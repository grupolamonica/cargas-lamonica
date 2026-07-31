"""Setup dos testes do coletor Nestlé (bots/galileu).

Roda sem dependências de runtime: `supabase` (postgrest) é stubbado quando não está
instalado, porque os testes injetam um cliente FAKE — nada aqui toca rede ou banco.
"""

import sys
import types
from pathlib import Path

_RAIZ = Path(__file__).resolve().parents[1]
if str(_RAIZ) not in sys.path:
    sys.path.insert(0, str(_RAIZ))

try:  # pragma: no cover - depende do ambiente
    import supabase  # noqa: F401
except Exception:  # pragma: no cover
    _stub = types.ModuleType("supabase")

    class Client:  # noqa: D401 - só o símbolo importado por supabase_client.py
        pass

    def create_client(*_a, **_k):
        raise RuntimeError("create_client não deve ser chamado nos testes (use o cliente fake)")

    _stub.Client = Client
    _stub.create_client = create_client
    sys.modules["supabase"] = _stub

try:  # pragma: no cover
    import dotenv  # noqa: F401
except Exception:  # pragma: no cover
    _stub_dotenv = types.ModuleType("dotenv")
    _stub_dotenv.load_dotenv = lambda *_a, **_k: False
    sys.modules["dotenv"] = _stub_dotenv

try:  # pragma: no cover
    import requests  # noqa: F401
except Exception:  # pragma: no cover
    _stub_requests = types.ModuleType("requests")
    _stub_requests.post = lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("sem rede nos testes"))
    sys.modules["requests"] = _stub_requests
