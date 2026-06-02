"""Orquestracao end-to-end de cadastro de motorista no SPX.

Fluxo equivalente ao que o operador faz no portal:
  1. validate/basic  (early-exit se CPF ja existe)
  2. uploads (CNH front/back, selfie, CRLV + OCR)
  3. validate/detail
  4. submit/check
  5. submit
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from . import constants as K
from . import drivers, lookups, uploads
from .client import APIErro, SPXClient
from .logger import log_alerta, log_erro, log_info


# Campos que a request existente preserva — nao podem ser sobrescritos
# (a SPX bloqueia mudanca via locked_fields que vem no detail)
DEFAULT_LOCKED_FIELDS = {
    "cpf", "license_type", "driver_name", "license_number",
    "license_img_front", "license_img_back",
    "license_expire_date", "birth_day",
}

# ⛔ BLACKLIST: campos que JAMAIS devem ser tocados, mesmo se vazios.
# Fotos, documentos e arquivos uma vez submetidos NAO podem ser substituidos.
FOTOS_E_DOCUMENTOS_BLACKLIST = {
    "driver_photo",
    "license_img_front", "license_img_back",
    "rg_img_front", "rg_img_back",
    "rg_photo_url_list",
    "vehicle_document",
    "risk_assessment_document",
    # Tokens internos do upload
    "biometricsUrl",
}

# ✅ WHITELIST: campos seguros pra complementar quando estiverem vazios.
# Excluem cpf/cnh/birth_day (locked) e fotos/docs (blacklist).
CAMPOS_SEGUROS_COMPLEMENTAR = {
    # Contato / dados pessoais editaveis
    "contact_number", "gender",
    # Endereco
    "city_id", "city_name", "neighbourhood_name", "street_name",
    "address_number", "zip_code",
    # Funcao / estacao
    "contract_type", "function_type_list",
    "linehaul_station_id", "pickup_station_id",
    "delivery_station_id", "return_station_id",
    "feeder_mode", "at_level_handover",
    "allow_feeders_self_trigger_transferred_status",
    # Veiculo (sem documento)
    "vehicle_type", "license_plate", "renavam",
    "vehicle_manufacturer", "vehicle_manufacturing_year",
    "vehicle_owner_name", "plate_number_quantity",
    # CNH metadata (sem foto)
    "cnh_remarks",
    # Risk doc — data, mas NAO o arquivo
    "rad_expire_date",
    # Pickup flags
    "quick_pickup", "quick_pickup_flag",
}


def _esta_vazio(valor: Any) -> bool:
    """Considera vazio: None, '', 0, [], {}. NOT vazio: False (boolean valido)."""
    if valor is None:
        return True
    if isinstance(valor, str):
        return valor.strip() == ""
    if isinstance(valor, (list, dict)):
        return len(valor) == 0
    if isinstance(valor, (int, float)):
        return valor == 0
    return False


def _to_unix_seconds(d: str | int | datetime | None) -> int:
    """Aceita 'YYYY-MM-DD', 'DD/MM/YYYY', datetime, unix int."""
    if d is None or d == "":
        return 0
    if isinstance(d, int):
        return d
    if isinstance(d, datetime):
        return int(d.timestamp())
    s = str(d).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%Y/%m/%d", "%d-%m-%Y"):
        try:
            return int(datetime.strptime(s, fmt).timestamp())
        except ValueError:
            continue
    # ja eh epoch como string?
    try:
        return int(float(s))
    except ValueError:
        raise ValueError(f"data invalida: {d!r}")


def _merge_com_existente(novo: dict, existente: dict, locked: set[str]) -> tuple[dict, list[str]]:
    """Sobrepoe `novo` em `existente`, mas preserva `locked` e descarta keys
    que `novo` traz com valor vazio (operador nao quer mudar).
    """
    avisos: list[str] = []
    out = dict(existente)
    for k, v in (novo or {}).items():
        if v in (None, "", [], 0) and existente.get(k) not in (None, "", []):
            continue  # nao sobrescreve com vazio
        if k in locked and existente.get(k) not in (None, "", []) and v != existente.get(k):
            avisos.append(f"campo locked '{k}' ignorado (mantendo {existente.get(k)!r})")
            out[k] = existente.get(k)
        else:
            out[k] = v
    return out, avisos


def consultar_request_existente(
    client: SPXClient,
    request_id: int,
    *,
    dados_locais: dict | None = None,
) -> dict[str, Any]:
    """READ-ONLY: busca uma driver_request existente no SPX e (opcional)
    compara campo a campo com dados_locais (o cadastro do nosso DB).

    NUNCA escreve no SPX. Apenas le e relata.

    Retorna:
        {
            ok: True,
            etapa: 'consulta',
            request_id, status, status_description, locked_fields,
            dados_spx: { campos do detail },
            comparacao: {           # se dados_locais foi passado
                conferem: bool,
                divergencias: { campo: {local, spx} },
                pendentes_no_spx: [campos vazios no SPX],
                missing_locais: [campos que estao no SPX mas nao no local]
            }
        }
    """
    try:
        det = drivers.get_request_detail(client, request_id, view_only=False)
    except APIErro as exc:
        try:
            det = drivers.get_request_detail(client, request_id, view_only=True)
        except APIErro as exc2:
            return {"ok": False, "etapa": "consulta", "erro": str(exc2), "retcode": exc2.retcode}
    if not det:
        return {"ok": False, "etapa": "consulta", "erro": "Request nao encontrada", "request_id": request_id}

    locked = list((det.get("locked_fields") or []) + list(DEFAULT_LOCKED_FIELDS))

    out = {
        "ok": True,
        "etapa": "consulta",
        "modo": "READ_ONLY",
        "request_id": int(det.get("id") or request_id),
        "status": det.get("request_status"),
        "status_description": (det.get("status") or {}).get("description") if isinstance(det.get("status"), dict) else None,
        "rejected_reason": det.get("rejected_reason"),
        "locked_fields": locked,
        "dados_spx": det,
    }

    if dados_locais:
        divergencias = {}
        pendentes_no_spx = []
        for campo, val_local in (dados_locais or {}).items():
            val_spx = det.get(campo)
            # Pendente no SPX = vazio/null/zero mas presente no local
            if val_local and not val_spx:
                pendentes_no_spx.append(campo)
                continue
            if val_local is None or val_local == "" or val_local == []:
                continue
            # Comparacao tolerante: ambos string, ignora case/espaco/hifen
            def _norm(v):
                if v is None: return None
                s = str(v).strip().upper().replace("-", "").replace(".", "").replace("/", "")
                return s or None
            if _norm(val_local) != _norm(val_spx):
                divergencias[campo] = {"local": val_local, "spx": val_spx}

        out["comparacao"] = {
            "conferem": not divergencias and not pendentes_no_spx,
            "divergencias": divergencias,
            "pendentes_no_spx": pendentes_no_spx,
            "total_campos_comparados": len(dados_locais),
        }

    return out


def complementar_dados_vazios(
    client: SPXClient,
    request_id: int,
    *,
    dados_locais: dict,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Preenche APENAS os campos que estao vazios no SPX, sem sobrescrever
    nada que ja tenha dado. Fotos, documentos e campos locked NUNCA sao tocados.

    Esta operacao eh mais segura que atualizar_request_existente() pois:
    - Le os dados atuais do SPX
    - Identifica campos vazios elegiveis (whitelist - locked - blacklist)
    - Preenche APENAS esses com valores de dados_locais
    - Submete payload completo que preserva fotos/docs existentes (suas URLs nao mudam)

    Args:
        client: SPXClient autenticado
        request_id: id da driver_request a complementar
        dados_locais: dict com candidatos a preencher (ex do nosso cadastro WhatsApp)
        dry_run: se True, retorna o plano sem submeter

    Retorna:
        {
            ok: bool,
            etapa: 'sem_pendencias' | 'complementado' | 'dry_run' | 'erro',
            campos_atualizados: [...],     # quais foram preenchidos
            campos_protegidos: [...],      # quais ficaram porque ja tinham dado
            campos_blacklist: [...],       # quais foram ignorados (foto/doc)
            campos_locked: [...],          # quais sao locked pelo SPX
            payload_final: {...}           # se dry_run
        }
    """
    # 1. Le dados atuais
    try:
        existente = drivers.get_request_detail(client, request_id, view_only=False)
    except APIErro as exc:
        try:
            existente = drivers.get_request_detail(client, request_id, view_only=True)
        except APIErro as exc2:
            return {"ok": False, "etapa": "erro_consulta", "erro": str(exc2)}
    if not existente:
        return {"ok": False, "etapa": "erro_consulta", "erro": "Request nao encontrada"}

    locked = set(existente.get("locked_fields") or []) | DEFAULT_LOCKED_FIELDS

    # 2. Identifica campos que podem ser complementados
    campos_para_preencher: dict[str, Any] = {}
    campos_protegidos: list[str] = []  # ja tem valor — nao toca
    campos_blacklist: list[str] = []   # foto/doc — proibido
    campos_locked: list[str] = []      # SPX bloqueia
    campos_invalidos: list[str] = []   # nao estao na whitelist

    for campo, valor_local in (dados_locais or {}).items():
        # Skip blacklist (fotos/docs)
        if campo in FOTOS_E_DOCUMENTOS_BLACKLIST:
            campos_blacklist.append(campo)
            continue
        # Skip locked fields
        if campo in locked:
            campos_locked.append(campo)
            continue
        # Skip campos fora da whitelist
        if campo not in CAMPOS_SEGUROS_COMPLEMENTAR:
            campos_invalidos.append(campo)
            continue
        # Skip valor local vazio (nao tem o que preencher)
        if _esta_vazio(valor_local):
            continue
        # Skip se SPX ja tem valor
        valor_atual = existente.get(campo)
        if not _esta_vazio(valor_atual):
            campos_protegidos.append(campo)
            continue
        # ✅ Eligible: SPX vazio + local com valor + nao-locked + nao-foto + whitelist
        campos_para_preencher[campo] = valor_local

    if not campos_para_preencher:
        return {
            "ok": True,
            "etapa": "sem_pendencias",
            "msg": "Nenhum campo vazio elegivel pra complementar.",
            "request_id": request_id,
            "campos_protegidos": campos_protegidos,
            "campos_blacklist": campos_blacklist,
            "campos_locked": campos_locked,
            "campos_invalidos": campos_invalidos,
        }

    # 3. Monta payload final: existente + complementos. PRESERVA fotos/docs.
    payload_final = dict(existente)
    payload_final.update(campos_para_preencher)
    payload_final["id"] = int(request_id)

    # Sanitizacao defensiva: garantir que campos da blacklist NAO foram trocados
    for campo in FOTOS_E_DOCUMENTOS_BLACKLIST:
        if campo in existente:
            payload_final[campo] = existente[campo]  # restore se algum merge mexeu

    if dry_run:
        return {
            "ok": True,
            "etapa": "dry_run",
            "request_id": request_id,
            "campos_atualizados": list(campos_para_preencher.keys()),
            "valores_preenchidos": campos_para_preencher,
            "campos_protegidos": campos_protegidos,
            "campos_blacklist": campos_blacklist,
            "campos_locked": campos_locked,
            "campos_invalidos": campos_invalidos,
            "payload_final": payload_final,
            "msg": f"Dry-run: {len(campos_para_preencher)} campos seriam complementados",
        }

    # 4. Submete (draft → detail → submit)
    log_info(f"[complementar] {len(campos_para_preencher)} campos vazios -> {list(campos_para_preencher.keys())}")
    avisos = []
    try:
        drivers.save_draft(client, payload_final, request_id=request_id)
    except APIErro as exc:
        avisos.append(f"draft/save: {exc}")
    try:
        drivers.validate_detail(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "validate_detail",
            "erro": str(exc), "retcode": exc.retcode,
            "campos_atualizados": list(campos_para_preencher.keys()),
            "avisos": avisos,
        }
    try:
        drivers.submit_check(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "submit_check",
            "erro": str(exc), "retcode": exc.retcode, "avisos": avisos,
        }
    try:
        result = drivers.submit(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "submit",
            "erro": str(exc), "retcode": exc.retcode, "avisos": avisos,
        }

    return {
        "ok": True,
        "etapa": "complementado",
        "msg": f"{len(campos_para_preencher)} campo(s) preenchido(s) com sucesso.",
        "request_id": (result or {}).get("request_id") or request_id,
        "driver_id": (result or {}).get("driver_id"),
        "campos_atualizados": list(campos_para_preencher.keys()),
        "campos_protegidos": campos_protegidos,
        "campos_blacklist": campos_blacklist,
        "campos_locked": campos_locked,
        "result": result,
        "avisos": avisos,
    }


