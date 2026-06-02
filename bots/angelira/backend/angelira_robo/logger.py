"""Logger interno do pacote angelira_robo.

Drop-in replacement do shared/logger.py do projeto original. Mantem as
mesmas assinaturas (log_info/log_erro/log_alerta) usadas em browser.py,
login.py e form_helpers.py — assim a copia desses arquivos roda sem
alteracao no corpo, so trocando o import.

Mantem-se enxuto: usa logging stdlib, sem hub HTTP, sem JSONL estruturado,
sem execution_context. Quem quiser observabilidade plugue em logging.
"""

from __future__ import annotations

import logging

_LOGGER = logging.getLogger("angelira_robo")
if not _LOGGER.handlers:
    _LOGGER.setLevel(logging.INFO)
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s | %(levelname)s | angelira_robo | %(message)s"))
    _LOGGER.addHandler(_handler)
    _LOGGER.propagate = False


def log_info(mensagem) -> None:
    _LOGGER.info(str(mensagem or ""))


def log_erro(mensagem) -> None:
    _LOGGER.error(str(mensagem or ""))


def log_alerta(mensagem) -> None:
    _LOGGER.warning(str(mensagem or ""))
