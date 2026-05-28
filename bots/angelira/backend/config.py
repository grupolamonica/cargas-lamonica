"""Configuracao do sidecar angelira-robo (API-only).

Le .env do diretorio do sidecar. Sem providers OCR, sem Sheets, sem Selenium.
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv


def _base_dir() -> Path:
    """Diretorio editavel: onde o usuario poe .env.

    Frozen: dir do executavel. Dev: raiz do sidecar (bots/angelira/).
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


BASE_DIR = _base_dir()

load_dotenv(BASE_DIR / ".env")

# Limite ~15MB base64 (≈ 10MB binario) para upload de anexos via /api/anexo/salvar.
MAX_IMAGE_BASE64_BYTES = 15_000_000

# ── API publica da AngelLira ────────────────────────────────────────────────
ANGELIRA_AUTH_BASE = os.getenv("ANGELIRA_AUTH_BASE", "https://auth.angellira.com.br").rstrip("/")
ANGELIRA_API_BASE = os.getenv("ANGELIRA_API_BASE", "https://api.angellira.com.br/profile").rstrip("/")

# ID numerico da empresa logada na Angellira (usado no /auth/grant).
ANGELIRA_EMPRESA_ID = int(os.getenv("ANGELIRA_EMPRESA_ID", "876943"))

# Janela (em dias) para o precheck via API filtrar localmente.
ANGELIRA_PRECHECK_DIAS = int(os.getenv("ANGELIRA_PRECHECK_DIAS", "365"))
