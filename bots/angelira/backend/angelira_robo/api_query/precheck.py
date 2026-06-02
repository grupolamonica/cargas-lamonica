"""Pre-check de cadastro via API publica (substitui o polling Selenium em /relatorio).

Mesma assinatura semantica de relatorio_precheck.py — retorna o mesmo
ConsultaRelatorioResultado (importado de precheck_types). O wrapper em
relatorio_precheck.py decide se usa este modulo ou cai pro Selenium.

Mapeamento status/situacao:
    ENCONTRADO   + situacao=CONFORME      -> ja cadastrado, validade vigente
    ENCONTRADO   + situacao=NAO_CONFORME  -> cadastrado, mas limitDate venceu
    ENCONTRADO   + situacao=""            -> cadastrado, sem limitDate (raro)
    NAO_ENCONTRADO                        -> nao localizado nos N dias buscados
    INCONCLUSIVO + erro=...               -> falha de rede/auth — caller decide fallback
"""

from __future__ import annotations

import os
import traceback
import unicodedata
from datetime import datetime

from ..helpers import extrair_numeros, normalizar_placa
from ..logger import log_alerta, log_info
from ..precheck_types import ConsultaRelatorioResultado
from .client import AngellraAPIClient


def _normalizar(texto: str) -> str:
    """Mesma normalizacao do relatorio_precheck.py Selenium (NFKD + alphanum upper)."""
    normalized = unicodedata.normalize("NFKD", str(texto or ""))
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")
    return "".join(ch for ch in ascii_only.upper() if ch.isalnum())


def _dias_busca_default() -> int:
    raw = (os.getenv("ANGELIRA_PRECHECK_DIAS") or "").strip()
    if not raw:
        return 365
    try:
        return max(7, int(raw))
    except ValueError:
        return 365


def _parse_limit_date(query: dict) -> datetime | None:
    limit = query.get("limitDate")
    if not limit:
        return None
    try:
        return datetime.strptime(
            str(limit).replace("Z", "").split(".", 1)[0],
            "%Y-%m-%dT%H:%M:%S",
        )
    except Exception:
        return None


def _coletar_descricoes(query: dict) -> list[str]:
    """Todos os campos textuais da API que podem conter o rotulo CONFORME/NAO CONFORME."""
    textos: list[str] = []
    if query.get("description"):
        textos.append(str(query["description"]))
    status_obj = query.get("status") or {}
    if isinstance(status_obj, dict) and status_obj.get("description"):
        textos.append(str(status_obj["description"]))
    if isinstance(status_obj, dict) and status_obj.get("name"):
        textos.append(str(status_obj["name"]))
    type_obj = query.get("type") or {}
    if isinstance(type_obj, dict) and type_obj.get("description"):
        textos.append(str(type_obj["description"]))
    return textos


def _detectar_situacao_por_descricao(query: dict) -> str:
    """Mesma logica de _detectar_situacao do relatorio_precheck.py — testa
    NAOCONFORME ANTES de CONFORME (a primeira eh substring da segunda apos
    normalizar)."""
    for texto in _coletar_descricoes(query):
        n = _normalizar(texto)
        if "NAOCONFORME" in n:
            return "NAO_CONFORME"
        if "CONFORME" in n:
            return "CONFORME"
    return ""


def _classificar_situacao(query: dict) -> str:
    """Determina CONFORME / NAO_CONFORME aplicando, em ordem:
        1) Texto descritivo (espelha Selenium /relatorio coluna 'Status').
        2) limitDate (futuro = CONFORME, passado = NAO_CONFORME / 'Vencido').
        3) Fallback NAO_CONFORME quando o cadastro existe mas a API nao
           expoe a situacao — flow deve seguir pra UPDATE em vez de encerrar
           por seguranca (mesma decisao do operador quando ve 'sem status').
    """
    via_texto = _detectar_situacao_por_descricao(query)
    limit = _parse_limit_date(query)

    # Vigencia vencida sobrescreve rotulo CONFORME: o portal nao atualiza o
    # texto descritivo quando limitDate expira (ex.: consulta de 2020 com
    # vigencia ate fev/2021 continua chegando como "Conforme" anos depois).
    # Sem esse override, o flow encerra em early-return e o cadastro nunca
    # eh atualizado.
    if via_texto == "CONFORME" and limit is not None and limit <= datetime.now():
        log_info(
            f"[precheck-api] CONFORME ignorado: vigencia {limit.isoformat()} "
            f"venceu -> reclassificando como NAO_CONFORME (forca update)"
        )
        return "NAO_CONFORME"

    if via_texto:
        return via_texto

    if limit is not None:
        return "CONFORME" if limit > datetime.now() else "NAO_CONFORME"

    # ENCONTRADO sem texto e sem limitDate -> trata como NAO_CONFORME para que
    # o flow rode o UPDATE (comportamento solicitado pelo usuario).
    return "NAO_CONFORME"


