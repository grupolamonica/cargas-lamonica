"""
pdf_render.py
-------------
Renderiza um PDF de "Risk Assessment Document" no MESMO layout do portal
AngelLira (logo, cabecalho/rodape, secoes de motorista/cavalo/carreta),
a partir de registros ja prontos — SEM consultar a API AngelLira.

Este e o clone de estudo/teste do AngelLira Unificador: a camada de
renderizacao (estilos, formatadores, secoes) e identica a do sistema real;
a unica diferenca e que os dados chegam prontos (via JSON) em vez de virem
de uma consulta autenticada.

Layout: ReportLab platypus.
"""

from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
)

from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

from shared.logger import log_info, log_alerta

# Logo AngelLira (SVG identico ao portal). shared/ -> raiz -> static/img/...
_BASE_DIR = Path(__file__).parent.parent
LOGO_PATH = _BASE_DIR / 'static' / 'img' / 'angellira-logo.svg'

try:
    from svglib.svglib import svg2rlg
    _LOGO_DRAWING = svg2rlg(str(LOGO_PATH)) if LOGO_PATH.exists() else None
except Exception:
    _LOGO_DRAWING = None


# ── Estilos ───────────────────────────────────────────────────────────

def _styles():
    """Estilos fieis ao portal AngelLira:
    - "Detalhes da Consulta" -> preto bold 14pt
    - "Consulta", "Dados do Motorista", etc -> azul ciano (#01b6ed) bold
    - Labels -> cinza 8pt
    - Valores -> preto 10pt
    """
    base = getSampleStyleSheet()
    styles = {
        'mainHdr':   ParagraphStyle('MainHdr', parent=base['Heading2'], fontSize=14, textColor=colors.black,
                                    spaceBefore=10, spaceAfter=4, fontName='Helvetica-Bold'),
        'subHdr':    ParagraphStyle('SubHdr', parent=base['Normal'], fontSize=11, textColor=colors.HexColor('#01b6ed'),
                                    spaceBefore=8, spaceAfter=4, fontName='Helvetica-Bold'),
        'label':     ParagraphStyle('Label', parent=base['Normal'], fontSize=8, textColor=colors.HexColor('#64748b')),
        'value':     ParagraphStyle('Value', parent=base['Normal'], fontSize=10, textColor=colors.black),
        'comment':   ParagraphStyle('Comment', parent=base['Normal'], fontSize=10, textColor=colors.black,
                                    spaceAfter=4),
        'badgeOk':   ParagraphStyle('BadgeOk', parent=base['Normal'], fontSize=9, textColor=colors.HexColor('#16a34a'),
                                    spaceAfter=2, fontName='Helvetica-Bold'),
        'badgeWarn': ParagraphStyle('BadgeWarn', parent=base['Normal'], fontSize=9, textColor=colors.HexColor('#dc2626'),
                                    spaceAfter=2, fontName='Helvetica-Bold'),
    }
    return styles


def _fmt_date(value) -> str:
    """Data sem hora. Aceita ISO 'YYYY-MM-DDTHH:MM:SS.000Z'."""
    if not value:
        return '—'
    s = str(value)
    if 'T' in s and len(s) >= 10:
        try:
            d = datetime.fromisoformat(s.replace('Z', '+00:00'))
            return d.strftime('%d/%m/%Y')
        except Exception:
            return s[:10]
    return s


def _fmt_datetime(value) -> str:
    """Data+hora 'DD/MM/YYYY, HH:MM:SS' — mantem UTC sem conversao (igual portal)."""
    if not value:
        return '—'
    s = str(value)
    if 'T' in s and len(s) >= 10:
        try:
            d = datetime.fromisoformat(s.replace('Z', '+00:00')).replace(tzinfo=None)
            return d.strftime('%d/%m/%Y, %H:%M:%S')
        except Exception:
            return s[:10]
    return s


# Mapeamento de tipos AngelLira (codigo -> descricao expandida)
_DRIVER_KIND_MAP = {
    'AGR': 'Motorista Agregado',
    'FNC': 'Motorista Funcionário',
    'AUT': 'Motorista Autônomo',
    'TER': 'Motorista Terceiro',
}


