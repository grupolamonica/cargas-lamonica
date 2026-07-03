"""Leitura de viagens linehaul (line_haul trips) da API SPX.

Espelha o padrao de drivers.py/lookups.py: funcoes que recebem um SPXClient e
chamam client.get_json(). Descoberto 2026-06-11 (ver memoria spx-linehaul-trips-endpoint):

  GET /api/line_haul/agency/trip/list
    ?pageno=&count=200&query_type=&sta=<ini>,<fim>&agency_current_station_id=<id>

  - query_type: 1=Planejado, 2=Aceito, 3=Concluido.
  - agency_current_station_id e OBRIGATORIO. Conta sem station ve 0 viagens.
  - A tab Aceito (query_type=2) IGNORA a janela de data (sta), entao pega as
    viagens em execucao (Departed/Arrived/...) sem depender do periodo.
"""
from __future__ import annotations

import os
import time
from typing import Any

from .client import SPXClient

_TRIPS_PATH = "/api/line_haul/agency/trip/list"
_DETAIL_PATH = "/api/line_haul/agency/trip/detail"
_ACCEPT_PATH = "/api/line_haul/agency/trip/accept"
# Endpoint REAL de atribuição (capturado/verificado ao vivo 2026-06-22 — alocou Welves
# na LT0Q6O0291RR1). NÃO é o /trip/accept/assign_multiple_driver (esse dava 131801069).
_ASSIGN_PATH = "/api/line_haul/agency/trip/assign"

# enum tt_trip_status (conf do portal)
TRIP_STATUS = {
    0: "Created", 4: "Assigning", 5: "Assigned", 10: "Loading", 30: "Seal",
    40: "Departed", 50: "Arrived", 60: "Unseal", 70: "Operating", 80: "Unloaded",
    90: "Completed", 100: "Cancelled", 200: "Pending",
}


def _station_id(explicit: int | None = None) -> int:
    """agency_current_station_id OBRIGATORIO. Default via env SPX_LINEHAUL_STATION_ID."""
    return int(explicit or os.getenv("SPX_LINEHAUL_STATION_ID") or 0)


def list_trips(
    client: SPXClient,
    *,
    page: int = 1,
    count: int = 200,
    query_type: int = 2,
    sta: tuple[int, int] | None = None,
    agency_current_station_id: int | None = None,
) -> dict:
    """Uma pagina do trip/list. Levanta ValueError se faltar station_id."""
    sid = _station_id(agency_current_station_id)
    if not sid:
        raise ValueError(
            "agency_current_station_id obrigatorio — defina SPX_LINEHAUL_STATION_ID "
            "ou passe station_id (sem ele a SPX retorna 0 viagens)."
        )
    params: dict[str, Any] = {
        "pageno": page,
        "count": count,
        "query_type": query_type,
        "agency_current_station_id": sid,
    }
    # sta e UM param com virgula (epoch,epoch); montar a string manualmente
    if sta:
        params["sta"] = f"{int(sta[0])},{int(sta[1])}"
    return client.get_json(_TRIPS_PATH, params=params) or {}


def _norm_trip(t: dict) -> dict:
    """Projeta a viagem crua da SPX nos campos que o poller da Torre consome."""
    stations = t.get("trip_station") or []
    origem = stations[0] if stations else {}
    destino = stations[-1] if stations else {}
    plates = t.get("vehicle_plate_number_list") or []
    return {
        "trip_id": t.get("id") or t.get("trip_id"),
        "trip_number": t.get("trip_number"),
        "trip_name": t.get("trip_name"),
        "origem": origem.get("station_name"),
        "destino": destino.get("station_name"),
        "std": origem.get("std") or origem.get("sta"),
        "driver_name": t.get("driver_name") or "",
        "vehicle_type": t.get("vehicle_type_name") or "",
        "cavalo": plates[0] if len(plates) > 0 else "",
        "carreta": plates[1] if len(plates) > 1 else "",
        "acceptance_status": t.get("acceptance_status"),
        "trip_status": t.get("trip_status"),
        "trip_status_name": TRIP_STATUS.get(t.get("trip_status"), str(t.get("trip_status"))),
    }


