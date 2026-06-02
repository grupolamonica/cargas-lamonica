"""Pacote api_query: chamadas autenticadas para api.angellira.com.br.

Pontos de entrada:

* `AngellraAPIClient`  -- cliente HTTP autenticado (login + grant + GET /profile/query).
* `precheck`           -- verificar_motorista_via_api / verificar_veiculo_via_api.
* `flow_motorista`     -- cadastrar_motorista(payload, anexos, ...).
* `flow_proprietario`  -- cadastrar_proprietario(payload, anexos, tipo, ...).
* `flow_veiculo`       -- cadastrar_veiculo(payload, anexos, sub, owner_id, ...).
"""

from __future__ import annotations

try:
    import config  # noqa: F401  (efeito colateral: load_dotenv em backend/config.py)
except Exception:
    pass

from .client import AngellraAPIClient  # noqa: E402

__all__ = ["AngellraAPIClient"]
