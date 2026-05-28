"""
relatorio_api_pdf.py
--------------------
Gera um PDF unificado de Risk Assessment Document a partir dos dados da
API AngelLira (motorista + cavalo + carreta), 100% via API REST.

Sem Selenium, sem printToPDF. Tempo medio: ~3-5s vs ~60-90s do Selenium.

Layout: ReportLab platypus (mais robusto que o _build_pdf_bytes manual).
"""

from __future__ import annotations

import io
from datetime import datetime
from pathlib import Path
from typing import Iterable

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm, mm
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, KeepTogether,
)

from concurrent.futures import ThreadPoolExecutor, as_completed

from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF

from .relatorio_api import query_profile_records, get_cached_token
from .logger import log_info, log_alerta

# Logo AngelLira (SVG opcional — copie pra static/img/ se quiser exibir no PDF)
import os
_BASE_DIR = Path(__file__).parent.parent.parent
LOGO_PATH = Path(os.getenv("UNIFICADA_LOGO_PATH") or (_BASE_DIR / 'static' / 'img' / 'angellira-logo.svg'))

try:
    from svglib.svglib import svg2rlg
    _LOGO_DRAWING = svg2rlg(str(LOGO_PATH)) if LOGO_PATH.exists() else None
except Exception:
    _LOGO_DRAWING = None


# ── Estilos ───────────────────────────────────────────────────────────

def _styles():
    """Estilos fiéis ao portal AngelLira:
    - "Detalhes da Consulta" → preto bold 14pt
    - "Consulta", "Dados do Motorista", etc → azul ciano (#01b6ed) bold 10pt
    - Labels → cinza 8pt
    - Valores → preto 10pt
    """
    base = getSampleStyleSheet()
    styles = {
        # Cabeçalho de bloco grande (ex: "Detalhes da Consulta")
        'mainHdr':   ParagraphStyle('MainHdr', parent=base['Heading2'], fontSize=14, textColor=colors.black,
                                    spaceBefore=10, spaceAfter=4, fontName='Helvetica-Bold'),
        # Sub-cabeçalho azul claro (ex: "Consulta", "Dados do Motorista")
        'subHdr':    ParagraphStyle('SubHdr', parent=base['Normal'], fontSize=11, textColor=colors.HexColor('#01b6ed'),
                                    spaceBefore=8, spaceAfter=4, fontName='Helvetica-Bold'),
        # Label dos campos (cinza pequeno)
        'label':     ParagraphStyle('Label', parent=base['Normal'], fontSize=8, textColor=colors.HexColor('#64748b')),
        # Valor dos campos (preto regular)
        'value':     ParagraphStyle('Value', parent=base['Normal'], fontSize=10, textColor=colors.black),
        # Texto fluido (Comentário etc.)
        'comment':   ParagraphStyle('Comment', parent=base['Normal'], fontSize=10, textColor=colors.black,
                                    spaceAfter=4),
        # Badges
        'badgeOk':   ParagraphStyle('BadgeOk', parent=base['Normal'], fontSize=9, textColor=colors.HexColor('#16a34a'),
                                    spaceAfter=2, fontName='Helvetica-Bold'),
        'badgeWarn': ParagraphStyle('BadgeWarn', parent=base['Normal'], fontSize=9, textColor=colors.HexColor('#dc2626'),
                                    spaceAfter=2, fontName='Helvetica-Bold'),
    }
    return styles


def _fmt_date(value) -> str:
    """Data sem hora. Aceita ISO 'YYYY-MM-DDTHH:MM:SS.000Z'."""
    if not value: return '—'
    s = str(value)
    if 'T' in s and len(s) >= 10:
        try:
            d = datetime.fromisoformat(s.replace('Z', '+00:00'))
            return d.strftime('%d/%m/%Y')
        except: return s[:10]
    return s


def _fmt_datetime(value) -> str:
    """Data+hora 'DD/MM/YYYY, HH:MM:SS' — mantém UTC sem conversão (igual portal AngelLira)."""
    if not value: return '—'
    s = str(value)
    if 'T' in s and len(s) >= 10:
        try:
            # Lê e mantém o relógio UTC (não converte pra timezone local)
            d = datetime.fromisoformat(s.replace('Z', '+00:00')).replace(tzinfo=None)
            return d.strftime('%d/%m/%Y, %H:%M:%S')
        except: return s[:10]
    return s


