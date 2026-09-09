"""在当前任务工作区内安全读取图片并生成多模态消息所需的 data URL。"""

from __future__ import annotations

import base64
import os
import re
import stat
from pathlib import Path


MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_CONTEXT_BYTES = 12 * 1024 * 1024
MAX_IMAGE_OBSERVATIONS = 8
MAX_IMAGE_PATH_BYTES = 4096

_IMAGE_SUFFIXES = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
_WINDOWS_ABSOLUTE_PATH = re.compile(r"^[A-Za-z]:[/\\]")


class ImageToolError(ValueError):
    """图片观察请求不符合工作区或图片格式限制。"""


def _normalize_relative_path(requested: str) -> tuple[str, list[str]]:
    if not isinstance(requested, str) or not requested.strip():
        raise ImageToolError("图片路径必须是非空相对路径")
    value = requested.strip()
    if len(value.encode("utf-8")) > MAX_IMAGE_PATH_BYTES:
        raise ImageToolError("图片路径过长")
    if "\\" in value or "\x00" in value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ImageToolError("图片路径包含不安全字符")
    if value.startswith("/") or _WINDOWS_ABSOLUTE_PATH.match(value):
        raise ImageToolError("图片路径必须是相对路径")
    while value.startswith("./"):
        value = value[2:]
    parts = value.split("/")
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ImageToolError("图片路径不能包含空路径段或 ..")
    return "/".join(parts), parts


def _image_mime(data: bytes) -> str | None:
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n") and data[12:16] == b"IHDR":
        return "image/png"
    if len(data) >= 3 and data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(data) >= 6 and data[:6] in {b"GIF87a", b"GIF89a"}:
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _workspace_image_path(workspace: Path, parts: list[str], display_path: str) -> Path:
    try:
        workspace_input = workspace
        if workspace_input.is_symlink():
            raise ImageToolError("任务工作区不能是符号链接")
        root = workspace_input.resolve(strict=True)
    except ImageToolError:
        raise
    except OSError as error:
        raise ImageToolError("任务工作区不可读") from error
    if not root.is_dir():
        raise ImageToolError("任务工作区不是目录")

    current = root
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except OSError as error:
            raise ImageToolError(f"图片不存在：{display_path}") from error
        if stat.S_ISLNK(info.st_mode):
            raise ImageToolError("图片路径不能经过符号链接")
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            raise ImageToolError(f"图片父路径不是目录：{display_path}")
    return current


def _read_regular_image(path: Path, maximum_bytes: int, display_path: str) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise ImageToolError(f"图片不可读：{display_path}") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise ImageToolError("图片必须是独立普通文件")
        if before.st_size < 1 or before.st_size > maximum_bytes:
            raise ImageToolError(f"图片大小必须在 1..{maximum_bytes} 字节内")
        chunks: list[bytes] = []
        remaining = maximum_bytes + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(descriptor)
        if len(data) > maximum_bytes or len(data) != after.st_size:
            raise ImageToolError("图片在读取期间发生变化或超过大小上限")
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            raise ImageToolError("图片在读取期间发生变化")
        return data
    except ImageToolError:
        raise
    except OSError as error:
        raise ImageToolError(f"图片不可读：{display_path}") from error
    finally:
        os.close(descriptor)


def read_image(
    workspace: str | Path,
    requested: str,
    maximum_bytes: int = MAX_IMAGE_BYTES,
) -> dict[str, str | int]:
    """读取工作区图片并返回不含原始字节的可序列化元数据和 data URL。

    Args:
        workspace: 当前任务工作区。
        requested: 相对于工作区的图片路径。
        maximum_bytes: 本次读取允许的最大字节数，不能超过固定安全上限。

    Returns:
        包含规范化路径、MIME、字节数、编码后大小和 data URL 的字典。
    """

    if not isinstance(maximum_bytes, int) or isinstance(maximum_bytes, bool):
        raise ImageToolError("图片大小上限必须是整数")
    if maximum_bytes < 1 or maximum_bytes > MAX_IMAGE_BYTES:
        raise ImageToolError(f"图片大小上限必须在 1..{MAX_IMAGE_BYTES} 字节内")
    display_path, parts = _normalize_relative_path(requested)
    path = _workspace_image_path(Path(workspace), parts, display_path)
    suffix_mime = _IMAGE_SUFFIXES.get(path.suffix.lower())
    if suffix_mime is None:
        raise ImageToolError("只支持 PNG、JPEG、WEBP 和 GIF 图片")
    data = _read_regular_image(path, maximum_bytes, display_path)
    mime = _image_mime(data)
    if mime is None or mime != suffix_mime:
        raise ImageToolError("图片扩展名与文件内容不匹配")
    encoded = base64.b64encode(data).decode("ascii")
    return {
        "path": display_path,
        "mime_type": mime,
        "bytes": len(data),
        "encoded_bytes": len(encoded),
        "data_url": f"data:{mime};base64,{encoded}",
    }
