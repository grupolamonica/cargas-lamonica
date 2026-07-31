"""
cadastro_map.py
---------------
Mapeia o payload de CADASTRO do sistema de cargas (motorista/cavalo/carretas/
cavalo_owner/protocolo) para o formato de registro do AngelLira (profile/query)
que a camada de render consome.

Assim da pra pegar um JSON real de cadastro e ver como ficaria no layout do
dossie AngelLira — sem nenhuma consulta ao portal.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone


# ── Formatadores ──────────────────────────────────────────────────────────

def _digits(value) -> str:
    return ''.join(c for c in str(value or '') if c.isdigit())


def _fmt_cnpj(value) -> str:
    d = _digits(value)
    if len(d) == 14:
        return f'{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}'
    return str(value or '').strip()


def _fmt_cpf(value) -> str:
    d = _digits(value)
    if len(d) == 11:
        return f'{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}'
    return str(value or '').strip()


def _to_ddmmyyyy(value):
    """Normaliza varias formas de data para 'DD/MM/YYYY' (que a camada de
    render exibe literalmente quando nao ha 'T')."""
    if not value:
        return None
    s = str(value).strip()
    if 'T' in s:
        try:
            return datetime.fromisoformat(s.replace('Z', '+00:00')).strftime('%d/%m/%Y')
        except Exception:
            return s[:10]
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        try:
            return datetime.strptime(s, '%Y-%m-%d').strftime('%d/%m/%Y')
        except Exception:
            return s
    if re.match(r'^\d{2}/\d{2}/\d{4}$', s):
        return s
    return s


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')


def _plus_days_iso(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime('%Y-%m-%dT%H:%M:%S.000Z')


# ── Deteccao ────────────────────────────────────────────────────────────────

def is_cadastro_payload(payload) -> bool:
    """Heuristica: e o payload de cadastro do sistema de cargas?"""
    if not isinstance(payload, dict):
        return False
    if any(k in payload for k in ('protocolo', 'cavalo_owner', 'carretas', 'owner_reuse')):
        return True
    mot = payload.get('motorista')
    if isinstance(mot, dict) and isinstance(mot.get('cnh'), dict):
        return True
    cav = payload.get('cavalo')
    if isinstance(cav, dict) and 'placa' in cav and 'history' not in cav:
        return True
    return False


# ── Blocos ──────────────────────────────────────────────────────────────────

def _owner_company(payload: dict) -> tuple[dict, str]:
    """Deriva (company, vinculo) do proprietario do cavalo.

    Cobre os casos do payload real do cargas:
      - cavalo_owner presente (dono terceiro) → usa os dados dele;
      - cavalo_owner ausente E o motorista é o dono (buildSubmitDados omite o
        cavalo_owner nesse caso e não emite owner_reuse) → o transportador é o
        próprio motorista, vínculo "Motorista Proprietário";
      - sem pistas → company vazia, "Agregado".
    """
    owner = payload.get('cavalo_owner') or {}
    cavalo = payload.get('cavalo') or {}
    motorista = payload.get('motorista') or {}
    reuse = payload.get('owner_reuse') or {}

    motorista_cpf = _digits(motorista.get('cpf'))
    owner_doc_cavalo = _digits(cavalo.get('owner_doc'))
    is_driver_owner = (
        bool(reuse.get('cavalo_owner_is_driver'))
        or (bool(motorista_cpf) and motorista_cpf == owner_doc_cavalo)
    )

    if owner:
        end = owner.get('endereco') or {}
        # tipo do owner: campo próprio, senão derivado do owner_doc_type do cavalo.
        owner_doc_type = str(cavalo.get('owner_doc_type') or '').lower()
        tipo = str(owner.get('tipo') or '').lower() or ('pj' if owner_doc_type == 'cnpj' else 'pf')
        doc = owner.get('doc')
        doc_fmt = _fmt_cnpj(doc) if tipo == 'pj' else _fmt_cpf(doc)
        company = {
            'name': owner.get('nome') or owner.get('razao_social'),
            'cnpj': doc_fmt,
            'city': end.get('cidade'),
            'state': end.get('uf'),
            'phone': owner.get('telefone'),
        }
    elif is_driver_owner:
        end = motorista.get('endereco') or {}
        tels = motorista.get('telefones') or []
        company = {
            'name': motorista.get('nome'),
            'cnpj': _fmt_cpf(motorista.get('cpf')),
            'city': end.get('cidade') or end.get('municipio'),
            'state': end.get('uf'),
            'phone': motorista.get('telefone_primario') or (tels[0] if tels else None),
        }
    else:
        company = {'name': None, 'cnpj': None, 'city': None, 'state': None, 'phone': None}

    vinculo = 'Motorista Proprietário' if is_driver_owner else 'Agregado'
    return company, vinculo


def _resolve_rntrc(payload: dict, veic: dict, prefix: str) -> str:
    """RNTRC (ANTT) do veículo. O CRLV não traz ANTT: o RNTRC mora no
    proprietário. Espelha resolveVehicleRntrc do backend Node (payload-mapper.js)."""
    def pick(*vals) -> str:
        for v in vals:
            d = _digits(v)
            if d:
                return d
        return ''

    if prefix == 'cab':
        owner = payload.get('cavalo_owner') or {}
        return pick(
            veic.get('antt'), veic.get('rntrc'),
            owner.get('rntrc'), (owner.get('antt_titular') or {}).get('rntrc'),
        )

    # carreta (tow) — o layout AngelLira usa a primeira carreta (idx 0).
    carreta_owners = payload.get('carreta_owners')
    owner = (
        carreta_owners[0] if isinstance(carreta_owners, list) and carreta_owners
        else payload.get('carreta_owner')
    ) or {}
    cavalo_owner = payload.get('cavalo_owner') or {}
    reused = (payload.get('owner_reuse') or {}).get('carreta_owners_reused') or []
    reuses_cavalo = isinstance(reused, list) and 'cavalo_owner' in reused
    return pick(
        veic.get('antt'), veic.get('rntrc'),
        owner.get('rntrc'), (owner.get('antt_titular') or {}).get('rntrc'),
        cavalo_owner.get('rntrc') if reuses_cavalo else '',
        (cavalo_owner.get('antt_titular') or {}).get('rntrc') if reuses_cavalo else '',
    )


def _company_history(company: dict) -> dict:
    return {
        'companyName': company.get('name'),
        'companyCNPJ': company.get('cnpj'),
        'companyCity': company.get('city'),
        'companyState': company.get('state'),
        'companyPhone': company.get('phone'),
    }


def _meta(protocolo, status_desc: str) -> dict:
    """Cabecalho de consulta comum (id, tipo, datas, status, usuario)."""
    return {
        'id': protocolo or '—',
        'sentDate': _now_iso(),
        'receivingDate': _now_iso(),
        'limitDate': _plus_days_iso(365),
        'daysUntilDue': None,  # a render calcula a partir de limitDate
        'status': {'id': 1, 'description': status_desc},
        'user': {'login': 'mock.estudo'},
        'observationCertificate': '',
    }


def _map_motorista(payload: dict, company: dict, vinculo: str, status_desc: str) -> dict | None:
    mot = payload.get('motorista')
    if not isinstance(mot, dict):
        return None
    cnh = mot.get('cnh') or {}
    phones = mot.get('telefones') or []
    phone = mot.get('telefone_primario') or (phones[0] if phones else '')
    protocolo = payload.get('protocolo')

    hist = {
        'driverName': mot.get('nome'),
        'driverKind': 'AGR',
        'driverCPF': _digits(mot.get('cpf')),
        'driverBirth': _to_ddmmyyyy(mot.get('data_nascimento')),
        'driverRg': mot.get('rg'),
        'driverRgState': mot.get('rg_uf'),
        'driverFather': mot.get('nome_pai'),
        'driverMother': mot.get('nome_mae'),
        'driverPhone': phone,
        'driverCNH': cnh.get('registro'),
        'driverCNHCategory': cnh.get('categoria'),
        'driverCNHSecurity': cnh.get('codigo_seguranca'),
        'driverCNHValidity': _to_ddmmyyyy(cnh.get('validade')),
        **_company_history(company),
    }
    rec = {
        'type': {'description': 'Motorista'},
        # Comentário = situação (igual ao layout do doc AngelLira).
        'description': status_desc,
        'history': hist,
        'driver': {'name': mot.get('nome'), 'natural': {'cpf': _digits(mot.get('cpf'))}},
        'company': company,
        'legalPersonRelationship': {'description': vinculo},
    }
    rec.update(_meta(protocolo, status_desc))
    return rec


def _map_veiculo(veic: dict, prefix: str, payload: dict, company: dict,
                 vinculo: str, status_desc: str) -> dict | None:
    """prefix = 'cab' (cavalo) ou 'tow' (carreta/reboque)."""
    if not isinstance(veic, dict):
        return None
    protocolo = payload.get('protocolo')
    owner_type = str(veic.get('owner_doc_type') or '').lower()
    owner_doc = veic.get('owner_doc')

    hist = {
        f'{prefix}Plate': str(veic.get('placa') or '').upper(),
        f'{prefix}Brand': veic.get('marca'),
        f'{prefix}Model': veic.get('modelo'),
        f'{prefix}FabricationYear': veic.get('ano_fabricacao'),
        f'{prefix}ModelYear': veic.get('ano'),
        f'{prefix}UF': veic.get('uf_emplacamento'),
        f'{prefix}Renavam': veic.get('renavam'),
        f'{prefix}Chassis': veic.get('chassi'),
        f'{prefix}Antt': _resolve_rntrc(payload, veic, prefix),
        f'{prefix}LastLicensing': _to_ddmmyyyy(veic.get('ultimo_licenciamento')),
        f'{prefix}Color': veic.get('cor'),
        f'{prefix}OwnerCNPJ': _fmt_cnpj(owner_doc) if owner_type == 'cnpj' else '',
        f'{prefix}OwnerCPF': _fmt_cpf(owner_doc) if owner_type == 'cpf' else '',
        f'{prefix}Fleet': '',
        **_company_history(company),
    }
    rec = {
        'type': {'description': 'Veículo'},
        # Comentário = situação (igual ao layout do doc AngelLira).
        'description': status_desc,
        'history': hist,
        'company': company,
        'legalPersonRelationship': {'description': vinculo},
    }
    rec.update(_meta(protocolo, status_desc))
    return rec


def map_cadastro(payload: dict, *, status_desc: str = 'Conforme') -> tuple[dict, list[str]]:
    """Converte o payload de cadastro em { motorista, cavalo, carreta } no
    formato AngelLira. Retorna (records, warnings)."""
    warnings: list[str] = []
    company, vinculo = _owner_company(payload)

    records: dict[str, dict | None] = {'motorista': None, 'cavalo': None, 'carreta': None}
    records['motorista'] = _map_motorista(payload, company, vinculo, status_desc)

    if payload.get('cavalo'):
        records['cavalo'] = _map_veiculo(payload['cavalo'], 'cab', payload, company, vinculo, status_desc)

    carretas = payload.get('carretas')
    if isinstance(carretas, list) and carretas:
        records['carreta'] = _map_veiculo(carretas[0], 'tow', payload, company, vinculo, status_desc)
        if len(carretas) > 1:
            warnings.append(
                f"{len(carretas)} carretas no JSON — o layout AngelLira mostra 1; "
                f"usando a primeira ({carretas[0].get('placa')})."
            )
    elif isinstance(payload.get('carreta'), dict):
        records['carreta'] = _map_veiculo(payload['carreta'], 'tow', payload, company, vinculo, status_desc)

    return records, warnings