def _expand_driver_kind(code) -> str:
    if not code:
        return '—'
    c = str(code).strip().upper()
    return _DRIVER_KIND_MAP.get(c, c)


def _fmt_cpf(value) -> str:
    s = ''.join(c for c in str(value or '') if c.isdigit())
    if len(s) == 11:
        return f'{s[:3]}.{s[3:6]}.{s[6:9]}-{s[9:]}'
    return s or '—'


def _safe(value, default='—') -> str:
    if value is None:
        return default
    s = str(value).strip()
    return s if s else default


def _grid_row(fields: list[tuple[str, str]], total_cols: int = 4) -> Table:
    """Layout horizontal igual portal AngelLira: label em cima (cinza), valor
    embaixo (preto). Recebe lista de (label, valor) e distribui em N colunas."""
    styles = _styles()
    fields = list(fields)
    while len(fields) < total_cols:
        fields.append(('', ''))

    page_width = A4[0] - 4 * cm  # descontando margens
    col_w = page_width / total_cols

    cells = []
    for label, value in fields:
        if not label:
            cells.append('')
            continue
        cell = Table(
            [[Paragraph(label, styles['label'])], [Paragraph(_safe(value), styles['value'])]],
            colWidths=[col_w - 4],
        )
        cell.setStyle(TableStyle([
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('TOPPADDING', (0, 0), (-1, -1), 0),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 2),
            ('BOTTOMPADDING', (0, 1), (-1, 1), 0),
            ('LEFTPADDING', (0, 0), (-1, -1), 0),
            ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ]))
        cells.append(cell)

    outer = Table([cells], colWidths=[col_w] * total_cols, hAlign='LEFT')
    outer.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
    ]))
    return outer


def _grid_block(fields: list[tuple[str, str]], cols_per_row: int = 4) -> list:
    """Quebra `fields` em multiplas linhas com `cols_per_row` colunas cada."""
    rows_elems = []
    for i in range(0, len(fields), cols_per_row):
        chunk = fields[i:i + cols_per_row]
        rows_elems.append(_grid_row(chunk, total_cols=cols_per_row))
        rows_elems.append(Spacer(1, 1))
    return rows_elems


def _simple_text_block(label: str, value: str) -> list:
    """Bloco simples 'label em cima, texto embaixo' (pra Comentario etc.)."""
    styles = _styles()
    return [
        Paragraph(label, styles['subHdr']),
        Paragraph(_safe(value), styles['value']),
        Spacer(1, 6),
    ]


def _calc_days_until(iso_str) -> str:
    """Calcula dias ate a data ISO. API pode retornar daysUntilDue=null."""
    if not iso_str:
        return '—'
    try:
        s = str(iso_str).replace('Z', '+00:00')
        d = datetime.fromisoformat(s)
        delta = (d.date() - datetime.now().date()).days
        return str(delta)
    except Exception:
        return '—'


def _consulta_rows(rec: dict) -> list[tuple[str, str]]:
    """Linhas da subsecao 'Consulta' — datas com hora (igual portal AngelLira)."""
    user = rec.get('user') or {}
    user_name = user.get('login') or user.get('name')
    tipo = (rec.get('type') or {}).get('description')
    dias = rec.get('daysUntilDue')
    if dias is None:
        dias = _calc_days_until(rec.get('limitDate'))
    else:
        dias = str(dias)
    return [
        ('Código', str(rec.get('id') or '—')),
        ('Tipo', _safe(tipo)),
        ('Data Envio', _fmt_datetime(rec.get('sentDate'))),
        ('Data de Recebimento', _fmt_datetime(rec.get('receivingDate'))),
        ('Data Vencimento', _fmt_datetime(rec.get('limitDate'))),
        ('Dias Vencimento', dias),
        ('Situação', _safe((rec.get('status') or {}).get('description'))),
        ('Usuário', _safe(user_name)),
    ]


