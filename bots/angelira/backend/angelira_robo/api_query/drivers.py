"""Cliente API para motoristas (drivers) na Angellira.

Espelha os exports do bundle JS do portal (modulo LXLT):
    GET    /profile/drivers/cpf/{cpf}        -> driverByCPF
    GET    /profile/drivers/{id}             -> findDriver
    GET    /profile/drivers/{id}/complete    -> validateDriver
    GET    /profile/drivers/validitybycnh/{cpf} -> validityCnh
    GET    /profile/types/drivers            -> tipos do motorista (Funcionario etc.)
    GET    /profile/types/cnh                -> categorias da CNH (A, B, C, D, E, ...)
    POST   /profile/drivers                  -> createDriver (JSON)
    PATCH  /profile/drivers/{id}             -> patchDriver (JSON)
    PUT    /profile/drivers/{id}/cnh         -> uploadCNH (multipart)
    PUT    /profile/drivers/{id}/rg          -> uploadRG  (multipart)

DESCOBERTAS IMPORTANTES (validadas via testes reais):
- POST e PATCH funcionam com JSON. O bundle JS usa multipart so quando ha
  arquivos; com JSON puro o backend processa direto. **Multipart silenciosamente
  perde campos de data** (birth, cnhValidity, firstCNHIssue). NUNCA usar multipart
  para o cadastro principal.
- PATCH zera campos relacionados quando voce toca em UM deles isolado. Por
  exemplo, PATCH {birth: '...'} zera cnhValidity e firstCNHIssue. Tem que mandar
  os 3 campos de data JUNTOS pra evitar essa side effect. Use `patch_grouped`.
- POST minimal `{prime, cpf, name}` retorna 200 com um "ghost id" 15228568 (um
  placeholder padrao do backend). So vira cadastro real quando o payload inclui
  os campos necessarios pra resolver endereco (cityId+neighborhoodId+...).
- Para o endereco funcionar, precisa enviar AMBOS: ids (cityId/stateId/...) E
  os nomes (cityName/stateName/neighborhoodName). So um ou so outro nao basta.
"""

from __future__ import annotations

import mimetypes
import os
from typing import Any

from ..logger import log_alerta, log_info
from .client import AngellraAPIClient


# Grupos de campos que devem ser PATCH-ados juntos para evitar side effects
# do backend (que zera os outros do grupo se nao forem reenviados).
CAMPOS_DATA = ("birth", "cnhValidity", "firstCNHIssue")
# Campos de endereco que API REJEITA (422 Cid_Codigo / .split undefined).
# Stripamos no PATCH/POST. IMPORTANTE: number e complement NAO entram aqui —
# eles SAO aceitos pela API (testado: PATCH com number+complement passa 200).
CAMPOS_ENDERECO = (
    "address",
    "cityId", "stateId", "neighborhoodId", "placeId",
    "cityName", "stateName", "neighborhoodName",
)


def _profile_url(client: AngellraAPIClient, path: str) -> str:
    base = client.base_url.rstrip("/")
    return f"{base}{path if path.startswith('/') else '/' + path}"


def _open_file(path: str | None, field_name: str):
    if not path:
        return None
    if not os.path.isfile(path):
        raise FileNotFoundError(f"[drivers.{field_name}] arquivo nao existe: {path}")
    mime, _ = mimetypes.guess_type(path)
    if not mime:
        mime = "application/octet-stream"
    return (os.path.basename(path), open(path, "rb"), mime)


# ── Leitura ──────────────────────────────────────────────────────────────────


