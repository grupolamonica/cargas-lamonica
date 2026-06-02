"""Mapeamento Angellira API JSON -> linha do Google Sheets.

Centraliza o esquema das 22 colunas e os helpers de conversao que estavam
duplicados nos 3 scripts originais em Downloads:
    cadastros_api_publica.py   linhas 113-208
    cadastros_api_incremental.py linhas 30-138
    cadastros_vigente.py        linhas 24-41

Fonte unica da verdade: alterar a ordem das colunas ou a logica de extracao
em um lugar so afeta full load + incremental + vigente.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


# Ordem fixa das colunas no Sheets. ALTERAR AQUI quebra a planilha legada —
# manter a ordem do script original e adicionar novas colunas no final.
COLUNAS: list[str] = [
    "Seq",
    "CÓDIGO DO CLIENTE", "NOME DO CLIENTE", "CNPJ DO CLIENTE",
    "LOGIN DO USUÁRIO", "NOME DO USUÁRIO",
    "DATA DE ENVIO", "TERCEIRO",
    "TIPO DA CONSULTA", "STATUS DA CONSULTA", "TIPO DE COBRANCA",
    "CODIGO DA CONSULTA", "DATA VALIDADE",
    "CÓDIGO DO MOTORISTA", "NOME DO MOTORISTA", "CPF DO MOTORISTA",
    "PLACA DO CAVALO", "PLACA DA CARRETA",
    "CÓDIGO DA EMPRESA", "EMPRESA", "CNPJ EMPRESA",
    "TIPO CONSULTA",
]

# Indices 0-based (uteis para o vigente.py que mexe em colunas especificas).
COL_SEQ        = COLUNAS.index("Seq")
COL_DATA_ENVIO = COLUNAS.index("DATA DE ENVIO")
COL_STATUS     = COLUNAS.index("STATUS DA CONSULTA")
COL_CODIGO     = COLUNAS.index("CODIGO DA CONSULTA")
COL_CPF        = COLUNAS.index("CPF DO MOTORISTA")
COL_PLACA_CAV  = COLUNAS.index("PLACA DO CAVALO")
COL_PLACA_CAR  = COLUNAS.index("PLACA DA CARRETA")
COL_CNPJ_EMP   = COLUNAS.index("CNPJ EMPRESA")


def iso_to_brdt(s: Any) -> str:
    """Converte ISO '2025-03-30T17:44:26.270Z' -> '30/03/2025 17:44:26'.

    Tolerante: se nao conseguir parsear, devolve a string original (evita
    estragar a celula do Sheets com data exotica).
    """
    if not s:
        return ""
    try:
        texto = str(s).replace("Z", "").split(".", 1)[0]
        dt = datetime.strptime(texto, "%Y-%m-%dT%H:%M:%S")
        return dt.strftime("%d/%m/%Y %H:%M:%S")
    except Exception:
        return str(s)


def parse_br_dt(valor: Any) -> datetime:
    """Inverso de iso_to_brdt — usado pelo vigente.py pra ordenar por data."""
    if not valor:
        return datetime.min
    try:
        return datetime.strptime(str(valor), "%d/%m/%Y %H:%M:%S")
    except Exception:
        return datetime.min


def calc_status_consulta(query: dict) -> str:
    """STATUS DA CONSULTA: sobrescreve com 'Vencido' se limitDate ja passou.

    Mantem o comportamento exato do script original (so muda para vencido
    quando a data eh parseavel E menor que agora).
    """
    status_obj = query.get("status") or {}
    original = query.get("description") or status_obj.get("description", "") or ""
    limit = query.get("limitDate")
    if not limit:
        return original
    try:
        dt = datetime.strptime(str(limit).replace("Z", "").split(".", 1)[0], "%Y-%m-%dT%H:%M:%S")
        if dt < datetime.now():
            return "Vencido"
    except Exception:
        pass
    return original


def _strip(valor: Any) -> str:
    if valor is None:
        return ""
    if isinstance(valor, str):
        return valor.strip()
    return str(valor).strip()


def extrair_cpf_motorista(query: dict) -> str:
    driver = query.get("driver") or {}
    natural = driver.get("natural") or {}
    cpf = _strip(natural.get("cpf"))
    if cpf:
        return cpf
    return _strip((query.get("history") or {}).get("driverCPF"))


def extrair_cnpj_empresa(query: dict) -> str:
    company = query.get("company") or {}
    legal = company.get("legal") or {}
    cnpj = _strip(legal.get("cnpj"))
    if cnpj:
        return cnpj
    return _strip((query.get("history") or {}).get("companyCNPJ"))


def extrair_placa_cavalo(query: dict) -> str:
    cab = query.get("cab") or {}
    placa = _strip(cab.get("plate")) if cab else ""
    if placa:
        return placa
    return _strip((query.get("history") or {}).get("cabPlate"))


def extrair_placa_carreta(query: dict) -> str:
    tow = query.get("tow") or {}
    placa = _strip(tow.get("plate")) if tow else ""
    if placa:
        return placa
    return _strip((query.get("history") or {}).get("towPlate"))


def _tipo_consulta_label(prime_val: Any) -> str:
    if prime_val == 1:
        return "PRIME"
    if prime_val == 2:
        return "PRIME PLUS"
    return "NORMAL"


def to_row(seq: int, query: dict, *, empresa_id: int, empresa_nome: str, empresa_cnpj: str) -> list:
    """Converte 1 cadastro JSON da API para a linha de 22 colunas do Sheets.

    Mantem a mesma ordem e fallback logic do script original. Os campos do
    cliente (CODIGO/NOME/CNPJ DO CLIENTE) sao passados por argumento pra
    nao depender de env globais — facilita teste.
    """
    type_obj = query.get("type") or {}
    driver = query.get("driver") or {}
    company = query.get("company") or {}
    user_obj = query.get("user") or {}
    history = query.get("history") or {}

    nome_motorista = ""
    if driver:
        nome_motorista = _strip(driver.get("name"))
    if not nome_motorista:
        nome_motorista = _strip(history.get("driverName"))

    nome_empresa = ""
    if company:
        nome_empresa = _strip(company.get("name"))
    if not nome_empresa:
        nome_empresa = _strip(history.get("companyName"))

    cod_motorista = ""
    if driver and driver.get("id") is not None:
        cod_motorista = driver.get("id")
    elif query.get("driverId") is not None:
        cod_motorista = query.get("driverId")

    cod_empresa = ""
    if company and company.get("id") is not None:
        cod_empresa = company.get("id")
    elif query.get("companyId") is not None:
        cod_empresa = query.get("companyId")

    return [
        seq,
        empresa_id,
        empresa_nome,
        empresa_cnpj,
        _strip(user_obj.get("login")),
        _strip(user_obj.get("name")),
        iso_to_brdt(query.get("sentDate")),
        "",  # TERCEIRO
        _strip(type_obj.get("description")),
        calc_status_consulta(query),
        "CADASTRO",
        query.get("id", ""),
        iso_to_brdt(query.get("limitDate")),
        cod_motorista,
        nome_motorista,
        extrair_cpf_motorista(query),
        extrair_placa_cavalo(query),
        extrair_placa_carreta(query),
        cod_empresa,
        nome_empresa,
        extrair_cnpj_empresa(query),
        _tipo_consulta_label(query.get("prime", 0)),
    ]
