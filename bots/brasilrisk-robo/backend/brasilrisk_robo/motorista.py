# -*- coding: utf-8 -*-
"""Fluxo de cadastro de motorista no BRSystem2.

Endpoints mapeados (2026-06-26). Onde o parametro exato nao foi confirmado,
marquei `# CONFIRMAR` — um HAR de um cadastro real fecha esses pontos:
    python mapeador-api/mapear_api.py brasilrisk.har --nome brasilrisk

Pagina/contrato:
    GET  /Motorista/Criar                      -> form (tem CSRF token)
    POST /Motorista/Criar                      -> salva (form-urlencoded, 57 campos)
    POST /Motorista/ConfirmarEnvioLgpdMotorista-> confirma LGPD pos-save
    POST /Motorista/UploadFile                 -> upload de foto/CNH (multipart)
    GET  /Motorista/ExisteCPF                  -> checa CPF duplicado
    GET  /Motorista/ValidarCNH                 -> valida CNH
    GET  /Endereco/BuscarCep                   -> autopreenche por CEP
    GET  /Endereco/BuscarCidade                -> cidades de uma UF
"""

from __future__ import annotations

import os
import re
from html.parser import HTMLParser
from typing import Any

from . import constants as K
from .client import BRSystemClient, BRSystemErro
from .logger import log_alerta, log_info

_digits = lambda s: re.sub(r"\D+", "", str(s or ""))


# ── Lookups (GET -> JSON) ───────────────────────────────────────────────────

def listar_genero(c: BRSystemClient) -> Any:
    return c.get_json("/Motorista/ListarGenero")

def listar_funcao(c: BRSystemClient) -> Any:
    return c.get_json("/Motorista/ListarFuncao")

def listar_perfil(c: BRSystemClient) -> Any:
    return c.get_json("/Motorista/ListarPerfil")

def listar_empresa_faturamento(c: BRSystemClient) -> Any:
    return c.get_json("/Motorista/ListarEmpresaFaturamento")

def listar_uf(c: BRSystemClient) -> Any:
    return c.get_json("/Motorista/ListarUF", params={"codPais": 1})

def select_emp_centro_custo(c: BRSystemClient, cod_empresa: int) -> Any:
    # CONFIRMAR nome do param (codEmpresa?)
    return c.get_json("/Motorista/SelectEmpCentroCusto",
                      params={"codEmpresa": cod_empresa})


# ── Endereco ────────────────────────────────────────────────────────────────

def buscar_cep(c: BRSystemClient, cep: str) -> Any:
    """GET /Endereco/BuscarCep?cep= — autopreenche logradouro/bairro/cidade."""
    return c.get_json("/Endereco/BuscarCep", params={"cep": _digits(cep)})

def buscar_cidade(c: BRSystemClient, cod_uf: int) -> Any:
    """GET /Endereco/BuscarCidade?codUF= — cidades da UF (codigo interno)."""
    # CONFIRMAR nome do param (codUF vs coduf)
    return c.get_json("/Endereco/BuscarCidade", params={"codUF": cod_uf})


# ── Validacoes ──────────────────────────────────────────────────────────────

def existe_cpf(c: BRSystemClient, cpf: str) -> Any:
    """GET /Motorista/ExisteCPF?cpf= — checa duplicado. Retorno bruto da API."""
    # CONFIRMAR metodo (GET/POST) e shape da resposta
    return c.get_json("/Motorista/ExisteCPF", params={"cpf": _digits(cpf)})

def validar_cnh(c: BRSystemClient, *, registro: str = "", numero: str = "",
                categoria: str = "", validade: str = "") -> Any:
    """GET /Motorista/ValidarCNH — valida dados da CNH."""
    # CONFIRMAR nomes dos params
    return c.get_json("/Motorista/ValidarCNH", params={
        "cnhRegistro": registro, "cnhNumero": numero,
        "categoria": categoria, "validade": validade,
    })


# ── Upload ──────────────────────────────────────────────────────────────────