def _transportador_rows(rec: dict) -> list[tuple[str, str]]:
    """Transportador vem em rec.legalPersonRelationship ou rec.company."""
    lp = rec.get('legalPersonRelationship') or {}
    comp = rec.get('company') or {}
    hist = rec.get('history') or {}
    return [
        ('Nome', _safe(comp.get('name') or hist.get('companyName'))),
        ('CNPJ', _safe(comp.get('cnpj') or hist.get('companyCNPJ'))),
        ('Cidade / UF', f"{_safe(comp.get('city') or hist.get('companyCity'),'')} / {_safe(comp.get('state') or hist.get('companyState'),'')}".strip(' /')),
        ('Telefone', _safe(comp.get('phone') or hist.get('companyPhone'))),
        ('Vínculo', _safe(lp.get('description') if isinstance(lp, dict) else lp)),
    ]


def _build_motorista_section(rec: dict) -> list:
    """Layout HORIZONTAL identico ao portal AngelLira:
    label em cima (cinza pequeno), valor embaixo (preto), 4-5 colunas por linha."""
    styles = _styles()
    hist = rec.get('history') or {}
    driver = rec.get('driver') or {}

    consulta_fields = _consulta_rows(rec)  # 8 campos -> 2 linhas de 4

    dados_top = [
        ('Nome', _safe(hist.get('driverName') or driver.get('name'))),
        ('Tipo', _expand_driver_kind(hist.get('driverKind'))),
        ('CPF', _fmt_cpf(hist.get('driverCPF') or (driver.get('natural') or {}).get('cpf'))),
        ('Data Nascimento', _fmt_date(hist.get('driverBirth'))),
    ]
    dados_bot = [
        ('RG', _safe(hist.get('driverRg'))),
        ('UF', _safe(hist.get('driverRgState'))),
        ('Nome do Pai', _safe(hist.get('driverFather'))),
        ('Nome da Mãe', _safe(hist.get('driverMother'))),
        ('Telefones', _safe(hist.get('driverPhone'))),
    ]
    cnh_fields = [
        ('Número CNH', _safe(hist.get('driverCNH'))),
        ('Categoria CNH', _safe(hist.get('driverCNHCategory'))),
        ('Cód. Segurança CNH', _safe(hist.get('driverCNHSecurity'))),
        ('Validade CNH', _fmt_date(hist.get('driverCNHValidity'))),
    ]

    elems = [
        Paragraph('Detalhes da Consulta', styles['mainHdr']),
        Paragraph('Consulta', styles['subHdr']),
    ]
    elems.extend(_grid_block(consulta_fields, cols_per_row=4))
    elems.extend(_simple_text_block('Comentário', rec.get('description')))
    elems.extend(_simple_text_block('Comentário Certificado', rec.get('observationCertificate')))
    elems.append(Paragraph('Dados do Motorista', styles['subHdr']))
    elems.append(_grid_row(dados_top, total_cols=4))
    elems.append(Spacer(1, 2))
    elems.append(_grid_row(dados_bot, total_cols=5))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph('Carteira de Habilitação', styles['subHdr']))
    elems.append(_grid_row(cnh_fields, total_cols=4))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph('Transportador', styles['subHdr']))
    elems.append(_grid_row(_transportador_rows(rec)[:5], total_cols=5))
    return elems