# Mapeamento de tipos AngelLira (codigo → descrição expandida)
_DRIVER_KIND_MAP = {
    'AGR': 'Motorista Agregado',
    'FNC': 'Motorista Funcionário',
    'AUT': 'Motorista Autônomo',
    'TER': 'Motorista Terceiro',
}


def _expand_driver_kind(code) -> str:
    if not code: return '—'
    c = str(code).strip().upper()
    return _DRIVER_KIND_MAP.get(c, c)


def _fmt_cpf(value) -> str:
    s = ''.join(c for c in str(value or '') if c.isdigit())
    if len(s) == 11:
        return f'{s[:3]}.{s[3:6]}.{s[6:9]}-{s[9:]}'
    return s or '—'


def _safe(value, default='—') -> str:
    if value is None: return default
    s = str(value).strip()
    return s if s else default


def _kv_table(rows: list[tuple[str, str]]) -> Table:
    """[LEGACY] Tabela 2-col vertical. Mantida pro fallback."""
    data = []
    styles = _styles()
    for label, value in rows:
        data.append([
            Paragraph(label, styles['label']),
            Paragraph(_safe(value), styles['value']),
        ])
    t = Table(data, colWidths=[5.5 * cm, 11 * cm], hAlign='LEFT')
    t.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#f8fafc')),
        ('LINEABOVE', (0, 1), (-1, -1), 0.3, colors.HexColor('#e2e8f0')),
    ]))
    return t


