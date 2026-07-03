"""Driver-request: validate, draft/save, submit/check, submit, list, detail, withdraw.

Espelha o flow do portal /workforce/driver-request/create.
"""

from __future__ import annotations

import re
from typing import Any

from . import constants as K
from .client import APIErro, SPXClient
from .logger import log_alerta, log_info


_ONLY_DIGITS = re.compile(r"\D+")


def _digits(s: str | None) -> str:
    return _ONLY_DIGITS.sub("", s or "")


# ── Validacoes / pre-check ────────────────────────────────────────────────

def validate_basic(
    client: SPXClient,
    *,
    cpf: str,
    driver_name: str,
    contact_number: str,
    license_number: str = "",
    is_new_request: bool = True,
    transport_type: int = K.TransportType.NORMAL_DRIVER,
) -> dict:
    """POST /api/driverservice/agency/br/driver/request/validate/basic.

    Step 1 do form. Retorna:
      - {is_matched: True, driver_info: {...}} se CPF ja existe (autofill no portal)
      - {is_matched: False} se CPF eh novo

    Lanca APIErro se retcode != 0 (ex: 271605007 CPF invalido).
    """
    body = {
        "cpf": _digits(cpf),
        "driver_name": (driver_name or "").strip(),
        "contact_number": _digits(contact_number),
        "license_number": _digits(license_number),
        "is_new_request": bool(is_new_request),
        "transport_type": int(transport_type),
    }
    data = client.post_json(
        "/api/driverservice/agency/br/driver/request/validate/basic",
        body=body,
    )
    return data or {}


def is_cpf_exist(client: SPXClient, cpf: str) -> bool:
    """POST /api/driverservice/agency/br/driver/is_cpf_exist.
    Endpoint dedicado, NAO requer phone/cnh.
    """
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        return False
    data = client.post_json(
        "/api/driverservice/agency/br/driver/is_cpf_exist",
        body={"cpf": cpf_d},
    )
    if isinstance(data, dict):
        return bool(data.get("is_exist") or data.get("exist"))
    return bool(data)


def buscar_por_cpf(client: SPXClient, cpf: str) -> dict | None:
    """Checa rapidamente se motorista existe (sem requerer phone).
    Retorna dict com {exists, cpf} se encontrado, None se nao.

    Para obter driver_info completo (autofill), use buscar_com_phone(cpf, phone_real)
    """
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        return None
    try:
        exists = is_cpf_exist(client, cpf_d)
    except APIErro as exc:
        log_alerta(f"[drivers] is_cpf_exist falhou: {exc}")
        return None
    return {"exists": exists, "cpf": cpf_d} if exists else None


def buscar_com_phone(client: SPXClient, cpf: str, *, contact_number: str,
                     driver_name: str = "LOOKUP", license_number: str = "12345678901",
                     transport_type: int = K.TransportType.NORMAL_DRIVER) -> dict | None:
    """Autofill detalhado: valida CPF + phone real do motorista pra obter driver_info.
    Use quando voce JA tem o phone real (do whatsapp/cadastro) e quer pre-popular o form.
    """
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        return None
    try:
        r = validate_basic(
            client, cpf=cpf_d, driver_name=driver_name,
            contact_number=contact_number, license_number=license_number,
            is_new_request=False, transport_type=transport_type,
        )
        if r.get("is_matched"):
            return r.get("driver_info")
    except APIErro as exc:
        if exc.retcode in (K.CPF_INVALID, K.PHONE_INVALID):
            log_alerta(f"[drivers] buscar_com_phone rejeitada: retcode={exc.retcode}")
            return None
        raise
    return None


# ── Draft / Submit ────────────────────────────────────────────────────────

def save_draft(client: SPXClient, payload: dict, *, request_id: int | None = None) -> dict:
    """POST /api/driverservice/agency/br/driver/request/draft/save.
    Checkpoint opcional. Se passar request_id, atualiza draft existente.
    """
    body = dict(payload)
    if request_id is not None:
        body["id"] = int(request_id)
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/draft/save",
        body=body,
    ) or {}


def validate_detail(client: SPXClient, payload: dict) -> dict:
    """POST .../request/validate/detail — Step 2 validation."""
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/validate/detail",
        body=payload,
    ) or {}


