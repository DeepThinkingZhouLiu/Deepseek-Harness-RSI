"""Small TOML and upstream-prompt bridge for the optional Cowork baselines."""

import argparse
import json
from pathlib import Path


def inspect_task(repo: Path, relative: str) -> dict:
    import tomllib

    task = repo / relative
    if not task.resolve().is_relative_to(repo.resolve()):
        raise ValueError("Task path escapes benchmark repository")
    config = tomllib.loads((task / "task.toml").read_text())
    return {
        "instruction": (task / "instruction.md").read_text(),
        "config": config,
    }


def prompts(root: Path) -> dict:
    return json.loads((root / "baselines/prompts.json").read_text())


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["task", "prompts"])
    parser.add_argument("root", type=Path)
    parser.add_argument("--task")
    args = parser.parse_args()
    value = prompts(args.root) if args.operation == "prompts" else inspect_task(
        args.root, args.task,
    )
    print(json.dumps(value, ensure_ascii=False))