def _build_veiculo_section(rec: dict, label: str, *, is_carreta: bool = False) -> list:
    """Mesmo layout horizontal pra Cavalo/Reboque (4+5+4 cols)."""
    styles = _styles()
    hist = rec.get('history') or {}

    has_cab = bool(hist.get('cabPlate'))
    prefix = 'cab' if has_cab else ('tow' if hist.get('towPlate') else 'cab')
    p = lambda key: hist.get(f'{prefix}{key}')

    consulta_fields = _consulta_rows(rec)
    veh_top = [
        ('Placa', _safe(p('Plate'))),
        ('Marca', _safe(p('Brand'))),
        ('Modelo', _safe(p('Model'))),
        ('Ano Fabricação/Modelo', f"{_safe(p('FabricationYear'),'')}/{_safe(p('ModelYear'),'')}".strip('/')),
    ]
    veh_bot = [
        ('Placa (Registro)', _safe(p('UF'))),
        ('Renavam', _safe(p('Renavam'))),
        ('Chassi', _safe(p('Chassis'))),
        ('ANTT', _safe(p('Antt'))),
        ('Último Licenciamento', _fmt_datetime(p('LastLicensing'))),
    ]
    veh_extra = [
        ('Cor', _safe(p('Color'))),
        ('Proprietário CNPJ', _safe(p('OwnerCNPJ'))),
        ('Proprietário CPF', _fmt_cpf(p('OwnerCPF')) if p('OwnerCPF') else '—'),
        ('Frota', _safe(p('Fleet'))),
    ]

    sub_title = 'Reboque' if is_carreta else 'Cavalo'
    elems = [
        PageBreak(),
        Paragraph('Detalhes da Consulta', styles['mainHdr']),
        Paragraph('Consulta', styles['subHdr']),
    ]
    elems.extend(_grid_block(consulta_fields, cols_per_row=4))
    elems.extend(_simple_text_block('Comentário', rec.get('description')))
    elems.extend(_simple_text_block('Comentário Certificado', rec.get('observationCertificate')))
    elems.append(Paragraph(sub_title, styles['subHdr']))
    elems.append(_grid_row(veh_top, total_cols=4))
    elems.append(Spacer(1, 2))
    elems.append(_grid_row(veh_bot, total_cols=5))
    elems.append(Spacer(1, 2))
    elems.append(_grid_row(veh_extra, total_cols=4))
    elems.append(Spacer(1, 6))
    elems.append(Paragraph('Transportador', styles['subHdr']))
    elems.append(_grid_row(_transportador_rows(rec)[:5], total_cols=5))
    return elems


def _header_footer(canvas, doc):
    """Header com logo AngelLira + razao social. Footer com copyright + versao.
    Imitando o portal: profile.angellira.com.br
    """
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
        canvas.setFillColor(colors.HexColor('#04528c'))
        canvas.setFont('Helvetica-Bold', 14)
        canvas.drawString(2 * cm, header_y, 'AngelLira')
        text_x = 4.5 * cm

    canvas.setFillColor(colors.black)
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawString(text_x, header_y + 0.2 * cm, 'ANGELLIRA TECNOLOGIA, SEGURANÇA E LOGÍSTICA LTDA')

    canvas.setStrokeColor(colors.HexColor('#cbd5e1'))
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, header_y - 0.4 * cm, A4[0] - 2 * cm, header_y - 0.4 * cm)

    canvas.setFillColor(colors.HexColor('#6b7280'))
    canvas.setFont('Helvetica', 7)
    canvas.drawString(2 * cm, 1 * cm,
                      'Copyright © 2026 ANGELLIRA TECNOLOGIA, SEGURANÇA E LOGÍSTICA LTDA. Todos os direitos reservados |')
    canvas.setFillColor(colors.HexColor('#04528c'))
    canvas.drawString(2 * cm, 0.65 * cm, 'Política de Privacidade   ·   Política de Cookies   ·   Perfil Securitário | Versão 1.13.0')
    canvas.setFillColor(colors.HexColor('#6b7280'))
    canvas.drawRightString(A4[0] - 2 * cm, 0.65 * cm, f'Página {doc.page}')

    canvas.restoreState()


# ── Funcao publica ─────────────────────────────────────────────────────

def _status_desc(rec: dict) -> str:
    return ((rec.get('status') or {}).get('description') or '').strip()