def submit_check(client: SPXClient, payload: dict) -> dict:
    """POST .../request/submit/check — pre-submit. Retorna {vehicle_diff_field: [...]}
    se ha conflito com cadastro existente.
    """
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/submit/check",
        body=payload,
    ) or {}


def submit(client: SPXClient, payload: dict) -> dict:
    """POST .../request/submit — envia cadastro final. Retorna {request_id, driver_id?}."""
    log_info(f"[drivers] submit cpf={payload.get('cpf', '?')[:3]}... transport_type={payload.get('transport_type')}")
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/submit",
        body=payload,
    ) or {}


# ── Listagem / detalhe / withdraw ─────────────────────────────────────────

def list_requests(client: SPXClient, *, page: int = 1, count: int = 50, filters: dict | None = None) -> dict:
    """POST .../request/list."""
    body = {"pageno": page, "count": count}
    if filters:
        body.update(filters)
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/list",
        body=body,
    ) or {}


def get_request_detail(client: SPXClient, request_id: int, *, view_only: bool = False) -> dict:
    """POST .../request/detail (admin) ou .../request/detail/view (view-only)."""
    path = "/api/driverservice/agency/br/driver/request/detail"
    if view_only:
        path = "/api/driverservice/agency/br/driver/request/detail/view"
    return client.post_json(path, body={"id": int(request_id)}) or {}


def withdraw_request(client: SPXClient, request_id: int) -> dict:
    """POST .../request/withdraw — cancela uma request submitted ainda pendente."""
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/withdraw",
        body={"id": int(request_id)},
    ) or {}


def list_drivers_in_agency(client: SPXClient, *, cpf: str | None = None, page: int = 1, count: int = 20) -> dict:
    """POST /api/driverservice/agency/br/driver/list — lista drivers ja registrados na agencia.
    Use pra achar driver_id de motoristas inativos.
    """
    body = {"pageno": page, "count": count}
    if cpf:
        body["cpf"] = _digits(cpf)
    return client.post_json("/api/driverservice/agency/br/driver/list", body=body) or {}


def list_assignable_drivers(client: SPXClient, *, count: int = 500, max_pages: int = 10) -> list[dict]:
    """Motoristas da agência para resolver nome->driver_id na atribuição de viagem.

    Retorna [{driver_id, name}]. Fonte = /driver/list (list_drivers_in_agency),
    que devolve o driver_id canônico consumido por trips.assign_drivers. O dropdown
    específico do line_haul não foi capturado; a lista da agência é o equivalente
    seguro para casar por nome — só motoristas registrados são atribuíveis mesmo.
    Pagina até `max_pages` ou até acumular `count` motoristas.
    """
    out: list[dict] = []
    seen: set[int] = set()
    per_page = 100
    page = 1
    while page <= max_pages and len(out) < count:
        try:
            data = list_drivers_in_agency(client, page=page, count=per_page)
        except APIErro as exc:
            log_alerta(f"[drivers] list_assignable_drivers pagina {page} falhou: {exc}")
            break
        lst = (data or {}).get("list") or (data or {}).get("items") or []
        for it in lst:
            did = it.get("driver_id") or it.get("id")
            nm = it.get("driver_name") or it.get("name") or it.get("full_name") or ""
            if did is None:
                continue
            did = int(did)
            if did in seen:
                continue
            seen.add(did)
            out.append({"driver_id": did, "name": (nm or "").strip()})
        if len(lst) < per_page:
            break
        page += 1
    return out[:count]


def activate_driver(client: SPXClient, driver_id: int) -> dict:
    """POST /api/driverservice/agency/br/driver/activation/update — ativa driver_profile inativo.
    action: 1=Deactivate, 2=Activate, 3=Cancel
    """
    return client.post_json(
        "/api/driverservice/agency/br/driver/activation/update",
        body={"driver_id": int(driver_id), "action": 2},
    ) or {}


