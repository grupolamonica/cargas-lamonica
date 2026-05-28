"""Autenticacao via cookie file persistente.

A API SPX usa cookies HTTPOnly setados via SSO em accounts.myagencyservice.com.br.
Nao ha endpoint programatico de login (bundle do portal nao expoe).

Fluxo:
  1. Operador faz login UMA vez no Chrome
  2. Exporta cookies via extensao (Cookie Editor / EditThisCookie) ou DevTools
  3. Salva em config/spx_cookies.json
  4. Cliente Python carrega via load_cookies()

Formato esperado (Cookie Editor): array de objetos
  [{ name, value, domain, path, expirationDate, httpOnly, secure, sameSite }, ...]

Quando os cookies expirarem (~horas/dias), uma chamada 401/login_redirect
sera detectada e o caller deve renovar manualmente.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .logger import log_alerta, log_erro, log_info


COOKIE_DOMAINS = (
    "logistics.myagencyservice.com.br",
    ".myagencyservice.com.br",
    "myagencyservice.com.br",
    "accounts.myagencyservice.com.br",
)


def _cookie_path() -> Path:
    raw = os.getenv("SPX_COOKIE_FILE") or "config/spx_cookies.json"
    return Path(raw).expanduser().resolve()


def load_cookies(path: Path | str | None = None) -> list[dict[str, Any]]:
    """Le e normaliza o arquivo JSON de cookies. Retorna lista de dicts.

    Aceita os 2 formatos comuns:
      - Cookie Editor / EditThisCookie: lista de objetos
      - Manual: {"cookies": [...]}
    """
    p = Path(path) if path else _cookie_path()
    if not p.exists():
        raise FileNotFoundError(
            f"Cookie file nao encontrado: {p}. "
            f"Exporte cookies do Chrome (extensao Cookie Editor) e salve nesse caminho."
        )
    raw = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(raw, dict) and "cookies" in raw:
        raw = raw["cookies"]
    if not isinstance(raw, list):
        raise ValueError(f"Cookie file invalido (esperado array): {p}")
    return raw


def cookies_to_requests_dict(cookies: list[dict[str, Any]]) -> dict[str, str]:
    """Converte para o dict simples que requests.Session aceita.

    Filtra apenas cookies dos dominios SPX e nao expirados.
    """
    now = time.time()
    out: dict[str, str] = {}
    for c in cookies:
        domain = (c.get("domain") or "").lower().lstrip(".")
        if not any(domain == d.lstrip(".") or domain.endswith(d.lstrip(".")) for d in COOKIE_DOMAINS):
            continue
        # Expiracao (Cookie Editor usa epoch float)
        exp = c.get("expirationDate") or c.get("expires") or 0
        try:
            exp = float(exp)
        except (TypeError, ValueError):
            exp = 0
        if exp and exp > 0 and exp < now:
            log_alerta(f"[auth] cookie '{c.get('name')}' expirado em {exp} — pulando")
            continue
        name = c.get("name")
        value = c.get("value")
        if not name or value is None:
            continue
        out[str(name)] = str(value)
    return out


def cookies_summary(cookies_dict: dict[str, str]) -> dict[str, Any]:
    """Sumario seguro pra log (so nomes + tamanho dos valores)."""
    return {
        "total": len(cookies_dict),
        "names": sorted(cookies_dict.keys()),
        "has_auth_like": any(
            n.startswith(("SPC_", "_csrftoken", "SC_SESSION", "scfe_",
                          "fms_user_skey", "fms_user_id", "spx_uk", "spx_uid"))
            for n in cookies_dict
        ),
    }


def carregar_sessao_cookies(path: Path | str | None = None) -> dict[str, str]:
    """Helper top-level: carrega cookies do arquivo e retorna dict pronto
    pra session.cookies.update(). Loga sumario + aviso de expiracao.
    """
    cookies_raw = load_cookies(path)
    cookies_dict = cookies_to_requests_dict(cookies_raw)
    summary = cookies_summary(cookies_dict)
    if not summary["has_auth_like"]:
        log_alerta(
            f"[auth] cookies carregados ({summary['total']}) mas NENHUM parece ser de "
            f"autenticacao (SPC_*/SC_SESSION/scfe_*). Sessao pode falhar."
        )
    else:
        log_info(f"[auth] cookies carregados: {summary['total']} cookies, auth-like presente")
    # Aviso de expiracao (Quick Win 2026-05-26)
    try:
        dias = dias_ate_expiracao(cookies_raw)
        if dias is not None:
            if dias < 0:
                log_alerta(f"[auth] cookies EXPIRADOS ha {-dias} dia(s) — reexporte do Chrome")
            elif dias < 2:
                log_alerta(f"[auth] cookies expiram em {dias} dia(s) — reexporte em breve")
            else:
                log_info(f"[auth] cookies validos por mais {dias} dia(s)")
    except Exception:
        pass
    return cookies_dict


def dias_ate_expiracao(cookies_raw: list[dict[str, Any]]) -> int | None:
    """Retorna o numero de dias ate o cookie auth-like mais cedo expirar.
    None se nao houver expirationDate em nenhum cookie de auth.
    """
    AUTH_PREFIXES = ("SPC_", "_csrftoken", "SC_SESSION", "scfe_",
                     "fms_user_skey", "fms_user_id", "spx_uk", "spx_uid")
    menor_exp: float | None = None
    for c in cookies_raw or []:
        name = (c.get("name") or "").strip()
        if not any(name.startswith(p) or name == p for p in AUTH_PREFIXES):
            continue
        exp = c.get("expirationDate") or c.get("expires")
        try:
            exp_f = float(exp) if exp else 0
        except (TypeError, ValueError):
            exp_f = 0
        if exp_f <= 0:
            continue
        if menor_exp is None or exp_f < menor_exp:
            menor_exp = exp_f
    if menor_exp is None:
        return None
    delta = menor_exp - time.time()
    return int(delta // 86400)


def save_cookies_from_jar(
    jar: Any,
    path: Path | str | None = None,
) -> bool:
    """Persiste cookies da session.cookies de volta no JSON file no formato
    Cookie Editor — preservando campos como httpOnly/sameSite/hostOnly quando
    possivel (lendo o arquivo atual e merge-ando por nome).

    Estrategia "Set-Cookie capture":
    - requests.Session ja captura Set-Cookie automaticamente nas respostas
    - Chamamos esta funcao apos requests bem-sucedidos pra persistir as
      rotacoes de cookie do servidor
    - Como o servidor SPX rotaciona cookies em chamadas validas, isso
      mantem a sessao viva indefinidamente enquanto o sistema rodar
      regularmente

    Retorna True se escreveu (mudou) ou False se nao mudou nada.
    """
    p = Path(path) if path else _cookie_path()

    existing_by_name: dict[str, dict[str, Any]] = {}
    if p.exists():
        try:
            current = load_cookies(p)
            existing_by_name = {c.get("name"): c for c in current if c.get("name")}
        except Exception:
            pass

    out: list[dict[str, Any]] = []
    for cookie in jar:
        name = cookie.name
        base = existing_by_name.get(name, {})
        domain = cookie.domain or base.get("domain", ".myagencyservice.com.br")
        entry = {
            "domain": domain,
            "expirationDate": cookie.expires if cookie.expires else base.get("expirationDate"),
            "hostOnly": base.get("hostOnly", not domain.startswith(".")),
            "httpOnly": base.get("httpOnly", False),
            "name": name,
            "path": cookie.path or base.get("path", "/"),
            "sameSite": base.get("sameSite"),
            "secure": bool(cookie.secure) if cookie.secure is not None else base.get("secure", False),
            "session": base.get("session", cookie.expires is None),
            "storeId": base.get("storeId"),
            "value": cookie.value,
        }
        if entry.get("expirationDate") is None:
            entry.pop("expirationDate", None)
        out.append(entry)

    nova = {e["name"]: e["value"] for e in out}
    atual = {n: c.get("value") for n, c in existing_by_name.items()}
    if nova == atual:
        return False

    tmp = p.with_suffix(p.suffix + ".tmp")
    try:
        tmp.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)
        return True
    except Exception as exc:
        log_alerta(f"[auth] falha ao persistir cookies em {p}: {exc}")
        try:
            tmp.unlink()
        except Exception:
            pass
        return False
