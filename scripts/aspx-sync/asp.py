"""Sincroniza motoristas do Agency Portal (ASPx / myagencyservice) para o Supabase.

Fluxo:
  1. Lê credenciais da tabela `public.aspx_credentials` (singleton).
  2. Autentica no portal via Playwright headless (com cache de cookies em disco).
  3. Itera paginação da API `/api/driverservice/agency/br/driver/list`.
  4. Faz UPSERT em `public.aspx_drivers` (cpf, display_name, raw_status,
     last_seen_at, synced_at). CPF é extraído de `staff_data_cpf`.
  5. Remove registros cujo `last_seen_at` ficou desatualizado (> STALE_HOURS)
     — garante que motoristas removidos do portal saiam da validação.

Presença na tabela = "tem ASPx = SIM". O backend de validação de candidaturas
(backend/server/services/driver-validation/aspx-directory.js) consome esta
tabela diretamente via `lookupAspxDriverByCpf(cpf)`.

Executado pelo GitHub Action `.github/workflows/aspx-sync.yml` a cada 1h.

Variáveis de ambiente obrigatórias:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ==============================
# CONFIG
# ==============================
BASE = "https://logistics.myagencyservice.com.br"
API_URL = f"{BASE}/api/driverservice/agency/br/driver/list"

STALE_HOURS = 6  # remove registros que nao aparecem ha > N horas

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorios")


# ==============================
# SUPABASE (via PostgREST)
# ==============================
def _sb_headers(extra: dict | None = None) -> dict:
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def carregar_credenciais_aspx() -> tuple[str, str, str]:
    url = f"{SUPABASE_URL}/rest/v1/aspx_credentials?id=eq.1&select=email,password,device_id"
    response = requests.get(url, headers=_sb_headers(), timeout=15)
    response.raise_for_status()
    rows = response.json()
    if not rows:
        raise SystemExit("Sem credenciais em public.aspx_credentials (id=1)")
    row = rows[0]
    email = row.get("email", "").strip()
    senha = row.get("password", "").strip()
    device_id = (row.get("device_id") or "").strip() or "e17e5dcd53c211d038a0cd1a950702df"
    if not email or not senha:
        raise SystemExit("aspx_credentials sem email/password")
    return email, senha, device_id


def upsert_aspx_drivers(records: list[dict]) -> None:
    if not records:
        return
    url = (
        f"{SUPABASE_URL}/rest/v1/aspx_drivers"
        "?on_conflict=cpf"
    )
    headers = _sb_headers({"Prefer": "resolution=merge-duplicates,return=minimal"})
    # lotes de 500 para nao estourar payload
    batch_size = 500
    for start in range(0, len(records), batch_size):
        batch = records[start : start + batch_size]
        response = requests.post(url, headers=headers, data=json.dumps(batch), timeout=60)
        if not response.ok:
            raise SystemExit(
                f"Upsert aspx_drivers falhou (HTTP {response.status_code}): {response.text[:500]}"
            )


def remover_stale(now_iso: str, horas: int) -> int:
    """Remove registros nao vistos na ultima janela `horas`. Retorna contagem."""
    from urllib.parse import quote

    cutoff = datetime.now(timezone.utc).timestamp() - horas * 3600
    # Sufixo "Z" evita o "+" no ISO ser interpretado como espaco na query string.
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.%f"
    ) + "Z"
    url = (
        f"{SUPABASE_URL}/rest/v1/aspx_drivers"
        f"?last_seen_at=lt.{quote(cutoff_iso, safe='')}"
    )
    headers = _sb_headers({"Prefer": "return=representation"})
    response = requests.delete(url, headers=headers, timeout=30)
    if not response.ok:
        print(f"Aviso: delete stale falhou HTTP {response.status_code}: {response.text[:300]}")
        return 0
    deleted = response.json() if response.text else []
    return len(deleted) if isinstance(deleted, list) else 0


# ==============================
# CACHE DE COOKIES (Supabase)
# ==============================
# Cookies ficam em public.aspx_credentials.cookies_json (JSONB) com TTL em
# cookies_expires_at. Vantagem: qualquer runner (GitHub Action, Vercel, local)
# compartilha a mesma sessao. Quando expira, so quem tiver Playwright local
# renova (nao depende do IP do CI, que o portal bloqueia).

ALLOW_PLAYWRIGHT_LOGIN = os.environ.get("ASPX_ALLOW_PLAYWRIGHT_LOGIN", "").strip() in {"1", "true", "yes"}


def _cookies_do_cache() -> dict | None:
    url = (
        f"{SUPABASE_URL}/rest/v1/aspx_credentials"
        "?id=eq.1&select=cookies_json,cookies_expires_at"
    )
    r = requests.get(url, headers=_sb_headers(), timeout=15)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return None
    row = rows[0]
    cookies = row.get("cookies_json")
    expires = row.get("cookies_expires_at")
    if not cookies or not expires:
        return None
    try:
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
    except ValueError:
        return None
    if exp_dt <= datetime.now(timezone.utc):
        print(f"Cookies no Supabase expiraram em {expires}.")
        return None
    print(f"Cookies carregados do Supabase (validos ate {expires}).")
    return cookies


def _salvar_cookies(cookies: dict) -> None:
    # TTL rolante (~14h): a sessao SSO real do SPX dura ~16h ociosa. O spx-bot
    # (keep-alive) estende a cada ping; este login e' o self-heal quando ela morre.
    ttl_sec = int(os.environ.get("SPX_COOKIE_TTL_SEC") or 14 * 3600)
    expires = datetime.fromtimestamp(time.time() + ttl_sec, tz=timezone.utc).isoformat()
    updated = datetime.now(timezone.utc).isoformat()
    url = f"{SUPABASE_URL}/rest/v1/aspx_credentials?id=eq.1"
    headers = _sb_headers({"Prefer": "return=minimal"})
    body = json.dumps({
        "cookies_json": cookies,
        "cookies_expires_at": expires,
        "cookies_updated_at": updated,
    })
    r = requests.patch(url, headers=headers, data=body, timeout=15)
    if not r.ok:
        print(f"Aviso: nao foi possivel salvar cookies no Supabase ({r.status_code}): {r.text[:300]}")
        return
    print(f"Cookies salvos no Supabase (expiram em {expires}).")


def _invalidar_cache() -> None:
    """Marca cookies como expirados no Supabase apos 401 definitivo."""
    url = f"{SUPABASE_URL}/rest/v1/aspx_credentials?id=eq.1"
    headers = _sb_headers({"Prefer": "return=minimal"})
    body = json.dumps({"cookies_expires_at": datetime.now(timezone.utc).isoformat()})
    try:
        requests.patch(url, headers=headers, data=body, timeout=15)
    except requests.RequestException:
        pass


# ==============================
# LOGIN VIA PLAYWRIGHT (headless, na VPS)
# ==============================
# IMPORTANTE (2026-06-26): o login headless FUNCIONA na VPS — nao ha captcha
# bloqueando no IP do servidor. O codigo antigo falhava por SELETOR ERRADO
# (input[type=email] + Enter, indo pra /#/workforce/...). Os seletores reais do
# SSO sao placeholder "Email"/"Password" + botao "Log In", partindo da raiz do
# portal. Usamos um PERFIL PERSISTENTE (volume) = "dispositivo confiavel", o que
# reduz risco de captcha em re-logins.
PORTAL_URL = f"{BASE}/"

# Cookies que so aparecem APOS login (os SPC_* aparecem anonimos — nao contam).
_AUTH_PREFIXES = (
    "fms_user_skey", "fms_user_id", "spx_uk", "spx_uid", "spx_st",
    "spx_cid", "SC_SESSION", "scfe_",
)


def _profile_dir() -> str:
    return os.environ.get("SPX_PW_PROFILE_DIR") or "/data/pw_profile"


def _is_authenticated(cookies: list) -> bool:
    names = {c.get("name") for c in cookies if "myagencyservice" in (c.get("domain") or "")}
    return any(n and n.startswith(_AUTH_PREFIXES) for n in names)


def _login_playwright(email: str, senha: str, device_id: str) -> dict:
    """Login/refresh headless da sessao SPX via Playwright (perfil persistente).

    Revisita o portal no perfil dedicado; se a sessao expirou ou caiu no SSO,
    preenche o form (placeholder Email/Password + botao 'Log In') e re-loga.
    Grava os cookies no Supabase. Levanta SystemExit se Playwright desabilitado
    ou se nao autenticar apos retries.
    """
    if not ALLOW_PLAYWRIGHT_LOGIN:
        raise SystemExit(
            "FALHA: cookies expirados e Playwright desabilitado (ASPX_ALLOW_PLAYWRIGHT_LOGIN=0)."
        )

    from playwright.sync_api import sync_playwright

    pdir = _profile_dir()
    os.makedirs(pdir, exist_ok=True)
    # --no-sandbox/--disable-setuid-sandbox: Chromium recusa rodar como root com
    # sandbox. --disable-dev-shm-usage: /dev/shm de 64MB do Docker crasha o Chromium.
    launch_args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]

    last_err: Exception | None = None
    for attempt in range(1, 3):
        try:
            with sync_playwright() as p:
                ctx = p.chromium.launch_persistent_context(pdir, headless=True, args=launch_args)
                try:
                    page = ctx.pages[0] if ctx.pages else ctx.new_page()
                    try:
                        page.goto(PORTAL_URL, wait_until="domcontentloaded", timeout=60000)
                    except Exception as exc:  # noqa: BLE001 — segue com o estado atual
                        print(f"[login] navegacao parcial: {exc}", file=sys.stderr)
                    page.wait_for_timeout(3000)

                    if ("accounts.myagencyservice.com.br" in page.url) or ("/login" in page.url) or not _is_authenticated(ctx.cookies()):
                        page.get_by_placeholder("Email").fill(email, timeout=15000)
                        page.get_by_placeholder("Password").fill(senha, timeout=15000)
                        page.get_by_role("button", name="Log In").click(timeout=15000)
                        deadline = time.time() + 45
                        while time.time() < deadline:
                            if _is_authenticated(ctx.cookies()) and "accounts.myagencyservice" not in page.url:
                                break
                            time.sleep(2)

                    raw = ctx.cookies()
                finally:
                    ctx.close()

            if not _is_authenticated(raw):
                raise RuntimeError(
                    f"login nao autenticou (sem cookie auth-like). cookies={sorted({c.get('name') for c in raw})[:12]}"
                )
            cookies = {c["name"]: c["value"] for c in raw if "myagencyservice" in (c.get("domain") or "")}
            _salvar_cookies(cookies)
            print(f"Sessao renovada (tentativa {attempt}) - {len(cookies)} cookies salvos.")
            return cookies
        except Exception as exc:  # noqa: BLE001 — relogamos e retentamos
            last_err = exc
            print(f"[login] tentativa {attempt} falhou: {exc}", file=sys.stderr)
            time.sleep(3)

    raise SystemExit(
        f"FALHA: login Playwright falhou apos retries. Ultimo erro: {last_err}"
    )


# ==============================
# SESSÃO / API
# ==============================
def _headers(device_id: str) -> dict:
    return {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        "origin": BASE,
        "referer": f"{BASE}/",
        "device-id": device_id,
        "app": "Agency Portal",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/136.0.0.0 Safari/537.36"
        ),
    }


def obter_sessao(
    email: str, senha: str, device_id: str, *, forcar: bool = False
) -> requests.Session:
    session = requests.Session()
    session.headers.update(_headers(device_id))

    if forcar:
        if not ALLOW_PLAYWRIGHT_LOGIN:
            # Sem Playwright: NAO invalida o cookie compartilhado (derrubaria o
            # spx-bot junto); aguarda renovacao externa.
            raise SystemExit(
                "Cookies SPX expirados/invalidos e Playwright off — aguardando renovacao externa."
            )
        # Com Playwright: re-loga headless e grava no Supabase (sem invalidar antes
        # — o login ja sobrescreve com cookies frescos).
        cookies = _login_playwright(email, senha, device_id)
    else:
        cookies = _cookies_do_cache()
        if cookies is None:
            cookies = _login_playwright(email, senha, device_id)

    session.cookies.update(cookies)
    return session


def extrair_lista(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        if "data" in data:
            if isinstance(data["data"], list):
                return data["data"]
            if isinstance(data["data"], dict) and "list" in data["data"]:
                return data["data"]["list"]
        for chave in ["rows", "result", "items"]:
            if chave in data:
                return data[chave]
    return []


def buscar_motoristas(session: requests.Session, email: str, senha: str, device_id: str) -> list:
    all_drivers: list = []
    page = 1
    retried = False

    while True:
        print(f"Buscando pagina {page}...")
        response = session.post(
            API_URL, json={"pageno": page, "count": 50}, timeout=20
        )

        if response.status_code == 401:
            if retried:
                # Ja renovamos uma vez e ainda deu 401. Nao insiste: aborta.
                print("Erro 401 apos renovacao. Abortando.")
                print(response.text[:300])
                break
            print("Sessao expirada, renovando...")
            session = obter_sessao(email, senha, device_id, forcar=True)
            retried = True
            response = session.post(
                API_URL, json={"pageno": page, "count": 50}, timeout=20
            )

        if response.status_code != 200:
            print(f"Erro na pagina {page}: {response.status_code}")
            print(response.text[:300])
            break

        drivers = extrair_lista(response.json())
        if not drivers:
            print("Fim das paginas.")
            break

        all_drivers.extend(drivers)
        page += 1

    return all_drivers


# ==============================
# TRANSFORM
# ==============================
def _normalize_cpf(value) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def _get_path(obj, path: list[str]):
    cursor = obj
    for key in path:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
    return cursor


def montar_registros(drivers: list, now_iso: str) -> list[dict]:
    vistos: dict[str, dict] = {}
    for driver in drivers:
        cpf = _normalize_cpf(
            _get_path(driver, ["staff_data", "cpf"])
            or driver.get("staff_data_cpf")
        )
        if not cpf:
            continue

        display_name = (
            _get_path(driver, ["staff_data", "staff_name"])
            or driver.get("staff_data_staff_name")
            or driver.get("driver_name")
            or None
        )
        if isinstance(display_name, str):
            display_name = display_name.strip() or None

        raw_status = driver.get("status") or driver.get("sub_status") or None
        if isinstance(raw_status, (int, float)):
            raw_status = str(raw_status)

        # Dedup — o portal pode retornar duplicado para o mesmo CPF.
        vistos[cpf] = {
            "cpf": cpf,
            "display_name": display_name,
            "raw_status": raw_status,
            "last_seen_at": now_iso,
            "synced_at": now_iso,
            "updated_at": now_iso,
        }
    return list(vistos.values())


# ==============================
# MAIN
# ==============================
def main() -> None:
    email, senha, device_id = carregar_credenciais_aspx()
    print(f"Credenciais carregadas para {email}")

    session = obter_sessao(email, senha, device_id)
    drivers = buscar_motoristas(session, email, senha, device_id)
    print(f"Total de motoristas no portal: {len(drivers)}")

    if not drivers:
        # Fail loud: 0 drivers sempre indica bug (cookies faltando, API mudou,
        # credenciais invalidas). Nunca sobrescrever a tabela com vazio.
        raise SystemExit("FALHA: portal retornou 0 motoristas - abortando sync")

    now_iso = datetime.now(timezone.utc).isoformat()
    records = montar_registros(drivers, now_iso)
    print(f"Registros com CPF valido: {len(records)}")

    upsert_aspx_drivers(records)
    print(f"UPSERT em aspx_drivers concluido ({len(records)} linhas)")

    removidos = remover_stale(now_iso, STALE_HOURS)
    print(f"Registros stale removidos (>{STALE_HOURS}h): {removidos}")

    print("Sync ASPx finalizado.")


# ==============================
# RENEW LOOP + SYNC LOOP (servico Docker persistente)
# ==============================
# `--renew-loop`   -> renova cookies (legacy, ainda suportado)
# `--sync-loop`    -> sincroniza motoristas ASPX -> Supabase a cada N min
# `--service-loop` -> roda os dois em um unico loop (recomendado em prod)
_RENEW_CHECK_INTERVAL_SEC = 3600       # verifica a cada 1h
_RENEW_THRESHOLD_SEC = 12 * 3600      # renova se < 12h restantes
_SYNC_INTERVAL_SEC = int(os.environ.get("ASPX_SYNC_INTERVAL_SEC", "3600"))  # default 1h


def _cookies_remaining_seconds() -> float | None:
    """Retorna segundos ate expirar ou None se nao encontrado / expirado."""
    url = (
        f"{SUPABASE_URL}/rest/v1/aspx_credentials"
        "?id=eq.1&select=cookies_expires_at"
    )
    try:
        r = requests.get(url, headers=_sb_headers(), timeout=15)
        r.raise_for_status()
        rows = r.json()
    except requests.RequestException:
        return None
    if not rows:
        return None
    exp_str = rows[0].get("cookies_expires_at")
    if not exp_str:
        return None
    try:
        exp_dt = datetime.fromisoformat(exp_str.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (exp_dt - datetime.now(timezone.utc)).total_seconds()


def renew_loop() -> None:
    """Loop de renovacao de cookies via Playwright headless.

    Iniciado como servico Docker persistente na VPS.
    Verifica a cada 1h; renova quando faltam < 12h para expirar.
    Requer ASPX_ALLOW_PLAYWRIGHT_LOGIN=1.
    """
    if not ALLOW_PLAYWRIGHT_LOGIN:
        raise SystemExit(
            "FALHA: --renew-loop requer ASPX_ALLOW_PLAYWRIGHT_LOGIN=1"
        )

    print(
        f"[renew-loop] Iniciado. "
        f"Verifica a cada {_RENEW_CHECK_INTERVAL_SEC // 3600}h, "
        f"renova se < {_RENEW_THRESHOLD_SEC // 3600}h restantes."
    )

    while True:
        try:
            remaining = _cookies_remaining_seconds()
            needs_renew = remaining is None or remaining < _RENEW_THRESHOLD_SEC

            if needs_renew:
                if remaining is None:
                    print("[renew-loop] Cookie expirado ou ausente — renovando...")
                else:
                    print(f"[renew-loop] Cookie expira em {int(remaining // 3600)}h — renovando...")

                email, senha, device_id = carregar_credenciais_aspx()
                new_cookies = _login_playwright(email, senha, device_id)
                _salvar_cookies(new_cookies)
                print("[renew-loop] Cookie renovado com sucesso.")
            else:
                print(f"[renew-loop] Cookie valido por mais {int(remaining // 3600)}h — nada a fazer.")

        except SystemExit as exc:
            print(f"[renew-loop] Erro fatal: {exc}", file=sys.stderr)
        except Exception as exc:
            print(f"[renew-loop] Erro inesperado: {exc}", file=sys.stderr)

        print(f"[renew-loop] Proxima verificacao em {_RENEW_CHECK_INTERVAL_SEC // 3600}h.")
        time.sleep(_RENEW_CHECK_INTERVAL_SEC)


def sync_loop() -> None:
    """Loop persistente do sync ASPX -> Supabase aspx_drivers.

    Roda main() a cada ASPX_SYNC_INTERVAL_SEC (default 1h). Erros isolados nao
    derrubam o loop. Compativel com cookie persistido pelo renew_loop.

    Originalmente isso seria um GitHub Action externo (workflows/aspx-sync.yml),
    mas o portal ASPX bloqueia IPs de runners. Roda no container persistente
    da VPS pra manter aspx_drivers atualizado.
    """
    print(
        f"[sync-loop] Iniciado. Sincroniza a cada {_SYNC_INTERVAL_SEC // 60} min."
    )
    while True:
        try:
            main()
        except SystemExit as exc:
            print(f"[sync-loop] Sync abortado: {exc}", file=sys.stderr)
        except Exception as exc:
            print(f"[sync-loop] Erro inesperado: {exc}", file=sys.stderr)

        print(f"[sync-loop] Proxima sync em {_SYNC_INTERVAL_SEC // 60} min.")
        time.sleep(_SYNC_INTERVAL_SEC)


def service_loop() -> None:
    """Combina renew + sync no mesmo processo.

    Em prod, este e o CMD do container aspx-renewal. Faz tres coisas a cada
    intervalo curto (default 1h):
      1. Garante cookies validos (Playwright login se < 12h restantes)
      2. Roda main() — UPSERT em aspx_drivers
      3. Sleep ate proxima iteracao

    Se cookies expirados E ASPX_ALLOW_PLAYWRIGHT_LOGIN=0 -> aborta sync da
    iteracao (mas nao morre o loop). Se sync falhar, continua tentando.
    """
    if not ALLOW_PLAYWRIGHT_LOGIN:
        print(
            "[service-loop] Aviso: ASPX_ALLOW_PLAYWRIGHT_LOGIN=0 — login via "
            "Playwright bloqueado. Loop continua, mas sync vai falhar se "
            "cookies expirarem.",
            file=sys.stderr,
        )

    print(
        f"[service-loop] Iniciado. Loop a cada {_SYNC_INTERVAL_SEC // 60} min "
        f"(renew threshold: {_RENEW_THRESHOLD_SEC // 3600}h)."
    )

    while True:
        # 1) Garante cookies validos antes da sync.
        #    Com Playwright (ALLOW=1, default em prod): SELF-HEAL — se o cookie
        #    expirou/vai expirar, faz login headless (perfil persistente) e grava
        #    no Supabase. O spx-bot (keep-alive) mantem a sessao viva entre logins,
        #    entao este caminho so dispara quando ela morre de vez. Sem Playwright,
        #    apenas consome e aguarda renovacao externa.
        try:
            remaining = _cookies_remaining_seconds()
            if ALLOW_PLAYWRIGHT_LOGIN and (remaining is None or remaining < _RENEW_THRESHOLD_SEC):
                msg = (
                    "expirado/ausente"
                    if remaining is None
                    else f"expira em {int(remaining // 3600)}h"
                )
                print(f"[service-loop] Cookie {msg} — renovando via login headless...")
                email, senha, device_id = carregar_credenciais_aspx()
                _login_playwright(email, senha, device_id)
                print("[service-loop] Cookie renovado.")
            elif remaining is None or remaining <= 0:
                print(
                    "[service-loop] Cookie expirado/ausente e Playwright off — "
                    "aguardando renovacao externa. Pulando sync desta iteracao.",
                    file=sys.stderr,
                )
                time.sleep(_SYNC_INTERVAL_SEC)
                continue
            else:
                print(
                    f"[service-loop] Cookie valido por mais {int(remaining // 3600)}h."
                )
        except SystemExit as exc:
            print(f"[service-loop] Erro renovando cookie: {exc}", file=sys.stderr)
            time.sleep(_SYNC_INTERVAL_SEC)
            continue
        except Exception as exc:
            print(f"[service-loop] Erro renovando cookie: {exc}", file=sys.stderr)
            time.sleep(_SYNC_INTERVAL_SEC)
            continue

        # 2) Roda o sync
        try:
            main()
        except SystemExit as exc:
            print(f"[service-loop] Sync abortado: {exc}", file=sys.stderr)
        except Exception as exc:
            print(f"[service-loop] Erro inesperado no sync: {exc}", file=sys.stderr)

        # 3) Sleep ate proxima
        print(f"[service-loop] Proxima iteracao em {_SYNC_INTERVAL_SEC // 60} min.")
        time.sleep(_SYNC_INTERVAL_SEC)


if __name__ == "__main__":
    if "--service-loop" in sys.argv:
        service_loop()
    elif "--sync-loop" in sys.argv:
        sync_loop()
    elif "--renew-loop" in sys.argv:
        renew_loop()
    else:
        main()
