"""Cadastro de veiculo (cavalo OU carreta) 100% via API publica.

Recebe payload no formato do Node bot — `{cavalo}` ou `{carreta}` — e executa:
    1. find_by_plate -> ja existe?
    2. resolve UFs, marca, modelo, municipio para IDs
    3. POST /vehicles ou PATCH se existe
    4. preflight /query (queryTypeId=2 cavalo, 3 carreta)
    5. store_query

Retorna dict no mesmo formato do flow Selenium:
    {ok, salvou, etapa, vehicleId, queryId, erro, duracao_s}
"""

from __future__ import annotations

import time
from typing import Any

from ..helpers import extrair_numeros, limpar_texto
from ..logger import log_alerta, log_erro, log_info
from .client import AngellraAPIClient, get_shared_client
from .precheck import verificar_veiculo_via_api
from . import geo, queries, vehicles


# Defaults
COMPANY_OWNER_ID_DEFAULT = 876943  # GRIFFI — sera lido via config se necessario
RELATIONSHIP_PROPRIA = 1

# Owners "genericos/fantasma" da Angellira — placeholders que aparecem em
# veiculos antigos sem proprietario real. Sao seguros pra sobrescrever
# quando o flow tem um owner real resolvido via CPF/CNPJ.
OWNERS_GENERICOS = {
    876943,    # GRIFFI TRANSPORTES (default da empresa logada)
    12083636,  # TRANSPORTADOR N0 (placeholder Angellira)
}


def _http_status_from_exc(exc: Exception) -> int | None:
    """Extrai status_code de um HTTPError do requests; None se nao for HTTPError."""
    try:
        resp = getattr(exc, "response", None)
        return getattr(resp, "status_code", None)
    except Exception:
        return None


def _resolver_409_por_chave_alternativa(
    client: AngellraAPIClient, body: dict, exc: Exception
) -> dict | None:
    """POST /vehicles retornou 409? Veiculo ja existe por renavam/chassis mesmo
    que find_by_plate nao tenha achado — comum quando placa mudou (renovacao
    Mercosul), foi cadastrada com formato diferente, ou ha conflito por outro
    veiculo com mesmo chassis/renavam.

    Retorna o dict do veiculo encontrado, ou None se realmente nao acharmos.
    """
    if _http_status_from_exc(exc) != 409:
        return None

    renavam = (body.get("renavam") or "").strip() if isinstance(body.get("renavam"), str) else body.get("renavam")
    chassis = (body.get("chassis") or "").strip() if isinstance(body.get("chassis"), str) else body.get("chassis")

    for nome, fn, val in (
        ("renavam", vehicles.find_by_renavam, renavam),
        ("chassis", vehicles.find_by_chassis, chassis),
    ):
        if not val:
            continue
        try:
            v = fn(client, val)
            if v and v.get("id"):
                log_info(
                    f"[flow_veiculo_api] _resolver_409: encontrado por {nome}={val} "
                    f"-> id={v['id']} placa_existente={v.get('plate')!r}"
                )
                return v
        except Exception as lookup_exc:
            log_alerta(
                f"[flow_veiculo_api] _resolver_409: lookup por {nome}={val} falhou: {lookup_exc}"
            )
    return None


