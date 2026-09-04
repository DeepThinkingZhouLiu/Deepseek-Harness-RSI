"""面向 Cowork 的最小 model -> Bash -> observation 循环。"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from model import query
from tools import run_bash


BASH_PATTERNS = (
    re.compile(r"<bash>\s*(.*?)\s*</bash>", re.DOTALL | re.IGNORECASE),
    re.compile(r"```bash\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE),
)
FINAL_PATTERN = re.compile(r"<final>\s*(.*?)\s*</final>", re.DOTALL | re.IGNORECASE)
EXPLICIT_BASH_MARKER = re.compile(
    r"(?:^|\n)\s*to=bash(?:\.exec)?\s+code:\s*",
    re.IGNORECASE,
)
COMPLETION_PATTERN = re.compile(
    r"\b(?:completed|created|updated|saved|deliverable)\b|已(?:完成|创建|更新|保存)|交付文件",
    re.IGNORECASE,
)
REFUSAL_PATTERN = re.compile(
    r"\b(?:unable|cannot|can't|could not)\b|无法|不能|未能",
    re.IGNORECASE,
)
DELIVERABLE_SUFFIXES = {
    ".csv", ".doc", ".docx", ".odp", ".ods", ".odt", ".pdf",
    ".ppt", ".pptx", ".rtf", ".xls", ".xlsm", ".xlsx",
}


def _skill_files(root: Path) -> list[Path]:
    """只枚举真实根目录中的普通 SKILL.md，不跟随符号链接。"""

    try:
        actual_root = root.resolve(strict=True)
    except FileNotFoundError:
        return []
    if not actual_root.is_dir() or actual_root.is_symlink():
        return []
    output: list[Path] = []
    for path in sorted(actual_root.rglob("SKILL.md")):
        try:
            if path.is_symlink() or not path.is_file():
                continue
            path.resolve(strict=True).relative_to(actual_root)
        except (FileNotFoundError, ValueError):
            continue
        output.append(path)
    return output


def _load_skills(roots: list[Path], maximum_files: int, maximum_chars: int) -> str:
    documents: list[str] = []
    used_chars = 0
    for path in [item for root in roots for item in _skill_files(root)]:
        if len(documents) >= maximum_files:
            break
        source = path.read_text(encoding="utf-8")
        remaining = maximum_chars - used_chars
        if remaining <= 0:
            break
        source = source[:remaining]
        documents.append(f"<skill path={json.dumps(str(path))}>\n{source}\n</skill>")
        used_chars += len(source)
    return "\n\n".join(documents)


class Agent:
    def __init__(
        self,
        root: Path,
        profile: str,
        gateway_url: str,
        api_key: str,
        model: str,
        maximum_output_tokens: int,
        maximum_steps: int,
        trace_path: Path,
    ):
        profile_root = root / "profiles"
        self.config = json.loads((profile_root / f"{profile}.json").read_text(encoding="utf-8"))
        prompt = (profile_root / f"{profile}.md").read_text(encoding="utf-8")
        environment_root = Path(os.environ.get("RSI_ENVIRONMENT_ASSETS_ROOT", "/environment-assets"))
        skill_text = _load_skills(
            [root / "skills", environment_root],
            int(self.config["maximum_skill_files"]),
            int(self.config["maximum_skill_chars"]),
        )
        self.system_prompt = prompt if not skill_text else f"{prompt}\n\nAvailable skills:\n\n{skill_text}"
        self.gateway_url = gateway_url
        self.api_key = api_key
        self.model = model
        self.maximum_output_tokens = min(
            int(self.config["max_output_tokens"]),
            maximum_output_tokens,
        )
        self.maximum_steps = min(int(self.config["max_steps"]), maximum_steps)
        self.trace_path = trace_path

    def trace(self, event: dict) -> None:
        with self.trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    @staticmethod
    def _parse_action(reply: str) -> tuple[str, str, str] | None:
        candidates: list[tuple[int, str, str, str]] = []
        final = FINAL_PATTERN.search(reply)
        if final and final.group(1).strip():
            candidates.append((final.start(), "final", final.group(1).strip(), "xml-final"))
        for pattern in BASH_PATTERNS:
            action = pattern.search(reply)
            if action and action.group(1).strip():
                dialect = "xml-bash" if action.group(0).lstrip().lower().startswith("<bash>") else "fenced-bash"
                candidates.append((action.start(), "bash", action.group(1).strip(), dialect))

        marker = EXPLICIT_BASH_MARKER.search(reply)
        if marker and not candidates:
            payload = reply[marker.end():].strip()
            command = payload
            dialect = "explicit-bash"
            if payload.startswith("{") and payload.endswith("}"):
                try:
                    call = json.loads(payload)
                except json.JSONDecodeError:
                    call = None
                if isinstance(call, dict) and isinstance(call.get("cmd"), str):
                    command = call["cmd"].strip()
                    dialect = "explicit-bash-json"
            if command:
                candidates.append((marker.start(), "bash", command, dialect))

        if not candidates:
            return None
        _, kind, content, dialect = min(candidates, key=lambda item: item[0])
        return kind, content, dialect

    @staticmethod
    def parse(reply: str) -> tuple[str, str] | None:
        parsed = Agent._parse_action(reply)
        return None if parsed is None else parsed[:2]

    @staticmethod
    def _looks_like_bare_final(reply: str) -> bool:
        return bool(COMPLETION_PATTERN.search(reply)) and not REFUSAL_PATTERN.search(reply)

    @staticmethod
    def _parse_failure_reason(reply: str) -> str:
        if REFUSAL_PATTERN.search(reply):
            return "refusal-without-action"
        if "<bash" in reply.lower() or "to=bash" in reply.lower() or "```bash" in reply.lower():
            return "malformed-bash-action"
        if COMPLETION_PATTERN.search(reply):
            return "bare-final-without-deliverable-change"
        return "missing-action-envelope"

    @staticmethod
    def _workspace_state(workspace: Path) -> dict[str, tuple[int, int]]:
        state = {}
        for path in workspace.rglob("*"):
            if path.is_file() and not path.is_symlink() and path.suffix.lower() in DELIVERABLE_SUFFIXES:
                info = path.stat()
                state[str(path.relative_to(workspace))] = (info.st_size, info.st_mtime_ns)
        return state

    def run(self, task: str, workspace: Path) -> str:
        initial_workspace = self._workspace_state(workspace)
        unparsed_streak = 0
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        for step in range(1, self.maximum_steps + 1):
            reply = query(
                self.gateway_url,
                self.api_key,
                self.model,
                messages,
                self.maximum_output_tokens,
            )
            parsed_action = self._parse_action(reply)
            deliverable_changed = self._workspace_state(workspace) != initial_workspace
            if parsed_action is None and deliverable_changed and self._looks_like_bare_final(reply):
                parsed_action = ("final", reply.strip(), "bare-final-after-deliverable")
            failure_reason = None if parsed_action else self._parse_failure_reason(reply)
            self.trace({
                "type": "model",
                "step": step,
                "content": reply,
                "parsedAction": None if parsed_action is None else parsed_action[0],
                "parserDialect": None if parsed_action is None else parsed_action[2],
                "parseFailureReason": failure_reason,
            })
            parsed = None if parsed_action is None else parsed_action[:2]
            if parsed and parsed[0] == "final":
                return parsed[1]
            messages.append({"role": "assistant", "content": reply})
            if parsed and parsed[0] == "bash":
                unparsed_streak = 0
                observation = run_bash(
                    parsed[1],
                    str(workspace),
                    int(self.config["command_timeout_seconds"]),
                    int(self.config["max_observation_chars"]),
                )
                self.trace({
                    "type": "bash",
                    "step": step,
                    "command": parsed[1],
                    "observation": observation,
                })
                messages.append({
                    "role": "user",
                    "content": f"Bash observation:\n{observation}\nContinue with one <bash> or <final> block.",
                })
            else:
                unparsed_streak += 1
                reason = {
                    "refusal-without-action": "Your response refused the task without an executable action.",
                    "malformed-bash-action": "I found Bash-like syntax, but it was not a complete supported action.",
                    "bare-final-without-deliverable-change": "You claimed completion, but no deliverable file changed.",
                    "missing-action-envelope": "Your response contained neither an executable Bash action nor a final answer.",
                }[failure_reason]
                messages.append({
                    "role": "user",
                    "content": (
                        f"Parser failure {unparsed_streak}: {reason} "
                        "Use one complete <bash>...</bash> block, one ```bash fenced block, "
                        "one explicit to=bash code: action, or <final>...</final>. "
                        "Do not repeat a prose completion claim unless the requested file exists."
                    ),
                })
        return "The agent exhausted its step budget before completing the requested deliverable."
