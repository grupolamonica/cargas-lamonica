# -*- coding: utf-8 -*-
"""Traz o 'JSON' de um cadastro de motorista existente — 100% via HTTP (sem navegador).

    cd brasilrisk-robo/backend
    # PowerShell:
    $env:BRSYSTEM_USER="login"; $env:BRSYSTEM_PASS="senha"; $env:CPF="76276937487"
    python -m examples.obter_cadastro
"""

from __future__ import annotations

import json
import os

from brasilrisk_robo.client import BRSystemClient
from brasilrisk_robo import motorista as M


def main() -> None:
    usuario = os.getenv("BRSYSTEM_USER") or ""
    senha = os.getenv("BRSYSTEM_PASS") or ""
    cpf = os.getenv("CPF") or "76276937487"
    if not usuario or not senha:
        raise SystemExit("defina BRSYSTEM_USER e BRSYSTEM_PASS")

    c = BRSystemClient()
    c.login(usuario, senha)

    cad = M.obter_cadastro_por_cpf(c, cpf)
    if cad is None:
        print("cadastro nao encontrado / IDs do grid nao mapeados.")
        # ajuda a mapear: imprime a 1a linha crua do grid
        grid = M.buscar_motoristas(c, cpf=cpf)
        linhas = (grid or {}).get("aaData") or (grid or {}).get("data") or []
        if linhas:
            print("Linha crua do grid (pra mapear as chaves):")
            print(json.dumps(linhas[0], ensure_ascii=False, indent=2))
        return

    print(json.dumps(cad, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
