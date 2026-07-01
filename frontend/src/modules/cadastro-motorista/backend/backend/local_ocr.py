"""OCR local (EasyOCR) — comprovante de residencia + cartao CNPJ.

Motivacao: substituir endpoints pagos da Infosimples para documentos de
layout estavel (cartao CNPJ da Receita Federal e contas de concessionarias).
Infosimples continua ativo como fallback — este modulo so e acionado se
OCR_*_PROVIDER=local no .env.

Arquitetura:
  - Lazy import do easyocr (nao quebra a app se lib nao instalada).
  - Singleton do Reader (carrega modelos PT/EN 1x — ~250MB em RAM).
  - Inferencia rodada em `asyncio.to_thread` (CPU-bound, nao bloqueia event loop).
  - Parsers regex retornam no MESMO formato Infosimples:
      {"code": 200, "code_message": "...", "data": [{"campos": {...}}]}
    Assim o frontend nao precisa saber qual provider respondeu.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import re
import unicodedata
from typing import Any


def _sem_acento(s: str) -> str:
    """Remove acentos. OCR as vezes devolve CAO, outras CÃO — normalizamos
    para simplificar os regex (evita [CÇ][AÃ]O everywhere)."""
    return "".join(
        c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn"
    )

log = logging.getLogger("infosimples-demo.local_ocr")

# ─ Singleton do Reader ───────────────────────────────────────────────────────

_reader: Any | None = None
_reader_lock = asyncio.Lock()


def _is_available() -> bool:
    """Checa sem importar — evita custo de import em request que nem vai usar."""
    try:
        import importlib.util
        return importlib.util.find_spec("easyocr") is not None
    except Exception:
        return False


async def _get_reader():
    """Carrega o Reader 1x. Seguranca contra race conditions via lock."""
    global _reader
    if _reader is not None:
        return _reader
    async with _reader_lock:
        if _reader is not None:
            return _reader
        try:
            import easyocr  # lazy import
        except ImportError as e:
            raise RuntimeError(
                "OCR local selecionado mas easyocr nao esta instalado. "
                "Execute: pip install -r requirements-ocr.txt"
            ) from e
        log.info("Carregando EasyOCR Reader (pt, en) — primeira execucao baixa ~100MB de modelos...")
        _reader = await asyncio.to_thread(easyocr.Reader, ["pt", "en"], gpu=False, verbose=False)
        log.info("EasyOCR Reader pronto.")
        return _reader


# ─ Utilitario: extrair texto bruto ────────────────────────────────────────────

def _decodar_base64(b64: str) -> bytes:
    """Aceita data URI ou base64 puro. Levanta ValueError em input invalido."""
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        return base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"Imagem base64 invalida: {e}") from e


def _eh_pdf(b: bytes) -> bool:
    return b[:5] == b"%PDF-"


def _pdf_para_imagens(pdf_bytes: bytes, dpi: int = 150, max_paginas: int = 1) -> list[bytes]:
    """Rasteriza PDF -> lista de PNG bytes. EasyOCR nao le PDF nativo.

    DPI 150: equilibra qualidade vs velocidade (OCR ainda funciona bem).
    max_paginas=1: comprovante/cartao-CNPJ tem o endereco/dados na 1a pagina;
    paginas extras (historicos, info legal) so atrasam o OCR.
    """
    try:
        import pypdfium2 as pdfium
    except ImportError as e:
        raise RuntimeError(
            "PDF detectado mas pypdfium2 nao instalado. "
            "Execute: pip install -r requirements-ocr.txt"
        ) from e

    import io
    pdf = pdfium.PdfDocument(pdf_bytes)
    imgs: list[bytes] = []
    try:
        n = min(len(pdf), max_paginas)
        scale = dpi / 72.0  # pypdfium2 usa 72dpi como base
        for i in range(n):
            page = pdf[i]
            pil_img = page.render(scale=scale).to_pil()
            buf = io.BytesIO()
            pil_img.save(buf, format="PNG")
            imgs.append(buf.getvalue())
            page.close()
        log.debug("PDF rasterizado: %d pagina(s) -> PNG @ %d DPI", n, dpi)
        return imgs
    finally:
        pdf.close()


async def _extrair_texto(imagem_b64: str) -> str:
    """Retorna texto bruto juntado por newline (preserva ordem de leitura).

    Aceita PNG/JPG/PDF via base64. PDFs sao rasterizados pagina a pagina
    antes do OCR.
    """
    img_bytes = _decodar_base64(imagem_b64)
    reader = await _get_reader()

    if _eh_pdf(img_bytes):
        # PDF: rasteriza em thread (CPU-bound) e faz OCR em cada pagina.
        paginas = await asyncio.to_thread(_pdf_para_imagens, img_bytes)
        todas_linhas: list[str] = []
        for i, pag_bytes in enumerate(paginas, 1):
            linhas_pag: list[str] = await asyncio.to_thread(
                reader.readtext, pag_bytes, detail=0, paragraph=False
            )
            if len(paginas) > 1:
                todas_linhas.append(f"--- pagina {i} ---")
            todas_linhas.extend(linhas_pag)
        texto = "\n".join(todas_linhas)
    else:
        # Imagem direta (PNG/JPG/etc).
        linhas: list[str] = await asyncio.to_thread(
            reader.readtext, img_bytes, detail=0, paragraph=False
        )
        texto = "\n".join(linhas)

    log.debug("OCR local extraiu %d caracteres", len(texto))
    return texto


# ─ Helpers regex ──────────────────────────────────────────────────────────────

def _r(pattern: str, texto: str, flags: int = re.IGNORECASE) -> str:
    m = re.search(pattern, texto, flags)
    if not m:
        return ""
    return (m.group(1) if m.groups() else m.group(0)).strip()


def _campo(valor: str, score: float = 0.85) -> dict:
    """Formato Infosimples-compativel: {valor, tipo, score}."""
    return {"valor": valor, "tipo": "texto", "score": score if valor else 0.0}


def _envelope(tipo: str, campos: dict, texto_bruto: str) -> dict:
    """Envelope no formato esperado pelo frontend (data[].campos.*)."""
    preenchidos = sum(1 for v in campos.values() if v.get("valor"))
    return {
        "code": 200,
        "code_message": f"OCR local extraiu {preenchidos}/{len(campos)} campos",
        "header": {"provider": "local-easyocr"},
        "data": [
            {
                "tipo": tipo,
                "campos": campos,
                "texto_bruto": texto_bruto,  # util p/ debugging na UI (toggle JSON)
            }
        ],
        "errors": [],
        "data_count": 1,
    }


# ─ Parser: Cartao CNPJ (Comprovante de Inscricao — Receita Federal) ──────────

def _parse_cartao_cnpj(texto: str) -> dict:
    """
    Layout oficial da Receita Federal (estavel ha anos):
      NUMERO DE INSCRICAO: 12.345.678/0001-90
      DATA DE ABERTURA: 01/01/2000
      NOME EMPRESARIAL: ACME TRANSPORTES LTDA
      TITULO DO ESTABELECIMENTO (NOME DE FANTASIA): ACME
      CODIGO E DESCRICAO DA ATIVIDADE ECONOMICA PRINCIPAL: 49.30-2-02 - ...
      LOGRADOURO: RUA X
      NUMERO: 123
      COMPLEMENTO: SALA 4
      CEP: 01234-567
      BAIRRO/DISTRITO: CENTRO
      MUNICIPIO: SAO PAULO
      UF: SP
      TELEFONE: (11) 9999-9999
      SITUACAO CADASTRAL: ATIVA

    Estrategia: normaliza acentos, parseia linha a linha casando
    "ROTULO: valor" — mais robusto que regex greedy em texto completo.
    """
    # Normaliza: tira acentos + NBSP + colapsa espacos/pipes (OCR as vezes poe '|').
    texto_norm = _sem_acento(texto).replace("\u00a0", " ").replace("|", " ")
    linhas = [re.sub(r"\s+", " ", l).strip() for l in texto_norm.split("\n") if l.strip()]
    full = "\n".join(linhas)

    def campo_de(rotulos_regex: str) -> str:
        """Procura uma linha que CASE o rotulo e retorna o valor apos ':'.
        Aceita tambem linha seguinte se o rotulo estiver sozinho."""
        for i, linha in enumerate(linhas):
            m = re.match(
                rf"^(?:{rotulos_regex})\s*[:\-]\s*(.*)$",
                linha,
                re.IGNORECASE,
            )
            if m:
                valor = m.group(1).strip()
                # Rotulo sozinho (valor veio na linha seguinte).
                if not valor and i + 1 < len(linhas):
                    return linhas[i + 1].strip()
                return valor
        return ""

    # CNPJ — formato com pontuacao OU 14 digitos corridos.
    cnpj = _r(r"\b(\d{2}[.,]\d{3}[.,]\d{3}[/\\]\d{4}-\d{2})\b", full)
    if not cnpj:
        m = re.search(r"\b(\d{14})\b", full)
        if m:
            raw = m.group(1)
            cnpj = f"{raw[:2]}.{raw[2:5]}.{raw[5:8]}/{raw[8:12]}-{raw[12:]}"
    else:
        digs = re.sub(r"\D", "", cnpj)
        if len(digs) == 14:
            cnpj = f"{digs[:2]}.{digs[2:5]}.{digs[5:8]}/{digs[8:12]}-{digs[12:]}"

    # CEP — unico no layout, nao ha risco de colisao.
    cep = _r(r"\b(\d{5}-?\d{3})\b", full)
    if cep and "-" not in cep:
        cep = f"{cep[:5]}-{cep[5:]}"

    razao = campo_de(r"NOME\s+EMPRESARIAL")
    fantasia = campo_de(r"(?:TITULO\s+DO\s+ESTABELECIMENTO\s*\(NOME\s+DE\s+FANTASIA\)?|NOME\s+DE\s+FANTASIA)")
    if fantasia.startswith("*") or fantasia == "********":
        fantasia = ""  # cartao exibe ***** quando nao ha nome fantasia

    # CNAE: aceita 4 formatos comuns: "4930-2/02", "49.30-2-02", "4930-2-02", "49.30-2/02"
    cnae = _r(r"\b(\d{2}\.\d{2}-\d-\d{2})\b", full) \
        or _r(r"\b(\d{4}-\d/\d{2})\b", full) \
        or _r(r"\b(\d{2}\.\d{2}-\d/\d{2})\b", full) \
        or _r(r"\b(\d{4}-\d-\d{2})\b", full)
    # Descricao CNAE: tudo que vem depois do codigo ate fim da linha.
    cnae_desc = ""
    if cnae:
        m = re.search(
            rf"{re.escape(cnae)}\s*[-–]\s*([^\n]+)", full
        )
        if m:
            cnae_desc = m.group(1).strip()
        else:
            # Descricao pode estar na linha seguinte ao codigo.
            for i, linha in enumerate(linhas):
                if cnae in linha and i + 1 < len(linhas):
                    cnae_desc = linhas[i + 1].strip()
                    break

    logradouro  = campo_de(r"LOGRADOURO")
    # NUMERO: exige rotulo sozinho ou com ':' — evita casar "NUMERO DE INSCRICAO".
    numero      = campo_de(r"NUMERO(?!\s+DE\s+INSCRICAO)")
    complemento = campo_de(r"COMPLEMENTO")
    bairro      = campo_de(r"BAIRRO(?:[/\\-]DISTRITO)?")
    municipio   = campo_de(r"MUNICIPIO")
    uf          = campo_de(r"UF")
    telefone    = campo_de(r"TELEFONE") or _r(r"\(\s*\d{2}\s*\)\s*\d{4,5}[-\s]?\d{4}", full)
    situacao    = campo_de(r"SITUACAO\s+CADASTRAL")
    data_abert  = campo_de(r"DATA\s+DE\s+ABERTURA")

    # UF isolado (2 letras maiusculas).
    if uf:
        m = re.search(r"\b([A-Z]{2})\b", uf.upper())
        uf = m.group(1) if m else ""

    # Situacao: mantem so 1a palavra/frase curta (ATIVA, BAIXADA, SUSPENSA, etc).
    if situacao:
        m = re.match(r"([A-Z ]{3,30})", situacao.upper())
        situacao = (m.group(1) if m else situacao).strip()

    campos = {
        "cnpj":               _campo(cnpj),
        "razao_social":       _campo(razao),
        "nome_fantasia":      _campo(fantasia),
        "cnae":               _campo(cnae),
        "cnae_descricao":     _campo(cnae_desc),
        "logradouro":         _campo(logradouro),
        "numero":             _campo(numero),
        "complemento":        _campo(complemento),
        "bairro":             _campo(bairro),
        "municipio":          _campo(municipio),
        "cidade":             _campo(municipio),  # alias p/ frontend
        "uf":                 _campo(uf),
        "estado":             _campo(uf),  # alias p/ frontend
        "cep":                _campo(cep),
        "telefone":           _campo(telefone),
        "situacao_cadastral": _campo(situacao),
        "situacao":           _campo(situacao),  # alias
        "data_abertura":      _campo(data_abert),
    }
    return campos


# ─ Parser: Comprovante de residencia (generico para concessionarias) ─────────

def _parse_comprovante(texto: str) -> dict:
    """
    Parser hibrido (rotulo-first + heuristica) para contas de luz/agua/telefone.
    Cobre Copel/DANFE, CPFL, Enel, Cemig, Light, Energisa, Neoenergia, RGE, etc.

    Estrategia em camadas:
      1) Se a fatura tem rotulos explicitos (Nome:, Endereco:, Cidade:, CEP:),
         usa-os — mais preciso que heuristica.
      2) DANFE/nota fiscal tem bloco da concessionaria (topo) + bloco do cliente.
         Priorizamos campos apos a palavra "UNIDADE CONSUMIDORA" ou o rotulo
         "Nome:", para evitar capturar dados da concessionaria por engano.
      3) Fallback heuristico: linha com tipo de via (RUA/AV/ESTRADA) + CEP + UF.

    Ainda recomendado: enriquecer via Correios /api/consulta/cep apos a extracao
    (normaliza logradouro/bairro/cidade/UF oficialmente).
    """
    t = _sem_acento(texto).replace("\u00a0", " ")
    linhas_t = t.split("\n")

    def _campo_apos_rotulo(rotulo_regex: str, *, permite_prox_linha: bool = True) -> str:
        """Procura `rotulo: valor` (case-insensitive). Se valor vazio, pega proxima linha."""
        rx = re.compile(rf"^\s*(?:{rotulo_regex})\s*[:\-]\s*(.*)$", re.IGNORECASE)
        for i, l in enumerate(linhas_t):
            m = rx.match(l)
            if m:
                v = m.group(1).strip()
                if v:
                    return v
                if permite_prox_linha and i + 1 < len(linhas_t):
                    return linhas_t[i + 1].strip()
        return ""

    # ─ Camada 1: rotulos explicitos ─────────────────────────────────────────
    titular_rotulo  = _campo_apos_rotulo(r"NOME(?:\s+DO\s+CLIENTE|\s+COMPLETO)?")
    endereco_rotulo = _campo_apos_rotulo(r"ENDERECO(?:\s+DE\s+ENTREGA|\s+DO\s+CLIENTE)?|LOGRADOURO")
    cidade_rotulo   = _campo_apos_rotulo(r"CIDADE|MUNICIPIO")
    estado_rotulo   = _campo_apos_rotulo(r"ESTADO|UF")
    bairro_rotulo   = _campo_apos_rotulo(r"BAIRRO|DISTRITO")

    # ─ CEP: escolher o MAIS PROXIMO do bloco do cliente ─────────────────────
    # DANFE tem 2 CEPs (concessionaria + cliente). Ancoramos no rotulo "Cidade:"
    # (ou "Estado:", "UNIDADE CONSUMIDORA") quando presente — o CEP certo e o
    # anterior a essa ancora. Fallback: ultimo CEP na pagina.
    todos_ceps: list[tuple[int, str]] = [
        (m.start(), m.group(1)) for m in re.finditer(r"\b(\d{5}-?\d{3})\b", t)
    ]
    cep = ""
    if todos_ceps:
        ancora = None
        for rot in (r"CIDADE\s*[:\-]", r"ESTADO\s*[:\-]", r"UNIDADE\s+CONSUMIDORA"):
            m = re.search(rot, t, re.IGNORECASE)
            if m:
                ancora = m.start()
                break
        if ancora is not None:
            cep_antes = [c for p, c in todos_ceps if p < ancora]
            # Prefere o mais proximo ANTES da ancora (maior posicao < ancora)
            cep = cep_antes[-1] if cep_antes else todos_ceps[-1][1]
        else:
            cep = todos_ceps[-1][1]
        if "-" not in cep:
            cep = f"{cep[:5]}-{cep[5:]}"

    # ─ UF ───────────────────────────────────────────────────────────────────
    uf = ""
    if estado_rotulo:
        m = re.search(r"\b([A-Z]{2})\b", estado_rotulo.upper())
        if m:
            uf = m.group(1)
    if not uf:
        # Fallback: UF brasileira valida proxima do CEP
        if cep:
            m = re.search(
                rf"{re.escape(cep)}[^A-Z]*?\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b",
                t,
            )
            if m:
                uf = m.group(1)
        if not uf:
            m = re.search(r"\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b", t)
            if m:
                uf = m.group(1)

    # ─ Cidade ───────────────────────────────────────────────────────────────
    cidade = cidade_rotulo
    if cidade:
        # Remove trailing "- PR" ou "/ PR" se coube junto
        cidade = re.sub(r"\s*[-/]\s*[A-Z]{2}\s*$", "", cidade).strip()
    elif uf:
        # Fallback: linha tipo "CIDADE - UF"
        for linha in linhas_t:
            m = re.match(rf"\s*([A-Z][A-Za-z\s]+?)\s*[-/]\s*{uf}\s*$", linha)
            if m:
                cidade = m.group(1).strip()
                break

    # ─ Logradouro + numero ──────────────────────────────────────────────────
    logradouro, numero = "", ""
    if endereco_rotulo:
        # Formatos: "Rua X, 123" | "Rua X; 123" | "Rua X - 123" | "Rua X 123"
        m = re.match(r"^(.+?)[,;\-]\s*(\d{1,6})\b", endereco_rotulo)
        if m:
            logradouro = m.group(1).strip()
            numero = m.group(2)
        else:
            m = re.match(r"^(.+?)\s+(\d{1,6})(?:\s|$)", endereco_rotulo)
            if m:
                logradouro = m.group(1).strip()
                numero = m.group(2)
            else:
                logradouro = endereco_rotulo.strip()

    if not logradouro:
        # Heuristica: exige palavra-chave de tipo de via COM espaco e letra depois
        # (evita falso positivo "AL ELETRONICA" dentro de "FISCAL ELETRONICA")
        logradouro = _r(
            r"\b((?:RUA|R\.|AV(?:ENIDA)?|ALAMEDA|TRAVESSA|ESTRADA|ROD(?:OVIA)?|PRACA|LARGO|VIELA)\s+[A-Z][A-Za-z][^\n]{3,80})",
            t,
        )
        if logradouro:
            m = re.search(r"[,;\s]+(\d{1,6})(?:\s|$|[A-Z])", logradouro)
            if m:
                numero = m.group(1)

    if not numero:
        numero = _r(r"N[°ºO]\s*(\d{1,6})", t) or _r(r"\bNUMERO\s+(\d{1,6})", t)

    # ─ Bairro ───────────────────────────────────────────────────────────────
    bairro = bairro_rotulo
    if not bairro and endereco_rotulo:
        # Heuristica: procura linhas-candidato entre "Endereco:" e "CEP:"
        # e prefere a ULTIMA (bairro geralmente fica imediatamente antes do CEP,
        # enquanto linhas iniciais podem ser resto do nome/codigo de unidade).
        try:
            i_end = next(i for i, l in enumerate(linhas_t) if re.search(r"^ENDERECO\s*[:\-]", l, re.IGNORECASE))
            i_cep = next((i for i, l in enumerate(linhas_t) if i > i_end and re.search(r"^CEP\s*[:\-]", l, re.IGNORECASE)), len(linhas_t))
            candidatos = []
            for l in linhas_t[i_end + 1:i_cep]:
                l = l.strip()
                if not (3 <= len(l) <= 40):
                    continue
                if re.search(r"\d{4,}", l):  # nao pode ter numero de unidade (4+ digitos)
                    continue
                if len(l.split()) > 5:
                    continue
                if re.search(r"UNIDADE|CODIGO|DEBITO|CIDADE|CEP|ESTADO|NOME|FATURA|AUTOMATICO", l, re.IGNORECASE):
                    continue
                # Descarta linhas de 1 palavra curta (< 5 chars) — geralmente
                # ruido de OCR (ex.: "Josefa" sobrenome truncado do nome).
                if len(l.split()) == 1 and len(l) < 5:
                    continue
                candidatos.append(l)
            if candidatos:
                # Ultima candidato = mais proxima do CEP = provavel bairro
                bairro = candidatos[-1]
        except StopIteration:
            pass

    # ─ Titular ──────────────────────────────────────────────────────────────
    titular = titular_rotulo
    if not titular:
        # Fallback heuristica: linha MAIUSCULA plausivel, nao rotulo/concessionaria
        BLACKLIST = {
            # Concessionarias / marcas comuns
            "CPFL", "ENEL", "CEMIG", "LIGHT", "ENERGISA", "NEOENERGIA", "RGE", "ELEKTRO",
            "EQUATORIAL", "ELETROBRAS", "COPEL", "CELESC", "COELBA", "SABESP", "CAGECE",
            "SANEPAR", "CEDAE", "EMBASA",
            # Rotulos / boilerplate fatura
            "RUA", "AV", "AVENIDA", "CEP", "CNPJ", "LOGRADOURO", "BAIRRO", "CIDADE",
            "ESTADO", "UF", "TELEFONE", "VENCIMENTO", "VALOR", "FATURA", "CONTA",
            "NOTA", "ENERGIA", "ELETRICA", "ELETRICO", "DISTRIBUIDORA", "COMPROVANTE",
            "DOCUMENTO", "AUXILIAR", "DANFE", "DANF3E", "FISCAL", "EMISSAO", "TOTAL",
            "UNIDADE", "CONSUMIDORA", "PROTOCOLO", "AUTORIZACAO", "REF", "MES",
            "PAGAR", "DEBITO", "AUTOMATICO", "CODIGO", "SERIE", "LEITURA",
        }
        for linha in linhas_t:
            l = linha.strip()
            if len(l) < 6 or len(l) > 60:
                continue
            if not re.match(r"^[A-Z][A-Z\s\.]{4,}$", l):
                continue
            palavras = l.split()
            if len(palavras) < 2 or len(palavras) > 6:
                continue
            if any(p in BLACKLIST for p in palavras):
                continue
            titular = l
            break

    campos = {
        "cep":          _campo(cep),
        "logradouro":   _campo(logradouro),
        "endereco":     _campo(logradouro),  # alias
        "numero":       _campo(numero),
        "bairro":       _campo(bairro),
        "cidade":       _campo(cidade),
        "municipio":    _campo(cidade),  # alias
        "uf":           _campo(uf),
        "estado":       _campo(uf),  # alias
        "titular":      _campo(titular),
        "nome":         _campo(titular),  # alias
    }
    return campos


# ─ API publica (chamada pelo main.py) ────────────────────────────────────────

def is_available() -> bool:
    """True se easyocr esta instalado. Usado pelo main.py para validar config."""
    return _is_available()


async def ocr_cartao_cnpj(imagem_b64: str) -> dict:
    texto = await _extrair_texto(imagem_b64)
    if not texto.strip():
        return {
            "code": 422,
            "code_message": "Nao foi possivel extrair texto da imagem",
            "data": [],
            "errors": ["OCR retornou texto vazio — verifique qualidade da imagem."],
            "data_count": 0,
        }
    return _envelope("cartao_cnpj", _parse_cartao_cnpj(texto), texto)


async def ocr_comprovante(imagem_b64: str) -> dict:
    texto = await _extrair_texto(imagem_b64)
    if not texto.strip():
        return {
            "code": 422,
            "code_message": "Nao foi possivel extrair texto da imagem",
            "data": [],
            "errors": ["OCR retornou texto vazio — verifique qualidade da imagem."],
            "data_count": 0,
        }
    return _envelope("comprovante_residencia", _parse_comprovante(texto), texto)


async def warmup() -> None:
    """Opcional: aquece o Reader no lifespan para 1a request ser rapida."""
    if not _is_available():
        log.info("easyocr nao instalado — warmup pulado")
        return
    try:
        await _get_reader()
    except Exception as e:
        log.warning("Falha no warmup do EasyOCR: %s", e)
