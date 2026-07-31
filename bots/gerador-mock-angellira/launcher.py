"""
launcher.py — ponto de entrada do Gerador Mock AngelLira.

Acha uma porta livre (8002-8099), sobe o Uvicorn e abre o navegador.
"""
from __future__ import annotations

import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

BASE_DIR = Path(getattr(sys, "_MEIPASS", None) or Path(__file__).parent)
sys.path.insert(0, str(BASE_DIR))


def _find_free_port(start: int = 8002, end: int = 8099) -> int:
    for port in range(start, end + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("Nenhuma porta livre encontrada (8002-8099).")


def _open_browser(url: str) -> None:
    time.sleep(1.2)
    try:
        webbrowser.open(url)
    except Exception:
        pass


def main() -> None:
    import uvicorn
    from app import app

    port = _find_free_port()
    url = f"http://127.0.0.1:{port}"
    print(f"Gerador Mock AngelLira -> {url}")

    threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
