"""Entrypoint unificado: dev (python run.py) + producao frozen (PyInstaller).

PyInstaller nao lida bem com `uvicorn.run("main:app", ...)` via string import
(o import path muda quando frozen). Este wrapper importa `app` diretamente,
e ajusta sys.path pra achar os modulos do backend/ tanto em dev quanto no
bundle.

Uso:
  - Dev:    python run.py
  - Build:  pyinstaller run.spec   (gera dist/InfosimplesDemo.exe)
  - Prod:   duplo-clique no .exe gerado
"""
from __future__ import annotations

import os
import sys
import threading
import webbrowser
from pathlib import Path


def _setup_sys_path() -> None:
    """Garante que `backend/` esteja no sys.path em dev e frozen.

    Dev: backend/ ao lado de run.py.
    Frozen: PyInstaller extrai tudo pra sys._MEIPASS/backend/ (via --add-data).
    """
    if getattr(sys, "frozen", False):
        root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        root = Path(__file__).resolve().parent
    backend = root / "backend"
    if backend.is_dir() and str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


_setup_sys_path()

# Os imports abaixo DEPENDEM do sys.path ter sido ajustado.
# Em frozen, config.py ja le .env da pasta do .exe (ver config.BASE_DIR).
from main import app  # noqa: E402  (import depende de _setup_sys_path)


def _abrir_navegador(url: str, delay_segundos: float = 1.5) -> None:
    """Abre o navegador no URL do servidor depois de um delay.

    Roda em thread separada pra nao bloquear o startup do uvicorn.
    O delay existe pro servidor ja estar aceitando conexoes quando o browser bate.
    """
    def _tick():
        import time
        time.sleep(delay_segundos)
        try:
            webbrowser.open(url)
        except Exception:
            pass
    threading.Thread(target=_tick, daemon=True).start()


def main() -> None:
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8765"))
    url = f"http://{host}:{port}"

    # Abre o navegador so quando rodando como .exe (frozen) ou quando a env
    # ABRIR_NAVEGADOR=1 estiver setada. Em dev, o iniciar.bat ja cuida disso.
    if getattr(sys, "frozen", False) or os.getenv("ABRIR_NAVEGADOR") == "1":
        _abrir_navegador(url)

    # Import tardio pra deixar _setup_sys_path rodar primeiro.
    import uvicorn
    # Passando o objeto app diretamente (nao a string "main:app") evita que
    # o uvicorn tente re-importar o modulo, o que quebra em bundles frozen.
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        # reload=False explicitamente: reload usa watchfiles + re-import, nao
        # funciona dentro de PyInstaller.
        reload=False,
    )


if __name__ == "__main__":
    main()
