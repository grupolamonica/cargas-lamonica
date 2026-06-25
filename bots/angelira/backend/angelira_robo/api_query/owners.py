"""Cliente API para proprietarios (owners) na Angellira.

Endpoints (todos sob /profile):
    GET    /owners?q={}                   -> queryOwners
    GET    /owners/legal?q={}             -> legalOwners (so PJ)
    GET    /owners/available?q={}         -> queryAvailableOwners (sugestoes)
    GET    /owners/cpf/{cpf}              -> ownerByCPF (PF)
    GET    /owners/cnpj/{cnpj}            -> ownerByCNPJ (PJ)
    GET    /owners/{id}                   -> ownerById
    GET    /owners/{id}/complete          -> validateOwner
    POST   /owners                        -> createOwner (JSON)
    PATCH  /owners/{id}                   -> updateOwner

`type` aceita: "natural" (PF) ou "legal" (PJ).

DESCOBERTA: POST /owners cria o owner E a consulta na mesma chamada, retornando
`{id, queryId}`. queryTypeId resultante = 5 (Empresa) pra PJ.

Campos obrigatorios POST /owners (PJ):
    name, cnpj, type="legal", relationship, phones (>=1 com typeId=2 fixo),
    address, number (INT), cityId, stateId, neighborhoodId, neighborhoodName,
    placeId, cep.

NAO aceitos: companyId, complement, cityName, stateName, ie, stateRegistration,
cellphone, city/state/neighborhood/place como objeto nested.
"""

from __future__ import annotations

from typing import Any

from ..logger import log_alerta, log_info
from .client import AngellraAPIClient


PERSON_NATURAL = "natural"
PERSON_LEGAL = "legal"

# POST /owners PJ aceita typeId=2 (fixo). PF exige typeId=3 (celular).
PHONE_TYPE_FIXO = 2
PHONE_TYPE_CELULAR = 3


def _profile_url(client: AngellraAPIClient, path: str) -> str:
    base = client.base_url.rstrip("/")
    return f"{base}{path if path.startswith('/') else '/' + path}"


# ── Leitura ──────────────────────────────────────────────────────────────────


