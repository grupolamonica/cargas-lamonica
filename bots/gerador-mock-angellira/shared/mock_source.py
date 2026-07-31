"""
mock_source.py
--------------
Adaptador de entrada: transforma o JSON recebido em um dict padronizado
{ 'motorista': rec|None, 'cavalo': rec|None, 'carreta': rec|None }
pronto pra `pdf_render.gerar_pdf_from_records`.

Aceita varios formatos de entrada (para ficar "facil de mandar o JSON"):

  1. Rotulado (recomendado):
     { "motorista": {rec}, "cavalo": {rec}, "carreta": {rec} }   (qualquer subset)

  2. Payload cru do AngelLira:
     { "data": [ {rec}, {rec}, ... ] }   -> classifica cada rec por conteudo

  3. Lista de registros:
     [ {rec}, {rec} ]                    -> classifica cada rec

  4. Registro unico:
     {rec}                               -> classifica o rec

`rec` = um registro no formato profile/query do AngelLira (com history, status,
driver, company, etc). Veja examples/exemplo_motorista.json.
"""

from __future__ import annotations

from copy import deepcopy

from shared.cadastro_map import is_cadastro_payload, map_cadastro


_COMPONENT_KEYS = ('motorista', 'cavalo', 'carreta')


def _looks_like_record(obj) -> bool:
    """Heuristica: e um 'rec' do AngelLira (tem history/status/driver/plate)?"""
    if not isinstance(obj, dict):
        return False
    if any(k in obj for k in ('history', 'status', 'driver', 'company')):
        return True
    hist = obj.get('history')
    if isinstance(hist, dict):
        return True
    return False


def _classify_record(rec: dict) -> str:
    """Decide se um rec e motorista, cavalo ou carreta pelo conteudo."""
    hist = rec.get('history') or {}
    driver = rec.get('driver') or {}

    # Motorista: tem CPF/nome/CNH de motorista.
    if (hist.get('driverCPF') or hist.get('driverName') or hist.get('driverCNH')
            or (driver.get('natural') or {}).get('cpf') or driver.get('name')):
        return 'motorista'

    # Cavalo: placa de tracao (cab*).
    if hist.get('cabPlate') or hist.get('cabRenavam') or hist.get('cabChassis'):
        return 'cavalo'

    # Carreta/reboque: placa de reboque (tow*).
    if hist.get('towPlate') or hist.get('towRenavam') or hist.get('towChassis'):
        return 'carreta'

    # Sem pistas fortes: chuta motorista (secao mais comum).
    return 'motorista'


def _unwrap_record(obj):
    """Se vier o wrapper { 'data': [rec, ...] } de UM componente, extrai o rec.
    Aceita tambem { 'data': rec } ou o proprio rec."""
    if isinstance(obj, dict) and 'data' in obj and not _looks_like_record(obj):
        data = obj.get('data')
        if isinstance(data, list):
            return data[0] if data else None
        if isinstance(data, dict):
            return data
        return None
    return obj


def normalize_input(payload) -> tuple[dict, list[str]]:
    """Retorna ({ 'motorista', 'cavalo', 'carreta' }, warnings).
    Chaves ausentes viram None."""
    result: dict[str, dict | None] = {k: None for k in _COMPONENT_KEYS}
    warnings: list[str] = []

    if payload is None:
        return result, warnings

    # (0) Payload de CADASTRO do sistema de cargas -> mapeia p/ formato AngelLira.
    if is_cadastro_payload(payload):
        return map_cadastro(payload)

    # (1) Rotulado — dict com chaves motorista/cavalo/carreta (formato AngelLira rec).
    if isinstance(payload, dict) and any(k in payload for k in _COMPONENT_KEYS):
        for k in _COMPONENT_KEYS:
            rec = _unwrap_record(payload.get(k))
            if isinstance(rec, dict):
                result[k] = deepcopy(rec)
        return result, warnings

    # (2) Payload cru do AngelLira — { 'data': [rec, ...] } com varios recs.
    if isinstance(payload, dict) and 'data' in payload and isinstance(payload['data'], list):
        for rec in payload['data']:
            if isinstance(rec, dict):
                result[_classify_record(rec)] = deepcopy(rec)
        return result, warnings

    # (3) Lista de registros.
    if isinstance(payload, list):
        for rec in payload:
            if isinstance(rec, dict) and _looks_like_record(rec):
                result[_classify_record(rec)] = deepcopy(rec)
        return result, warnings

    # (4) Registro unico — so aceita se parecer um registro AngelLira.
    if isinstance(payload, dict) and _looks_like_record(payload):
        result[_classify_record(payload)] = deepcopy(payload)
        return result, warnings

    return result, warnings


