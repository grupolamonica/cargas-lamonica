"""Lookups: vehicle_types, stations, cities, attributes.

Todos cached in-memory (5 min TTL) — sao listas que mudam pouco.
"""

from __future__ import annotations

import time
import unicodedata
from typing import Any

from .client import SPXClient
from .logger import log_info


_CACHE: dict[str, tuple[float, Any]] = {}
_TTL_SECONDS = 300


def _norm(s: Any) -> str:
    """Normaliza p/ comparacao de nomes: sem acento, MAIUSCULO, espacos colapsados.

    Resolve o caso 'Simoes Filho' (como o SPX guarda) x 'Simões Filho' com acento
    (como vem da cidade/cadastro) — antes o match exato falhava e a estacao caia
    pra id=0, gerando o erro confuso 'Station not exist' no validate.
    """
    txt = unicodedata.normalize("NFKD", str(s or ""))
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    return " ".join(txt.upper().split())


def _cached(key: str, fetcher):
    now = time.time()
    cached = _CACHE.get(key)
    if cached and (now - cached[0]) < _TTL_SECONDS:
        return cached[1]
    val = fetcher()
    _CACHE[key] = (now, val)
    return val


def fetch_vehicle_types(client: SPXClient, *, display_status: int = 1) -> list[dict]:
    """GET /api/fleet_management/agency/type/search → 17 tipos de veiculo (BR).

    Cada item: {id, vehicle_type_id, vehicle_type_name, weight_capacity, volume_capacity,
                length, width, height, vehicle_group, require_plate_info, display_status, ...}
    """
    def _do():
        data = client.get_json(
            "/api/fleet_management/agency/type/search",
            params={"count": 9999999, "pageno": 1, "display_status": display_status},
        )
        return data.get("list", []) if isinstance(data, dict) else []
    return _cached(f"vehicle_types:{display_status}", _do)


def find_vehicle_type_by_name(client: SPXClient, name: str) -> dict | None:
    """Match case/acento-insensitive exato → contem → None."""
    name_n = _norm(name)
    if not name_n:
        return None
    types = fetch_vehicle_types(client)
    # Match exato
    for t in types:
        if _norm(t.get("vehicle_type_name", "")) == name_n:
            return t
    # Match parcial
    for t in types:
        if name_n in _norm(t.get("vehicle_type_name", "")):
            return t
    return None


def fetch_stations(client: SPXClient) -> dict[str, list[dict]]:
    """POST /api/driverservice/agency/br/function_station_list (body {}) → estacoes da agencia.

    Retorna {agency_id, function_type_list, pickup_station_list, delivery_station_list,
             return_station_list, linehaul_station_list}.
    Cada station: {station_id, station_name, is_xpt_site}
    """
    def _do():
        data = client.post_json("/api/driverservice/agency/br/function_station_list", body={})
        return {
            "agency_id": (data or {}).get("agency_id"),
            "function_type_list": (data or {}).get("function_type_list") or [],
            "pickup": (data or {}).get("pickup_station_list") or [],
            "delivery": (data or {}).get("delivery_station_list") or [],
            "return": (data or {}).get("return_station_list") or [],
            "linehaul": (data or {}).get("linehaul_station_list") or [],
        }
    return _cached("function_stations", _do)


def find_station_by_name(client: SPXClient, name: str, *, function_type: str = "linehaul") -> dict | None:
    """Procura station_id pelo nome. function_type: pickup/delivery/return/linehaul."""
    stations = fetch_stations(client).get(function_type, []) or []
    name_n = _norm(name)
    if not name_n:
        return None
    for s in stations:
        if _norm(s.get("station_name", "")) == name_n:
            return s
    for s in stations:
        if name_n in _norm(s.get("station_name", "")):
            return s
    return None


def fetch_cities(client: SPXClient, *, city_name: str | None = None, limit: int = 100) -> list[dict]:
    """GET /api/networkroute/agency/address_management/search_cities.

    Se city_name for passado, faz busca. Senao retorna primeiras N.
    """
    params: dict[str, Any] = {"count": limit, "pageno": 1}
    if city_name:
        params["city_name"] = city_name
    key = f"cities:{city_name or '__all__'}:{limit}"

    def _do():
        data = client.get_json("/api/networkroute/agency/address_management/search_cities", params=params)
        return (data or {}).get("city_list", [])
    return _cached(key, _do)


def _state_name_valido(c: dict) -> bool:
    """True se a entrada de cidade tem state_name 'real' (por extenso).

    O catalogo de cidades do SPX tem ~77 entradas legadas (de ~5668) cujo
    state_name e' sigla de 2 letras ('SP'), vazio, ou numerico ('42') — e o id
    delas o SPX REJEITA no cadastro com '271624001: Invalid city id'. As validas
    tem o estado por extenso ('São Paulo', 'Bahia'). Ex. real: 'Caieiras' aparece
    como 196260/'SP' (invalida) e 201637/'São Paulo' (valida); antes pegavamos a
    primeira (lixo) e o validate/detail estourava (mascarado como 'Station not exist').
    """
    sn = str(c.get("state_name") or "").strip()
    return len(sn) > 2 and not sn.isdigit()


def find_city_id(client: SPXClient, city_name: str, *, state_uf: str | None = None) -> int | None:
    """Resolve city_id pelo nome, preferindo a entrada com estado por extenso."""
    if not city_name:
        return None
    cities = fetch_cities(client, city_name=city_name)
    name_n = _norm(city_name)
    exatos = [c for c in cities if _norm(c.get("city_name", "")) == name_n]
    if not exatos:
        # match parcial (ja normalizado sem acento via _norm)
        exatos = [c for c in cities if name_n in _norm(c.get("city_name", ""))]
    if not exatos:
        return None
    # Preferir entradas com state_name por extenso (descarta as ~77 legadas com
    # sigla/vazio/numerico, cujo id o SPX trata como 'Invalid city id').
    validos = [c for c in exatos if _state_name_valido(c)]
    if state_uf:
        # Desambigua por UF quando informado (compara contra o state_name por extenso).
        uf_n = _norm(state_uf)
        por_uf = [c for c in (validos or exatos) if _norm(c.get("state_name", "")) == uf_n]
        if por_uf:
            return por_uf[0].get("id")
    candidates = validos or exatos
    return candidates[0].get("id")


def fetch_driver_attributes(client: SPXClient) -> list[dict]:
    """GET /api/driverservice/agency/driver/attribute/list."""
    def _do():
        data = client.get_json("/api/driverservice/agency/driver/attribute/list",
                               params={"count": 1000, "pageno": 1})
        return (data or {}).get("list", [])
    return _cached("driver_attributes", _do)


def fetch_apollo_driver_info(client: SPXClient) -> dict:
    """GET /api/driverservice/agency/br/driver/get_driver_apollo_info — config Apollo."""
    return client.get_json("/api/driverservice/agency/br/driver/get_driver_apollo_info") or {}


def clear_cache() -> None:
    """Limpa cache de lookups (use em desenvolvimento)."""
    _CACHE.clear()
    log_info("[lookups] cache limpo")
