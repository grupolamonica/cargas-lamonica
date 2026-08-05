"""Poe backend/ no sys.path p/ importar `angelira_robo` sem instalar o pacote.
`angelira_robo.helpers` e puro (so re/datetime) — sem dependencia de runtime a
stubbar. Espelha bots/galileu/tests/conftest.py e bots/spx/backend/tests.
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))