def _grid_row(fields: list[tuple[str, str]], total_cols: int = 4) -> Table:
    """Layout horizontal igual portal AngelLira: label em cima (cinza), valor
    embaixo (preto). Recebe lista de (label, valor) e distribui em N colunas.

    Cada célula é um mini-stack vertical:
        [label]
        [valor]
    """
    styles = _styles()
    # Preenche com células vazias se faltar pra completar a row
    while len(fields) < total_cols:
        fields.append(('', ''))

    page_width = A4[0] - 4 * cm  # já descontando margens
    col_w = page_width / total_cols

    # Cada célula é uma tabela 1-col com label em cima e valor embaixo
    cells = []
    for label, value in fields:
        if not label:
            cells.append('')
            continue
        cell = Table(
            [[Paragraph(label, styles['label'])], [Paragraph(_safe(value), styles['value'])]],
            colWidths=[col_w - 4]
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
    """Quebra `fields` em múltiplas linhas com `cols_per_row` colunas cada."""
    rows_elems = []
    for i in range(0, len(fields), cols_per_row):
        chunk = fields[i:i + cols_per_row]
        rows_elems.append(_grid_row(chunk, total_cols=cols_per_row))
        rows_elems.append(Spacer(1, 1))
    return rows_elems


def _simple_text_block(label: str, value: str) -> list:
    """Bloco simples 'label em cima, texto embaixo' (pra Comentário etc.)."""
    styles = _styles()
    return [
        Paragraph(label, styles['subHdr']),
        Paragraph(_safe(value), styles['value']),
        Spacer(1, 6),
    ]


def _status_badge(status_description: str):
    """Badge de status — só texto colorido, igual o portal ("Conforme" em verde)."""
    # Não usado mais como bloco separado — o status agora aparece dentro da grade Consulta.
    return None


def _calc_days_until(iso_str) -> str:
    """Calcula dias até a data ISO. API pode retornar daysUntilDue=null."""
    if not iso_str: return '—'
    try:
        s = str(iso_str).replace('Z', '+00:00')
        d = datetime.fromisoformat(s)
        delta = (d.date() - datetime.now().date()).days
        return str(delta)
    except Exception:
        return '—'


def _consulta_rows(rec: dict) -> list[tuple[str, str]]:
    """Linhas da subseção 'Consulta' — datas com hora (igual portal AngelLira)."""
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


def _comentario_rows(rec: dict) -> list[tuple[str, str]]:
    return [
        ('Comentário', _safe(rec.get('description'))),
        ('Comentário Certificado', _safe(rec.get('observationCertificate'))),
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
    """Layout HORIZONTAL idêntico ao portal AngelLira:
    label em cima (cinza pequeno), valor embaixo (preto), 4-5 colunas por linha."""
    styles = _styles()
    hist = rec.get('history') or {}
    driver = rec.get('driver') or {}
    status_desc = (rec.get('status') or {}).get('description')

    consulta_fields = _consulta_rows(rec)  # 8 campos → 2 linhas de 4

    dados_top = [  # linha 1: 4 cols (Nome | Tipo | CPF | Data Nascimento)
        ('Nome', _safe(hist.get('driverName') or driver.get('name'))),
        ('Tipo', _expand_driver_kind(hist.get('driverKind'))),
        ('CPF', _fmt_cpf(hist.get('driverCPF') or (driver.get('natural') or {}).get('cpf'))),
        ('Data Nascimento', _fmt_date(hist.get('driverBirth'))),
    ]
    dados_bot = [  # linha 2: 5 cols (RG | UF | Pai | Mãe | Telefones)
        ('RG', _safe(hist.get('driverRg'))),
        ('UF', _safe(hist.get('driverRgState'))),
        ('Nome do Pai', _safe(hist.get('driverFather'))),
        ('Nome da Mãe', _safe(hist.get('driverMother'))),
        ('Telefones', _safe(hist.get('driverPhone'))),
    ]
    cnh_fields = [  # 4 cols
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
    status_desc = (rec.get('status') or {}).get('description')

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
    """Header com logo AngelLira + razão social. Footer com copyright + versão.
    Imitando o portal: profile.angellira.com.br
    """
    canvas.saveState()

    # ── Header: Logo AngelLira + razao social ──
    header_y = A4[1] - 1.8 * cm
    if _LOGO_DRAWING is not None:
        # Escalar o drawing pro tamanho do header
        target_h = 1.2 * cm
        scale = target_h / _LOGO_DRAWING.height
        d = Drawing(_LOGO_DRAWING.width * scale, _LOGO_DRAWING.height * scale)
        d.scale(scale, scale)
        # contents é a lista interna do Drawing
        for child in _LOGO_DRAWING.contents:
            d.add(child)
        renderPDF.draw(d, canvas, 2 * cm, header_y - 0.1 * cm)
        text_x = 2 * cm + d.width + 0.4 * cm
    else:
        # Fallback: só texto se SVG nao carregou
        canvas.setFillColor(colors.HexColor('#04528c'))
        canvas.setFont('Helvetica-Bold', 14)
        canvas.drawString(2 * cm, header_y, 'AngelLira')
        text_x = 4.5 * cm

    canvas.setFillColor(colors.black)
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawString(text_x, header_y + 0.2 * cm, 'ANGELLIRA TECNOLOGIA, SEGURANÇA E LOGÍSTICA LTDA')

    # Linha cinza claro abaixo do header
    canvas.setStrokeColor(colors.HexColor('#cbd5e1'))
    canvas.setLineWidth(0.5)
    canvas.line(2 * cm, header_y - 0.4 * cm, A4[0] - 2 * cm, header_y - 0.4 * cm)

    # ── Footer: copyright + version (idêntico ao portal) ──
    canvas.setFillColor(colors.HexColor('#6b7280'))
    canvas.setFont('Helvetica', 7)
    canvas.drawString(2 * cm, 1 * cm,
                      'Copyright © 2026 ANGELLIRA TECNOLOGIA, SEGURANÇA E LOGÍSTICA LTDA. Todos os direitos reservados |')
    canvas.setFillColor(colors.HexColor('#04528c'))
    canvas.drawString(2 * cm, 0.65 * cm, 'Política de Privacidade   ·   Política de Cookies   ·   Perfil Securitário | Versão 1.13.0')
    # Numero de pagina à direita do footer
    canvas.setFillColor(colors.HexColor('#6b7280'))
    canvas.drawRightString(A4[0] - 2 * cm, 0.65 * cm, f'Página {doc.page}')

    canvas.restoreState()


# ── Função pública ───────────────────────────────────────────────────────

def gerar_pdf_unificado(
    *,
    cpf: str | None = None,
    placa_cavalo: str | None = None,
    placa_carreta: str | None = None,
    output_path: str | Path,
) -> dict:
    """Consulta a API AngelLira para os 3 alvos disponíveis (motorista, cavalo,
    carreta) e gera um único PDF com layout próprio em `output_path`.

    Retorna dict com:
        ok: bool
        output_path: str
        components: dict de status por componente
        warnings: list[str]
    """
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    warnings = []
    components = {}
    elements_per_component = []

    # Aquece o token JWT primeiro (uma vez) pra evitar 3 logins em paralelo
    try:
        get_cached_token()
    except Exception as e:
        log_alerta(f"[pdf-api] falha ao aquecer token: {e}")

    # ── Queries em paralelo (motorista + cavalo + carreta) ──
    queries = []
    if cpf: queries.append(('motorista', cpf, 'cpf'))
    if placa_cavalo: queries.append(('cavalo', placa_cavalo, 'plate'))
    if placa_carreta: queries.append(('carreta', placa_carreta, 'plate'))

    results = {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        future_to_label = {
            pool.submit(query_profile_records, q_val, q_for): label
            for label, q_val, q_for in queries
        }
        for fut in as_completed(future_to_label):
            label = future_to_label[fut]
            try:
                results[label] = fut.result()
            except Exception as e:
                log_alerta(f"[pdf-api] query {label} falhou: {e}")
                results[label] = []

    # ── Motorista ──
    if cpf:
        records = results.get('motorista') or []
        if records:
            rec = records[0]
            status_desc = (rec.get('status') or {}).get('description', '')
            components['motorista'] = {
                'found': True,
                'status': status_desc,
                'id': rec.get('id'),
                'limit_date': rec.get('limitDate'),
            }
            if 'conforme' not in status_desc.lower():
                warnings.append(f"motorista: status={status_desc} (nao Conforme)")
            elements_per_component.append(_build_motorista_section(rec))
        else:
            components['motorista'] = {'found': False}
            warnings.append(f"motorista CPF {cpf} nao encontrado no AngelLira")

    # ── Cavalo ──
    if placa_cavalo:
        records = results.get('cavalo') or []
        if records:
            rec = records[0]
            status_desc = (rec.get('status') or {}).get('description', '')
            components['cavalo'] = {
                'found': True,
                'status': status_desc,
                'id': rec.get('id'),
                'limit_date': rec.get('limitDate'),
            }
            if 'conforme' not in status_desc.lower():
                warnings.append(f"cavalo: status={status_desc}")
            elements_per_component.append(_build_veiculo_section(rec, 'Veículo Tração (Cavalo)', is_carreta=False))
        else:
            components['cavalo'] = {'found': False}
            warnings.append(f"cavalo placa {placa_cavalo} nao encontrado")

    # ── Carreta ──
    if placa_carreta:
        records = results.get('carreta') or []
        if records:
            rec = records[0]
            status_desc = (rec.get('status') or {}).get('description', '')
            components['carreta'] = {
                'found': True,
                'status': status_desc,
                'id': rec.get('id'),
                'limit_date': rec.get('limitDate'),
            }
            if 'conforme' not in status_desc.lower():
                warnings.append(f"carreta: status={status_desc}")
            elements_per_component.append(_build_veiculo_section(rec, 'Reboque (Carreta)', is_carreta=True))
        else:
            components['carreta'] = {'found': False}
            warnings.append(f"carreta placa {placa_carreta} nao encontrado")

    if not elements_per_component:
        return {
            'ok': False,
            'output_path': '',
            'components': components,
            'warnings': warnings + ['nenhum componente encontrado — PDF nao gerado'],
        }

    # ── Render do PDF ──
    # Sem título "Dossiê" — começa direto com a primeira seção (Detalhes da Consulta)
    # igual o portal AngelLira faz
    styles = _styles()
    story = [Spacer(1, 0.2 * cm)]
    for i, elems in enumerate(elements_per_component):
        if i > 0:
            story.append(Spacer(1, 0.6 * cm))
        story.extend(elems)

    doc = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        topMargin=2.0 * cm,
        bottomMargin=1.6 * cm,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        title='Risk Assessment Document',
        author='Sistema Lamonica',
    )
    doc.build(story, onFirstPage=_header_footer, onLaterPages=_header_footer)

    log_info(f"[pdf-api] gerado {output} ({output.stat().st_size} bytes) componentes={list(components.keys())}")

    return {
        'ok': True,
        'output_path': str(output),
        'components': components,
        'warnings': warnings,
    }
