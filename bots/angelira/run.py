"""Entrypoint do sidecar angelira-robo (API-only standalone).

Sobe FastAPI/uvicorn na porta PORT (default 8765).

Variaveis de ambiente lidas do .env ao lado deste arquivo:
   - ANGELIRA_API_USERNAME / ANGELIRA_API_PASSWORD   (obrigatorios)
   - ANGELIRA_EMPRESA_ID (default 876943)
   - ANGELIRA_AUTH_BASE / ANGELIRA_API_BASE (defaults publicos)
   - HOST (default 127.0.0.1), PORT (default 8765)
   - CORS_ORIGINS (csv, default localhost:5010/8765)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _load_env() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    here = Path(__file__).resolve().parent
    env_file = here / ".env"
    if env_file.exists():
        load_dotenv(env_file)


_load_env()


def _setup_sys_path() -> None:
    root = Path(__file__).resolve().parent
    backend = root / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


_setup_sys_path()

from main import app  # noqa: E402


def main() -> None:
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8765"))
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