# ── Exemplo embutido (fallback / demo) ──────────────────────────────────
# Formato = um registro profile/query do AngelLira por componente.

SAMPLE_RECORDS = {
    "motorista": {
        "id": 100001,
        "type": {"description": "Motorista"},
        "sentDate": "2026-07-10T13:20:00.000Z",
        "receivingDate": "2026-07-10T13:25:00.000Z",
        "limitDate": "2027-07-10T13:20:00.000Z",
        "daysUntilDue": 345,
        "status": {"id": 1, "description": "Conforme"},
        "user": {"login": "operador.teste", "name": "Operador Teste"},
        "description": "Cadastro de estudo — dados ficticios, sem consulta ao AngelLira.",
        "observationCertificate": "Documento gerado em modo mock para validacao de layout.",
        "history": {
            "driverName": "JOAO DA SILVA EXEMPLO",
            "driverKind": "AGR",
            "driverCPF": "12345678901",
            "driverBirth": "1988-04-15T00:00:00.000Z",
            "driverRg": "123456789",
            "driverRgState": "SP",
            "driverFather": "JOSE DA SILVA",
            "driverMother": "MARIA DA SILVA",
            "driverPhone": "(11) 90000-0000",
            "driverCNH": "01234567890",
            "driverCNHCategory": "E",
            "driverCNHSecurity": "9876543210",
            "driverCNHValidity": "2028-03-01T00:00:00.000Z",
            "companyName": "TRANSPORTES EXEMPLO LTDA",
            "companyCNPJ": "12.345.678/0001-90",
            "companyCity": "SAO PAULO",
            "companyState": "SP",
            "companyPhone": "(11) 3000-0000",
        },
        "legalPersonRelationship": {"description": "Agregado"},
    },
    "cavalo": {
        "id": 100002,
        "type": {"description": "Veículo"},
        "sentDate": "2026-07-10T13:22:00.000Z",
        "receivingDate": "2026-07-10T13:26:00.000Z",
        "limitDate": "2027-07-10T13:22:00.000Z",
        "daysUntilDue": 345,
        "status": {"id": 1, "description": "Conforme"},
        "user": {"login": "operador.teste"},
        "description": "Veiculo tracao — dados ficticios.",
        "observationCertificate": "",
        "history": {
            "cabPlate": "ABC1D23",
            "cabBrand": "SCANIA",
            "cabModel": "R450 A6X2",
            "cabFabricationYear": "2021",
            "cabModelYear": "2022",
            "cabUF": "SP",
            "cabRenavam": "00123456789",
            "cabChassis": "9BS4X20000R000000",
            "cabAntt": "12345678",
            "cabLastLicensing": "2026-01-10T00:00:00.000Z",
            "cabColor": "BRANCA",
            "cabOwnerCNPJ": "12.345.678/0001-90",
            "cabOwnerCPF": "",
            "cabFleet": "F-001",
            "companyName": "TRANSPORTES EXEMPLO LTDA",
            "companyCNPJ": "12.345.678/0001-90",
            "companyCity": "SAO PAULO",
            "companyState": "SP",
            "companyPhone": "(11) 3000-0000",
        },
        "legalPersonRelationship": {"description": "Agregado"},
    },
    "carreta": {
        "id": 100003,
        "type": {"description": "Veículo"},
        "sentDate": "2026-07-10T13:24:00.000Z",
        "receivingDate": "2026-07-10T13:27:00.000Z",
        "limitDate": "2027-07-10T13:24:00.000Z",
        "daysUntilDue": 345,
        "status": {"id": 1, "description": "Conforme"},
        "user": {"login": "operador.teste"},
        "description": "Reboque — dados ficticios.",
        "observationCertificate": "",
        "history": {
            "towPlate": "XYZ4E56",
            "towBrand": "RANDON",
            "towModel": "SR GR",
            "towFabricationYear": "2020",
            "towModelYear": "2020",
            "towUF": "SP",
            "towRenavam": "00987654321",
            "towChassis": "9AD0000000R000000",
            "towAntt": "87654321",
            "towLastLicensing": "2026-01-12T00:00:00.000Z",
            "towColor": "CINZA",
            "towOwnerCNPJ": "12.345.678/0001-90",
            "towOwnerCPF": "",
            "towFleet": "R-001",
            "companyName": "TRANSPORTES EXEMPLO LTDA",
            "companyCNPJ": "12.345.678/0001-90",
            "companyCity": "SAO PAULO",
            "companyState": "SP",
            "companyPhone": "(11) 3000-0000",
        },
        "legalPersonRelationship": {"description": "Agregado"},
    },
}


def get_sample() -> dict:
    return deepcopy(SAMPLE_RECORDS)
