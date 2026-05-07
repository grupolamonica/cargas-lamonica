"""Cliente Infosimples — wrapper httpx com client reusável.

Tipos de erro especificos pra UI mostrar mensagem acionavel em vez de
um 500 generico: timeout (esperar/reduzir imagem) vs API error (token/suporte).
"""
import httpx

from config import (
    INFOSIMPLES_CONSULTAS_URL,
    INFOSIMPLES_IMAGENS_URL,
    INFOSIMPLES_TOKEN,
    TIMEOUT_CONSULTA,
    TIMEOUT_OCR,
)


class InfosimplesError(RuntimeError):
    """Base pra erros da integracao Infosimples."""


class InfosimplesTimeout(InfosimplesError):
    """Timeout na API externa — tipicamente imagem grande ou rede instavel.

    Na UI, mapeia pra 504 (gateway timeout) com sugestao de reduzir imagem.
    """


class InfosimplesAPIError(InfosimplesError):
    """A API externa retornou erro HTTP (4xx/5xx). Token invalido, saldo
    zerado, payload ruim, ou instabilidade do lado deles.

    Na UI, mapeia pra 502 (bad gateway).
    """
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


# Client singleton — inicializado no lifespan do FastAPI.
# Evita reabrir conexão TCP/TLS a cada request (~300ms ganho).
_client: httpx.AsyncClient | None = None


def set_client(client: httpx.AsyncClient) -> None:
    global _client
    _client = client


def _require_client() -> httpx.AsyncClient:
    if _client is None:
        raise RuntimeError("Client Infosimples não inicializado (verifique lifespan do FastAPI).")
    return _client


async def consultar(service: str, params: dict) -> dict:
    payload = {
        "token": INFOSIMPLES_TOKEN,
        "timeout": TIMEOUT_CONSULTA,
        **params,
    }
    client = _require_client()
    try:
        resp = await client.post(
            f"{INFOSIMPLES_CONSULTAS_URL}/{service}",
            data=payload,
            timeout=TIMEOUT_CONSULTA + 30,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        raise InfosimplesTimeout(
            f"Tempo limite excedido ao consultar Infosimples ({service}). Tente de novo."
        ) from None
    except httpx.HTTPStatusError as exc:
        raise InfosimplesAPIError(
            f"Infosimples retornou HTTP {exc.response.status_code} em {service}",
            status_code=exc.response.status_code,
        ) from exc


async def ocr(service: str, imagem_base64: str) -> dict:
    payload = {
        "token": INFOSIMPLES_TOKEN,
        "image_base64": imagem_base64,
    }
    client = _require_client()
    try:
        resp = await client.post(
            f"{INFOSIMPLES_IMAGENS_URL}/{service}",
            data=payload,
            timeout=TIMEOUT_OCR + 30,
        )
        resp.raise_for_status()
        return resp.json()
    except httpx.TimeoutException:
        raise InfosimplesTimeout(
            f"OCR demorou demais ({service}). Reduza a imagem ou tente novamente."
        ) from None
    except httpx.HTTPStatusError as exc:
        raise InfosimplesAPIError(
            f"Infosimples retornou HTTP {exc.response.status_code} em {service}",
            status_code=exc.response.status_code,
        ) from exc