def upload_file(c: BRSystemClient, caminho_arquivo: str, *,
                campo: str = "file") -> str:
    """POST /Motorista/UploadFile (multipart) -> retorna o caminho salvo.

    O caminho retornado vai em CaminhoFoto / CaminhoFotoCNH / CaminhoPdfCNH.
    CONFIRMAR: nome do campo do arquivo ('file'?) e o shape da resposta.
    """
    if not os.path.isfile(caminho_arquivo):
        raise FileNotFoundError(caminho_arquivo)
    nome = os.path.basename(caminho_arquivo)
    with open(caminho_arquivo, "rb") as fh:
        files = {campo: (nome, fh, "application/octet-stream")}
        resp = c.post_multipart("/Motorista/UploadFile", files=files)
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError:
        return resp.text.strip().strip('"')
    # tenta achar o caminho na resposta (chaves comuns)
    if isinstance(data, dict):
        for k in ("caminho", "path", "Caminho", "url", "arquivo", "file"):
            if data.get(k):
                return str(data[k])
    return str(data)


# ── Payload do cadastro ──────────────────────────────────────────────────────

def montar_payload(**campos: Any) -> dict[str, str]:
    """Monta o dict do POST /Motorista/Criar com os 57 campos.

    Use os nomes de `constants.CADASTRO_FIELDS`. Campos nao informados entram
    com default seguro (string vazia / flags desligadas). Ex:
        montar_payload(Nome="FULANO", CPF="12345678901", CodGenero=2,
                       CodMotoristaFuncao=K.FUNCAO_MOTORISTA, ...)
    """
    payload: dict[str, str] = {f: "" for f in K.CADASTRO_FIELDS}
    # defaults de controle
    payload["MotoristaInternacional"] = "False"
    payload["CNHPermanente"] = "false"
    payload["Endereco.Alterado"] = "true"
    for k, v in campos.items():
        if k not in payload:
            log_alerta(f"[montar_payload] campo desconhecido ignorado: {k}")
            continue
        payload[k] = "" if v is None else str(v)
    return payload


def criar(c: BRSystemClient, payload: dict) -> dict:
    """GET /Motorista/Criar (raspa CSRF) -> POST /Motorista/Criar.

    Retorna a resposta interpretada. ATENCAO: cria registro REAL no sistema
    de risco — nao rode contra producao em teste.
    """
    faltando = [f for f in K.CADASTRO_REQUIRED if not payload.get(f)]
    if faltando:
        log_alerta(f"[criar] campos obrigatorios vazios: {faltando}")
    log_info(f"[criar] POST /Motorista/Criar cpf={_digits(payload.get('CPF'))[:3]}…")
    resp = c.post_form("/Motorista/Criar", payload,
                       add_token_from="/Motorista/Criar")
    if resp.status_code >= 400:
        raise BRSystemErro("falha ao criar motorista", status=resp.status_code,
                           path="/Motorista/Criar", body=resp.text[:500])
    try:
        return resp.json()
    except ValueError:
        return {"status": resp.status_code, "url_final": resp.url}


def confirmar_lgpd(c: BRSystemClient, *, cpf: str = "",
                   cod_motorista: int | None = None) -> dict:
    """POST /Motorista/ConfirmarEnvioLgpdMotorista (passo pos-cadastro)."""
    # CONFIRMAR params exatos (cpf? codMotorista?)
    data: dict[str, Any] = {}
    if cpf:
        data["cpf"] = _digits(cpf)
    if cod_motorista is not None:
        data["codMotorista"] = cod_motorista
    resp = c.post_form("/Motorista/ConfirmarEnvioLgpdMotorista", data)
    try:
        return resp.json()
    except ValueError:
        return {"status": resp.status_code}


# ── Orquestracao ─────────────────────────────────────────────────────────────

# ── Leitura de um cadastro existente (100% via HTTP, sem navegador) ──────────

_DT_FILTROS = [
    "cpf", "dataInicial", "dataFinal", "codMotorista", "nome", "empSolicitante",
    "codPerfil", "codFuncao", "cnh", "codigoUF", "codStatus", "controleCliente",
    "somenteMotoristaDaOperacao", "idConjunto",
]


