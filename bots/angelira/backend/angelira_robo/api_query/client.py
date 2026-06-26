"""Cliente HTTP autenticado para api.angellira.com.br/profile/query.

Substitui o fluxo Selenium de leitura de cadastros — login + GET paginado
com retry + filtros locais. Mantem o padrao de auth do robo (auth.py +
.env), zero credencial hardcoded.

Usado por:
- pipeline_full / pipeline_incremental (extracao em batch para Sheets)
- precheck (busca pontual por CPF / placa antes do cadastro)
"""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Iterable

from .. import auth
from ..helpers import normalizar_placa, extrair_numeros
from ..logger import log_alerta, log_erro, log_info


_API_BASE_DEFAULT = "https://api.angellira.com.br/profile"

# JWT da AngelLira expira (~20 min). Re-logamos proativamente antes disso para
# que owners/drivers/vehicles (que fazem GET/POST direto, sem retry de 401 —
# só o /query renova) não tomem 401 quando o sidecar fica ocioso.
_TOKEN_REFRESH_AFTER_S = 18 * 60


def _api_base() -> str:
    return (os.getenv("ANGELIRA_API_BASE") or _API_BASE_DEFAULT).rstrip("/")


def _fmt_data(d: datetime) -> str:
    """Formata datetime no padrao aceito pela API: 'YYYY-M-D' (sem zero-padding)."""
    return f"{d.year}-{d.month}-{d.day}"


