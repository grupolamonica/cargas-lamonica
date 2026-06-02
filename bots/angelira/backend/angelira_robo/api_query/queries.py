"""Cliente API para o recurso `/query` da Angellira (consultas / cadastros).

Espelha os exports do bundle de profile.angellira.com.br:
    GET    /query                        -> list (com paginacao)
    POST   /query/preflight              -> preflight (valida licenca/state)
    POST   /query                        -> storeQuery (cria a consulta/cadastro)
    POST   /query/requery                -> renewQuery (re-cadastra NAO_CONFORME)
    GET    /query/{id}                   -> fetchQuery
    GET    /query/{id}/report            -> fetchQueryReport

`queryTypeId` (de GET /types/queries):
    1=Integrado, 2=Cavalo, 3=Carreta, 4=Motorista, 5=Empresa.

`prime`:
    0=NORMAL, 1=PRIME, 2=PRIME PLUS — depende da licenca da empresa.
"""

from __future__ import annotations

from typing import Any

from ..logger import log_alerta, log_info
from .client import AngellraAPIClient


QUERY_TYPE_INTEGRADO = 1
QUERY_TYPE_CAVALO = 2
QUERY_TYPE_CARRETA = 3
QUERY_TYPE_MOTORISTA = 4
QUERY_TYPE_EMPRESA = 5

PRIME_NORMAL = 0
PRIME_PRIME = 1
PRIME_PRIME_PLUS = 2


def _profile_url(client: AngellraAPIClient, path: str) -> str:
    base = client.base_url.rstrip("/")
    return f"{base}{path if path.startswith('/') else '/' + path}"


def preflight(
    client: AngellraAPIClient,
    *,
    prime: int = PRIME_NORMAL,
    query_type_id: int = QUERY_TYPE_MOTORISTA,
    driver_id: int | None = None,
    cab_id: int | None = None,
    tow_id: int | None = None,
    company_id: int | None = None,
) -> dict:
    """POST /query/preflight — valida se a query pode ser feita antes de chamar store_query.

    Retorna `{registrationValidity, lastValidRegistrationValidity, recentQueryId,
              incompleteEntities, summary: {requery: bool, query: bool}}`.

    Use `summary.query` antes de chamar store_query.
    """
    body: dict[str, Any] = {"prime": prime, "queryTypeId": query_type_id}
    if driver_id is not None:
        body["driverId"] = driver_id
    if cab_id is not None:
        body["cabId"] = cab_id
    if tow_id is not None:
        body["towId"] = tow_id
    if company_id is not None:
        body["companyId"] = company_id

    sess = client._ensure_session()
    log_info(f"[queries.preflight] POST /query/preflight body={body}")
    resp = sess.post(
        _profile_url(client, "/query/preflight"),
        json=body,
        timeout=client.default_timeout,
    )
    resp.raise_for_status()
    return resp.json()


def store_query(
    client: AngellraAPIClient,
    *,
    prime: int = PRIME_NORMAL,
    query_type_id: int = QUERY_TYPE_MOTORISTA,
    driver_id: int | None = None,
    cab_id: int | None = None,
    tow_id: int | None = None,
    company_id: int | None = None,
    freight_id: int | None = None,
) -> tuple[int, dict]:
    """POST /query — cria a consulta/cadastro. Retorna (queryId, response).

    O server responde `201 Created. Redirecting to /query/{id}` (texto) com
    o id na URL. Extraimos o id pro caller.
    """
    body: dict[str, Any] = {"prime": prime, "queryTypeId": query_type_id}
    if driver_id is not None:
        body["driverId"] = driver_id
    if cab_id is not None:
        body["cabId"] = cab_id
    if tow_id is not None:
        body["towId"] = tow_id
    if company_id is not None:
        body["companyId"] = company_id
    if freight_id is not None:
        body["freightId"] = freight_id

    sess = client._ensure_session()
    log_info(f"[queries.store] POST /query body={body}")
    resp = sess.post(
        _profile_url(client, "/query"),
        json=body,
        timeout=client.default_timeout * 2,
    )
    # Server retorna 201 "Created. Redirecting to /query/{id}" — extrai o id
    if resp.status_code in (200, 201):
        text = resp.text or ""
        query_id = _extrair_query_id_de_resposta(text)
        log_info(f"[queries.store] OK queryId={query_id}")
        return query_id, {"raw": text, "queryId": query_id, "status": resp.status_code}
    # Erro: logar e propagar
    log_alerta(f"[queries.store] FALHA status={resp.status_code} body={resp.text[:300]}")
    resp.raise_for_status()
    raise RuntimeError(f"store_query: HTTP {resp.status_code}: {resp.text[:200]}")


def _extrair_query_id_de_resposta(texto: str) -> int:
    """'Created. Redirecting to /query/2364517' -> 2364517"""
    if not texto:
        return 0
    marker = "/query/"
    idx = texto.find(marker)
    if idx < 0:
        return 0
    rest = texto[idx + len(marker):].strip()
    digits = ""
    for ch in rest:
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits else 0


def fetch(client: AngellraAPIClient, query_id: int) -> dict | None:
    """GET /query/{id} -> dict ou None se nao existir."""
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/query/{query_id}"), timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def renew_query(
    client: AngellraAPIClient,
    query_id: int,
    *,
    prime: int = PRIME_NORMAL,
) -> tuple[int, dict]:
    """POST /query/requery — re-cadastra um query existente (caso NAO_CONFORME)."""
    body: dict[str, Any] = {"prime": prime, "queryId": query_id}
    sess = client._ensure_session()
    log_info(f"[queries.renew] POST /query/requery body={body}")
    resp = sess.post(
        _profile_url(client, "/query/requery"),
        json=body,
        timeout=client.default_timeout * 2,
    )
    if resp.status_code in (200, 201):
        new_id = _extrair_query_id_de_resposta(resp.text or "") or query_id
        return new_id, {"raw": resp.text, "queryId": new_id, "status": resp.status_code}
    log_alerta(f"[queries.renew] FALHA status={resp.status_code} body={resp.text[:300]}")
    resp.raise_for_status()
    raise RuntimeError(f"renew_query: HTTP {resp.status_code}: {resp.text[:200]}")
