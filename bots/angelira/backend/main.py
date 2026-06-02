"""FastAPI do servico AngelLira — API-only (sem Selenium).

Expoe os endpoints de cadastro 100% API:

    GET  /api/status                         -- health do servico
    POST /api/anexo/salvar                   -- storage temporario de anexos
    POST /api/anexo/limpar                   -- limpa anexos de um id_cadastro

    POST /api/robo/motorista_api/iniciar     -- cadastra motorista via API
    POST /api/robo/proprietario_api/iniciar  -- cadastra proprietario PF/PJ via API
    POST /api/robo/veiculo_api/iniciar       -- cadastra veiculo cavalo/carreta via API
    POST /api/robo/veiculo_api/check_owner   -- pre-check passivo de divergencia de owner

Todos os endpoints usam locks por documento (CPF/CNPJ/placa) para evitar
race condition em double-dispatch concorrente.
"""
import asyncio
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator

import anexo_storage
from angelira_robo import auth as robo_auth
from angelira_robo.api_query import flow_motorista as api_flow_motorista
from angelira_robo.api_query import flow_proprietario as api_flow_proprietario
from angelira_robo.api_query import flow_veiculo as api_flow_veiculo
from config import MAX_IMAGE_BASE64_BYTES


# Locks por documento/placa pra evitar race em concurrent dispatch.
_DOC_LOCKS: dict[str, asyncio.Lock] = {}
_DOC_LOCKS_GUARD = asyncio.Lock()


async def _doc_lock(chave: str) -> asyncio.Lock:
    """Retorna lock por documento. Evita race de double-dispatch."""
    if not chave:
        return asyncio.Lock()
    async with _DOC_LOCKS_GUARD:
        if chave not in _DOC_LOCKS:
            _DOC_LOCKS[chave] = asyncio.Lock()
        return _DOC_LOCKS[chave]


log = logging.getLogger("angelira-robo")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        removidas = anexo_storage.limpar_antigos()
        if removidas:
            log.info("Anexos antigos removidos no startup: %d pastas", removidas)
    except Exception:
        log.exception("Falha ao limpar anexos antigos no startup")
    yield


app = FastAPI(
    title="AngelLira Robo (API-only)",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: ajuste origins via env CORS_ORIGINS se necessario (csv).
import os
_cors_origins_raw = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5010,http://127.0.0.1:5010,http://localhost:8765,http://127.0.0.1:8765",
)
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def _tratar_erro(e: Exception, ctx: str) -> HTTPException:
    if isinstance(e, HTTPException):
        return e
    log.exception("Erro em %s: %s", ctx, e)
    return HTTPException(status_code=500, detail="Erro ao processar a requisicao.")


# ── Health ───────────────────────────────────────────────────────────────────

@app.get("/api/status")
async def status():
    robo_ok, robo_motivo = robo_auth.is_available()
    return {
        "ok": True,
        "service": "angelira-robo (api-only)",
        "robo_angelira": {
            "disponivel": robo_ok,
            "motivo": robo_motivo or None,
            "auth_base": robo_auth.get_login_url(),
            "user": robo_auth.get_username() if robo_ok else None,
        },
    }


# ── Anexos temporarios para o robo ───────────────────────────────────────────

class AnexoSalvarRequest(BaseModel):
    tipo: str
    imagem: str
    id_cadastro: str

    @field_validator("imagem")
    @classmethod
    def validar_tamanho(cls, v: str) -> str:
        if len(v) > MAX_IMAGE_BASE64_BYTES:
            raise ValueError(f"Arquivo excede {MAX_IMAGE_BASE64_BYTES // 1000}KB (base64).")
        if not v.strip():
            raise ValueError("Arquivo vazio.")
        return v


@app.post("/api/anexo/salvar")
async def anexo_salvar(req: AnexoSalvarRequest):
    try:
        salvo = await asyncio.to_thread(anexo_storage.salvar, req.tipo, req.imagem, req.id_cadastro)
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
        raise _tratar_erro(e, "anexo/salvar")


