"""Cliente API para veiculos (vehicles) na Angellira.

Endpoints (todos sob /profile):
    GET    /vehicles/plate/{plate}       -> findByPlate (placa com hifen!)
    GET    /vehicles/renavam/{renavam}   -> findByRenavam
    GET    /vehicles/chassis/{chassis}   -> findByChassis
    GET    /vehicles/{id}                -> findById
    GET    /vehicles/{id}/complete       -> validateVehicle
    GET    /types/vehicles               -> tipos (CAVALO=1, CARRETA, BITREM, ...)
    GET    /types/bodyworks              -> carrocerias
    GET    /types/brands?q={busca}       -> marcas (lookup)
    GET    /types/models/{brandId}?q={}  -> modelos da marca
    POST   /vehicles                     -> create (JSON, nao multipart)
    PATCH  /vehicles/{id}                -> update (JSON, sem `plate`)

DESCOBERTAS importantes:
- Placa antiga (AAA-9999) precisa de HIFEN. POST com "GBJ3629" falha "placa
  valida no mercosul pattern"; com "GBJ-3629" passa. Placa Mercosul (AAA0A99)
  passa sem hifen.
- POST e PATCH usam JSON (mesma observacao do drivers).
- PATCH NAO aceita `plate` (read-only). Tira da body antes.
- Campos obrigatorios no POST: prime, typeId, plate, color, renavam, chassis,
  axles, ownerId, brandId, modelId, fabricationYear, modelYear, plateStateId,
  plateCityId, relationship, antt (se anttControl=true no type).
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from ..helpers import normalizar_placa
from ..logger import log_alerta, log_info
from .client import AngellraAPIClient


def _norm_descricao(texto: str) -> str:
    """Remove acentos + upper + filtra so alfanum. 'Caminhão Trator' -> 'CAMINHAOTRATOR'."""
    if not texto:
        return ""
    decomposto = unicodedata.normalize("NFKD", str(texto))
    ascii_only = decomposto.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^A-Z0-9]", "", ascii_only.upper())


# Mapa estatico (descricao normalizada) -> typeId. Lookup na API e fallback.
# Esses sao os ids descobertos via GET /types/vehicles.
TIPO_TO_ID: dict[str, int] = {
    "CAVALO": 1,
    "CAMINHAOTRATOR": 1,
    "CAMINHAOTRATOR4X2": 1,
    "34": 14,                    # 3/4
    "BAUSECO30PL": 62,
    "BITREM": 85,
    "BITRUCK": 75,
    "BITRUCK2": 77,              # BI-TRUCK
    "TRATORESPLANPREP": 40,
    # CRLVs de carreta vem com "SEMI-REBOQUE", mas Angellira so tem
    # CARRETA 1/2/3 (por eixos). NAO mapeamos SEMIREBOQUE/REBOQUE aqui
    # de proposito: deixa cair no fallback `carreta_type_id_por_eixos`
    # em flow_veiculo, que escolhe 3/5/8 pelo numero de eixos.
    "CARRETA1": 3,
    "CARRETA2": 5,
    "CARRETA3": 8,
}


def carreta_type_id_por_eixos(eixos: int | None) -> int:
    """Map eixos -> typeId pra carreta (Angellira: 3=CARRETA 1, 5=CARRETA 2, 8=CARRETA 3).

    Mapeamento ajustado para classificação real BR:
    - 1-2 eixos → CARRETA 1 (semi-reboque leve)
    - 3 eixos   → CARRETA 2 (semi-reboque tri-eixo, mais comum no Brasil)
    - 4+ eixos  → CARRETA 3 (semi-reboque pesado/bitrem)
    """
    if eixos and eixos >= 4: return 8   # CARRETA 3 — 4+ eixos (bi-trem etc)
    if eixos and eixos == 3: return 5   # CARRETA 2 — tri-eixo (padrão BR)
    return 3  # default CARRETA 1 — até 2 eixos


def _profile_url(client: AngellraAPIClient, path: str) -> str:
    base = client.base_url.rstrip("/")
    return f"{base}{path if path.startswith('/') else '/' + path}"


def formatar_placa_api(placa: str) -> str:
    """Normaliza placa pro formato que a API aceita.

    - Placa Mercosul (AAA0A99): retorna como esta, sem hifen.
    - Placa antiga (AAA9999): insere hifen apos a 3a letra (AAA-9999).
    """
    if not placa:
        return ""
    p = normalizar_placa(placa)  # uppercase alphanum
    if re.fullmatch(r"[A-Z]{3}\d[A-Z]\d{2}", p):
        return p  # Mercosul, sem hifen
    if re.fullmatch(r"[A-Z]{3}\d{4}", p):
        return f"{p[:3]}-{p[3:]}"  # antigo, com hifen
    return p  # devolve normalizado mesmo se nao bater padrao


# ── Leitura ──────────────────────────────────────────────────────────────────


def find_by_plate(client: AngellraAPIClient, plate: str) -> dict | None:
    sess = client._ensure_session()
    placa_fmt = formatar_placa_api(plate)
    if not placa_fmt:
        return None
    resp = sess.get(_profile_url(client, f"/vehicles/plate/{placa_fmt}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_id(client: AngellraAPIClient, vehicle_id: int) -> dict | None:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/vehicles/{vehicle_id}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_renavam(client: AngellraAPIClient, renavam: str) -> dict | None:
    sess = client._ensure_session()
    digitos = "".join(c for c in str(renavam or "") if c.isdigit())
    if not digitos:
        return None
    resp = sess.get(_profile_url(client, f"/vehicles/renavam/{digitos}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def find_by_chassis(client: AngellraAPIClient, chassis: str) -> dict | None:
    sess = client._ensure_session()
    chassis_norm = (chassis or "").strip().upper()
    if not chassis_norm:
        return None
    resp = sess.get(_profile_url(client, f"/vehicles/chassis/{chassis_norm}"),
                    timeout=client.default_timeout)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def validate_complete(client: AngellraAPIClient, vehicle_id: int) -> dict:
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, f"/vehicles/{vehicle_id}/complete"),
                    timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


# ── Lookups (tipos, marcas, modelos) ─────────────────────────────────────────


_types_cache: list[dict] | None = None
_bodies_cache: list[dict] | None = None

# OTIMIZACAO 2026-05-27: cache em memoria de marcas/modelos
# Marcas e modelos do AngelLira sao quase imutaveis (catalogo nacional de
# fabricantes/modelos), entao podemos cachear com TTL longo (24h) e evitar
# 200-400ms por cadastro de veiculo em cada lookup. Cache key = query string
# upper-normalized (mesma busca da API).
import time as _time
import threading as _threading
_BRAND_CACHE_TTL = 86400.0   # 24h
_MODEL_CACHE_TTL = 86400.0   # 24h
_brand_cache: dict[str, tuple[list[dict], float]] = {}
_model_cache: dict[tuple[int, str], tuple[list[dict], float]] = {}
_brand_cache_lock = _threading.Lock()
_model_cache_lock = _threading.Lock()


def get_types(client: AngellraAPIClient) -> list[dict]:
    global _types_cache
    if _types_cache is not None:
        return _types_cache
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, "/types/vehicles"), timeout=client.default_timeout)
    resp.raise_for_status()
    _types_cache = resp.json()
    return _types_cache


def type_id_from_descricao(client: AngellraAPIClient, descricao: str) -> int | None:
    """'Caminhão Trator' -> 1 (CAVALO). Match com normalizacao NFKD + alphanum."""
    if not descricao:
        return None
    chave = _norm_descricao(descricao)
    if not chave:
        return None
    if chave in TIPO_TO_ID:
        return TIPO_TO_ID[chave]
    try:
        for t in get_types(client):
            if _norm_descricao(t.get("description") or "") == chave:
                return int(t["id"])
    except Exception as exc:
        log_alerta(f"[vehicles] falha consultando tipos: {exc}")
    return None


def get_bodies(client: AngellraAPIClient) -> list[dict]:
    global _bodies_cache
    if _bodies_cache is not None:
        return _bodies_cache
    sess = client._ensure_session()
    resp = sess.get(_profile_url(client, "/types/bodyworks"), timeout=client.default_timeout)
    resp.raise_for_status()
    _bodies_cache = resp.json()
    return _bodies_cache


# Aliases entre abreviacoes do CRLV (DENATRAN) e nomes canonicos da Angellira.
# Inclui formas separadas por espaco/ponto pra cobrir variacoes do OCR/CRLV.
ALIAS_MARCAS = {
    "M BENZ": "MERCEDES",
    "M.BENZ": "MERCEDES",
    "MBENZ": "MERCEDES",
    "MERCEDESBENZ": "MERCEDES",
    "VW": "VOLKSWAGEN",
    "V.W": "VOLKSWAGEN",
    "VW/": "VOLKSWAGEN",
    "GM": "CHEVROLET",
    "GM CHEVROLET": "CHEVROLET",
    "I/": "",  # prefixo "importado" — remove
}


def _query_marcas_api(client: AngellraAPIClient, q: str) -> list[dict]:
    """GET /types/brands?q=... — retorna lista de candidatos (ou vazia).
    Cacheado em memoria por 24h (catalogo de marcas raramente muda).
    """
    cache_key = (q or "").strip().upper()
    # Hit?
    with _brand_cache_lock:
        entry = _brand_cache.get(cache_key)
        if entry and (_time.time() - entry[1]) < _BRAND_CACHE_TTL:
            return entry[0]
    # Miss → consulta API
    sess = client._ensure_session()
    try:
        resp = sess.get(_profile_url(client, "/types/brands"),
                        params={"q": q}, timeout=client.default_timeout)
        if resp.status_code != 200:
            return []
        rj = resp.json()
        data = rj.get("data") if isinstance(rj, dict) else (rj or [])
        # Cacheia resultado (mesmo vazio — evita re-tentar lookup invalido)
        with _brand_cache_lock:
            _brand_cache[cache_key] = (data, _time.time())
        return data
    except Exception:
        return []


def find_brand(client: AngellraAPIClient, busca: str) -> dict | None:
    """GET /types/brands?q={busca} -> primeiro match (id, description).

    CRLV usa abreviacoes (M BENZ, VW) que nao casam direto com os nomes
    canonicos da Angellira (MERCEDES-BENZ, VOLKSWAGEN). Aplicamos alias
    antes da consulta e fallback pra variacoes.
    """
    if not busca:
        return None
    # Normaliza a busca: upper, sem prefixos DENATRAN:
    #   I/  = importado (ex: I/MERCEDES ou I / IVECO STRALIS 490S46T)
    #   SR/ = semi-reboque (ex: SR/RANDONSP)
    #   R/  = reboque
    # O formato do CRLV pode vir com ou sem espaços ao redor da barra:
    #   "I/IVECO" ou "I / IVECO STRALIS 490S46T" — ambos tratados via regex.
    busca_orig = busca.strip().upper()
    busca_orig = re.sub(r'^(?:I|SR|R)\s*/\s*', '', busca_orig).strip()

    # Aplica alias se houver
    busca_canonica = ALIAS_MARCAS.get(busca_orig, busca_orig)
    if not busca_canonica:
        return None

    # Tenta a busca canonica primeiro
    candidatos: list[str] = []
    if busca_canonica != busca_orig:
        candidatos.append(busca_canonica)
    candidatos.append(busca_orig)
    # Fuzzy char-removal: cobre sufixos como "RANDONSP" -> "RANDON" (UF colada no fim)
    s = busca_orig
    while len(s) > 4:
        s = s[:-1].strip()
        if s and s not in candidatos:
            candidatos.append(s)
    # Fallback: pega so a primeira palavra (ex: "M BENZ" -> "M", "VOLKSWAGEN" -> "VOLKSWAGEN")
    primeira_palavra = busca_orig.split()[0] if busca_orig.split() else busca_orig
    if primeira_palavra not in candidatos:
        candidatos.append(primeira_palavra)

    for q in candidatos:
        data = _query_marcas_api(client, q)
        if not data:
            continue
        busca_n = re.sub(r"[^A-Z0-9]", "", q.upper())
        # Match exato
        for item in data:
            desc_n = re.sub(r"[^A-Z0-9]", "", (item.get("description") or "").upper())
            if desc_n == busca_n:
                if q != busca:
                    log_info(f"[vehicles.find_brand] match {q!r} -> id={item.get('id')} desc={item.get('description')!r}")
                return item
        # Match parcial: busca_n esta contida em desc (ex: BENZ em MERCEDES-BENZ)
        for item in data:
            desc_n = re.sub(r"[^A-Z0-9]", "", (item.get("description") or "").upper())
            if busca_n in desc_n:
                log_info(f"[vehicles.find_brand] match parcial {q!r} em {item.get('description')!r}")
                return item

    log_alerta(f"[vehicles.find_brand] sem match pra {busca!r} (tentativas={candidatos}) — retornando None")
    return None


def _query_modelos_api(client: AngellraAPIClient, brand_id: int, q: str) -> list[dict]:
    """GET /types/models/{brand_id}?q=... — cacheado em memoria por 24h.
    Modelos de uma marca raramente mudam (catalogo nacional).
    """
    cache_key = (int(brand_id), (q or "").strip().upper())
    with _model_cache_lock:
        entry = _model_cache.get(cache_key)
        if entry and (_time.time() - entry[1]) < _MODEL_CACHE_TTL:
            return entry[0]
    sess = client._ensure_session()
    try:
        resp = sess.get(_profile_url(client, f"/types/models/{brand_id}"),
                        params={"q": q}, timeout=client.default_timeout)
        if resp.status_code != 200:
            return []
        rj = resp.json()
        data = rj.get("data") if isinstance(rj, dict) else (rj or [])
        with _model_cache_lock:
            _model_cache[cache_key] = (data, _time.time())
        return data
    except Exception:
        return []


def find_model(client: AngellraAPIClient, brand_id: int, busca: str) -> dict | None:
    """GET /types/models/{brand_id}?q={busca} -> primeiro match.

    Modelos no CRLV vem com sufixos que o Angellira nao reconhece (AXOR 2545S
    quando o canonico e AXOR 2545). Aplicamos fallback fuzzy: tenta a busca
    original, depois vai removendo o ultimo caractere/token ate min 4 chars.
    """
    if not brand_id or not busca:
        return None
    busca_orig = busca.strip().upper()

    # Gera candidatos progressivamente menos especificos.
    # Ordem importa: queremos casar com o modelo MAIS especifico primeiro.
    # 1. Busca original (AXOR 2545S)
    # 2. Removendo ultimo char um por vez (AXOR 2545 — cobre sufixos como "S")
    # 3. Removendo tokens (AXOR — ultima opcao, generico)
    candidatos = [busca_orig]
    # Char-removal primeiro pra preservar especificidade
    s = busca_orig
    while len(s) > 4:
        s = s[:-1].strip()
        if s and s not in candidatos:
            candidatos.append(s)
    # Token-removal por ultimo (perde especificidade rapido)
    tokens = busca_orig.split()
    while len(tokens) > 1:
        tokens = tokens[:-1]
        token_join = " ".join(tokens)
        if token_join not in candidatos:
            candidatos.append(token_join)

    for q in candidatos:
        data = _query_modelos_api(client, brand_id, q)
        if not data:
            continue
        busca_n = re.sub(r"[^A-Z0-9]", "", q.upper())
        # Match exato primeiro
        for item in data:
            desc_n = re.sub(r"[^A-Z0-9]", "", (item.get("description") or "").upper())
            if desc_n == busca_n:
                if q != busca_orig:
                    log_info(f"[vehicles.find_model] fuzzy {busca!r} -> {q!r} -> id={item.get('id')} desc={item.get('description')!r}")
                return item
        # Match por prefixo ou contem
        for item in data:
            desc_n = re.sub(r"[^A-Z0-9]", "", (item.get("description") or "").upper())
            if desc_n.startswith(busca_n) or busca_n in desc_n:
                if q != busca_orig:
                    log_info(f"[vehicles.find_model] fuzzy parcial {busca!r} -> {q!r} -> {item.get('description')!r}")
                return item

    log_alerta(f"[vehicles.find_model] sem match pra {busca!r} brand={brand_id} (tentativas={candidatos[:5]}) — retornando None")
    return None


# ── Escrita ──────────────────────────────────────────────────────────────────


# Campos que o backend Angellira NAO aceita alterar via PATCH (identidade dura
# do veiculo). `renavam` foi REMOVIDO desta lista em 2026-05-27: veiculos legados
# (criados antes da integracao API) frequentemente tem renavam vazio no portal
# Angellira e, no preflight, isso retorna `incompleteEntities: {cabId: ['renavam']}`
# bloqueando a consulta. Como o renavam vem do CRLV (fonte de verdade) e o
# backend Angellira aceita PATCH com renavam, liberamos pra preencher legados.
# Mesmo padrao do fix B8 (number/complement em drivers).
CAMPOS_READONLY_PATCH = {"plate", "chassis"}


def create(client: AngellraAPIClient, payload: dict[str, Any]) -> dict:
    """POST /profile/vehicles (JSON)."""
    sess = client._ensure_session()
    log_info(f"[vehicles.create] POST /vehicles fields={sorted(payload.keys())} body={payload}")
    resp = sess.post(
        _profile_url(client, "/vehicles"),
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=client.default_timeout * 2,
    )
    if resp.status_code >= 400:
        log_alerta(f"[vehicles.create] FALHA {resp.status_code} body_sent={payload} resp={resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()


def patch(client: AngellraAPIClient, vehicle_id: int, payload: dict[str, Any]) -> dict:
    """PATCH /profile/vehicles/{id} (JSON, sem campos read-only).

    Filtra apenas {plate, chassis} (identidade). `renavam` PASSA — ver nota
    em CAMPOS_READONLY_PATCH. Log destaca quando renavam esta no PATCH
    (cenario "preenchimento de veiculo legado").
    """
    body = {k: v for k, v in payload.items() if k not in CAMPOS_READONLY_PATCH}
    sess = client._ensure_session()
    if body.get("renavam"):
        log_info(
            f"[vehicles.patch] PATCH /vehicles/{vehicle_id} renavam={body['renavam']} "
            f"(preenchendo legado — ver CAMPOS_READONLY_PATCH em vehicles.py)"
        )
    log_info(f"[vehicles.patch] PATCH /vehicles/{vehicle_id} fields={sorted(body.keys())} body={body}")
    resp = sess.patch(
        _profile_url(client, f"/vehicles/{vehicle_id}"),
        json=body,
        headers={"Content-Type": "application/json"},
        timeout=client.default_timeout * 2,
    )
    if resp.status_code >= 400:
        log_alerta(f"[vehicles.patch] FALHA {resp.status_code} body_sent={body} resp={resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()


def _open_file(path: str, field_name: str):
    import os, mimetypes
    if not os.path.isfile(path):
        raise FileNotFoundError(f"[vehicles.{field_name}] arquivo nao existe: {path}")
    mime, _ = mimetypes.guess_type(path)
    return (os.path.basename(path), open(path, "rb"), mime or "application/octet-stream")


def upload_crlv(client: AngellraAPIClient, vehicle_id: int, crlv_path: str) -> dict:
    """Upload do CRLV via PATCH /vehicles/{id} multipart com `crlvFile`.

    O Joi do PATCH multipart EXIGE `relationship`, `typeId`, `ownerId`, e
    `antt` (se anttControl=true no type). Pegamos do estado atual do veiculo
    e reenviamos pra evitar erros 422/500.
    """
    sess = client._ensure_session()

    # Le o estado atual pra reenviar campos obrigatorios
    veic = find_by_id(client, vehicle_id) or {}
    type_id = veic.get("type", {}).get("id")
    relationship = veic.get("relationship")
    owner_id = (veic.get("owner") or {}).get("id") if veic.get("owner") else None
    antt = veic.get("antt") or ""

    tup = _open_file(crlv_path, "crlv")
    files = {"crlvFile": tup}
    data = {"hasCrlvFile": "true"}
    if type_id is not None: data["typeId"] = str(type_id)
    if relationship is not None: data["relationship"] = str(relationship)
    if owner_id is not None: data["ownerId"] = str(owner_id)
    if antt: data["antt"] = str(antt)
    log_info(f"[vehicles.upload_crlv] PATCH /vehicles/{vehicle_id} files=crlvFile preserve={list(data.keys())}")
    try:
        resp = sess.patch(
            _profile_url(client, f"/vehicles/{vehicle_id}"),
            data=data, files=files,
            timeout=client.default_timeout * 3,
        )
    finally:
        try: tup[1].close()
        except Exception: pass
    resp.raise_for_status()
    return resp.json() if resp.text else {"id": vehicle_id}


def upload_consent_form(client: AngellraAPIClient, vehicle_id: int, consent_path: str) -> dict:
    """Upload do termo de consentimento (consentFormFile)."""
    sess = client._ensure_session()
    tup = _open_file(consent_path, "consent")
    files = {"consentFormFile": tup}
    log_info(f"[vehicles.upload_consent] PATCH /vehicles/{vehicle_id} files=consentFormFile")
    try:
        resp = sess.patch(
            _profile_url(client, f"/vehicles/{vehicle_id}"),
            files=files,
            timeout=client.default_timeout * 3,
        )
    finally:
        try: tup[1].close()
        except Exception: pass
    resp.raise_for_status()
    return resp.json() if resp.text else {"id": vehicle_id}