def _build_story(records: dict, *, enforce_conforme: bool = False) -> dict:
    """Monta a story do ReportLab + o mapa de componentes/avisos (sem renderizar).

    Retorna dict: { ok, story, components, warnings }.
    """
    warnings: list[str] = []
    components: dict[str, dict] = {}
    elements_per_component: list[list] = []

    # Ordem fixa: motorista -> cavalo -> carreta (igual portal/unificador).
    plano = []
    mot = records.get('motorista')
    cav = records.get('cavalo')
    car = records.get('carreta')
    if mot:
        plano.append(('motorista', mot, lambda rec: _build_motorista_section(rec)))
    if cav:
        plano.append(('cavalo', cav, lambda rec: _build_veiculo_section(rec, 'Veículo Tração (Cavalo)', is_carreta=False)))
    if car:
        plano.append(('carreta', car, lambda rec: _build_veiculo_section(rec, 'Reboque (Carreta)', is_carreta=True)))

    if not plano:
        return {'ok': False, 'story': None, 'components': components,
                'warnings': ['Nenhum componente informado (motorista/cavalo/carreta).']}

    bloqueios: list[str] = []
    for label, rec, build_fn in plano:
        if not isinstance(rec, dict):
            components[label] = {'found': False}
            bloqueios.append(f'{label}: registro invalido (esperado objeto JSON).')
            continue

        status_desc = _status_desc(rec)
        components[label] = {
            'found': True,
            'status': status_desc,
            'id': rec.get('id'),
            'limit_date': rec.get('limitDate'),
        }
        if label == 'motorista':
            hist = rec.get('history') or {}
            drv = rec.get('driver') or {}
            components[label]['driver_name'] = (hist.get('driverName') or drv.get('name') or '').strip()

        if enforce_conforme and status_desc.casefold() != 'conforme':
            bloqueios.append(f'{label}: status "{status_desc or "-"}" — precisa estar "Conforme"')
            continue

        elements_per_component.append(build_fn(rec))

    if enforce_conforme and bloqueios:
        log_alerta(f"[mock-pdf] geracao bloqueada (enforce_conforme): {'; '.join(bloqueios)}")
        return {'ok': False, 'story': None, 'components': components,
                'warnings': warnings + bloqueios}

    if not elements_per_component:
        return {'ok': False, 'story': None, 'components': components,
                'warnings': warnings + ['nenhum componente valido — PDF nao gerado']}

    story = [Spacer(1, 0.2 * cm)]
    for i, elems in enumerate(elements_per_component):
        if i > 0:
            story.append(Spacer(1, 0.6 * cm))
        story.extend(elems)

    return {'ok': True, 'story': story, 'components': components, 'warnings': warnings}


def _make_doc(target):
    """SimpleDocTemplate padrao (aceita caminho ou file-like/BytesIO)."""
    return SimpleDocTemplate(
        target,
        pagesize=A4,
        topMargin=2.0 * cm,
        bottomMargin=1.6 * cm,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        title='Risk Assessment Document',
        author='Sistema Lamonica (Mock)',
    )


def render_pdf_bytes(records: dict, *, enforce_conforme: bool = False) -> dict:
    """Renderiza o PDF EM MEMORIA (sem tocar em disco) — ideal p/ microservico.

    Retorna dict: { ok, pdf (bytes|None), components, warnings }.
    """
    built = _build_story(records, enforce_conforme=enforce_conforme)
    if not built['ok']:
        return {'ok': False, 'pdf': None,
                'components': built['components'], 'warnings': built['warnings']}

    buf = io.BytesIO()
    _make_doc(buf).build(built['story'], onFirstPage=_header_footer, onLaterPages=_header_footer)
    pdf = buf.getvalue()
    log_info(f"[mock-pdf] render em memoria ({len(pdf)} bytes) componentes={list(built['components'].keys())}")
    return {'ok': True, 'pdf': pdf, 'components': built['components'], 'warnings': built['warnings']}


def gerar_pdf_from_records(
    records: dict,
    output_path: str | Path,
    *,
    enforce_conforme: bool = False,
) -> dict:
    """Gera um unico PDF (layout AngelLira) a partir de registros ja prontos e
    salva em `output_path`.

    Args:
        records: dict com ate 3 chaves — 'motorista', 'cavalo', 'carreta' —
            cada uma um registro no formato do AngelLira (profile/query).
        output_path: caminho do PDF de saida.
        enforce_conforme: se True, reproduz o gate "abort-all" (so gera se
            TODOS os componentes estiverem "Conforme"). Padrao False.

    Retorna dict: { ok, output_path, components, warnings }.
    """
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    built = _build_story(records, enforce_conforme=enforce_conforme)
    if not built['ok']:
        return {'ok': False, 'output_path': '',
                'components': built['components'], 'warnings': built['warnings']}

    _make_doc(str(output)).build(built['story'], onFirstPage=_header_footer, onLaterPages=_header_footer)
    log_info(f"[mock-pdf] gerado {output} ({output.stat().st_size} bytes) componentes={list(built['components'].keys())}")
    return {'ok': True, 'output_path': str(output),
            'components': built['components'], 'warnings': built['warnings']}
