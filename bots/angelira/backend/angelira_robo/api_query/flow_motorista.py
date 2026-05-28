"""Cadastro de motorista 100% via API publica da Angellira (substitui Selenium).

Recebe o mesmo payload que o flow Selenium em `flows/motorista.py` consome
(formato do Node bot: `{motorista, cnh, endereco}` com chaves em portugues),
faz a traducao para os endpoints API e executa:

    1. find_by_cpf -> ja existe?
    2. resolve geo (CEP) e UFs (rg/cnh) para IDs
    3. POST /drivers (cria) OU PATCH /drivers/{id} (atualiza)
    4. PATCH agrupado para os campos restantes
    5. preflight /query -> store_query (consulta final)

Retorna dict no MESMO formato do runner Selenium:
    {ok, salvou, etapa, driverId, queryId, erro, duracao_s}

NOTA 2026-05-26 — flag "Definir este motorista tambem como proprietario":
    O portal Angellira tem um toggle nessa pagina de cadastro de motorista
    que, quando ativado, cria/vincula um owner PF com mesmo CPF. Inspecionando
    o bundle JS (driver.b653388a.js -> prepareData) descobrimos que o front
    envia `owner: true` no body do POST/PATCH /drivers (junto com
    hasCNHImage/hasRGImage/hasConsentFormFile). O backend processa esse
    campo automaticamente, sem chamada separada pra /owners. Por decisao do
    escritorio, deixamos `owner: True` hard-coded no payload — todo motorista
    cadastrado vira proprietario tambem.
"""

from __future__ import annotations

import time
from typing import Any

from concurrent.futures import ThreadPoolExecutor

from ..helpers import extrair_numeros, formatar_telefone, limpar_texto
from ..logger import log_alerta, log_erro, log_info
from .client import AngellraAPIClient, get_shared_client
from .precheck import verificar_motorista_via_api
from . import drivers, geo, queries


# Defaults
TYPE_FUNCIONARIO = 25  # /types/drivers
PHONE_TYPE_CELULAR = 3


def _br_para_iso(data_br: str) -> str | None:
    """'21/12/2000' -> '2000-12-21'. Retorna None se invalido.

    Valida com datetime: dia/mes precisam estar nos ranges validos. Rejeita
    '32/13/2000', anos absurdos (<1900 ou >2100), etc.
    """
    if not data_br:
        return None
    import datetime as _dt
    s = str(data_br).strip()
    # Tenta BR (DD/MM/YYYY)
    if "/" in s:
        try:
            d, m, y = s.split("/")
            iso = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
            parsed = _dt.date.fromisoformat(iso)
            if 1900 <= parsed.year <= 2100:
                return iso
            return None
        except Exception:
            return None
    # Tenta ISO (YYYY-MM-DD)
    if len(s) >= 10 and s[4] == "-":
        try:
            parsed = _dt.date.fromisoformat(s[:10])
            if 1900 <= parsed.year <= 2100:
                return s[:10]
        except Exception:
            return None
    return None


def _detectar_ocr_suspeito(motorista: dict, cnh: dict) -> list[str]:
    """Detecta valores OCR mal-extraidos. Retorna lista de mensagens.

    Heuristica: campos numericos (RG, CPF, CNH, codigo seguranca) com
    caracteres nao-digitos diferentes de espacos/pontos/hifens sao suspeitos.
    Casos vistos: "2007767484]" — OCR confundiu "1" com "]".
    """
    avisos = []
    import re
    suspeitos = re.compile(r"[^\d\s\.\-/]")  # tudo que nao for digit, space, ., -, /
    for nome, val in (
        ("RG", motorista.get("rg")),
        ("CPF", motorista.get("cpf")),
        ("CNH registro", cnh.get("registro")),
        ("Codigo de seguranca CNH", cnh.get("codigo_seguranca")),
    ):
        if val and suspeitos.search(str(val)):
            avisos.append(
                f"⚠️ OCR SUSPEITO em {nome}: valor extraido {val!r} contem "
                f"caractere nao-numerico. CONFERIR no portal Angellira."
            )
    return avisos


def _phones_para_api(telefones: Any) -> list[dict]:
    """['14997507525'] -> [{phone:'(14) 99750-7525', typeId:3}]."""
    saida: list[dict] = []
    if not telefones:
        return saida
    if not isinstance(telefones, list):
        telefones = [telefones]
    for tel in telefones:
        if isinstance(tel, dict):
            num = tel.get("phone") or tel.get("numero") or ""
            tipo = tel.get("typeId") or tel.get("tipo") or PHONE_TYPE_CELULAR
        else:
            num = str(tel or "")
            tipo = PHONE_TYPE_CELULAR
        formatado = formatar_telefone(num)
        if formatado:
            saida.append({"phone": formatado, "typeId": int(tipo)})
    return saida


