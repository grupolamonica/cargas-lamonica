"""Persistencia local de anexos para o robo SPX.

O backend Node baixa os documentos (do bucket Supabase ou do share da producao),
manda em base64 via POST /spx/anexo/salvar, e este modulo grava num path no disco
DENTRO do container do spx-bot. Os flows (flow_motorista + uploads.py) entao leem
esse path e sobem o arquivo (multipart) pro portal SPX.

Espelha bots/angelira/backend/anexo_storage.py (mesma tecnica de ponte
cross-container), com a allowlist de tipos do SPX.

Layout:
    backend/spx_robo/anexos_tmp/
        <id_cadastro>/
            cnh_frente.jpg
            cnh_verso.jpg
            selfie_cnh.jpg
            crlv_cavalo.pdf
            risk_doc.pdf
            ...

Garantias:
- Sandbox: paths sao sempre resolvidos dentro de ANEXOS_DIR. Nenhuma manipulacao
  de id_cadastro consegue escrever fora dessa pasta (anti path traversal).
- Tipos permitidos sao explicitos (allowlist).
- Cleanup: limpar_antigos() apaga pastas com mtime > N horas. Chamado no startup
  (lifespan do main.py).
"""

from __future__ import annotations

import base64
import logging
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path


log = logging.getLogger("spx_anexo_storage")

# backend/anexo_storage.py -> backend/ ; sandbox dentro do pacote spx_robo.
BASE_DIR = Path(__file__).resolve().parent
ANEXOS_DIR = (BASE_DIR / "spx_robo" / "anexos_tmp").resolve()
ANEXOS_DIR.mkdir(parents=True, exist_ok=True)

# Tipos aceitos (allowlist). Mapeiam pros uploads do SPX:
#   cnh_frente/cnh_verso -> upload_license_image (2 chamadas)
#   selfie_cnh           -> upload_driver_photo
#   crlv_cavalo/carreta  -> recognize_vehicle_doc (upload + OCR)
#   risk_doc             -> upload_risk_doc (dossie de gerenciamento de risco)
TIPOS_VALIDOS = {
    "cnh_frente",
    "cnh_verso",
    "selfie_cnh",
    "crlv_cavalo",
    "crlv_carreta",
    "risk_doc",
}

# Risk Doc em PDF de boa qualidade pode passar de alguns MB; 12MB cobre com folga.
MAX_FILE_BYTES = 12_000_000

# TTL padrao para limpeza automatica.
TTL_HORAS = 24

_RE_ID_VALIDO = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


@dataclass
class AnexoSalvo:
    tipo: str
    id_cadastro: str
    path: str
    bytes: int


class AnexoError(ValueError):
    """Erro de validacao ao manipular anexos."""


def _validar_id_cadastro(id_cadastro: str) -> str:
    valor = (id_cadastro or "").strip()
    if not valor:
        raise AnexoError("id_cadastro vazio")
    if not _RE_ID_VALIDO.fullmatch(valor):
        raise AnexoError(
            "id_cadastro invalido — use apenas letras, numeros, '_' e '-' (max 64)"
        )
    return valor


def _validar_tipo(tipo: str) -> str:
    valor = (tipo or "").strip().lower()
    if valor not in TIPOS_VALIDOS:
        raise AnexoError(f"tipo de anexo invalido: '{tipo}'")
    return valor


def _detectar_extensao(payload_bytes: bytes) -> str:
    """Sniffa magic bytes para deduzir extensao. Default: .bin"""
    if len(payload_bytes) < 4:
        return ".bin"
    cabecalho = payload_bytes[:8]
    if cabecalho.startswith(b"\x89PNG"):
        return ".png"
    if cabecalho.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if cabecalho.startswith(b"%PDF"):
        return ".pdf"
    if cabecalho.startswith(b"GIF8"):
        return ".gif"
    return ".bin"