def _datatables_params(n_cols: int = 10) -> dict:
    """Params de paginação/ordenação que o grid DataTables exige."""
    p: dict[str, Any] = {
        "sEcho": 1, "iColumns": n_cols, "iDisplayStart": 0,
        "iDisplayLength": 10, "iSortCol_0": 0, "sSortDir_0": "asc",
        "iSortingCols": 1,
    }
    for i in range(n_cols):
        p[f"bSortable_{i}"] = "false"
    return p


def buscar_motoristas(c: BRSystemClient, *, cpf: str = "", nome: str = "",
                      cod_status: str = "", **filtros: Any) -> dict:
    """GET /Motorista/ListaMotoristas — retorna o JSON cru do grid (DataTables).

    Use `.get('aaData')` para as linhas. Filtros aceitos em _DT_FILTROS.
    """
    params = {k: "" for k in _DT_FILTROS}
    params["somenteMotoristaDaOperacao"] = "false"
    params["cpf"] = _digits(cpf)
    params["nome"] = nome or ""
    params["codStatus"] = cod_status or ""
    for k, v in filtros.items():
        if k in params:
            params[k] = v
    params.update(_datatables_params())
    return c.get_json("/Motorista/ListaMotoristas", params=params)


def _achar_valor(obj: Any, pattern: str) -> Any:
    """Busca recursiva: 1º valor cuja CHAVE casa (case-insensitive) com o regex."""
    rx = re.compile(pattern, re.I)
    if isinstance(obj, dict):
        for k, v in obj.items():
            if rx.search(str(k)) and not isinstance(v, (dict, list)):
                return v
        for v in obj.values():
            r = _achar_valor(v, pattern)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _achar_valor(v, pattern)
            if r is not None:
                return r
    return None