def _construir_payload_driver(
    client: AngellraAPIClient,
    motorista: dict,
    cnh: dict,
    endereco: dict,
    *,
    prime: int = queries.PRIME_NORMAL,
    type_id: int = TYPE_FUNCIONARIO,
) -> tuple[dict[str, Any], dict | None]:
    """Constroi o body JSON do POST/PATCH /drivers a partir do payload do Node.

    Retorna (payload_api, geo_result). `geo_result` e o que `/geo/address` devolveu
    (pode ser None se CEP invalido — caller decide).
    """
    rg_state = geo.state_id_from_uf(client, motorista.get("rg_uf") or "")
    cnh_state = geo.state_id_from_uf(client, cnh.get("uf_emissor") or "")

    geo_result = None
    cep = endereco.get("cep") or ""
    if cep:
        geo_result = geo.query_cep(client, cep)

    # NOTA 2026-05-26: a tentativa de "ancora upgrade" pos-ViaCEP foi REVERTIDA.
    # Motivo: body_create strippa address/city/neighborhood/place ANTES do POST
    # (limitacao arquitetural documentada — API Angellira nao aceita esses
    # campos via POST/PATCH, auto-resolve por CPF interno). Aplicar ancora aqui
    # nao mudava o body enviado e ia gerar endereco generico de Fortaleza nas
    # avisos — o que contradiz a diretriz "endereco sempre do JSON". Mantemos
    # apenas o fallback existente (geo_result=None caso CEP nao resolva),
    # que protege contra "Cid_Codigo undefined" em manual-fallback puro.

    # Fallback: se CEP nao resolveu (CEP invalido / fora do Angellira e do
    # ViaCEP), monta geo_result manualmente usando UF + cidade do endereco,
    # ou em ultimo caso UF da CNH + naturalidade do motorista. Sem city
    # a API retorna 422 "Cid_Codigo undefined" no POST /drivers.
    if not geo_result:
        end_uf = (endereco.get("uf") or "").upper().strip()
        end_cidade = (endereco.get("cidade") or "").strip()
        # 1a tentativa: UF+cidade do endereco
        s_id = geo.state_id_from_uf(client, end_uf)
        c_id = geo.find_city_by_name(client, s_id, end_cidade) if (s_id and end_cidade) else None
        # 2a tentativa: UF da CNH + naturalidade
        if not c_id:
            cnh_uf = (cnh.get("uf_emissor") or "").upper().strip()
            naturalidade = (motorista.get("naturalidade") or "").strip()
            s2 = geo.state_id_from_uf(client, cnh_uf)
            c2 = geo.find_city_by_name(client, s2, naturalidade) if (s2 and naturalidade) else None
            if c2:
                s_id, c_id = s2, c2
                end_uf, end_cidade = cnh_uf, naturalidade
        if s_id and c_id:
            log_alerta(f"[flow_motorista_api] geo fallback manual: city='{end_cidade}'/{end_uf} (stateId={s_id} cityId={c_id})")
            geo_result = {
                "state": {"id": s_id, "name": "", "abbrev": end_uf},
                "city":  {"id": c_id, "name": end_cidade},
                "neighborhood": {"name": (endereco.get("bairro") or "").strip()} if endereco.get("bairro") else {},
                "place": {"address": endereco.get("logradouro") or "", "cep": cep} if endereco.get("logradouro") else {},
            }
            # Upgrade: tenta enriquecer com place.id real via CEP-ancora da UF.
            # A API silenciosamente descarta city/neighborhood se nao houver
            # place.id real — entao um CEP-ancora qualquer da UF resolve o
            # vinculo. Endereco fica generico (centro da capital), mas o
            # cadastro completa e o preflight passa. Operador ajusta no portal.
            cep_ancora = geo.CEP_ANCORA_POR_UF.get(end_uf)
            if cep_ancora:
                g_ancora = geo.query_cep(client, cep_ancora)
                if g_ancora and (g_ancora.get("place") or {}).get("id"):
                    nb_a = (g_ancora.get("neighborhood") or {})
                    pl_a = (g_ancora.get("place") or {})
                    log_alerta(
                        f"[flow_motorista_api] ⚠️ ENDERECO GENERICO aplicado pra "
                        f"motorista {motorista.get('cpf') or motorista.get('nome')}: "
                        f"sem CEP/OCR de comprovante, usando ancora UF={end_uf} "
                        f"(CEP {cep_ancora} -> {pl_a.get('address')!r} / "
                        f"bairro={nb_a.get('name')!r} / city={end_cidade}). "
                        f"OPERADOR DEVE REVISAR/CORRIGIR ENDERECO NO PORTAL ANGELLIRA."
                    )
                    geo_result = g_ancora
                    # Sinaliza no geo_result que e ancora generica pra caller saber
                    geo_result["_address_generic"] = True

    # extrai number (int)
    numero_raw = (endereco.get("numero") or "").strip()
    try:
        numero = int(extrair_numeros(numero_raw) or "0")
    except Exception:
        numero = 0

    # Joi do POST /drivers tornou `rg` OBRIGATORIO (alinhado com /owners).
    # Quando OCR da CNH falha em extrair o numero, caimos pro CPF como fallback —
    # operador deve corrigir depois no portal AngelLira.
    _cpf_clean = extrair_numeros(motorista.get("cpf") or "")
    _rg_raw = motorista.get("rg") or ""
    _rg_value = extrair_numeros(_rg_raw) or (_rg_raw.strip() if isinstance(_rg_raw, str) else None) or None
    if not _rg_value:
        _rg_value = _cpf_clean or None
        if _rg_value:
            log_alerta(
                f"[flow_motorista_api] OCR nao extraiu RG do motorista "
                f"(CPF={_cpf_clean}, nome={motorista.get('nome')!r}); usando CPF "
                f"como fallback no campo `rg`. "
                f"⚠️ OPERADOR: atualizar RG real no portal AngelLira depois."
            )

    body: dict[str, Any] = {
        "prime": prime,
        "type": type_id,
        "cpf": _cpf_clean,
        "name": limpar_texto(motorista.get("nome") or ""),
        "birth": _br_para_iso(motorista.get("data_nascimento") or ""),
        "father": limpar_texto(motorista.get("nome_pai") or "") or None,
        "mother": limpar_texto(motorista.get("nome_mae") or "") or None,
        "naturalness": limpar_texto(motorista.get("naturalidade") or "") or None,
        "rg": _rg_value,
        "rgOrgan": limpar_texto(motorista.get("rg_orgao") or "") or None,
        "rgState": rg_state,
        "cnh": extrair_numeros(cnh.get("registro") or "") or None,
        "cnhCategory": (cnh.get("categoria") or "").strip().upper() or None,
        "cnhSecurity": extrair_numeros(cnh.get("codigo_seguranca") or "") or None,
        "cnhState": cnh_state,
        "cnhValidity": _br_para_iso(cnh.get("validade") or ""),
        "firstCNHIssue": _br_para_iso(cnh.get("primeira_emissao") or ""),
        "address": limpar_texto(endereco.get("logradouro") or "") or None,
        "number": numero,
        "complement": limpar_texto(endereco.get("complemento") or "") or "",
        "phones": _phones_para_api(motorista.get("telefones") or []),
        # ── FLAG "Definir este motorista também como proprietário" ───────────
        # Descoberto inspecionando o bundle JS do portal (driver.b653388a.js):
        # o checkbox da UI seta state.owner=true e o prepareData() inclui essa
        # chave no payload do POST/PATCH /drivers (junto com hasCNHImage/RGImage/
        # ConsentFormFile). O backend Angellira cria/vincula o owner PF
        # automaticamente quando recebe owner=true. Decisao do escritorio
        # (2026-05-26): TODO motorista PF passa a ser proprietario tambem,
        # entao deixamos hard-coded True. Se um dia precisar parametrizar,
        # basta puxar de motorista.get("definir_como_proprietario", True).
        "owner": True,
    }

    if geo_result:
        city = geo_result.get("city") or {}
        state = geo_result.get("state") or {}
        neighborhood = geo_result.get("neighborhood") or {}
        place = geo_result.get("place") or {}
        cep_limpo = "".join(c for c in str(endereco.get("cep") or "") if c.isdigit())
        # IMPORTANTE: a API espera estrutura NESTED (igual ao GET retorna),
        # nao IDs e nomes flat. Flat dispara .split() undefined no backend.
        if city.get("id") and state.get("id"):
            body["city"] = {
                "id": city["id"],
                "name": city.get("name") or "",
                "state": {
                    "id": state["id"],
                    "name": state.get("name") or "",
                    "abbrev": state.get("abbrev") or "",
                },
            }
        if neighborhood.get("id"):
            body["neighborhood"] = {
                "id": neighborhood["id"],
                "name": neighborhood.get("name") or "",
            }
        if place.get("id"):
            body["place"] = {
                "id": place["id"],
                "address": place.get("address") or body.get("address") or "",
                "complement": None,
                "cep": cep_limpo or None,
            }
            # Se OCR nao trouxe logradouro, herda do place pra preflight aceitar
            # (preflight exige driver.address preenchido).
            if not body.get("address") and place.get("address"):
                body["address"] = place["address"]
            if not body.get("number"):
                body["number"] = 0

    # CRITICO: Angellira 422 "Cid_Codigo undefined" se o body tem `address`
    # mas nao tem `place.id` real (com FK valido). Ou seja, quando o CEP nao
    # resolve via Angellira/ViaCEP e a gente cai pro fallback manual, o body
    # NAO pode mandar address/number/complement — so city sozinha. O motorista
    # fica cadastrado sem rua, mas com a cidade certa pra preflight rodar.
    if not (body.get("place") or {}).get("id"):
        for f in ("address", "number", "complement"):
            body.pop(f, None)
        log_alerta("[flow_motorista_api] sem place.id -> address/number/complement removidos pra evitar 422")

    # Remove None top-level pra nao confundir o backend (excecao: campos de
    # data que tem "validity" no nome ou birth — esses sao "sempre enviar"
    # para permitir limpeza/sobrescrita explicita; mas como geramos via
    # _br_para_iso, se eh None significa "campo nao veio", entao tira mesmo).
    return {k: v for k, v in body.items() if v is not None}, geo_result


