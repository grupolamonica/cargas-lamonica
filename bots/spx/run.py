"""Entrypoint do sidecar spx-robo (standalone).

Sobe FastAPI/uvicorn na porta SPX_SIDECAR_PORT (default 8766).

Variaveis de ambiente lidas do .env ao lado deste arquivo:
   - SPX_COOKIE_FILE        (default: config/spx_cookies.json)
   - SPX_BASE_URL           (default: https://logistics.myagencyservice.com.br)
   - SPX_DEVICE_ID          (obrigatorio - pegue do localStorage do portal)
   - SPX_VERSION            (obrigatorio - copie header "version" de uma request)
   - SPX_AGENCY_ID          (default: 297)
   - SPX_SIDECAR_HOST       (default: 127.0.0.1)
   - SPX_SIDECAR_PORT       (default: 8766)
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
    host = os.getenv("SPX_SIDECAR_HOST", "127.0.0.1")
    port = int(os.getenv("SPX_SIDECAR_PORT", "8766"))
    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level="info", reload=False)


if __name__ == "__main__":
    main()
