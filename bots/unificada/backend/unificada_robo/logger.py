"""Logger simples para o sidecar unificada-robo (stdout + arquivo opcional).

Equivalente reduzido do shared/logger.py — sem hub HTTP, sem JSONL estruturado,
sem execution_context. So o necessario pra rastrear erros em PROD.
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_LOGGER_NAME = "unificada_robo"
_INITIALIZED = False


def _setup() -> logging.Logger:
    global _INITIALIZED
    logger = logging.getLogger(_LOGGER_NAME)
    if _INITIALIZED:
        return logger
    _INITIALIZED = True

    level_name = (os.getenv("UNIFICADA_LOG_LEVEL") or "INFO").upper()
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    log_dir = Path(os.getenv("UNIFICADA_LOG_DIR") or "logs")
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            log_dir / "unificada_robo.log",
            maxBytes=5_000_000, backupCount=5, encoding="utf-8",
        )
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except OSError:
        pass

    return logger


def log_info(msg: str) -> None:
    _setup().info(str(msg or ""))


def log_alerta(msg: str) -> None:
    _setup().warning(str(msg or ""))


def log_erro(msg: str) -> None:
    _setup().error(str(msg or ""))
