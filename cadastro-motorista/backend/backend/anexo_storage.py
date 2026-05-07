"""Persistencia local de anexos do cadastro de motorista.

Os endpoints /api/ocr/* recebem imagem em base64 e (alem de extrair via
OCR) salvam o arquivo no disco numa pasta nomeada com o nome do motorista.
A pasta serve como referencia operacional: o cadastro inteiro fica em
um lugar so, organizado por categoria.

Layout:
    backend/anexos_tmp/
        <nome_motorista_slug>/
            motorista/
                cnh_motorista.<ext>             (original — PDF/JPG enviado)
                cnh_motorista_frente.jpg        (frente recortada pela Infosimples)
                cnh_motorista_verso.jpg         (verso recortado)
                foto_motorista.jpg              (foto 3x4 do portador)
                comprovante_motorista.<ext>
                rg_motorista.<ext>              (opcional)
            veiculo/
                crlv_cavalo.<ext>
                crlv_carreta.<ext>
            proprietario/
                cnh_proprietario.<ext>          (se PF)
                cnh_proprietario_frente.jpg
                cnh_proprietario_verso.jpg
                comprovante_proprietario.<ext>  (se PF)
                rg_proprietario.<ext>           (se PF, opcional)
                cartao_cnpj.<ext>               (se PJ)
                cartao_cnpj_carreta.<ext>       (se PJ + dono carreta diferente)

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
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from config import BASE_DIR


log = logging.getLogger("anexo_storage")

ANEXOS_DIR = (BASE_DIR / "backend" / "anexos_tmp").resolve()
ANEXOS_DIR.mkdir(parents=True, exist_ok=True)

# Tipos aceitos. Allowlist explicita evita que o front sugira tipos que
# o robo nao saiba anexar. Cada tipo e mapeado para uma subpasta semantica
# (motorista/veiculo/proprietario) — facilita auditoria manual e mantem o
# diretorio organizavel mesmo com 100+ cadastros simultaneos.
TIPO_PARA_CATEGORIA = {
    # Motorista
    "cnh_motorista": "motorista",                # documento original (PDF/JPG enviado)
    "cnh_motorista_frente": "motorista",         # frente recortada pela Infosimples
    "cnh_motorista_verso": "motorista",          # verso recortada pela Infosimples
    "foto_motorista": "motorista",               # foto 3x4 do portador (extraida da CNH)
    "rg_motorista": "motorista",
    "comprovante_motorista": "motorista",
    # Veiculo (cavalo + carreta)
    "crlv_cavalo": "veiculo",
    "crlv_carreta": "veiculo",
    # Proprietario (PF ou PJ)
    "cnh_proprietario": "proprietario",
    "cnh_proprietario_frente": "proprietario",
    "cnh_proprietario_verso": "proprietario",
    "rg_proprietario": "proprietario",
    "comprovante_proprietario": "proprietario",
    "cartao_cnpj": "proprietario",
    "cartao_cnpj_carreta": "proprietario",
}
TIPOS_VALIDOS = frozenset(TIPO_PARA_CATEGORIA.keys())

# Limite de tamanho do arquivo decodificado. ~1.5MB — mesmo limite
# usado para a base64 das imagens em config.MAX_IMAGE_BASE64_BYTES.
MAX_FILE_BYTES = 2_000_000

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


def salvar_bytes(tipo: str, payload: bytes, id_cadastro: str) -> AnexoSalvo:
    """Variante de salvar() que recebe bytes ja decodificados.

    Util quando o caller ja tem os bytes em mao (ex.: OCR da Infosimples
    devolve image_base64 que ja vamos decodificar pra outras finalidades).
    """
    tipo_v = _validar_tipo(tipo)
    id_v = _validar_id_cadastro(id_cadastro)

    if len(payload) > MAX_FILE_BYTES:
        raise AnexoError(
            f"arquivo excede {MAX_FILE_BYTES // 1000}KB ({len(payload) // 1000}KB recebidos)"
        )
    if len(payload) == 0:
        raise AnexoError("arquivo vazio")

    categoria = TIPO_PARA_CATEGORIA[tipo_v]
    extensao = _detectar_extensao(payload)
    pasta = ANEXOS_DIR / id_v / categoria
    pasta.mkdir(parents=True, exist_ok=True)
    caminho = pasta / f"{tipo_v}{extensao}"

    if not _path_dentro_do_sandbox(caminho):
        raise AnexoError("path resolvido fora do sandbox de anexos")

    caminho.write_bytes(payload)
    log.info("anexo salvo tipo=%s id=%s bytes=%d path=%s", tipo_v, id_v, len(payload), caminho)
    return AnexoSalvo(tipo=tipo_v, id_cadastro=id_v, path=str(caminho), bytes=len(payload))


def salvar(tipo: str, imagem_base64: str, id_cadastro: str) -> AnexoSalvo:
    """Persiste um anexo em ANEXOS_DIR/<id>/<categoria>/<tipo>.<ext>.

    Categoria deduzida do tipo via TIPO_PARA_CATEGORIA — ex.: cnh_motorista
    cai em motorista/, crlv_cavalo em veiculo/, cartao_cnpj em proprietario/.

    Sobrescreve se ja existir (re-upload pelo operador).
    """
    payload = _decodificar_base64(imagem_base64)
    return salvar_bytes(tipo, payload, id_cadastro)


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


def _slug_motorista(nome: str) -> str:
    """Converte 'Fernando Silva José' -> 'fernando_silva_jose'.

    - Remove acentos via NFKD
    - Mantem apenas [a-z0-9_-]
    - Espacos viram underscore
    - Trunca em 64 chars
    """
    if not nome or not nome.strip():
        raise AnexoError("nome do motorista vazio")
    valor = unicodedata.normalize("NFKD", nome.strip())
    valor = "".join(c for c in valor if not unicodedata.combining(c))
    valor = valor.lower()
    valor = re.sub(r"[\s]+", "_", valor)
    valor = re.sub(r"[^a-z0-9_-]", "", valor)
    valor = re.sub(r"_+", "_", valor).strip("_-")
    valor = valor[:64]
    if not valor:
        raise AnexoError("nome do motorista inválido após sanitização")
    return valor


def renomear_pasta_cadastro(id_velho: str, nome_motorista: str) -> str:
    """Renomeia ANEXOS_DIR/<id_velho>/ para ANEXOS_DIR/<slug>/.

    Se a pasta destino ja existir (outro motorista com mesmo nome ou re-tentativa),
    anexa um sufixo numerico estavel. Se a pasta de origem nao existir (ainda nao
    salvou nenhum anexo), apenas valida e retorna o slug — proximas chamadas a
    salvar() vao criar a pasta correta direto.

    Retorna o novo id_cadastro (slug, com sufixo se aplicavel) que o frontend
    deve passar a usar.
    """
    id_velho_v = _validar_id_cadastro(id_velho)
    slug_base = _slug_motorista(nome_motorista)

    pasta_origem = ANEXOS_DIR / id_velho_v
    if not _path_dentro_do_sandbox(pasta_origem):
        raise AnexoError("id_cadastro fora do sandbox")

    if id_velho_v == slug_base:
        return slug_base  # ja esta no nome certo, nada a fazer

    # Resolve colisao: motorista_silva, motorista_silva_2, motorista_silva_3, ...
    slug = slug_base
    contador = 2
    while (ANEXOS_DIR / slug).exists() and slug != id_velho_v:
        slug = f"{slug_base}_{contador}"
        contador += 1
        if contador > 99:
            raise AnexoError("nao foi possivel resolver colisao de nomes")

    pasta_destino = ANEXOS_DIR / slug
    if not _path_dentro_do_sandbox(pasta_destino):
        raise AnexoError("destino fora do sandbox")

    if pasta_origem.is_dir():
        # shutil.move: fallback automatico pra copy+delete se rename atomico
        # falhar (Windows tipicamente bloqueia rename quando indexer/AV tem
        # handle aberto na pasta).
        shutil.move(str(pasta_origem), str(pasta_destino))
        log.info("pasta renomeada %s -> %s", id_velho_v, slug)
    else:
        log.info("pasta %s nao existe ainda — slug %s reservado", id_velho_v, slug)

    return slug


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