class _FormParser(HTMLParser):
    """Coleta TODOS os <form> da página e seus campos (name->value).

    Independente de id: depois escolhemos o form com mais campos (o cadastro).
    Lida com input (value/checkbox), select (option selected) e textarea.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self._cur: dict | None = None
        self._select: str | None = None
        self._textarea: str | None = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v if v is not None else "") for k, v in attrs}
        if tag == "form":
            self._cur = {"action": a.get("action", ""), "id": a.get("id", ""),
                         "fields": {}}
            self.forms.append(self._cur)
            return
        if self._cur is None:
            return
        f = self._cur["fields"]
        if tag == "input":
            name = a.get("name")
            if not name:
                return
            itype = (a.get("type") or "text").lower()
            if itype in ("checkbox", "radio"):
                if "checked" in a:
                    f[name] = a.get("value", "on")
                else:
                    f.setdefault(name, "")
            else:
                f[name] = a.get("value", "")
        elif tag == "select":
            self._select = a.get("name") or None
            if self._select:
                f.setdefault(self._select, "")
        elif tag == "option" and self._select:
            if "selected" in a:
                f[self._select] = a.get("value", "")
        elif tag == "textarea":
            self._textarea = a.get("name") or None
            if self._textarea:
                f[self._textarea] = ""

    def handle_startendtag(self, tag, attrs):
        # <input .../> self-fechado
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "select":
            self._select = None
        elif tag == "textarea":
            self._textarea = None
        elif tag == "form":
            self._cur = None

    def handle_data(self, data):
        if self._cur is not None and self._textarea:
            self._cur["fields"][self._textarea] += data


def parse_form_cadastro(html_text: str) -> dict:
    """Extrai o form de cadastro (o maior da página) como dict name->value."""
    p = _FormParser()
    p.feed(html_text)
    if not p.forms:
        return {}
    # preferencia: form cujo action aponta pra Motorista; senao, o com mais campos
    cand = [fm for fm in p.forms if "motorista" in (fm["action"] or "").lower()]
    escolha = max(cand or p.forms, key=lambda fm: len(fm["fields"]))
    campos = dict(escolha["fields"])
    campos.pop("__RequestVerificationToken", None)
    return campos


def obter_cadastro_editar(c: BRSystemClient, *, cod_motorista_pessoa: Any,
                          cod_empresa_solicitante: Any = "",
                          cod_pesquisa_motorista: Any = "") -> dict:
    """GET /Motorista/Editar (HTML) -> dict com os campos preenchidos do cadastro.

    ATENCAO (confirmado 2026-06-26): o form de EDITAR usa nomes DIFERENTES do
    de CRIAR. Ex.: Pessoa.Nome (vs Nome), Pessoa.CPF (vs CPF), Empresa.CodEmpresa
    (vs CodEmpresaFaturamento), UFCNH.CodUF (vs CNHCodUF), DataNascimento como
    'dd/mm/aaaa 00:00:00' (vs DataNascimentoString 'dd/mm/aaaa'). Ou seja: este
    retorno serve pra LER; pra CRIAR use os nomes de constants.CADASTRO_FIELDS.
    Mapa em constants.EDIT_TO_CREATE.
    """
    r = c.get("/Motorista/Editar", params={
        "codMotoristaPessoa": cod_motorista_pessoa,
        "codEmpresaSolicitante": cod_empresa_solicitante,
        "codPesquisaMotorista": cod_pesquisa_motorista,
    })
    r.raise_for_status()
    return parse_form_cadastro(r.text)


def obter_cadastro_por_cpf(c: BRSystemClient, cpf: str) -> dict | None:
    """Acha o motorista pelo CPF e devolve o 'JSON' do cadastro — tudo via HTTP.

    Fluxo: ListaMotoristas (acha IDs) -> Editar (HTML) -> parse do form.
    Retorna None se o CPF nao for encontrado.
    """
    grid = buscar_motoristas(c, cpf=cpf)
    linhas = (grid or {}).get("aaData") or (grid or {}).get("data") or []
    if not linhas:
        log_alerta(f"[obter_cadastro_por_cpf] CPF {_digits(cpf)} nao encontrado")
        return None
    row = linhas[0]

    # CONFIRMAR: chaves exatas do grid. Busca defensiva por padrao no nome da chave.
    cod_pessoa = _achar_valor(row, r"codmotoristapessoa$") or _achar_valor(row, r"codmotorista")
    cod_emp = _achar_valor(row, r"codempresasolicitante") or _achar_valor(row, r"empresasolicitante")
    cod_pesq = _achar_valor(row, r"codpesquisamotorista") or _achar_valor(row, r"codpesquisa")

    if not cod_pessoa:
        log_alerta("[obter_cadastro_por_cpf] nao achei CodMotoristaPessoa na linha. "
                   f"Chaves disponiveis: {list(row.keys()) if isinstance(row, dict) else type(row)}")
        return None

    return obter_cadastro_editar(
        c, cod_motorista_pessoa=cod_pessoa,
        cod_empresa_solicitante=cod_emp or "",
        cod_pesquisa_motorista=cod_pesq or "",
    )


# ── Orquestracao ─────────────────────────────────────────────────────────────

def cadastrar_completo(c: BRSystemClient, *, dados: dict,
                       foto: str | None = None,
                       foto_cnh: str | None = None,
                       pdf_cnh: str | None = None,
                       confirmar_lgpd_apos: bool = True) -> dict:
    """Fluxo ponta-a-ponta: uploads -> montar payload -> criar -> LGPD.

    `dados` = kwargs de montar_payload (campos do form ja resolvidos:
    CodGenero, Endereco.Cidade_UF_CodUF, Endereco.CodCidade, etc.).
    """
    campos = dict(dados)
    if foto:
        campos["CaminhoFoto"] = upload_file(c, foto)
    if foto_cnh:
        campos["CaminhoFotoCNH"] = upload_file(c, foto_cnh)
    if pdf_cnh:
        campos["CaminhoPdfCNH"] = upload_file(c, pdf_cnh)

    payload = montar_payload(**campos)
    resultado = criar(c, payload)
    if confirmar_lgpd_apos:
        try:
            confirmar_lgpd(c, cpf=campos.get("CPF", ""))
        except Exception as exc:  # nao derruba o cadastro por causa do LGPD
            log_alerta(f"[cadastrar_completo] confirmar_lgpd falhou: {exc}")
    return resultado
