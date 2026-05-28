"""Logger leve, espelhando o padrao do angelira-robo (log_info/log_alerta/log_erro).
Saida em stdout + arquivo rotativo em logs/spx_robo.log
"""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path


_LOGGER_NAME = "spx_robo"
_INITIALIZED = False


def _setup() -> logging.Logger:
    global _INITIALIZED
    logger = logging.getLogger(_LOGGER_NAME)
    if _INITIALIZED:
        return logger
    _INITIALIZED = True

    level_name = (os.getenv("SPX_LOG_LEVEL") or "INFO").upper()
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(sh)

    log_dir = Path(os.getenv("SPX_LOG_DIR") or "logs")
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        fh = RotatingFileHandler(
            log_dir / "spx_robo.log",
            maxBytes=5_000_000, backupCount=5, encoding="utf-8",
        )
        fh.setFormatter(fmt)
        logger.addHandler(fh)
    except OSError:
        pass

    return logger


def log_info(msg: str) -> None:
    _setup().info(msg)


def log_alerta(msg: str) -> None:
    _setup().warning(msg)


def log_erro(msg: str) -> None:
    _setup().error(msg)