def _evidencia_curta(query: dict) -> str:
    codigo = query.get("id", "?")
    sent = query.get("sentDate") or ""
    limit = query.get("limitDate") or ""
    return f"id={codigo} sent={sent[:10]} limit={limit[:10]}"


def verificar_motorista_via_api(
    cpf: str,
    client: AngellraAPIClient | None = None,
    *,
    dias_atras: int | None = None,
) -> ConsultaRelatorioResultado:
    """Pre-check de motorista por CPF — sucessor da consulta Selenium em /relatorio.

    Argumentos:
        cpf:        string crua (com ou sem formatacao); normaliza para 11 digitos.
        client:     reusar AngellraAPIClient ja autenticado (opcional).
        dias_atras: janela de busca; default vem de ANGELIRA_PRECHECK_DIAS (365).
    """
    cpf_limpo = extrair_numeros(cpf)
    if len(cpf_limpo) != 11:
        return ConsultaRelatorioResultado(
            status="INCONCLUSIVO",
            erro=f"CPF invalido para consulta via API: {cpf!r}",
        )

    dias = dias_atras if dias_atras is not None else _dias_busca_default()
    log_info(f"[precheck-api] consultando motorista cpf={cpf_limpo} (janela {dias}d)...")
    try:
        if client is None:
            client = AngellraAPIClient()
            client.login()
        query = client.buscar_por_cpf(cpf_limpo, dias_atras=dias)
    except Exception as exc:
        log_alerta(f"[precheck-api] falha na API: {type(exc).__name__}: {exc}")
        log_alerta(traceback.format_exc())
        return ConsultaRelatorioResultado(
            status="INCONCLUSIVO",
            erro=f"Falha na API: {type(exc).__name__}: {str(exc)[:120]}",
        )

    if query is None:
        log_info(f"[precheck-api] motorista cpf={cpf_limpo} NAO encontrado nos ultimos {dias}d")
        return ConsultaRelatorioResultado(
            status="NAO_ENCONTRADO",
            evidencia=f"Busca em {dias}d sem match",
        )

    situacao = _classificar_situacao(query)
    descs = _coletar_descricoes(query)
    evid = _evidencia_curta(query)
    log_info(
        f"[precheck-api] motorista cpf={cpf_limpo} ENCONTRADO ({situacao}): {evid} "
        f"descs={descs!r}"
    )
    return ConsultaRelatorioResultado(
        status="ENCONTRADO",
        situacao=situacao,
        evidencia=evid,
    )


def verificar_veiculo_via_api(
    placa: str,
    client: AngellraAPIClient | None = None,
    *,
    dias_atras: int | None = None,
) -> ConsultaRelatorioResultado:
    """Pre-check de veiculo por placa (cavalo ou carreta) via API."""
    placa_norm = normalizar_placa(placa)
    if not placa_norm:
        return ConsultaRelatorioResultado(
            status="INCONCLUSIVO",
            erro=f"Placa invalida para consulta via API: {placa!r}",
        )

    dias = dias_atras if dias_atras is not None else _dias_busca_default()
    log_info(f"[precheck-api] consultando veiculo placa={placa_norm} (janela {dias}d)...")
    try:
        if client is None:
            client = AngellraAPIClient()
            client.login()
        query = client.buscar_por_placa(placa_norm, dias_atras=dias)
    except Exception as exc:
        log_alerta(f"[precheck-api] falha na API: {type(exc).__name__}: {exc}")
        log_alerta(traceback.format_exc())
        return ConsultaRelatorioResultado(
            status="INCONCLUSIVO",
            erro=f"Falha na API: {type(exc).__name__}: {str(exc)[:120]}",
        )

    if query is None:
        log_info(f"[precheck-api] veiculo placa={placa_norm} NAO encontrado nos ultimos {dias}d")
        return ConsultaRelatorioResultado(
            status="NAO_ENCONTRADO",
            evidencia=f"Busca em {dias}d sem match",
        )

    situacao = _classificar_situacao(query)
    descs = _coletar_descricoes(query)
    evid = _evidencia_curta(query)
    log_info(
        f"[precheck-api] veiculo placa={placa_norm} ENCONTRADO ({situacao}): {evid} "
        f"descs={descs!r}"
    )
    return ConsultaRelatorioResultado(
        status="ENCONTRADO",
        situacao=situacao,
        evidencia=evid,
    )
