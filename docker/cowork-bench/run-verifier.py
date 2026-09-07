"""在无网络容器中调用 Cowork-Bench 任务的隐藏 Judge。"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
from pathlib import Path


def regular_file(path: Path, label: str) -> Path:
    info = path.stat(follow_symlinks=False)
    if path.is_symlink() or not path.is_file() or info.st_nlink != 1:
        raise RuntimeError(f"{label} 不是独立普通文件")
    return path.resolve(strict=True)


def declares_option(judge_path: Path, option: str) -> bool:
    """静态检查 Judge CLI 是否声明可选参数，不执行未受信的探测调用。"""

    tree = ast.parse(judge_path.read_text(encoding="utf-8"), filename=str(judge_path))
    return any(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_argument"
        and any(isinstance(arg, ast.Constant) and arg.value == option for arg in node.args)
        for node in ast.walk(tree)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--judge", required=True)
    parser.add_argument("--submission", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expected-id", required=True)
    args = parser.parse_args()
    submission = Path(args.submission).resolve(strict=True)
    if not submission.is_dir() or submission.is_symlink():
        raise RuntimeError("Submission 不是安全目录")
    judge_path = regular_file(Path(args.judge), "Cowork Judge")
    # Release 中的 Judge 都提供统一 CLI；evaluate() 只是内部实现细节，签名并不统一。
    # 始终走 CLI，才能让 Judge 自己选择目标 Artifact、输入目录和评分版本。
    judge_result = Path(args.output).with_name("judge-result.json")
    reward_file = Path(args.output).with_name("judge-reward.txt")
    command = [
        sys.executable, str(judge_path),
        "--artifact-dir", str(submission),
        "--result", str(judge_result),
    ]
    if declares_option(judge_path, "--reward-file"):
        command.extend(["--reward-file", str(reward_file)])
    process = subprocess.run(
        command,
        capture_output=True, text=True, timeout=1200, check=False,
        cwd=judge_path.parent,
    )
    if process.returncode != 0 or not judge_result.is_file():
        detail = (process.stderr or process.stdout or "无结果文件")[-2000:]
        raise RuntimeError(f"Cowork CLI Judge 执行失败：{detail}")
    result = json.loads(judge_result.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise RuntimeError("Cowork Judge 返回值不是对象")
    reward = result.get("reward")
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not 0 <= float(reward) <= 1:
        raise RuntimeError("Cowork Judge reward 必须位于 [0,1]")
    if result.get("task_id") and not str(result["task_id"]).endswith(args.expected_id):
        raise RuntimeError("Cowork Judge task_id 与任务不一致")
    output = Path(args.output)
    if output.exists():
        raise RuntimeError("Verifier 输出文件运行前必须不存在")
    output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
