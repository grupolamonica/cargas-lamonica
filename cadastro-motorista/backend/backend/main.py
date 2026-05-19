import base64
import io
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
import infosimples
import local_ocr
from config import (
    BUNDLE_DIR,
    INFOSIMPLES_TOKEN,
    MAX_IMAGE_BASE64_BYTES,
    OCR_CARTAO_CNPJ_PROVIDER,
    OCR_COMPROVANTE_PROVIDER,
)

log = logging.getLogger("cadastro-motorista")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Singleton httpx client — reaproveita conexão TCP/TLS entre requests.
    client = httpx.AsyncClient(timeout=150)
    infosimples.set_client(client)
    log.info("Infosimples httpx client inicializado")

    # Warm-up do OCR local se algum provider=local (pré-carrega modelos em background).
    precisa_local = "local" in (OCR_COMPROVANTE_PROVIDER, OCR_CARTAO_CNPJ_PROVIDER)
    if precisa_local:
        if local_ocr.is_available():
            log.info(
                "OCR local ativo (comprovante=%s, cartao_cnpj=%s) — aquecendo modelos...",
                OCR_COMPROVANTE_PROVIDER, OCR_CARTAO_CNPJ_PROVIDER,
            )
            # Warmup não bloqueia o startup — roda em background.
            import asyncio as _asyncio
            _asyncio.create_task(local_ocr.warmup())
        else:
            log.warning(
                "OCR_*_PROVIDER=local mas easyocr nao instalado. "
                "Execute: pip install -r requirements-ocr.txt "
                "(ou troque para OCR_*_PROVIDER=infosimples em .env)."
            )

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
    return {
        "ok": token_ok,
        "token_configurado": token_ok,
        "providers": {
            "comprovante": OCR_COMPROVANTE_PROVIDER,
            "cartao_cnpj": OCR_CARTAO_CNPJ_PROVIDER,
            "local_disponivel": local_ocr.is_available(),
        },
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


def _decode_imagem_payload(payload: str) -> tuple[bytes, str]:
    """Aceita data-URI (`data:image/jpeg;base64,...`) ou base64 puro. Retorna
    (bytes, mime) — mime é "application/pdf" se a entrada já era PDF.
    """
    raw = payload
    mime = "application/octet-stream"
    if raw.startswith("data:"):
        header, _, raw = raw.partition(",")
        # data:image/jpeg;base64
        if ";" in header and ":" in header:
            mime = header.split(":", 1)[1].split(";", 1)[0].strip() or mime
    try:
        return base64.b64decode(raw, validate=False), mime
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Base64 inválido: {exc}")


def _garantir_pdf_base64(imagem_base64: str) -> str:
    """Converte imagem JPG/PNG → PDF em memória. Se já é PDF, devolve a string
    sem prefixo `data:` para a Infosimples consumir.

    Necessário porque /imagens/ocr/contas/* exige `pdf_base64` (não aceita
    `image_base64`). PIL/Pillow vem como dependência transitiva do easyocr.
    """
    data, mime = _decode_imagem_payload(imagem_base64)
    if mime == "application/pdf" or data[:4] == b"%PDF":
        return base64.b64encode(data).decode("ascii")

    try:
        from PIL import Image  # type: ignore[import-untyped]
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "Conversão imagem→PDF indisponível: Pillow não instalado no "
                "sidecar. Reinstale a imagem cadastro-ocr com easyocr (que "
                "puxa Pillow) ou envie um PDF direto."
            ),
        ) from exc

    try:
        img = Image.open(io.BytesIO(data))
        # PDF não suporta alpha + alguns modos; força RGB
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        img.save(buf, format="PDF", resolution=200.0)
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Não foi possível converter a imagem para PDF: {exc}",
        ) from exc


CONCESSIONARIAS_OCR = {
    # Infosimples Imagens usa BARRAS, não hífens (`ocr/contas/cpfl`, não
    # `ocr/contas-cpfl`). O slug com hífen retorna code 602 ("serviço
    # informado na URL não é válido"). Validado via curl direto contra
    # api.infosimples.com em 2026-05-19.
    "cpfl": "ocr/contas/cpfl",
    "enel": "ocr/contas/enel",
    "cemig": "ocr/contas/cemig",
    "light": "ocr/contas/light",
    "energisa": "ocr/contas/energisa",
    "neoenergia": "ocr/contas/neoenergia",
    "rge": "ocr/contas/rge",
    "elektro": "ocr/contas/elektro",
}


# ── OCR — API de Imagens ─────────────────────────────────────────────────────

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
        resposta = await infosimples.ocr("ocr/cnh", req.imagem)
        novo_id = await asyncio.to_thread(
            _extrair_recortes_cnh, resposta, id_efetivo, prefixo
        )
        if novo_id:
            resposta["id_cadastro_pasta"] = novo_id
        return resposta
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
        return await infosimples.ocr("ocr/crlv", req.imagem)
    except Exception as e:
        raise _tratar_erro(e, "ocr/crlv")