def _construir_payload_veiculo(
    client: AngellraAPIClient,
    veiculo: dict,
    *,
    owner_id: int,
    relationship: int,
    prime: int = queries.PRIME_NORMAL,
    sub: str = "cavalo",
) -> dict[str, Any]:
    """Mapeia payload PT-BR para body da API.

    Resolve marca/modelo/cidade/uf via lookups na API.
    """
    plate_norm = vehicles.formatar_placa_api(veiculo.get("placa") or "")
    plate_uf = veiculo.get("uf") or ""
    plate_state_id = geo.state_id_from_uf(client, plate_uf)

    plate_city = veiculo.get("municipio") or veiculo.get("cidade") or ""
    plate_city_id = None
    if plate_state_id and plate_city:
        plate_city_id = geo.find_city_by_name(client, plate_state_id, plate_city)

    # Marca / modelo
    brand_id = None
    model_id = None
    marca = veiculo.get("marca") or ""
    if marca:
        brand = vehicles.find_brand(client, marca)
        if brand:
            brand_id = int(brand["id"])
    modelo = veiculo.get("modelo") or ""
    if brand_id and modelo:
        m = vehicles.find_model(client, brand_id, modelo)
        if m:
            model_id = int(m["id"])
        else:
            # Fallback: tenta buscar pelo modelo sem o prefixo de marca.
            # Ex: "IVECO STRALIS 490S46T" -> "STRALIS 490S46T"
            modelo_sem_marca = " ".join(modelo.split()[1:]) if len(modelo.split()) > 1 else ""
            if modelo_sem_marca:
                m2 = vehicles.find_model(client, brand_id, modelo_sem_marca)
                if m2:
                    model_id = int(m2["id"])
                    log_alerta(
                        f"[flow_veiculo_api] modelId: modelo '{modelo}' sem match, "
                        f"encontrado com '{modelo_sem_marca}' -> id={model_id}"
                    )
            # Se ainda None, usa primeiro modelo da marca para nao bloquear o POST.
            # Angellira exige modelId; operador pode corrigir depois no portal.
            if model_id is None and brand_id:
                try:
                    primeiros = vehicles._query_modelos_api(client, brand_id, "")
                    if primeiros:
                        model_id = int(primeiros[0]["id"])
                        log_alerta(
                            f"[flow_veiculo_api] modelId fallback: '{modelo}' nao encontrado "
                            f"pra brand={brand_id}, usando primeiro disponivel id={model_id} "
                            f"({primeiros[0].get('description', '')}). Corrija no portal."
                        )
                except Exception as exc_fb:
                    log_alerta(f"[flow_veiculo_api] falha buscando modelos fallback: {exc_fb}")

    # Eixos / anos / antt como int
    def _int(v, default=0):
        try: return int(extrair_numeros(str(v))) if v else default
        except Exception: return default

    # Tipo (Caminhão Trator -> CAVALO id=1)
    type_id = vehicles.type_id_from_descricao(client, veiculo.get("tipo") or "")
    # Fallback critico: sem typeId, API Angellira retorna 500 ao PATCH com
    # relationship. CRLV de carreta vem como "SEMI-REBOQUE" — fora dos types.
    if not type_id:
        if (sub or "").lower() == "carreta":
            type_id = vehicles.carreta_type_id_por_eixos(_int(veiculo.get("eixos")))
            log_alerta(f"[flow_veiculo_api] typeId fallback carreta -> {type_id} (tipo CRLV: {veiculo.get('tipo')!r}, eixos={veiculo.get('eixos')})")
        else:
            type_id = 1  # CAVALO default
            log_alerta(f"[flow_veiculo_api] typeId fallback cavalo -> 1 (tipo CRLV: {veiculo.get('tipo')!r})")

    # lastLicensing: aceita "04/02/2026" (data completa) ou "2026" (so ano).
    def _ult_lic(s):
        s = (s or "").strip()
        if not s: return None
        if "/" in s and len(s) >= 8:
            try:
                d, m, y = s.split("/")
                return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
            except Exception:
                return None
        if s.isdigit() and len(s) == 4:  # so ano -> 1o de janeiro
            return f"{s}-01-01"
        return None

    # bodyworkId: obrigatorio pra CARRETA, opcional pra CAVALO.
    # Mapeamento por descricao do CRLV (com regra de negocio Lamonica):
    #   "CARROCERIA FECHADA" no CRLV  -> usa BAU (98), nao "CARROCERIA FECHADA" (123)
    #   qualquer carreta sem carroceria explicita -> BAU (98)
    # Regra acordada com operador 2026-05-22: carreta sempre BAU, mesmo que
    # CRLV diga outra coisa. Operador ajusta no portal se for tanque/frigo/etc.
    BAU_ID = 98
    body_id = None
    carroceria_txt = (veiculo.get("carroceria") or "").strip()

    # Regra explicita de mapeamento (CRLV → carroceria portal)
    _carroceria_upper = carroceria_txt.upper()
    if _carroceria_upper in {"CARROCERIA FECHADA", "FECHADA", "BAU"}:
        body_id = BAU_ID
        log_info(f"[flow_veiculo_api] Regra: '{carroceria_txt}' -> BAU (id 98)")
    elif carroceria_txt:
        # Tenta match exato pelo texto do CRLV
        try:
            bodies = vehicles.get_bodies(client)
            import re as _re, unicodedata as _ud
            def _norm(s):
                s = _ud.normalize("NFKD", str(s or "")).encode("ascii","ignore").decode("ascii")
                return _re.sub(r"[^A-Z0-9]", "", s.upper())
            alvo = _norm(carroceria_txt)
            for b in bodies:
                if _norm(b.get("description") or "") == alvo:
                    body_id = int(b["id"]); break
        except Exception as exc:
            log_alerta(f"[flow_veiculo_api] falha resolvendo bodyworkId: {exc}")

    # Fallback final pra CARRETA: SEMPRE usa BAU (regra Lamonica), nao
    # CARRETA-CARGA SECA (15) como antes
    if (sub or "").lower() == "carreta" and not body_id:
        body_id = BAU_ID
        log_alerta(f"[flow_veiculo_api] bodyworkId default {BAU_ID} (BAU) para carreta — carroceria CRLV: {carroceria_txt!r}")

    # CAVALO (typeId tração) NÃO aceita bodyworkId — a API responde 422
    # "bodyworkId is not allowed". Carroceria só existe p/ CARRETA. Mesmo que
    # o CRLV/OCR traga carroceria no cavalo (caso TEO7C91 -> body 128),
    # descartamos aqui pra não derrubar o POST /vehicles do cavalo.
    if (sub or "").lower() != "carreta" and body_id is not None:
        log_alerta(f"[flow_veiculo_api] cavalo não aceita bodyworkId — descartando body_id={body_id}")
        body_id = None

    body: dict[str, Any] = {
        "prime": prime,
        "typeId": type_id,
        "plate": plate_norm,
        "color": (limpar_texto(veiculo.get("cor") or "") or "").upper() or None,
        # RENAVAM BR tem sempre 11 dígitos com zeros à esquerda. Garantimos o
        # zero-pad para que a API do Angellira receba "00340589973" e não
        # 340589973 (int) — alguns gateways dropam zeros se não recebem string
        # de tamanho fixo. zfill(11) é idempotente se já tiver 11 chars.
        "renavam": (extrair_numeros(veiculo.get("renavam") or "") or "").zfill(11) or None,
        "chassis": (limpar_texto(veiculo.get("chassi") or "") or "").upper() or None,
        "axles": _int(veiculo.get("eixos"), 0) or None,
        "ownerId": owner_id,
        "brandId": brand_id,
        "modelId": model_id,
        "bodyworkId": body_id,
        "fabricationYear": _int(veiculo.get("ano_fabricacao")) or None,
        "modelYear": _int(veiculo.get("ano_modelo")) or None,
        "plateStateId": plate_state_id,
        "plateCityId": plate_city_id,
        "relationship": relationship,
        "antt": extrair_numeros(veiculo.get("antt") or "") or None,
        "lastLicensing": _ult_lic(veiculo.get("ultimo_licenciamento") or ""),
    }
    return {k: v for k, v in body.items() if v is not None}


