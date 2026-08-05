"""Poe a raiz do projeto no sys.path p/ importar `shared` sem instalar o pacote.
`shared.cadastro_map` e leve (random/re/datetime) — sem dependencia de runtime.
"""

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
