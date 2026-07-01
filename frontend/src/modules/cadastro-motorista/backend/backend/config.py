import logging
import os
import sys
from pathlib import Path
from dotenv import load_dotenv


# ── Resolucao de paths: funciona tanto em dev (python main.py) quanto frozen
# (PyInstaller --onedir/--onefile). Quando frozen:
#   - sys.executable aponta pro .exe gerado (diretorio de distribuicao)
#   - sys._MEIPASS aponta pro dir temporario onde os arquivos BUNDLED foram
#     extraidos (read-only, limpo ao sair).
# Regra: recursos editaveis (.env, service_account.json) vivem JUNTO do .exe.
#        recursos read-only (frontend/ embutido, modelos) vem do _MEIPASS.

def _base_dir() -> Path:
    """Diretorio editavel: onde o usuario poe .env e service_account.json.

    Frozen: dir do .exe. Dev: raiz do projeto (teste_API/).
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    # __file__ = backend/config.py -> .parent.parent = raiz do projeto.
    return Path(__file__).resolve().parent.parent


def _bundle_dir() -> Path:
    """Diretorio read-only de recursos embutidos (frontend/ via --add-data).

    Frozen: sys._MEIPASS. Dev: mesma coisa que _base_dir() (tudo no fonte).
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return Path(meipass)
    return _base_dir()


BASE_DIR = _base_dir()
BUNDLE_DIR = _bundle_dir()

# .env e service_account.json sao editaveis -> carrega sempre do BASE_DIR
# (dir do .exe quando frozen). Permite o operador trocar o token/credencial
# sem rebuildar o executavel.
load_dotenv(BASE_DIR / ".env")

INFOSIMPLES_TOKEN = os.getenv("INFOSIMPLES_TOKEN", "")
INFOSIMPLES_CONSULTAS_URL = "https://api.infosimples.com/api/v2/consultas"
INFOSIMPLES_IMAGENS_URL = "https://api.infosimples.com/api/v2/imagens"
TIMEOUT_CONSULTA = 60
TIMEOUT_OCR = 120

# Limite ~10MB base64 (≈ 7.5MB binário). Suficiente para PDFs de fatura em
# alta resolucao (EDP/Embasa/Coelba) e fotos de smartphone. Quando OCR_*_PROVIDER=local,
# imagens muito grandes sao processadas localmente sem custo externo.
MAX_IMAGE_BASE64_BYTES = 10_000_000

# ── Providers de OCR ─────────────────────────────────────────────────────────
# "infosimples" = usa API paga (atual, precisão alta, layouts brasileiros treinados)
# "local"       = usa EasyOCR rodando na própria máquina (grátis, offline)
# Default seguro: infosimples (mantém comportamento existente).
OCR_COMPROVANTE_PROVIDER = os.getenv("OCR_COMPROVANTE_PROVIDER", "infosimples").lower()
OCR_CARTAO_CNPJ_PROVIDER = os.getenv("OCR_CARTAO_CNPJ_PROVIDER", "local").lower()

# CNH e CRLV permanecem SEMPRE no Infosimples — parser deles agrega valor real
# nesses casos (estrutura complexa, campos aninhados, normalização).
# Não criamos toggle para não introduzir regressão na qualidade.

_PROVIDERS_VALIDOS = {"infosimples", "local"}
if OCR_COMPROVANTE_PROVIDER not in _PROVIDERS_VALIDOS:
    logging.warning(
        "OCR_COMPROVANTE_PROVIDER='%s' inválido — usando 'infosimples'.",
        OCR_COMPROVANTE_PROVIDER,
    )
    OCR_COMPROVANTE_PROVIDER = "infosimples"
if OCR_CARTAO_CNPJ_PROVIDER not in _PROVIDERS_VALIDOS:
    logging.warning(
        "OCR_CARTAO_CNPJ_PROVIDER='%s' inválido — usando 'local'.",
        OCR_CARTAO_CNPJ_PROVIDER,
    )
    OCR_CARTAO_CNPJ_PROVIDER = "local"

if not INFOSIMPLES_TOKEN or INFOSIMPLES_TOKEN == "COLE_SEU_TOKEN_AQUI":
    logging.warning(
        "INFOSIMPLES_TOKEN não configurado — consultas via Infosimples falharão. "
        "Edite o arquivo .env com um token válido. "
        "(OCR local continua funcionando se OCR_*_PROVIDER=local.)"
    )