def snapshot(
    client: SPXClient,
    *,
    query_type: int = 2,
    agency_current_station_id: int | None = None,
    max_pages: int = 20,
    com_veiculo: bool = True,
    sta: tuple[int, int] | None = None,
) -> dict:
    """Pagina o trip/list ate esgotar e devolve a lista projetada + meta.

    com_veiculo=True filtra so as viagens que ja tem veiculo atribuido (placa)
    — sao as unicas com algo pra validar na Angellira.

    sta=(ini,fim) (epoch) aplica a janela de data; necessario p/ as abas
    Planejado(1)/Concluido(3) (a aba Aceito(2) ignora a janela). `truncated`
    no retorno indica que o cap de paginacao (max_pages) foi atingido — ou seja,
    a lista pode estar incompleta.
    """
    out: list[dict] = []
    page = 1
    truncated = False
    while page <= max_pages:
        data = list_trips(
            client, page=page, count=200, query_type=query_type,
            agency_current_station_id=agency_current_station_id, sta=sta,
        )
        lst = (data or {}).get("list") or (data or {}).get("items") or []
        out.extend(lst)
        if len(lst) < 200:
            break
        page += 1
        if page > max_pages:
            truncated = True

    trips = [_norm_trip(t) for t in out]
    if com_veiculo:
        trips = [t for t in trips if t["cavalo"] or t["carreta"]]
    return {"fetched_at": int(time.time()), "total": len(trips), "truncated": truncated, "trips": trips}


# ── Alocacao: detalhe / aceitar / atribuir motorista ──────────────────────
# Fluxo verificado ao vivo 2026-06-22 (Jira DC-138):
#   "Aceitar" -> POST trip/accept  (mutacao; ja reserva a carga)
#   handover  -> GET trip/detail + GET driver/dropdown/list (drivers.list_assignable_drivers)
#   "Atribuir"-> POST trip/assign  (mutacao; passo final — motorista + placas no mesmo body)

def get_trip_detail(
    client: SPXClient, trip_id: int, *, agency_current_station_id: int | None = None
) -> dict:
    """GET /api/line_haul/agency/trip/detail — ficha da viagem (read-only).

    Traz trip_status, agency_id/agency_name, bid_status, motorista(s) atribuido(s), etc.
    """
    params: dict[str, Any] = {"trip_id": int(trip_id)}
    sid = _station_id(agency_current_station_id)
    if sid:
        params["agency_current_station_id"] = sid
    return client.get_json(_DETAIL_PATH, params=params) or {}


def accept_trip(
    client: SPXClient,
    trip_id: int,
    *,
    agency_current_station_id: int | None = None,
    dry_run: bool = True,
) -> dict:
    """POST /api/line_haul/agency/trip/accept — aceita/reserva a viagem para a agencia.

    MUTACAO: compromete a carga com a agencia (e o que o botao "Aceitar" dispara). So
    e' necessario para viagens ainda nao aceitas; viagens ja na aba "Aceito" pulam isso.

    dry_run=True (default, SEGURO) apenas monta o body e NAO envia.
    """
    body = {"trip_id": int(trip_id)}
    sid = _station_id(agency_current_station_id)
    if sid:
        body["agency_current_station_id"] = sid
    if dry_run:
        return {"dry_run": True, "method": "POST", "path": _ACCEPT_PATH, "body": body}
    return client.post_json(_ACCEPT_PATH, body=body) or {}


