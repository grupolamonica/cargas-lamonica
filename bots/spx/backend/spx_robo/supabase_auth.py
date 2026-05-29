"""Carregamento de credenciais SPX a partir da tabela `aspx_credentials` no Supabase.

A renovação de cookies é responsabilidade do container `aspx-renewal` (já
existente no docker-compose), que roda Playwright a cada 4 dias e atualiza
`cookies_json` + `cookies_expires_at` no Supabase. Este sidecar SPX apenas
**consome** os cookies — não renova.

Para uso local/dev, mantém fallback pro arquivo `config/spx_cookies.json`.

DC-111 / Sprint 1 — extensão SPX (2026-05-29).
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
      - cookies_expires_at venceu → operador precisa renovar via aspx-renewal
        (container Playwright separado).
    """
    row = fetch_aspx_credentials(timeout=timeout)
    cookies_json = row.get("cookies_json") or {}
    expires_at = row.get("cookies_expires_at")
    device_id = (row.get("device_id") or "").strip()

    if not cookies_json:
        raise SupabaseAuthError(
            "aspx_credentials.cookies_json vazio. Rode o container aspx-renewal "
            "(ASPX_ALLOW_PLAYWRIGHT_LOGIN=1) pra capturar cookies do portal SPX."
        )

    if is_expired(expires_at):
        raise SupabaseAuthError(
            f"Cookies SPX expirados em {expires_at}. Rode o container aspx-renewal pra renovar."
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


def invalidar_cookies(timeout: float = 10.0) -> bool:
    """Marca cookies como expirados (PATCH cookies_expires_at = now()).

    Chamado quando o bot detecta sessao invalida no SPX (401/redirect login).
    O container aspx-renewal vai renovar na proxima execucao do loop.
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
            log_info("[supabase_auth] cookies marcados como expirados — aspx-renewal renovará")
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
