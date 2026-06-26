"""Credenciais/cookies SPX na tabela `aspx_credentials` do Supabase.

Lê (`carregar_cookies_supabase`) e regrava (`salvar_cookies_supabase`) os
cookies SSO compartilhados (também usados pelo sync ASPX). O SPX **não tem login
programático** (SSO HTTPOnly + captcha + App-Bound Encryption do Chrome), então
a sessão é mantida viva pela ROTAÇÃO de cookies: cada chamada válida ao portal
devolve Set-Cookie renovado, que o `SPXClient` regrava aqui (keep-alive). O
bootstrap/recuperação quando o SSO morre de vez é o cole manual do export do
Cookie-Editor pelo painel do operador.

Para uso local/dev, mantém fallback pro arquivo `config/spx_cookies.json`.

DC-111 / Sprint 1 — extensão SPX (2026-05-29). Keep-alive Supabase (2026-06-26).
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .logger import log_alerta, log_erro, log_info


class SupabaseAuthError(RuntimeError):
    """Falha ao ler/validar credenciais SPX do Supabase."""


def _supabase_url() -> str:
    raw = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    if not raw:
        raise SupabaseAuthError("SUPABASE_URL nao configurado no .env do container spx-bot")
    return raw


def _supabase_key() -> str:
    raw = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("SUPABASE_SECRET_KEY")
        or ""
    )
    if not raw:
        raise SupabaseAuthError("SUPABASE_SERVICE_ROLE_KEY nao configurado no .env do container spx-bot")
    return raw


def _headers() -> dict[str, str]:
    key = _supabase_key()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def fetch_aspx_credentials(timeout: float = 15.0) -> dict[str, Any]:
    """GET aspx_credentials (singleton id=1). Retorna o row completo."""
    url = (
        f"{_supabase_url()}/rest/v1/aspx_credentials"
        "?id=eq.1&select=email,password,device_id,cookies_json,cookies_expires_at,cookies_updated_at"
    )
    response = requests.get(url, headers=_headers(), timeout=timeout)
    if response.status_code != 200:
        raise SupabaseAuthError(
            f"Falha consultando aspx_credentials: HTTP {response.status_code} {response.text[:200]}"
        )
    rows = response.json()
    if not rows:
        raise SupabaseAuthError("aspx_credentials sem row id=1")
    return rows[0]


def is_expired(expires_at: str | None) -> bool:
    """Retorna True se cookies_expires_at já passou."""
    if not expires_at:
        return True
    try:
        dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    return dt <= datetime.now(timezone.utc)


def carregar_cookies_supabase(timeout: float = 15.0) -> tuple[dict[str, str], str]:
    """Retorna (cookies_dict, device_id) lidos do Supabase.

    Lança `SupabaseAuthError` se:
      - SUPABASE_URL/KEY ausentes
      - aspx_credentials inexistente
      - cookies_json vazio
      - cookies_expires_at venceu → a sessão SSO foi encerrada; precisa de novo
        login no SPX (o keep-alive só mantém viva uma sessão já válida).
    """
    row = fetch_aspx_credentials(timeout=timeout)
    cookies_json = row.get("cookies_json") or {}
    expires_at = row.get("cookies_expires_at")
    device_id = (row.get("device_id") or "").strip()

    if not cookies_json:
        raise SupabaseAuthError(
            "Nenhuma sessão SPX configurada (aspx_credentials.cookies_json vazio). "
            "É preciso o login inicial no SPX."
        )

    if is_expired(expires_at):
        raise SupabaseAuthError(
            f"Sessão SPX expirada em {expires_at} — a Shopee encerrou a sessão; "
            f"é preciso novo login no SPX."
        )

    if not isinstance(cookies_json, dict):
        raise SupabaseAuthError(
            f"aspx_credentials.cookies_json em formato inesperado: {type(cookies_json).__name__}. "
            f"Esperado dict {{nome: valor}}."
        )

    # Sanity check: deve haver cookie de auth-like (spx_cid, fms_user_skey, etc)
    auth_like = any(
        n.startswith(("SPC_", "_csrftoken", "SC_SESSION", "scfe_",
                      "fms_user_skey", "fms_user_id", "spx_cid", "spx_uk", "spx_uid"))
        for n in cookies_json.keys()
    )
    if not auth_like:
        log_alerta(
            f"[supabase_auth] cookies carregados ({len(cookies_json)}) mas NENHUM parece ser "
            f"de autenticacao. Sessao pode falhar."
        )
    else:
        log_info(
            f"[supabase_auth] {len(cookies_json)} cookies carregados do Supabase "
            f"(expira em {expires_at}); device_id={device_id[:8]}..."
        )

    return {k: str(v) for k, v in cookies_json.items()}, device_id


# TTL rolante usado quando o cookie auth-like nao traz expiracao propria.
# A sessao SSO do SPX dura ~16h ociosa e e' DESLIZANTE (cada chamada valida a
# estende). O keep-alive do spx-bot pinga a cada ~30min e, a cada ping
# bem-sucedido, regrava cookies_expires_at = now + 14h — mantendo a sessao viva
# sozinha, sem Playwright/login. Se o bot parar, o TTL conta pra tras
# naturalmente e um eventual 401 chama invalidar_cookies() pra corrigir o status.
ROLLING_TTL_SECONDS = int(os.getenv("SPX_COOKIE_ROLLING_TTL_SEC") or 14 * 3600)


def salvar_cookies_supabase(
    cookies: dict[str, str],
    *,
    expires_at: str | None = None,
    timeout: float = 10.0,
) -> bool:
    """Regrava cookies_json no Supabase (PATCH aspx_credentials id=1).

    Chamado pelo SPXClient apos uma chamada valida ao SPX: o servidor rotaciona
    os cookies de sessao (Set-Cookie) e regravamos pra manter a sessao viva sem
    login/Playwright (que e' impossivel nesse portal — SSO HTTPOnly + captcha).

    `expires_at` (ISO 8601) deve refletir a expiracao real do cookie auth-like
    quando conhecida (ex.: cole manual via Cookie-Editor); ausente, usa o TTL
    rolante (ROLLING_TTL_SECONDS). `cookies` no formato {nome: valor}.

    Retorna True se o PATCH foi aceito. Nunca levanta — falha e' logada.
    """
    if not cookies:
        return False
    if not expires_at:
        expires_at = datetime.fromtimestamp(
            time.time() + ROLLING_TTL_SECONDS, tz=timezone.utc
        ).isoformat()
    updated = datetime.now(timezone.utc).isoformat()
    try:
        url = f"{_supabase_url()}/rest/v1/aspx_credentials?id=eq.1"
        body = json.dumps({
            "cookies_json": cookies,
            "cookies_expires_at": expires_at,
            "cookies_updated_at": updated,
        })
        response = requests.patch(
            url,
            headers={**_headers(), "Prefer": "return=minimal"},
            data=body,
            timeout=timeout,
        )
        ok = response.status_code in (200, 204)
        if not ok:
            log_erro(
                f"[supabase_auth] falha ao salvar cookies: "
                f"HTTP {response.status_code} {response.text[:200]}"
            )
        return ok
    except Exception as exc:  # noqa: BLE001
        log_erro(f"[supabase_auth] falha ao salvar cookies: {exc}")
        return False


def invalidar_cookies(timeout: float = 10.0) -> bool:
    """Marca cookies como expirados (PATCH cookies_expires_at = now()).

    Chamado quando o bot detecta sessao invalida no SPX (401/redirect login).
    Reflete o status real (expirado) no painel; a recuperacao e' um novo login
    no SPX (o keep-alive so mantem viva uma sessao ja valida).
    Retorna True se conseguiu invalidar.
    """
    try:
        url = f"{_supabase_url()}/rest/v1/aspx_credentials?id=eq.1"
        body = json.dumps({"cookies_expires_at": datetime.now(timezone.utc).isoformat()})
        response = requests.patch(
            url,
            headers={**_headers(), "Prefer": "return=minimal"},
            data=body,
            timeout=timeout,
        )
        ok = response.status_code in (200, 204)
        if ok:
            log_info("[supabase_auth] cookies marcados como expirados — requer novo login no SPX")
        else:
            log_erro(f"[supabase_auth] falha ao invalidar cookies: HTTP {response.status_code}")
        return ok
    except Exception as exc:  # noqa: BLE001
        log_erro(f"[supabase_auth] falha ao invalidar cookies: {exc}")
        return False


def is_available() -> tuple[bool, str]:
    """Health-check: tenta ler cookies. Retorna (disponivel, motivo)."""
    try:
        cookies, device_id = carregar_cookies_supabase()
        return True, f"{len(cookies)} cookies, device_id={device_id[:8]}..."
    except SupabaseAuthError as exc:
        return False, str(exc)
    except Exception as exc:  # noqa: BLE001
        return False, f"erro inesperado: {type(exc).__name__}: {exc}"


def use_supabase() -> bool:
    """Decide entre Supabase (prod) e arquivo local (dev legacy)."""
    return bool(os.getenv("SUPABASE_URL")) and bool(
        os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_SECRET_KEY")
    )
