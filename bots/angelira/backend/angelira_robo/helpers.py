"""Formatadores e validadores brasileiros (CPF, CNPJ, telefone, placa, etc).

Cópia enxuta do shared/helpers.py do projeto original. Removidos os
helpers de CLI interativa (aguardar_enter_interativo, confirmar_interativamente,
terminal_interativo) — não cabem num backend HTTP.
"""

from __future__ import annotations

import re
from datetime import datetime


PLACA_PADRAO_ANTIGO = re.compile(r"^[A-Z]{3}\d{4}$")
PLACA_PADRAO_MERCOSUL = re.compile(r"^[A-Z]{3}\d[A-Z]\d{2}$")


def extrair_numeros(texto: str) -> str:
    if not texto:
        return ""
    return re.sub(r"[^0-9]", "", str(texto))


def limpar_texto(texto: str, *, substituir_ampersand: bool = True) -> str:
    if not texto or str(texto).strip().lower() in ["", "nan", "none"]:
        return ""
    texto_limpo = str(texto)
    if substituir_ampersand:
        texto_limpo = texto_limpo.replace("&", " e ")
    return " ".join(texto_limpo.split()).strip()


def formatar_cpf(cpf: str) -> str:
    if not cpf:
        return ""
    numeros = extrair_numeros(str(cpf))
    if len(numeros) == 11:
        return f"{numeros[:3]}.{numeros[3:6]}.{numeros[6:9]}-{numeros[9:]}"
    return cpf


def validar_cpf(cpf: str) -> bool:
    return len(extrair_numeros(cpf)) == 11


def formatar_cnpj(cnpj: str) -> str:
    if not cnpj:
        return ""
    nums = extrair_numeros(str(cnpj))
    if len(nums) == 14:
        return f"{nums[:2]}.{nums[2:5]}.{nums[5:8]}/{nums[8:12]}-{nums[12:]}"
    return cnpj


def validar_cnpj(cnpj: str) -> bool:
    return len(extrair_numeros(cnpj)) == 14


def formatar_telefone(telefone: str) -> str:
    if not telefone:
        return ""
    numeros = extrair_numeros(str(telefone))
    if len(numeros) == 11:
        return f"({numeros[:2]}) {numeros[2:7]}-{numeros[7:]}"
    if len(numeros) == 10:
        return f"({numeros[:2]}) {numeros[2:6]}-{numeros[6:]}"
    return telefone


def validar_telefone(telefone: str) -> bool:
    return len(extrair_numeros(telefone)) in [10, 11]


def extrair_cnh_valida(valor_cnh) -> str | None:
    if not valor_cnh:
        return None
    numeros = extrair_numeros(str(valor_cnh))
    if len(numeros) >= 11:
        return numeros[:11]
    return None


def formatar_data(data: str, formato_saida: str = "%Y-%m-%d") -> str:
    if not data or str(data).strip().lower() in ["", "nan", "none"]:
        return ""
    try:
        data = str(data).strip()
        for fmt in ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%d%m%Y"):
            try:
                return datetime.strptime(data, fmt).strftime(formato_saida)
            except ValueError:
                continue
        return data
    except Exception:
        return data


def normalizar_placa(placa) -> str:
    if not placa:
        return ""
    placa = limpar_texto(placa).upper()
    return re.sub(r"[^A-Z0-9]", "", placa)


def eh_placa_antiga(placa) -> bool:
    return bool(PLACA_PADRAO_ANTIGO.fullmatch(normalizar_placa(placa)))


def eh_placa_mercosul(placa) -> bool:
    return bool(PLACA_PADRAO_MERCOSUL.fullmatch(normalizar_placa(placa)))


def formatar_placa(placa) -> str:
    if not placa:
        return placa
    placa_normalizada = normalizar_placa(placa)
    if eh_placa_antiga(placa_normalizada):
        return f"{placa_normalizada[:3]}-{placa_normalizada[3:]}"
    return placa_normalizada


def formatar_chassi(chassi) -> str:
    if not chassi:
        return chassi
    return limpar_texto(chassi).upper()


def formatar_renavam(renavam) -> str:
    if not renavam:
        return renavam
    return extrair_numeros(str(renavam))


def extrair_ano(ano) -> str:
    if not ano:
        return ano
    numeros = extrair_numeros(str(ano))
    if len(numeros) >= 4:
        return numeros[:4]
    return numeros