def buscar_driver_id_por_cpf(client: SPXClient, cpf: str) -> int | None:
    """Procura driver_id de um motorista ja registrado (ativo ou inativo) na agencia."""
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        return None
    try:
        r = list_drivers_in_agency(client, cpf=cpf_d, page=1, count=10)
    except APIErro as exc:
        log_alerta(f"[drivers] buscar_driver_id falhou: {exc}")
        return None
    lista = (r or {}).get("list") or (r or {}).get("items") or []
    for item in lista:
        item_cpf = _digits(str(item.get("cpf") or ""))
        if item_cpf and item_cpf == cpf_d:
            return item.get("driver_id") or item.get("id")
    # Fallback: primeiro item se backend filtrou pelo CPF mas escondeu valor
    if lista:
        return lista[0].get("driver_id") or lista[0].get("id")
    return None


def delete_draft(client: SPXClient, request_id: int) -> dict:
    """POST .../request/draft/delete."""
    return client.post_json(
        "/api/driverservice/agency/br/driver/request/draft/delete",
        body={"id": int(request_id)},
    ) or {}


# ── Payload builder ───────────────────────────────────────────────────────

def build_payload_normal_driver(
    *,
    # Identificacao
    cpf: str, driver_name: str, contact_number: str,
    gender: int, birth_day: int,
    # Endereco
    city_id: int, neighbourhood_name: str, street_name: str,
    address_number: str, zip_code: str,
    # Funcao/estacao
    contract_type: int, function_type_list: list[int],
    linehaul_station_id: int = 0,
    pickup_station_id: int = 0, delivery_station_id: int = 0, return_station_id: int = 0,
    feeder_mode: list[int] | None = None,
    at_level_handover: int = K.AtHandover.YES,
    allow_feeders_self_trigger_transferred_status: int = 0,
    # CNH
    license_number: str, license_type: int, license_expire_date: int,
    cnh_remarks: list[str] | None = None,
    # Veiculo
    vehicle_type: int,
    license_plate: str,
    plate_number_quantity: int = 1,
    vehicle_manufacturer: str = "",
    vehicle_manufacturing_year: str = "",
    vehicle_owner_name: str = "",
    renavam: str = "",
    # URLs retornadas dos uploads
    driver_photo: str = "", license_img_front: str = "", license_img_back: str = "",
    rg_img_front: str = "", rg_img_back: str = "",
    risk_assessment_document: str = "", rad_expire_date: int = 0,
    vehicle_document: str = "",
    # Extras
    quick_pickup: int = 0, quick_pickup_flag: int = 0,
) -> dict:
    """Constroi o dict payload do submit para fluxo NormalDriver (transport_type=0)."""
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        raise ValueError(f"CPF invalido (esperado {K.CPF_LENGTH} digitos): {cpf}")
    phone_d = _digits(contact_number)
    cnh_d = _digits(license_number)
    renavam_d = _digits(renavam)
    zip_d = _digits(zip_code)
    addr_num_d = _digits(address_number)

    # Pickup mode: quick_pickup* sao zerados quando Pickup no function_type_list
    if K.FunctionType.PICKUP in function_type_list:
        quick_pickup = 0
        quick_pickup_flag = 0

    rg_photo_url_list = [u for u in (rg_img_front, rg_img_back) if u]

    payload = {
        # Identificacao
        "cpf": cpf_d,
        "driver_name": (driver_name or "").strip(),
        "contact_number": phone_d,
        "transport_type": K.TransportType.NORMAL_DRIVER,
        "gender": int(gender),
        "birth_day": int(birth_day),
        # Endereco
        "city_id": int(city_id),
        "neighbourhood_name": (neighbourhood_name or "")[:K.NEIGHBOURHOOD_LENGTH_LIMIT],
        "street_name": (street_name or "")[:K.STREET_LENGTH_LIMIT],
        "address_number": addr_num_d[:K.ADDRESS_NUMBER_MAX_DIGITS],
        "zip_code": zip_d,
        # Fotos
        "driver_photo": driver_photo or "",
        "license_img_front": license_img_front or "",
        "license_img_back": license_img_back or "",
        "rg_img_front": rg_img_front or "",
        "rg_img_back": rg_img_back or "",
        "rg_photo_url_list": rg_photo_url_list,
        "risk_assessment_document": risk_assessment_document or "",
        "rad_expire_date": int(rad_expire_date or 0),
        # Funcao
        "contract_type": int(contract_type),
        "function_type_list": [int(x) for x in (function_type_list or [])],
        "pickup_station_id": int(pickup_station_id or 0),
        "delivery_station_id": int(delivery_station_id or 0),
        "return_station_id": int(return_station_id or 0),
        "linehaul_station_id": int(linehaul_station_id or 0),
        "feeder_mode": [int(x) for x in (feeder_mode or [])],
        "at_level_handover": int(at_level_handover),
        "allow_feeders_self_trigger_transferred_status": int(allow_feeders_self_trigger_transferred_status),
        # CNH
        "license_number": cnh_d,
        "license_type": int(license_type),
        "cnh_remarks": list(cnh_remarks or []),
        "license_expire_date": int(license_expire_date),
        # Veiculo
        "renavam": renavam_d,
        "vehicle_type": int(vehicle_type),
        "license_plate": (license_plate or "").strip().upper(),
        "plate_number_quantity": int(plate_number_quantity),
        "vehicle_manufacturer": (vehicle_manufacturer or "").strip(),
        "vehicle_manufacturing_year": (vehicle_manufacturing_year or "").strip(),
        "vehicle_owner_name": (vehicle_owner_name or "").strip()[:K.VEHICLE_OWNER_NAME_LENGTH_LIMIT],
        "vehicle_document": vehicle_document or "",
        # Pickup flags
        "quick_pickup": int(quick_pickup),
        "quick_pickup_flag": int(quick_pickup_flag),
    }
    return payload


