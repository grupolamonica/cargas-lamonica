# -*- coding: utf-8 -*-
"""Logger minimo (espelha o padrao dos outros robos: log_info/alerta/erro)."""

from __future__ import annotations

import sys
from datetime import datetime


def _emit(nivel: str, msg: str) -> None:
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {nivel} {msg}", file=sys.stderr)


def log_info(msg: str) -> None:
    _emit("INFO ", msg)


def log_alerta(msg: str) -> None:
    _emit("ALERTA", msg)


def log_erro(msg: str) -> None:
    _emit("ERRO ", msg)