def _decodificar_base64(imagem: str) -> bytes:
    """Aceita 'data:...;base64,...' ou base64 puro."""
    if not imagem:
        raise AnexoError("imagem vazia")
    bruto = imagem.strip()
    if bruto.startswith("data:") and ";base64," in bruto:
        bruto = bruto.split(";base64,", 1)[1]
    try:
        return base64.b64decode(bruto, validate=False)
    except Exception as e:
        raise AnexoError(f"base64 invalido: {e}") from e


def _path_dentro_do_sandbox(path: Path) -> bool:
    try:
        path.resolve().relative_to(ANEXOS_DIR)
        return True
    except (ValueError, OSError):
        return False


def salvar(tipo: str, imagem_base64: str, id_cadastro: str) -> AnexoSalvo:
    """Persiste um anexo em ANEXOS_DIR/<id>/<tipo>.<ext>. Sobrescreve se existir."""
    tipo_v = _validar_tipo(tipo)
    id_v = _validar_id_cadastro(id_cadastro)
    payload = _decodificar_base64(imagem_base64)

    if len(payload) > MAX_FILE_BYTES:
        raise AnexoError(
            f"arquivo excede {MAX_FILE_BYTES // 1000}KB ({len(payload) // 1000}KB recebidos)"
        )
    if len(payload) == 0:
        raise AnexoError("arquivo vazio apos decodificar base64")

    extensao = _detectar_extensao(payload)
    pasta = ANEXOS_DIR / id_v
    pasta.mkdir(parents=True, exist_ok=True)
    caminho = pasta / f"{tipo_v}{extensao}"

    if not _path_dentro_do_sandbox(caminho):
        raise AnexoError("path resolvido fora do sandbox de anexos")

    caminho.write_bytes(payload)
    log.info("anexo salvo tipo=%s id=%s bytes=%d path=%s", tipo_v, id_v, len(payload), caminho)

    return AnexoSalvo(tipo=tipo_v, id_cadastro=id_v, path=str(caminho), bytes=len(payload))


def validar_path_para_robo(path: str) -> str:
    """Garante que o path aponta para um arquivo existente DENTRO de ANEXOS_DIR.
    Retorna o path absoluto canonico ou levanta AnexoError.
    """
    if not path:
        raise AnexoError("path vazio")
    p = Path(path).expanduser()
    if not _path_dentro_do_sandbox(p):
        raise AnexoError(f"path fora do sandbox de anexos: {p}")
    if not p.is_file():
        raise AnexoError(f"arquivo nao existe: {p}")
    return str(p.resolve())


def limpar_cadastro(id_cadastro: str) -> int:
    """Apaga toda a pasta de um id_cadastro. Retorna nro de arquivos removidos."""
    try:
        id_v = _validar_id_cadastro(id_cadastro)
    except AnexoError:
        return 0
    pasta = ANEXOS_DIR / id_v
    if not pasta.is_dir() or not _path_dentro_do_sandbox(pasta):
        return 0
    arquivos = sum(1 for _ in pasta.iterdir() if _.is_file())
    shutil.rmtree(pasta, ignore_errors=True)
    log.info("anexos do cadastro %s removidos (%d arquivos)", id_v, arquivos)
    return arquivos


def limpar_antigos(ttl_horas: int = TTL_HORAS) -> int:
    """Remove pastas com mtime > ttl_horas. Retorna nro de pastas removidas."""
    if not ANEXOS_DIR.is_dir():
        return 0
    limite = time.time() - (ttl_horas * 3600)
    removidas = 0
    for sub in ANEXOS_DIR.iterdir():
        if not sub.is_dir():
            continue
        if not _path_dentro_do_sandbox(sub):
            continue
        try:
            if sub.stat().st_mtime < limite:
                shutil.rmtree(sub, ignore_errors=True)
                removidas += 1
        except Exception:
            continue
    if removidas:
        log.info("limpeza periodica: %d pastas antigas removidas", removidas)
    return removidas
