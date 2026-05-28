"""Uploads multipart de fotos e documentos.

Cada upload retorna um {url, ...} que e usado como referencia no payload do submit.
Os campos do submit (driver_photo, license_img_front, etc) recebem essa URL.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Any

from .client import SPXClient
from .logger import log_info


def _guess_mime(path: Path) -> str:
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def _open_file(path: str | Path) -> tuple[str, bytes, str]:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"Arquivo nao encontrado: {p}")
    return p.name, p.read_bytes(), _guess_mime(p)


def upload_license_image(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/request/upload/image
    Use para front/back da CNH (separadamente, 2 chamadas).
    Retorna {url, ...}
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] license_image {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/request/upload/image",
        files={"file": (name, content, mime)},
    )


def upload_license(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/request/upload/license
    Variante oficial do upload de CNH. Mesma assinatura.
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] license {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/request/upload/license",
        files={"file": (name, content, mime)},
    )


def upload_rg_photo(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/request/upload/rg_photo
    Para fluxo Walker/Biker (transport_type=1).
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] rg_photo {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/request/upload/rg_photo",
        files={"file": (name, content, mime)},
    )


def upload_risk_doc(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/request/upload/risk_doc
    Documento de avaliacao de risco (PDF).
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] risk_doc {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/request/upload/risk_doc",
        files={"file": (name, content, mime)},
    )


def upload_driver_photo(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/driver_photo/upload
    Selfie do motorista.
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] driver_photo {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/driver_photo/upload",
        files={"file": (name, content, mime)},
    )


def recognize_vehicle_doc(client: SPXClient, file_path: str | Path) -> dict:
    """POST /api/driverservice/agency/br/driver/request/vehicle_doc/recognition
    CRLV — upload + OCR automatico. Retorna:
      {
        url, ocr_result (0=ok, 1=invalida, 2=mismatch, ...),
        renavam, vehicle_type, license_plate,
        vehicle_manufacturing_year, vehicle_owner_name,
        vehicle_manufacturer, vehicle_allowed_edit_fields
      }
    """
    name, content, mime = _open_file(file_path)
    log_info(f"[upload] vehicle_doc {name} ({len(content)} bytes)")
    return client.post_multipart(
        "/api/driverservice/agency/br/driver/request/vehicle_doc/recognition",
        files={"file": (name, content, mime)},
    )


def download_url(client: SPXClient, file_path_token: str) -> bytes:
    """GET /api/driverservice/agency/download?file_path={token}
    Baixa um anexo previamente subido (token retornado pelos uploads).
    """
    resp = client.request("GET", "/api/driverservice/agency/download",
                          params={"file_path": file_path_token}, timeout=120.0)
    resp.raise_for_status()
    return resp.content
