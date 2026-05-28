"""
helpers.py
----------------------------------
Funcoes auxiliares gerais unificadas para processamento de strings
e validacao de dados em todos os robos.
"""

import re
import sys
from datetime import datetime


PLACA_PADRAO_ANTIGO = re.compile(r"^[A-Z]{3}\d{4}$")
PLACA_PADRAO_MERCOSUL = re.compile(r"^[A-Z]{3}\d[A-Z]\d{2}$")


def extrair_numeros(texto: str) -> str:
    """Extrai apenas numeros de uma string."""
    if not texto:
        return ""
    return re.sub(r"[^0-9]", "", str(texto))


def limpar_texto(texto: str, *, substituir_ampersand: bool = True) -> str:
    """Remove espacos extras e caracteres especiais simples."""
    if not texto or str(texto).strip().lower() in ["", "nan", "none"]:
        return ""
    texto_limpo = str(texto)
    if substituir_ampersand:
        texto_limpo = texto_limpo.replace("&", " e ")
    return " ".join(texto_limpo.split()).strip()


# ================================
# Formatacoes Pessoais/Empresariais
# ================================

def formatar_cpf(cpf: str) -> str:
    """Formata CPF para padrao XXX.XXX.XXX-XX."""
    if not cpf:
        return ""
    numeros = extrair_numeros(str(cpf))
    if len(numeros) == 11:
        return f"{numeros[:3]}.{numeros[3:6]}.{numeros[6:9]}-{numeros[9:]}"
    return cpf


def validar_cpf(cpf: str) -> bool:
    """Valida se CPF tem 11 digitos numericos."""
    numeros = extrair_numeros(cpf)
    return len(numeros) == 11


def formatar_cnpj(cnpj: str) -> str:
    """Formata CNPJ para padrao XX.XXX.XXX/XXXX-XX."""
    if not cnpj:
        return ""
    nums = extrair_numeros(str(cnpj))
    if len(nums) == 14:
        return f"{nums[:2]}.{nums[2:5]}.{nums[5:8]}/{nums[8:12]}-{nums[12:]}"
    return cnpj


def validar_cnpj(cnpj: str) -> bool:
    """Valida se CNPJ tem 14 digitos numericos."""
    nums = extrair_numeros(cnpj)
    return len(nums) == 14


def formatar_telefone(telefone: str) -> str:
    """Formata telefone para padrao brasileiro."""
    if not telefone:
        return ""
    numeros = extrair_numeros(str(telefone))
    if len(numeros) == 11:
        return f"({numeros[:2]}) {numeros[2:7]}-{numeros[7:]}"
    if len(numeros) == 10:
        return f"({numeros[:2]}) {numeros[2:6]}-{numeros[6:]}"
    return telefone


def validar_telefone(telefone: str) -> bool:
    """Valida se telefone tem 10 ou 11 digitos."""
    numeros = extrair_numeros(telefone)
    return len(numeros) in [10, 11]


def extrair_cnh_valida(valor_cnh) -> str:
    """Extrai apenas os primeiros 11 digitos de uma CNH."""
    if not valor_cnh:
        return None

    numeros = extrair_numeros(str(valor_cnh))
    if len(numeros) >= 11:
        return numeros[:11]

    return None


def formatar_data(data: str, formato_saida="%Y-%m-%d") -> str:
    """
    Tenta formatar uma string de data para o formato de saida informado.
    """
    if not data or str(data).strip().lower() in ["", "nan", "none"]:
        return ""

    try:
        data = str(data).strip()
        formatos_tentativa = [
            "%d/%m/%Y",
            "%d/%m/%y",
            "%Y-%m-%d",
            "%d-%m-%Y",
            "%d.%m.%Y",
            "%d%m%Y",
        ]

        for fmt in formatos_tentativa:
            try:
                data_obj = datetime.strptime(data, fmt)
                return data_obj.strftime(formato_saida)
            except ValueError:
                continue

        return data

    except Exception:
        return data


# ================================
# Formatacoes de Veiculos
# ================================

def normalizar_placa(placa):
    """Remove mascara e padroniza a placa em maiusculas."""
    if not placa:
        return ""
    placa = limpar_texto(placa).upper()
    return re.sub(r"[^A-Z0-9]", "", placa)


def eh_placa_antiga(placa):
    """Valida o padrao antigo: 3 letras e 4 numeros."""
    return bool(PLACA_PADRAO_ANTIGO.fullmatch(normalizar_placa(placa)))


def eh_placa_mercosul(placa):
    """Valida o padrao Mercosul: 3 letras, 1 numero, 1 letra e 2 numeros."""
    return bool(PLACA_PADRAO_MERCOSUL.fullmatch(normalizar_placa(placa)))


def formatar_placa(placa):
    """Formata placa antiga com hifen e preserva Mercosul sem hifen."""
    if not placa:
        return placa
    placa_normalizada = normalizar_placa(placa)
    if eh_placa_antiga(placa_normalizada):
        return f"{placa_normalizada[:3]}-{placa_normalizada[3:]}"
    if eh_placa_mercosul(placa_normalizada):
        return placa_normalizada
    return placa_normalizada


def formatar_chassi(chassi):
    """Limpa e padroniza chassi."""
    if not chassi:
        return chassi
    return limpar_texto(chassi).upper()


def formatar_renavam(renavam):
    """Extrai apenas numeros do RENAVAM."""
    if not renavam:
        return renavam
    return extrair_numeros(str(renavam))


def extrair_ano(ano):
    """Extrai apenas os 4 primeiros digitos do ano."""
    if not ano:
        return ano
    numeros = extrair_numeros(str(ano))
    if len(numeros) >= 4:
        return numeros[:4]
    return numeros


def extrair_id_planilha(texto: str) -> str:
    """
    Extrai o ID de uma planilha do Google Sheets a partir da URL ou retorna o texto.
    """
    if not texto:
        return ""

    texto = str(texto).strip()

    if "docs.google.com/spreadsheets/d/" in texto:
        try:
            partes = texto.split("/d/")
            if len(partes) > 1:
                return partes[1].split("/")[0]
        except Exception:
            pass

    return texto.replace(" ", "")


def terminal_interativo() -> bool:
    """Indica se o processo atual consegue ler input do terminal."""
    try:
        return bool(sys.stdin) and sys.stdin.isatty()
    except Exception:
        return False


def confirmar_interativamente(mensagem: str, padrao: bool = False) -> bool:
    """
    Faz uma pergunta simples no terminal.

    Em execucao sem console interativo, retorna o valor padrao.
    """
    if not terminal_interativo():
        return padrao

    try:
        resposta = input(mensagem)
    except EOFError:
        return padrao

    resposta_normalizada = str(resposta).strip().lower()
    return resposta_normalizada in {"s", "sim", "y", "yes"}


def aguardar_enter_interativo(mensagem: str = "") -> bool:
    """
    Aguarda ENTER apenas quando houver console interativo.

    Retorna True quando aguardou com sucesso e False quando ignorou.
    """
    if not terminal_interativo():
        return False

    try:
        input(mensagem)
        return True
    except EOFError:
        return False
