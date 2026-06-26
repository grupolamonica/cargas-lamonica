"""Sidecar FastAPI — expoe API REST local pro painel Node consumir.

Equivalente ao backend do angelira-robo. Roda em localhost:8766 por padrao.

Endpoints:
  GET  /spx/health           — checa conexao com SPX (ping no portal)
  GET  /spx/lookups/vehicle_types
  GET  /spx/lookups/cities?name=...
  GET  /spx/lookups/stations
  POST /spx/motorista/busca  body={cpf}
  POST /spx/motorista        body=cadastro completo
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

# permite rodar com `python backend/main.py` (path do package)
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
# Ordem: 1) .env raiz do projeto (config compartilhada) 2) .env do spx-robo
#        3) config/.env local (legado). Local sobrepoe se conflitar.
_PROJECT_ROOT = ROOT.parent.parent   # spx-robo/backend/ -> spx-robo -> projeto
_root_env = _PROJECT_ROOT / ".env"
if _root_env.exists():
    load_dotenv(_root_env)
load_dotenv(ROOT.parent / ".env", override=True)
load_dotenv(ROOT.parent / "config" / ".env", override=True)

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
import uvicorn

from spx_robo import constants as K
from spx_robo import drivers as drivers_mod
from spx_robo import flow_motorista, lookups
from spx_robo.client import APIErro, SPXClient, SessaoExpirada
from spx_robo.logger import log_alerta, log_erro, log_info

import anexo_storage  # ponte de anexos cross-container (sandbox local)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Faxina de anexos antigos do sandbox no startup (TTL 24h).
    try:
        removidas = anexo_storage.limpar_antigos()
        if removidas:
            log_info(f"[spx] anexos antigos removidos no startup: {removidas} pastas")
    except Exception as exc:
        log_alerta(f"[spx] falha ao limpar anexos antigos no startup: {exc}")
    # Keep-alive da sessao SPX — renova o cookie por rotacao (ver _keepalive_loop).
    _start_keepalive()
    yield


app = FastAPI(title="SPX Robo (sidecar)", version="0.1.0", lifespan=lifespan)


# ── Anexos: ponte cross-container ─────────────────────────────────────
# O Node baixa o doc (bucket Supabase / share da producao), manda em base64, e
# gravamos num sandbox local; flow_motorista lê o path e sobe pro SPX (uploads.py).
# Mesmo mecanismo do angelira-bot.

_MAX_IMG_B64 = 18_000_000  # ~13MB binário em base64


class AnexoSalvarRequest(BaseModel):
    tipo: str
    imagem: str
    id_cadastro: str

    @field_validator("imagem")
    @classmethod
    def _validar_tamanho(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Arquivo vazio.")
        if len(v) > _MAX_IMG_B64:
            raise ValueError(f"Arquivo excede {_MAX_IMG_B64 // 1000}KB (base64).")
        return v


@app.post("/spx/anexo/salvar")
async def spx_anexo_salvar(req: AnexoSalvarRequest):
    """Recebe um doc em base64 e grava no sandbox local; devolve o anexo_path."""
    try:
        salvo = await asyncio.to_thread(
            anexo_storage.salvar, req.tipo, req.imagem, req.id_cadastro
        )
        return {
            "ok": True,
            "anexo_path": salvo.path,
            "tipo": salvo.tipo,
            "id_cadastro": salvo.id_cadastro,
            "bytes": salvo.bytes,
        }
    except anexo_storage.AnexoError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log_erro(f"[spx] /spx/anexo/salvar falhou: {e!r}")
        raise HTTPException(status_code=500, detail="Erro ao salvar anexo.")


@app.post("/spx/anexo/limpar")
async def spx_anexo_limpar(id_cadastro: str):
    """Apaga os anexos de um cadastro do sandbox (best-effort)."""
    try:
        removidos = await asyncio.to_thread(anexo_storage.limpar_cadastro, id_cadastro)
        return {"ok": True, "removidos": removidos}
    except Exception as e:
        log_erro(f"[spx] /spx/anexo/limpar falhou: {e!r}")
        raise HTTPException(status_code=500, detail="Erro ao limpar anexos.")


# Singleton client — reusa cookies/sessao entre requests
_CLIENT: SPXClient | None = None


def get_client() -> SPXClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = SPXClient()
    return _CLIENT


def reset_client():
    global _CLIENT
    if _CLIENT is not None:
        try:
            _CLIENT.close()
        except Exception:
            pass
    _CLIENT = None


# ── Keep-alive da sessao SPX ─────────────────────────────────────────
# O SPX nao tem login programatico; a sessao SSO so se mantem viva pela ROTACAO
# de cookies que o servidor devolve a cada chamada valida. Como o portal pode
# ficar ocioso (noite/fim de semana), um ping periodico forca essa rotacao e o
# SPXClient regrava o cookie no Supabase — mantendo a sessao viva sem Playwright.
# Quando a sessao morre de vez (evento de seguranca), o ping da 401 -> cookies
# marcados expirados -> operador renova pelo botao "Atualizar cookies" do painel.
_KEEPALIVE_INTERVAL_SEC = int(os.getenv("SPX_KEEPALIVE_INTERVAL_SEC") or 1800)  # 30min
_keepalive_thread: threading.Thread | None = None


def _keepalive_loop() -> None:
    # Atraso inicial pra nao competir com o boot do uvicorn.
    time.sleep(min(120, _KEEPALIVE_INTERVAL_SEC))
    while True:
        try:
            client = get_client()
            if client.ping():
                # Sessao confirmada viva: estende o prazo no Supabase mesmo que o
                # cookie nao tenha rotacionado — mantem o keep-alive 100% automatico.
                client.bump_supabase_session_ttl()
                log_info("[keepalive] ping OK — prazo da sessao SPX estendido")
            else:
                # ping() ja invalidou os cookies no Supabase (401/redirect).
                log_alerta("[keepalive] ping falhou — sessao expirada. Aguardando re-login.")
                reset_client()
        except Exception as exc:  # noqa: BLE001 — cookies ausentes/expirados, Supabase off, etc.
            log_alerta(f"[keepalive] indisponivel: {type(exc).__name__}: {exc}")
            reset_client()
        time.sleep(_KEEPALIVE_INTERVAL_SEC)


def _start_keepalive() -> None:
    """Inicia a thread de keep-alive. Chamado pelo lifespan no startup."""
    global _keepalive_thread
    if (os.getenv("SPX_KEEPALIVE_DISABLED") or "").strip().lower() in {"1", "true", "yes"}:
        log_info("[keepalive] desabilitado via SPX_KEEPALIVE_DISABLED")
        return
    if _keepalive_thread is None:
        _keepalive_thread = threading.Thread(
            target=_keepalive_loop, daemon=True, name="spx-keepalive"
        )
        _keepalive_thread.start()
        log_info(f"[keepalive] iniciado (intervalo {_KEEPALIVE_INTERVAL_SEC}s)")


# ── Models ──────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    ok: bool
    detail: str = ""


class BuscaCPFRequest(BaseModel):
    cpf: str


class MotoristaPayload(BaseModel):
    cpf: str
    driver_name: str
    contact_number: str
    gender: int = 1
    birth_day: str | int

    city_name: str
    neighbourhood_name: str
    street_name: str
    address_number: str
    zip_code: str

    contract_type: int
    function_type_list: list[int]
    linehaul_station_name: str | None = None
    pickup_station_name: str | None = None
    delivery_station_name: str | None = None
    return_station_name: str | None = None
    feeder_mode: list[int] | None = None
    at_level_handover: int = 0

    license_number: str
    license_type: int
    license_expire_date: str | int
    cnh_remarks: list[str] | None = None

    vehicle_type_name: str
    license_plate: str
    vehicle_manufacturer: str = ""
    vehicle_manufacturing_year: str = ""
    vehicle_owner_name: str = ""
    renavam: str = ""

    cnh_frente_path: str | None = None
    cnh_verso_path: str | None = None
    selfie_path: str | None = None
    crlv_path: str | None = None
    risk_doc_path: str | None = None
    rad_expire_date: str | int | None = None

    dry_run: bool = False
    do_draft_save: bool = False


# ── Endpoints ──────────────────────────────────────────────────────

@app.get("/spx/health", response_model=HealthResponse)
def health():
    try:
        c = get_client()
        if c.ping():
            return HealthResponse(ok=True, detail="sessao valida")
        return HealthResponse(ok=False, detail="ping falhou — verifique cookies")
    except SessaoExpirada as exc:
        reset_client()
        return HealthResponse(ok=False, detail=f"sessao expirada: {exc}")
    except FileNotFoundError as exc:
        return HealthResponse(ok=False, detail=str(exc))
    except Exception as exc:
        log_erro(f"[main] /health falhou: {exc!r}")
        return HealthResponse(ok=False, detail=f"erro: {type(exc).__name__}: {exc}")


@app.get("/spx/status")
def status():
    """Status detalhado — não tenta ping (caro). Retorna apenas se cookies
    estão presentes/vigentes no Supabase. Usado pelo backend Node pra UI.
    """
    from spx_robo import supabase_auth
    if not supabase_auth.use_supabase():
        return {
            "ok": True,
            "service": "spx-bot (modo arquivo local)",
            "supabase": False,
            "cookies": "arquivo local — sem health do Supabase",
        }
    ok, motivo = supabase_auth.is_available()
    return {
        "ok": ok,
        "service": "spx-bot",
        "supabase": True,
        "cookies": motivo if ok else None,
        "motivo": motivo if not ok else None,
    }


@app.get("/spx/lookups/vehicle_types")
def lookup_vehicle_types():
    try:
        return {"ok": True, "data": lookups.fetch_vehicle_types(get_client())}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/spx/lookups/cities")
def lookup_cities(name: str = "", limit: int = 100):
    try:
        return {"ok": True, "data": lookups.fetch_cities(get_client(), city_name=name or None, limit=limit)}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/spx/lookups/stations")
def lookup_stations():
    try:
        return {"ok": True, "data": lookups.fetch_stations(get_client())}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/spx/lookups/attributes")
def lookup_attributes():
    try:
        return {"ok": True, "data": lookups.fetch_driver_attributes(get_client())}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/spx/motorista/busca")
def busca_por_cpf(req: BuscaCPFRequest):
    try:
        info = drivers_mod.buscar_por_cpf(get_client(), req.cpf)
        return {"ok": True, "encontrado": info is not None, "driver_info": info}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/spx/motorista")
def cadastrar_motorista(p: MotoristaPayload):
    try:
        result = flow_motorista.cadastrar_motorista_normal(
            get_client(),
            cpf=p.cpf,
            driver_name=p.driver_name,
            contact_number=p.contact_number,
            gender=p.gender,
            birth_day=p.birth_day,
            city_name=p.city_name,
            neighbourhood_name=p.neighbourhood_name,
            street_name=p.street_name,
            address_number=p.address_number,
            zip_code=p.zip_code,
            contract_type=p.contract_type,
            function_type_list=p.function_type_list,
            linehaul_station_name=p.linehaul_station_name,
            pickup_station_name=p.pickup_station_name,
            delivery_station_name=p.delivery_station_name,
            return_station_name=p.return_station_name,
            feeder_mode=p.feeder_mode,
            at_level_handover=p.at_level_handover,
            license_number=p.license_number,
            license_type=p.license_type,
            license_expire_date=p.license_expire_date,
            cnh_remarks=p.cnh_remarks,
            vehicle_type_name=p.vehicle_type_name,
            license_plate=p.license_plate,
            vehicle_manufacturer=p.vehicle_manufacturer,
            vehicle_manufacturing_year=p.vehicle_manufacturing_year,
            vehicle_owner_name=p.vehicle_owner_name,
            renavam=p.renavam,
            cnh_frente_path=p.cnh_frente_path,
            cnh_verso_path=p.cnh_verso_path,
            selfie_path=p.selfie_path,
            crlv_path=p.crlv_path,
            risk_doc_path=p.risk_doc_path,
            rad_expire_date=p.rad_expire_date,
            dry_run=p.dry_run,
            do_draft_save=p.do_draft_save,
        )
        return result
    except SessaoExpirada as exc:
        reset_client()
        raise HTTPException(status_code=401, detail=f"Sessao expirada: {exc}")
    except APIErro as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        log_erro(f"[main] /motorista falhou: {exc!r}")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


class AtualizarRequestPayload(BaseModel):
    request_id: int
    novo_driver_photo_path: str | None = None
    novo_license_img_front_path: str | None = None
    novo_license_img_back_path: str | None = None
    novo_crlv_path: str | None = None
    novo_risk_doc_path: str | None = None
    overrides: dict | None = None
    dry_run: bool = False
    # ⚠️ Obrigatorio pra autorizar sobrescrever dados no SPX
    force_overwrite: bool = False


@app.get("/spx/requests/list")
def requests_list(page: int = 1, count: int = 20, cpf: str = ""):
    """Lista driver_requests da agencia, com filtro opcional de CPF."""
    try:
        filters = {"cpf": cpf} if cpf else None
        data = drivers_mod.list_requests(get_client(), page=page, count=count, filters=filters)
        return {"ok": True, "data": data}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/spx/requests/{request_id}")
def request_detail(request_id: int, view_only: bool = True):
    """Detalhe de uma driver_request."""
    try:
        data = drivers_mod.get_request_detail(get_client(), request_id, view_only=view_only)
        return {"ok": True, "data": data}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/spx/requests/{request_id}/withdraw")
def request_withdraw(request_id: int):
    """Cancela uma driver_request submitted ainda pendente."""
    try:
        data = drivers_mod.withdraw_request(get_client(), request_id)
        return {"ok": True, "data": data}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/spx/motorista/atualizar")
def atualizar_request(p: AtualizarRequestPayload):
    """⚠️ DANGEROUS: atualiza driver_request existente (re-sobe arquivos + re-submete).

    Por padrao BLOQUEADO (force_overwrite=False). SPX nao permite reverter alteracoes,
    entao essa operacao requer confirmacao explicita do operador. Use `/spx/motorista/consultar`
    se quiser apenas ver os dados existentes (read-only).
    """
    try:
        result = flow_motorista.atualizar_request_existente(
            get_client(),
            request_id=p.request_id,
            novo_driver_photo_path=p.novo_driver_photo_path,
            novo_license_img_front_path=p.novo_license_img_front_path,
            novo_license_img_back_path=p.novo_license_img_back_path,
            novo_crlv_path=p.novo_crlv_path,
            novo_risk_doc_path=p.novo_risk_doc_path,
            overrides=p.overrides,
            dry_run=p.dry_run,
            force_overwrite=p.force_overwrite,
        )
        return result
    except SessaoExpirada as exc:
        reset_client()
        raise HTTPException(status_code=401, detail=f"Sessao expirada: {exc}")
    except APIErro as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        log_erro(f"[main] /motorista/atualizar falhou: {exc!r}")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


class ConsultarRequestPayload(BaseModel):
    request_id: int
    dados_locais: dict | None = None


@app.post("/spx/motorista/consultar")
def consultar_request(p: ConsultarRequestPayload):
    """READ-ONLY: busca dados de uma driver_request existente e (opcional) compara
    com `dados_locais`. NUNCA escreve no SPX. Use este endpoint quando motorista
    ja existe — SPX nao permite sobrescrever fotos/documentos depois de submetidos.
    """
    try:
        return flow_motorista.consultar_request_existente(
            get_client(),
            request_id=p.request_id,
            dados_locais=p.dados_locais,
        )
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class ComplementarPayload(BaseModel):
    request_id: int
    dados_locais: dict
    dry_run: bool = True


@app.post("/spx/motorista/complementar")
def complementar_request(p: ComplementarPayload):
    """Preenche APENAS campos vazios na request existente. Sem sobrescrever
    nada, sem tocar em fotos/documentos. Operacao segura.

    `dry_run=True` (default) retorna o plano sem submeter — use pra revisar
    antes de aplicar de verdade.
    """
    try:
        return flow_motorista.complementar_dados_vazios(
            get_client(),
            request_id=p.request_id,
            dados_locais=p.dados_locais,
            dry_run=p.dry_run,
        )
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class CompletarOutraAgenciaPayload(BaseModel):
    request_id: int
    risk_doc_path: str | None = None
    rad_expire_date: str | int | None = None
    linehaul_station_name: str | None = None
    crlv_path: str | None = None
    dry_run: bool = True


@app.post("/spx/motorista/completar_outra_agencia")
def completar_outra_agencia_endpoint(p: CompletarOutraAgenciaPayload):
    """Preenche SOMENTE Risk Doc (PDF), expiry, linehaul e CRLV vazios numa request
    de motorista em outra agencia. NUNCA sobrescreve campos ja preenchidos
    (mesmo se Risk Doc expirou). dry_run=True por default — sempre revisar antes.
    """
    try:
        return flow_motorista.completar_outra_agencia(
            get_client(),
            request_id=p.request_id,
            risk_doc_path=p.risk_doc_path,
            rad_expire_date=p.rad_expire_date,
            linehaul_station_name=p.linehaul_station_name,
            crlv_path=p.crlv_path,
            dry_run=p.dry_run,
        )
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class DiagnosticoPayload(BaseModel):
    """Probe PASSIVO — NAO envia placa ao SPX. So lista requests + compara placa."""
    cpf: str
    placa_nossa: str | None = None   # pra comparacao local apenas


# ─────────────────────────────────────────────────────────────────────────────
# Lookup leve pra obter driver_info do SPX SEM disparar uploads/criacao de request.
# Usado pelo painel: quando cadastro abre, queremos saber se motorista existe em
# outra agencia (sem request nossa) pra exibir botao "Migrar pra NOSSA agencia".
#
# Faz: validate/basic → retorna driver_info se is_matched=true.
# IMPORTANTE: validate/basic sem placa NAO trava o motorista, pode ser chamado livremente.
# ─────────────────────────────────────────────────────────────────────────────
class LookupDriverPayload(BaseModel):
    cpf: str
    driver_name: str = ""
    contact_number: str = ""
    # license_number ajuda a passar validate/basic — SEM ele o backend
    # SPX retorna retcode 271605013 ("A CNH não pode estar vazia") e perdemos
    # a detecção cross-agency. Quando o caller (precheck do painel) tiver
    # a CNH em mãos, passar aqui. Fallback: placeholder no lookup interno.
    license_number: str = ""


@app.post("/spx/motorista/lookup")
def lookup_driver(p: LookupDriverPayload):
    """Lookup leve: chama validate/basic e retorna driver_info se is_matched=true.
    NAO faz uploads nem cria/altera requests. Seguro pra chamar a qualquer hora.

    Detecta motorista em QUALQUER agência (não só LAMONICA). Se is_matched=true
    mas nao_minha_agencia → operador deve usar /importar_matched.
    """
    try:
        cpf_clean = ''.join(c for c in (p.cpf or '') if c.isdigit())
        if len(cpf_clean) != 11:
            raise HTTPException(status_code=400, detail="CPF invalido")

        client = get_client()

        # ESTRATEGIA cross-agency (DC-111 / 2026-05-29):
        # - is_cpf_exist parece retornar False quando motorista nao esta NA NOSSA
        #   agencia, mesmo existindo em outras. Nao podemos confiar nele pra
        #   pular validate/basic.
        # - validate/basic DETECTA cross-agency via is_matched=true + driver_info,
        #   mas exige license_number nao-vazio (senao retcode 271605013).
        # - Solucao: chamamos validate/basic SEMPRE, passando placeholder de CNH
        #   se o caller nao enviou um. Se mesmo assim falhar, retorna inconclusivo
        #   com o motivo.
        license_number = ''.join(c for c in (p.license_number or '') if c.isdigit())
        license_to_send = license_number or "11111111111"  # placeholder de 11 digitos
        driver_name_to_send = (p.driver_name or "MOTORISTA LOOKUP").strip().upper()
        contact_real = ''.join(c for c in (p.contact_number or '') if c.isdigit())
        contact_to_send = contact_real or "11999999999"
        # Os placeholders 11111111111 (CNH) e 11999999999 (telefone) JA EXISTEM
        # registrados no SPX → disparam 271605059/271605005 FALSOS. Se usamos
        # placeholder, esses retcodes sao inconclusivos (nao significam que ESTE
        # motorista existe). Rastreamos pra nao classificar errado.
        used_license_ph = not license_number
        used_phone_ph = not contact_real

        # PERF (2026-05-29): is_cpf_exist virou LAZY. Antes era chamado SEMPRE
        # antes do validate/basic (+1 round-trip ~0.5-1s). Mas ele é
        # não-confiável pra cross-agency (retorna False mesmo existindo em outra
        # agência) e agora mapeamos todos os retcodes relevantes do validate.
        # Então só chamamos is_cpf_exist como fallback, quando validate/basic
        # falha SEM um retcode mapeável (caminho raro). existe_local começa None
        # = "não consultado".
        existe_local = None

        # validate/basic — detecta cross-agency (caminho principal)
        try:
            vb = drivers_mod.validate_basic(
                client,
                cpf=cpf_clean,
                driver_name=driver_name_to_send,
                contact_number=contact_to_send,
                license_number=license_to_send,
            )
        except (APIErro, SessaoExpirada) as exc:
            log_alerta(f"[lookup_driver] validate/basic falhou: {exc}")
            retcode = getattr(exc, "retcode", None)
            erro = str(exc)

            # Mapping cross-agency dos retcodes que ainda assim significam
            # que MOTORISTA EXISTE (em outra agência, em rascunho, inativo, etc).
            # Sem isso, perdíamos a info crítica de cross-agency.
            CROSS_AGENCY_CODES = {
                K.DRIVER_IN_OTHER_AGENCY,      # 271605035 — explícito "outra agência"
                K.LICENSE_ALREADY_REGISTERED,  # 271605059 — CNH registrada em algum motorista
                K.DRIVER_REPEAT,                # 271627140 — CPF ja cadastrado
                K.LICENSE_OR_PHONE_TAKEN,      # 271605005 — telefone/CNH pertencem a outro
            }
            PENDENTE_CODES = {
                K.DRAFT_EXISTS,                # 271605026 — rascunho aberto
                K.REQUEST_IN_PROGRESS,         # 271605028 — solicitacao em andamento
                getattr(K, "DRIVER_IN_REVIEW", 271605008),  # request em revisão
            }
            INATIVO_CODES = {
                K.DRIVER_REGISTERED_INACTIVE,  # 271605004 — registrado mas inativo
            }
            BLOQUEADO_CODES = {
                K.DRIVER_BLOCKED,              # 271617003 — bloqueado
            }

            # INCONCLUSIVO por placeholder: 271605059 (CNH ja registrada) e
            # 271605005 (telefone/CNH de outro) podem ter sido disparados pelo
            # NOSSO placeholder (11111111111 / 11999999999), nao pelo motorista
            # real. Se foi placeholder, NAO da pra afirmar matched nem nao-cadastrado.
            if (retcode == K.LICENSE_ALREADY_REGISTERED and used_license_ph) or (
                retcode == K.LICENSE_OR_PHONE_TAKEN and (used_license_ph or used_phone_ph)
            ):
                return {
                    "ok": True, "encontrado": False, "is_matched": False,
                    "inconclusivo": True, "retcode": retcode, "erro_validate": erro,
                    "motivo": "CNH/telefone reais ausentes no cadastro — lookup usou placeholder "
                              "e colidiu; status no SPX indeterminado (complete os dados e refaca).",
                }

            if retcode in CROSS_AGENCY_CODES:
                # Tenta listar requests nossa agência mesmo assim (pode haver
                # request residual sem ter passado pelo validate)
                items_nossa = []
                try:
                    rl = drivers_mod.list_requests(client, page=1, count=5, filters={"cpf": cpf_clean})
                    items_nossa = (rl or {}).get("list") or (rl or {}).get("items") or []
                except Exception:
                    pass
                return {
                    "ok": True, "encontrado": True, "is_matched": True,
                    "driver_info": None, "retcode": retcode, "erro_validate": erro,
                    "na_minha_agencia": len(items_nossa) > 0,
                    "requests_nossa_agencia_count": len(items_nossa),
                    "outra_agencia": retcode in (K.DRIVER_IN_OTHER_AGENCY, K.LICENSE_OR_PHONE_TAKEN),
                    "license_collision": retcode == K.LICENSE_ALREADY_REGISTERED,
                    "license_or_phone_taken": retcode == K.LICENSE_OR_PHONE_TAKEN,
                }

            if retcode in PENDENTE_CODES:
                return {
                    "ok": True, "encontrado": True, "is_matched": True,
                    "driver_info": None, "retcode": retcode, "erro_validate": erro,
                    "request_pendente": True,
                }

            if retcode in INATIVO_CODES:
                return {
                    "ok": True, "encontrado": True, "is_matched": True,
                    "driver_info": None, "retcode": retcode, "erro_validate": erro,
                    "inativo": True,
                }

            if retcode in BLOQUEADO_CODES:
                return {
                    "ok": True, "encontrado": True, "is_matched": False,
                    "driver_info": None, "retcode": retcode, "erro_validate": erro,
                    "bloqueado": True,
                }

            # Outros erros (CPF inválido, telefone inválido, etc) — sem retcode
            # mapeável. Aqui SIM vale a pena o fallback is_cpf_exist (lazy):
            # confirma se ao menos existe driver_profile na nossa agência.
            if existe_local is None:
                try:
                    existe_local = drivers_mod.is_cpf_exist(client, cpf_clean)
                except (APIErro, SessaoExpirada) as exc2:
                    log_alerta(f"[lookup_driver] is_cpf_exist (fallback) falhou: {exc2}")
                    existe_local = False
            return {
                "ok": True,
                "encontrado": bool(existe_local),
                "is_matched": False,
                "erro_validate": erro,
                "retcode": retcode,
            }

        is_matched = bool(vb.get("is_matched"))
        driver_info = vb.get("driver_info") if is_matched else None
        existing_driver_id = (driver_info or {}).get("driver_id") if driver_info else vb.get("existing_driver_id")

        # Checa se ja tem request na nossa agencia (pra distinguir "ja na nossa" vs "outra agencia")
        try:
            rl = drivers_mod.list_requests(client, page=1, count=5, filters={"cpf": cpf_clean})
            items_nossa = (rl or {}).get("list") or (rl or {}).get("items") or []
        except Exception:
            items_nossa = []

        # encontrado = motorista existe em alguma agência (na nossa OU outra)
        encontrado = is_matched or bool(existe_local) or len(items_nossa) > 0
        return {
            "ok": True,
            "encontrado": encontrado,
            "is_matched": is_matched,
            "driver_info": driver_info,
            "existing_driver_id": existing_driver_id,
            "na_minha_agencia": len(items_nossa) > 0,
            "requests_nossa_agencia_count": len(items_nossa),
        }
    except HTTPException:
        raise
    except Exception as e:
        log_erro(f"[main] /lookup falhou: {e!r}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")


@app.post("/spx/motorista/diagnostico")
def diagnostico_motorista(p: DiagnosticoPayload):
    """Diagnostico passivo de motorista em outra agencia — SEM enviar placa ao SPX.

    Estrategia:
      1. /motorista/busca (so CPF) → ve se existe driver_profile na Shopee
      2. /requests/list?cpf= → ve se temos request nossa
      3. Se tem request, pega detail e compara placa
      4. Retorna mesmo schema do validate/basic mas SEM riscar travar o motorista
    """
    try:
        cpf_clean = ''.join(c for c in (p.cpf or '') if c.isdigit())
        if len(cpf_clean) != 11:
            raise HTTPException(status_code=400, detail="CPF invalido")

        client = get_client()
        # Passo 1: confirma que motorista existe na Shopee (so CPF, sem placa)
        existe = drivers_mod.is_cpf_exist(client, cpf_clean)
        if not existe:
            return {"ok": True, "etapa": "nao_cadastrado", "retcode": 0}

        # Passo 2: lista requests nossas
        try:
            rl = drivers_mod.list_requests(client, page=1, count=5, filters={"cpf": cpf_clean})
            items = (rl or {}).get("list") or (rl or {}).get("items") or []
        except Exception:
            items = []

        if items:
            # Existe request na nossa agencia — nao eh "outra agencia"
            return {
                "ok": True,
                "etapa": "ja_cadastrado",
                "retcode": K.REQUEST_IN_PROGRESS,
                "existing_request_id": items[0].get("id") or items[0].get("request_id"),
                "request_status": items[0].get("status"),
            }

        # Passo 3: sem request nossa = provavel "outra agencia"
        # Reusa o analisador (que compara placa se passada)
        req_info = flow_motorista._analisar_complemento_outra_agencia(
            client, cpf_clean, placa_nossa=p.placa_nossa,
        )
        return {
            "ok": True,
            "etapa": "outra_agencia",
            "retcode": K.DRIVER_IN_OTHER_AGENCY,
            **(req_info or {}),
        }
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class ImportarMatchedPayload(BaseModel):
    """Importa driver_profile existente (is_matched=True) pra criar request NOSSA.

    Reusa todos os dados LOCKED do driver_info (CNH, foto, RG, endereco, telefone).
    Apenas Risk Doc + linehaul + vehicle podem ser nossos.
    """
    cpf: str
    driver_info: dict
    contract_type: int = 364
    function_type_list: list[int] | None = None
    linehaul_station_name: str | None = None
    pickup_station_name: str | None = None
    delivery_station_name: str | None = None
    return_station_name: str | None = None
    vehicle_type_name: str | None = None
    license_plate: str | None = None
    renavam: str | None = None
    vehicle_manufacturer: str | None = None
    vehicle_manufacturing_year: str | None = None
    vehicle_owner_name: str | None = None
    crlv_path: str | None = None
    risk_doc_path: str | None = None
    rad_expire_date: str | int | None = None
    dry_run: bool = True
    do_draft_save: bool = False
    # Fallback quando driver_info não traz city_name/city_id (ex: motorista
    # veio de outra agência e o profile SPX não tem cidade resolvida).
    city_name_fallback: str | None = None


@app.post("/spx/motorista/importar_matched")
def importar_matched_endpoint(p: ImportarMatchedPayload):
    """Importa driver_profile existente (is_matched=True sem request nossa)
    criando driver_request NOSSA. dry_run=True por default — revise antes.
    """
    try:
        return flow_motorista.importar_motorista_matched(
            get_client(),
            cpf=p.cpf,
            driver_info=p.driver_info,
            contract_type=p.contract_type,
            function_type_list=p.function_type_list,
            linehaul_station_name=p.linehaul_station_name,
            pickup_station_name=p.pickup_station_name,
            delivery_station_name=p.delivery_station_name,
            return_station_name=p.return_station_name,
            vehicle_type_name=p.vehicle_type_name,
            license_plate=p.license_plate,
            renavam=p.renavam,
            vehicle_manufacturer=p.vehicle_manufacturer,
            vehicle_manufacturing_year=p.vehicle_manufacturing_year,
            vehicle_owner_name=p.vehicle_owner_name,
            crlv_path=p.crlv_path,
            risk_doc_path=p.risk_doc_path,
            rad_expire_date=p.rad_expire_date,
            dry_run=p.dry_run,
            do_draft_save=p.do_draft_save,
            city_name_fallback=p.city_name_fallback,
        )
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


class AtivarDriverPayload(BaseModel):
    driver_id: int


@app.post("/spx/motorista/ativar")
def ativar_driver(p: AtivarDriverPayload):
    """Ativa driver_profile inativo (cenario retcode 271605004)."""
    try:
        result = drivers_mod.activate_driver(get_client(), p.driver_id)
        return {"ok": True, "data": result}
    except (APIErro, SessaoExpirada) as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.post("/spx/session/reset")
def session_reset():
    """Forca recarregar cookies (apos reexportar do Chrome)."""
    reset_client()
    return {"ok": True, "detail": "cookies serao recarregados na proxima chamada"}


@app.post("/spx/session/refresh")
def session_refresh():
    """Renovacao imediata da sessao (botao 'Renovar agora' do painel).

    Recarrega os cookies do Supabase, faz um ping (rotaciona o cookie) e estende
    o prazo (bump_supabase_session_ttl) — tudo sem login/Playwright. NUNCA
    levanta: reporta {ok, alive, detail}. Se a sessao estiver morta de vez,
    alive=False (so um login humano recupera; nao da' pra automatizar o login).
    """
    reset_client()  # re-le cookies frescos do Supabase
    try:
        c = get_client()
    except Exception as exc:  # noqa: BLE001 — cookies ausentes/expirados no Supabase
        return {"ok": False, "alive": False, "detail": str(exc)}
    try:
        if c.ping():
            c.bump_supabase_session_ttl()
            return {"ok": True, "alive": True, "detail": "sessao renovada"}
        return {"ok": False, "alive": False, "detail": "sessao expirada — precisa de novo login no SPX"}
    except SessaoExpirada as exc:
        reset_client()
        return {"ok": False, "alive": False, "detail": f"sessao expirada: {exc}"}
    except Exception as exc:  # noqa: BLE001
        log_erro(f"[main] /session/refresh falhou: {exc!r}")
        return {"ok": False, "alive": False, "detail": f"{type(exc).__name__}: {exc}"}


def main():
    host = os.getenv("SPX_SIDECAR_HOST") or "127.0.0.1"
    port = int(os.getenv("SPX_SIDECAR_PORT") or 8766)
    log_info(f"[sidecar] iniciando em http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