def _confirmar_anexos_driver(client: AngellraAPIClient, driver_id: int) -> list[str]:
    """GET driver e mapeia has*Image flags -> ['cnh','rg','consentForm']."""
    try:
        d = drivers.find_by_id(client, driver_id) or {}
    except Exception as exc:
        log_alerta(f"[flow_motorista_api] erro GET driver pra confirmar anexos: {exc}")
        return []
    confirmados = []
    if d.get("hasCNHImage"): confirmados.append("cnh")
    if d.get("hasRGImage"): confirmados.append("rg")
    if d.get("hasConsentFormFile"): confirmados.append("consentForm")
    return confirmados


def _upload_anexos_driver(client: AngellraAPIClient, driver_id: int, anexos: dict | None) -> list[str]:
    """Aplica CNH+RG no mesmo PATCH multipart (preserva campos de data).

    Regra: se houver `cnh` mas nao `rg`, usa o mesmo arquivo da CNH como RG
    (replica o comportamento do robo Selenium original).
    """
    if not anexos:
        return []
    cnh_path = anexos.get("cnh") or anexos.get("cnh_motorista")
    rg_path = anexos.get("rg") or anexos.get("rg_motorista") or cnh_path

    if not (cnh_path or rg_path):
        return []

    # Pega o estado atual pra preservar datas no PATCH multipart
    preserve = None
    preserve_phones = None
    try:
        atual = drivers.find_by_id(client, driver_id) or {}
        preserve = {k: atual.get(k) for k in drivers.CAMPOS_DATA if atual.get(k)}
        preserve_phones = atual.get("phones") or []
    except Exception as exc:
        log_alerta(f"[flow_motorista_api] nao consegui ler estado pra preservar datas/phones: {exc}")

    try:
        drivers.upload_attachments(client, driver_id,
                                   cnh_path=cnh_path,
                                   rg_path=rg_path,
                                   preserve_dates=preserve,
                                   preserve_phones=preserve_phones)
        aplicados = []
        if cnh_path: aplicados.append("cnh")
        if rg_path: aplicados.append("rg")
        reusado = (rg_path == cnh_path and not (anexos.get("rg") or anexos.get("rg_motorista")))
        log_info(f"[flow_motorista_api] anexos {aplicados} enviados pra driverId={driver_id}"
                 + (" (RG reusou CNH)" if reusado else ""))
        return aplicados
    except Exception as exc:
        log_alerta(f"[flow_motorista_api] falha upload anexos: {exc}")
        return []


