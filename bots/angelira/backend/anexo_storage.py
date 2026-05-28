"""Persistencia local de anexos para o robo AngelLira.

Os endpoints /api/ocr/* recebem imagem em base64 e descartam o arquivo
apos extrair. O robo Selenium precisa de um path no disco para anexar
no portal — esse modulo cobre essa lacuna.

Layout:
    backend/angelira_robo/anexos_tmp/
        <id_cadastro>/
            crlv_cavalo.png
            crlv_carreta.png
            cnh_motorista.jpg
            ...

Garantias:
- Sandbox: paths sao sempre resolvidos dentro de ANEXOS_DIR. Nenhuma
  manipulacao de id_cadastro consegue escrever fora dessa pasta (anti
  path traversal).
- Tipos permitidos sao explicitos (allowlist).
- Cleanup: limpar_antigos() apaga pastas com mtime > N horas para
  evitar acumulo. Chamado periodicamente pelo main.py (lifespan).
"""

from __future__ import annotations

import base64
import logging
import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from config import BASE_DIR


log = logging.getLogger("anexo_storage")

ANEXOS_DIR = (BASE_DIR / "backend" / "angelira_robo" / "anexos_tmp").resolve()
ANEXOS_DIR.mkdir(parents=True, exist_ok=True)

# Tipos aceitos. Allowlist explicita evita que o front sugira tipos que
# o robo nao saiba anexar.
TIPOS_VALIDOS = {
    "crlv_cavalo",
    "crlv_carreta",
    "cnh_motorista",
    "rg_motorista",
    "rg_proprietario",
    "cnh_proprietario",
    "cartao_cnpj",
    "cartao_cnpj_carreta",
    "comprovante_motorista",
    "comprovante_proprietario",
    # Tipos usados pelo bot Node em angellira_payload.js (cavalo/carreta_prop_*)
    "cavalo_prop_cnh",
    "carreta_prop_cnh",
    "cavalo_prop_cnpj",
    "carreta_prop_cnpj",
    "cavalo_prop_comp_residencia",
    "carreta_prop_comp_residencia",
    # ANTT proprietario (mapeamento.py)
    "antt_cavalo_prop_cnh",
    "antt_carreta_prop_cnh",
    "antt_cavalo_prop_cnpj",
    "antt_carreta_prop_cnpj",
}

# Limite de tamanho do arquivo decodificado. 10MB — cobre CRLVs em PDF
# de boa qualidade (fotos altas resolucao) sem cortar legitimos.
MAX_FILE_BYTES = 10_000_000

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
    """Aceita 'data:image/png;base64,...' ou base64 puro."""
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
    """Persiste um anexo em ANEXOS_DIR/<id>/<tipo>.<ext>.

    Sobrescreve se ja existir (re-upload pelo operador).
    """
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
        # Defensivo: nao deveria acontecer dada a validacao acima.
        raise AnexoError("path resolvido fora do sandbox de anexos")

    caminho.write_bytes(payload)
    log.info("anexo salvo tipo=%s id=%s bytes=%d path=%s", tipo_v, id_v, len(payload), caminho)

    return AnexoSalvo(tipo=tipo_v, id_cadastro=id_v, path=str(caminho), bytes=len(payload))


def validar_path_para_robo(path: str) -> str:
    """Garante que o path enviado pelo front no /api/robo/* aponta para
    um arquivo existente DENTRO de ANEXOS_DIR. Retorna o path absoluto
    canonico ou levanta AnexoError.
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
