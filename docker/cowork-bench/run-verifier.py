"""在无网络容器中调用 Cowork-Bench 任务的隐藏 Judge。"""

from __future__ import annotations

import argparse
import ast
import json
import math
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
    for option in ("--data-dir", "--input-dir"):
        if declares_option(judge_path, option):
            command.extend([option, str(judge_path.parent.parent / "data" / "input_files")])
    process = subprocess.run(
        command,
        capture_output=True, text=True, timeout=1200, check=False,
        cwd=judge_path.parent,
    )
    # CoworkEvoBench 的 Judge 用退出码表示是否达到通过阈值：0 表示通过，
    # 1 表示未通过但评分结果仍然有效。只有其他退出码或缺失结果文件才是执行失败。
    if process.returncode not in (0, 1) or not judge_result.is_file():
        detail = (process.stderr or process.stdout or "无结果文件")[-2000:]
        raise RuntimeError(f"Cowork CLI Judge 执行失败：{detail}")
    result = json.loads(judge_result.read_text(encoding="utf-8"))
    if not isinstance(result, dict):
        raise RuntimeError("Cowork Judge 返回值不是对象")
    if "reward" not in result and "score" in result:
        result["reward"] = result["score"]
    if "criterion_results" not in result and "criteria" in result:
        result["criterion_results"] = [
            {"criterion_id": item["id"], "score": item["score"],
             "evidence": item.get("evidence", ""), "raw": item}
            for item in result["criteria"]
        ]
    reward = result.get("reward")
    if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(float(reward)):
        raise RuntimeError("Cowork Judge reward 必须是有限数值")
    # CoworkBench 的部分 deterministic judge 用负数表示失败惩罚；统一协议以 0
    # 表示最低奖励，详细扣分原因仍保留在 criterion_results 和原始 Judge 日志中。
    result["reward"] = min(1.0, max(0.0, float(reward)))
    if result.get("task_id") and not str(result["task_id"]).endswith(args.expected_id):
        raise RuntimeError("Cowork Judge task_id 与任务不一致")
    output = Path(args.output)
    if output.exists():
        raise RuntimeError("Verifier 输出文件运行前必须不存在")
    output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