def _confirmar_anexos_veiculo(client: AngellraAPIClient, vehicle_id: int) -> list[str]:
    """GET vehicle e mapeia has*Image flags."""
    try:
        v = vehicles.find_by_id(client, vehicle_id) or {}
    except Exception as exc:
        log_alerta(f"[flow_veiculo_api] erro GET vehicle pra confirmar anexos: {exc}")
        return []
    confirmados = []
    if v.get("hasCRLVImage"): confirmados.append("crlv")
    if v.get("hasPreviousConsentFormFile") or v.get("hasConsentFormFile"): confirmados.append("consentForm")
    return confirmados


def _upload_anexos_veiculo(client: AngellraAPIClient, vehicle_id: int, anexos: dict | None) -> list[str]:
    if not anexos:
        return []
    aplicados: list[str] = []
    crlv_path = anexos.get("crlv") or anexos.get("crlv_cavalo") or anexos.get("crlv_carreta")
    if crlv_path:
        try:
            vehicles.upload_crlv(client, vehicle_id, crlv_path)
            log_info(f"[flow_veiculo_api] CRLV enviada para vehicleId={vehicle_id}")
            aplicados.append("crlv")
        except Exception as exc:
            log_alerta(f"[flow_veiculo_api] falha upload CRLV: {exc}")
    consent_path = anexos.get("consentForm") or anexos.get("termo")
    if consent_path:
        try:
            vehicles.upload_consent_form(client, vehicle_id, consent_path)
            log_info(f"[flow_veiculo_api] termo enviado para vehicleId={vehicle_id}")
            aplicados.append("consentForm")
        except Exception as exc:
            log_alerta(f"[flow_veiculo_api] falha upload termo: {exc}")
    return aplicados


