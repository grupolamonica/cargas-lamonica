"""Cadastro de proprietario (PJ ou PF) 100% via API publica.

Recebe payload do Node bot — `{proprietario_*}` ou `{proprietario: {tipo, payload}}` —
e executa o cadastro via /owners.

Particularidade vs motorista/veiculo: POST /owners cria o owner E a consulta
(queryTypeId=5 = Empresa) numa unica chamada. Retorna {id, queryId}.

Suporta dois tipos:
- PJ (legal): {cnpj, nome (razao social), endereco, telefones, ie?}
- PF (natural): {cpf, nome, cnh, endereco, ...} — espelha estrutura do motorista.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from ..helpers import extrair_numeros, formatar_telefone, limpar_texto
from ..logger import log_alerta, log_erro, log_info
from .client import AngellraAPIClient, get_shared_client
from . import geo, owners, queries


RELATIONSHIP_PROPRIA = 1


def _detectar_ocr_suspeito_owner(prop: dict, tipo: str) -> list[str]:
    """Detecta valores OCR suspeitos em campos numericos do proprietario.

    PF: rg, cpf
    PJ: cnpj, inscricao_estadual
    Casos vistos: OCR confunde "1" com "]", "0" com "O", "8" com "B", etc.
    """
    import re
    avisos = []
    suspeitos = re.compile(r"[^\d\s\.\-/]")
    if (tipo or "").upper() == "PF":
        campos = (("RG (prop)", prop.get("rg")),
                  ("CPF (prop)", prop.get("cpf")))
    else:  # PJ
        campos = (("CNPJ (prop)", prop.get("cnpj")),
                  ("Inscricao Estadual (prop)", prop.get("inscricao_estadual")))
    for nome, val in campos:
        if val and suspeitos.search(str(val)):
            avisos.append(
                f"⚠️ OCR SUSPEITO em {nome}: valor extraido {val!r} contem "
                f"caractere nao-numerico. CONFERIR no portal Angellira."
            )
    return avisos


def _create_com_retry_query_em_andamento(client: AngellraAPIClient, body: dict, max_tentativas: int = 6) -> dict:
    """POST /owners com retry quando backend retorna QUERY1 (query em andamento).

    Caso comum: motorista_eh_proprietario=1 -> dispara motorista (cria query 4)
    -> em seguida dispara proprietario com mesmo CPF -> backend bloqueia
    POST /owners com 'query_in_progress' ate a query do motorista concluir.
    Aguardamos com backoff exponencial (3s, 6s, 12s, 24s, 48s — total ~90s).
    """
    import time as _time
    delay = 3
    for tentativa in range(1, max_tentativas + 1):
        try:
            return owners.create(client, body)
        except Exception as exc:
            msg = str(exc)
            # Detecta QUERY1 / query_in_progress
            is_query_in_progress = (
                "QUERY1" in msg or "query_in_progress" in msg
            )
            if not is_query_in_progress or tentativa >= max_tentativas:
                raise
            log_alerta(
                f"[flow_proprietario_api] backend retornou query_in_progress "
                f"(tentativa {tentativa}/{max_tentativas}) — aguardando {delay}s..."
            )
            _time.sleep(delay)
            delay = min(delay * 2, 60)
    raise RuntimeError("retry esgotado em _create_com_retry_query_em_andamento")


def _phones_para_api(telefones: list, type_id: int = owners.PHONE_TYPE_FIXO) -> list[dict]:
    """Converte lista de telefones do payload (strings ou dicts) para formato API.

    POST /owners exige pelo menos 1 phone com typeId=2 (fixo). Se nao houver
    nenhum, retornamos lista vazia e o caller decide se garante 1 default.
    """
    saida: list[dict] = []
    if not telefones:
        return saida
    for tel in telefones:
        if isinstance(tel, dict):
            num = tel.get("phone") or tel.get("numero") or ""
            tipo = tel.get("typeId") or tel.get("tipo") or type_id
        else:
            num = str(tel or "")
            tipo = type_id
        formatado = formatar_telefone(num)
        if formatado:
            saida.append({"phone": formatado, "typeId": int(tipo)})
    return saida


def _to_int_or_none(valor: Any) -> int | None:
    if valor is None:
        return None
    s = extrair_numeros(str(valor))
    return int(s) if s else None


def _construir_payload_pj(
    client: AngellraAPIClient,
    proprietario: dict,
    *,
    relationship: int,
) -> dict[str, Any]:
    """Monta o body do POST /owners para PJ.

    Espera o payload no formato do Node bot:
        {cnpj, nome, ie, cep, uf, cidade, bairro, logradouro, numero, complemento, telefones}
    """
    cnpj = extrair_numeros(proprietario.get("cnpj") or "")
    cep = extrair_numeros(proprietario.get("cep") or "")

    # Resolve geo via CEP
    geo_result = None
    if cep:
        geo_result = geo.query_cep(client, cep)

    state_id = (geo_result or {}).get("state", {}).get("id") if geo_result else None
    if not state_id:
        state_id = geo.state_id_from_uf(client, proprietario.get("uf") or "")

    city_id = (geo_result or {}).get("city", {}).get("id") if geo_result else None
    if not city_id and state_id and proprietario.get("cidade"):
        city_id = geo.find_city_by_name(client, state_id, proprietario.get("cidade") or "")

    neighborhood_id = (geo_result or {}).get("neighborhood", {}).get("id") if geo_result else None
    neighborhood_name = (
        proprietario.get("bairro")
        or ((geo_result or {}).get("neighborhood") or {}).get("name")
        or ""
    )
    neighborhood_name = (neighborhood_name or "").strip().upper()

    place_id = (geo_result or {}).get("place", {}).get("id") if geo_result else None

    # number como int — o backend rejeita "3-64" (string) ou string com hifen
    number_int = _to_int_or_none(proprietario.get("numero"))

    # Pelo menos 1 phone com typeId=2 (fixo)
    phones = _phones_para_api(proprietario.get("telefones") or [], type_id=owners.PHONE_TYPE_FIXO)
    if not phones:
        # Sem telefone -> dummy fixo (Angellira valida pelo menos 1; operador
        # pode atualizar via portal depois).
        phones = [{"phone": "(00) 0000-0000", "typeId": owners.PHONE_TYPE_FIXO}]

    body: dict[str, Any] = {
        "type": owners.PERSON_LEGAL,
        "name": limpar_texto(proprietario.get("nome") or ""),
        "cnpj": cnpj,
        "relationship": relationship,
        "phones": phones,
        "address": limpar_texto(proprietario.get("logradouro") or "") or None,
        "number": number_int,
        "cep": cep or None,
    }
    # OWNERS usa FLAT (cityId/stateId/neighborhoodId/placeId + neighborhoodName).
    # Schema do POST /owners NAO aceita os objetos nested city/neighborhood/place.
    if city_id: body["cityId"] = city_id
    if state_id: body["stateId"] = state_id
    if neighborhood_id: body["neighborhoodId"] = neighborhood_id
    if neighborhood_name: body["neighborhoodName"] = neighborhood_name
    if place_id: body["placeId"] = place_id
    return {k: v for k, v in body.items() if v is not None}


def _construir_payload_pf(
    client: AngellraAPIClient,
    proprietario: dict,
    *,
    relationship: int,
) -> dict[str, Any]:
    """Monta o body do POST /owners para PF (pessoa fisica).

    PF como proprietario tem campos parecidos com motorista (CNH, RG, etc).
    Esse formato pode precisar ajustes — implementacao defensiva ate termos
    payload real pra validar.
    """
    cpf = extrair_numeros(proprietario.get("cpf") or "")
    cep = extrair_numeros(proprietario.get("cep") or "")
    geo_result = geo.query_cep(client, cep) if cep else None

    state_id = (geo_result or {}).get("state", {}).get("id") if geo_result else None
    if not state_id:
        state_id = geo.state_id_from_uf(client, proprietario.get("uf") or "")
    city_id = (geo_result or {}).get("city", {}).get("id") if geo_result else None
    if not city_id and state_id and proprietario.get("cidade"):
        city_id = geo.find_city_by_name(client, state_id, proprietario.get("cidade") or "")
    neighborhood_id = (geo_result or {}).get("neighborhood", {}).get("id") if geo_result else None
    neighborhood_name = (proprietario.get("bairro") or ((geo_result or {}).get("neighborhood") or {}).get("name") or "").strip().upper()
    place_id = (geo_result or {}).get("place", {}).get("id") if geo_result else None
    number_int = _to_int_or_none(proprietario.get("numero"))

    # PF: Joi exige celular (typeId=3). PJ aceita fixo (typeId=2).
    phones = _phones_para_api(proprietario.get("telefones") or [], type_id=owners.PHONE_TYPE_CELULAR)
    if not phones:
        # Sem telefone explicito — tenta reusar o do motorista (proprietario
        # PF geralmente eh o proprio motorista). So usa dummy se nao achar.
        try:
            from . import drivers as drivers_mod
            d = drivers_mod.find_by_cpf(client, cpf)
            if d and d.get("phones"):
                phones = [{"phone": p.get("phone"), "typeId": owners.PHONE_TYPE_CELULAR}
                          for p in d["phones"] if p.get("phone")]
        except Exception:
            pass
        if not phones:
            phones = [{"phone": "(00) 00000-0000", "typeId": owners.PHONE_TYPE_CELULAR}]

    # data_nascimento "21/12/2000" -> "2000-12-21"
    def _br_iso(s):
        if not s: return None
        try:
            d, m, y = str(s).split("/")
            return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
        except Exception:
            return str(s)[:10] if len(str(s)) >= 10 and str(s)[4] == "-" else None

    rg_uf = proprietario.get("rg_uf") or ""
    rg_state = geo.state_id_from_uf(client, rg_uf) if rg_uf else None

    # Joi do POST /owners (PF) tornou `rg` OBRIGATORIO. Quando OCR da CNH falha
    # em extrair o numero (caso comum em CNHs antigas/borradas), caimos pro CPF
    # como fallback — operador deve corrigir depois no portal AngelLira.
    rg_raw = proprietario.get("rg") or ""
    rg_value = extrair_numeros(rg_raw) or (rg_raw.strip() if isinstance(rg_raw, str) else None) or None
    if not rg_value:
        rg_value = cpf
        log_alerta(
            f"[flow_proprietario_api] OCR nao extraiu RG do proprietario PF "
            f"(CPF={cpf}, nome={proprietario.get('nome')!r}); usando CPF como "
            f"fallback no campo `rg` pra atender Joi `any.required`. "
            f"⚠️ OPERADOR: atualizar RG real no portal AngelLira depois."
        )

    # OBS: o schema PF do POST /owners NAO aceita `relationship` (Joi rejeita).
    # `relationship` so e valido pra PJ.
    body: dict[str, Any] = {
        "type": owners.PERSON_NATURAL,
        "name": limpar_texto(proprietario.get("nome") or ""),
        "cpf": cpf,
        "birth": _br_iso(proprietario.get("data_nascimento") or ""),
        # Pai/mae ausente -> "SEM FILIACAO" (AngelLira exige father/mother nao-vazios).
        "father": limpar_texto(proprietario.get("nome_pai") or "") or "SEM FILIACAO",
        "mother": limpar_texto(proprietario.get("nome_mae") or "") or "SEM FILIACAO",
        "naturalness": limpar_texto(proprietario.get("naturalidade") or "") or None,
        "rg": rg_value,
        "rgOrgan": limpar_texto(proprietario.get("rg_orgao") or "") or None,
        "rgState": rg_state,
        "phones": phones,
        "address": limpar_texto(proprietario.get("logradouro") or "") or None,
        "number": number_int,
        "cep": cep or None,
    }
    # FLAT (idem PJ)
    if city_id: body["cityId"] = city_id
    if state_id: body["stateId"] = state_id
    if neighborhood_id: body["neighborhoodId"] = neighborhood_id
    if neighborhood_name: body["neighborhoodName"] = neighborhood_name
    if place_id: body["placeId"] = place_id
    return {k: v for k, v in body.items() if v is not None}


def _confirmar_anexos_owner(client: AngellraAPIClient, owner_id: int) -> list[str]:
    try:
        o = owners.find_by_id(client, owner_id) or {}
    except Exception as exc:
        log_alerta(f"[flow_proprietario_api] erro GET owner pra confirmar anexos: {exc}")
        return []
    confirmados = []
    if o.get("hasCNHImage"): confirmados.append("cnh")
    if o.get("hasRGImage"): confirmados.append("rg")
    if o.get("hasConsentFormFile"): confirmados.append("consentForm")
    return confirmados


def _upload_anexos_owner(client: AngellraAPIClient, owner_id: int, anexos: dict | None,
                          tipo_norm: str, documento: str | None = None) -> list[str]:
    if not anexos:
        return []
    aplicados: list[str] = []
    # Node bot envia o anexo como 'rg' tanto para PF (cnh do proprietario)
    # quanto para PJ (cartao CNPJ). Mapeamos:
    #   PF -> cnhFile (CNH do proprietario serve como prova)
    #   PJ -> rgFile  (cartao CNPJ como documento corporativo)
    doc_path = anexos.get("rg") or anexos.get("cnh") or anexos.get("cartao_cnpj") or anexos.get("documento")
    if doc_path:
        field = "cnhFile" if tipo_norm == "PF" else "rgFile"
        # Fix #6 reforço (2026-05-21): repassa documento (cpf/cnpj) do payload
        # como known_cpf/known_cnpj pra owners.upload_documento — sem isso, se
        # o GET /owners/{id} não retornar nat.cpf/leg.cnpj, o backend rebaixa
        # pra null e retorna 422 'dataValues'.
        known_cpf = documento if (documento and tipo_norm == "PF") else None
        known_cnpj = documento if (documento and tipo_norm == "PJ") else None
        try:
            owners.upload_documento(client, owner_id, doc_path,
                                     field_name=field,
                                     known_cpf=known_cpf,
                                     known_cnpj=known_cnpj)
            log_info(f"[flow_proprietario_api] {field} enviado para ownerId={owner_id}")
            aplicados.append(field)
        except Exception as exc:
            log_alerta(f"[flow_proprietario_api] falha upload {field}: {exc}")
    return aplicados


def _idade_query_em_segundos(client: AngellraAPIClient, query_id: int | None) -> float | None:
    """Retorna idade (segundos) da query desde sentDate, ou None se não conseguir aferir.

    Usado pelo dedup pré-dispatch (Quick Win #7) pra detectar queries criadas
    nos últimos segundos antes de disparar uma nova (que seria duplicada/paga
    em dobro).

    Robusto: se a query não existe, ou sentDate vier malformado, retorna None
    (o caller deve então seguir o fluxo normal sem dedup).
    """
    if not query_id:
        return None
    try:
        q = queries.fetch(client, int(query_id))
    except Exception as exc:
        log_alerta(f"[flow_proprietario_api] fetch query {query_id} falhou: {exc}")
        return None
    if not q:
        return None
    sent_raw = q.get("sentDate") or q.get("createdAt")
    if not sent_raw:
        return None
    try:
        # API retorna ISO 8601 (ex: '2026-05-21T12:04:53.789Z' ou com offset)
        sent_dt = datetime.fromisoformat(str(sent_raw).replace("Z", "+00:00"))
        if sent_dt.tzinfo is None:
            sent_dt = sent_dt.replace(tzinfo=timezone.utc)
        idade = (datetime.now(timezone.utc) - sent_dt).total_seconds()
        return max(idade, 0.0)
    except Exception as exc:
        log_alerta(f"[flow_proprietario_api] sentDate inválido em queryId={query_id}: {sent_raw!r} ({exc})")
        return None


def cadastrar_proprietario(
    payload: dict,
    *,
    anexos: dict | None = None,
    tipo: str | None = None,
    relationship: int = RELATIONSHIP_PROPRIA,
) -> dict:
    """Cadastra proprietario via API.

    Args:
        payload: dict no formato `{tipo, payload: {...}}` OU `{proprietario_*: {...}}`
                 OU `{cnpj/cpf, nome, ...}` (achatado).
        tipo: 'PJ' ou 'PF'. Se None, detecta pela presenca de cnpj vs cpf.
    """
    inicio = time.monotonic()

    # Aceita varios formatos de payload
    if "payload" in payload and "tipo" in payload:
        tipo = tipo or payload.get("tipo")
        prop = payload.get("payload") or {}
    elif "proprietario_cavalo" in payload:
        prop = payload["proprietario_cavalo"].get("payload") or {}
        tipo = tipo or payload["proprietario_cavalo"].get("tipo")
    elif "proprietario_carreta" in payload:
        prop = payload["proprietario_carreta"].get("payload") or {}
        tipo = tipo or payload["proprietario_carreta"].get("tipo")
    elif "proprietario" in payload:
        sub = payload["proprietario"]
        tipo = tipo or sub.get("tipo")
        prop = sub.get("payload") or sub
    else:
        prop = payload

    # Auto-detecta tipo
    if not tipo:
        tipo = "PJ" if extrair_numeros(prop.get("cnpj") or "") else "PF"
    tipo_norm = tipo.strip().upper()

    if tipo_norm == "PJ":
        documento = extrair_numeros(prop.get("cnpj") or "")
        if len(documento) != 14:
            return _erro("validacao", f"CNPJ invalido: {prop.get('cnpj')!r}", inicio)
    elif tipo_norm == "PF":
        documento = extrair_numeros(prop.get("cpf") or "")
        if len(documento) != 11:
            return _erro("validacao", f"CPF invalido: {prop.get('cpf')!r}", inicio)
    else:
        return _erro("validacao", f"tipo invalido: {tipo!r} (use PJ ou PF)", inicio)

    log_info(f"[flow_proprietario_api] iniciando {tipo_norm} documento={documento}")

    try:
        # OTIMIZACAO 2026-05-27: usa singleton em vez de criar AngellraAPIClient + login
        # novo a cada cadastro. Antes: ~600-1500ms de login redundante por proprietario.
        # get_shared_client() reusa a sessao do processo (mesma do motorista/veiculo).
        client = get_shared_client()
    except Exception as exc:
        return _erro("login", f"Login Angellira falhou: {exc}", inicio)

    # 1) Precheck — ja existe?
    try:
        if tipo_norm == "PJ":
            existente = owners.find_by_cnpj(client, documento)
        else:
            existente = owners.find_by_cpf(client, documento)
    except Exception as exc:
        return _erro("precheck", f"GET /owners falhou: {exc}", inicio)

    # 2) Constroi payload
    try:
        if tipo_norm == "PJ":
            body = _construir_payload_pj(client, prop, relationship=relationship)
        else:
            body = _construir_payload_pf(client, prop, relationship=relationship)
    except Exception as exc:
        log_erro(f"[flow_proprietario_api] erro construindo payload: {exc}")
        return _erro("payload", f"Erro montando payload: {exc}", inicio)

    # OCR suspeito — calculado ja aqui pra incluir em qualquer return path
    avisos_ocr = _detectar_ocr_suspeito_owner(prop, tipo_norm)

    # 3) Cria OU dispara nova consulta para owner existente
    #    POST /owners cria owner + query numa chamada. Se ja existe, usamos
    #    POST /query com queryTypeId=5 (Empresa) + companyId=ownerId.
    try:
        if existente:
            owner_id = existente["id"]
            log_info(f"[flow_proprietario_api] proprietario ja existe id={owner_id} — disparando POST /query")
            # Best-effort: sobrescreve dados do owner existente com payload novo.
            # SEGREDO descoberto: PATCH precisa de `type: 'legal'/'natural'` +
            # `relationship: 1` JUNTOS pra atravessar a Joi do backend. Sem isso
            # ou retorna "relationship not allowed" ou "Relacionamento invalido".
            try:
                tipo_canon = "natural" if tipo_norm == "PF" else "legal"
                # Remove campos que dummy (telefone (00)) — nao queremos sobrescrever
                # numero real com dummy. Mantemos resto.
                payload_phones = body.get("phones") or []
                phones_reais = [p for p in payload_phones
                                if p.get("phone") and not p.get("phone","").startswith("(00)")]
                # Monta body de UPDATE: copia body do POST mas troca type + add fields
                # essenciais. NAO inclui cpf/cnpj (readonly) ja filtrados em owners.patch.
                body_update = {k: v for k, v in body.items()
                               if k not in ("type",) and v is not None}
                body_update["type"] = tipo_canon
                body_update["relationship"] = 1
                if phones_reais:
                    body_update["phones"] = phones_reais
                else:
                    body_update.pop("phones", None)  # nao sobrescreve com dummy
                owners.patch(client, owner_id, body_update)
                log_info(f"[flow_proprietario_api] owner {owner_id} atualizado com dados reais (type={tipo_canon})")
            except Exception as exc:
                log_alerta(f"[flow_proprietario_api] PATCH owner existente falhou: {exc}")
            try:
                pf = queries.preflight(client, prime=0, query_type_id=queries.QUERY_TYPE_EMPRESA,
                                       company_id=owner_id)
                summary = pf.get("summary") or {}
                recent_query_id = pf.get("recentQueryId")
                if not summary.get("query"):
                    if recent_query_id and not (pf.get("incompleteEntities") or {}):
                        duracao = round(time.monotonic() - inicio, 2)
                        return {"ok": True, "salvou": False, "ja_cadastrado": True,
                                "etapa": "ja_cadastrado_recente",
                                "ownerId": owner_id, "queryId": recent_query_id,
                                "avisos": avisos_ocr,
                                "erro": None, "duracao_s": duracao, "preflight": pf}
                    return _erro("preflight", f"preflight bloqueou: {pf}", inicio,
                                 extra={"ownerId": owner_id, "preflight": pf})

                # Quick Win #7 (2026-05-21): dedup pré-dispatch.
                # Mesmo quando o preflight diz "pode disparar query nova", se já
                # existe queryId recente (<60s) pro mesmo owner, retornamos ela
                # em vez de criar nova — evita 2-3 queries cobradas em sequência
                # quando o operador clica em cavalo+carreta+redispatch do mesmo
                # proprietário (caso JAILSON 21/05: 3 queries em 6min).
                idade_query_recente_s = _idade_query_em_segundos(client, recent_query_id)
                if idade_query_recente_s is not None and idade_query_recente_s < 60:
                    duracao = round(time.monotonic() - inicio, 2)
                    log_info(
                        f"[flow_proprietario_api] dedup: queryId={recent_query_id} criada "
                        f"ha {idade_query_recente_s:.0f}s — retornando sem disparar nova"
                    )
                    return {"ok": True, "salvou": False, "ja_cadastrado": True,
                            "etapa": "ja_cadastrado_recente",
                            "ownerId": owner_id, "queryId": recent_query_id,
                            "avisos": avisos_ocr + [
                                f"Reusando consulta criada ha {int(idade_query_recente_s)}s "
                                f"pra evitar cobranca duplicada"
                            ],
                            "erro": None, "duracao_s": duracao, "preflight": pf}

                qid, raw = queries.store_query(client, prime=0,
                                               query_type_id=queries.QUERY_TYPE_EMPRESA,
                                               company_id=owner_id)
                duracao = round(time.monotonic() - inicio, 2)
                log_info(f"[flow_proprietario_api] OK existente ownerId={owner_id} queryId={qid} em {duracao}s")
                return {"ok": True, "salvou": True, "etapa": "completo_existente",
                        "ownerId": owner_id, "queryId": qid,
                        "avisos": avisos_ocr,
                        "erro": None, "duracao_s": duracao, "raw": raw}
            except Exception as exc:
                return _erro("query", f"POST /query falhou: {exc}", inicio,
                             extra={"ownerId": owner_id})
        log_info("[flow_proprietario_api] criando POST /owners")
        criado = _create_com_retry_query_em_andamento(client, body)
    except Exception as exc:
        # FALLBACK (2026-06-25): o POST /owners de PJ às vezes volta 422
        # `query_incomplete: companyId` (precisa do ownerId p/ a query da empresa) OU
        # estoura timeout quando a API AngelLira está lenta — e nesses casos o owner
        # pode já existir (criado num attempt anterior / lookup inicial deu falso-
        # negativo sob carga). Re-busca por documento; se existir, completa pela query
        # (companyId=ownerId), igual ao caminho de owner existente — em vez de erro duro.
        msg = str(exc).lower()
        recuperavel = any(s in msg for s in ("companyid", "query_incomplete", "query2", "timed out", "timeout"))
        if recuperavel:
            try:
                ja = owners.find_by_cnpj(client, documento) if tipo_norm == "PJ" else owners.find_by_cpf(client, documento)
            except Exception:
                ja = None
            owner_id_fb = (ja or {}).get("id")
            if owner_id_fb:
                log_info(f"[flow_proprietario_api] fallback: owner {owner_id_fb} ja existe — disparando query (companyId={owner_id_fb})")
                try:
                    qid_fb, raw_fb = queries.store_query(
                        client, prime=0, query_type_id=queries.QUERY_TYPE_EMPRESA, company_id=owner_id_fb,
                    )
                    duracao = round(time.monotonic() - inicio, 2)
                    return {"ok": True, "salvou": True, "etapa": "completo_fallback_existente",
                            "ownerId": owner_id_fb, "queryId": qid_fb,
                            "avisos": avisos_ocr + [
                                "Owner recuperado por documento apos falha no POST /owners "
                                "(companyId/timeout) — query disparada via fallback.",
                            ],
                            "erro": None, "duracao_s": duracao, "raw": raw_fb}
                except Exception as exc2:
                    return _erro("query_fallback", f"query no fallback falhou: {exc2}", inicio,
                                 extra={"ownerId": owner_id_fb})
        return _erro("write", f"POST /owners falhou: {exc}", inicio)

    owner_id = criado.get("id")
    query_id = criado.get("queryId")
    if not owner_id:
        return _erro("create", f"POST /owners sem id: {criado}", inicio)

    # Upload de anexos (CNH ou cartao CNPJ)
    anexos_aplicados = _upload_anexos_owner(client, owner_id, anexos, tipo_norm, documento=documento)
    anexos_confirmados = _confirmar_anexos_owner(client, owner_id)

    duracao = round(time.monotonic() - inicio, 2)
    log_info(f"[flow_proprietario_api] OK ownerId={owner_id} queryId={query_id} anexos={anexos_confirmados} em {duracao}s")
    avisos: list[str] = []
    # OCR suspeito (rg/cpf PF; cnpj/ie PJ) — usa o ja calculado no inicio do flow
    avisos.extend(avisos_ocr)
    # Anexos esperados vs aplicados
    anexos_esperados = bool(anexos and (anexos.get("rg") or anexos.get("cnh") or
                                         anexos.get("cartao_cnpj") or anexos.get("documento")))
    if anexos_esperados and not anexos_aplicados:
        avisos.append(
            f"⚠️ Documento ({'CNH' if tipo_norm == 'PF' else 'cartao CNPJ'}) NAO foi anexado. "
            f"Subir manualmente no portal Angellira (owner {owner_id})."
        )
    # Phone dummy
    body_phones = body.get("phones") or []
    if any(p.get("phone","").startswith("(00)") for p in body_phones):
        avisos.append(
            "Telefone DUMMY '(00)' aplicado — operador deve atualizar com telefone real no portal."
        )
    return {
        "ok": True, "salvou": True, "etapa": "completo",
        "ownerId": owner_id, "queryId": query_id,
        "anexos_aplicados": anexos_aplicados,
        "anexos_confirmados": anexos_confirmados,
        "anexos_falha": anexos_esperados and not anexos_aplicados,
        "avisos": avisos,
        "erro": None, "duracao_s": duracao,
        "raw": criado,
    }


def _erro(etapa: str, msg: str, inicio: float, *, extra: dict | None = None) -> dict:
    log_erro(f"[flow_proprietario_api] FALHOU em {etapa}: {msg}")
    duracao = round(time.monotonic() - inicio, 2)
    saida = {"ok": False, "salvou": False, "etapa": etapa,
             "duracao_s": duracao, "erro": msg}
    if extra: saida.update(extra)
    return saida
