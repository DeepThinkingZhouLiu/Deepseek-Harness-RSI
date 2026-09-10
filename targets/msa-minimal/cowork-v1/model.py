"""通过 Controller 隔离网关调用 OpenAI Chat Completions。"""

from __future__ import annotations

import http.client
import json
import re
import time
import unicodedata
from urllib.parse import urlsplit

MAXIMUM_TRANSIENT_RESPONSE_ATTEMPTS = 8
MAXIMUM_EMPTY_RESPONSE_ATTEMPTS = 3
RETRY_BASE_DELAY_SECONDS = 0.5
RETRY_MAXIMUM_DELAY_SECONDS = 4.0
RETRYABLE_GATEWAY_STATUSES = frozenset({429, 500, 502, 503, 504})


class TransientModelResponseError(RuntimeError):
    """上游响应尚未交给 Agent 时发生的可重试故障。"""


def _safe_label(value: object) -> str:
    # 诊断只允许短标识符，不回显上游正文、消息或凭据。
    if (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.:/-]{1,128}", value)
            and "sk-" not in value.lower()):
        return value
    return "unknown"


def _request_id(response: http.client.HTTPResponse) -> str:
    for name in ("x-oneapi-request-id", "x-request-id", "request-id", "x-deepseek-request-id"):
        if response.headers.get(name):
            return _safe_label(response.headers[name])
    return "unknown"


def _upstream_error(payload: object, request_id: str) -> None:
    if not isinstance(payload, dict):
        raise TransientModelResponseError("model gateway invalid response shape")
    if payload.get("error") is None and payload.get("type") != "error":
        return
    error = payload.get("error")
    if not isinstance(error, dict):
        error = payload
    code = _safe_label(error.get("code") or error.get("type"))
    detail = f"model gateway upstream error (code={code}, request_id={request_id})"
    if code in {"invalid_api_key", "authentication_error", "permission_error",
                "invalid_request_error", "context_length_exceeded", "not_found_error"}:
        raise RuntimeError(detail)
    raise TransientModelResponseError(detail)


def _sse_events(raw: str):
    # SSE 的一个事件可以包含多行 data；网络分块与事件边界无关。
    lines: list[str] = []
    for line in [*raw.splitlines(), ""]:
        if not line:
            if lines:
                yield "\n".join(lines)
                lines = []
        elif line.startswith("data:"):
            lines.append(line[5:].removeprefix(" "))