def find_by_cpf(client: AngellraAPIClient, cpf: str) -> dict | None:
    """GET /profile/drivers/cpf/{cpf} -> dict | None."""
    sess = client._ensure_session()
    cpf_limpo = "".join(c for c in str(cpf or "") if c.isdigit())
    if len(cpf_limpo) != 11:
        return None
    resp = sess.get(_profile_url(client, f"/drivers/cpf/{cpf_limpo}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_id(client: AngellraAPIClient, driver_id: int) -> dict | None:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/drivers/{driver_id}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_types(client: AngellraAPIClient) -> list[dict]:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, "/types/drivers"), timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


def get_cnh_types(client: AngellraAPIClient) -> list[str]:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, "/types/cnh"), timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


def validate_complete(client: AngellraAPIClient, driver_id: int) -> dict:
    """GET /profile/drivers/{id}/complete -> {complete: bool, incomplete: list, isDriver: bool}."""
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/drivers/{driver_id}/complete"),
                    timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


def validity_cnh(client: AngellraAPIClient, cpf: str) -> dict:
    sess = client._ensure_session()
    cpf_limpo = "".join(c for c in str(cpf or "") if c.isdigit())
    resp = sess.get(_profile_url(client, f"/drivers/validitybycnh/{cpf_limpo}"),
                    timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


# ── Escrita: create / patch / upload ─────────────────────────────────────────


def _raise_with_body(resp, contexto: str) -> None:
    """raise_for_status mas com o body do erro incluido na mensagem."""
    if resp.ok:
        return
    body = (resp.text or "")[:600].replace("\n", " ")
    log_alerta(f"[{contexto}] HTTP {resp.status_code} body: {body}")
    resp.reason = f"{resp.reason} — body: {body}"
    resp.raise_for_status()


def create(client: AngellraAPIClient, payload: dict[str, Any]) -> dict:
    """POST /profile/drivers (JSON). Retorna `{"id": int}` do driver criado."""
    sess = client._ensure_session()
    log_info(f"[drivers.create] POST /drivers (JSON) fields={sorted(payload.keys())} body={payload}")
    resp = sess.post(
        _profile_url(client, "/drivers"),
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=client.default_timeout * 2,
    )
    _raise_with_body(resp, "drivers.create")
    return resp.json()


def patch(client: AngellraAPIClient, driver_id: int, payload: dict[str, Any]) -> dict:
    """PATCH /profile/drivers/{id} (JSON)."""
    sess = client._ensure_session()
    log_info(f"[drivers.patch] PATCH /drivers/{driver_id} (JSON) fields={sorted(payload.keys())}")
    resp = sess.patch(
        _profile_url(client, f"/drivers/{driver_id}"),
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=client.default_timeout * 2,
    )
    _raise_with_body(resp, f"drivers.patch[{driver_id}]")
    return resp.json()


def patch_grouped(
    client: AngellraAPIClient,
    driver_id: int,
    payload: dict[str, Any],
    *,
    current: dict | None = None,
) -> dict:
    """PATCH agrupando campos relacionados para evitar zerar valores existentes.

    Se voce passa apenas `{birth: ...}`, o backend zera cnhValidity e firstCNHIssue.
    Esta funcao detecta quando o payload toca em campos de um grupo e re-inclui
    os outros membros (do `current` ou do proprio payload) para preservar o estado.

    Args:
        current: estado atual do driver (de find_by_id ou find_by_cpf). Se None,
                 nao tenta preservar — usuario deve passar o grupo completo.
    """
    grupos = [CAMPOS_DATA, CAMPOS_ENDERECO]
    body = dict(payload)
    if current:
        for grupo in grupos:
            if any(c in body for c in grupo):
                # garante que TODOS os campos do grupo estao no body
                for campo in grupo:
                    if campo not in body and current.get(campo) is not None:
                        body[campo] = current[campo]
    return patch(client, driver_id, body)


def upload_attachments(
    client: AngellraAPIClient,
    driver_id: int,
    *,
    cnh_path: str | None = None,
    rg_path: str | None = None,
    consent_path: str | None = None,
    preserve_dates: dict | None = None,
    preserve_phones: list | None = None,
) -> dict:
    """Upload de CNH/RG/consentForm via PATCH multipart UNICO.

    A API descoberta nao tem `PUT /drivers/{id}/cnh` (retorna 404). O bundle
    referenciava isso mas o backend so aceita upload via `patchDriver`:
    PATCH /drivers/{id} multipart com `cnhFile`/`rgFile` + flags `hasCnhFile`/
    `hasRgFile`.

    IMPORTANTE: o PATCH multipart zera os campos de data E phones se nao
    forem reenviados. Por isso aceitamos `preserve_dates` e `preserve_phones`
    pra reenvia-los na mesma chamada e preservar o estado.

    Faz UMA SO chamada com todos os anexos juntos pra evitar zerar/zerar/zerar.
    """
    if not (cnh_path or rg_path or consent_path):
        return {"id": driver_id, "skipped": True}

    sess = client._ensure_session()
    files: dict[str, tuple] = {}
    # Phones obrigatorio no form — se NAO preservar, multipart reseta pra [].
    # Lemos os phones atuais via GET pra preservar se caller nao passou.
    if preserve_phones is None:
        try:
            cur = find_by_id(client, driver_id) or {}
            preserve_phones = cur.get("phones") or []
        except Exception:
            preserve_phones = []
    import json as _json
    data: dict[str, str] = {"phones": _json.dumps(preserve_phones)}
    open_handles: list = []

    try:
        if cnh_path:
            tup = _open_file(cnh_path, "cnh")
            files["cnhFile"] = tup
            data["hasCnhFile"] = "true"
            open_handles.append(tup[1])
        if rg_path:
            tup = _open_file(rg_path, "rg")
            files["rgFile"] = tup
            data["hasRgFile"] = "true"
            open_handles.append(tup[1])
        if consent_path:
            tup = _open_file(consent_path, "consent")
            files["consentFormFile"] = tup
            open_handles.append(tup[1])

        # Preserva campos de data — backend zera o que nao vier no form
        for k in CAMPOS_DATA:
            if preserve_dates and preserve_dates.get(k):
                data[k] = str(preserve_dates[k])

        log_info(f"[drivers.upload_attachments] PATCH /drivers/{driver_id} files={list(files.keys())} preserve={list(preserve_dates or {})}")
        resp = sess.patch(
            _profile_url(client, f"/drivers/{driver_id}"),
            data=data, files=files,
            timeout=client.default_timeout * 3,
        )
    finally:
        for fh in open_handles:
            try: fh.close()
            except Exception: pass

    _raise_with_body(resp, f"drivers.upload_attachments[{driver_id}]")
    return resp.json() if resp.text else {"id": driver_id}


# Compatibilidade: API antiga (chamadas separadas). Internamente direcionam pra
# upload_attachments que faz a chamada multipart correta.
def replace_cnh(client: AngellraAPIClient, driver_id: int, cnh_path: str) -> dict:
    """Sobe somente a CNH. Use `upload_attachments` quando tiver CNH+RG juntos."""
    return upload_attachments(client, driver_id, cnh_path=cnh_path)


def replace_rg(client: AngellraAPIClient, driver_id: int, rg_path: str) -> dict:
    return upload_attachments(client, driver_id, rg_path=rg_path)