def assign_drivers(
    client: SPXClient,
    *,
    trip_id: int,
    driver_ids: list[int],
    vehicle_plates: list[str] | None = None,
    agency_current_station_id: int | None = None,
    dry_run: bool = True,
) -> dict:
    """POST /api/line_haul/agency/trip/assign — atribui motorista + VEICULO a uma viagem.

    Schema REAL capturado/verificado ao vivo 2026-06-22 (alocou Welves driver_id 725069 +
    cavalo GGY0E48/carreta RRH5H94 na viagem LT0Q6O0291RR1 → trip_status 5 Assigned):

        {"trip_id": <int>,
         "driver_id": <int>,                                 # 1 motorista, no topo (nao driver_list)
         "vehicle_plate_number_list": ["CAVALO","CARRETA"],  # veiculo vai AQUI (nao e' request separada)
         "operation_info": {"device_type": 1, "operation_mode": 0},
         "agency_current_station_id": <int>}                 # estacao do OPERADOR (ex. 5015)

    `driver_ids[0]` = motorista principal; se houver 2, o segundo vai em `second_driver_id`.
    `vehicle_plates` = [cavalo, carreta]. dry_run=True (default) so monta o body, NAO envia.

    NOTA: o veiculo da viagem e' definido pelas PLACAS (nao pelo vehicle_type do cadastro
    do motorista) — por isso o Welves (cadastro TRUCK) foi alocado numa viagem
    CARRETA-EXPRESSA usando placas de carreta. O endpoint antigo
    /trip/accept/assign_multiple_driver NAO e' o usado (dava 131801069).
    """
    if not driver_ids:
        raise ValueError("driver_ids vazio — informe ao menos 1 driver_id")
    plates = [str(p).strip().upper() for p in (vehicle_plates or []) if str(p).strip()]

    body: dict[str, Any] = {
        "trip_id": int(trip_id),
        "driver_id": int(driver_ids[0]),
        "vehicle_plate_number_list": plates,
        "operation_info": {"device_type": 1, "operation_mode": 0},
    }
    if len(driver_ids) > 1:
        body["second_driver_id"] = int(driver_ids[1])
    sid = _station_id(agency_current_station_id)
    if sid:
        body["agency_current_station_id"] = sid
    if dry_run:
        return {"dry_run": True, "method": "POST", "path": _ASSIGN_PATH, "body": body}
    return client.post_json(_ASSIGN_PATH, body=body) or {}


def list_assignable_trips(
    client: SPXClient,
    *,
    agency_current_station_id: int | None = None,
    max_pages: int = 20,
) -> list[dict]:
    """Viagens ATRIBUIVEIS: trip_status==4 (Assigning) e SEM motorista ainda.

    Sao as que a tela de alocacao deve oferecer. Varre as abas Planejado(1) e
    Aceito(2) (o status 4 pode aparecer em qualquer uma) e devolve {trip_id,
    trip_number, origem, destino, vehicle_type, std}, deduplicado por trip_number.
    O id da viagem vem do campo `id` do item cru do trip/list.
    """
    sid = _station_id(agency_current_station_id)
    seen: dict[str, dict] = {}
    for qt in (1, 2):
        page = 1
        while page <= max_pages:
            data = list_trips(
                client, page=page, count=200, query_type=qt,
                agency_current_station_id=sid,
            )
            lst = (data or {}).get("list") or (data or {}).get("items") or []
            for t in lst:
                if t.get("trip_status") != 4:
                    continue
                if (t.get("driver_name") or "").strip():
                    continue  # ja tem motorista
                tn = t.get("trip_number")
                tid = t.get("id") or t.get("trip_id")
                if not tn or not tid or tn in seen:
                    continue
                stations = t.get("trip_station") or []
                origem = stations[0] if stations else {}
                destino = stations[-1] if stations else {}
                seen[tn] = {
                    "trip_id": int(tid),
                    "trip_number": tn,
                    "origem": origem.get("station_name"),
                    "destino": destino.get("station_name"),
                    "vehicle_type": t.get("vehicle_type_name") or "",
                    "std": origem.get("std") or origem.get("sta"),
                }
            if len(lst) < 200:
                break
            page += 1
    return list(seen.values())
