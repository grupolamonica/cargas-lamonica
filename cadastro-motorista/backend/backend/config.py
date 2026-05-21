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


# ── GPT-4o Vision (Fase 1 da migração OCR — 2026-05-21) ─────────────────────
# Cliente OpenAI Vision API usado como:
#   - Fallback para CNH/CRLV quando Infosimples retornar code != 200 (Fase 2)
#   - Provider primário para cartão CNPJ, RNTRC, comprovante residência e
#     selfie c/ CNH (endpoint novo) — vide ocr_router.route().
# Token vem SO via env var OPENAI_API_KEY — nunca em código/repo/log/commit.
# Default GPT4O_VISION_MODEL="gpt-4o" (modelo geral, suporta vision em alta
# resolução). Trocar para "gpt-4o-mini" reduz custo ~10x mas perde acurácia
# em CNH/CRLV brasileiros.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
GPT4O_VISION_MODEL = os.getenv("GPT4O_VISION_MODEL", "gpt-4o").strip()


def _env_int(name: str, default: int) -> int:
    """Lê env var como int com fallback silencioso pro default."""
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logging.warning("%s='%s' não é int — usando default %s", name, raw, default)
        return default


def _env_float(name: str, default: float) -> float:
    """Lê env var como float com fallback silencioso pro default."""
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        logging.warning("%s='%s' não é float — usando default %s", name, raw, default)
        return default


GPT4O_VISION_TIMEOUT_SECONDS = _env_int("GPT4O_VISION_TIMEOUT_SECONDS", 30)
GPT4O_VISION_MAX_RETRIES = _env_int("GPT4O_VISION_MAX_RETRIES", 2)

# Orçamento diário em USD para chamadas Vision. Quando atingido, envelope
# retorna code=429 ("Limite diário de OCR atingido"). Reset diário UTC.
# Default 25.0 cobre volume previsto (500 cadastros/mês × 6 docs × ~$0.02
# ≈ $60/mês = ~$2/dia, deixando folga 12x para picos/burst).
GPT4O_DAILY_BUDGET_USD = _env_float("GPT4O_DAILY_BUDGET_USD", 25.0)

if not OPENAI_API_KEY:
    logging.info(
        "OPENAI_API_KEY não configurado — GPT-4o Vision indisponível. "
        "Endpoints OCR rodam só com provider primário (Infosimples/local)."
    )


# ── OCR Routing Strategies (Fase 2 da migração OCR) ──────────────────────────
# Cada endpoint OCR tem uma estratégia configurável por env var:
#   "legacy"                          = comportamento atual (Infosimples ou
#                                       EasyOCR local conforme OCR_*_PROVIDER)
#   "infosimples-with-vision-fallback" = tenta Infosimples; se code != 200 ou
#                                        exception, cai pra GPT-4o Vision
#   "vision-only"                     = chama GPT-4o Vision direto
#
# Defaults preservam comportamento atual (=legacy). Ativacao por endpoint
# (rollback granular: setar uma var = "legacy" + restart cadastro-ocr).
#
# Recomendacao por endpoint (pos-validacao da Fase 1):
#   CNH/CRLV: infosimples-with-vision-fallback (validacao federal preserva)
#   cartao_cnpj/rntrc/comprovante: vision-only (EasyOCR substituido)
#   selfie_cnh (novo endpoint Fase 2): vision-only (unico provider)

_VALID_STRATEGIES = frozenset({"legacy", "infosimples-with-vision-fallback", "vision-only"})


def _read_strategy(env_name: str, default: str = "legacy") -> str:
    raw = os.getenv(env_name, default).strip().lower()
    if raw not in _VALID_STRATEGIES:
        logging.warning(
            "%s='%s' invalido (opcoes: %s) — usando default %s",
            env_name, raw, ", ".join(sorted(_VALID_STRATEGIES)), default,
        )
        return default
    return raw


OCR_CNH_STRATEGY = _read_strategy("OCR_CNH_STRATEGY")
OCR_CRLV_STRATEGY = _read_strategy("OCR_CRLV_STRATEGY")
OCR_CARTAO_CNPJ_STRATEGY = _read_strategy("OCR_CARTAO_CNPJ_STRATEGY")
OCR_RNTRC_STRATEGY = _read_strategy("OCR_RNTRC_STRATEGY")
OCR_COMPROVANTE_STRATEGY = _read_strategy("OCR_COMPROVANTE_STRATEGY")
# Selfie eh novo endpoint Fase 2 — default vision-only ja que nao tem fallback.
OCR_SELFIE_CNH_STRATEGY = _read_strategy("OCR_SELFIE_CNH_STRATEGY", default="vision-only")
