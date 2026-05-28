"""Entrypoint do sidecar unificada-robo (API-only standalone).

Sobe FastAPI/uvicorn na porta UNIFICADA_PORT (default 8001).
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
    host = os.getenv("UNIFICADA_HOST", "127.0.0.1")
    port = int(os.getenv("UNIFICADA_PORT", "8001"))
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
