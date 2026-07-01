# -*- coding: utf-8 -*-
"""Traz o cadastro reusando a SESSAO DO NAVEGADOR (sem senha, sem bater no Cloudflare).

Pré-requisito: criar 2 arquivos texto nesta pasta (backend/):
  - cookie.txt      -> o valor do header `Cookie` (copiado do DevTools)
  - useragent.txt   -> o seu User-Agent (mesmo lugar). Opcional, mas recomendado.

Depois:
    cd brasilrisk-robo/backend
    $env:CPF="76276937487"; python -m examples.obter_cadastro_cookie
"""

from __future__ import annotations

import json
import os

from brasilrisk_robo.client import BRSystemClient
from brasilrisk_robo import motorista as M


def _ler(nome: str) -> str:
    for caminho in (nome, os.path.join(os.path.dirname(__file__), "..", nome)):
        try:
            with open(caminho, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except OSError:
            continue
    return ""


def main() -> None:
    cookie = os.getenv("BRSYSTEM_COOKIE") or _ler("cookie.txt")
    ua = os.getenv("BRSYSTEM_UA") or _ler("useragent.txt") or None
    cpf = os.getenv("CPF") or "76276937487"
    if not cookie:
        raise SystemExit("crie o arquivo backend/cookie.txt com o header Cookie do navegador "
                         "(veja o README / instrucoes).")

    c = BRSystemClient()
    c.usar_sessao_navegador(cookie, user_agent=ua)

    cad = M.obter_cadastro_por_cpf(c, cpf)
    if cad is None:
        print("cadastro nao encontrado / IDs do grid nao mapeados.")
        grid = M.buscar_motoristas(c, cpf=cpf)
        linhas = (grid or {}).get("aaData") or (grid or {}).get("data") or []
        if linhas:
            print("Linha crua do grid (pra mapear as chaves):")
            print(json.dumps(linhas[0], ensure_ascii=False, indent=2))
        return

    print(json.dumps(cad, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
