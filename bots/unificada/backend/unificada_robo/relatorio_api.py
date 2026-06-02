"""
Consulta e exportacao do relatorio AngelLira via API direta.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import io
import json
import os
import time
import textwrap
from pathlib import Path
from typing import Iterable

import requests

from .auth import get_company_id, get_password, get_username
from .helpers import extrair_numeros, formatar_placa
from .logger import log_alerta, log_info

# Constante extraida de shared/relatorio_precheck.py (era usada por filters de data).
DATA_DESDE_PADRAO = "2000-01-01"


AUTH_URL = "https://auth.angellira.com.br/auth"
GRANT_URL = "https://auth.angellira.com.br/auth/grant"
PROFILE_QUERY_URL = "https://api.angellira.com.br/profile/query"
TOKEN_CACHE_TTL_MINUTES = 20

_TOKEN_CACHE: dict[str, object] = {"token": "", "expires_at": None}


@dataclass(frozen=True)
class RelatorioApiExportResult:
    status: str
    query_value: str
    q_for: str
    output_path: str = ""
    item: dict | None = None
    erro: str = ""


@dataclass(frozen=True)
class RelatorioApiStatusResult:
    status: str
    query_value: str
    q_for: str
    item: dict | None = None
    status_description: str = ""
    erro: str = ""

def _build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Accept": "application/json, text/plain, */*",
        }
    )
    return session


def _extract_token_from_response(response: requests.Response) -> str:
    try:
        payload = response.json()
        if isinstance(payload, dict):
            token = str(payload.get("token") or "").strip()
            if token:
                return token
    except Exception:
        pass

    final_url = str(response.url or "")
    for marker in ("access_token=", "token="):
        if marker in final_url:
            return final_url.split(marker, 1)[1].split("&", 1)[0].strip()

    raw_text = str(response.text or "")
    for marker in ('"token":"', '"access_token":"'):
        if marker in raw_text:
            return raw_text.split(marker, 1)[1].split('"', 1)[0].strip()

    return ""


def _request_new_token() -> str:
    username = get_username()
    password = get_password()
    company_id = get_company_id()

    session = _build_session()

    login_response = session.post(
        AUTH_URL,
        json={"login": username, "pass": password, "lang": "pt-br"},
        timeout=20,
    )
    login_response.raise_for_status()

    grant_response = session.post(
        GRANT_URL,
        data={
            "company": str(company_id),
            "user": '{"userName":"","userId":-1}',
        },
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://auth.angellira.com.br",
            "Referer": (
                "https://auth.angellira.com.br/grant"
                f"?client=Angellira&scope=&company={company_id}"
            ),
        },
        timeout=20,
        allow_redirects=True,
    )
    grant_response.raise_for_status()

    token = _extract_token_from_response(grant_response)
    if not token:
        raise RuntimeError(
            "Nao foi possivel obter o token final do AngelLira pela API de grant."
        )

    _TOKEN_CACHE["token"] = token
    _TOKEN_CACHE["expires_at"] = datetime.now(timezone.utc) + timedelta(
        minutes=TOKEN_CACHE_TTL_MINUTES
    )
    return token


def get_cached_token(force_refresh: bool = False) -> str:
    expires_at = _TOKEN_CACHE.get("expires_at")
    token = str(_TOKEN_CACHE.get("token") or "")
    now = datetime.now(timezone.utc)

    if (
        not force_refresh
        and token
        and isinstance(expires_at, datetime)
        and now < expires_at
    ):
        return token

    return _request_new_token()


def _normalize_query_value(q_for: str, value: str) -> str:
    raw_value = str(value or "").strip()
    if q_for == "cpf":
        return extrair_numeros(raw_value)
    if q_for == "plate":
        return formatar_placa(raw_value).upper().strip()
    return raw_value


def query_profile_records(
    query_value: str,
    q_for: str,
    *,
    since: str = DATA_DESDE_PADRAO,
    detailed: bool = True,
) -> list[dict]:
    normalized_value = _normalize_query_value(q_for, query_value)
    if not normalized_value:
        return []

    def _execute(token: str) -> requests.Response:
        return requests.get(
            PROFILE_QUERY_URL,
            headers={"Authorization": f"Bearer {token}"},
            params={
                "q": normalized_value,
                "detailed": "true" if detailed else "false",
                "since": since,
                "qFor": q_for,
                "sort[]": "-sentDate",
            },
            timeout=20,
        )

    token = get_cached_token(force_refresh=False)
    response = _execute(token)
    if response.status_code == 401:
        log_alerta(
            "Token do relatorio AngelLira expirou ou foi rejeitado. Renovando automaticamente."
        )
        token = get_cached_token(force_refresh=True)
        response = _execute(token)

    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return []

    data = payload.get("data") or []
    return [item for item in data if isinstance(item, dict)]


def _status_description_from_item(item: dict | None) -> str:
    if not isinstance(item, dict):
        return ""
    return str(((item.get("status", {}) or {}).get("description") or "")).strip()


def _status_is_conforme(status_description: str) -> bool:
    return str(status_description or "").strip().upper() == "CONFORME"


def consultar_status_relatorio(
    query_value: str,
    q_for: str,
) -> RelatorioApiStatusResult:
    normalized_value = _normalize_query_value(q_for, query_value)
    try:
        records = query_profile_records(normalized_value, q_for)
        if not records:
            return RelatorioApiStatusResult(
                status="NAO_ENCONTRADO",
                query_value=normalized_value,
                q_for=q_for,
                erro="API do AngelLira nao retornou registros para a consulta.",
            )

        selected_item = records[0]
        status_description = _status_description_from_item(selected_item)
        if _status_is_conforme(status_description):
            return RelatorioApiStatusResult(
                status="CONFORME",
                query_value=normalized_value,
                q_for=q_for,
                item=selected_item,
                status_description=status_description,
            )

        return RelatorioApiStatusResult(
            status="AGUARDANDO_STATUS",
            query_value=normalized_value,
            q_for=q_for,
            item=selected_item,
            status_description=status_description,
            erro=(
                "Registro localizado, mas a analise ainda nao ficou Conforme. "
                f"Status atual: {status_description or '-'}"
            ),
        )
    except Exception as exc:
        return RelatorioApiStatusResult(
            status="ERRO",
            query_value=normalized_value,
            q_for=q_for,
            erro=str(exc),
        )


def aguardar_status_relatorio_conforme(
    query_value: str,
    q_for: str,
    *,
    timeout_seconds: float = 300.0,
    poll_interval_seconds: float = 10.0,
) -> RelatorioApiStatusResult:
    deadline = time.monotonic() + max(float(timeout_seconds or 0.0), 0.0)
    intervalo = max(float(poll_interval_seconds or 0.0), 1.0)
    ultimo_resultado = RelatorioApiStatusResult(
        status="NAO_ENCONTRADO",
        query_value=_normalize_query_value(q_for, query_value),
        q_for=q_for,
        erro="API do AngelLira ainda nao retornou registros para a consulta.",
    )

    while True:
        ultimo_resultado = consultar_status_relatorio(query_value, q_for)
        if ultimo_resultado.status in {"CONFORME", "ERRO"}:
            return ultimo_resultado

        if time.monotonic() >= deadline:
            return ultimo_resultado

        log_info(
            "Analise AngelLira ainda nao esta pronta para download. "
            f"Aguardando status Conforme para {ultimo_resultado.query_value}..."
        )
        time.sleep(intervalo)


def _format_datetime(value: str) -> str:
    raw_value = str(value or "").strip()
    if not raw_value:
        return "-"
    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
        return parsed.strftime("%d/%m/%Y %H:%M")
    except Exception:
        return raw_value


def _flatten_payload(prefix: str, value) -> Iterable[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            next_prefix = f"{prefix}.{key}" if prefix else str(key)
            yield from _flatten_payload(next_prefix, item)
        return

    if isinstance(value, list):
        if not value:
            return
        if all(not isinstance(item, (dict, list)) for item in value):
            joined = ", ".join(str(item) for item in value if str(item).strip())
            if joined:
                yield f"{prefix}: {joined}"
            return

        for index, item in enumerate(value):
            next_prefix = f"{prefix}[{index}]"
            yield from _flatten_payload(next_prefix, item)
        return

    text = str(value or "").strip()
    if text:
        yield f"{prefix}: {text}"


def _build_report_lines(item: dict, component_label: str, query_value: str, q_for: str) -> list[str]:
    status_description = (
        item.get("status", {}) or {}
    ).get("description", "-")
    driver_name = (
        (item.get("history", {}) or {}).get("driverName")
        or (item.get("driver", {}) or {}).get("name")
        or "-"
    )
    sent_date = _format_datetime(item.get("sentDate", ""))
    limit_date = _format_datetime(item.get("limitDate", ""))

    lines = [
        f"Componente: {component_label}",
        f"Consulta: {query_value}",
        f"Tipo da busca: {q_for}",
        f"Motorista: {driver_name}",
        f"Status: {status_description}",
        f"Data de envio: {sent_date}",
        f"Vigencia: {limit_date}",
        "",
        "Detalhes completos da API:",
    ]

    flattened_lines = list(_flatten_payload("", item))
    lines.extend(flattened_lines[:220])
    return lines


def _wrap_lines(lines: Iterable[str], width: int = 110) -> list[str]:
    wrapped = []
    for line in lines:
        raw_line = str(line or "")
        if not raw_line:
            wrapped.append("")
            continue
        wrapped.extend(textwrap.wrap(raw_line, width=width) or [""])
    return wrapped


def _escape_pdf_text(text: str) -> str:
    return (
        str(text or "")
        .replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
    )


def _build_pdf_bytes(title: str, lines: list[str]) -> bytes:
    wrapped_lines = _wrap_lines(lines, width=112)
    lines_per_page = 45
    line_chunks = [
        wrapped_lines[index:index + lines_per_page]
        for index in range(0, len(wrapped_lines), lines_per_page)
    ] or [[]]

    generated_at = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{' '.join(f'{4 + index * 2} 0 R' for index in range(len(line_chunks)))}] /Count {len(line_chunks)} >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    for index, chunk in enumerate(line_chunks):
        page_obj_num = 4 + index * 2
        content_obj_num = page_obj_num + 1

        page_lines = [
            title,
            f"Gerado em: {generated_at} | Pagina {index + 1}/{len(line_chunks)}",
            "",
            *chunk,
        ]
        escaped_lines = [_escape_pdf_text(line) for line in page_lines]
        content_commands = [
            "BT",
            "/F1 11 Tf",
            "14 TL",
            "50 792 Td",
        ]
        if escaped_lines:
            first_line, *other_lines = escaped_lines
            content_commands.append(f"({first_line}) Tj")
            for line in other_lines:
                content_commands.append("T*")
                content_commands.append(f"({line}) Tj")
        content_commands.append("ET")
        content_stream = "\n".join(content_commands)

        page_obj = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_obj_num} 0 R >>"
        )
        content_obj = (
            f"<< /Length {len(content_stream.encode('utf-8'))} >>\n"
            f"stream\n{content_stream}\nendstream"
        )
        objects.extend([page_obj, content_obj])

    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]

    for obj_num, obj_body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{obj_num} 0 obj\n{obj_body}\nendobj\n".encode("utf-8"))

    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("utf-8"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("utf-8"))

    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF"
        ).encode("utf-8")
    )
    return bytes(output)


def _save_lines_as_pdf(output_path: Path, title: str, lines: list[str]) -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(_build_pdf_bytes(title, lines))
    return output_path


def export_profile_query_to_pdf(
    query_value: str,
    q_for: str,
    component_label: str,
    output_path: str | Path,
) -> RelatorioApiExportResult:
    normalized_value = _normalize_query_value(q_for, query_value)
    try:
        records = query_profile_records(normalized_value, q_for)
        if not records:
            return RelatorioApiExportResult(
                status="NAO_ENCONTRADO",
                query_value=normalized_value,
                q_for=q_for,
                erro="API do AngelLira nao retornou registros para a consulta.",
            )

        selected_item = records[0]
        status_description = _status_description_from_item(selected_item)
        if not _status_is_conforme(status_description):
            return RelatorioApiExportResult(
                status="AGUARDANDO_STATUS",
                query_value=normalized_value,
                q_for=q_for,
                item=selected_item,
                erro=(
                    "Registro localizado, mas a analise ainda nao ficou Conforme. "
                    f"Status atual: {status_description or '-'}"
                ),
            )

        title = f"Relatorio AngelLira - {component_label}"
        lines = _build_report_lines(selected_item, component_label, normalized_value, q_for)
        pdf_path = _save_lines_as_pdf(Path(output_path), title, lines)
        log_info(
            f"PDF do relatorio via API gerado para {component_label}: {pdf_path}"
        )
        return RelatorioApiExportResult(
            status="EXPORTADO",
            query_value=normalized_value,
            q_for=q_for,
            output_path=str(pdf_path),
            item=selected_item,
        )
    except Exception as exc:
        return RelatorioApiExportResult(
            status="ERRO",
            query_value=normalized_value,
            q_for=q_for,
            erro=str(exc),
        )