class AngellraAPIClient:
    """Cliente fino sobre requests.Session com retry e paginacao.

    Uso tipico:
        client = AngellraAPIClient()
        client.login()                            # cria sessao + JWT
        cadastros = client.query_all(since, until)
        ou
        cad = client.buscar_por_cpf("12345678909")

    A sessao expira eventualmente (JWT da Angellira). Se um GET retornar
    401, chama `login()` novamente — o caller pode reusar o mesmo client.
    """

    def __init__(self, base_url: str | None = None, default_timeout: float = 15.0):
        # OTIMIZACAO 2026-05-27: default_timeout reduzido de 60s -> 15s.
        # HTTP normal AngelLira respondem <2s. Timeout de 60s mascarava lentidao/falhas.
        # Operacoes que precisam de timeout maior (paginacao profunda em query_paralelo_por_ano,
        # storeQuery em horario de pico) passam timeout explicito via kwarg.
        self.base_url = (base_url or _api_base()).rstrip("/")
        self.default_timeout = default_timeout
        self._session = None  # type: ignore[var-annotated]  -- requests.Session
        self._logged_at = 0.0  # monotonic do último login (refresh proativo)

    # ── Autenticacao ─────────────────────────────────────────────────────

    def login(self):
        """Cria/renova a sessao autenticada via auth.criar_sessao_api()."""
        self._session = auth.criar_sessao_api(timeout=30.0)
        self._logged_at = time.monotonic()
        return self._session

    def _ensure_session(self):
        # Refresh PROATIVO: o JWT expira (~20 min) e owners/drivers/vehicles
        # fazem GET/POST direto, sem retry de 401 (só o /query renova). Sem
        # isso, o sidecar ocioso > 20 min tomava 401 no primeiro lookup
        # (find_by_cnpj) e derrubava o cadastro inteiro → circuit breaker.
        if self._session is None:
            self.login()
        elif (time.monotonic() - self._logged_at) > _TOKEN_REFRESH_AFTER_S:
            log_info(f"[client] sessao AngelLira > {int(_TOKEN_REFRESH_AFTER_S // 60)}min — refresh proativo do token")
            self.login()
        return self._session

    # ── GET com retry ────────────────────────────────────────────────────

    def _fetch_with_retry(self, params: dict, *, max_retries: int = 3, timeout: float | None = None):
        """GET /query com retry exponencial e re-login em 401."""
        sess = self._ensure_session()
        url = f"{self.base_url}/query"
        timeout = timeout or self.default_timeout
        last_err: Exception | None = None
        for tentativa in range(1, max_retries + 1):
            try:
                resp = sess.get(url, params=params, timeout=timeout)
                if resp.status_code == 401 and tentativa < max_retries:
                    log_alerta("[api_query] 401 da API — refazendo login")
                    sess = self.login()
                    continue
                resp.raise_for_status()
                return resp
            except Exception as exc:
                last_err = exc
                if tentativa < max_retries:
                    espera = 2 ** (tentativa - 1)
                    log_alerta(
                        f"[api_query] retry {tentativa}/{max_retries} em {espera}s: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    time.sleep(espera)
        assert last_err is not None
        raise last_err

    # ── Consultas ─────────────────────────────────────────────────────────

    def query(
        self,
        since: datetime,
        until: datetime,
        *,
        page: int = 1,
        per_page: int = 500,
        sort: str = "-sentDate",
        detailed: bool = True,
        timeout: float | None = None,
    ) -> dict:
        """Uma pagina do /profile/query. Retorna o JSON cru."""
        params = {
            "since": _fmt_data(since),
            "until": _fmt_data(until),
            "page": page,
            "perPage": per_page,
            "detailed": "true" if detailed else "false",
            "sort": sort,
        }
        resp = self._fetch_with_retry(params, timeout=timeout)
        return resp.json()

    def query_all(
        self,
        since: datetime,
        until: datetime,
        *,
        per_page: int = 500,
        sort: str = "-sentDate",
        detailed: bool = True,
        timeout: float | None = None,
    ) -> list[dict]:
        """Pagina ate esgotar e devolve a lista plana de cadastros."""
        primeira = self.query(
            since, until, page=1, per_page=per_page,
            sort=sort, detailed=detailed, timeout=timeout,
        )
        total = int(primeira.get("total") or 0)
        registros: list[dict] = list(primeira.get("data") or [])
        if total <= per_page:
            return registros
        paginas = (total + per_page - 1) // per_page
        for page in range(2, paginas + 1):
            rj = self.query(
                since, until, page=page, per_page=per_page,
                sort=sort, detailed=detailed, timeout=timeout,
            )
            registros.extend(rj.get("data") or [])
        return registros

    def query_paralelo_por_ano(
        self,
        since: datetime,
        until: datetime,
        *,
        workers: int = 5,
        per_page: int = 500,
        sort: str = "-sentDate",
        detailed: bool = True,
    ) -> list[dict]:
        """Full load: quebra o range em chunks anuais e paraleliza com 1 sessao
        autenticada por worker (para evitar contensao do JWT).

        Equivalente ao bloco main() do cadastros_api_publica.py linhas 226-258.
        """
        chunks: list[tuple[datetime, datetime]] = []
        for ano in range(since.year, until.year + 1):
            inicio = max(since, datetime(ano, 1, 1))
            fim = min(until, datetime(ano, 12, 31, 23, 59, 59))
            if inicio <= fim:
                chunks.append((inicio, fim))
        if not chunks:
            return []

        log_info(f"[api_query] {len(chunks)} chunk(s) anuais x {workers} worker(s) paralelos")

        registros: list[dict] = []
        seen_ids: set = set()

        def _worker(chunk_since: datetime, chunk_until: datetime) -> list[dict]:
            local = AngellraAPIClient(base_url=self.base_url, default_timeout=self.default_timeout)
            local.login()
            return local.query_all(
                chunk_since, chunk_until,
                per_page=per_page, sort=sort, detailed=detailed,
                timeout=300.0,  # paginacao profunda eh lenta
            )

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futuros = {
                pool.submit(_worker, c_since, c_until): (c_since, c_until)
                for c_since, c_until in chunks
            }
            for fut in as_completed(futuros):
                c_since, c_until = futuros[fut]
                try:
                    lote = fut.result()
                except Exception as exc:
                    log_erro(f"[api_query] chunk {c_since.year} falhou: {exc}")
                    continue
                novos = 0
                for item in lote:
                    rid = item.get("id")
                    if rid is None or rid in seen_ids:
                        continue
                    seen_ids.add(rid)
                    registros.append(item)
                    novos += 1
                log_info(f"[api_query] chunk {c_since.year}: +{novos} (acumulado {len(registros)})")

        return registros

    # ── Buscas pontuais (para o precheck) ─────────────────────────────────
    #
    # Estrategia: pagina UMA pagina por vez, filtra localmente, retorna no
    # primeiro match. Como o servidor ordena por sort=-sentDate (mais recente
    # primeiro), cadastros recentes batem na pagina 1 e a chamada termina em
    # 2-5s ao inves de baixar 90 dias inteiros (~120s).

    def _pages_estimate(self, total: int, per_page: int) -> int:
        if total <= 0:
            return 1
        return (total + per_page - 1) // per_page

    def buscar_por_cpf(
        self,
        cpf: str,
        *,
        dias_atras: int = 365,
        per_page: int = 500,
    ) -> dict | None:
        """Busca o cadastro mais recente do motorista pelo CPF (early-exit por pagina)."""
        cpf_limpo = extrair_numeros(cpf)
        if len(cpf_limpo) < 11:
            return None
        agora = datetime.now()
        since = agora - timedelta(days=dias_atras)
        until = agora + timedelta(days=1)
        from .mapping import extrair_cpf_motorista

        primeira = self.query(since, until, page=1, per_page=per_page)
        total = int(primeira.get("total") or 0)
        paginas = self._pages_estimate(total, per_page)
        for q in (primeira.get("data") or []):
            if extrair_cpf_motorista(q) == cpf_limpo:
                log_info(f"[api_query] match cpf={cpf_limpo} na pagina 1/{paginas}")
                return q

        for page in range(2, paginas + 1):
            rj = self.query(since, until, page=page, per_page=per_page)
            for q in (rj.get("data") or []):
                if extrair_cpf_motorista(q) == cpf_limpo:
                    log_info(f"[api_query] match cpf={cpf_limpo} na pagina {page}/{paginas} (early-exit)")
                    return q
        log_info(f"[api_query] cpf={cpf_limpo} nao encontrado apos {paginas} pagina(s)")
        return None

    def buscar_por_placa(
        self,
        placa: str,
        *,
        dias_atras: int = 365,
        per_page: int = 500,
    ) -> dict | None:
        """Busca o cadastro mais recente do veiculo pela placa (cavalo/carreta) com early-exit."""
        placa_norm = normalizar_placa(placa)
        if not placa_norm:
            return None
        agora = datetime.now()
        since = agora - timedelta(days=dias_atras)
        until = agora + timedelta(days=1)
        from .mapping import extrair_placa_cavalo, extrair_placa_carreta

        def _match(q: dict) -> bool:
            placa_c = normalizar_placa(extrair_placa_cavalo(q))
            placa_r = normalizar_placa(extrair_placa_carreta(q))
            return placa_norm in (placa_c, placa_r)

        primeira = self.query(since, until, page=1, per_page=per_page)
        total = int(primeira.get("total") or 0)
        paginas = self._pages_estimate(total, per_page)
        for q in (primeira.get("data") or []):
            if _match(q):
                log_info(f"[api_query] match placa={placa_norm} na pagina 1/{paginas}")
                return q

        for page in range(2, paginas + 1):
            rj = self.query(since, until, page=page, per_page=per_page)
            for q in (rj.get("data") or []):
                if _match(q):
                    log_info(f"[api_query] match placa={placa_norm} na pagina {page}/{paginas} (early-exit)")
                    return q
        log_info(f"[api_query] placa={placa_norm} nao encontrada apos {paginas} pagina(s)")
        return None


def buscar_por_cpf(cpf: str, *, dias_atras: int = 365, client: AngellraAPIClient | None = None) -> dict | None:
    """Helper top-level: usa um client efemero se nenhum for passado."""
    if client is None:
        client = get_shared_client()
    return client.buscar_por_cpf(cpf, dias_atras=dias_atras)


def buscar_por_placa(placa: str, *, dias_atras: int = 365, client: AngellraAPIClient | None = None) -> dict | None:
    if client is None:
        client = get_shared_client()
    return client.buscar_por_placa(placa, dias_atras=dias_atras)


# ─── Singleton compartilhado (PERFORMANCE 2026-05-26) ────────────────────────
# Antes desse helper, cada chamada de cadastrar_motorista/cadastrar_proprietario
# instanciava um AngellraAPIClient novo + .login() (handshake ~600-1500ms).
# Agora reusamos uma sessao module-level: 1 login por processo, refresh
# automatico em 401 (o _fetch_with_retry ja faz). Thread-safe via lock pra
# nao logar duas vezes em corridas iniciais.
import threading as _threading

_shared_client: AngellraAPIClient | None = None
_shared_client_lock = _threading.Lock()


def get_shared_client(*, force_new: bool = False) -> AngellraAPIClient:
    """Retorna o AngellraAPIClient compartilhado do processo (login lazy)."""
    global _shared_client
    if force_new or _shared_client is None:
        with _shared_client_lock:
            if force_new or _shared_client is None:
                c = AngellraAPIClient()
                c.login()
                _shared_client = c
                log_info("[client] AngellraAPIClient compartilhado criado (login feito)")
    return _shared_client


def reset_shared_client() -> None:
    """Limpa o singleton (proxima get_shared_client refaz o login)."""
    global _shared_client
    with _shared_client_lock:
        _shared_client = None