@app.post("/api/anexo/limpar")
async def anexo_limpar(id_cadastro: str):
    try:
        removidos = await asyncio.to_thread(anexo_storage.limpar_cadastro, id_cadastro)
        return {"ok": True, "removidos": removidos}
    except Exception as e:
        raise _tratar_erro(e, "anexo/limpar")


# ── Cadastro Motorista via API ───────────────────────────────────────────────

class MotoristaApiIniciarRequest(BaseModel):
    id_cadastro: str = ""
    payload: dict = {}
    anexos: dict = {}
    prime: int = 0       # 0=NORMAL, 1=PRIME, 2=PRIME PLUS
    type_id: int = 25    # /types/drivers: 25=Funcionario, 26=Agregado, ...


@app.post("/api/robo/motorista_api/iniciar")
async def robo_motorista_api_iniciar(req: MotoristaApiIniciarRequest):
    """Cadastra motorista via API publica AngelLira.

    Espera o payload no formato:
        payload = {"motorista": {...}, "cnh": {...}, "endereco": {...}}
    """
    pronto, motivo = robo_auth.is_available()
    if not pronto:
        raise HTTPException(status_code=503, detail=f"AngelLira indisponivel: {motivo}")
    payload = dict(req.payload or {})
    motorista = payload.get("motorista") or {}
    if not motorista.get("nome") or not motorista.get("cpf"):
        raise HTTPException(
            status_code=400,
            detail="payload.motorista.nome e payload.motorista.cpf sao obrigatorios",
        )
    anexos_validados: dict = {}
    for chave, path in (req.anexos or {}).items():
        if not path:
            continue
        try:
            anexos_validados[chave] = anexo_storage.validar_path_para_robo(path)
        except anexo_storage.AnexoError as e:
            raise HTTPException(status_code=400, detail=f"anexo '{chave}' invalido: {e}")
    cpf_lock_key = "".join(c for c in str(motorista.get("cpf") or "") if c.isdigit())
    lock = await _doc_lock(f"motorista:{cpf_lock_key}")
    async with lock:
        try:
            resultado = await asyncio.to_thread(
                api_flow_motorista.cadastrar_motorista,
                payload,
                anexos=anexos_validados,
                prime=req.prime,
                type_id=req.type_id,
            )
            if not resultado.get("ok"):
                raise HTTPException(status_code=502, detail={
                    "etapa": resultado.get("etapa"),
                    "duracao_s": resultado.get("duracao_s"),
                    "erro": resultado.get("erro"),
                    "driverId": resultado.get("driverId"),
                })
            return resultado
        except HTTPException:
            raise
        except Exception as e:
            raise _tratar_erro(e, "robo/motorista_api/iniciar")


# ── Cadastro Proprietario via API ────────────────────────────────────────────

class ProprietarioApiIniciarRequest(BaseModel):
    tipo: str = "PJ"   # 'PJ' ou 'PF'
    id_cadastro: str = ""
    payload: dict = {}
    anexos: dict = {}
    relationship: int = 1


@app.post("/api/robo/proprietario_api/iniciar")
async def robo_proprietario_api_iniciar(req: ProprietarioApiIniciarRequest):
    """Cadastra proprietario (PJ ou PF) via API."""
    pronto, motivo = robo_auth.is_available()
    if not pronto:
        raise HTTPException(status_code=503, detail=f"AngelLira indisponivel: {motivo}")
    tipo = (req.tipo or "PJ").strip().upper()
    if tipo not in {"PJ", "PF"}:
        raise HTTPException(status_code=400, detail=f"tipo invalido: {req.tipo!r} (use PJ ou PF)")
    payload = dict(req.payload or {})
    anexos_validados: dict = {}
    for chave, path in (req.anexos or {}).items():
        if not path:
            continue
        try:
            anexos_validados[chave] = anexo_storage.validar_path_para_robo(path)
        except anexo_storage.AnexoError as e:
            raise HTTPException(status_code=400, detail=f"anexo '{chave}' invalido: {e}")
    doc_lock_key = "".join(
        c for c in str(
            payload.get("cnpj") or payload.get("cpf")
            or (payload.get("payload") or {}).get("cnpj")
            or (payload.get("payload") or {}).get("cpf") or ""
        ) if c.isdigit()
    )
    lock = await _doc_lock(f"prop:{doc_lock_key}")
    async with lock:
        try:
            resultado = await asyncio.to_thread(
                api_flow_proprietario.cadastrar_proprietario,
                payload,
                anexos=anexos_validados,
                tipo=tipo,
                relationship=req.relationship,
            )
            if not resultado.get("ok"):
                raise HTTPException(status_code=502, detail={
                    "etapa": resultado.get("etapa"),
                    "duracao_s": resultado.get("duracao_s"),
                    "erro": resultado.get("erro"),
                    "ownerId": resultado.get("ownerId"),
                })
            return resultado
        except HTTPException:
            raise
        except Exception as e:
            raise _tratar_erro(e, "robo/proprietario_api/iniciar")


