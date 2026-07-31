"""
Logger minimo e autocontido para o Gerador Mock AngelLira.

Sem dependencias externas (nao posta em hub, nao usa execution_context).
Expoe a mesma interface que a camada de render espera: log_info / log_alerta.
"""

from __future__ import annotations

from datetime import datetime


def _stamp() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log_info(mensagem) -> None:
    print(f"[{_stamp()}] INFO  | {mensagem}")


def log_alerta(mensagem) -> None:
    print(f"[{_stamp()}] WARN  | {mensagem}")


def log_erro(mensagem) -> None:
    print(f"[{_stamp()}] ERROR | {mensagem}")
