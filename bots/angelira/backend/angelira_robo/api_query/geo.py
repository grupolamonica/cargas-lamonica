"""Helpers geograficos da API Angellira: estados, cidades, CEP.

Endpoints (todos sob api.angellira.com.br/profile):
    GET /geo/countries/{countryId}/states  -> lista estados
    GET /geo/states/{stateId}/cities       -> lista cidades de um estado
    GET /geo/address?cep={cep}             -> resolve CEP em place/city/state/neighborhood

Brasil tem countryId=1. Mantemos um mapa estatico UF -> stateId pra evitar
1 round-trip por cadastro; a funcao `state_id_from_uf` consulta a API se
encontrar UF desconhecido (defensivo).

THREAD-SAFETY (2026-05-26): caches abaixo sao protegidos por Lock pra suportar
batch paralelo de motoristas (cadastrar_motoristas_em_lote).
"""

from __future__ import annotations

import threading
from typing import Any

from ..logger import log_alerta
from .client import AngellraAPIClient


_cache_lock = threading.Lock()


# UF -> stateId (mapa descoberto via GET /geo/countries/1/states).
# Manter atualizado se a Angellira adicionar novas siglas.
UF_TO_STATE_ID: dict[str, int] = {
    "AC": 1,  "AL": 2,  "AM": 3,  "AP": 4,  "BA": 5,
    "CE": 6,  "DF": 7,  "ES": 8,  "GO": 9,  "MA": 10,
    "MG": 11, "MS": 12, "MT": 13, "PA": 14, "PB": 15,
    "PE": 16, "PI": 17, "PR": 18, "RJ": 19, "RN": 20,
    "RO": 21, "RR": 22, "RS": 23, "SC": 24, "SE": 25,
    "SP": 26, "TO": 27,
    "XX": 34, "EX": 64, "NI": 67,
}


# CEP-ancora por UF — centro/zona conhecida da capital. Usado quando o cadastro
# nao tem CEP no payload, mas precisamos de um place.id real pra Angellira
# aceitar o endereco no driver/owner. Sao CEPs validos que retornam
# place.id+neighborhood.id+city.id reais no /geo/address.
CEP_ANCORA_POR_UF: dict[str, str] = {
    "AC": "69900000", "AL": "57000000", "AM": "69000000", "AP": "68900000",
    "BA": "40010000", "CE": "60020000", "DF": "70040000", "ES": "29010000",
    "GO": "74000000", "MA": "65000000", "MG": "30110000", "MS": "79000000",
    "MT": "78000000", "PA": "66000000", "PB": "58000000", "PE": "50010000",
    "PI": "64000000", "PR": "80010000", "RJ": "20010000", "RN": "59000000",
    "RO": "76800000", "RR": "69300000", "RS": "90010000", "SC": "88010000",
    "SE": "49000000", "SP": "01010000", "TO": "77000000",
}

_state_cache: list[dict] | None = None


def list_states(client: AngellraAPIClient, country_id: int = 1) -> list[dict]:
    """[{id, name, abbrev}, ...]. Cacheia em memoria. Thread-safe."""
    global _state_cache
    # Fast-path sem lock (leitura de referencia eh atomica via GIL)
    if _state_cache is not None:
        return _state_cache
    sess = client._ensure_session()
    url = f"{client.base_url}/geo/countries/{country_id}/states"
    resp = sess.get(url, timeout=client.default_timeout)
    resp.raise_for_status()
    payload = resp.json()
    with _cache_lock:
        if _state_cache is None:
            _state_cache = payload
    return _state_cache


def state_id_from_uf(client: AngellraAPIClient, uf: str) -> int | None:
    """SP -> 26. Usa mapa estatico; consulta API se UF desconhecido."""
    if not uf:
        return None
    uf_norm = uf.strip().upper()
    if uf_norm in UF_TO_STATE_ID:
        return UF_TO_STATE_ID[uf_norm]
    try:
        for s in list_states(client):
            if (s.get("abbrev") or "").upper() == uf_norm:
                return int(s["id"])
    except Exception as exc:
        log_alerta(f"[geo] falha consultando estados: {exc}")
    return None


def list_cities(client: AngellraAPIClient, state_id: int) -> list[dict]:
    """[{id, name}, ...] de um estado."""
    sess = client._ensure_session()
    url = f"{client.base_url}/geo/states/{state_id}/cities"
    resp = sess.get(url, timeout=client.default_timeout)
    resp.raise_for_status()
    return resp.json()


_city_cache: dict[tuple[int, str], int] = {}


def find_city_by_name(client: AngellraAPIClient, state_id: int, city_name: str) -> int | None:
    """Procura cityId pelo nome num estado. Cache em memoria por (stateId, nome).

    Tenta match exato primeiro; se nao acha, tenta fuzzy match com difflib pra
    tolerar typos do OCR (ex: 'LJMOEIRO DO NORTE' -> 'LIMOEIRO DO NORTE').
    """
    if not state_id or not city_name:
        return None
    import unicodedata, re as _re, difflib
    def _norm(s: str) -> str:
        s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode("ascii")
        return _re.sub(r"[^A-Z0-9]", "", s.upper())
    chave_norm = _norm(city_name)
    cache_key = (state_id, chave_norm)
    cached = _city_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        cidades = list_cities(client, state_id)
    except Exception as exc:
        log_alerta(f"[geo] falha listando cidades de {state_id}: {exc}")
        return None
    # 1. Match exato (normalizado)
    for c in cidades:
        if _norm(c.get("name") or "") == chave_norm:
            cid = int(c["id"])
            with _cache_lock:
                _city_cache[cache_key] = cid
            return cid
    # 2. Fuzzy match (cutoff 0.85 = ~85% similaridade — tolera OCR errors leves)
    nomes_norm = [_norm(c.get("name") or "") for c in cidades]
    matches = difflib.get_close_matches(chave_norm, nomes_norm, n=1, cutoff=0.85)
    if matches:
        idx = nomes_norm.index(matches[0])
        c = cidades[idx]
        cid = int(c["id"])
        log_alerta(f"[geo] fuzzy match: {city_name!r} -> {c.get('name')!r} (cityId={cid})")
        with _cache_lock:
            _city_cache[cache_key] = cid
        return cid
    return None


