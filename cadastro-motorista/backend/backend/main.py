import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

import asyncio

import anexo_storage
import gpt4o_vision
import infosimples
import ocr_router
from config import (
    BUNDLE_DIR,
    GPT4O_VISION_MODEL,
    INFOSIMPLES_TOKEN,
    MAX_IMAGE_BASE64_BYTES,
)

log = logging.getLogger("cadastro-motorista")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Singleton httpx client — reaproveita conexão TCP/TLS entre requests.
    client = httpx.AsyncClient(timeout=150)
    infosimples.set_client(client)
    log.info("Infosimples httpx client inicializado")

    # GPT-4o Vision client (Fase 1+2 migracao OCR). Idempotente; no-op se
    # OPENAI_API_KEY ausente. install_log_redactor() roda dentro de
    # init_client_from_env() so quando inicializa com sucesso.
    if gpt4o_vision.init_client_from_env():
        log.info("GPT-4o Vision pronto (model=%s)", GPT4O_VISION_MODEL)
    else:
        log.info("GPT-4o Vision desabilitado (OPENAI_API_KEY ausente ou SDK off)")

    # Fase 3 (2026-05-21): EasyOCR removido. Cartao CNPJ / comprovante /
    # rntrc agora rodam via GPT-4o Vision (vide ocr_router). Endpoints legacy
    # que apontavam para local_ocr retornam 501 — operacoes deveriam usar
    # OCR_*_STRATEGY=vision-only ou infosimples-with-vision-fallback.

    # Limpa anexos temporarios antigos (>24h) na inicializacao. Evita
    # acumulo se o front cair antes de finalizar um cadastro.
    try:
        removidas = anexo_storage.limpar_antigos()
        if removidas:
            log.info("Anexos antigos removidos no startup: %d pastas", removidas)
    except Exception:
        log.exception("Falha ao limpar anexos antigos no startup")

    try:
        yield
    finally:
        await client.aclose()
        log.info("Infosimples httpx client encerrado")