def _content(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "".join(parts)
    return ""


def _response_result(
    text: str,
    finish_reason: str | None,
    saw_reasoning: bool,
    refused: bool,
) -> dict:
    return {
        "text": text,
        "finish_reason": finish_reason,
        "saw_reasoning": saw_reasoning,
        "refused": refused,
    }


def _first_choice(payload: dict) -> dict:
    choices = payload.get("choices", [])
    if not isinstance(choices, list) or (choices and not isinstance(choices[0], dict)):
        raise TransientModelResponseError("model gateway invalid choices shape")
    return choices[0] if choices else {}


def _read_response(response: http.client.HTTPResponse) -> dict:
    raw = response.read().decode("utf-8-sig").strip()
    request_id = _request_id(response)
    # 兼容网关可能把 JSON 标成 SSE，或把 SSE 标成 JSON；按实际内容识别。
    if raw.startswith(("{", "[")):
        payload = json.loads(raw)
        _upstream_error(payload, request_id)
        choice = _first_choice(payload)
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        finish_reason = choice.get("finish_reason")
        if not isinstance(finish_reason, str):
            finish_reason = None
        result = _response_result(
            _content(message.get("content")),
            finish_reason,
            bool(_content(message.get("reasoning_content")).strip()),
            bool(_content(message.get("refusal")).strip()),
        )
        return {**result, "request_id": request_id, "wire_format": "json"}

    parts: list[str] = []
    final_message = ""
    finish_reason: str | None = None
    saw_reasoning = False
    refused = False
    saw_done = False
    for data in _sse_events(raw):
        if data.strip() == "[DONE]":
            saw_done = True
            continue
        event = json.loads(data)
        _upstream_error(event, request_id)
        choice = _first_choice(event)
        if not choice:
            continue
        delta = choice.get("delta", {})
        if not isinstance(delta, dict):
            delta = {}
        message = choice.get("message", {})
        if not isinstance(message, dict):
            message = {}
        parts.append(_content(delta.get("content")))
        # 少数兼容网关会在流的最终事件中返回完整 message，而不是 delta。
        # 只有在没有任何 delta content 时才使用它，避免重复拼接。
        message_content = _content(message.get("content"))
        if message_content:
            final_message = message_content
        saw_reasoning = saw_reasoning or bool(
            _content(delta.get("reasoning_content")).strip()
            or _content(message.get("reasoning_content")).strip()
        )
        refused = refused or bool(
            _content(delta.get("refusal")).strip()
            or _content(message.get("refusal")).strip()
        )
        current_finish = choice.get("finish_reason")
        if isinstance(current_finish, str):
            finish_reason = current_finish
    text = "".join(parts)
    if raw and not saw_done and finish_reason is None:
        raise TransientModelResponseError(
            f"model gateway incomplete stream (request_id={request_id})"
        )
    result = _response_result(
        text if text else final_message,
        finish_reason,
        saw_reasoning,
        refused,
    )
    return {**result, "request_id": request_id, "wire_format": "sse"}


def _empty_response_error(result: dict, attempts: int) -> RuntimeError:
    finish_reason = result["finish_reason"] or "missing"
    reasoning_discarded = "true" if result["saw_reasoning"] else "false"
    return RuntimeError(
        "model gateway returned no final content "
        f"after {attempts} attempt(s) "
        f"(finish_reason={_safe_label(finish_reason)}, reasoning_content_discarded={reasoning_discarded}, "
        f"wire_format={result.get('wire_format', 'unknown')}, request_id={result.get('request_id', 'unknown')})"
    )


def _wait_before_transient_retry(failure_count: int) -> None:
    delay = min(
        RETRY_MAXIMUM_DELAY_SECONDS,
        RETRY_BASE_DELAY_SECONDS * (2 ** max(0, failure_count - 1)),
    )
    if delay > 0:
        time.sleep(delay)


def query(
    gateway_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    max_output_tokens: int,
) -> str:
    parsed = urlsplit(gateway_url)
    if parsed.scheme != "http" or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("model gateway URL must be an internal HTTP endpoint")
    base_path = parsed.path.rstrip("/")
    endpoint = f"{base_path}/chat/completions" or "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": max_output_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
    }).encode("utf-8")
    transient_failures = 0
    empty_failures = 0
    while True:
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=1200)
        try:
            connection.request(
                "POST",
                endpoint,
                body=body,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                raw_error = response.read(4096)
                try:
                    payload = json.loads(raw_error)
                    error = payload.get("error", {}) if isinstance(payload, dict) else {}
                    code = _safe_label(error.get("code") or error.get("type")) if isinstance(error, dict) else "unknown"
                except (ValueError, UnicodeError):
                    code = "unknown"
                detail = f"(code={code}, request_id={_request_id(response)})"
                if response.status in RETRYABLE_GATEWAY_STATUSES:
                    raise TransientModelResponseError(
                        f"model gateway returned retryable HTTP {response.status} {detail}"
                    )
                raise RuntimeError(f"model gateway HTTP {response.status} {detail}")
            result = _read_response(response)
        except (
            TransientModelResponseError,
            http.client.HTTPException,
            json.JSONDecodeError,
            UnicodeError,
            OSError,
        ) as error:
            transient_failures += 1
            if transient_failures < MAXIMUM_TRANSIENT_RESPONSE_ATTEMPTS:
                _wait_before_transient_retry(transient_failures)
                continue
            raise RuntimeError(
                "model gateway transient response failure after "
                f"{transient_failures} attempt(s); "
                # 只有本模块生成的安全错误才记录详情，底层异常只记录类型。
                + (str(error) if isinstance(error, TransientModelResponseError) else type(error).__name__)
            ) from None
        finally:
            connection.close()

        if result["refused"] or result["finish_reason"] == "content_filter":
            raise RuntimeError("model gateway refused or filtered the completion")
        text = result["text"].strip()
        # 零宽空格等纯格式字符也属于空回答，不能占用 Agent 的解题步数。
        if any(not character.isspace() and unicodedata.category(character) != "Cf" for character in text):
            return text

        # 只把“正常结束但正文为空”或“空流”视为一次性上游故障。
        # length、tool_calls 等状态不会靠相同请求自动恢复，因此直接失败。
        empty_failures += 1
        if (empty_failures < MAXIMUM_EMPTY_RESPONSE_ATTEMPTS
                and result["finish_reason"] in {None, "stop"}):
            continue
        raise _empty_response_error(result, empty_failures)
