"""Unit tests para backend/gpt4o_vision.py.

Mocka ``AsyncOpenAI`` completamente — nunca chama a API real.

Requer: pytest, pytest-asyncio.
Rodar: ``cd cadastro-motorista/backend && python -m pytest tests/ -v``
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any

import pytest

from backend import gpt4o_vision


# asyncio_mode=auto em pytest.ini cuida das funcoes async automaticamente.


# ─── Fixtures ────────────────────────────────────────────────────────────────


@dataclass
class _MockUsage:
    prompt_tokens: int = 100
    completion_tokens: int = 50


@dataclass
class _MockMessage:
    content: str


@dataclass
class _MockChoice:
    message: _MockMessage


@dataclass
class _MockResponse:
    choices: list
    usage: _MockUsage


class _MockChatCompletions:
    def __init__(self):
        self.last_call: dict = {}
        self.fake_content: str = '{"nome": "Joao", "cpf": "12345678900"}'
        self.raise_exception: Exception | None = None

    async def create(self, **kwargs) -> _MockResponse:
        self.last_call = kwargs
        if self.raise_exception is not None:
            raise self.raise_exception
        return _MockResponse(
            choices=[_MockChoice(message=_MockMessage(content=self.fake_content))],
            usage=_MockUsage(),
        )


class _MockClient:
    def __init__(self):
        self.chat = type("Chat", (), {})()
        self.chat.completions = _MockChatCompletions()


@pytest.fixture(autouse=True)
def reset_state():
    """Limpa singletons entre testes para isolamento."""
    gpt4o_vision._client = None
    gpt4o_vision._circuit.failures.clear()
    gpt4o_vision._circuit.opened_at = None
    gpt4o_vision._budget.date_utc = ""
    gpt4o_vision._budget.spent_usd = 0.0
    gpt4o_vision._budget.calls = 0
    yield


@pytest.fixture
def mock_client():
    client = _MockClient()
    gpt4o_vision.set_client(client)
    return client


@pytest.fixture
def png_b64():
    """1x1 PNG transparente em base64 (header valido)."""
    return (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
        "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    )


# ─── redact() / install_log_redactor ─────────────────────────────────────────


def test_redact_strips_openai_token():
    msg = "Token sk-proj-AbcDefGhIjKlMnOpQrSt vazou no log"
    assert gpt4o_vision.redact(msg) == "Token sk-***REDACTED*** vazou no log"


def test_redact_strips_multiple_tokens():
    msg = "sk-abcdefghijklmnop e sk-zyxwvutsrqponmlk"
    out = gpt4o_vision.redact(msg)
    assert out.count("sk-***REDACTED***") == 2
    assert "sk-abc" not in out


def test_redact_preserves_non_token_text():
    msg = "Erro 502 do upstream"
    assert gpt4o_vision.redact(msg) == msg


def test_install_log_redactor_is_idempotent():
    gpt4o_vision.install_log_redactor()
    factory_before = logging.getLogRecordFactory()
    gpt4o_vision.install_log_redactor()
    factory_after = logging.getLogRecordFactory()
    assert factory_before is factory_after


def test_log_filter_redacts_in_message(caplog):
    gpt4o_vision.install_log_redactor()
    log = logging.getLogger("test.redact")
    with caplog.at_level(logging.INFO):
        log.info("vazou sk-abcdefghijklmnopqrst no log")
    rec = next(r for r in caplog.records if "vazou" in r.getMessage())
    assert "sk-***REDACTED***" in rec.getMessage()
    assert "sk-abc" not in rec.getMessage()


# ─── _detect_mime ────────────────────────────────────────────────────────────


def test_detect_mime_png(png_b64):
    assert gpt4o_vision._detect_mime(png_b64) == "image/png"


def test_detect_mime_jpeg():
    # JPEG header: \xff\xd8\xff\xe0
    import base64

    raw = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 20
    assert gpt4o_vision._detect_mime(base64.b64encode(raw).decode()) == "image/jpeg"


def test_detect_mime_pdf_returns_pdf():
    import base64

    raw = b"%PDF-1.4\n" + b"\x00" * 20
    assert gpt4o_vision._detect_mime(base64.b64encode(raw).decode()) == "application/pdf"


def test_detect_mime_strips_dataurl_prefix(png_b64):
    assert gpt4o_vision._detect_mime(f"data:image/png;base64,{png_b64}") == "image/png"


# ─── _to_envelope ────────────────────────────────────────────────────────────


def test_to_envelope_shape():
    env = gpt4o_vision._to_envelope(
        "cnh",
        {"nome": "Joao", "cpf": "12345678900", "rg": None},
        model="gpt-4o",
        prompt_tokens=100,
        completion_tokens=50,
        usd=0.0012,
    )
    assert env["code"] == 200
    assert env["data_count"] == 1
    assert env["data"][0]["tipo"] == "cnh"
    assert env["data"][0]["campos"]["nome"] == {"valor": "Joao", "score": None}
    assert env["data"][0]["campos"]["cpf"] == {"valor": "12345678900", "score": None}
    assert env["data"][0]["campos"]["rg"] == {"valor": None, "score": None}
    assert env["header"]["provider"] == "gpt4o-vision"
    assert env["header"]["model"] == "gpt-4o"
    assert env["header"]["tokens"] == {"in": 100, "out": 50, "usd": 0.0012}


def test_to_envelope_empty_string_treated_as_null():
    env = gpt4o_vision._to_envelope(
        "rntrc",
        {"nome": "", "rntrc": "123456"},
        model="gpt-4o",
        prompt_tokens=0,
        completion_tokens=0,
        usd=0.0,
    )
    assert env["data"][0]["campos"]["nome"]["valor"] is None
    assert env["data"][0]["campos"]["rntrc"]["valor"] == "123456"


# ─── _estimate_cost_usd ──────────────────────────────────────────────────────


def test_estimate_cost_gpt4o():
    # gpt-4o: $5/M in, $15/M out
    # 1M in + 1M out = $5 + $15 = $20
    assert gpt4o_vision._estimate_cost_usd("gpt-4o", 1_000_000, 1_000_000) == 20.0


def test_estimate_cost_unknown_model_falls_back():
    # Unknown -> usa gpt-4o rates como fallback
    assert (
        gpt4o_vision._estimate_cost_usd("gpt-9-future", 1_000_000, 0) == 5.0
    )


# ─── extract() — happy path ──────────────────────────────────────────────────


async def test_extract_happy_path(mock_client, png_b64):
    mock_client.chat.completions.fake_content = json.dumps(
        {"nome": "Maria Silva", "cpf": "98765432100"}
    )
    env = await gpt4o_vision.extract("cnh", png_b64)
    assert env["code"] == 200
    assert env["data"][0]["campos"]["nome"]["valor"] == "Maria Silva"
    # Confirma que mock recebeu prompt CNH (user msg eh lista de partes)
    msgs = mock_client.chat.completions.last_call["messages"]
    user_msg = msgs[-1]
    assert user_msg["role"] == "user"
    text_parts = [
        p["text"] for p in user_msg["content"] if p.get("type") == "text"
    ]
    assert any("CNH" in t for t in text_parts)


async def test_extract_sends_high_detail_image_url(mock_client, png_b64):
    await gpt4o_vision.extract("cartao_cnpj", png_b64)
    user_msg = mock_client.chat.completions.last_call["messages"][-1]
    assert user_msg["role"] == "user"
    parts = user_msg["content"]
    img_part = next(p for p in parts if p["type"] == "image_url")
    assert img_part["image_url"]["detail"] == "high"
    assert img_part["image_url"]["url"].startswith("data:image/png;base64,")


async def test_extract_uses_response_format_json(mock_client, png_b64):
    await gpt4o_vision.extract("rntrc", png_b64)
    call = mock_client.chat.completions.last_call
    assert call["response_format"] == {"type": "json_object"}
    assert call["temperature"] == 0.0


# ─── extract() — erros ──────────────────────────────────────────────────────


async def test_extract_raises_when_client_not_initialized(png_b64):
    # mock_client fixture NÃO usada — client fica None
    with pytest.raises(gpt4o_vision.GPT4oVisionError, match="não inicializado"):
        await gpt4o_vision.extract("cnh", png_b64)


async def test_extract_raises_for_unknown_doc_type(mock_client, png_b64):
    with pytest.raises(gpt4o_vision.GPT4oVisionError, match="desconhecido"):
        await gpt4o_vision.extract("invalido", png_b64)


async def test_extract_raises_parse_error_on_invalid_json(mock_client, png_b64):
    mock_client.chat.completions.fake_content = "isto nao eh json"
    with pytest.raises(gpt4o_vision.GPT4oVisionParseError, match="JSON malformado"):
        await gpt4o_vision.extract("cnh", png_b64)


async def test_extract_raises_parse_error_on_non_object_json(mock_client, png_b64):
    mock_client.chat.completions.fake_content = '["array", "instead", "of", "object"]'
    with pytest.raises(gpt4o_vision.GPT4oVisionParseError, match="não-object"):
        await gpt4o_vision.extract("cnh", png_b64)


async def test_extract_raises_pdf_rejected(mock_client):
    import base64

    pdf_b64 = base64.b64encode(b"%PDF-1.4\n" + b"\x00" * 100).decode()
    with pytest.raises(gpt4o_vision.GPT4oVisionError, match="PDF não suportado"):
        await gpt4o_vision.extract("cnh", pdf_b64)


async def test_extract_translates_timeout(mock_client, png_b64):
    # Cria mock APITimeoutError compativel com import opcional
    from openai import APITimeoutError as RealTimeout

    mock_client.chat.completions.raise_exception = RealTimeout(request=None)  # type: ignore[arg-type]
    with pytest.raises(gpt4o_vision.GPT4oVisionTimeout):
        await gpt4o_vision.extract("cnh", png_b64)


async def test_extract_redacts_token_in_error_message(mock_client, png_b64):
    mock_client.chat.completions.raise_exception = RuntimeError(
        "auth fail token=sk-abcdefghijklmnopqrst"
    )
    with pytest.raises(gpt4o_vision.GPT4oVisionError) as exc:
        await gpt4o_vision.extract("cnh", png_b64)
    assert "sk-***REDACTED***" in str(exc.value)
    assert "sk-abc" not in str(exc.value)


# ─── Circuit breaker ─────────────────────────────────────────────────────────


async def test_circuit_opens_after_threshold(mock_client, png_b64):
    mock_client.chat.completions.raise_exception = RuntimeError("boom")
    for _ in range(gpt4o_vision._CIRCUIT_FAIL_THRESHOLD):
        with pytest.raises(gpt4o_vision.GPT4oVisionError):
            await gpt4o_vision.extract("cnh", png_b64)
    # 6a chamada bloqueia antes mesmo de tentar API
    mock_client.chat.completions.raise_exception = None
    with pytest.raises(gpt4o_vision.GPT4oVisionCircuitOpen):
        await gpt4o_vision.extract("cnh", png_b64)


async def test_circuit_success_reduces_failure_window(mock_client, png_b64):
    mock_client.chat.completions.raise_exception = RuntimeError("transient")
    for _ in range(gpt4o_vision._CIRCUIT_FAIL_THRESHOLD - 2):
        with pytest.raises(gpt4o_vision.GPT4oVisionError):
            await gpt4o_vision.extract("cnh", png_b64)
    failures_before = len(gpt4o_vision._circuit.failures)
    mock_client.chat.completions.raise_exception = None
    await gpt4o_vision.extract("cnh", png_b64)
    failures_after = len(gpt4o_vision._circuit.failures)
    assert failures_after == failures_before - 1


# ─── Budget tracker ──────────────────────────────────────────────────────────


async def test_budget_records_after_each_call(mock_client, png_b64):
    snap_before = gpt4o_vision.budget_snapshot()
    await gpt4o_vision.extract("cnh", png_b64)
    snap_after = gpt4o_vision.budget_snapshot()
    assert snap_after["calls"] == snap_before["calls"] + 1
    assert snap_after["spent_usd"] > snap_before["spent_usd"]


async def test_budget_blocks_when_exceeded(monkeypatch, mock_client, png_b64):
    from backend import config

    monkeypatch.setattr(config, "GPT4O_DAILY_BUDGET_USD", 0.0001)
    # Primeira chamada gasta ~$0.001 (mock = 100in+50out a $5/$15 por M)
    await gpt4o_vision.extract("cnh", png_b64)
    # Segunda chamada deve bloquear pre-flight
    with pytest.raises(gpt4o_vision.GPT4oVisionBudgetExceeded):
        await gpt4o_vision.extract("cnh", png_b64)