def cadastrar_motorista(
    payload: dict,
    *,
    anexos: dict | None = None,
    prime: int = queries.PRIME_NORMAL,
    type_id: int = TYPE_FUNCIONARIO,
) -> dict:
    """Executa o cadastro completo de motorista via API.

    Args:
        payload: dict no formato `{motorista, cnh, endereco}` (Node bot).
        prime: 0=NORMAL, 1=PRIME, 2=PRIME PLUS.
        type_id: tipo de motorista (25=Funcionario, 26=Agregado, ...).

    Returns:
        {ok, salvou, etapa, driverId, queryId, erro, duracao_s}
    """
    inicio = time.monotonic()
    motorista = payload.get("motorista") or {}
    cnh = payload.get("cnh") or {}
    endereco = payload.get("endereco") or {}

    cpf = extrair_numeros(motorista.get("cpf") or "")
    if len(cpf) != 11:
        return _erro("validacao", f"CPF invalido: {motorista.get('cpf')!r}", inicio)

    # NEW (2026-05-26): se o JSON nao tem nenhum dado de endereco, aborta
    # imediatamente — sem CEP, UF+cidade ou logradouro nao da pra ancorar
    # endereco nem com a estrategia de fallback. Decisao do escritorio: so
    # falhar quando o JSON nao trouxer nenhum dado, em vez de seguir adiante
    # e cair em pending_manual sem chance de completar.
    _endereco_minimo = bool(
        (endereco.get("cep") or "").strip()
        or (
            (endereco.get("uf") or "").strip()
            and (endereco.get("cidade") or "").strip()
        )
        or (endereco.get("logradouro") or "").strip()
    )
    if not _endereco_minimo:
        return _erro(
            "endereco_vazio",
            "Payload sem dados minimos de endereco (precisa CEP, ou UF+cidade, ou logradouro)",
            inicio,
        )

    log_info(f"[flow_motorista_api] iniciando cadastro CPF={cpf} nome={motorista.get('nome')!r}")

    # PERFORMANCE 2026-05-26: usa singleton compartilhado (login 1x por processo,
    # nao por cadastro). Refresh automatico em 401 ja existe no _fetch_with_retry.
    try:
        client = get_shared_client()
    except Exception as exc:
        return _erro("login", f"Login Angellira falhou: {exc}", inicio)

    # PERFORMANCE 2026-05-26: prechecks paralelos.
    # 1a) Precheck de situacao (consulta no /query — pode levar 1-3s)
    # 1b) Precheck de existencia (GET /drivers/cpf — pode levar 300-800ms)
    # Ambos sao independentes e o resultado e usado de qualquer jeito (exceto
    # quando 1a retorna CONFORME, ai 1b vira trabalho desperdicado — mas isso
    # eh ok, CONFORME e o caso raro de "ja ta tudo certo, nada a fazer").
    # Rodando paralelo, ganhamos ~800ms-2s por cadastro no caminho comum.
    pc = None
    existente = None
    precheck_exc: Exception | None = None
    find_exc: Exception | None = None
    with ThreadPoolExecutor(max_workers=2) as _pool:
        fut_pc = _pool.submit(verificar_motorista_via_api, cpf, client)
        fut_find = _pool.submit(drivers.find_by_cpf, client, cpf)
        try:
            pc = fut_pc.result()
        except Exception as exc:
            precheck_exc = exc
        try:
            existente = fut_find.result()
        except Exception as exc:
            find_exc = exc

    if precheck_exc is not None:
        log_alerta(f"[flow_motorista_api] precheck situacao falhou (seguindo cadastro): {precheck_exc}")

    if find_exc is not None:
        return _erro("precheck", f"GET /drivers/cpf falhou: {find_exc}", inicio)

    # 1a) Se CONFORME (cadastro vigente, dentro da validade), encerra sem
    # disparar o cadastro. NAO_CONFORME / NAO_ENCONTRADO / INCONCLUSIVO seguem
    # o fluxo normal (update ou create).
    if pc is not None and pc.status == "ENCONTRADO" and pc.situacao == "CONFORME":
        duracao = round(time.monotonic() - inicio, 2)
        log_info(
            f"[flow_motorista_api] motorista CPF={cpf} ja CONFORME — "
            f"encerrando sem cadastro ({pc.evidencia})"
        )
        return {
            "ok": True,
            "salvou": False,
            "ja_cadastrado": True,
            "situacao": "CONFORME",
            "etapa": "conforme",
            "evidencia": (pc.evidencia or "")[:120],
            "erro": None,
            "duracao_s": duracao,
        }

    # 2) Constroi payload API
    try:
        body, geo_result = _construir_payload_driver(
            client, motorista, cnh, endereco,
            prime=prime, type_id=type_id,
        )
    except Exception as exc:
        log_erro(f"[flow_motorista_api] erro construindo payload: {exc}")
        return _erro("payload", f"Erro montando payload: {exc}", inicio)

    if endereco.get("cep") and not geo_result:
        log_alerta(f"[flow_motorista_api] CEP {endereco.get('cep')!r} nao resolvido — endereco ficara incompleto")

    # 3) Cria ou atualiza
    #    OBSERVACAO: o backend tem bug — PATCH com qualquer subset de campos
    #    de endereco (address/cityId/neighborhoodId/...) retorna 422 .split()
    #    sem persistir. So no POST (criacao) o endereco e aceito. Entao na
    #    UPDATE pulamos os campos de endereco; o operador atualiza via portal
    #    quando precisar trocar endereco.
    try:
        flag_owner = bool(body.get("owner"))
        if flag_owner:
            log_info("[flow_motorista_api] flag owner=True no payload — backend vinculará motorista como proprietário automaticamente")
        if existente:
            driver_id = existente["id"]
            log_info(f"[flow_motorista_api] motorista ja existe — driverId={driver_id} (UPDATE)")
            body_update = {k: v for k, v in body.items()
                           if k not in drivers.CAMPOS_ENDERECO}
            drivers.patch(client, driver_id, body_update)
        else:
            log_info("[flow_motorista_api] motorista nao existe — POST /drivers")
            # CRITICO: a API Angellira nao persiste address/city/neighborhood/place
            # via POST/PATCH /drivers — backend auto-resolve via CPF e nao deixa
            # sobrescrever (422 "Cid_Codigo undefined"). MAS number e complement
            # SAO aceitos. Stripamos so address/city/neighborhood/place; mantemos
            # number/complement do OCR pra que a casa do motorista fique correta.
            body_create = {k: v for k, v in body.items()
                           if k not in ("address", "city", "neighborhood", "place")}
            try:
                criado = drivers.create(client, body_create)
            except Exception as exc_create:
                # POST as vezes retorna 422 .split mas PERSISTE o driver.
                # Antes de desistir, checa via find_by_cpf.
                log_alerta(f"[flow_motorista_api] POST /drivers falhou ({exc_create}); verificando se driver foi criado mesmo assim...")
                verif = drivers.find_by_cpf(client, cpf)
                if not verif:
                    return _erro("create", f"POST /drivers falhou e driver nao existe: {exc_create}", inicio)
                criado = verif
                log_info(f"[flow_motorista_api] driver persistido apesar do erro POST — id={verif.get('id')}")
            driver_id = criado.get("id")
            if not driver_id:
                return _erro("create", f"POST /drivers nao devolveu id: {criado}", inicio)
            log_info(f"[flow_motorista_api] driver criado id={driver_id}")
    except Exception as exc:
        return _erro("write", f"POST/PATCH /drivers falhou: {exc}", inicio)

    # 4) Garante que campos de data ficaram persistidos (patch agrupado).
    #    O backend zera campos do mesmo grupo se voce nao reenvia juntos.
    try:
        atual = drivers.find_by_id(client, driver_id)
        if atual is None:
            return _erro("verify", f"driver id={driver_id} sumiu apos create", inicio)
        # Verifica se algum dos campos de data ainda esta None mas tinha sido enviado
        precisa_grupo = False
        for campo in drivers.CAMPOS_DATA:
            if body.get(campo) and not atual.get(campo):
                precisa_grupo = True
                break
        if precisa_grupo:
            log_info("[flow_motorista_api] patch agrupado de datas (backend zerou alguma)")
            payload_datas = {c: body[c] for c in drivers.CAMPOS_DATA if body.get(c)}
            drivers.patch(client, driver_id, payload_datas)
        # Best-effort: PATCH number+complement caso o backend tenha resetado.
        # Sao os UNICOS campos de endereco que a API aceita atualizar (address/
        # city/place todos rejeitam 422). Sem isso o numero da casa fica 0.
        try:
            num_atual = atual.get("number") if atual else 0
            num_payload = body.get("number") or 0
            compl_atual = (atual or {}).get("complement") or ""
            compl_payload = body.get("complement") or ""
            patch_addr = {}
            if num_payload and num_payload != num_atual:
                patch_addr["number"] = num_payload
            if compl_payload and compl_payload != compl_atual:
                patch_addr["complement"] = compl_payload
            if patch_addr:
                drivers.patch(client, driver_id, patch_addr)
                log_info(f"[flow_motorista_api] PATCH number/complement aplicado: {patch_addr}")
        except Exception as exc:
            log_alerta(f"[flow_motorista_api] PATCH number/complement falhou (best-effort): {exc}")
    except Exception as exc:
        log_alerta(f"[flow_motorista_api] aviso no verify/patch agrupado: {exc}")

    # 5) Anexos (CNH, RG) — antes do preflight, porque o backend usa o OCR
    #    dos arquivos pra completar campos faltantes (cnhValidity etc.)
    anexos_aplicados = _upload_anexos_driver(client, driver_id, anexos)

    # 6) Detectar se driver tem endereco preenchido — sem isso, preflight
    #    bloqueia com `incomplete={'driverId': ['address', 'city']}`. A API
    #    Angellira nao aceita address/city via POST/PATCH (verificado), entao
    #    se ainda nao tem, retorna pending_manual pro operador corrigir no
    #    portal e redispatch depois.
    # Check rigoroso: o preflight da Angellira valida address + city.id +
    # neighborhood.id + place.id. Pra driver shell o backend pode retornar
    # city: {id: <algum>} mesmo sem endereco real, dando falso positivo no
    # check antigo (apenas address+city.id). Resultado: caia no preflight
    # logo depois e falhava com `incomplete={'driverId': ['address', 'city']}`.
    try:
        atual2 = drivers.find_by_id(client, driver_id) or {}
        _city = atual2.get("city") or {}
        _neigh = atual2.get("neighborhood") or {}
        _place = atual2.get("place") or {}
        has_address = bool(
            atual2.get("address")
            and _city.get("id")
            and _neigh.get("id")
            and _place.get("id")
        )
        if not has_address:
            log_info(
                f"[flow_motorista_api] has_address=False: address={bool(atual2.get('address'))} "
                f"city.id={_city.get('id')} neighborhood.id={_neigh.get('id')} place.id={_place.get('id')}"
            )
    except Exception:
        has_address = False

    # 6.5) Sem fallback Selenium — decisao arquitetural 2026-05-20: a API publica
    # nao aceita setar address (W1 / 12+ probes / caso JULIVALDO). O fallback
    # Selenium do portal web era fragil (XPaths quebram, save nao persistia,
    # 3+ min por tentativa) e gerava drivers parciais. Removido. Quando o backend
    # nao auto-resolve endereco, caimos direto em pending_manual com link pro
    # portal + redispatch.
    if not has_address:
        # MUDANCA DE LOGICA: nao tratamos mais como ERRO. Driver foi criado
        # com sucesso na Angellira; falta apenas o endereco pra rodar consulta
        # final. A API publica nao deixa setar endereco (limitacao do backend),
        # entao retornamos OK + consulta_pendente=True. Operador completa
        # endereco no portal quando puder e redispatch roda so a consulta.
        # Sem Selenium, sem erro vermelho — cadastro aceito como estado parcial.
        duracao = round(time.monotonic() - inicio, 2)
        msg_operador = (
            f"Driver {driver_id} criado com sucesso. Para finalizar a consulta, "
            f"complete o endereço (cidade/bairro/rua/número) no portal Angellira "
            f"e redispatch o motorista — só a consulta será executada."
        )
        log_info(f"[flow_motorista_api] driver criado, consulta pendente por endereco: {msg_operador}")
        return {
            "ok": True,
            "salvou": True,
            "ja_cadastrado": False,
            "consulta_pendente": True,
            "etapa": "criado_consulta_pendente",
            "driverId": driver_id,
            "queryId": None,
            "anexos_aplicados": anexos_aplicados,
            "pending_manual": ["address", "city"],
            "avisos": [msg_operador],
            "erro": None,
            "duracao_s": duracao,
        }

    # 7) Preflight pra confirmar que pode storeQuery
    try:
        pf = queries.preflight(client, prime=prime,
                               query_type_id=queries.QUERY_TYPE_MOTORISTA,
                               driver_id=driver_id)
    except Exception as exc:
        return _erro("preflight", f"preflight falhou: {exc}", inicio)

    summary = pf.get("summary") or {}
    incompletas = pf.get("incompleteEntities") or {}
    recent_query_id = pf.get("recentQueryId")
    if not summary.get("query"):
        if recent_query_id and not incompletas:
            duracao = round(time.monotonic() - inicio, 2)
            log_info(f"[flow_motorista_api] OK driverId={driver_id} ja tem consulta recente queryId={recent_query_id} em {duracao}s")
            return {
                "ok": True, "salvou": False, "ja_cadastrado": True,
                "etapa": "ja_cadastrado_recente",
                "driverId": driver_id, "queryId": recent_query_id,
                "erro": None, "duracao_s": duracao,
                "preflight": pf,
            }
        return _erro(
            "preflight",
            f"preflight bloqueou cadastro: incomplete={incompletas} summary={summary}",
            inicio,
            extra={"driverId": driver_id, "preflight": pf},
        )

    # 6) storeQuery
    try:
        query_id, raw = queries.store_query(
            client, prime=prime,
            query_type_id=queries.QUERY_TYPE_MOTORISTA,
            driver_id=driver_id,
        )
    except Exception as exc:
        return _erro("storeQuery", f"POST /query falhou: {exc}",
                     inicio, extra={"driverId": driver_id})

    anexos_confirmados = _confirmar_anexos_driver(client, driver_id)
    duracao = round(time.monotonic() - inicio, 2)
    log_info(f"[flow_motorista_api] OK driverId={driver_id} queryId={query_id} anexos={anexos_confirmados} em {duracao}s")
    avisos: list[str] = []
    # OCR suspeito (caracteres nao-numericos em campos numericos)
    avisos.extend(_detectar_ocr_suspeito(motorista, cnh))
    address_generic = bool((geo_result or {}).get("_address_generic"))
    if address_generic:
        avisos.append(
            "Endereco generico aplicado (CEP-ancora da capital UF) — operador deve "
            "revisar/corrigir endereco do motorista no portal Angellira."
        )
    # Flag se anexos esperados nao foram aplicados (cnh, rg)
    anexos_esperados = set(k for k in (anexos or {}).keys() if k in ("cnh", "rg"))
    anexos_falha = anexos_esperados - set(anexos_aplicados)
    if anexos_falha:
        avisos.append(f"Anexos NAO aplicados: {sorted(anexos_falha)}")
    return {
        "ok": True,
        "salvou": True,
        "etapa": "completo",
        "driverId": driver_id,
        "queryId": query_id,
        "anexos_aplicados": anexos_aplicados,
        "anexos_confirmados": anexos_confirmados,
        "address_generic": address_generic,
        "avisos": avisos,
        "erro": None,
        "duracao_s": duracao,
        "raw": raw,
    }