# ──────────────────────────────────────────────────────────────────────────
# Completar RASCUNHO existente (retcode 271605026 DRAFT_EXISTS)
# ──────────────────────────────────────────────────────────────────────────
_FOTO_PATH_PARA_CAMPO = {
    "selfie_path": "driver_photo",
    "cnh_frente_path": "license_img_front",
    "cnh_verso_path": "license_img_back",
    "crlv_path": "vehicle_document",
    "risk_doc_path": "risk_assessment_document",
}


def _resolver_lookups_para_rascunho(client, dados_locais, avisos):
    resolvido = {}
    city_name = (dados_locais or {}).get("city_name")
    if city_name:
        try:
            cid = lookups.find_city_id(client, city_name)
            if cid:
                resolvido["city_id"] = cid
        except Exception as exc:
            avisos.append(f"lookup cidade: {exc}")
    vt_name = (dados_locais or {}).get("vehicle_type_name")
    if vt_name:
        try:
            vt = lookups.find_vehicle_type_by_name(client, vt_name)
            if vt:
                resolvido["vehicle_type"] = vt.get("vehicle_type_id") or vt.get("id")
        except Exception as exc:
            avisos.append(f"lookup vehicle_type: {exc}")
    pairs = (("linehaul_station_name", "linehaul"), ("pickup_station_name", "pickup"),
             ("delivery_station_name", "delivery"), ("return_station_name", "return"))
    for pkey, skey in pairs:
        name = (dados_locais or {}).get(pkey)
        if not name:
            continue
        try:
            s = lookups.find_station_by_name(client, name, function_type=skey)
            if s:
                resolvido[f"{skey}_station_id"] = int(s.get("station_id") or 0)
            else:
                avisos.append(f"station nao encontrada ({skey})")
        except Exception as exc:
            avisos.append(f"lookup station {skey}: {exc}")
    return resolvido


