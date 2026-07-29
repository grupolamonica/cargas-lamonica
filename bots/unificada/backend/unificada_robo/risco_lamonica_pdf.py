"""
risco_lamonica_pdf.py
---------------------
Gera o "Gerenciador de Risco" (Perfil Securitário) a partir do NOSSO cadastro
(`dados` do wizard/Supabase) — SEM consultar a API AngelLira em runtime.

Substitui, no fluxo SPX-first, o gerador antigo `relatorio_api_pdf.gerar_pdf_unificado`
(que dependia da API AngelLira), permitindo emitir o documento ANTES do cadastro
externo. Mesma ESTRUTURA dos documentos de gerenciamento de risco (Detalhes da
Consulta / Consulta / Dados do Motorista / CNH / Cavalo / Reboque / Transportador).

MARCA: TODA a identidade (nome, logo, cores, copyright) é configurável por env.
O default é HONESTO — Grupo Lamônica (emissor real do documento). O código NÃO
embute a identidade de uma gerenciadora terceira (logo/nome/copyright de outra
empresa) por padrão. Se o operador tiver autorização de uma gerenciadora para
emitir na marca dela, ele define as env vars no ambiente dele — é decisão e
responsabilidade operacional, não algo embutido no código.

Módulo AUTOCONTIDO (não importa `relatorio_api`): a geração do PDF não depende
da API AngelLira.

Env de marca (opcionais; sem elas, default Lamônica):
  RISCO_MARCA_COR / RISCO_MARCA_AZUL / RISCO_MARCA_NOME / RISCO_MARCA_TITULO
  RISCO_MARCA_COPYRIGHT / RISCO_MARCA_RODAPE / RISCO_LOGO_PATH (SVG)
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)

try:
    from reportlab.graphics.shapes import Drawing
    from reportlab.graphics import renderPDF
    from svglib.svglib import svg2rlg
except Exception:  # pragma: no cover
    svg2rlg = None

# ── Marca (TODA configurável por env) ───────────────────────────────────────
# Default HONESTO = Grupo Lamônica (emissor real do documento). A identidade de
# uma gerenciadora terceira (ex.: AngelLira: nome/logo/copyright) NÃO é embutida
# como padrão — só é aplicada se o operador definir estas env vars no ambiente
# dele, sob responsabilidade/autorização dele (ver docstring). Assim o código
# não "impersona" ninguém por padrão.
MARCA_COR = os.getenv("RISCO_MARCA_COR") or "#0B4DA2"  # acento
MARCA_AZUL = os.getenv("RISCO_MARCA_AZUL") or "#0B4DA2"  # rodapé
MARCA_NOME = os.getenv("RISCO_MARCA_NOME") or "GRUPO LAMÔNICA — TRANSPORTES E LOGÍSTICA"
MARCA_TITULO = os.getenv("RISCO_MARCA_TITULO") or "Grupo Lamônica"
MARCA_COPYRIGHT = (
    os.getenv("RISCO_MARCA_COPYRIGHT")
    or "Documento gerado pelo Sistema de Cadastro do Grupo Lamônica — uso interno para gestão de risco."
)
MARCA_RODAPE = os.getenv("RISCO_MARCA_RODAPE") or "Gerenciamento de Risco"
# Tipo de vínculo do motorista — não coletamos no cadastro; default "Agregado"
# (decisão de produto). Sobreponível por dados.motorista.tipo.
MOTORISTA_TIPO_DEFAULT = os.getenv("RISCO_MOTORISTA_TIPO") or "Motorista Agregado"
# Logo: sem default embutido — só exibe logo se RISCO_LOGO_PATH apontar um SVG.
_LOGO_PATH = os.getenv("RISCO_LOGO_PATH")
_LOGO_DRAWING = None
if _LOGO_PATH and svg2rlg and Path(_LOGO_PATH).exists():
    try:
        _LOGO_DRAWING = svg2rlg(_LOGO_PATH)
    except Exception:
        _LOGO_DRAWING = None

# Verde "Conforme" e vermelho "Não Conforme" (iguais ao portal AngelLira).
_GREEN = "#16a34a"
_RED = "#dc2626"


# ── Estilos ─────────────────────────────────────────────────────────────────
def _styles():
    base = getSampleStyleSheet()
    return {
        "mainHdr": ParagraphStyle("MainHdr", parent=base["Heading2"], fontSize=14,
                                  textColor=colors.black, spaceBefore=10, spaceAfter=4,
                                  fontName="Helvetica-Bold"),
        "subHdr": ParagraphStyle("SubHdr", parent=base["Normal"], fontSize=11,
                                 textColor=colors.HexColor(MARCA_COR), spaceBefore=8,
                                 spaceAfter=4, fontName="Helvetica-Bold"),
        "label": ParagraphStyle("Label", parent=base["Normal"], fontSize=8,
                                textColor=colors.HexColor("#64748b")),
        "value": ParagraphStyle("Value", parent=base["Normal"], fontSize=10, textColor=colors.black),
        "ok": ParagraphStyle("Ok", parent=base["Normal"], fontSize=10,
                             textColor=colors.HexColor(_GREEN), fontName="Helvetica-Bold"),
        "warn": ParagraphStyle("Warn", parent=base["Normal"], fontSize=10,
                              textColor=colors.HexColor(_RED), fontName="Helvetica-Bold"),
    }


# ── Formatação ────────────────────────────────────────────────────────────
def _safe(value, default="—") -> str:
    if value is None:
        return default
    s = str(value).strip()
    return s if s else default


def _fmt_cpf_cnpj(value) -> str:
    s = "".join(c for c in str(value or "") if c.isdigit())
    if len(s) == 11:
        return f"{s[:3]}.{s[3:6]}.{s[6:9]}-{s[9:]}"
    if len(s) == 14:
        return f"{s[:2]}.{s[2:5]}.{s[5:8]}/{s[8:12]}-{s[12:]}"
    return s or "—"


def _fmt_date(value) -> str:
    """Aceita 'YYYY-MM-DD', 'DD/MM/YYYY' ou ISO — devolve DD/MM/YYYY."""
    if not value:
        return "—"
    s = str(value).strip()
    if "/" in s:  # já DD/MM/YYYY
        return s[:10]
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00").split("T")[0])
        return d.strftime("%d/%m/%Y")
    except (ValueError, TypeError):
        return s


def _fmt_datetime(dt: datetime) -> str:
    return dt.strftime("%d/%m/%Y, %H:%M:%S")


def _grid_row(fields: list, total_cols: int = 4) -> Table:
    """Linha horizontal: label (cinza) em cima, valor embaixo. Cada campo é
    (label, valor) ou (label, valor, style_key) — style_key p/ ex. 'ok' (verde)."""
    styles = _styles()
    fields = list(fields)
    while len(fields) < total_cols:
        fields.append(("", ""))

    page_width = A4[0] - 4 * cm
    col_w = page_width / total_cols

    cells = []
    for f in fields:
        label = f[0]
        value = f[1] if len(f) > 1 else ""
        style_key = f[2] if len(f) > 2 else "value"
        if not label:
            cells.append("")
            continue
        cell = Table(
            [[Paragraph(label, styles["label"])],
             [Paragraph(_safe(value), styles[style_key])]],
            colWidths=[col_w - 4],
        )
        cell.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 2),
            ("BOTTOMPADDING", (0, 1), (-1, 1), 0),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ]))
        cells.append(cell)

    outer = Table([cells], colWidths=[col_w] * total_cols, hAlign="LEFT")
    outer.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
    ]))
    return outer


def _grid_block(fields: list, cols_per_row: int = 4) -> list:
    elems = []
    for i in range(0, len(fields), cols_per_row):
        elems.append(_grid_row(fields[i:i + cols_per_row], total_cols=cols_per_row))
        elems.append(Spacer(1, 1))
    return elems


def _simple_text_block(label: str, value: str) -> list:
    styles = _styles()
    return [Paragraph(label, styles["subHdr"]), Paragraph(_safe(value), styles["value"]), Spacer(1, 6)]


# ── Consulta (metadados do documento — sintetizados por nós) ────────────────
def _consulta_fields(consulta: dict) -> list:
    situ = consulta.get("situacao") or "Conforme"
    style = "ok" if "conforme" in situ.lower() and "não" not in situ.lower() and "nao" not in situ.lower() else "warn"
    return [
        ("Código", _safe(consulta.get("codigo"))),
        ("Tipo", _safe(consulta.get("tipo"))),
        ("Data Envio", consulta.get("data_envio", "—")),
        ("Data de Recebimento", consulta.get("data_recebimento", "—")),
        ("Data Vencimento", consulta.get("data_vencimento", "—")),
        ("Dias Vencimento", str(consulta.get("dias_vencimento", "—"))),
        ("Situação", situ, style),
        ("Usuário", _safe(consulta.get("usuario"))),
    ]


def _transportador_fields(transp: dict) -> list:
    transp = transp or {}
    return [
        ("Nome", _safe(transp.get("nome"))),
        ("CNPJ", _fmt_cpf_cnpj(transp.get("cnpj")) if transp.get("cnpj") else "—"),
        ("Cidade / UF", _safe(f"{_safe(transp.get('cidade'), '')} / {_safe(transp.get('uf'), '')}".strip(" /"))),
        ("Telefone", _safe(transp.get("telefone"))),
        ("Vínculo", _safe(transp.get("vinculo"))),
    ]


def _consulta_header(consulta: dict, transp: dict) -> list:
    styles = _styles()
    elems = [
        Paragraph("Detalhes da Consulta", styles["mainHdr"]),
        Paragraph("Consulta", styles["subHdr"]),
    ]
    elems.extend(_grid_block(_consulta_fields(consulta), cols_per_row=4))
    elems.extend(_simple_text_block("Comentário", consulta.get("comentario") or "Conforme"))
    elems.extend(_simple_text_block("Comentário Certificado", consulta.get("comentario_certificado") or "-"))
    return elems


def _motorista_section(mot: dict, consulta: dict, transp: dict) -> list:
    styles = _styles()
    cnh = mot.get("cnh") or {}
    telefones = mot.get("telefones") or ([mot["telefone_primario"]] if mot.get("telefone_primario") else [])
    elems = _consulta_header(consulta, transp)
    elems.append(Paragraph("Dados do Motorista", styles["subHdr"]))
    elems.append(_grid_row([
        ("Nome", _safe(mot.get("nome"))),
        ("Tipo", _safe(mot.get("tipo") or MOTORISTA_TIPO_DEFAULT)),
        ("CPF", _fmt_cpf_cnpj(mot.get("cpf"))),
        ("Data Nascimento", _fmt_date(mot.get("data_nascimento"))),
    ], total_cols=4))
    elems.append(Spacer(1, 2))
    elems.append(_grid_row([
        ("RG", _safe(mot.get("rg"))),
        ("UF", _safe(mot.get("rg_uf"))),
        ("Nome do Pai", _safe(mot.get("nome_pai"))),
        ("Nome da Mãe", _safe(mot.get("nome_mae"))),
        ("Telefones", _safe(", ".join(telefones) if telefones else None)),
    ], total_cols=5))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph("Carteira de Habilitação", styles["subHdr"]))
    elems.append(_grid_row([
        ("Número CNH", _safe(cnh.get("registro"))),
        ("Categoria CNH", _safe(cnh.get("categoria"))),
        ("Cód. Segurança CNH", _safe(cnh.get("codigo_seguranca"))),
        ("Validade CNH", _fmt_date(cnh.get("validade"))),
    ], total_cols=4))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph("Transportador", styles["subHdr"]))
    elems.append(_grid_row(_transportador_fields(transp), total_cols=5))
    return elems


def _veiculo_section(veh: dict, titulo: str, consulta: dict, transp: dict) -> list:
    styles = _styles()
    ano_fab = veh.get("ano_fabricacao")
    ano_mod = veh.get("ano")
    elems = [PageBreak()]
    elems.extend(_consulta_header(consulta, transp))
    elems.append(Paragraph(titulo, styles["subHdr"]))
    elems.append(_grid_row([
        ("Placa", _safe(veh.get("placa"))),
        ("Marca", _safe(veh.get("marca"))),
        ("Modelo", _safe(veh.get("modelo"))),
        ("Ano Fabricação/Modelo", _safe(f"{_safe(ano_fab, '')}/{_safe(ano_mod, '')}".strip("/"))),
    ], total_cols=4))
    elems.append(Spacer(1, 2))
    elems.append(_grid_row([
        ("Placa (Registro)", _safe(veh.get("uf_emplacamento"))),
        ("Renavam", _safe(veh.get("renavam"))),
        ("Chassi", _safe(veh.get("chassi"))),
        ("ANTT", _safe(veh.get("antt"))),
        ("Último Licenciamento", _fmt_date(veh.get("ultimo_licenciamento"))),
    ], total_cols=5))
    elems.append(Spacer(1, 2))
    owner = veh.get("owner_doc")
    owner_is_cnpj = veh.get("owner_doc_type") == "cnpj"
    elems.append(_grid_row([
        ("Cor", _safe(veh.get("cor"))),
        ("Proprietário CNPJ", _fmt_cpf_cnpj(owner) if (owner and owner_is_cnpj) else "—"),
        ("Proprietário CPF", _fmt_cpf_cnpj(owner) if (owner and not owner_is_cnpj) else "—"),
        ("Frota", _safe(veh.get("frota"))),
    ], total_cols=4))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph("Transportador", styles["subHdr"]))
    elems.append(_grid_row(_transportador_fields(transp), total_cols=5))
    return elems


# ── Header / Footer (marca AngelLira — uso autorizado, ver docstring) ────────
def _header_footer(canvas, doc):
    canvas.saveState()
    header_y = A4[1] - 1.8 * cm
    if _LOGO_DRAWING is not None:
        target_h = 1.2 * cm
        scale = target_h / _LOGO_DRAWING.height
        d = Drawing(_LOGO_DRAWING.width * scale, _LOGO_DRAWING.height * scale)
        d.scale(scale, scale)
        for child in _LOGO_DRAWING.contents:
            d.add(child)
        renderPDF.draw(d, canvas, 2 * cm, header_y - 0.1 * cm)
        text_x = 2 * cm + d.width + 0.4 * cm
    else:
        canvas.setFillColor(colors.HexColor(MARCA_AZUL))
        canvas.setFont("Helvetica-Bold", 14)
        canvas.drawString(2 * cm, header_y, MARCA_TITULO)
        text_x = 4.5 * cm
    canvas.setFillColor(colors.black)
    canvas.setFont("Helvetica-Bold", 9)
    canvas.drawString(text_x, header_y + 0.2 * cm, MARCA_NOME)
    canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, header_y - 0.4 * cm, A4[0] - 2 * cm, header_y - 0.4 * cm)
    # Footer (copyright + versão — igual portal AngelLira)
    canvas.setFillColor(colors.HexColor("#6b7280"))
    canvas.setFont("Helvetica", 7)
    canvas.drawString(2 * cm, 1 * cm, MARCA_COPYRIGHT)
    canvas.setFillColor(colors.HexColor(MARCA_AZUL))
    canvas.drawString(2 * cm, 0.65 * cm, MARCA_RODAPE)
    canvas.setFillColor(colors.HexColor("#6b7280"))
    canvas.drawRightString(A4[0] - 2 * cm, 0.65 * cm, f"Página {doc.page}")
    canvas.restoreState()


# ── Função pública ──────────────────────────────────────────────────────────
def gerar_risco_lamonica(
    dados: dict,
    output_path,
    *,
    protocolo: str | None = None,
    usuario: str = "Sistema Lamônica",
    validade_dias: int = 180,
    now: datetime | None = None,
) -> dict:
    """Gera o Gerenciador de Risco (PDF) a partir do `dados` do nosso cadastro.

    `dados` = { motorista, cavalo, carretas[], transportador?, protocolo? } —
    mesmo shape de `pending_driver_registrations.dados`.

    Uma "Consulta" (metadados + Situação "Conforme") é sintetizada por
    componente. NÃO representa análise de risco independente — é o carimbo do
    documento (decisão de produto).
    """
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    mot = dados.get("motorista") or {}
    cavalo = dados.get("cavalo") or {}
    carretas = dados.get("carretas") or []
    # Transportador = transportadora vinculada ao motorista (NÃO a marca do laudo).
    # Nos documentos AngelLira reais costuma vir vazio ("—"); só preenche se o
    # cadastro trouxer `dados.transportador`.
    transp = dados.get("transportador") or {}
    prot = protocolo or dados.get("protocolo") or "—"

    _now = now or datetime.now()
    venc = _now + timedelta(days=validade_dias)

    def _consulta(tipo: str) -> dict:
        return {
            "codigo": prot, "tipo": tipo,
            "data_envio": _fmt_datetime(_now), "data_recebimento": _fmt_datetime(_now),
            "data_vencimento": _fmt_datetime(venc),
            "dias_vencimento": max(0, (venc.date() - _now.date()).days),
            "situacao": "Conforme", "usuario": usuario, "comentario": "Conforme",
        }

    components = {}
    story = [Spacer(1, 0.2 * cm)]

    if mot:
        story.extend(_motorista_section(mot, _consulta("Motorista"), transp))
        components["motorista"] = {"found": True, "status": "Conforme"}
    if cavalo:
        story.extend(_veiculo_section(cavalo, "Cavalo", _consulta("Cavalo"), transp))
        components["cavalo"] = {"found": True, "status": "Conforme"}
    for idx, car in enumerate(carretas, start=1):
        story.extend(_veiculo_section(car, f"{idx}º Reboque", _consulta("Carreta"), transp))
        components[f"carreta_{idx}"] = {"found": True, "status": "Conforme"}

    if len(story) <= 1:
        return {"ok": False, "output_path": "", "components": {}, "warnings": ["dados vazios — PDF não gerado"]}

    doc = SimpleDocTemplate(
        str(output), pagesize=A4, topMargin=2.0 * cm, bottomMargin=1.6 * cm,
        leftMargin=2 * cm, rightMargin=2 * cm,
        title="Gerenciador de Risco — Grupo Lamônica", author="Sistema Lamonica",
    )
    doc.build(story, onFirstPage=_header_footer, onLaterPages=_header_footer)
    return {"ok": True, "output_path": str(output), "components": components, "warnings": []}