# ── Cadastro Veiculo via API ─────────────────────────────────────────────────

class VeiculoApiIniciarRequest(BaseModel):
    sub: str = "cavalo"   # 'cavalo' ou 'carreta'
    id_cadastro: str = ""
    payload: dict = {}
    anexos: dict = {}
    prime: int = 0
    # CPF/CNPJ do proprietario do veiculo (Python resolve o ownerId).
    # POLITICA ESTRITA: NUNCA cadastra veiculo sem owner real cadastrado.
    owner_cnpj: str = ""
    owner_cpf: str = ""
    owner_id: int = 0       # 0 = "nao informado" (forca uso de owner_cpf/owner_cnpj)
    relationship: int = 1   # 1=propria


@app.post("/api/robo/veiculo_api/iniciar")
async def robo_veiculo_api_iniciar(req: VeiculoApiIniciarRequest):
    """Cadastra veiculo (cavalo ou carreta) via API publica."""
    pronto, motivo = robo_auth.is_available()
    if not pronto:
        raise HTTPException(status_code=503, detail=f"AngelLira indisponivel: {motivo}")
    sub = (req.sub or "cavalo").strip().lower()
    if sub not in {"cavalo", "carreta"}:
        raise HTTPException(status_code=400, detail=f"sub invalido: {req.sub!r} (use cavalo ou carreta)")
    payload = dict(req.payload or {})
    # Aceita 2 formatos: {cavalo: {placa,...}} ou {placa, renavam, chassi,...} flat
    if not payload.get(sub):
        if payload.get("placa"):
            payload = {sub: payload}
        else:
            raise HTTPException(status_code=400, detail=f"payload.{sub} ou payload.placa e obrigatorio")
    if not (payload.get(sub) or {}).get("placa"):
        raise HTTPException(status_code=400, detail=f"payload.{sub}.placa e obrigatorio")
    anexos_validados: dict = {}
    for chave, path in (req.anexos or {}).items():
        if not path:
            continue
        try:
            anexos_validados[chave] = anexo_storage.validar_path_para_robo(path)
        except anexo_storage.AnexoError as e:
            raise HTTPException(status_code=400, detail=f"anexo '{chave}' invalido: {e}")

    # Resolve ownerId pelo CPF/CNPJ informado.
    resolved_owner_id = 0
    owner_lookup_doc = (req.owner_cpf or req.owner_cnpj or "").strip()
    log.info(
        "[veiculo_api] resolve_owner: cpf=%r cnpj=%r owner_id_passado=%s",
        req.owner_cpf, req.owner_cnpj, req.owner_id,
    )

    if req.owner_id and req.owner_id > 0:
        from angelira_robo.api_query.flow_veiculo import OWNERS_GENERICOS as _OWNERS_GENERICOS
        if req.owner_id in _OWNERS_GENERICOS:
            raise HTTPException(status_code=422, detail={
                "etapa": "owner_generico_bloqueado",
                "erro": (
                    f"ownerId={req.owner_id} corresponde a owner generico (politica estrita). "
                    f"Cadastre o proprietario real antes."
                ),
                "owner_id_bloqueado": req.owner_id,
            })
        resolved_owner_id = int(req.owner_id)
    elif req.owner_cnpj or req.owner_cpf:
        try:
            from angelira_robo.api_query import owners as _owners
            from angelira_robo.api_query.client import get_shared_client as _gsc
            _c = _gsc()
            o = None
            if req.owner_cnpj:
                o = _owners.find_by_cnpj(_c, req.owner_cnpj)
            elif req.owner_cpf:
                o = _owners.find_by_cpf(_c, req.owner_cpf)
            if o and o.get("id"):
                resolved_owner_id = int(o["id"])
            else:
                raise HTTPException(status_code=422, detail={
                    "etapa": "owner_nao_cadastrado",
                    "erro": (
                        f"Proprietario com documento '{owner_lookup_doc}' nao foi encontrado. "
                        f"Cadastre o proprietario PRIMEIRO via /api/robo/proprietario_api/iniciar."
                    ),
                    "causa": "proprietario_nao_existe_no_angellira",
                    "owner_documento_buscado": owner_lookup_doc,
                    "sub": sub,
                })
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=502, detail={
                "etapa": "owner_lookup_falhou",
                "erro": f"Erro consultando AngelLira pra resolver owner: {exc}",
                "owner_documento_buscado": owner_lookup_doc,
            })
    else:
        raise HTTPException(status_code=400, detail={
            "etapa": "owner_nao_informado",
            "erro": (
                "Veiculo exige proprietario: informe owner_cpf, owner_cnpj ou owner_id. "
                "Politica estrita: nunca cadastramos veiculo sem owner real."
            ),
        })

    placa_normalizada = "".join(
        c.upper() for c in str((payload.get(sub) or {}).get("placa")
                               or payload.get("placa") or "") if c.isalnum()
    )
    lock = await _doc_lock(f"veiculo:{placa_normalizada}")
    async with lock:
        try:
            resultado = await asyncio.to_thread(
                api_flow_veiculo.cadastrar_veiculo,
                payload,
                anexos=anexos_validados,
                sub=sub,
                owner_id=resolved_owner_id,
                relationship=req.relationship,
                prime=req.prime,
            )
            if isinstance(resultado, dict):
                resultado["owner_fallback"] = False
            if not resultado.get("ok"):
                raise HTTPException(status_code=502, detail={
                    "etapa": resultado.get("etapa"),
                    "duracao_s": resultado.get("duracao_s"),
                    "erro": resultado.get("erro"),
                    "vehicleId": resultado.get("vehicleId"),
                    "owner_fallback": False,
                })
            return resultado
        except HTTPException:
            raise
        except Exception as e:
            raise _tratar_erro(e, "robo/veiculo_api/iniciar")