def find_by_cnpj(client: AngellraAPIClient, cnpj: str) -> dict | None:
    sess = client._ensure_session()
    digitos = "".join(c for c in str(cnpj or "") if c.isdigit())
    if len(digitos) != 14:
        return None
    resp = sess.get(_profile_url(client, f"/owners/cnpj/{digitos}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_cpf(client: AngellraAPIClient, cpf: str) -> dict | None:
    sess = client._ensure_session()
    digitos = "".join(c for c in str(cpf or "") if c.isdigit())
    if len(digitos) != 11:
        return None
    resp = sess.get(_profile_url(client, f"/owners/cpf/{digitos}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_id(client: AngellraAPIClient, owner_id: int) -> dict | None:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/owners/{owner_id}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def validate_complete(client: AngellraAPIClient, owner_id: int) -> dict:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/owners/{owner_id}/complete"),
                    timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


# ── Escrita ──────────────────────────────────────────────────────────────────


def _raise_with_body(resp, contexto: str) -> None:
    if resp.ok:
        return
    body = (resp.text or "")[:800].replace("\n", " ")
    log_alerta(f"[{contexto}] HTTP {resp.status_code} body: {body}")
    resp.reason = f"{resp.reason} — body: {body}"
    resp.raise_for_status()


def create(client: AngellraAPIClient, payload: dict[str, Any], *, timeout: float = 120.0) -> dict:
    """POST /profile/owners (JSON). Retorna `{id, queryId, ...}`.

    timeout (2026-06-25): POST /owners cria o owner E dispara a consulta na
    MESMA chamada. Para PJ (empresa), a consulta do AngelLira faz um lookup
    Receita/CNPJ sincrono que leva 30-90s (mesma janela que o Node ja conhece:
    vide angellira-bot-client.js "relatorio leva 30-90s" -> timeout Node = 180s).
    O antigo `default_timeout * 2` (=30s) cortava ANTES da consulta PJ terminar
    e derrubava o ramo do cavalo inteiro com "Read timed out (30.0)" (caso
    FERNANDO/TEIXEIRA LOPES TRANSPORTES LTDA, 2026-06-25). 120s cabe no pior
    caso com folga sob os 180s do Node->bot. PF responde em <2s, entao o teto
    maior nao a afeta (so esperamos o que a API demorar)."""
    sess = client._ensure_session()
    log_info(f"[owners.create] POST /owners fields={sorted(payload.keys())} timeout={timeout}s")
    resp = sess.post(
        _profile_url(client, "/owners"),
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )
    _raise_with_body(resp, "owners.create")
    return resp.json()


# Campos read-only no PATCH /owners — sao definidos pelo POST original.
# IMPORTANTE: type e relationship NAO sao filtrados aqui — eles SAO necessarios
# em PATCHes quando o owner foi criado com state inconsistente (type='EMPRESA'
# do legado) e precisamos forcar type='legal'/'natural' + relationship junto
# pra satisfazer a Joi do backend.
CAMPOS_READONLY_PATCH = {"cnpj", "cpf"}


def _open_file(path: str, field_name: str):
    import os, mimetypes
    if not os.path.isfile(path):
        raise FileNotFoundError(f"[owners.{field_name}] arquivo nao existe: {path}")
    mime, _ = mimetypes.guess_type(path)
    return (os.path.basename(path), open(path, "rb"), mime or "application/octet-stream")


def upload_documento(client: AngellraAPIClient, owner_id: int, doc_path: str,
                     *, field_name: str = "cnhFile",
                     known_cpf: str | None = None,
                     known_cnpj: str | None = None) -> dict:
    """Upload de documento do proprietario via PATCH /owners/{id} multipart.

    field_name: 'cnhFile' (PF — CNH do proprietario) ou 'rgFile' (cartao CNPJ
    em alguns layouts). O bundle nao expoe um endpoint dedicado para owners
    como faz para drivers (PUT /drivers/{id}/cnh); usamos PATCH multipart
    seguindo o padrao do patchOwner do portal.

    A Joi do PATCH multipart EXIGE preserve dos campos identificadores e do
    endereco — senao retorna 422 'Validation error' / 'Cid_Codigo undefined'
    / 'Cannot read properties of null (reading dataValues)'.

    Pegamos do estado atual via GET /owners/{id} e reenviamos. O caller pode
    passar `known_cpf`/`known_cnpj` como fallback se o GET vier sem esses
    campos (caso visto na bateria 2026-05-21).
    """
    sess = client._ensure_session()

    # Le estado atual pra reenviar campos obrigatorios
    try:
        cur = sess.get(_profile_url(client, f"/owners/{owner_id}"),
                       timeout=client.default_timeout).json() or {}
    except Exception:
        cur = {}

    data: dict[str, str] = {}
    has_flag = f"has{field_name[0].upper()}{field_name[1:]}"  # cnhFile -> hasCnhFile
    data[has_flag] = "true"

    # Identificadores — busca em multiplos lugares pra ser robusto:
    # 1) cur.natural.cpf / cur.legal.cnpj (nested padrão)
    # 2) cur.cpf / cur.cnpj (top-level, alguns endpoints retornam assim)
    # 3) known_cpf / known_cnpj (passado pelo caller — última garantia)
    nat = cur.get("natural") or {}
    leg = cur.get("legal") or {}
    digits = lambda v: "".join(c for c in str(v or "") if c.isdigit())
    cpf_resolved = digits(nat.get("cpf") or cur.get("cpf") or known_cpf or "")
    cnpj_resolved = digits(leg.get("cnpj") or cur.get("cnpj") or known_cnpj or "")
    # Fix #6 (2026-05-21): o cur.type vem como label legível ("EMPRESA",
    # "PF-PROP VEICULO") quando lido via GET — não funciona no schema Joi
    # do PATCH, que exige 'natural'/'legal'. Resolvemos derivando type da
    # presença real de cpf/cnpj (já normalizados acima).
    if len(cnpj_resolved) == 14:
        data["type"] = "legal"
        data["cnpj"] = cnpj_resolved
    elif len(cpf_resolved) == 11:
        data["type"] = "natural"
        data["cpf"] = cpf_resolved
    elif cur.get("type"):
        # Fallback final: tenta inferir do label legível antigo
        t_upper = str(cur["type"]).upper()
        if "JURIDIC" in t_upper or "EMPRESA" in t_upper or "PJ" in t_upper or t_upper == "LEGAL":
            data["type"] = "legal"
        elif "PESSOA" in t_upper or "PF" in t_upper or t_upper == "NATURAL":
            data["type"] = "natural"
        else:
            log_alerta(f"[owners.upload_documento] type não-mapeável: {cur['type']!r} — omitindo no PATCH")
        log_alerta(f"[owners.upload_documento] owner {owner_id} sem cpf/cnpj resolvível (nat={nat!r} leg={leg!r} known_cpf={known_cpf!r} known_cnpj={known_cnpj!r}) — backend provavelmente rejeitará 422 dataValues")
    if cur.get("relationship") is not None:
        data["relationship"] = str(cur["relationship"])
    else:
        # Default seguro pro PATCH multipart: relationship=1 (PROPRIA)
        data["relationship"] = "1"

    # Bundle endereco — owner usa FLAT
    city = cur.get("city") or {}
    state = (city.get("state") or {}) if isinstance(city, dict) else {}
    nb = cur.get("neighborhood") or {}
    place = cur.get("place") or {}
    if city.get("id"): data["cityId"] = str(city["id"])
    if state.get("id"): data["stateId"] = str(state["id"])
    if nb.get("id"): data["neighborhoodId"] = str(nb["id"])
    if nb.get("name"): data["neighborhoodName"] = str(nb["name"])
    if place.get("id"): data["placeId"] = str(place["id"])
    if cur.get("address"): data["address"] = str(cur["address"])
    if cur.get("number") is not None: data["number"] = str(cur["number"])
    if cur.get("cep"): data["cep"] = str(cur["cep"])
    elif place.get("cep"): data["cep"] = str(place["cep"])

    tup = _open_file(doc_path, field_name)
    files = {field_name: tup}
    log_info(f"[owners.upload_documento] PATCH /owners/{owner_id} files={field_name} preserve={sorted(data.keys())}")
    try:
        resp = sess.patch(
            _profile_url(client, f"/owners/{owner_id}"),
            data=data, files=files,
            timeout=client.default_timeout * 3,
        )
    finally:
        try: tup[1].close()
        except Exception: pass
    if resp.status_code >= 400:
        log_alerta(f"[owners.upload_documento] FALHA {resp.status_code} preserve={data} resp={resp.text[:500]}")
    resp.raise_for_status()
    return resp.json() if resp.text else {"id": owner_id}


def patch(client: AngellraAPIClient, owner_id: int, payload: dict[str, Any]) -> dict:
    """PATCH /profile/owners/{id} (JSON). cnpj/cpf/type sao readonly — filtrados."""
    body = {k: v for k, v in payload.items() if k not in CAMPOS_READONLY_PATCH}
    sess = client._ensure_session()
    log_info(f"[owners.patch] PATCH /owners/{owner_id} fields={sorted(body.keys())}")
    resp = sess.patch(
        _profile_url(client, f"/owners/{owner_id}"),
        json=body,
        headers={"Content-Type": "application/json"},
        timeout=client.default_timeout * 2,
    )
    resp.raise_for_status()
    return resp.json()
