"""Router que aplica estratégia de provider OCR por endpoint.

Pattern alvo da migração (vide ``docs/lgpd-openai-processor.md``):

+----------------+----------------------+------------------------+
| Endpoint       | Primary              | Fallback               |
+================+======================+========================+
| /api/ocr/cnh   | Infosimples          | GPT-4o Vision          |
| /api/ocr/crlv  | Infosimples          | GPT-4o Vision          |
| /cartao-cnpj   | GPT-4o Vision        | — (RF complementa)     |
| /rntrc         | GPT-4o Vision        | — (ANTT valida)        |
| /comprovante   | GPT-4o Vision        | — (sem API)            |
| /selfie-cnh    | GPT-4o Vision        | — (sem API)            |
+----------------+----------------------+------------------------+

Cada endpoint chama :func:`route` passando duas factories assíncronas
(``primary`` e ``vision``) — a função aplica a :data:`Strategy` configurada
e retorna o envelope. As factories são preguiçosas para evitar chamada
desnecessária quando a estratégia já dispensa um dos providers.
"""

from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

from . import gpt4o_vision


log = logging.getLogger("cadastro-motorista.ocr_router")


# Tipo de uma factory async que retorna envelope.
EnvelopeFactory = Callable[[], Awaitable[dict]]


class _PrimaryFailedLogically(Exception):
    """Sinaliza que o primary retornou code != 200 — gatilho para fallback."""

    def __init__(self, code: int, message: str = ""):
        self.code = code
        self.message = message


async def _try_primary(primary: EnvelopeFactory, doc_type: str) -> dict:
    """Chama o primary; converte code!=200 em exception logica."""
    resp = await primary()
    if not isinstance(resp, dict):
        raise _PrimaryFailedLogically(0, f"resposta primary nao-dict em {doc_type}")
    code = resp.get("code")
    if code != 200:
        raise _PrimaryFailedLogically(
            code or 0, str(resp.get("code_message") or "primary code != 200")
        )
    return resp


def _annotate_fallback(env: dict, primary_error: str) -> dict:
    """Marca envelope como originado de fallback (telemetria)."""
    header = env.setdefault("header", {})
    header["provider"] = "gpt4o-vision-fallback"
    header["primary_error"] = primary_error
    return env


async def route(
    doc_type: str,
    *,
    primary: EnvelopeFactory,
    vision: EnvelopeFactory,
    strategy: str,
) -> dict:
    """Executa a estratégia configurada.

    Args:
        doc_type: chave do prompt (cnh, crlv, cartao_cnpj, rntrc,
            comprovante, selfie_cnh). Usado só para log.
        primary: factory async do provider primário (Infosimples ou local).
            Não é chamada quando ``strategy == "vision-only"``.
        vision: factory async do GPT-4o Vision. Não é chamada quando
            ``strategy == "legacy"``.
        strategy: ``legacy`` | ``infosimples-with-vision-fallback`` |
            ``vision-only``. Valores inválidos caem pra ``legacy``.

    Returns:
        Envelope ``{"code", "code_message", "data", "header"}``.

    Raises:
        Qualquer exceção do provider chamado (Infosimples ou Vision)
        propaga sem tradução — o handler do endpoint decide o HTTP status
        via ``_tratar_erro()``.
    """
    if strategy == "vision-only":
        return await vision()

    if strategy == "legacy":
        return await primary()

    # infosimples-with-vision-fallback
    if strategy != "infosimples-with-vision-fallback":
        log.warning("strategy desconhecida '%s' em %s — usando legacy", strategy, doc_type)
        return await primary()

    try:
        return await _try_primary(primary, doc_type)
    except _PrimaryFailedLogically as exc:
        log.info(
            "primary code=%s em %s — fallback Vision (msg=%s)",
            exc.code, doc_type, exc.message[:120],
        )
        try:
            env = await vision()
        except gpt4o_vision.GPT4oVisionError as vexc:
            # Fallback falhou — re-levanta primary error como envelope.
            # Frontend ja sabe lidar com code != 200 via humanizeOcrMessage.
            log.warning("Fallback Vision tambem falhou em %s: %s", doc_type, vexc)
            return {
                "code": exc.code or 502,
                "code_message": (
                    f"Provider primario falhou (code={exc.code}). "
                    f"Fallback indisponivel: {type(vexc).__name__}"
                ),
                "data": [],
                "data_count": 0,
                "errors": [exc.message, str(vexc)],
                "header": {
                    "provider": "fallback-both-failed",
                    "primary_error": f"code_{exc.code}",
                    "fallback_error": type(vexc).__name__,
                },
            }
        return _annotate_fallback(env, f"infosimples_code_{exc.code}")
    except Exception as exc:
        # Exception real (timeout, rede, etc.) — log com tipo e tenta Vision.
        log.warning(
            "primary exception em %s (%s) — fallback Vision: %s",
            doc_type, type(exc).__name__, str(exc)[:120],
        )
        try:
            env = await vision()
        except gpt4o_vision.GPT4oVisionError as vexc:
            log.error(
                "Fallback Vision tambem falhou em %s: %s",
                doc_type, vexc,
            )
            # Re-levanta primary exception original — handler de endpoint
            # mapeia (InfosimplesTimeout -> 504, etc.).
            raise exc
        return _annotate_fallback(env, type(exc).__name__)


def strategy_for(doc_type: str) -> str:
    """Lookup centralizado da strategy por doc_type.

    Reutilizado pelos endpoints em main.py e por testes.
    """
    from . import config

    return {
        "cnh": config.OCR_CNH_STRATEGY,
        "crlv": config.OCR_CRLV_STRATEGY,
        "cartao_cnpj": config.OCR_CARTAO_CNPJ_STRATEGY,
        "rntrc": config.OCR_RNTRC_STRATEGY,
        "comprovante": config.OCR_COMPROVANTE_STRATEGY,
        "selfie_cnh": config.OCR_SELFIE_CNH_STRATEGY,
    }.get(doc_type, "legacy")
