"""Pytest config: garante que `import backend.gpt4o_vision` funcione.

A pasta ``backend/`` do sidecar não é um pacote instalável; adicionamos
o pai dela ao ``sys.path`` para que os módulos sejam importáveis pelos
testes (``from backend import gpt4o_vision`).
"""

import sys
from pathlib import Path


_HERE = Path(__file__).resolve()
_SIDECAR_ROOT = _HERE.parent.parent  # cadastro-motorista/backend/
sys.path.insert(0, str(_SIDECAR_ROOT))
