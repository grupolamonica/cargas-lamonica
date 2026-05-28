"""Credenciais e sessao autenticada da API AngelLira via .env.

Le ANGELIRA_API_USERNAME / ANGELIRA_API_PASSWORD / ANGELIRA_EMPRESA_ID do .env.
Mantem aliases historicos (ANGELIRA_USERNAME / ANGELIRA_USER / ANGELIRA_PASSWORD)
pra compatibilidade.

Fluxo de auth (descoberto via reverse engineering do bundle do portal):
    POST {AUTH_BASE}/auth         {login, pass, lang}     -> set-cookie sessao
    POST {AUTH_BASE}/auth/grant   {company, user marker}  -> redirect com JWT na URL

`criar_sessao_api()` retorna uma `requests.Session` ja com header
`Authorization: Bearer <jwt>`.
"""

from __future__ import annotations

import os


def _first_env(*nomes: str) -> str:
    for nome in nomes:
        valor = (os.getenv(nome) or "").strip()
        if valor:
            return valor
    return ""


def get_username() -> str:
    valor = _first_env(
        "ANGELIRA_API_USERNAME",
        "ANGELIRA_USERNAME",
        "ANGELIRA_USER",
    )
    if not valor:
        raise RuntimeError(
            "Credencial do AngelLira ausente. Configure ANGELIRA_API_USERNAME no .env."
        )
    return valor


def get_password() -> str:
    valor = _first_env(
        "ANGELIRA_API_PASSWORD",
        "ANGELIRA_PASSWORD",
        "ANGELIRA_PASS",
    )
    if not valor:
        raise RuntimeError(
            "Senha do AngelLira ausente. Configure ANGELIRA_API_PASSWORD no .env."
        )
    return valor


def get_empresa_id() -> int:
    """ID numerico da empresa logada na Angellira (usado no /auth/grant).

    Default mantem 876943 (GRIFFI) por compatibilidade historica. Se voce
    rodar para outra empresa, basta setar ANGELIRA_EMPRESA_ID no .env.
    """
    raw = (os.getenv("ANGELIRA_EMPRESA_ID") or "").strip()
    if not raw:
        return 876943
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(
            f"ANGELIRA_EMPRESA_ID invalido no .env: {raw!r}"
        ) from exc


def is_available() -> tuple[bool, str]:
    """Indica se o servico esta configurado pra ser usado.

    Retorna (disponivel, motivo). Usado pelo /api/status.
    """
    if not _first_env("ANGELIRA_API_USERNAME", "ANGELIRA_USERNAME", "ANGELIRA_USER"):
        return False, "ANGELIRA_API_USERNAME nao configurado no .env"
    if not _first_env("ANGELIRA_API_PASSWORD", "ANGELIRA_PASSWORD", "ANGELIRA_PASS"):
        return False, "ANGELIRA_API_PASSWORD nao configurado no .env"
    try:
        get_empresa_id()
    except RuntimeError as exc:
        return False, str(exc)
    return True, ""


def get_login_url() -> str:
    return (os.getenv("ANGELIRA_AUTH_BASE") or "https://auth.angellira.com.br").rstrip("/")


_AUTH_BASE_DEFAULT = "https://auth.angellira.com.br"


def _auth_base() -> str:
    return (os.getenv("ANGELIRA_AUTH_BASE") or _AUTH_BASE_DEFAULT).rstrip("/")


def criar_sessao_api(timeout: float = 30.0):
    """Faz login na Angellira e devolve uma `requests.Session` com Bearer JWT.

    Raise RuntimeError se credenciais ausentes, auth/grant falharem ou JWT
    nao for extraivel.
    """
    import requests

    usuario = get_username()
    senha = get_password()
    empresa_id = get_empresa_id()
    base = _auth_base()

    sessao = requests.Session()
    sessao.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Accept": "application/json, text/plain, */*",
    })

    resp = sessao.post(
        f"{base}/auth",
        json={"login": usuario, "pass": senha, "lang": "pt-br"},
        headers={"Content-Type": "application/json"},
        timeout=timeout,
    )
    if resp.status_code != 200:
        snippet = (resp.text or "")[:200].replace("\n", " ")
        raise RuntimeError(f"Login Angellira falhou: HTTP {resp.status_code} {snippet}")

    resp_grant = sessao.post(
        f"{base}/auth/grant",
        data={"company": str(empresa_id), "user": '{"userName":"","userId":-1}'},
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": base,
            "Referer": f"{base}/grant?client=Angellira&scope=&company={empresa_id}",
        },
        timeout=timeout,
        allow_redirects=True,
    )

    jwt = ""
    url_final = resp_grant.url or ""
    if "access_token=" in url_final:
        jwt = url_final.split("access_token=", 1)[1].split("&", 1)[0]
    if not jwt:
        try:
            jwt = (resp_grant.json() or {}).get("token") or ""
        except Exception:
            jwt = ""
    if not jwt:
        raise RuntimeError(
            f"Grant Angellira retornou sem JWT (HTTP {resp_grant.status_code}, url={url_final})"
        )

    sessao.headers["Authorization"] = f"Bearer {jwt}"
    return sessao
