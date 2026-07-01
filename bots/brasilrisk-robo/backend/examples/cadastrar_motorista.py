# -*- coding: utf-8 -*-
"""Exemplo de uso do brasilrisk_robo.

Rode da pasta backend/:
    cd brasilrisk-robo/backend
    set BRSYSTEM_USER=...&& set BRSYSTEM_PASS=...&& python -m examples.cadastrar_motorista

⚠️ O passo de criar() cria registro REAL no sistema de risco. Por padrao este
exemplo so faz LOGIN + LOOKUPS (read-only). Descomente o bloco do cadastro
quando tiver confirmado os contratos com um HAR.
"""

from __future__ import annotations

import os

from brasilrisk_robo.client import BRSystemClient
from brasilrisk_robo import constants as K
from brasilrisk_robo import motorista as M


def main() -> None:
    usuario = os.getenv("BRSYSTEM_USER") or ""
    senha = os.getenv("BRSYSTEM_PASS") or ""
    if not usuario or not senha:
        raise SystemExit("defina BRSYSTEM_USER e BRSYSTEM_PASS no ambiente")

    c = BRSystemClient()
    c.login(usuario, senha)
    print("login OK")

    # --- leitura (seguro) ---
    print("UF SP =", K.UF["SP"])
    print("cidades de SP:", M.buscar_cidade(c, K.UF["SP"]))
    print("cep:", M.buscar_cep(c, "01310-100"))

    # --- cadastro (CRIA REGISTRO REAL — descomente com cuidado) ---
    # dados = dict(
    #     Nome="FULANO DE TAL",
    #     CPF="12345678901",
    #     CodGenero=K.GENERO["M"],
    #     DataNascimentoString="01/01/1990",
    #     CodMotoristaFuncao=K.FUNCAO_MOTORISTA,
    #     CodMotoristaPerfil=2,                       # Agregado
    #     CodEmpresaFaturamento=K.EMPRESA_GRIFFI,
    #     CNHNumero="12345678901", CNHCategoria="E",
    #     CNHValidadeString="01/01/2030", CNHCodUF=K.UF["SP"],
    #     **{
    #         "Endereco.Cep": "01310100",
    #         "Endereco.Cidade_UF_CodUF": K.UF["SP"],
    #         "Endereco.CodCidade": 0,                # pegar de buscar_cidade()
    #         "Endereco.Bairro": "CENTRO",
    #         "Endereco.Logradouro": "AV PAULISTA",
    #         "Numero": "1000",
    #     },
    #     TelCelular="11999998888",
    # )
    # res = M.cadastrar_completo(
    #     c, dados=dados,
    #     foto="foto.jpg", foto_cnh="cnh_frente.jpg", pdf_cnh="cnh.pdf",
    # )
    # print("cadastro:", res)


if __name__ == "__main__":
    main()