def _erro(etapa: str, msg: str, inicio: float, *, extra: dict | None = None) -> dict:
    log_erro(f"[flow_motorista_api] FALHOU em {etapa}: {msg}")
    duracao = round(time.monotonic() - inicio, 2)
    saida = {
        "ok": False,
        "salvou": False,
        "etapa": etapa,
        "duracao_s": duracao,
        "erro": msg,
    }
    if extra:
        saida.update(extra)
    return saida


# ─── Batch paralelo de motoristas (PERFORMANCE 2026-05-26) ───────────────────
# Quando o operador tem N motoristas pra cadastrar (lote vindo de planilha, do
# bot WhatsApp em fila, etc.), processa-los em paralelo economiza 50-80% do
# tempo total. Cada motorista usa o singleton AngellraAPIClient (login 1x) e
# os caches geo (states/cities/cep) que sao thread-safe via _cache_lock.
#
# Rate-limit: default 4 workers paralelos. Aumentar com cuidado — a Angellira
# pode ter limite de conexoes simultaneas por conta. Configuravel via env:
#     ANGELIRA_BATCH_WORKERS=8 python ...
#
# Resultado: lista na MESMA ORDEM do input, com 'erro' por motorista quando
# algum falhar (nao aborta o lote inteiro).


def _default_batch_workers() -> int:
    import os as _os
    raw = (_os.getenv("ANGELIRA_BATCH_WORKERS") or "").strip()
    if not raw:
        return 4
    try:
        n = int(raw)
        return max(1, min(n, 16))  # clamp [1, 16] pra seguranca
    except ValueError:
        return 4