def cadastrar_veiculo(
    payload: dict,
    *,
    anexos: dict | None = None,
    sub: str = "cavalo",
    owner_id: int = 0,
    relationship: int = RELATIONSHIP_PROPRIA,
    prime: int = queries.PRIME_NORMAL,
) -> dict:
    """Cadastra veiculo via API. Retorna dict no formato do runner.

    Args:
        payload: dict no formato `{cavalo: {...}}` ou `{carreta: {...}}`.
        sub:     'cavalo' ou 'carreta' — define queryTypeId e a chave do payload.
        owner_id: id do proprietario REAL. POLITICA ESTRITA 2026-05-27:
                  NUNCA usar owner generico (GRIFFI 876943, TRANSPORTADOR_N0, etc).
                  Se nao informado ou generico, retorna erro com causa clara.
        relationship: 1 = propria (default).
        prime:   0/1/2.
    """
    inicio = time.monotonic()
    sub_norm = (sub or "cavalo").strip().lower()
    chave_payload = sub_norm  # 'cavalo' ou 'carreta'

    # POLITICA ESTRITA: bloqueia chamadas sem owner real.
    # main.py ja barra owners genericos no endpoint, mas adicionamos
    # segunda camada de protecao aqui (scripts/testes que chamem direto).
    if not owner_id or owner_id <= 0:
        return _erro(
            "owner_nao_informado",
            "owner_id obrigatorio e maior que zero. Veiculo nao pode ser cadastrado "
            "sem proprietario real (politica estrita — nao usamos fallback GRIFFI).",
            inicio,
        )
    if owner_id in OWNERS_GENERICOS:
        return _erro(
            "owner_generico_bloqueado",
            f"owner_id={owner_id} eh generico (GRIFFI/TRANSPORTADOR_N0). "
            f"Cadastre o proprietario REAL primeiro.",
            inicio,
        )

    veiculo = payload.get(chave_payload) or payload.get("veiculo") or {}
    if not veiculo:
        return _erro("validacao", f"payload nao tem chave {chave_payload!r}", inicio)

    placa_raw = veiculo.get("placa") or ""
    if not placa_raw:
        return _erro("validacao", "placa obrigatoria", inicio)

    placa = vehicles.formatar_placa_api(placa_raw)
    log_info(f"[flow_veiculo_api] iniciando {sub_norm} placa={placa}")

    try:
        # OTIMIZACAO 2026-05-27: usa singleton em vez de criar AngellraAPIClient + login
        # novo a cada veiculo. Antes: ~600-1500ms de login redundante por cavalo/carreta.
        # get_shared_client() reusa a sessao do processo (mesma do motorista/proprietario).
        client = get_shared_client()
    except Exception as exc:
        return _erro("login", f"Login Angellira falhou: {exc}", inicio)

    # PERFORMANCE 2026-05-27: prechecks paralelos (mesmo padrao de flow_motorista.py).
    # 1a) Precheck de situacao  → consulta /query (1-3s)
    # 1b) Precheck de existencia → GET /vehicles/plate (300-800ms)
    # Ambos sao independentes — paralelizar economiza ~1-2s por veiculo.
    # Quando 1a retorna CONFORME, 1b vira desperdicio mas eh OK (caso raro).
    from concurrent.futures import ThreadPoolExecutor as _TPE_v
    pc = None
    existente = None
    precheck_exc: Exception | None = None
    find_exc: Exception | None = None
    with _TPE_v(max_workers=2) as _pool_v:
        fut_pc = _pool_v.submit(verificar_veiculo_via_api, placa, client=client)
        fut_find = _pool_v.submit(vehicles.find_by_plate, client, placa)
        try:
            pc = fut_pc.result()
        except Exception as exc:
            precheck_exc = exc
        try:
            existente = fut_find.result()
        except Exception as exc:
            find_exc = exc

    # Avalia precheck de situacao: se CONFORME, encerra sem cadastrar
    if precheck_exc is not None:
        log_alerta(f"[flow_veiculo_api] precheck situacao falhou (seguindo cadastro): {precheck_exc}")
    elif pc and pc.status == "ENCONTRADO" and pc.situacao == "CONFORME":
        duracao = round(time.monotonic() - inicio, 2)
        log_info(
            f"[flow_veiculo_api] {sub_norm} placa={placa} ja CONFORME — "
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

    # Avalia precheck de existencia: erro aqui eh terminal (precisa saber se cria ou atualiza)
    if find_exc is not None:
        return _erro("precheck", f"GET /vehicles/plate falhou: {find_exc}", inicio)

    # 2) Constroi payload API
    try:
        body = _construir_payload_veiculo(client, veiculo,
                                          owner_id=owner_id,
                                          relationship=relationship,
                                          prime=prime,
                                          sub=sub_norm)
    except Exception as exc:
        log_erro(f"[flow_veiculo_api] erro construindo payload: {exc}")
        return _erro("payload", f"Erro montando payload: {exc}", inicio)

    # 3) Cria ou atualiza
    try:
        if existente:
            vehicle_id = existente["id"]
            owner_atual = (existente.get("owner") or {}).get("id")
            # Excluir ownerId do PATCH so e perigoso (FK 500) quando o veiculo
            # JA TEM um owner real diferente e ALEM disso tem queries vinculadas.
            # Se owner atual eh None ou um dos owners-fantasma (GRIFFI 876943,
            # TRANSPORTADOR N0 12083636, etc), podemos sobrescrever com seguranca
            # — alias eh ESSENCIAL pra trocar.
            seguro_setar_owner = (
                owner_atual is None
                or owner_atual in OWNERS_GENERICOS
                or (body.get("ownerId") and body["ownerId"] == owner_atual)
            )
            log_info(
                f"[flow_veiculo_api] veiculo ja existe id={vehicle_id} "
                f"owner_atual={owner_atual} owner_payload={body.get('ownerId')} "
                f"setar_owner={seguro_setar_owner}"
            )
            campos_inseguros_patch = {"prime"} if seguro_setar_owner else {"prime", "ownerId"}
            body_safe = {k: v for k, v in body.items() if k not in campos_inseguros_patch}

            # Visibilidade: lista campos VAZIOS no existente que estamos preenchendo
            # com nosso dado atual (cenario "veiculo legado sendo regularizado").
            # Ajuda a entender no log o que o PATCH efetivamente adicionou.
            try:
                campos_preenchendo_legado = []
                for k, v_novo in body_safe.items():
                    v_atual = existente.get(k)
                    eh_vazio = v_atual is None or v_atual == "" or v_atual == 0 or v_atual == []
                    if eh_vazio and v_novo not in (None, "", 0, []):
                        campos_preenchendo_legado.append(f"{k}={v_novo!r}")
                if campos_preenchendo_legado:
                    log_info(
                        f"[flow_veiculo_api] PREENCHENDO LEGADO id={vehicle_id} "
                        f"campos_vazios_atualizados=[{', '.join(campos_preenchendo_legado)}]"
                    )
            except Exception as exc:
                log_alerta(f"[flow_veiculo_api] log diff legado falhou (segue): {exc}")

            if body_safe:
                try:
                    vehicles.patch(client, vehicle_id, body_safe)
                except Exception as exc:
                    # 409 no PATCH: Angellira rejeita quando algum campo único já existe em
                    # outro veículo (mais comum: renavam duplicado). A exception do requests
                    # tem o status_code em exc.response, não no texto da mensagem.
                    # Retenta sem renavam para salvar plateCity/plateState/relationship/ownerId.
                    status_409 = getattr(getattr(exc, "response", None), "status_code", None) == 409
                    if status_409:
                        body_sem_renavam = {k: v for k, v in body_safe.items() if k != "renavam"}
                        if body_sem_renavam:
                            try:
                                vehicles.patch(client, vehicle_id, body_sem_renavam)
                                log_alerta(
                                    f"[flow_veiculo_api] PATCH retentado sem renavam (409 conflito): "
                                    f"campos salvos={list(body_sem_renavam.keys())}. "
                                    f"Renavam duplicado no Angellira — corrija manualmente."
                                )
                            except Exception as exc2:
                                log_alerta(f"[flow_veiculo_api] PATCH sem renavam tambem falhou: {exc2}")
                        else:
                            log_alerta(f"[flow_veiculo_api] PATCH veiculo falhou (best-effort, segue): {exc}")
                    else:
                        log_alerta(f"[flow_veiculo_api] PATCH veiculo falhou (best-effort, segue): {exc}")
        else:
            log_info("[flow_veiculo_api] criando POST /vehicles")
            try:
                criado = vehicles.create(client, body)
                vehicle_id = criado.get("id")
                if not vehicle_id:
                    return _erro("create", f"POST /vehicles sem id: {criado}", inicio)
                log_info(f"[flow_veiculo_api] criado id={vehicle_id}")
            except Exception as create_exc:
                # 409 = veiculo ja existe por renavam/chassis mesmo que
                # find_by_plate nao tenha achado. Fallback: tenta lookup
                # por chave alternativa e converte em PATCH.
                existente_alt = _resolver_409_por_chave_alternativa(client, body, create_exc)
                if not existente_alt:
                    raise
                vehicle_id = existente_alt["id"]
                owner_atual = (existente_alt.get("owner") or {}).get("id") if existente_alt.get("owner") else None
                seguro_setar_owner = (
                    owner_atual is None
                    or owner_atual in OWNERS_GENERICOS
                    or (body.get("ownerId") and body["ownerId"] == owner_atual)
                )
                log_alerta(
                    f"[flow_veiculo_api] POST 409 — veiculo achado por chave "
                    f"alternativa id={vehicle_id} owner_atual={owner_atual} "
                    f"placa_payload={body.get('plate')!r} placa_existente="
                    f"{existente_alt.get('plate')!r}. Convertendo em PATCH."
                )
                campos_inseguros_patch = {"prime"} if seguro_setar_owner else {"prime", "ownerId"}
                body_safe = {k: v for k, v in body.items() if k not in campos_inseguros_patch}

                # Log de "PREENCHENDO LEGADO" tambem no caminho 409 (mesma logica do
                # branch normal acima — visibilidade de quais campos vazios estamos
                # preenchendo com o dado novo).
                try:
                    campos_preenchendo_legado = []
                    for k, v_novo in body_safe.items():
                        v_atual = existente_alt.get(k)
                        eh_vazio = v_atual is None or v_atual == "" or v_atual == 0 or v_atual == []
                        if eh_vazio and v_novo not in (None, "", 0, []):
                            campos_preenchendo_legado.append(f"{k}={v_novo!r}")
                    if campos_preenchendo_legado:
                        log_info(
                            f"[flow_veiculo_api] PREENCHENDO LEGADO (via 409) id={vehicle_id} "
                            f"campos_vazios_atualizados=[{', '.join(campos_preenchendo_legado)}]"
                        )
                except Exception as exc:
                    log_alerta(f"[flow_veiculo_api] log diff legado (409) falhou (segue): {exc}")

                if body_safe:
                    try:
                        vehicles.patch(client, vehicle_id, body_safe)
                    except Exception as patch_exc:
                        status_409_alt = getattr(getattr(patch_exc, "response", None), "status_code", None) == 409
                        if status_409_alt:
                            body_sem_renavam = {k: v for k, v in body_safe.items() if k != "renavam"}
                            if body_sem_renavam:
                                try:
                                    vehicles.patch(client, vehicle_id, body_sem_renavam)
                                    log_alerta(
                                        f"[flow_veiculo_api] PATCH (via 409) retentado sem renavam: "
                                        f"campos={list(body_sem_renavam.keys())}. Renavam duplicado."
                                    )
                                except Exception as exc3:
                                    log_alerta(f"[flow_veiculo_api] PATCH sem renavam (via 409) falhou: {exc3}")
                        else:
                            log_alerta(
                                f"[flow_veiculo_api] PATCH apos 409 falhou "
                                f"(best-effort, segue): {patch_exc}"
                            )
    except Exception as exc:
        return _erro("write", f"POST/PATCH /vehicles falhou: {exc}", inicio)

    # 4) Anexos (CRLV, termo) antes do preflight
    anexos_aplicados = _upload_anexos_veiculo(client, vehicle_id, anexos)

    # 5) Preflight
    cab_kwarg = "cab_id" if sub_norm == "cavalo" else "tow_id"
    query_type_id = queries.QUERY_TYPE_CAVALO if sub_norm == "cavalo" else queries.QUERY_TYPE_CARRETA
    try:
        pf = queries.preflight(client, prime=prime, query_type_id=query_type_id,
                               **{cab_kwarg: vehicle_id})
    except Exception as exc:
        return _erro("preflight", f"preflight falhou: {exc}", inicio,
                     extra={"vehicleId": vehicle_id})

    summary = pf.get("summary") or {}
    incompletas = pf.get("incompleteEntities") or {}
    recent_query_id = pf.get("recentQueryId")
    if not summary.get("query"):
        if recent_query_id and not incompletas:
            # Ja tem consulta recente vigente — nao duplicar, retornar como sucesso.
            duracao = round(time.monotonic() - inicio, 2)
            log_info(f"[flow_veiculo_api] OK vehicleId={vehicle_id} ja tem consulta recente queryId={recent_query_id} em {duracao}s")
            return {
                "ok": True, "salvou": False, "ja_cadastrado": True,
                "etapa": "ja_cadastrado_recente",
                "vehicleId": vehicle_id, "queryId": recent_query_id,
                "erro": None, "duracao_s": duracao,
                "preflight": pf,
            }
        return _erro(
            "preflight",
            f"preflight bloqueou: incomplete={incompletas} summary={summary}",
            inicio, extra={"vehicleId": vehicle_id, "preflight": pf},
        )

    # 5) storeQuery
    try:
        query_id, raw = queries.store_query(
            client, prime=prime, query_type_id=query_type_id,
            **{cab_kwarg: vehicle_id},
        )
    except Exception as exc:
        return _erro("storeQuery", f"POST /query falhou: {exc}",
                     inicio, extra={"vehicleId": vehicle_id})

    anexos_confirmados = _confirmar_anexos_veiculo(client, vehicle_id)
    duracao = round(time.monotonic() - inicio, 2)
    log_info(f"[flow_veiculo_api] OK vehicleId={vehicle_id} queryId={query_id} anexos={anexos_confirmados} em {duracao}s")
    return {
        "ok": True, "salvou": True, "etapa": "completo",
        "vehicleId": vehicle_id, "queryId": query_id,
        "anexos_aplicados": anexos_aplicados,
        "anexos_confirmados": anexos_confirmados,
        "erro": None, "duracao_s": duracao, "raw": raw,
    }


def _erro(etapa: str, msg: str, inicio: float, *, extra: dict | None = None) -> dict:
    log_erro(f"[flow_veiculo_api] FALHOU em {etapa}: {msg}")
    duracao = round(time.monotonic() - inicio, 2)
    saida = {"ok": False, "salvou": False, "etapa": etapa,
             "duracao_s": duracao, "erro": msg}
    if extra: saida.update(extra)
    return saida