@app.post("/api/ocr/comprovante-residencia")
async def ocr_comprovante_residencia(req: ComprovanteRequest):
    # Compat: ":proprietario" no fim do id_cadastro indica que e o
    # comprovante do dono (PF), nao do motorista.
    tipo = "comprovante_motorista"
    id_efetivo = req.id_cadastro
    if id_efetivo.endswith(":proprietario"):
        tipo = "comprovante_proprietario"
        id_efetivo = id_efetivo[: -len(":proprietario")]
    await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

    # Roteamento por provider: "local" (EasyOCR, grátis) ou "infosimples" (pago).
    if OCR_COMPROVANTE_PROVIDER == "local":
        if not local_ocr.is_available():
            raise HTTPException(
                status_code=503,
                detail=(
                    "OCR local selecionado mas easyocr nao instalado. "
                    "Execute: pip install -r requirements-ocr.txt"
                ),
            )
        try:
            return await local_ocr.ocr_comprovante(req.imagem)
        except Exception as e:
            raise _tratar_erro(e, "local/comprovante")

    # Provider padrão: Infosimples (por concessionária).
    service = CONCESSIONARIAS_OCR.get(req.concessionaria.lower())
    if not service:
        raise HTTPException(
            status_code=400,
            detail=f"Concessionária inválida. Opções: {', '.join(CONCESSIONARIAS_OCR)}.",
        )
    try:
        # Infosimples /imagens/ocr/contas/* exige `pdf_base64` (não `image_base64`).
        # Se o motorista enviou JPG/PNG, convertemos para PDF em memória antes
        # de chamar. PDFs vindos do frontend passam direto.
        pdf_b64 = await asyncio.to_thread(_garantir_pdf_base64, req.imagem)
        return await infosimples.ocr(service, pdf_b64, param_name="pdf_base64")
    except Exception as e:
        raise _tratar_erro(e, f"ocr/comprovante-{req.concessionaria}")


@app.post("/api/ocr/cartao-cnpj")
async def ocr_cartao_cnpj(req: CartaoCNPJRequest):
    """Extrai dados do Comprovante de Inscrição CNPJ.

    Infosimples NÃO tem endpoint Imagens dedicado a cartão CNPJ (validado em
    2026-05-19 testando 18+ slugs; todos retornam code 602). O endpoint que
    cobre o caso de uso é `/consultas/receita-federal/cnpj` — dados oficiais
    a partir do número do CNPJ.

    Estratégia 'local' (recomendada e default):
    1. EasyOCR local extrai texto da imagem
    2. Regex pega os 14 dígitos
    3. Sidecar chama Infosimples consulta receita-federal/cnpj com o CNPJ
    4. Retorna no formato OCR (campos extraidos + envelope) — drop-in
       compatível com o frontend existente.

    Se easyocr não estiver disponível na imagem do sidecar, devolve 503
    com instrução clara.
    """
    # Compat: ":carreta" indica que e o cartao CNPJ do dono da carreta
    # (quando carreta tem proprietario diferente do cavalo).
    tipo = "cartao_cnpj"
    id_efetivo = req.id_cadastro
    if id_efetivo.endswith(":carreta"):
        tipo = "cartao_cnpj_carreta"
        id_efetivo = id_efetivo[: -len(":carreta")]
    await asyncio.to_thread(_persistir_anexo_basico, tipo, req.imagem, id_efetivo)

    if not local_ocr.is_available():
        raise HTTPException(
            status_code=503,
            detail=(
                "OCR de cartão CNPJ exige EasyOCR no sidecar. "
                "Reinstale a imagem cadastro-ocr habilitando requirements-ocr.txt no Dockerfile. "
                "Alternativa: peça o motorista digitar o CNPJ e use /api/consulta/cnpj."
            ),
        )
    try:
        # 1) Local OCR só extrai os 14 dígitos do CNPJ (não confiamos no resto do
        #    layout — cartão CNPJ tem dezenas de variações).
        local_result = await local_ocr.ocr_cartao_cnpj(req.imagem)
    except Exception as e:
        raise _tratar_erro(e, "local/cartao-cnpj")

    cnpj_digits = "".join(filter(str.isdigit, (local_result.get("cnpj") or "")))
    if len(cnpj_digits) != 14:
        # OCR não conseguiu identificar CNPJ válido — retorna o resultado local
        # como fallback (frontend mostra mensagem amigável). Não chama Infosimples
        # com CNPJ ruim (gastaria crédito sem retorno).
        return local_result

    try:
        # 2) Consulta Receita Federal — dados oficiais da empresa.
        rf = await infosimples.consultar(
            "receita-federal/cnpj", {"cnpj": cnpj_digits}
        )
    except Exception as e:
        # Se RF caiu, ainda devolve o que o OCR local pegou
        log.warning("consulta/cnpj falhou — devolvendo só dados do OCR local: %s", e)
        return local_result

    # 3) Devolve um envelope no formato esperado pelo frontend (compatível com
    #    o que `ocrCartaoCnpj` em cadastroApi.ts já espera ler).
    rf_data = (rf.get("data") or [{}])[0] if isinstance(rf.get("data"), list) else (rf.get("data") or {})
    return {
        "code": 200,
        "code_message": "Cartão CNPJ extraído via OCR local + Receita Federal.",
        "data": [
            {
                "cnpj": cnpj_digits,
                "razao_social": rf_data.get("razao_social") or rf_data.get("nome") or "",
                "nome_fantasia": rf_data.get("nome_fantasia") or "",
                "cep": rf_data.get("endereco_cep") or rf_data.get("cep") or "",
                "uf": rf_data.get("endereco_uf") or rf_data.get("uf") or "",
                "municipio": rf_data.get("endereco_municipio") or rf_data.get("municipio") or "",
                "bairro": rf_data.get("endereco_bairro") or rf_data.get("bairro") or "",
                "logradouro": rf_data.get("endereco_logradouro") or rf_data.get("logradouro") or "",
                "numero": rf_data.get("endereco_numero") or rf_data.get("numero") or "",
                "_source": {
                    "ocr_local": local_result.get("cnpj"),
                    "receita_federal": rf.get("header", {}).get("service"),
                },
            }
        ],
    }


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
