"""Lookups: vehicle_types, stations, cities, attributes.

Todos cached in-memory (5 min TTL) — sao listas que mudam pouco.
"""

from __future__ import annotations

import time
from typing import Any

from .client import SPXClient
from .logger import log_info


_CACHE: dict[str, tuple[float, Any]] = {}
_TTL_SECONDS = 300


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
    """Match case-insensitive exato → contem → None."""
    name_n = (name or "").upper().strip()
    if not name_n:
        return None
    types = fetch_vehicle_types(client)
    # Match exato
    for t in types:
        if str(t.get("vehicle_type_name", "")).upper().strip() == name_n:
            return t
    # Match parcial
    for t in types:
        if name_n in str(t.get("vehicle_type_name", "")).upper():
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
    name_n = (name or "").upper().strip()
    if not name_n:
        return None
    for s in stations:
        if str(s.get("station_name", "")).upper().strip() == name_n:
            return s
    for s in stations:
        if name_n in str(s.get("station_name", "")).upper():
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


def find_city_id(client: SPXClient, city_name: str, *, state_uf: str | None = None) -> int | None:
    """Resolve city_id pelo nome (+ opcional UF pra desambiguar)."""
    if not city_name:
        return None
    cities = fetch_cities(client, city_name=city_name)
    name_n = city_name.strip().upper()
    candidates = [c for c in cities if str(c.get("city_name", "")).upper().strip() == name_n]
    if not candidates:
        # tenta normalizar (sem acento) — TODO se necessario
        candidates = [c for c in cities if name_n in str(c.get("city_name", "")).upper()]
    if not candidates:
        return None
    if state_uf:
        # ainda nao temos o state_uf nos dados; deixar como TODO se a base retornar
        pass
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