def completar_rascunho_existente(client, request_id, *, dados_locais,
    selfie_path=None, cnh_frente_path=None, cnh_verso_path=None,
    crlv_path=None, risk_doc_path=None, do_submit=True, dry_run=False):
    """Completa rascunho existente: sobe fotos faltantes, preenche campos vazios, submete.
    Nunca sobrescreve dados existentes (anti-travamento)."""
    avisos = []
    try:
        existente = drivers.get_request_detail(client, request_id, view_only=False)
    except APIErro:
        try:
            existente = drivers.get_request_detail(client, request_id, view_only=True)
        except APIErro as exc2:
            return {"ok": False, "etapa": "erro_consulta", "erro": str(exc2), "retcode": exc2.retcode}
    if not existente:
        return {"ok": False, "etapa": "erro_consulta", "erro": f"Rascunho {request_id} nao encontrado"}
    locked = set(existente.get("locked_fields") or []) | DEFAULT_LOCKED_FIELDS

    # Detecta swap de veiculo (placa do rascunho diverge da do payload)
    def _norm_plate(p):
        cleaned = (p or "").upper().replace("-", "").replace(" ", "")
        return {x.strip() for x in cleaned.split(",") if x.strip()}
    placa_rascunho_set = _norm_plate(str(existente.get("license_plate") or ""))
    placa_payload_set = _norm_plate(str((dados_locais or {}).get("license_plate") or ""))
    placa_match = bool(placa_rascunho_set & placa_payload_set) if (placa_rascunho_set and placa_payload_set) else False
    vehicle_swap = bool(placa_rascunho_set and placa_payload_set and not placa_match)
    CAMPOS_VEICULO_SWAP = {
        "license_plate", "renavam", "vehicle_manufacturer",
        "vehicle_manufacturing_year", "vehicle_owner_name", "vehicle_type",
    }
    if vehicle_swap:
        log_info(
            f"[completar_rascunho] PLACA DIVERGE rascunho={sorted(placa_rascunho_set)} "
            f"payload={sorted(placa_payload_set)} -> swap completo de veiculo"
        )
        avisos.append(
            f"vehicle_swap: rascunho={sorted(placa_rascunho_set)} payload={sorted(placa_payload_set)}"
        )

    fotos_paths = {"selfie_path": selfie_path, "cnh_frente_path": cnh_frente_path,
                   "cnh_verso_path": cnh_verso_path, "crlv_path": crlv_path,
                   "risk_doc_path": risk_doc_path}
    novas_urls = {}; fotos_subidas = []; fotos_preservadas = []
    for pkey, fpath in fotos_paths.items():
        campo = _FOTO_PATH_PARA_CAMPO[pkey]
        # No swap: sobrescreve APENAS vehicle_document (CRLV do novo veiculo).
        # Risk Doc / selfie / CNH NUNCA sao sobrescritos.
        eh_doc_do_swap = vehicle_swap and pkey == "crlv_path"
        ja_tem = existente.get(campo)
        if ja_tem and not eh_doc_do_swap:
            fotos_preservadas.append(campo); continue
        if not fpath:
            continue
        if dry_run:
            novas_urls[campo] = "DRY_RUN_URL"; fotos_subidas.append(campo); continue
        try:
            if pkey == "selfie_path":
                r = uploads.upload_driver_photo(client, fpath)
            elif pkey in ("cnh_frente_path", "cnh_verso_path"):
                r = uploads.upload_license_image(client, fpath)
            elif pkey == "crlv_path":
                r = uploads.recognize_vehicle_doc(client, fpath)
                ocr_code = (r or {}).get("ocr_result", 0)
                if not K.OCRResult.is_success(ocr_code):
                    avisos.append(f"OCR CRLV ocr_result={ocr_code}")
            elif pkey == "risk_doc_path":
                r = uploads.upload_risk_doc(client, fpath)
            else:
                continue
            url = (r or {}).get("url") or ""
            if url:
                novas_urls[campo] = url; fotos_subidas.append(campo)
            else:
                avisos.append(f"upload {pkey}: sem URL")
        except APIErro as exc:
            return {"ok": False, "etapa": "upload",
                    "erro": f"upload {pkey} falhou: {exc}",
                    "retcode": exc.retcode, "avisos": avisos}
        except FileNotFoundError as exc:
            avisos.append(f"upload {pkey}: arquivo nao encontrado ({exc})")
        except Exception as exc:
            avisos.append(f"upload {pkey} erro: {exc!r}")

    lookups_resolvidos = {}
    try:
        lookups_resolvidos = _resolver_lookups_para_rascunho(client, dados_locais or {}, avisos)
    except Exception as exc:
        avisos.append(f"lookups: {exc!r}")

    candidatos = dict(dados_locais or {})
    candidatos.update(lookups_resolvidos)
    for chave in ("selfie_path", "cnh_frente_path", "cnh_verso_path", "crlv_path", "risk_doc_path",
                  "city_name", "vehicle_type_name",
                  "linehaul_station_name", "pickup_station_name",
                  "delivery_station_name", "return_station_name",
                  "dry_run", "do_draft_save"):
        candidatos.pop(chave, None)

    textuais = {}; protegidos = []; lockedlist = []; invalidos = []
    campos_veiculo_substituidos = []
    for campo, val in candidatos.items():
        if campo in FOTOS_E_DOCUMENTOS_BLACKLIST:
            continue
        if campo in locked:
            lockedlist.append(campo); continue
        if campo not in CAMPOS_SEGUROS_COMPLEMENTAR:
            invalidos.append(campo); continue
        if _esta_vazio(val):
            continue
        # NO SWAP: campos do veiculo sobrescrevem o rascunho.
        if vehicle_swap and campo in CAMPOS_VEICULO_SWAP:
            textuais[campo] = val
            campos_veiculo_substituidos.append(campo)
            continue
        if not _esta_vazio(existente.get(campo)):
            protegidos.append(campo); continue
        textuais[campo] = val

    payload = dict(existente); payload.update(textuais); payload.update(novas_urls)
    payload["id"] = int(request_id)
    for c in FOTOS_E_DOCUMENTOS_BLACKLIST:
        if existente.get(c) and c not in novas_urls:
            payload[c] = existente[c]

    nada_a_fazer = (not textuais) and (not novas_urls)

    if dry_run:
        return {"ok": True, "etapa": "dry_run", "request_id": request_id,
                "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas, "fotos_preservadas": fotos_preservadas,
                "campos_protegidos": protegidos, "campos_locked": lockedlist,
                "campos_invalidos": invalidos, "payload_final": payload,
                "msg": ("Dry-run: nada a complementar." if nada_a_fazer
                        else f"Dry-run: {len(textuais)} textuais + {len(novas_urls)} fotos."),
                "avisos": avisos}

    log_info(f"[completar_rascunho] req={request_id} textuais={list(textuais.keys())} fotos={fotos_subidas}")
    try:
        drivers.save_draft(client, payload, request_id=request_id)
    except APIErro as exc:
        return {"ok": False, "etapa": "draft_save", "erro": str(exc), "retcode": exc.retcode,
                "avisos": avisos, "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas}

    if not do_submit:
        return {"ok": True, "etapa": "rascunho_atualizado", "request_id": request_id,
                "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas, "fotos_preservadas": fotos_preservadas,
                "campos_protegidos": protegidos,
                "msg": ("Rascunho atualizado (sem submit)." if not nada_a_fazer
                        else "Nada a complementar."),
                "avisos": avisos}

    try:
        drivers.validate_detail(client, payload)
    except APIErro as exc:
        dica = ""
        if exc.retcode == K.VALIDATE_DETAIL_REJECTED:
            dica = (
                "Possiveis causas: placa em uso por outro motorista na agencia, "
                "renavam duplicado, CRLV mal lido no OCR, ou conflito entre dados "
                "do rascunho e os dados que enviamos. Verifique o rascunho no portal."
            )
        diag_payload = {k: v for k, v in payload.items() if k not in FOTOS_E_DOCUMENTOS_BLACKLIST and k != "biometricsUrl"}
        return {"ok": False, "etapa": "validate_detail", "erro": str(exc), "retcode": exc.retcode,
                "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas, "avisos": avisos,
                "dica": dica, "payload_diag": diag_payload,
                "existing_request_id": request_id}
    try:
        drivers.submit_check(client, payload)
    except APIErro as exc:
        diag_payload = {k: v for k, v in payload.items() if k not in FOTOS_E_DOCUMENTOS_BLACKLIST and k != "biometricsUrl"}
        return {"ok": False, "etapa": "submit_check", "erro": str(exc), "retcode": exc.retcode,
                "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas, "avisos": avisos,
                "payload_diag": diag_payload, "existing_request_id": request_id}
    try:
        result = drivers.submit(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "submit", "erro": str(exc), "retcode": exc.retcode,
                "campos_atualizados": list(textuais.keys()),
                "fotos_subidas": fotos_subidas, "avisos": avisos,
                "existing_request_id": request_id}

    return {"ok": True, "etapa": "rascunho_completado",
            "msg": f"Rascunho complementado e submetido. {len(textuais)} textual(is) + {len(novas_urls)} foto(s).",
            "request_id": (result or {}).get("request_id") or request_id,
            "driver_id": (result or {}).get("driver_id"),
            "campos_atualizados": list(textuais.keys()),
            "fotos_subidas": fotos_subidas, "fotos_preservadas": fotos_preservadas,
            "campos_protegidos": protegidos, "campos_locked": lockedlist,
            "result": result, "avisos": avisos}


def atualizar_request_existente(
    client: SPXClient,
    request_id: int,
    *,
    # Novas fotos (opcional) — sobem antes do merge
    novo_driver_photo_path: str | None = None,
    novo_license_img_front_path: str | None = None,
    novo_license_img_back_path: str | None = None,
    novo_crlv_path: str | None = None,
    novo_risk_doc_path: str | None = None,
    # Override seletivo de campos (passe apenas os que quer mudar)
    overrides: dict | None = None,
    # Behavior
    dry_run: bool = False,
    do_draft_save: bool = True,
    force_overwrite: bool = False,  # ⚠️ obrigatorio pra realmente atualizar
) -> dict[str, Any]:
    """⚠️ DANGEROUS — Atualiza driver_request existente, SOBRESCREVENDO dados no SPX.

    Por padrao, esta funcao RECUSA-SE a rodar (force_overwrite=False) porque o SPX
    NAO permite reverter alteracoes em dados ja submetidos. Fotos, CNH, RG e
    documentos uma vez subidos NAO podem ser apagados — apenas substituidos por
    novas versoes, e auditados.

    A operacao normal/segura quando motorista ja existe eh APENAS CONSULTAR
    (use `consultar_request_existente`). So passe force_overwrite=True se voce:
    - Tem certeza absoluta de que precisa sobrescrever
    - O motorista nao tem cadastro completo (status rejeitado/pendente)
    - O operador confirmou explicitamente

    Estrategia:
    1. GET detail da request
    2. Sobe novas fotos se passadas (cada upload retorna nova URL)
    3. Faz merge respeitando locked_fields
    4. draft/save com id existente
    5. validate/detail + submit/check + submit
    """
    if not force_overwrite and not dry_run:
        return {
            "ok": False,
            "etapa": "bloqueado_por_seguranca",
            "erro": (
                "Atualizar request existente sobrescreve dados no SPX (fotos, campos, etc) "
                "e NAO PODE ser revertido. Esta operacao foi BLOQUEADA por padrao. "
                "Para fluxo seguro use consultar_request_existente(). "
                "Se realmente quer sobrescrever, passe force_overwrite=True com confirmacao."
            ),
            "request_id": request_id,
        }
    avisos: list[str] = []

    # 1. Detail da request existente
    try:
        existente = drivers.get_request_detail(client, request_id, view_only=False)
    except APIErro as exc:
        try:
            existente = drivers.get_request_detail(client, request_id, view_only=True)
        except APIErro as exc2:
            return {"ok": False, "etapa": "get_detail", "erro": str(exc2), "retcode": exc2.retcode}
    if not existente:
        return {"ok": False, "etapa": "get_detail", "erro": "Request nao encontrada"}

    # locked_fields da request (se vier) + defaults
    locked = set(existente.get("locked_fields") or []) | DEFAULT_LOCKED_FIELDS

    log_info(f"[flow-update] request {request_id} status={existente.get('request_status')} locked={sorted(locked)}")
    if existente.get("rejected_reason"):
        avisos.append(f"motivo de rejeicao anterior: {existente.get('rejected_reason')}")

    # 2. Uploads de fotos novas
    novos = {}
    try:
        if novo_driver_photo_path:
            r = uploads.upload_driver_photo(client, novo_driver_photo_path)
            novos["driver_photo"] = (r or {}).get("url") or ""
        if novo_license_img_front_path:
            r = uploads.upload_license_image(client, novo_license_img_front_path)
            novos["license_img_front"] = (r or {}).get("url") or ""
        if novo_license_img_back_path:
            r = uploads.upload_license_image(client, novo_license_img_back_path)
            novos["license_img_back"] = (r or {}).get("url") or ""
        if novo_crlv_path:
            r = uploads.recognize_vehicle_doc(client, novo_crlv_path)
            novos["vehicle_document"] = (r or {}).get("url") or ""
            ocr_code = (r or {}).get("ocr_result", 0)
            if not K.OCRResult.is_success(ocr_code):
                avisos.append(f"OCR CRLV ocr_result={ocr_code}")
        if novo_risk_doc_path:
            r = uploads.upload_risk_doc(client, novo_risk_doc_path)
            novos["risk_assessment_document"] = (r or {}).get("url") or ""
    except APIErro as exc:
        return {"ok": False, "etapa": "upload", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    # 3. Merge: existente + novos + overrides
    payload, av_locked = _merge_com_existente(novos, existente, locked)
    avisos.extend(av_locked)
    if overrides:
        payload, av_ov = _merge_com_existente(overrides, payload, locked)
        avisos.extend(av_ov)
    # Sempre inclui o id pra reutilizar a request
    payload["id"] = int(request_id)

    if dry_run:
        return {"ok": True, "etapa": "dry_run", "request_id": request_id, "payload_size": len(payload), "avisos": avisos, "payload": payload}

    # 4. draft/save
    if do_draft_save:
        try:
            drivers.save_draft(client, payload, request_id=request_id)
            log_info(f"[flow-update] draft salvo id={request_id}")
        except APIErro as exc:
            avisos.append(f"draft/save falhou: {exc}")

    # 5. validate_detail
    try:
        drivers.validate_detail(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "validate_detail", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    # 6. submit_check
    try:
        check = drivers.submit_check(client, payload)
        if (check or {}).get("vehicle_diff_field"):
            avisos.append(f"vehicle_diff_field={check['vehicle_diff_field']}")
    except APIErro as exc:
        return {"ok": False, "etapa": "submit_check", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    # 7. submit
    try:
        result = drivers.submit(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "submit", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    return {
        "ok": True,
        "etapa": "completo",
        "request_id": (result or {}).get("request_id") or request_id,
        "driver_id": (result or {}).get("driver_id"),
        "result": result,
        "avisos": avisos,
    }


def _analisar_complemento_outra_agencia(
    client: SPXClient,
    cpf_clean: str,
    *,
    placa_nossa: str | None = None,
) -> dict[str, Any] | None:
    """Tenta achar a request existente do motorista (mesmo em outra agencia) e
    verificar se Risk Doc / linehaul estao VAZIOS — esses sao os unicos campos
    que podemos preencher sem sobrescrever nada (regra do operador, 22/05/2026).

    ⚠ SEGURANCA: se `placa_nossa` for passada, compara com a placa registrada no
    perfil SPX. Se DIVERGENTE, marca `placa_divergente: True` no retorno e o
    operador NUNCA deve disparar operacao automatica — risco de travar o
    motorista no SPX (regra de seguranca confirmada 22/05/2026).

    Retorna dict com info pra UI se houver request complementavel, senao None.
    Estritamente: NUNCA mexe em Risk Doc ja preenchido, mesmo que a expiry venceu.
    """
    try:
        rl = drivers.list_requests(client, page=1, count=10, filters={"cpf": cpf_clean})
    except Exception as exc:
        log_alerta(f"[outra_agencia] list_requests falhou: {exc}")
        return None
    items = (rl or {}).get("list") or (rl or {}).get("items") or []
    if not items:
        return None
    req_meta = items[0]
    request_id = req_meta.get("id") or req_meta.get("request_id")
    if not request_id:
        return None
    try:
        detail = drivers.get_request_detail(client, int(request_id), view_only=True)
    except Exception as exc:
        log_alerta(f"[outra_agencia] get_request_detail({request_id}) falhou: {exc}")
        return None
    if not detail:
        return None

    # ⚠ SEGURANCA: Compara a placa cadastrada no perfil com a nossa.
    # Se divergente, BLOQUEIA — enviar placa diferente em validate/basic pode
    # travar o motorista no SPX (regra 22/05/2026).
    placa_spx_raw = str(detail.get("license_plate") or "")
    placa_divergente = False
    placas_comparadas: dict[str, Any] = {}
    if placa_nossa:
        # Normaliza ambas pra comparacao: tira hifen, espaco, vira upper, split por virgula
        def _norm(p: str) -> set[str]:
            cleaned = (p or "").upper().replace("-", "").replace(" ", "")
            return {x.strip() for x in cleaned.split(",") if x.strip()}
        nossa_set = _norm(placa_nossa)
        spx_set = _norm(placa_spx_raw)
        # divergente quando nenhuma placa nossa aparece nas placas do perfil
        if nossa_set and spx_set and not (nossa_set & spx_set):
            placa_divergente = True
        placas_comparadas = {
            "placa_nossa": placa_nossa,
            "placa_spx": placa_spx_raw,
            "nossa_set": sorted(nossa_set),
            "spx_set": sorted(spx_set),
        }

    # Verifica APENAS Risk Doc + linehaul + CRLV vazios (regra estrita)
    risk_doc_atual = detail.get("risk_assessment_document")
    rad_expire_atual = detail.get("rad_expire_date")
    linehaul_atual = detail.get("linehaul_station_id")
    vehicle_doc_atual = detail.get("vehicle_document")

    risk_doc_vazio = _esta_vazio(risk_doc_atual)
    rad_expire_vazio = _esta_vazio(rad_expire_atual)
    linehaul_vazio = _esta_vazio(linehaul_atual)
    vehicle_doc_vazio = _esta_vazio(vehicle_doc_atual)

    campos_vazios = []
    if risk_doc_vazio:
        campos_vazios.append("risk_assessment_document")
    if rad_expire_vazio:
        campos_vazios.append("rad_expire_date")
    if linehaul_vazio:
        campos_vazios.append("linehaul_station_id")
    if vehicle_doc_vazio:
        campos_vazios.append("vehicle_document")

    # Se placa diverge, NUNCA marca como complementavel (mesmo com campos vazios)
    if placa_divergente:
        return {
            "existing_request_id": int(request_id),
            "request_status": detail.get("request_status"),
            "complementavel": False,
            "placa_divergente": True,
            **placas_comparadas,
            "motivo_nao_complementavel": (
                f"⚠ Placa divergente! Nossa placa ({placa_nossa}) NAO bate com a "
                f"cadastrada no SPX ({placa_spx_raw}). Enviar dados divergentes "
                "trava o motorista. Contate a Shopee."
            ),
            "campos_vazios": campos_vazios,  # informativo, mas nao usar
        }

    if not campos_vazios:
        # Nada elegivel — apenas reporta a request mas sem complementar
        return {
            "existing_request_id": int(request_id),
            "request_status": detail.get("request_status"),
            "complementavel": False,
            "placa_divergente": False,
            **placas_comparadas,
            "motivo_nao_complementavel": (
                "Risk Doc, expiry e linehaul ja estao preenchidos na request. "
                "Nada a fazer do nosso lado — somente leitura."
            ),
        }

    return {
        "existing_request_id": int(request_id),
        "request_status": detail.get("request_status"),
        "complementavel": True,
        "placa_divergente": False,
        **placas_comparadas,
        "campos_vazios": campos_vazios,
        "tem_risk_doc_url": not risk_doc_vazio,
        "tem_rad_expire": not rad_expire_vazio,
        "tem_linehaul": not linehaul_vazio,
        "msg": (
            f"Detectei {len(campos_vazios)} campo(s) vazio(s) na request "
            f"(id {request_id}): {', '.join(campos_vazios)}. "
            "Placa confere — operador pode preencher sem sobrescrever."
        ),
    }


def completar_outra_agencia(
    client: SPXClient,
    request_id: int,
    *,
    risk_doc_path: str | None = None,
    rad_expire_date: str | int | datetime | None = None,
    linehaul_station_name: str | None = None,
    crlv_path: str | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Completa SOMENTE campos vazios numa request de motorista em outra agencia.

    Estrategia conservadora:
    1. Detail da request (view_only=False pra editar)
    2. Verifica QUE CAMPOS estao vazios — so esses serao tocados
    3. Sobe Risk Doc se vazio E foi passado novo PDF
    4. Resolve linehaul_station_id se vazio E foi passado nome
    5. Merge final preserva TODO o resto (especialmente fotos/docs preenchidos)
    6. draft/save + validate/detail + submit/check + submit

    Se algum campo eligivel ja estiver preenchido, ele NAO eh tocado (mesmo se a
    expiry venceu — regra do operador 22/05/2026).
    """
    avisos: list[str] = []

    # 1. Detail
    try:
        existente = drivers.get_request_detail(client, request_id, view_only=False)
    except APIErro as exc:
        try:
            existente = drivers.get_request_detail(client, request_id, view_only=True)
        except APIErro as exc2:
            return {"ok": False, "etapa": "get_detail", "erro": str(exc2), "retcode": exc2.retcode}
    if not existente:
        return {"ok": False, "etapa": "get_detail", "erro": "Request nao encontrada"}

    locked = set(existente.get("locked_fields") or []) | DEFAULT_LOCKED_FIELDS
    log_info(f"[outra_ag-completar] request {request_id} locked={sorted(locked)}")

    # 2. Identifica o que pode ser tocado (apenas se VAZIO)
    novos: dict[str, Any] = {}
    motivos_skipped: list[str] = []

    # Risk Doc PDF
    if risk_doc_path:
        if _esta_vazio(existente.get("risk_assessment_document")):
            try:
                r = uploads.upload_risk_doc(client, risk_doc_path)
                url = (r or {}).get("url") or ""
                if url:
                    novos["risk_assessment_document"] = url
                else:
                    motivos_skipped.append("upload_risk_doc: sem url")
            except APIErro as exc:
                return {"ok": False, "etapa": "upload_risk_doc", "erro": str(exc), "retcode": exc.retcode}
        else:
            motivos_skipped.append("risk_assessment_document: ja preenchido (regra estrita: nao toca)")

    # Risk Doc expiry
    if rad_expire_date and _esta_vazio(existente.get("rad_expire_date")):
        novos["rad_expire_date"] = _to_unix_seconds(rad_expire_date)
    elif rad_expire_date:
        motivos_skipped.append("rad_expire_date: ja preenchido")

    # Linehaul station
    if linehaul_station_name and _esta_vazio(existente.get("linehaul_station_id")):
        st = lookups.find_station_by_name(client, linehaul_station_name, function_type="linehaul")
        if st:
            novos["linehaul_station_id"] = int(st.get("station_id") or 0)
        else:
            motivos_skipped.append(f"linehaul station nao encontrada: {linehaul_station_name}")
    elif linehaul_station_name:
        motivos_skipped.append("linehaul_station_id: ja preenchido")

    # CRLV (vehicle_document) — so se vazio, mesma regra estrita do risk_doc.
    # Upload via recognize_vehicle_doc faz OCR automatico; se OCR falhar,
    # registra aviso mas mantem a URL (motorista cadastrado).
    if crlv_path:
        if _esta_vazio(existente.get("vehicle_document")):
            try:
                r = uploads.recognize_vehicle_doc(client, crlv_path)
                url = (r or {}).get("url") or ""
                ocr_code = (r or {}).get("ocr_result", 0)
                if url:
                    novos["vehicle_document"] = url
                    if ocr_code != 0:
                        avisos.append(f"OCR CRLV ocr_result={ocr_code} (nao-zero, conferir manualmente)")
                else:
                    motivos_skipped.append("recognize_vehicle_doc: sem url")
            except APIErro as exc:
                return {"ok": False, "etapa": "upload_crlv", "erro": str(exc), "retcode": exc.retcode}
        else:
            motivos_skipped.append("vehicle_document: ja preenchido (regra estrita: nao toca)")

    if not novos:
        return {
            "ok": True,
            "etapa": "sem_pendencias",
            "msg": "Nada a fazer — todos os campos elegiveis ja estao preenchidos na request.",
            "request_id": request_id,
            "motivos": motivos_skipped,
        }

    # 3. Merge final (preserva TUDO de existente + sobe novos)
    payload_final = dict(existente)
    payload_final.update(novos)
    payload_final["id"] = int(request_id)

    # Sanitizacao: fotos/docs ja existentes NAO podem ser alteradas
    for campo in FOTOS_E_DOCUMENTOS_BLACKLIST:
        if campo == "risk_assessment_document":
            continue  # esse pode ser preenchido SE estiver vazio
        if campo == "vehicle_document":
            continue  # CRLV tambem pode, mesma regra (so se vazio)
        if campo in existente:
            payload_final[campo] = existente[campo]

    if dry_run:
        return {
            "ok": True,
            "etapa": "dry_run",
            "request_id": request_id,
            "campos_atualizados": list(novos.keys()),
            "motivos_skipped": motivos_skipped,
            "msg": f"Dry-run: {len(novos)} campo(s) seriam preenchidos sem sobrescrever nada.",
        }

    # 4. Submete
    log_info(f"[outra_ag-completar] novos campos: {list(novos.keys())}")
    try:
        drivers.save_draft(client, payload_final, request_id=request_id)
    except APIErro as exc:
        avisos.append(f"draft/save: {exc}")
    try:
        drivers.validate_detail(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "validate_detail",
            "erro": str(exc), "retcode": exc.retcode,
            "campos_atualizados": list(novos.keys()),
            "avisos": avisos,
        }
    try:
        drivers.submit_check(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "submit_check",
            "erro": str(exc), "retcode": exc.retcode,
            "campos_atualizados": list(novos.keys()),
            "avisos": avisos,
        }
    try:
        result = drivers.submit(client, payload_final)
    except APIErro as exc:
        return {
            "ok": False, "etapa": "submit",
            "erro": str(exc), "retcode": exc.retcode,
            "campos_atualizados": list(novos.keys()),
            "avisos": avisos,
        }

    return {
        "ok": True,
        "etapa": "complementado",
        "msg": f"Preenchidos {len(novos)} campo(s) vazios sem sobrescrever nada.",
        "request_id": request_id,
        "campos_atualizados": list(novos.keys()),
        "valores_preenchidos": novos,
        "motivos_skipped": motivos_skipped,
        "result": result,
        "avisos": avisos,
    }


def importar_motorista_matched(
    client: SPXClient,
    *,
    cpf: str,
    # Driver_info que veio do validate/basic (com is_matched=True).
    # Usado como FONTE-DE-VERDADE pra dados locked (CNH, foto, endereco, etc).
    driver_info: dict[str, Any],
    # Nossos campos editaveis (overrides opcionais; senao usa driver_info)
    contract_type: int = 364,
    function_type_list: list[int] | None = None,
    linehaul_station_name: str | None = None,
    pickup_station_name: str | None = None,
    delivery_station_name: str | None = None,
    return_station_name: str | None = None,
    # Vehicle: se passar novos, usa; senao usa do driver_info
    vehicle_type_name: str | None = None,
    license_plate: str | None = None,
    renavam: str | None = None,
    vehicle_manufacturer: str | None = None,
    vehicle_manufacturing_year: str | None = None,
    vehicle_owner_name: str | None = None,
    crlv_path: str | None = None,   # se passar, sobe novo CRLV (vehicle_document)
    # Risk Doc — gerado pela unificada
    risk_doc_path: str | None = None,
    rad_expire_date: str | int | datetime | None = None,
    # Behavior
    dry_run: bool = True,
    do_draft_save: bool = False,
    # Fallback de cidade quando driver_info nao traz city_name/city_id resolvivel
    city_name_fallback: str | None = None,
) -> dict[str, Any]:
    """Cria uma driver_request NOSSA reusando um driver_profile existente na Shopee
    que foi detectado via `is_matched=True` no validate/basic.

    Cenario: motorista existe na Shopee (CPF + telefone batem), mas NAO temos
    request nossa pra ele. Em vez de bloquear, importamos: usamos todos os
    dados LOCKED do driver_info (CNH, foto, RG, endereco, telefone) e
    complementamos com NOSSOS dados (linehaul, vehicle, Risk Doc).

    Regra: NUNCA sobe fotos novas (CNH, RG, driver_photo) — usa as URLs que ja
    vieram no driver_info. Apenas Risk Doc e (opcional) CRLV novo.
    """
    avisos: list[str] = []
    cpf_clean = drivers._digits(cpf)
    if not driver_info or not isinstance(driver_info, dict):
        return {"ok": False, "etapa": "importar_matched", "erro": "driver_info ausente"}
    if driver_info.get("cpf") and drivers._digits(str(driver_info.get("cpf"))) != cpf_clean:
        return {
            "ok": False, "etapa": "importar_matched",
            "erro": f"CPF do driver_info ({driver_info.get('cpf')}) nao bate com cpf passado ({cpf_clean})",
        }

    function_type_list = function_type_list or [K.FunctionType.LINEHAUL]

    # ── 1. Resolve IDs (igual cadastrar_motorista_normal) ─────────────
    # City: prioriza driver_info (locked); senao tenta resolver pelo nome;
    # fallback final: city_name_fallback do nosso payload (ex: endereco do wizard).
    city_id = driver_info.get("city_id")
    city_name_di = driver_info.get("city_name", "")
    if not city_id and city_name_di:
        city_id = lookups.find_city_id(client, city_name_di)
    if not city_id and city_name_fallback:
        city_id = lookups.find_city_id(client, city_name_fallback)
    if not city_id:
        return {"ok": False, "etapa": "lookup_cidade", "erro": "city_id ausente no driver_info e nao foi possivel resolver"}

    # Vehicle type: nosso override ou do driver_info
    if vehicle_type_name:
        vt = lookups.find_vehicle_type_by_name(client, vehicle_type_name)
        if not vt:
            return {"ok": False, "etapa": "lookup_vehicle_type", "erro": f"tipo nao encontrado: {vehicle_type_name}"}
        vehicle_type_id = int(vt.get("vehicle_type_id") or vt.get("id") or 0)
    else:
        vehicle_type_id = int(driver_info.get("vehicle_type") or 0)

    def _resolve_station(name: str | None, key: str) -> int:
        if not name:
            return 0
        s = lookups.find_station_by_name(client, name, function_type=key)
        if not s:
            avisos.append(f"station '{name}' nao encontrada em {key} (id=0)")
            return 0
        return int(s.get("station_id") or 0)

    linehaul_id = _resolve_station(linehaul_station_name, "linehaul")
    pickup_id = _resolve_station(pickup_station_name, "pickup")
    delivery_id = _resolve_station(delivery_station_name, "delivery")
    return_id = _resolve_station(return_station_name, "return")

    if not linehaul_id:
        return {"ok": False, "etapa": "lookup_linehaul", "erro": "linehaul_station_id obrigatorio"}

    # ── 2. Uploads — APENAS Risk Doc e (opcional) CRLV novo ─────────
    # JAMAIS sobe driver_photo, license_img_front/back, rg_img — usa do driver_info.
    risk_doc_url = ""
    vehicle_document_url = driver_info.get("vehicle_document") or ""
    crlv_ocr_raw: dict | None = None  # diag: resposta crua do OCR do CRLV
    try:
        if risk_doc_path:
            r = uploads.upload_risk_doc(client, risk_doc_path)
            risk_doc_url = (r or {}).get("url") or ""
        if crlv_path:
            r = uploads.recognize_vehicle_doc(client, crlv_path)
            crlv_ocr_raw = r if isinstance(r, dict) else {"_raw": str(r)}
            vehicle_document_url = (r or {}).get("url") or ""
            ocr_code = (r or {}).get("ocr_result", 0)
            if not K.OCRResult.is_success(ocr_code):
                avisos.append(f"OCR CRLV ocr_result={ocr_code}")
            # Auto-fill do CRLV se nao passou explicitamente
            if not renavam: renavam = str((r or {}).get("renavam") or "")
            if not license_plate: license_plate = str((r or {}).get("license_plate") or "")
            if not vehicle_manufacturer: vehicle_manufacturer = str((r or {}).get("vehicle_manufacturer") or "")
            if not vehicle_manufacturing_year: vehicle_manufacturing_year = str((r or {}).get("vehicle_manufacturing_year") or "")
            if not vehicle_owner_name: vehicle_owner_name = str((r or {}).get("vehicle_owner_name") or "")
    except APIErro as exc:
        return {"ok": False, "etapa": "upload", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    # Vehicle fields: prioriza overrides explicitos, depois driver_info
    license_plate = license_plate or str(driver_info.get("license_plate") or "")
    # SPX as vezes manda placas separadas por virgula (cavalo,carreta) — pega so a primeira
    if "," in license_plate:
        license_plate = license_plate.split(",")[0].strip()
    renavam = renavam or str(driver_info.get("renavam") or "")
    vehicle_manufacturer = vehicle_manufacturer or str(driver_info.get("vehicle_manufacturer") or "")
    vehicle_manufacturing_year = vehicle_manufacturing_year or str(driver_info.get("vehicle_manufacturing_year") or "")
    vehicle_owner_name = vehicle_owner_name or str(driver_info.get("vehicle_owner_name") or "")

    # ── 3. Monta payload usando driver_info como base (locked) ─────────
    # Dados LOCKED do perfil — JAMAIS sobrescritos.
    payload = drivers.build_payload_normal_driver(
        cpf=cpf_clean,
        driver_name=str(driver_info.get("driver_name") or ""),
        contact_number=str(driver_info.get("contact_number") or ""),
        gender=int(driver_info.get("gender") or 1),
        birth_day=int(driver_info.get("birth_day") or 0),
        city_id=int(city_id),
        # Endereco do perfil (locked, usa do SPX)
        neighbourhood_name=str(driver_info.get("neighbourhood_name") or ""),
        street_name=str(driver_info.get("street_name") or ""),
        address_number=str(driver_info.get("address_number") or ""),
        zip_code=str(driver_info.get("zip_code") or ""),
        # Nossos campos:
        contract_type=int(contract_type),
        function_type_list=function_type_list,
        linehaul_station_id=linehaul_id,
        pickup_station_id=pickup_id,
        delivery_station_id=delivery_id,
        return_station_id=return_id,
        # CNH locked do perfil
        license_number=str(driver_info.get("license_number") or ""),
        license_type=int(driver_info.get("license_type") or 0),
        license_expire_date=int(driver_info.get("license_expire_date") or 0),
        cnh_remarks=driver_info.get("cnh_remarks") or [],
        # Veiculo: nossos overrides ou do perfil
        vehicle_type=vehicle_type_id,
        license_plate=license_plate,
        vehicle_manufacturer=vehicle_manufacturer,
        vehicle_manufacturing_year=vehicle_manufacturing_year,
        vehicle_owner_name=vehicle_owner_name,
        renavam=renavam,
        # Fotos/docs do perfil — NUNCA sobrescritos
        driver_photo=str(driver_info.get("driver_photo") or ""),
        license_img_front=str(driver_info.get("license_img_front") or ""),
        license_img_back=str(driver_info.get("license_img_back") or ""),
        vehicle_document=vehicle_document_url,
        # Risk Doc — nosso (gerado pela unificada)
        risk_assessment_document=risk_doc_url,
        rad_expire_date=_to_unix_seconds(rad_expire_date) if rad_expire_date else 0,
    )

    # Diagnostico/relatorio sobre o que veio do perfil vs nosso
    origem_campos = {
        "driver_name": "perfil_spx (locked)",
        "contact_number": "perfil_spx (locked)",
        "license_number": "perfil_spx (locked)",
        "license_img_front": "perfil_spx (locked) — nao tocamos",
        "license_img_back": "perfil_spx (locked) — nao tocamos",
        "driver_photo": "perfil_spx (locked) — nao tocamos",
        "city_id": f"perfil_spx ({city_name_di})",
        "neighbourhood_name": "perfil_spx (locked)",
        "street_name": "perfil_spx (locked)",
        "linehaul_station_id": f"nosso ({linehaul_station_name})",
        "contract_type": f"nosso ({contract_type})",
        "vehicle_type": f"{'nosso (' + (vehicle_type_name or '?') + ')' if vehicle_type_name else 'perfil_spx'}",
        "risk_assessment_document": "gerado_pela_unificada" if risk_doc_url else "VAZIO",
        "rad_expire_date": "passada" if rad_expire_date else "VAZIO",
    }

    if dry_run:
        return {
            "ok": True,
            "etapa": "dry_run",
            "msg": "Pre-visualizacao — payload pronto pra importar reusando driver_profile existente.",
            "payload": payload,
            "origem_campos": origem_campos,
            "avisos": avisos,
        }

    # ── 4. Draft opcional ────────────────────────────────────────────
    request_id = None
    if do_draft_save:
        try:
            draft = drivers.save_draft(client, payload)
            request_id = (draft or {}).get("id")
        except APIErro as exc:
            avisos.append(f"draft/save: {exc}")

    # ── 5. validate_detail ───────────────────────────────────────────
    try:
        drivers.validate_detail(client, payload)
    except APIErro as exc:
        dica = ""
        if exc.retcode == K.VALIDATE_DETAIL_REJECTED:
            dica = (
                "Possiveis causas: placa em uso por outro motorista na agencia, "
                "renavam duplicado, ou mismatch entre o que enviamos e o que o OCR da "
                "SPX extraiu do CRLV. Veja `crlv_vs_payload` abaixo — qualquer campo "
                "diferente entre 'ocr' e 'enviado' e candidato. Atencao: vehicle_manufacturer "
                "deve bater 1:1 com o OCR (so a marca, ex.: 'VOLVO', nao 'VOLVO/FH 400 6X2T')."
            )
        # Diagnostico: campos do CRLV via OCR vs o que enviamos (pra apontar mismatches)
        crlv_vs_payload = None
        if crlv_ocr_raw:
            campos = ["license_plate", "renavam", "vehicle_manufacturer",
                      "vehicle_manufacturing_year", "vehicle_owner_name", "vehicle_type"]
            crlv_vs_payload = {
                c: {"ocr": crlv_ocr_raw.get(c), "enviado": payload.get(c)}
                for c in campos
            }
        return {"ok": False, "etapa": "validate_detail", "erro": str(exc), "retcode": exc.retcode,
                "payload": payload, "avisos": avisos, "dica": dica,
                "spx_error_data": getattr(exc, "data", None),
                "crlv_ocr": crlv_ocr_raw, "crlv_vs_payload": crlv_vs_payload}

    # ── 6. submit_check ──────────────────────────────────────────────
    try:
        drivers.submit_check(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "submit_check", "erro": str(exc), "retcode": exc.retcode, "payload": payload, "avisos": avisos}

    # ── 7. submit ────────────────────────────────────────────────────
    try:
        result = drivers.submit(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "submit", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    return {
        "ok": True,
        "etapa": "importado",
        "msg": "Driver_profile existente importado pra Lamonica — nova request criada sem sobrescrever dados.",
        "request_id": (result or {}).get("request_id") or request_id,
        "driver_id": (result or {}).get("driver_id"),
        "result": result,
        "origem_campos": origem_campos,
        "avisos": avisos,
    }


def cadastrar_motorista_normal(
    client: SPXClient,
    *,
    # Identificacao
    cpf: str,
    driver_name: str,
    contact_number: str,
    gender: int = K.Gender.MALE,
    birth_day: str | int | datetime,
    # Endereco
    city_name: str,
    neighbourhood_name: str,
    street_name: str,
    address_number: str,
    zip_code: str,
    # Funcao
    contract_type: int,
    function_type_list: list[int],
    linehaul_station_name: str | None = None,
    pickup_station_name: str | None = None,
    delivery_station_name: str | None = None,
    return_station_name: str | None = None,
    feeder_mode: list[int] | None = None,
    at_level_handover: int = K.AtHandover.YES,
    # CNH
    license_number: str,
    license_type: int,
    license_expire_date: str | int | datetime,
    cnh_remarks: list[str] | None = None,
    # Veiculo
    vehicle_type_name: str,
    license_plate: str,
    vehicle_manufacturer: str = "",
    vehicle_manufacturing_year: str = "",
    vehicle_owner_name: str = "",
    renavam: str = "",
    # Arquivos locais (path)
    cnh_frente_path: str | None = None,
    cnh_verso_path: str | None = None,
    selfie_path: str | None = None,
    crlv_path: str | None = None,
    risk_doc_path: str | None = None,
    rad_expire_date: str | int | datetime | None = None,
    # Behavior
    dry_run: bool = False,
    do_draft_save: bool = False,
) -> dict[str, Any]:
    """Cadastra motorista NormalDriver. Retorna dict com resultado e avisos.

    Se motorista ja existe (DRIVER_REPEAT), retorna early com is_matched=True.
    """
    avisos: list[str] = []
    cpf_clean = drivers._digits(cpf)

    # ── 1. Pre-check via validate/basic ──────────────────────────────
    log_info(f"[flow] validate_basic cpf={cpf_clean[:3]}...")
    try:
        pre = drivers.validate_basic(
            client,
            cpf=cpf_clean,
            driver_name=driver_name,
            contact_number=contact_number,
            license_number=license_number,
            is_new_request=True,
            transport_type=K.TransportType.NORMAL_DRIVER,
        )
    except APIErro as exc:
        if exc.retcode == K.CPF_INVALID:
            return {"ok": False, "etapa": "validate_basic", "erro": "CPF invalido", "retcode": exc.retcode}
        if exc.retcode == K.DRAFT_EXISTS:
            # SPX 271605026 - ja tem rascunho aberto. Auto-completa e submete.
            existing_id = None
            try:
                rl = drivers.list_requests(client, page=1, count=10, filters={"cpf": cpf_clean})
                items = (rl or {}).get("list") or (rl or {}).get("items") or []
                rascunhos = [it for it in items if int(it.get("status") or 0) == 1]
                escolhido = (rascunhos or items or [None])[0]
                if escolhido:
                    existing_id = escolhido.get("id") or escolhido.get("request_id")
            except Exception as exc_list:
                log_alerta(f"[flow] DRAFT_EXISTS list_requests falhou: {exc_list!r}")
            if not existing_id:
                return {"ok": False, "etapa": "draft_exists", "retcode": exc.retcode,
                        "erro": "Rascunho existente nao foi localizado"}
            dados_locais = {
                "contact_number": contact_number, "gender": gender,
                "city_name": city_name, "neighbourhood_name": neighbourhood_name,
                "street_name": street_name, "address_number": address_number,
                "zip_code": zip_code, "contract_type": contract_type,
                "function_type_list": function_type_list,
                "linehaul_station_name": linehaul_station_name,
                "pickup_station_name": pickup_station_name,
                "delivery_station_name": delivery_station_name,
                "return_station_name": return_station_name,
                "feeder_mode": feeder_mode, "at_level_handover": at_level_handover,
                "cnh_remarks": cnh_remarks,
                "vehicle_type_name": vehicle_type_name,
                "license_plate": license_plate,
                "vehicle_manufacturer": vehicle_manufacturer,
                "vehicle_manufacturing_year": vehicle_manufacturing_year,
                "vehicle_owner_name": vehicle_owner_name,
                "renavam": renavam, "rad_expire_date": rad_expire_date,
            }
            log_info(f"[flow] DRAFT_EXISTS -> completar_rascunho(req={existing_id})")
            res = completar_rascunho_existente(
                client, request_id=int(existing_id),
                dados_locais=dados_locais,
                selfie_path=selfie_path, cnh_frente_path=cnh_frente_path,
                cnh_verso_path=cnh_verso_path, crlv_path=crlv_path,
                risk_doc_path=risk_doc_path,
                do_submit=True, dry_run=dry_run,
            )
            if isinstance(res, dict):
                res.setdefault("origem", "auto_draft_exists")
                res.setdefault("existing_request_id", int(existing_id))
            return res
        if exc.retcode == K.DRIVER_IN_REVIEW:
            # SPX 271605008 — motorista ja tem solicitacao em REVISAO/aprovacao
            # pendente. Nao eh erro: tenta achar a request existente e devolver
            # os dados pra o painel mostrar status "em revisao".
            existing_id = None
            consulta = None
            try:
                rl = drivers.list_requests(client, page=1, count=10, filters={"cpf": cpf_clean})
                items = (rl or {}).get("list") or (rl or {}).get("items") or []
                if items:
                    existing_id = items[0].get("id") or items[0].get("request_id")
            except Exception:
                pass
            if existing_id:
                try:
                    consulta = consultar_request_existente(client, existing_id)
                except Exception:
                    pass
            return {
                "ok": True,  # informativo, nao bloqueio
                "etapa": "em_revisao",
                "modo": "READ_ONLY",
                "msg": "Motorista em revisao na Shopee — aguarde a aprovacao antes de tentar novamente.",
                "retcode": exc.retcode,
                "existing_request_id": existing_id,
                "dados_spx": (consulta or {}).get("dados_spx"),
                "status_description": (consulta or {}).get("status_description") or "Em revisao",
                "rejected_reason": (consulta or {}).get("rejected_reason"),
                "action_required": "wait_review",
            }
        if exc.retcode == K.DRIVER_IN_OTHER_AGENCY:
            # Motorista existe na Shopee em outra agencia. Por padrao, bloqueio total.
            # MAS: pode haver uma request "nossa" parcial pra ele com Risk Doc + linehaul
            # vazios — nesses casos, podemos COMPLETAR sem sobrescrever nada.
            # Tenta achar a request e analisar campos vazios.
            # ⚠ Passa placa nossa pra detectar divergencia (regra anti-travamento).
            req_complementavel = _analisar_complemento_outra_agencia(
                client, cpf_clean, placa_nossa=license_plate,
            )
            return {
                "ok": False, "etapa": "outra_agencia",
                "erro": (
                    "Motorista esta cadastrado em OUTRA agencia da Shopee. "
                    "O telefone informado nao bate com o cadastrado. "
                    "Confirme o telefone com o motorista ou contate a Shopee."
                ),
                "retcode": exc.retcode,
                "action_required": "verify_phone_or_contact_shopee",
                # Se houver request com campos vazios elegiveis, anexa info:
                **(req_complementavel or {}),
            }
        if exc.retcode == K.DRIVER_REGISTERED_INACTIVE:
            # Driver_profile ja existe mas esta inativo na agencia.
            # Busca o driver_id e oferece ativacao.
            driver_id = None
            try:
                driver_id = drivers.buscar_driver_id_por_cpf(client, cpf_clean)
            except Exception:
                pass
            return {
                "ok": False, "etapa": "driver_inativo",
                "erro": "Motorista ja registrado mas INATIVO — use /spx/motorista/ativar",
                "retcode": exc.retcode,
                "existing_driver_id": driver_id,
                "action_required": "activate",
            }
        if exc.retcode == K.REQUEST_IN_PROGRESS:
            # Ja existe driver_request — busca o id e RETORNA OS DADOS EXISTENTES
            # (modo somente-consulta; nao oferece atualizar — SPX nao permite sobrescrever).
            existing_id = None
            try:
                rl = drivers.list_requests(client, page=1, count=10, filters={"cpf": cpf_clean})
                items = (rl or {}).get("list") or (rl or {}).get("items") or []
                if items:
                    existing_id = items[0].get("id") or items[0].get("request_id")
            except Exception:
                pass

            # Auto-consulta os dados ja cadastrados pra mostrar ao operador
            consulta = None
            if existing_id:
                try:
                    consulta = consultar_request_existente(client, existing_id)
                except Exception:
                    pass

            return {
                "ok": True,  # nao eh um erro — apenas indica que ja existe
                "etapa": "ja_cadastrado",
                "modo": "READ_ONLY",
                "msg": "Motorista ja possui solicitacao no SPX. Dados existentes carregados — sem alteracao.",
                "retcode": exc.retcode,
                "existing_request_id": existing_id,
                "dados_spx": (consulta or {}).get("dados_spx"),
                "status_description": (consulta or {}).get("status_description"),
                "rejected_reason": (consulta or {}).get("rejected_reason"),
            }
        raise
    if pre.get("is_matched"):
        # SPX retornou is_matched=True no validate/basic: motorista JA existe
        # cadastrado na nossa agencia. Nao eh erro — apenas read-only com os dados.
        # Tenta buscar o driver_id pra eventual ativacao/edicao manual.
        driver_id = None
        try:
            driver_id = drivers.buscar_driver_id_por_cpf(client, cpf_clean)
        except Exception:
            pass
        return {
            "ok": True,
            "etapa": "ja_cadastrado",
            "modo": "READ_ONLY",
            "is_matched": True,
            "existing_driver_id": driver_id,
            "driver_info": pre.get("driver_info"),
            "msg": "Motorista ja cadastrado no SPX. Dados existentes carregados — sem alteracao.",
        }

    # ── 2. Resolve IDs via lookups ───────────────────────────────────
    city_id = lookups.find_city_id(client, city_name)
    if not city_id:
        return {"ok": False, "etapa": "lookup_cidade", "erro": f"cidade nao encontrada: {city_name}"}

    vehicle_type = lookups.find_vehicle_type_by_name(client, vehicle_type_name)
    if not vehicle_type:
        return {"ok": False, "etapa": "lookup_vehicle_type", "erro": f"tipo de veiculo nao encontrado: {vehicle_type_name}"}
    vehicle_type_id = vehicle_type.get("vehicle_type_id") or vehicle_type.get("id")

    def _resolve_station(name: str | None, key: str) -> int:
        if not name:
            return 0
        s = lookups.find_station_by_name(client, name, function_type=key)
        if not s:
            avisos.append(f"station '{name}' nao encontrada em {key} (id=0)")
            return 0
        return int(s.get("station_id") or 0)

    linehaul_id = _resolve_station(linehaul_station_name, "linehaul")
    pickup_id = _resolve_station(pickup_station_name, "pickup")
    delivery_id = _resolve_station(delivery_station_name, "delivery")
    return_id = _resolve_station(return_station_name, "return")

    # ── 3. Uploads ────────────────────────────────────────────────────
    driver_photo_url = ""
    license_img_front = ""
    license_img_back = ""
    vehicle_document_url = ""
    risk_doc_url = ""

    try:
        if selfie_path:
            r = uploads.upload_driver_photo(client, selfie_path)
            driver_photo_url = (r or {}).get("url") or ""
        if cnh_frente_path:
            r = uploads.upload_license_image(client, cnh_frente_path)
            license_img_front = (r or {}).get("url") or ""
        if cnh_verso_path:
            r = uploads.upload_license_image(client, cnh_verso_path)
            license_img_back = (r or {}).get("url") or ""
        if crlv_path:
            r = uploads.recognize_vehicle_doc(client, crlv_path)
            vehicle_document_url = (r or {}).get("url") or ""
            ocr_code = (r or {}).get("ocr_result", 0)
            if not K.OCRResult.is_success(ocr_code):
                avisos.append(f"OCR CRLV ocr_result={ocr_code} — campos podem estar errados")
            # Preenche o que vier do OCR se nao foi informado
            if not renavam: renavam = str((r or {}).get("renavam") or "")
            if not license_plate: license_plate = str((r or {}).get("license_plate") or "")
            if not vehicle_manufacturer: vehicle_manufacturer = str((r or {}).get("vehicle_manufacturer") or "")
            if not vehicle_manufacturing_year: vehicle_manufacturing_year = str((r or {}).get("vehicle_manufacturing_year") or "")
            if not vehicle_owner_name: vehicle_owner_name = str((r or {}).get("vehicle_owner_name") or "")
        if risk_doc_path:
            r = uploads.upload_risk_doc(client, risk_doc_path)
            risk_doc_url = (r or {}).get("url") or ""
    except APIErro as exc:
        log_erro(f"[flow] upload falhou: {exc}")
        return {"ok": False, "etapa": "upload", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    # ── 4. Build payload ──────────────────────────────────────────────
    payload = drivers.build_payload_normal_driver(
        cpf=cpf_clean,
        driver_name=driver_name,
        contact_number=contact_number,
        gender=gender,
        birth_day=_to_unix_seconds(birth_day),
        city_id=int(city_id),
        neighbourhood_name=neighbourhood_name,
        street_name=street_name,
        address_number=address_number,
        zip_code=zip_code,
        contract_type=contract_type,
        function_type_list=function_type_list,
        linehaul_station_id=linehaul_id,
        pickup_station_id=pickup_id,
        delivery_station_id=delivery_id,
        return_station_id=return_id,
        feeder_mode=feeder_mode,
        at_level_handover=at_level_handover,
        license_number=license_number,
        license_type=license_type,
        license_expire_date=_to_unix_seconds(license_expire_date),
        cnh_remarks=cnh_remarks,
        vehicle_type=int(vehicle_type_id),
        license_plate=license_plate,
        vehicle_manufacturer=vehicle_manufacturer,
        vehicle_manufacturing_year=vehicle_manufacturing_year,
        vehicle_owner_name=vehicle_owner_name,
        renavam=renavam,
        driver_photo=driver_photo_url,
        license_img_front=license_img_front,
        license_img_back=license_img_back,
        vehicle_document=vehicle_document_url,
        risk_assessment_document=risk_doc_url,
        rad_expire_date=_to_unix_seconds(rad_expire_date) if rad_expire_date else 0,
    )

    if dry_run:
        return {"ok": True, "etapa": "dry_run", "payload": payload, "avisos": avisos}

    # ── 5. Draft opcional ────────────────────────────────────────────
    request_id = None
    if do_draft_save:
        try:
            draft = drivers.save_draft(client, payload)
            request_id = (draft or {}).get("id")
            log_info(f"[flow] draft salvo id={request_id}")
        except APIErro as exc:
            avisos.append(f"draft/save falhou: {exc}")

    # ── 6. validate_detail ───────────────────────────────────────────
    try:
        drivers.validate_detail(client, payload)
    except APIErro as exc:
        return {"ok": False, "etapa": "validate_detail", "erro": str(exc), "retcode": exc.retcode, "payload": payload, "avisos": avisos}

    # ── 7. submit_check ──────────────────────────────────────────────
    try:
        check = drivers.submit_check(client, payload)
        vehicle_diff = (check or {}).get("vehicle_diff_field") or []
        if vehicle_diff:
            avisos.append(f"vehicle_diff_field={vehicle_diff} (cadastro existente tem campos diferentes)")
    except APIErro as exc:
        return {"ok": False, "etapa": "submit_check", "erro": str(exc), "retcode": exc.retcode, "payload": payload, "avisos": avisos}

    # ── 8. submit ────────────────────────────────────────────────────
    try:
        result = drivers.submit(client, payload)
    except APIErro as exc:
        if exc.retcode == K.DRIVER_REPEAT:
            return {"ok": False, "etapa": "submit", "erro": "DRIVER_REPEAT — CPF ja cadastrado", "retcode": exc.retcode, "avisos": avisos}
        if exc.retcode == K.DRIVER_BLOCKED:
            return {"ok": False, "etapa": "submit", "erro": "DRIVER_BLOCKED — motorista bloqueado", "retcode": exc.retcode, "avisos": avisos}
        return {"ok": False, "etapa": "submit", "erro": str(exc), "retcode": exc.retcode, "avisos": avisos}

    return {
        "ok": True,
        "etapa": "completo",
        "request_id": (result or {}).get("request_id"),
        "driver_id": (result or {}).get("driver_id"),
        "result": result,
        "avisos": avisos,
    }
