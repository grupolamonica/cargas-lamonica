"""Cliente GPT-4o Vision para extração OCR.

Uso típico::

    from gpt4o_vision import extract

    envelope = await extract("cnh", image_b64, slot_hint="motorista")
    # envelope segue contrato Infosimples-compat:
    # {"code": 200, "code_message": "...", "data": [...], "header": {...}}

Garantias:

* Token OpenAI nunca é logado (regex de redação em qualquer mensagem que
  passe por ``str(exc)``).
* Circuit breaker abre após 5 falhas consecutivas em 60s — retorna
  envelope ``code=503`` durante o cooldown (30s).
* Orçamento diário (USD) controlado por :data:`config.GPT4O_DAILY_BUDGET_USD`.
  Reset diário UTC. Excedido → envelope ``code=429``.
* ``response_format={"type": "json_object"}`` + ``temperature=0`` para
  reduzir JSON malformado.

Inicialização:

* :func:`init_client_from_env` é idempotente e chamada pelo lifespan do
  FastAPI (vide ``main.py``).
* Se ``OPENAI_API_KEY`` não estiver setado, :func:`is_available` retorna
  False e :func:`extract` levanta :class:`GPT4oVisionError`.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

try:
    from openai import AsyncOpenAI
    from openai import APIError, APITimeoutError, RateLimitError
except ImportError:  # pragma: no cover — Fase 1 garante install
    AsyncOpenAI = None  # type: ignore[assignment, misc]
    APIError = APITimeoutError = RateLimitError = Exception  # type: ignore[misc, assignment]

# Import robusto: o sidecar roda em DOIS contextos de sys.path incompatíveis.
#   - run.py: insere `backend/` em sys.path e importa flat (`import gpt4o_vision`
#     via main.py), então este módulo NÃO tem pacote pai → `from . import ...`
#     quebra com "attempted relative import with no known parent package"
#     (crash no boot do sidecar).
#   - tests/conftest.py: insere o root do sidecar e importa `from backend import
#     gpt4o_vision`, então o pacote é `backend` e os módulos flat não existem.
# A relativa cobre o contexto de teste; a flat cobre o runtime do run.py.
try:  # contexto de teste (pacote `backend`)
    from . import config
    from .prompts import OCR_PROMPTS, PROMPT_VERSION
except ImportError:  # runtime via run.py (módulo flat, sem pacote pai)
    import config  # type: ignore[no-redef]
    from prompts import OCR_PROMPTS, PROMPT_VERSION


log = logging.getLogger("cadastro-motorista.gpt4o_vision")


# ─── Exceções públicas ───────────────────────────────────────────────────────


class GPT4oVisionError(RuntimeError):
    """Erro genérico do cliente Vision (rede, API, JSON inválido)."""


class GPT4oVisionTimeout(GPT4oVisionError):
    """Timeout ao chamar a API OpenAI."""


class GPT4oVisionParseError(GPT4oVisionError):
    """Resposta da API não pôde ser parseada como JSON."""


class GPT4oVisionCircuitOpen(GPT4oVisionError):
    """Circuit breaker aberto — chamadas bloqueadas durante cooldown."""


class GPT4oVisionBudgetExceeded(GPT4oVisionError):
    """Orçamento diário (USD) atingido."""


# ─── Redação de tokens em mensagens de erro ──────────────────────────────────


_TOKEN_REDACT_RE = re.compile(r"sk-[A-Za-z0-9_\-]{16,}")


def redact(text: str) -> str:
    """Remove tokens OpenAI/Anthropic-style de qualquer string."""
    if not text:
        return text
    return _TOKEN_REDACT_RE.sub("sk-***REDACTED***", text)


def install_log_redactor() -> None:
    """Instala redator global via ``logging.setLogRecordFactory``. Idempotente.

    Aplica a redação NO MOMENTO de criação do record — antes do filter chain
    e do handler. Funciona para records criados em qualquer logger (módulos
    terceiros incluso), o que não acontece se usarmos ``Logger.addFilter()``
    no root (filtros do parent não são chamados pelos descendentes).
    """
    factory = logging.getLogRecordFactory()
    if getattr(factory, "_gpt4o_redactor_installed", False):
        return
    original = factory

    def redactor_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = original(*args, **kwargs)
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover
            return record
        if "sk-" in msg:
            record.msg = redact(str(record.msg))
            record.args = ()
        return record

    redactor_factory._gpt4o_redactor_installed = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(redactor_factory)


# ─── Pricing (USD por 1M tokens) — atualizar se OpenAI mudar tabela ──────────


_PRICING_USD_PER_MTOK: dict[str, tuple[float, float]] = {
    # modelo: (input, output)
    "gpt-4o": (5.00, 15.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4o-2024-08-06": (2.50, 10.00),  # variante mais barata
    "gpt-4o-2024-11-20": (2.50, 10.00),
}


def _estimate_cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    rates = _PRICING_USD_PER_MTOK.get(model)
    if rates is None:
        # Modelo desconhecido — fallback conservador (assume preço do gpt-4o).
        log.warning("Pricing desconhecido para modelo %s — usando gpt-4o rates", model)
        rates = _PRICING_USD_PER_MTOK["gpt-4o"]
    in_rate, out_rate = rates
    return (prompt_tokens / 1_000_000.0) * in_rate + (
        completion_tokens / 1_000_000.0
    ) * out_rate


# ─── Circuit breaker (fail-fast quando OpenAI está caindo) ──────────────────


@dataclass
class _CircuitState:
    failures: list[float] = field(default_factory=list)
    opened_at: Optional[float] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_CIRCUIT_FAIL_WINDOW_SEC = 60.0
_CIRCUIT_FAIL_THRESHOLD = 5
_CIRCUIT_COOLDOWN_SEC = 30.0

_circuit = _CircuitState()


async def _circuit_check() -> None:
    """Levanta GPT4oVisionCircuitOpen se circuit estiver aberto."""
    async with _circuit.lock:
        if _circuit.opened_at is None:
            return
        if time.monotonic() - _circuit.opened_at >= _CIRCUIT_COOLDOWN_SEC:
            log.info("Circuit breaker fechando (cooldown expirou)")
            _circuit.opened_at = None
            _circuit.failures.clear()
            return
        raise GPT4oVisionCircuitOpen(
            f"Provider Vision indisponível por mais "
            f"{int(_CIRCUIT_COOLDOWN_SEC - (time.monotonic() - _circuit.opened_at))}s"
        )


async def _circuit_record_failure() -> None:
    async with _circuit.lock:
        now = time.monotonic()
        _circuit.failures = [
            t for t in _circuit.failures if now - t < _CIRCUIT_FAIL_WINDOW_SEC
        ]
        _circuit.failures.append(now)
        if len(_circuit.failures) >= _CIRCUIT_FAIL_THRESHOLD:
            _circuit.opened_at = now
            log.error(
                "Circuit breaker aberto: %d falhas em %ds",
                len(_circuit.failures),
                _CIRCUIT_FAIL_WINDOW_SEC,
            )


async def _circuit_record_success() -> None:
    async with _circuit.lock:
        # Sucesso esporádico não fecha o breaker, mas reduz a janela.
        if _circuit.failures:
            _circuit.failures.pop(0)


# ─── Budget tracker (USD por dia UTC) ────────────────────────────────────────


@dataclass
class _BudgetState:
    date_utc: str = ""  # 'YYYY-MM-DD'
    spent_usd: float = 0.0
    calls: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


_budget = _BudgetState()


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


async def _budget_record(usd: float) -> None:
    async with _budget.lock:
        today = _today_utc()
        if _budget.date_utc != today:
            _budget.date_utc = today
            _budget.spent_usd = 0.0
            _budget.calls = 0
        _budget.spent_usd += usd
        _budget.calls += 1


async def _budget_check() -> None:
    """Levanta GPT4oVisionBudgetExceeded se já passou do orçamento do dia."""
    async with _budget.lock:
        today = _today_utc()
        if _budget.date_utc != today:
            return  # novo dia, ainda zerado
        if _budget.spent_usd >= config.GPT4O_DAILY_BUDGET_USD:
            raise GPT4oVisionBudgetExceeded(
                f"Limite diário atingido: ${_budget.spent_usd:.2f} / "
                f"${config.GPT4O_DAILY_BUDGET_USD:.2f}"
            )


def budget_snapshot() -> dict:
    """Retorna estado atual do budget (sem lock — para /api/status)."""
    return {
        "date_utc": _budget.date_utc or _today_utc(),
        "spent_usd": round(_budget.spent_usd, 4),
        "calls": _budget.calls,
        "limit_usd": config.GPT4O_DAILY_BUDGET_USD,
    }


# ─── Cliente OpenAI (singleton) ──────────────────────────────────────────────


_client: Optional["AsyncOpenAI"] = None


def init_client_from_env() -> bool:
    """Inicializa o singleton ``AsyncOpenAI`` a partir das envs.

    Idempotente. Retorna True se o cliente foi inicializado (token presente
    + SDK instalado), False caso contrário.
    """
    global _client
    if _client is not None:
        return True
    if AsyncOpenAI is None:
        log.warning("openai SDK não instalado — Vision indisponível")
        return False
    if not config.OPENAI_API_KEY:
        return False
    try:
        _client = AsyncOpenAI(
            api_key=config.OPENAI_API_KEY,
            max_retries=config.GPT4O_VISION_MAX_RETRIES,
            timeout=config.GPT4O_VISION_TIMEOUT_SECONDS,
        )
    except Exception as exc:  # pragma: no cover
        log.error("Falha ao inicializar AsyncOpenAI: %s", redact(str(exc)))
        return False
    install_log_redactor()
    log.info("GPT-4o Vision client inicializado (modelo=%s)", config.GPT4O_VISION_MODEL)
    return True


def set_client(client: Any) -> None:
    """Substitui o singleton — usado apenas em testes."""
    global _client
    _client = client


def is_available() -> bool:
    """True se o cliente está pronto para chamadas."""
    return _client is not None


# ─── Helpers de imagem ───────────────────────────────────────────────────────


def _strip_dataurl(image_b64: str) -> str:
    """Remove prefixo ``data:image/...;base64,`` se presente."""
    if image_b64.startswith("data:"):
        comma = image_b64.find(",")
        if comma >= 0:
            return image_b64[comma + 1 :]
    return image_b64


def _detect_mime(image_b64: str) -> str:
    """Detecta MIME pela assinatura no header decodificado.

    Conservador: se não conseguir detectar, usa ``image/jpeg`` (default mais
    aceito pela OpenAI Vision). PDF é detectado mas não suportado pelo
    Vision API atualmente — caller deve rasterizar antes.
    """
    raw = _strip_dataurl(image_b64)
    try:
        head = base64.b64decode(raw[:32], validate=False)[:8]
    except Exception:
        return "image/jpeg"
    if head.startswith(b"\x89PNG"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:4] == b"GIF8":
        return "image/gif"
    if head[:4] == b"%PDF":
        return "application/pdf"
    if head[:4] in (b"RIFF",):
        return "image/webp"
    return "image/jpeg"


# ─── Construção do envelope Infosimples-compat ───────────────────────────────


def _to_envelope(
    doc_type: str,
    parsed: dict,
    *,
    model: str,
    prompt_tokens: int,
    completion_tokens: int,
    usd: float,
) -> dict:
    """Mapeia o dict cru do GPT no envelope esperado pelo frontend.

    Cada chave do dict vira ``campos[k] = {"valor": v, "score": None}``.
    Valores ``None``/``""`` são preservados como ``None``.
    """
    campos: dict[str, dict] = {}
    for key, value in parsed.items():
        if value is None or (isinstance(value, str) and not value.strip()):
            campos[key] = {"valor": None, "score": None}
        else:
            campos[key] = {"valor": str(value), "score": None}
    return {
        "code": 200,
        "code_message": "OCR via GPT-4o Vision",
        "data": [{"tipo": doc_type, "campos": campos}],
        "data_count": 1,
        "errors": [],
        "header": {
            "provider": "gpt4o-vision",
            "model": model,
            "prompt_version": PROMPT_VERSION,
            "tokens": {
                "in": prompt_tokens,
                "out": completion_tokens,
                "usd": round(usd, 6),
            },
        },
    }


# ─── API pública: extract() ──────────────────────────────────────────────────


async def extract(
    doc_type: str,
    image_b64: str,
    *,
    slot_hint: Optional[str] = None,
) -> dict:
    """Extrai dados do documento via GPT-4o Vision.

    Args:
        doc_type: chave em :data:`prompts.OCR_PROMPTS` (cnh, crlv,
            cartao_cnpj, rntrc, comprovante, selfie_cnh).
        image_b64: imagem base64 (com ou sem prefixo ``data:``).
        slot_hint: hint opcional propagado para o prompt (uso futuro;
            atualmente ignorado pelo prompt — deixar parâmetro estável).

    Returns:
        Envelope Infosimples-compat ``{"code", "code_message", "data",
        "header"}``.

    Raises:
        GPT4oVisionError: caso o cliente não esteja inicializado ou
            ``doc_type`` desconhecido.
        GPT4oVisionTimeout: timeout na chamada.
        GPT4oVisionParseError: resposta JSON malformada.
        GPT4oVisionCircuitOpen: circuit breaker aberto.
        GPT4oVisionBudgetExceeded: orçamento diário atingido.
    """
    if not is_available():
        raise GPT4oVisionError(
            "GPT-4o Vision client não inicializado (OPENAI_API_KEY ausente?)"
        )
    if doc_type not in OCR_PROMPTS:
        raise GPT4oVisionError(f"doc_type desconhecido: {doc_type}")

    await _budget_check()
    await _circuit_check()

    prompt = OCR_PROMPTS[doc_type]
    mime = _detect_mime(image_b64)
    if mime == "application/pdf":
        # Vision API atualmente não aceita PDF direto — caller deve
        # rasterizar (já fazemos isso para CRLV via pypdf). Sinalizamos
        # erro estruturado em vez de chamar a API com payload inválido.
        raise GPT4oVisionError(
            "PDF não suportado pelo Vision API — rasterizar antes (ver pypdf)"
        )
    payload_b64 = _strip_dataurl(image_b64)
    data_url = f"data:{mime};base64,{payload_b64}"

    model = config.GPT4O_VISION_MODEL
    assert _client is not None  # nosec — is_available() já garantiu

    try:
        resp = await _client.chat.completions.create(
            model=model,
            response_format={"type": "json_object"},
            temperature=0.0,
            max_tokens=1500,
            messages=[
                {"role": "system", "content": prompt.system},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt.user},
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url, "detail": "high"},
                        },
                    ],
                },
            ],
        )
    except APITimeoutError as exc:
        await _circuit_record_failure()
        raise GPT4oVisionTimeout(redact(str(exc))) from None
    except RateLimitError as exc:
        await _circuit_record_failure()
        raise GPT4oVisionError(f"rate_limit: {redact(str(exc))}") from None
    except APIError as exc:
        await _circuit_record_failure()
        raise GPT4oVisionError(redact(str(exc))) from None
    except Exception as exc:
        await _circuit_record_failure()
        raise GPT4oVisionError(f"erro inesperado: {redact(str(exc))}") from None

    raw = (resp.choices[0].message.content or "{}").strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        await _circuit_record_failure()
        # Não logamos o raw — pode conter PII extraída do documento.
        raise GPT4oVisionParseError(
            f"JSON malformado da Vision API: {exc.msg} (linha {exc.lineno})"
        ) from None

    if not isinstance(parsed, dict):
        await _circuit_record_failure()
        raise GPT4oVisionParseError("Vision API retornou JSON não-object")

    usage = resp.usage
    prompt_tokens = getattr(usage, "prompt_tokens", 0) if usage else 0
    completion_tokens = getattr(usage, "completion_tokens", 0) if usage else 0
    usd = _estimate_cost_usd(model, prompt_tokens, completion_tokens)
    await _budget_record(usd)
    await _circuit_record_success()

    return _to_envelope(
        doc_type,
        parsed,
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        usd=usd,
    )