def cadastrar_motoristas_em_lote(
    payloads: list[dict],
    *,
    anexos_por_indice: list[dict | None] | None = None,
    prime: int = queries.PRIME_NORMAL,
    type_id: int = TYPE_FUNCIONARIO,
    max_workers: int | None = None,
) -> list[dict]:
    """Processa N motoristas em paralelo via ThreadPoolExecutor.

    Args:
        payloads: lista de dicts no formato `{motorista, cnh, endereco}` (mesmo
            de cadastrar_motorista).
        anexos_por_indice: lista de anexos por motorista. Se None, ninguem tem
            anexos. Deve ter o mesmo tamanho de payloads quando fornecida.
        prime: PRIME_NORMAL / PRIME_PLUS / PRIME (queries.PRIME_*).
        type_id: tipo do motorista (25=Funcionario default).
        max_workers: threads paralelas. Default vem de ANGELIRA_BATCH_WORKERS
            (4) e eh clamped em [1, 16].

    Returns:
        Lista de resultados na MESMA ORDEM de payloads. Cada item eh o dict
        retornado por cadastrar_motorista() ou um dict de erro caso a thread
        tenha levantado excecao nao tratada.
    """
    if not payloads:
        return []

    n = len(payloads)
    if anexos_por_indice is None:
        anexos_por_indice = [None] * n
    elif len(anexos_por_indice) != n:
        raise ValueError(
            f"anexos_por_indice tamanho {len(anexos_por_indice)} != payloads {n}"
        )

    workers = max_workers if max_workers is not None else _default_batch_workers()
    workers = max(1, min(workers, n))  # nao mais workers que motoristas

    log_info(
        f"[flow_motorista_api.lote] iniciando batch de {n} motorista(s) "
        f"com {workers} worker(s) paralelos"
    )
    inicio = time.monotonic()

    # Pre-aquecer o singleton client antes do pool pra evitar N threads tentando
    # logar ao mesmo tempo (o lock interno cobre, mas economiza disputa)
    try:
        get_shared_client()
    except Exception as exc:
        log_alerta(f"[flow_motorista_api.lote] pre-warm do client falhou: {exc}")

    resultados: list[dict | None] = [None] * n

    def _worker(idx: int) -> tuple[int, dict]:
        payload = payloads[idx]
        anexos = anexos_por_indice[idx]
        try:
            r = cadastrar_motorista(payload, anexos=anexos, prime=prime, type_id=type_id)
        except Exception as exc:
            log_erro(f"[flow_motorista_api.lote] motorista #{idx} falhou (excecao nao tratada): {exc}")
            r = {
                "ok": False, "salvou": False, "etapa": "excecao_lote",
                "duracao_s": 0.0, "erro": f"{type(exc).__name__}: {str(exc)[:200]}",
            }
        return idx, r

    from concurrent.futures import ThreadPoolExecutor as _TPE, as_completed as _ac
    with _TPE(max_workers=workers) as pool:
        futuros = {pool.submit(_worker, i): i for i in range(n)}
        concluidos = 0
        for fut in _ac(futuros):
            try:
                idx, r = fut.result()
            except Exception as exc:
                idx = futuros[fut]
                r = {
                    "ok": False, "salvou": False, "etapa": "futuro_quebrado",
                    "duracao_s": 0.0, "erro": f"{type(exc).__name__}: {str(exc)[:200]}",
                }
            resultados[idx] = r
            concluidos += 1
            cpf_log = (payloads[idx].get("motorista") or {}).get("cpf") or "?"
            status_log = "ok" if r.get("salvou") else ("ja_cadastrado" if r.get("ja_cadastrado") else "erro")
            log_info(
                f"[flow_motorista_api.lote] {concluidos}/{n} concluido — "
                f"idx={idx} cpf={cpf_log} status={status_log}"
            )

    duracao = round(time.monotonic() - inicio, 2)
    ok = sum(1 for r in resultados if r and r.get("ok"))
    com_erro = n - ok
    log_info(
        f"[flow_motorista_api.lote] batch terminado em {duracao}s — "
        f"{ok} ok, {com_erro} com erro (workers={workers})"
    )
    return [r or {"ok": False, "erro": "resultado nulo", "etapa": "interno"} for r in resultados]
