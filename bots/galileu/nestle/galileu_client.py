import os
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(dotenv_path=Path(__file__).parent.parent / ".env")

BASE_URL = os.getenv("GALILEU_URL")
_session_token = None


def _headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {_session_token}" if _session_token else "",
    }


def _rpc(service: str, action: str, params: dict, _retry: bool = True) -> dict:
    resp = requests.post(
        f"{BASE_URL}?service={service}.{action}",
        json={"service": service, "action": action, "params": params},
        headers=_headers(),
        timeout=120,
    )
    if resp.status_code == 401 and _retry:
        print("   >> Token expirado — re-autenticando...")
        autenticar()
        return _rpc(service, action, params, _retry=False)
    resp.raise_for_status()
    return resp.json()


def autenticar() -> str:
    global _session_token
    user = os.getenv("GALILEU_USER")
    pwd = os.getenv("GALILEU_PASSWORD")
    # Auth não usa Bearer ainda
    resp = requests.post(
        f"{BASE_URL}?service=G2Service.authenticate",
        json={"service": "G2Service", "action": "authenticate", "params": {"username": user, "password": pwd}},
        headers={"Content-Type": "application/json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    payload = data.get("payload") or {}
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    _session_token = payload.get("accessToken") or payload.get("token")
    if not _session_token:
        raise ValueError(f"Token não encontrado: {data}")
    print("   >> Autenticado com sucesso")
    return _session_token


def get_token() -> str:
    global _session_token
    if not _session_token:
        autenticar()
    return _session_token


def _epoch_ms(dt_str: str, fim_do_dia: bool = False) -> str:
    from datetime import datetime
    dt = datetime.strptime(dt_str, "%d/%m/%Y")
    if fim_do_dia:
        dt = dt.replace(hour=23, minute=59, second=59)
    return str(int(dt.timestamp() * 1000))


def definir_periodo_apuracao(dt_inicio: str, dt_fim: str) -> None:
    """Desbloqueia a janela de consulta do Galileo (por padrão limitada aos últimos 3 meses).

    dt_inicio/dt_fim no formato dd/mm/aaaa. Precisa ser chamada antes de listar/filtrar
    por datas fora da janela padrão — o backend do Galileo valida contra esse período.
    """
    get_token()
    _rpc("CommonService", "setPeriodoApuracao", {
        "inicio": _epoch_ms(dt_inicio, fim_do_dia=False),
        "fim":    _epoch_ms(dt_fim, fim_do_dia=True),
    })


# listaStatus: "1"=PENDENTE, "4"=outro status pendente (conforme site)
STATUS_PENDENTE = ["4"]


def _listar_bloco(inicio: int, fim: int, limit: int, offset: int, apenas_pendentes: bool) -> list[dict]:
    get_token()
    filters: dict = {
        "codprogcoleta": "", "codembarque": "", "codcargas": "", "codigo_precarga": "",
        "numciot": "", "route_id": "", "tpveic_codigoexterno": "",
        "dtahrinclde": "", "dtahrinclate": "",
        "dtahrprevatualde": "", "dtahrprevatualate": "",
        "dtahrpreventregade": "", "dtahrpreventregaate": "",
        "dtahraceitede": "", "dtahraceiteate": "",
        "dtahrrecusade": "", "dtahrrecusaate": "",
        "dtahrcanceladode": "", "dtahrcanceladoate": "",
        "dtahrlimiteaceitede": "", "dtahrlimiteaceiteate": "",
        "dtahragendamentode": "", "dtahragendamentoate": "",
        "dtaremessade": "", "dtaremessaate": "",
    }
    if apenas_pendentes:
        filters["listaStatus"] = STATUS_PENDENTE
    params: dict = {"limit": limit, "offset": offset, "filters": filters}

    data = _rpc("ColetaServicePlus", "listarProgramacoes", params)

    if data.get("success") is False:
        msg = str(data)
        if "session" in msg.lower() or "token" in msg.lower() or "auth" in msg.lower():
            autenticar()
            return _listar_bloco(inicio, fim, limit, offset, apenas_pendentes)
        raise ValueError(f"Erro listarProgramacoes: {data}")

    payload = data.get("payload") or {}
    if isinstance(payload, dict):
        return payload.get("lista") or []
    return payload if isinstance(payload, list) else []


def listar_programacoes(limit: int = 200, offset: int = 0, apenas_pendentes: bool = True) -> list[dict]:
    resultados = []
    pagina = 0
    while True:
        off = offset + pagina * limit
        print(f"   >> Página {pagina + 1} (offset={off})")
        bloco = _listar_bloco(0, 0, limit, off, apenas_pendentes)
        resultados.extend(bloco)
        print(f"   >> {len(bloco)} registro(s) | acumulado: {len(resultados)}")
        if len(bloco) < limit:
            break
        pagina += 1
    print(f"   >> Total coletado: {len(resultados)}")
    return resultados


def aceitar_programacao(codprogcoleta: str) -> bool:
    get_token()
    data = _rpc("ColetaServicePlus", "aceitarProgramacao", {"codprogcoleta": codprogcoleta})
    if data.get("success") is False:
        msg = str(data)
        if "session" in msg.lower() or "token" in msg.lower():
            autenticar()
            return aceitar_programacao(codprogcoleta)
    return data.get("success", False)