# ─── Cache de CEP (PERFORMANCE 2026-05-26) ───────────────────────────────────
# Lote de N motoristas costuma ter CEPs repetidos (mesma frota, mesma cidade).
# Cacheamos em memoria pra economizar 200-800ms por CEP repetido. Cache eh
# module-level (vida = processo). Tamanho limitado pra nao crescer indefinidamente
# em workers de longa duracao.
_cep_cache: dict[str, dict | None] = {}
_CEP_CACHE_MAX = 5000


def _cep_cache_put(cep_limpo: str, valor: dict | None) -> None:
    # Thread-safe: _cache_lock evita perda de entradas no FIFO quando dois
    # threads escrevem simultaneamente com cache cheio.
    with _cache_lock:
        if len(_cep_cache) >= _CEP_CACHE_MAX:
            try:
                primeiro = next(iter(_cep_cache))
                _cep_cache.pop(primeiro, None)
            except StopIteration:
                pass
        _cep_cache[cep_limpo] = valor


def query_cep(client: AngellraAPIClient, cep: str) -> dict | None:
    """GET /geo/address?cep={cep} -> {place, city, state, neighborhood} ou None se CEP invalido.

    Estrategia de resolucao (cascata):
    1. Angellira /geo/address com o CEP exato
    2. Angellira /geo/address com prefixos do CEP (000 / 0000 / 00000)
       — pega placeId/neighborhoodId reais de um CEP "vizinho" no mesmo bloco
    3. ViaCEP -> relookup local (so retorna city/state, sem place.id real)

    A ordem 2-antes-de-3 e proposital: o backend Angellira exige place.id real
    pra cadastros completos; um CEP de prefixo da o ID real, ViaCEP nao.

    Resultados cacheados em memoria (vida = processo) pra evitar round-trips
    repetidos em lotes de motoristas do mesmo endereco/regiao.
    """
    cep_limpo = "".join(c for c in str(cep or "") if c.isdigit())
    if len(cep_limpo) < 8:
        return None
    if cep_limpo in _cep_cache:
        return _cep_cache[cep_limpo]
    sess = client._ensure_session()
    url = f"{client.base_url}/geo/address"
    # 1. CEP exato
    resp = sess.get(url, params={"cep": cep_limpo}, timeout=client.default_timeout)
    if resp.status_code == 200:
        result = resp.json()
        _cep_cache_put(cep_limpo, result)
        return result
    log_alerta(f"[geo] CEP {cep_limpo}: HTTP {resp.status_code} — tentando prefixos")
    # 2. CEPs de prefixo (000 -> 0000 -> 00000)
    for variante in (cep_limpo[:5] + "000", cep_limpo[:4] + "0000", cep_limpo[:3] + "00000"):
        if variante == cep_limpo:
            continue
        rv = sess.get(url, params={"cep": variante}, timeout=client.default_timeout)
        if rv.status_code == 200:
            log_alerta(f"[geo] CEP {cep_limpo} resolvido via prefixo {variante}")
            result = rv.json()
            _cep_cache_put(cep_limpo, result)
            return result
    # 3. ViaCEP
    log_alerta(f"[geo] CEP {cep_limpo}: prefixos tambem falharam — tentando ViaCEP")
    result = _query_cep_fallback_viacep(client, cep_limpo)
    _cep_cache_put(cep_limpo, result)
    return result


def _query_cep_fallback_viacep(client: AngellraAPIClient, cep_limpo: str) -> dict | None:
    """Fallback: ViaCEP -> remonta {city, state, neighborhood, place} via lookups Angellira."""
    import requests
    try:
        r = requests.get(f"https://viacep.com.br/ws/{cep_limpo}/json/", timeout=8)
        if r.status_code != 200:
            log_alerta(f"[geo.viacep] HTTP {r.status_code} pra CEP {cep_limpo}")
            return None
        v = r.json() or {}
        if v.get("erro"):
            log_alerta(f"[geo.viacep] CEP {cep_limpo} nao existe (erro=true)")
            return None
    except Exception as exc:
        log_alerta(f"[geo.viacep] falha CEP {cep_limpo}: {exc}")
        return None
    uf = (v.get("uf") or "").upper().strip()
    cidade_nome = v.get("localidade") or ""
    bairro_nome = v.get("bairro") or ""
    logradouro = v.get("logradouro") or ""
    state_id = state_id_from_uf(client, uf)
    if not state_id:
        log_alerta(f"[geo.viacep] UF '{uf}' nao mapeada (CEP {cep_limpo})")
        return None
    city_id = find_city_by_name(client, state_id, cidade_nome)
    if not city_id:
        log_alerta(f"[geo.viacep] cidade '{cidade_nome}/{uf}' nao encontrada na Angellira (CEP {cep_limpo})")
        return None
    log_alerta(f"[geo.viacep] OK CEP {cep_limpo} -> {cidade_nome}/{uf} (stateId={state_id} cityId={city_id})")
    return {
        "state": {"id": state_id, "name": "", "abbrev": uf},
        "city": {"id": city_id, "name": cidade_nome},
        "neighborhood": {"name": bairro_nome} if bairro_nome else {},
        "place": {"address": logradouro, "cep": cep_limpo} if logradouro else {},
    }
