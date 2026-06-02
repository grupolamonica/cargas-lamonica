"""Credenciais AngelLira via .env (sem DPAPI/secret_manager).

Equivalente simplificado do shared/angelira_auth.py — le tudo de variaveis
de ambiente.
"""

from __future__ import annotations

import os


def get_username() -> str:
    # Aceita grafia ANGELIRA (1 L, bots) e ANGELLIRA (2 Ls, backend.env do monorepo).
    value = (
        os.getenv("ANGELIRA_API_USERNAME")
        or os.getenv("ANGELIRA_USERNAME")
        or os.getenv("ANGELIRA_USER")
        or os.getenv("ANGELLIRA_USER")
        or os.getenv("ANGELLIRA_USERNAME")
        or ""
    ).strip()
    if not value:
        raise RuntimeError(
            "Credencial do AngelLira ausente. Configure ANGELIRA_API_USERNAME (ou ANGELLIRA_USER) no .env."
        )
    return value


def get_password() -> str:
    value = (
        os.getenv("ANGELIRA_API_PASSWORD")
        or os.getenv("ANGELIRA_PASSWORD")
        or os.getenv("ANGELIRA_PASS")
        or os.getenv("ANGELLIRA_PASSWORD")
        or ""
    ).strip()
    if not value:
        raise RuntimeError(
            "Senha do AngelLira ausente. Configure ANGELIRA_API_PASSWORD (ou ANGELLIRA_PASSWORD) no .env."
        )
    return value


def get_company_id() -> int:
    raw = str(
        os.getenv("ANGELIRA_COMPANY_ID")
        or os.getenv("ANGELIRA_EMPRESA_ID")
        or os.getenv("ANGELLIRA_EMPRESA_ID")
        or 876943
    ).strip()
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"ANGELIRA_COMPANY_ID invalido: {raw}") from exc
