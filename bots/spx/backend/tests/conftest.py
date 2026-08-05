"""Setup dos testes do bot SPX: poe backend/ no sys.path para importar
`spx_robo` sem instalar o pacote. `spx_robo.datas` e puro (so datetime), entao
nao ha dependencia de runtime a stubbar. Espelha bots/galileu/tests/conftest.py.
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
