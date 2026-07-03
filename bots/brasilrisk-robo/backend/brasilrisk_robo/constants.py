# -*- coding: utf-8 -*-
"""Constantes e tabelas de dominio do BRSystem2 / Brasil Risk.

Valores capturados em 2026-06-26 lendo os <select> do form /Motorista/Criar.
Codigos de UF e empresa sao INTERNOS do BRSystem (nao sao IBGE/CNPJ).
"""

from __future__ import annotations

import os

BASE_URL = (os.getenv("BRSYSTEM_BASE_URL") or "https://br2.brasilrisk.com.br").rstrip("/")

# ── Tabelas de dominio (codigo do select) ──────────────────────────────────

# CodGenero
GENERO = {"F": 1, "FEMININO": 1, "M": 2, "MASCULINO": 2, "OUTROS": 3}

# CodMotoristaFuncao
FUNCAO = {
    1: "Motorista", 2: "Ajudante", 3: "Outros", 5: "Vigilante",
    6: "DSP", 7: "HDP Owner", 8: "HDP DA Driver", 9: "HDP DA Non Driver",
}
FUNCAO_MOTORISTA = 1

# CodMotoristaPerfil
PERFIL = {1: "Frota", 2: "Agregado", 3: "Autonomo"}

# CodEmpresaFaturamento (codigo interno BRSystem)
EMPRESA_FATURAMENTO = {
    42378: "AMERICANAS S.A",
    43618: "CARGILL",
    33827: "DIRECT EXPRESS",
    37967: "GRIFFI TRANSPORTES",   # <- empresa do grupo
    54451: "MDIAS BRANCO",
    54977: "QUIMICA AMPARO",
    44017: "SUZANO",
}
EMPRESA_GRIFFI = 37967

# UF -> codigo interno BRSystem (usado em Endereco.Cidade_UF_CodUF e CNHCodUF).
# ATENCAO: NAO e o codigo IBGE. SP=26, MG=11, etc.
UF = {
    "AC": 1, "AL": 2, "AP": 4, "AM": 3, "BA": 5, "CE": 6, "DF": 7, "ES": 8,
    "GO": 9, "MA": 10, "MT": 13, "MS": 12, "MG": 11, "PA": 14, "PB": 15,
    "PR": 18, "PE": 16, "PI": 17, "RJ": 19, "RN": 20, "RS": 23, "RO": 21,
    "RR": 22, "SC": 24, "SP": 26, "SE": 25, "TO": 27,
}

# ── Campos do form fomMot (POST /Motorista/Criar) ───────────────────────────
# Lista completa dos 57 campos, na ordem do DOM. Serve de referencia para o
# montar_payload(). Hidden/controle no topo.
CADASTRO_FIELDS = [
    # controle / hidden
    "CodEmpresa", "OrderIdi", "StatusRDO", "PesquisaComplementar",
    "MotoristaInternacional", "Endereco.Alterado", "Endereco.CodEndereco",
    # documentos / upload
    "CaminhoFoto", "CaminhoFotoCNH", "CaminhoPdfCNH", "ImagemCNH64",
    # pessoais
    "Nome", "CodGenero", "DataNascimentoString", "CPF", "RG",
    "DataEmissaoString", "OrgaoExp", "ControleCliente", "NomePai", "NomeMae",
    "CodMotoristaFuncao", "CodMotoristaPerfil", "CodEmpresaCentroCusto",
    "CNPJMEI", "Passaporte", "CodEmpresaFaturamento",
    # endereco
    "Endereco.Cep", "Endereco.Cidade_UF_CodUF", "Endereco.CodCidade",
    "Municipio", "Endereco.Bairro", "Endereco.Logradouro", "Numero",
    "Complemento",
    # contato
    "TelResidencial", "TelCelular", "TelComercial", "Email",
    # cnh
    "CNHRegistro", "CNHNumero", "CNHCategoria", "CNHValidadeString",
    "CNHCodUF", "CNHPermanente",
    # estrangeiro
    "Antiguedad", "Expedicion", "OrgaoExpedidor", "Nacionalidad",
    "CodCidadeOutroPais",
    # observacoes
    "ObsUltimosEmpregos", "ObsEducacional",
]

# Obrigatorios no client-side (servidor pode exigir mais).
CADASTRO_REQUIRED = [
    "Endereco.Cidade_UF_CodUF", "Endereco.CodCidade",
    "Endereco.Logradouro", "Numero",
]

# O form de EDITAR (/Motorista/Editar) usa nomes diferentes do de CRIAR.
# Mapa: nome no Editar -> nome no Criar (confirmado lendo um cadastro real, 2026-06-26).
# Os nao-listados sao iguais nos dois (RG, OrgaoExp, NomePai, NomeMae, CodGenero,
# CodMotoristaFuncao, CodMotoristaPerfil, CNHNumero, CNHCategoria, CNHValidadeString,
# Endereco.*, Numero, Tel*, etc.).
EDIT_TO_CREATE = {
    "Pessoa.Nome": "Nome",
    "Pessoa.CPF": "CPF",
    "Pessoa.Email": "Email",
    "Empresa.CodEmpresa": "CodEmpresaFaturamento",
    "UFCNH.CodUF": "CNHCodUF",
    "DataNascimento": "DataNascimentoString",   # Editar traz 'dd/mm/aaaa 00:00:00'; Criar quer 'dd/mm/aaaa'
}

# Formatos confirmados:
#   data        -> 'dd/mm/aaaa' (no Criar) ; CEP -> '#####-###' ; tel -> '(DD) #####-####'
#   UF          -> codigo interno (PE=16) ; Endereco.CodCidade -> numerico (ex. 5384)