app = FastAPI(
    title="Cadastro Motorista — Lamonica",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS restrito a localhost (dev roda em 127.0.0.1:8765).
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8765",
        "http://127.0.0.1:8765",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

# Em dev: frontend/ esta na raiz do projeto. Em frozen: vem embutido no bundle
# (--add-data "frontend;frontend"). Config resolve os dois casos.
FRONTEND = BUNDLE_DIR / "frontend"

# Serve /vendor/* como arquivos estaticos (Tailwind + Alpine baixados pra uso
# offline — ver frontend/vendor/). Crucial pra demo: se a rede corporativa
# bloquear CDN (firewall/proxy) ou cair, a UI renderizaria sem estilo/JS.
if (FRONTEND / "vendor").is_dir():
    app.mount("/vendor", StaticFiles(directory=FRONTEND / "vendor"), name="vendor")


# ── Utilitário: error handler padrão ─────────────────────────────────────────

def _tratar_erro(e: Exception, ctx: str) -> HTTPException:
    """Loga detalhes internamente, retorna HTTP semantico ao cliente.

    Mapeamento:
      - InfosimplesTimeout   -> 504 (demo operador ve "tempo excedido")
      - InfosimplesAPIError  -> 502 (demo operador ve "servico externo falhou")
      - outros               -> 500 generico (mensagem aspira UX)
    """
    if isinstance(e, HTTPException):
        return e

    # Import local pra evitar dependencia circular no startup.
    from infosimples import InfosimplesAPIError, InfosimplesTimeout

    if isinstance(e, InfosimplesTimeout):
        log.warning("Timeout em %s: %s", ctx, e)
        return HTTPException(status_code=504, detail=str(e))
    if isinstance(e, InfosimplesAPIError):
        log.warning("API externa falhou em %s: %s", ctx, e)
        return HTTPException(status_code=502, detail=str(e))

    log.exception("Erro em %s: %s", ctx, e)
    return HTTPException(status_code=500, detail="Erro ao processar a requisição.")


# ── Servir frontend ──────────────────────────────────────────────────────────
# Frontend HTML standalone (FRONTEND / "index.html" + cadastro.html) foi
# substituído pela página React em frontend/src/modules/cadastro-motorista/.
# As rotas legacy só são montadas se os arquivos existirem (preserva a build
# do executável standalone, que ainda inclui a UI HTML).

if (FRONTEND / "index.html").is_file():
    @app.get("/")
    async def root():
        return FileResponse(FRONTEND / "index.html")

if (FRONTEND / "cadastro.html").is_file():
    @app.get("/cadastro")
    async def cadastro_page():
        return FileResponse(FRONTEND / "cadastro.html")


# ── Health / token check ─────────────────────────────────────────────────────

@app.get("/api/status")
async def status():
    token_ok = bool(INFOSIMPLES_TOKEN) and INFOSIMPLES_TOKEN != "COLE_SEU_TOKEN_AQUI"
    gpt4o_ready = gpt4o_vision.is_available()
    return {
        "ok": token_ok,
        "token_configurado": token_ok,
        "providers": {
            "gpt4o_vision_available": gpt4o_ready,
            "gpt4o_vision_model": GPT4O_VISION_MODEL if gpt4o_ready else None,
        },
        "strategies": {
            "cnh": ocr_router.strategy_for("cnh"),
            "crlv": ocr_router.strategy_for("crlv"),
            "cartao_cnpj": ocr_router.strategy_for("cartao_cnpj"),
            "rntrc": ocr_router.strategy_for("rntrc"),
            "comprovante": ocr_router.strategy_for("comprovante"),
            "selfie_cnh": ocr_router.strategy_for("selfie_cnh"),
        },
        "gpt4o_budget": gpt4o_vision.budget_snapshot() if gpt4o_ready else None,
    }


# ── Schemas ──────────────────────────────────────────────────────────────────

class OCRRequest(BaseModel):
    imagem: str
    # Opcional: quando preenchido, o backend persiste o arquivo em
    # anexos_tmp/<id>/<categoria>/<tipo>.<ext> e (no caso da CNH) tambem
    # extrai frente/verso/foto recortados pela Infosimples e renomeia a
    # pasta para o nome do motorista. Sem esse campo, comportamento
    # legado: roda OCR, retorna JSON, nao toca em disco.
    id_cadastro: str = ""

    @field_validator("imagem")
    @classmethod
    def validar_tamanho(cls, v: str) -> str:
        if len(v) > MAX_IMAGE_BASE64_BYTES:
            raise ValueError(
                f"Imagem excede {MAX_IMAGE_BASE64_BYTES // 1000}KB (base64)."
            )
        if not v.strip():
            raise ValueError("Imagem vazia.")
        return v


class CPFRequest(BaseModel):
    cpf: str
    nascimento: str  # DD/MM/AAAA


class CNPJRequest(BaseModel):
    cnpj: str


class ANTTRequest(BaseModel):
    cnpj: str = ""
    rntrc: str = ""
    cpf: str = ""  # TAC (transportador autonomo) usa CPF


class PlacaRequest(BaseModel):
    placa: str
    # Opcionais — Infosimples antt/veiculo aceita CPF/CNPJ do proprietario
    # como parametro de cruzamento (replica o comportamento do site
    # consultapublica.antt.gov.br que pede CPF + placa).
    cpf: str = ""
    cnpj: str = ""


class VeiculoSituacaoRequest(BaseModel):
    placa: str
    renavam: str = ""
    uf: str = ""    # ajuda a escolher o produto detran-{uf} mais especifico


class CEPRequest(BaseModel):
    cep: str


class ComprovanteRequest(OCRRequest):
    concessionaria: str  # cpfl | enel | cemig | light | energisa | neoenergia | rge | elektro


class CartaoCNPJRequest(OCRRequest):
    pass


CONCESSIONARIAS_OCR = {
    "cpfl": "ocr/contas-cpfl",
    "enel": "ocr/contas-enel",
    "cemig": "ocr/contas-cemig",
    "light": "ocr/contas-light",
    "energisa": "ocr/contas-energisa",
    "neoenergia": "ocr/contas-neoenergia",
    "rge": "ocr/contas-rge",
    "elektro": "ocr/contas-elektro",
}


# ── OCR — API de Imagens ─────────────────────────────────────────────────────

# 2026-05-21 — Helpers de PDF preservados da branch antiga (Fase F Bug #2).
# Infosimples /ocr/crlv rejeita PDFs com >1 página (erro 701). CRLVs reais
# costumam vir com 2 páginas (frente + verso); a frente tem todos os dados.
# Usamos pypdf para extrair a página 1 antes de chamar Infosimples no path
# de fallback do ocr_router. Vision (GPT-4o) processa multi-página direto,
# então é só pro primary=infosimples.


def _is_pdf_payload(imagem_base64: str) -> bool:
    """True se o base64 representa um PDF. Detecta `data:application/pdf`
    ou magic bytes `%PDF` após decode. Permite rotear JPG/PNG e PDF nativo
    por paths diferentes quando o provider precisa de PDF (Infosimples)."""
    import base64 as _b64
    try:
        raw = imagem_base64
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        data = _b64.b64decode(raw, validate=False)
    except Exception:
        return False
    return data[:4] == b"%PDF"


def _extrair_primeira_pagina_pdf_base64(imagem_base64: str) -> str:
    """Garante 1 página — Infosimples /ocr/crlv rejeita PDFs multi-página.
    Se input não for PDF, devolve sem mexer. Se for PDF com 1 página, idem.
    Se for PDF com 2+, extrai apenas página 1 (frente do CRLV onde estão
    todos os dados do veículo)."""
    import base64 as _b64
    import io as _io
    try:
        raw = imagem_base64
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        data = _b64.b64decode(raw, validate=False)
    except Exception:
        return imagem_base64
    if data[:4] != b"%PDF":
        return imagem_base64
    try:
        from pypdf import PdfReader, PdfWriter  # type: ignore[import-untyped]
    except ImportError:
        log.warning("pypdf indisponivel — devolvendo PDF original")
        return imagem_base64
    try:
        reader = PdfReader(_io.BytesIO(data))
        if len(reader.pages) <= 1:
            return imagem_base64
        writer = PdfWriter()
        writer.add_page(reader.pages[0])
        buf = _io.BytesIO()
        writer.write(buf)
        log.info(
            "PDF multipagina (%s paginas) -> extraida pagina 1 para OCR",
            len(reader.pages),
        )
        return _b64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        log.warning("Falha ao extrair pagina 1 do PDF: %s — devolvendo original", exc)
        return imagem_base64


def _pdf_to_jpeg_base64(imagem_base64: str) -> str:
    """Converte a página 1 de um PDF em JPEG base64 para GPT-4o Vision.

    GPT-4o Vision não aceita PDFs diretamente (apenas JPEG/PNG/WEBP/GIF).
    Usa pymupdf (fitz) para rasterizar. Se o input não for PDF ou a biblioteca
    não estiver disponível, devolve o payload original sem mexer.
    """
    import base64 as _b64
    import io as _io
    try:
        raw = imagem_base64
        if raw.startswith("data:"):
            _, _, raw = raw.partition(",")
        data = _b64.b64decode(raw, validate=False)
    except Exception:
        return imagem_base64
    if data[:4] != b"%PDF":
        return imagem_base64  # já é imagem — sem conversão
    try:
        import fitz  # type: ignore[import-untyped]  # pymupdf
    except ImportError:
        log.warning("pymupdf indisponivel — devolvendo PDF original (Vision pode rejeitar)")
        return imagem_base64
    try:
        doc = fitz.open(stream=data, filetype="pdf")
        page = doc[0]
        # DPI 150 — equilibrio entre qualidade OCR e tamanho do payload
        pix = page.get_pixmap(dpi=150)
        jpeg_bytes = pix.tobytes("jpeg")
        doc.close()
        log.info("PDF rasterizado para JPEG (%d bytes) para Vision API", len(jpeg_bytes))
        return _b64.b64encode(jpeg_bytes).decode("ascii")
    except Exception as exc:
        log.warning("Falha ao rasterizar PDF para JPEG: %s — devolvendo original", exc)
        return imagem_base64


def _persistir_anexo_basico(tipo: str, imagem_base64: str, id_cadastro: str) -> None:
    """Salva o arquivo enviado em ANEXOS_DIR/<id>/<categoria>/<tipo>.<ext>.

    No-op silencioso se id_cadastro vazio ou erro nao-fatal — OCR ja foi
    bem-sucedido, persistencia em disco e bonus pro robo AngelLira.
    """
    if not id_cadastro:
        return
    try:
        anexo_storage.salvar(tipo, imagem_base64, id_cadastro)
    except anexo_storage.AnexoError as e:
        log.warning("Falha ao salvar anexo %s id=%s: %s", tipo, id_cadastro, e)


def _extrair_recortes_cnh(resposta: dict, id_cadastro: str, prefixo: str) -> str | None:
    """Salva frente, verso e foto 3x4 que a Infosimples ja recortou.
    Para CNH do motorista (prefixo='motorista'), tambem renomeia a pasta
    com o nome extraido. Para CNH do proprietario, nao renomeia (a pasta
    ja foi nomeada pelo cadastro do motorista).

    Retorna o id_cadastro novo (slug) se o rename ocorrer, senao None.
    """
    if not id_cadastro:
        return None

    cnh_frente_tipo = f"cnh_{prefixo}_frente"
    cnh_verso_tipo = f"cnh_{prefixo}_verso"
    foto_tipo = f"foto_{prefixo}" if prefixo == "motorista" else None

    nome_extraido = None
    for entry in resposta.get("data", []) or []:
        tipo_cnh = entry.get("tipo")
        image_b64 = entry.get("image_base64")

        if tipo_cnh == "cnh_frente" and image_b64:
            try:
                anexo_storage.salvar(cnh_frente_tipo, image_b64, id_cadastro)
            except anexo_storage.AnexoError as e:
                log.warning("Falha ao salvar %s id=%s: %s", cnh_frente_tipo, id_cadastro, e)
            campos = entry.get("campos") or {}
            foto = (campos.get("foto") or {}).get("valor_base64")
            if foto and foto_tipo:
                try:
                    anexo_storage.salvar(foto_tipo, foto, id_cadastro)
                except anexo_storage.AnexoError as e:
                    log.warning("Falha ao salvar %s id=%s: %s", foto_tipo, id_cadastro, e)
            nome_extraido = (campos.get("nome") or {}).get("valor")

        elif tipo_cnh == "cnh_verso" and image_b64:
            try:
                anexo_storage.salvar(cnh_verso_tipo, image_b64, id_cadastro)
            except anexo_storage.AnexoError as e:
                log.warning("Falha ao salvar %s id=%s: %s", cnh_verso_tipo, id_cadastro, e)

    # Auto-rename apenas para CNH do motorista (define o nome da pasta)
    if prefixo == "motorista" and nome_extraido and nome_extraido.strip():
        try:
            return anexo_storage.renomear_pasta_cadastro(id_cadastro, nome_extraido)
        except anexo_storage.AnexoError as e:
            log.warning(
                "Falha ao renomear pasta id=%s nome=%r: %s", id_cadastro, nome_extraido, e
            )
    return None


# ── Helpers para o ocr_router ───────────────────────────────────────────────


def _renomear_pelo_envelope(envelope: dict, id_efetivo: str, prefixo: str) -> str | None:
    """Extrai nome do envelope (Infosimples ou Vision) e renomeia a pasta.

    Usado pelos endpoints CNH/CRLV apos o ocr_router retornar. Retorna o
    novo id_cadastro (slug) ou None se nao houver nome legivel.
    """
    if not isinstance(envelope, dict):
        return None
    data = envelope.get("data")
    if not isinstance(data, list) or not data:
        return None
    item = data[0] if isinstance(data[0], dict) else None
    if not item:
        return None
    campos = item.get("campos") if isinstance(item.get("campos"), dict) else {}
    nome_field = campos.get("nome") if isinstance(campos, dict) else None
    nome = (
        nome_field.get("valor") if isinstance(nome_field, dict) else nome_field
    )
    if not nome or not isinstance(nome, str) or not nome.strip():
        return None
    try:
        return anexo_storage.renomear_pasta_cadastro(id_efetivo, nome.strip())
    except anexo_storage.AnexoError as e:
        log.warning("rename pasta falhou para %s: %s", id_efetivo, e)
        return None


@app.post("/api/ocr/cnh")
async def ocr_cnh(req: OCRRequest):
    try:
        # Compat: ":proprietario" no fim do id_cadastro indica CNH do dono PF
        # (mesmo endpoint OCR, mas salva em proprietario/ em vez de motorista/).
        prefixo = "motorista"
        id_efetivo = req.id_cadastro
        if id_efetivo.endswith(":proprietario"):
            prefixo = "proprietario"
            id_efetivo = id_efetivo[: -len(":proprietario")]

        await asyncio.to_thread(
            _persistir_anexo_basico, f"cnh_{prefixo}", req.imagem, id_efetivo
        )

        async def _primary_infosimples() -> dict:
            resposta = await infosimples.ocr("ocr/cnh", req.imagem)
            # Recortes (frente/verso/foto) so existem no envelope Infosimples.
            novo_id = await asyncio.to_thread(
                _extrair_recortes_cnh, resposta, id_efetivo, prefixo
            )
            if novo_id:
                resposta["id_cadastro_pasta"] = novo_id
            return resposta

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("cnh", req.imagem)

        envelope = await ocr_router.route(
            "cnh",
            primary=_primary_infosimples,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("cnh"),
        )

        # Quando veio do fallback Vision (sem recortes), tenta renomear
        # pela campos.nome do envelope. Se primary OK, ja tem id_cadastro_pasta.
        if "id_cadastro_pasta" not in envelope and (envelope.get("header") or {}).get(
            "provider", ""
        ).startswith("gpt4o-vision"):
            novo_id = await asyncio.to_thread(
                _renomear_pelo_envelope, envelope, id_efetivo, prefixo
            )
            if novo_id:
                envelope["id_cadastro_pasta"] = novo_id

        return envelope
    except Exception as e:
        raise _tratar_erro(e, "ocr/cnh")


@app.post("/api/ocr/crlv")
async def ocr_crlv(req: OCRRequest):
    try:
        # CRLV nao tem campo no schema pra distinguir cavalo/carreta — o
        # frontend chama /api/ocr/crlv duas vezes e decide. Aqui assumimos
        # cavalo por padrao; se id_cadastro vier com sufixo ":carreta",
        # gravamos como crlv_carreta. Compat: id_cadastro continua sendo
        # validado por _validar_id_cadastro (so [A-Za-z0-9_-]).
        tipo = "crlv_cavalo"
        id_efetivo = req.id_cadastro
        if id_efetivo.endswith(":carreta"):
            tipo = "crlv_carreta"
            id_efetivo = id_efetivo[: -len(":carreta")]
        await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

        # Fase F Bug #2: Infosimples /ocr/crlv exige PDFs com 1 pagina. CRLVs
        # reais costumam vir com 2 (frente + verso). Vision aceita multi-pagina,
        # so o path Infosimples precisa do split. Calculado uma vez antes do
        # route() pra evitar duplicar trabalho se primary chamar 2x.
        imagem_para_infosimples = await asyncio.to_thread(
            _extrair_primeira_pagina_pdf_base64, req.imagem
        )

        async def _primary_infosimples() -> dict:
            return await infosimples.ocr("ocr/crlv", imagem_para_infosimples)

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("crlv", req.imagem)

        return await ocr_router.route(
            "crlv",
            primary=_primary_infosimples,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("crlv"),
        )
    except Exception as e:
        raise _tratar_erro(e, "ocr/crlv")


@app.post("/api/ocr/comprovante-residencia")
async def ocr_comprovante_residencia(req: ComprovanteRequest):
    try:
        # Compat: ":proprietario" no fim do id_cadastro indica que e o
        # comprovante do dono (PF), nao do motorista.
        tipo = "comprovante_motorista"
        id_efetivo = req.id_cadastro
        if id_efetivo.endswith(":proprietario"):
            tipo = "comprovante_proprietario"
            id_efetivo = id_efetivo[: -len(":proprietario")]
        await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

        async def _primary_legacy() -> dict:
            # Fase 3 (2026-05-21): EasyOCR removido. Legacy agora so via
            # Infosimples (sem branch "local"). Para imagens nao-PDF, recomenda-se
            # OCR_COMPROVANTE_STRATEGY=vision-only.
            service = CONCESSIONARIAS_OCR.get(req.concessionaria.lower())
            if not service:
                raise HTTPException(
                    status_code=400,
                    detail=f"Concessionária inválida. Opções: {', '.join(CONCESSIONARIAS_OCR)}.",
                )
            return await infosimples.ocr(service, req.imagem)

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("comprovante", req.imagem)

        return await ocr_router.route(
            "comprovante",
            primary=_primary_legacy,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("comprovante"),
        )
    except Exception as e:
        raise _tratar_erro(e, f"ocr/comprovante-{req.concessionaria}")


@app.post("/api/ocr/cartao-cnpj")
async def ocr_cartao_cnpj(req: CartaoCNPJRequest):
    """OCR do Comprovante de Inscrição CNPJ (Receita Federal).

    Strategies suportadas (vide config.OCR_CARTAO_CNPJ_STRATEGY):
      - legacy: Infosimples generico (ocr/cnpj) — qualidade media
      - vision-only: GPT-4o Vision direto (recomendado)
      - infosimples-with-vision-fallback: legacy primary, Vision se falhar
    """
    try:
        # Compat: ":carreta" indica que e o cartao CNPJ do dono da carreta
        # (quando carreta tem proprietario diferente do cavalo).
        tipo = "cartao_cnpj"
        id_efetivo = req.id_cadastro
        if id_efetivo.endswith(":carreta"):
            tipo = "cartao_cnpj_carreta"
            id_efetivo = id_efetivo[: -len(":carreta")]
        await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

        async def _primary_legacy() -> dict:
            # Fase 3 (2026-05-21): EasyOCR removido. Legacy = Infosimples generico.
            return await infosimples.ocr("ocr/cnpj", req.imagem)

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("cartao_cnpj", req.imagem)

        return await ocr_router.route(
            "cartao_cnpj",
            primary=_primary_legacy,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("cartao_cnpj"),
        )
    except Exception as e:
        raise _tratar_erro(e, "ocr/cartao-cnpj")


# ── Endpoints novos (Fase 2 da migração OCR) ────────────────────────────────


@app.post("/api/ocr/rntrc")
async def ocr_rntrc(req: OCRRequest):
    """OCR do comprovante ANTT/RNTRC do titular.

    Provider primario: GPT-4o Vision (sem provider Infosimples dedicado para
    OCR de comprovante ANTT). Fallback: nao ha — quando vision falha, retorna
    envelope de erro e o frontend pede ao motorista que tente outra foto.

    Compat: ":carreta" no id_cadastro indica que e o documento do dono da
    carreta (RNTRC eventualmente diferente do cavalo).
    """
    try:
        tipo = "rntrc_proprietario"
        id_efetivo = req.id_cadastro
        if id_efetivo.endswith(":carreta"):
            tipo = "rntrc_proprietario_carreta"
            id_efetivo = id_efetivo[: -len(":carreta")]
        await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

        async def _primary_legacy() -> dict:
            # Fase 3 (2026-05-21): EasyOCR removido. RNTRC nunca teve provider
            # primario alem do local (substituido pelo Vision). 501 sinaliza
            # ao caller que strategy=legacy nao faz mais sentido aqui.
            raise HTTPException(
                status_code=501,
                detail=(
                    "OCR/rntrc requer GPT-4o Vision. "
                    "Configure OCR_RNTRC_STRATEGY=vision-only (default)."
                ),
            )

        # Bug #3 — PDF RNTRC: GPT-4o Vision nao aceita PDFs diretamente.
        # Rasteriza pagina 1 para JPEG antes de enviar ao Vision API.
        imagem_para_vision = await asyncio.to_thread(_pdf_to_jpeg_base64, req.imagem)

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("rntrc", imagem_para_vision)

        return await ocr_router.route(
            "rntrc",
            primary=_primary_legacy,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("rntrc"),
        )
    except Exception as e:
        raise _tratar_erro(e, "ocr/rntrc")


@app.post("/api/ocr/selfie-cnh")
async def ocr_selfie_cnh(req: OCRRequest):
    """OCR/validacao de selfie do motorista segurando a propria CNH.

    Provider unico: GPT-4o Vision. Retorna campos:
      - cnh_visible: 'true' ou 'false'
      - face_visible: 'true' ou 'false'
      - match_score: 0.0-1.0 ou null (similaridade rosto selfie x foto CNH)
      - nome_cnh_legivel: nome impresso na CNH se legivel
      - observacoes: motivo se match baixo / CNH ilegivel

    O frontend usa esses campos pra bloquear selfies invalidas (match_score
    baixo ou CNH ausente) antes de avancar no wizard.
    """
    try:
        await asyncio.to_thread(
            _persistir_anexo_basico, "selfie_cnh_motorista", req.imagem, req.id_cadastro
        )

        async def _primary_unsupported() -> dict:
            # selfie_cnh nao tem provider primario alem do Vision — strategy
            # "legacy" nao faz sentido aqui. Retornamos envelope estruturado
            # que o frontend exibe como erro acionavel.
            return {
                "code": 501,
                "code_message": (
                    "selfie-cnh requer GPT-4o Vision. Configure OPENAI_API_KEY "
                    "ou ajuste OCR_SELFIE_CNH_STRATEGY=vision-only."
                ),
                "data": [],
                "data_count": 0,
                "errors": ["no_legacy_provider"],
                "header": {"provider": "none"},
            }

        async def _vision_extract() -> dict:
            return await gpt4o_vision.extract("selfie_cnh", req.imagem)

        return await ocr_router.route(
            "selfie_cnh",
            primary=_primary_unsupported,
            vision=_vision_extract,
            strategy=ocr_router.strategy_for("selfie_cnh"),
        )
    except Exception as e:
        raise _tratar_erro(e, "ocr/selfie-cnh")


# ── Consultas — Motorista ────────────────────────────────────────────────────

@app.post("/api/consulta/cpf")
async def consultar_cpf(req: CPFRequest):
    try:
        cpf = "".join(filter(str.isdigit, req.cpf))
        digitos = "".join(filter(str.isdigit, req.nascimento))
        if len(cpf) != 11 or len(digitos) != 8:
            raise HTTPException(
                status_code=400,
                detail="Informe CPF (11 dígitos) e data de nascimento (DD/MM/AAAA).",
            )
        birthdate = f"{digitos[4:8]}-{digitos[2:4]}-{digitos[0:2]}"  # YYYY-MM-DD
        return await infosimples.consultar(
            "receita-federal/cpf", {"cpf": cpf, "birthdate": birthdate}
        )
    except Exception as e:
        raise _tratar_erro(e, "consulta/cpf")


# ── Consultas — Empresa ──────────────────────────────────────────────────────

@app.post("/api/consulta/cnpj")
async def consultar_cnpj(req: CNPJRequest):
    try:
        cnpj = "".join(filter(str.isdigit, req.cnpj))
        if len(cnpj) != 14:
            raise HTTPException(status_code=400, detail="CNPJ inválido (14 dígitos).")
        return await infosimples.consultar("receita-federal/cnpj", {"cnpj": cnpj})
    except Exception as e:
        raise _tratar_erro(e, "consulta/cnpj")


@app.post("/api/consulta/antt")
async def consultar_antt(req: ANTTRequest):
    """Consulta ANTT do transportador por CNPJ, RNTRC ou CPF (TAC)."""
    try:
        params: dict = {}
        if req.cnpj:
            cnpj = "".join(filter(str.isdigit, req.cnpj))
            if len(cnpj) != 14:
                raise HTTPException(status_code=400, detail="CNPJ inválido (14 dígitos).")
            params["cnpj"] = cnpj
        elif req.rntrc:
            rntrc = "".join(filter(str.isdigit, req.rntrc))
            if not rntrc:
                raise HTTPException(status_code=400, detail="RNTRC inválido.")
            params["rntrc"] = rntrc
        elif req.cpf:
            cpf = "".join(filter(str.isdigit, req.cpf))
            if len(cpf) != 11:
                raise HTTPException(status_code=400, detail="CPF inválido (11 dígitos).")
            params["cpf"] = cpf
        else:
            raise HTTPException(status_code=400, detail="Informe CNPJ, RNTRC ou CPF.")
        return await infosimples.consultar("antt/transportador", params)
    except Exception as e:
        raise _tratar_erro(e, "consulta/antt")


@app.post("/api/consulta/antt-veiculo")
async def consultar_antt_veiculo(req: PlacaRequest):
    """Busca RNTRC por placa, com fallbacks que cruzam CPF/CNPJ quando disponivel.

    A consulta publica da ANTT (consultapublica.antt.gov.br) aceita
    CPF + placa para localizar TAC e CNPJ + placa para ETC/CTC. A Infosimples
    expoe variantes desse fluxo em produtos diferentes. Tentamos em ordem:

      1) antt/transportador {cpf}    — se CPF informado (TAC)
      2) antt/transportador {cnpj}   — se CNPJ informado (ETC/CTC)
      3) antt/veiculo {placa}        — placa-only (algumas contas tem)
      4) antt/registro-rntrc {placa} — variante alternativa
      5) antt/consulta-rntrc {placa, cpf?, cnpj?} — produto que mirroriza
         o site publico, exigindo cruzamento doc + placa

    Primeiro produto que retornar code 200 com dados ganha.
    """
    placa = "".join(ch for ch in req.placa.upper() if ch.isalnum())
    cpf = "".join(filter(str.isdigit, req.cpf or ""))
    cnpj = "".join(filter(str.isdigit, req.cnpj or ""))
    if len(placa) != 7:
        raise HTTPException(status_code=400, detail="Placa inválida (7 caracteres).")

    tentativas: list[dict] = []

    async def tenta(produto: str, params: dict) -> dict | None:
        try:
            r = await infosimples.consultar(produto, params)
            tentativas.append({"produto": produto, "params": list(params.keys()), "code": r.get("code")})
            if r.get("code") == 200 and r.get("data"):
                r["_produto_usado"] = produto
                return r
        except Exception as e:
            tentativas.append({"produto": produto, "params": list(params.keys()), "erro": str(e)[:120]})
        return None

    # 1) TAC: transportador por CPF
    if len(cpf) == 11:
        result = await tenta("antt/transportador", {"cpf": cpf})
        if result:
            return result

    # 2) ETC/CTC: transportador por CNPJ
    if len(cnpj) == 14:
        result = await tenta("antt/transportador", {"cnpj": cnpj})
        if result:
            return result

    # 3-4) Produtos placa-only
    for produto in ("antt/veiculo", "antt/registro-rntrc"):
        result = await tenta(produto, {"placa": placa})
        if result:
            return result

    # 5) Consulta-publica com cruzamento doc + placa (caso o produto exista)
    if len(cpf) == 11 or len(cnpj) == 14:
        params: dict = {"placa": placa}
        if cpf:
            params["cpf"] = cpf
        elif cnpj:
            params["cnpj"] = cnpj
        result = await tenta("antt/consulta-rntrc", params)
        if result:
            return result

    return {
        "code": 612,
        "code_message": "RNTRC nao localizado em nenhum produto Infosimples (placa, CPF, CNPJ).",
        "data": [],
        "tentativas": tentativas,
    }


# ── Consulta — Situacao do veiculo por placa (DENATRAN/SENATRAN/DETRAN) ────


@app.post("/api/consulta/veiculo-situacao")
async def consultar_veiculo_situacao(req: VeiculoSituacaoRequest):
    """Consulta situacao do veiculo (licenciamento, debitos, restricoes) por placa.

    Tenta produtos Infosimples em cascata. Como nem todas as contas tem todos
    os produtos liberados, o backend testa vários e devolve o primeiro que der
    sucesso. UF + RENAVAM ajudam quando o produto exige.
    """
    placa = "".join(ch for ch in req.placa.upper() if ch.isalnum())
    if len(placa) != 7:
        raise HTTPException(status_code=400, detail="Placa inválida (7 caracteres).")

    renavam = "".join(filter(str.isdigit, req.renavam or ""))
    uf = (req.uf or "").lower().strip()

    tentativas: list[dict] = []

    async def tenta(produto: str, params: dict) -> dict | None:
        try:
            r = await infosimples.consultar(produto, params)
            tentativas.append({"produto": produto, "params": list(params.keys()), "code": r.get("code")})
            if r.get("code") == 200 and r.get("data"):
                r["_produto_usado"] = produto
                return r
        except Exception as e:
            tentativas.append({"produto": produto, "params": list(params.keys()), "erro": str(e)[:120]})
        return None

    # 1) Detran estadual (mais detalhado quando UF + renavam disponiveis)
    if uf and renavam:
        params = {"placa": placa, "renavam": renavam}
        result = await tenta(f"detran-{uf}/restricoes-veiculo", params)
        if result:
            return result
        result = await tenta(f"detran-{uf}/situacao-veiculo", params)
        if result:
            return result

    # 2) DENATRAN nacional (cobre maioria dos estados)
    if renavam:
        result = await tenta("denatran/restricoes-veiculo", {"placa": placa, "renavam": renavam})
        if result:
            return result
    result = await tenta("denatran/restricoes-veiculo", {"placa": placa})
    if result:
        return result

    # 3) SINESP Cidadao (fallback nacional, dados basicos)
    result = await tenta("senatran/sinesp-cidadao", {"placa": placa})
    if result:
        return result

    return {
        "code": 612,
        "code_message": "Situacao do veiculo nao localizada em nenhum produto.",
        "data": [],
        "tentativas": tentativas,
    }


# ── Consultas — Endereço (CEP) ───────────────────────────────────────────────

@app.post("/api/consulta/cep")
async def consultar_cep(req: CEPRequest):
    try:
        cep = "".join(filter(str.isdigit, req.cep))
        if len(cep) != 8:
            raise HTTPException(status_code=400, detail="CEP inválido (8 dígitos).")
        return await infosimples.consultar("correios/cep", {"cep": cep})
    except Exception as e:
        raise _tratar_erro(e, "consulta/cep")


# ── Anexos (persistencia em disco) ───────────────────────────────────────────


class AnexoSalvarRequest(BaseModel):
    """Persiste um arquivo enviado pelo front em anexos_tmp/.

    Util para casos em que o front precisa salvar um documento sem rodar
    OCR (re-upload manual ou tipo nao coberto pelos endpoints /api/ocr/*).
    Os endpoints /api/ocr/* ja salvam internamente quando recebem id_cadastro.
    """
    tipo: str  # ver anexo_storage.TIPOS_VALIDOS
    imagem: str  # base64, com ou sem prefixo data:
    id_cadastro: str  # id da sessao de cadastro (ou slug do nome do motorista)

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
    """Salva em anexos_tmp/<id_cadastro>/<categoria>/<tipo>.<ext>.

    Categoria (motorista | veiculo | proprietario) e deduzida do `tipo`
    pelo modulo anexo_storage. Retorna {anexo_path, bytes, tipo}.
    """
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
        raise _tratar_erro(e, "anexo/salvar")


@app.post("/api/anexo/limpar")
async def anexo_limpar(id_cadastro: str):
    """Apaga a pasta de um cadastro especifico. Chamado ao concluir/cancelar."""
    try:
        removidos = await asyncio.to_thread(anexo_storage.limpar_cadastro, id_cadastro)
        return {"ok": True, "removidos": removidos}
    except Exception as e:
        raise _tratar_erro(e, "anexo/limpar")


class AnexoRenomearRequest(BaseModel):
    id_cadastro: str
    nome_motorista: str


@app.post("/api/anexo/renomear-pasta")
async def anexo_renomear_pasta(req: AnexoRenomearRequest):
    """Renomeia a pasta do cadastro para usar o nome do motorista.

    Frontend chama isso depois que o OCR da CNH retorna o nome real, pra
    transformar `cad_xxxx/` em `fernando_silva/`. Mantem um slug seguro
    (sem acentos, lower, underscore). Retorna o novo `id_cadastro` que o
    frontend deve adotar dali em diante.
    """
    try:
        novo_id = await asyncio.to_thread(
            anexo_storage.renomear_pasta_cadastro,
            req.id_cadastro,
            req.nome_motorista,
        )
        return {"ok": True, "id_cadastro": novo_id}
    except anexo_storage.AnexoError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise _tratar_erro(e, "anexo/renomear-pasta")
