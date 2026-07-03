# -*- coding: utf-8 -*-
"""brasilrisk_robo — cliente do BRSystem2 / Brasil Risk (gerenciamento de risco).

Uso rapido:
    from brasilrisk_robo.client import BRSystemClient
    from brasilrisk_robo import motorista as M

    c = BRSystemClient()
    c.login(usuario, senha)
    M.buscar_cep(c, "01310100")
"""

from . import constants  # noqa: F401
from .client import BRSystemClient, BRSystemErro, SessaoExpirada  # noqa: F401

__all__ = ["BRSystemClient", "BRSystemErro", "SessaoExpirada", "constants"]
