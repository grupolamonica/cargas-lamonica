import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

_client: Client | None = None


def get_client() -> Client:
    """Cliente Supabase de DESTINO — o projeto do Cargas Lamônica (onde a tela
    Programação lê nestle_ofertas).

    Prioriza NESTLE_SUPABASE_URL/NESTLE_SUPABASE_SERVICE_ROLE_KEY (explícito p/ o
    coletor) e cai para SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY do backend. service_role
    ignora RLS. Diferença vs o Projeto Galileu original: lá o destino era o Supabase
    próprio da Nestlé; aqui o destino é o banco do Lamônica.
    """
    global _client
    if not _client:
        url = os.getenv("NESTLE_SUPABASE_URL") or os.getenv("SUPABASE_URL")
        key = (
            os.getenv("NESTLE_SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            or os.getenv("SUPABASE_KEY")
        )
        if not url or not key:
            raise RuntimeError(
                "Defina NESTLE_SUPABASE_URL + NESTLE_SUPABASE_SERVICE_ROLE_KEY "
                "(ou SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) para o coletor."
            )
        _client = create_client(url, key)
    return _client


def registrar_log(nivel: str, mensagem: str, detalhes: dict | None = None):
    """Log tolerante: imprime sempre e tenta gravar em nestle_logs. Se a tabela não
    existir no destino (o Lamônica não tem nestle_logs), apenas segue — não derruba
    o ciclo do coletor."""
    print(f"[{nivel}] {mensagem}")
    try:
        get_client().table("nestle_logs").insert({
            "nivel": nivel,
            "mensagem": mensagem,
            "detalhes": detalhes,
        }).execute()
    except Exception as e:
        print(f"  [WARN] log não gravado (nestle_logs ausente no destino?): {e}")