# ── Pre-check passivo de owner divergente ────────────────────────────────────

class CheckOwnerRequest(BaseModel):
    placa: str
    expected_cpf: str = ""
    expected_cnpj: str = ""
    expected_tipo: str = ""   # "PF" ou "PJ" (opcional, ajuda no diagnostico)


@app.post("/api/robo/veiculo_api/check_owner")
async def robo_veiculo_check_owner(req: CheckOwnerRequest):
    """Verifica se veiculo ja existe e se owner atual diverge do esperado.

    Retorna diagnostico estruturado para o front decidir se mostra modal
    de confirmacao antes de disparar cadastro.
    """
    pronto, motivo_pronto = robo_auth.is_available()
    if not pronto:
        raise HTTPException(status_code=503, detail=f"AngelLira indisponivel: {motivo_pronto}")
    if not req.placa:
        raise HTTPException(status_code=400, detail="placa obrigatoria")

    from angelira_robo.api_query import vehicles as _vehicles
    from angelira_robo.api_query.client import get_shared_client as _gsc
    from angelira_robo.api_query.flow_veiculo import OWNERS_GENERICOS as _OWNERS_GENERICOS

    expected_cpf = "".join(c for c in (req.expected_cpf or "") if c.isdigit())
    expected_cnpj = "".join(c for c in (req.expected_cnpj or "") if c.isdigit())
    expected_tipo = (req.expected_tipo or "").strip().upper()
    if not expected_tipo:
        expected_tipo = "PJ" if expected_cnpj else ("PF" if expected_cpf else "")

    try:
        c = _gsc()
        placa_fmt = _vehicles.formatar_placa_api(req.placa)
        existente = await asyncio.to_thread(_vehicles.find_by_plate, c, placa_fmt)
    except Exception as exc:
        return {
            "ok": False, "erro": f"Falha consultando veiculo: {exc}",
            "veiculo_existe": None, "divergencia": False,
        }

    if not existente:
        return {
            "ok": True, "veiculo_existe": False,
            "expected": {"cpf": expected_cpf, "cnpj": expected_cnpj, "tipo": expected_tipo},
            "divergencia": False,
            "motivo": None,
        }

    vehicle_id = existente.get("id")
    owner = existente.get("owner") or {}
    owner_id = owner.get("id")
    owner_name = owner.get("name") or ""
    owner_cnpj = "".join(c for c in str(owner.get("cnpj") or "") if c.isdigit())
    owner_cpf = "".join(c for c in str(owner.get("cpf") or "") if c.isdigit())
    owner_tipo = "PJ" if owner_cnpj else ("PF" if owner_cpf else "DESCONHECIDO")
    owner_eh_generico = owner_id in _OWNERS_GENERICOS if owner_id else False

    if not owner_id or owner_eh_generico:
        return {
            "ok": True, "veiculo_existe": True, "vehicle_id": vehicle_id,
            "owner_atual": {"id": owner_id, "name": owner_name, "cnpj": owner_cnpj,
                            "cpf": owner_cpf, "tipo": owner_tipo},
            "owner_atual_eh_generico": owner_eh_generico,
            "expected": {"cpf": expected_cpf, "cnpj": expected_cnpj, "tipo": expected_tipo},
            "divergencia": False,
            "motivo": None,
        }

    doc_bate = False
    if owner_tipo == "PJ" and expected_cnpj and owner_cnpj == expected_cnpj:
        doc_bate = True
    elif owner_tipo == "PF" and expected_cpf and owner_cpf == expected_cpf:
        doc_bate = True

    if doc_bate:
        return {
            "ok": True, "veiculo_existe": True, "vehicle_id": vehicle_id,
            "owner_atual": {"id": owner_id, "name": owner_name, "cnpj": owner_cnpj,
                            "cpf": owner_cpf, "tipo": owner_tipo},
            "owner_atual_eh_generico": False,
            "expected": {"cpf": expected_cpf, "cnpj": expected_cnpj, "tipo": expected_tipo},
            "divergencia": False,
            "motivo": None,
        }

    motivo_parts = []
    if owner_tipo != expected_tipo and expected_tipo:
        motivo_parts.append(f"tipo divergente (atual={owner_tipo}, esperado={expected_tipo})")
    if owner_tipo == "PJ":
        motivo_parts.append(f"CNPJ atual={owner_cnpj or '?'} | esperado={expected_cnpj or expected_cpf or '?'}")
    elif owner_tipo == "PF":
        motivo_parts.append(f"CPF atual={owner_cpf or '?'} | esperado={expected_cpf or expected_cnpj or '?'}")
    motivo = (
        f"Veiculo ja cadastrado com {owner_tipo} '{owner_name}' (id={owner_id}). "
        + " | ".join(motivo_parts)
    )

    return {
        "ok": True, "veiculo_existe": True, "vehicle_id": vehicle_id,
        "owner_atual": {"id": owner_id, "name": owner_name, "cnpj": owner_cnpj,
                        "cpf": owner_cpf, "tipo": owner_tipo},
        "owner_atual_eh_generico": False,
        "expected": {"cpf": expected_cpf, "cnpj": expected_cnpj, "tipo": expected_tipo},
        "divergencia": True,
        "motivo": motivo,
    }
