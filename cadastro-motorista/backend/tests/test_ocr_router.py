"""Unit tests para backend/ocr_router.py.

Cobertura: 3 estratégias x (primary sucesso | primary code!=200 | primary
exception) + (vision sucesso | vision falha) + strategy_for lookup.
"""

from __future__ import annotations

import pytest

from backend import gpt4o_vision, ocr_router


# ─── Factories de envelope (helpers para testes) ────────────────────────────


def _ok_envelope(provider: str = "infosimples-test", code: int = 200) -> dict:
    return {
        "code": code,
        "code_message": "ok",
        "data": [{"campos": {"nome": {"valor": "Foo"}}, "tipo": "cnh"}],
        "header": {"provider": provider},
    }


def _err_envelope(code: int = 502, msg: str = "upstream falhou") -> dict:
    return {
        "code": code,
        "code_message": msg,
        "data": [],
        "header": {"provider": "infosimples-test"},
    }


def _primary_ok():
    async def _fn():
        return _ok_envelope("infosimples-test")
    return _fn


def _primary_err_code(code: int = 502):
    async def _fn():
        return _err_envelope(code, f"erro {code}")
    return _fn


def _primary_raises(exc: Exception):
    async def _fn():
        raise exc
    return _fn


def _vision_ok():
    async def _fn():
        return {
            "code": 200,
            "code_message": "OCR via GPT-4o Vision",
            "data": [{"campos": {"nome": {"valor": "Bar"}}, "tipo": "cnh"}],
            "header": {"provider": "gpt4o-vision", "model": "gpt-4o"},
        }
    return _fn


def _vision_raises_vision_error():
    async def _fn():
        raise gpt4o_vision.GPT4oVisionError("vision down")
    return _fn


# ─── Strategy: legacy ───────────────────────────────────────────────────────


async def test_legacy_returns_primary_unchanged():
    env = await ocr_router.route(
        "cnh", primary=_primary_ok(), vision=_vision_ok(), strategy="legacy"
    )
    assert env["header"]["provider"] == "infosimples-test"
    assert "primary_error" not in env["header"]


async def test_legacy_does_not_call_vision_on_primary_error():
    # Vision factory levanta — se for chamada, teste quebra.
    called = {"vision": False}

    async def _vision_should_not_run():
        called["vision"] = True
        return _ok_envelope()

    env = await ocr_router.route(
        "cnh",
        primary=_primary_err_code(502),
        vision=_vision_should_not_run,
        strategy="legacy",
    )
    assert env["code"] == 502
    assert called["vision"] is False


# ─── Strategy: vision-only ──────────────────────────────────────────────────


async def test_vision_only_skips_primary():
    called = {"primary": False}

    async def _primary_should_not_run():
        called["primary"] = True
        return _ok_envelope()

    env = await ocr_router.route(
        "cartao_cnpj",
        primary=_primary_should_not_run,
        vision=_vision_ok(),
        strategy="vision-only",
    )
    assert env["header"]["provider"] == "gpt4o-vision"
    assert called["primary"] is False


async def test_vision_only_propagates_vision_error():
    with pytest.raises(gpt4o_vision.GPT4oVisionError):
        await ocr_router.route(
            "cartao_cnpj",
            primary=_primary_ok(),
            vision=_vision_raises_vision_error(),
            strategy="vision-only",
        )


# ─── Strategy: infosimples-with-vision-fallback ─────────────────────────────


async def test_fallback_returns_primary_when_ok():
    env = await ocr_router.route(
        "cnh",
        primary=_primary_ok(),
        vision=_vision_ok(),
        strategy="infosimples-with-vision-fallback",
    )
    assert env["header"]["provider"] == "infosimples-test"
    assert "primary_error" not in env["header"]


async def test_fallback_uses_vision_when_primary_code_not_200():
    env = await ocr_router.route(
        "cnh",
        primary=_primary_err_code(502),
        vision=_vision_ok(),
        strategy="infosimples-with-vision-fallback",
    )
    assert env["header"]["provider"] == "gpt4o-vision-fallback"
    assert env["header"]["primary_error"] == "infosimples_code_502"
    assert env["data"][0]["campos"]["nome"]["valor"] == "Bar"


async def test_fallback_uses_vision_when_primary_raises():
    class FakeTimeout(Exception):
        pass

    env = await ocr_router.route(
        "cnh",
        primary=_primary_raises(FakeTimeout("upstream timeout")),
        vision=_vision_ok(),
        strategy="infosimples-with-vision-fallback",
    )
    assert env["header"]["provider"] == "gpt4o-vision-fallback"
    assert env["header"]["primary_error"] == "FakeTimeout"


async def test_fallback_returns_envelope_when_both_fail_logically():
    """Primary code!=200 + Vision exception -> envelope estruturado."""
    env = await ocr_router.route(
        "cnh",
        primary=_primary_err_code(503),
        vision=_vision_raises_vision_error(),
        strategy="infosimples-with-vision-fallback",
    )
    assert env["code"] == 503
    assert env["data"] == []
    assert env["header"]["provider"] == "fallback-both-failed"
    assert env["header"]["primary_error"] == "code_503"
    assert env["header"]["fallback_error"] == "GPT4oVisionError"


async def test_fallback_reraises_primary_when_both_throw():
    """Primary raise + Vision raise -> re-raise primary (handler mapeia)."""
    class FakeAPIError(Exception):
        pass

    with pytest.raises(FakeAPIError, match="upstream"):
        await ocr_router.route(
            "cnh",
            primary=_primary_raises(FakeAPIError("upstream")),
            vision=_vision_raises_vision_error(),
            strategy="infosimples-with-vision-fallback",
        )


async def test_fallback_handles_non_dict_primary():
    """Primary devolvendo nao-dict -> tratado como falha logica."""
    async def _primary_returns_string():
        return "isto nao eh envelope"

    env = await ocr_router.route(
        "cnh",
        primary=_primary_returns_string,
        vision=_vision_ok(),
        strategy="infosimples-with-vision-fallback",
    )
    assert env["header"]["provider"] == "gpt4o-vision-fallback"


# ─── Strategy desconhecida -> fallback pra legacy ───────────────────────────


async def test_unknown_strategy_falls_back_to_legacy():
    env = await ocr_router.route(
        "cnh", primary=_primary_ok(), vision=_vision_ok(), strategy="quantum"
    )
    assert env["header"]["provider"] == "infosimples-test"


# ─── strategy_for() lookup ──────────────────────────────────────────────────


def test_strategy_for_returns_configured_value(monkeypatch):
    from backend import config

    monkeypatch.setattr(config, "OCR_CNH_STRATEGY", "vision-only")
    monkeypatch.setattr(config, "OCR_SELFIE_CNH_STRATEGY", "legacy")
    assert ocr_router.strategy_for("cnh") == "vision-only"
    assert ocr_router.strategy_for("selfie_cnh") == "legacy"


def test_strategy_for_unknown_doc_returns_legacy():
    assert ocr_router.strategy_for("invalido") == "legacy"
