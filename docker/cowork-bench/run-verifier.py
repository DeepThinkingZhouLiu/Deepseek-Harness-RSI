"""在无网络容器中调用 Cowork-Bench 任务的隐藏 Judge。"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path


def regular_file(path: Path, label: str) -> Path:
    info = path.stat(follow_symlinks=False)
    if path.is_symlink() or not path.is_file() or info.st_nlink != 1:
        raise RuntimeError(f"{label} 不是独立普通文件")
    return path.resolve(strict=True)


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
    sys.path.insert(0, str(judge_path.parent))
    spec = importlib.util.spec_from_file_location("trusted_cowork_judge", judge_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 Cowork Judge")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    evaluate = getattr(module, "evaluate", None)
    if not callable(evaluate):
        raise RuntimeError("Cowork Judge 缺少 evaluate(directory) 函数")
    result = evaluate(str(submission))
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
