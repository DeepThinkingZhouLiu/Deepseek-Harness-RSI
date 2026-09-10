"""面向 Cowork 的最小 model -> Bash -> observation 循环。"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from image_tool import (
    ImageToolError,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_CONTEXT_BYTES,
    MAX_IMAGE_OBSERVATIONS,
    read_image,
)
from model import query
from tools import run_bash


BASH_PATTERNS = (
    re.compile(r"<bash>\s*(.*?)\s*</bash>", re.DOTALL | re.IGNORECASE),
    re.compile(r"```bash\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE),
)
IMAGE_PATTERN = re.compile(r"<view_image>\s*(.*?)\s*</view_image>", re.DOTALL | re.IGNORECASE)
FINAL_PATTERN = re.compile(r"<final>\s*(.*?)\s*</final>", re.DOTALL | re.IGNORECASE)


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
        configured_image_bytes = self.config.get("max_image_bytes", MAX_IMAGE_CONTEXT_BYTES)
        self.maximum_image_bytes = (
            configured_image_bytes
            if isinstance(configured_image_bytes, int)
            and not isinstance(configured_image_bytes, bool)
            and 1 <= configured_image_bytes <= MAX_IMAGE_BYTES
            else MAX_IMAGE_BYTES
        )
        self.trace_path = trace_path

    def trace(self, event: dict) -> None:
        with self.trace_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    @staticmethod
    def parse(reply: str) -> tuple[str, str] | None:
        actions: list[tuple[int, int, str, str]] = []
        patterns = (
            ("bash", BASH_PATTERNS[0]),
            ("bash", BASH_PATTERNS[1]),
            ("view_image", IMAGE_PATTERN),
            ("final", FINAL_PATTERN),
        )
        for order, (kind, pattern) in enumerate(patterns):
            match = pattern.search(reply)
            if match:
                content = match.group(1).strip()
                if content:
                    actions.append((match.start(), order, kind, content))
        if not actions:
            return None
        _, _, kind, content = min(actions)
        return kind, content

    def run(self, task: str, workspace: Path) -> str:
        messages = [
            {"role": "system", "content": self.system_prompt},
            {"role": "user", "content": task},
        ]
        image_observations = 0
        image_context_bytes = 0
        for step in range(1, self.maximum_steps + 1):
            reply = query(
                self.gateway_url,
                self.api_key,
                self.model,
                messages,
                self.maximum_output_tokens,
            )
            self.trace({"type": "model", "step": step, "content": reply})
            parsed = self.parse(reply)
            if parsed and parsed[0] == "final":
                return parsed[1]
            # 部分兼容模型会在一次响应里输出多个动作。Controller 只执行文本中
            # 最先出现的动作，并只把该动作写回上下文，避免模型误以为后续动作已执行。
            assistant_content = reply
            if parsed and parsed[0] == "bash":
                assistant_content = f"<bash>\n{parsed[1]}\n</bash>"
            elif parsed and parsed[0] == "view_image":
                assistant_content = f"<view_image>{parsed[1]}</view_image>"
            messages.append({"role": "assistant", "content": assistant_content})
            if parsed and parsed[0] == "bash":
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
            elif parsed and parsed[0] == "view_image":
                requested_path = parsed[1]
                try:
                    if image_observations >= MAX_IMAGE_OBSERVATIONS:
                        raise ImageToolError(
                            f"本轮最多查看 {MAX_IMAGE_OBSERVATIONS} 张图片"
                        )
                    image = read_image(
                        workspace,
                        requested_path,
                        maximum_bytes=self.maximum_image_bytes,
                    )
                    encoded_bytes = int(image["encoded_bytes"])
                    if image_context_bytes + encoded_bytes > MAX_IMAGE_CONTEXT_BYTES:
                        raise ImageToolError("本轮图片上下文已达到大小上限")
                    image_observations += 1
                    image_context_bytes += encoded_bytes
                    self.trace({
                        "type": "image_observation",
                        "step": step,
                        "path": image["path"],
                        "mime_type": image["mime_type"],
                        "bytes": image["bytes"],
                    })
                    messages.append({
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": (
                                    f"Image observation for {image['path']} "
                                    f"({image['mime_type']}, {image['bytes']} bytes). "
                                    "Inspect the image and continue with exactly one "
                                    "<bash>...</bash> or <view_image>...</view_image> "
                                    "or <final>...</final> block."
                                ),
                            },
                            {
                                "type": "image_url",
                                "image_url": {
                                    "url": image["data_url"],
                                    "detail": "auto",
                                },
                            },
                        ],
                    })
                except (ImageToolError, OSError, ValueError) as error:
                    self.trace({
                        "type": "image_observation",
                        "step": step,
                        "path": requested_path[:256],
                        "status": "rejected",
                        "reason": str(error),
                    })
                    messages.append({
                        "role": "user",
                        "content": (
                            f"Image observation failed: {error}\n"
                            "Use another relative PNG/JPEG/WEBP/GIF path, or continue "
                            "with exactly one <bash>...</bash> or <final>...</final> block."
                        ),
                    })
            else:
                messages.append({
                    "role": "user",
                    "content": (
                        "Use exactly one <bash>...</bash>, "
                        "<view_image>relative/path</view_image>, or <final>...</final> block."
                    ),
                })
        return "The agent exhausted its step budget before completing the requested deliverable."