def build_payload_walker_biker(
    *,
    # Identificacao
    cpf: str, driver_name: str, contact_number: str,
    gender: int, birth_day: int,
    # Endereco
    city_id: int, neighbourhood_name: str, street_name: str,
    address_number: str, zip_code: str,
    # Funcao/estacao
    contract_type: int, function_type_list: list[int],
    pickup_station_id: int = 0, delivery_station_id: int = 0,
    return_station_id: int = 0, linehaul_station_id: int = 0,
    # RG (substitui CNH para walker/biker)
    rg_img_front: str, rg_img_back: str,
    driver_photo: str,
    # Risk doc opcional
    risk_assessment_document: str = "", rad_expire_date: int = 0,
    quick_pickup: int = 0, quick_pickup_flag: int = 0,
) -> dict:
    """Variant pra transport_type=1 (Walker/Biker). Sem CNH/veiculo."""
    cpf_d = _digits(cpf)
    if len(cpf_d) != K.CPF_LENGTH:
        raise ValueError(f"CPF invalido: {cpf}")
    if K.FunctionType.PICKUP in function_type_list:
        quick_pickup = 0
        quick_pickup_flag = 0

    return {
        "cpf": cpf_d,
        "driver_name": (driver_name or "").strip(),
        "contact_number": _digits(contact_number),
        "transport_type": K.TransportType.WALKER_BIKER,
        "gender": int(gender),
        "birth_day": int(birth_day),
        "city_id": int(city_id),
        "neighbourhood_name": (neighbourhood_name or "")[:K.NEIGHBOURHOOD_LENGTH_LIMIT],
        "street_name": (street_name or "")[:K.STREET_LENGTH_LIMIT],
        "address_number": _digits(address_number)[:K.ADDRESS_NUMBER_MAX_DIGITS],
        "zip_code": _digits(zip_code),
        "driver_photo": driver_photo,
        "rg_img_front": rg_img_front,
        "rg_img_back": rg_img_back,
        "rg_photo_url_list": [rg_img_front, rg_img_back],
        "risk_assessment_document": risk_assessment_document or "",
        "rad_expire_date": int(rad_expire_date or 0),
        "contract_type": int(contract_type),
        "function_type_list": [int(x) for x in (function_type_list or [])],
        "pickup_station_id": int(pickup_station_id or 0),
        "delivery_station_id": int(delivery_station_id or 0),
        "return_station_id": int(return_station_id or 0),
        "linehaul_station_id": int(linehaul_station_id or 0),
        "quick_pickup": int(quick_pickup),
        "quick_pickup_flag": int(quick_pickup_flag),
    }
