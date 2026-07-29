"""FastAPI do servico unificada-robo — API-only (sem Selenium).

Expoe geracao de Dossie/Relatorio AngelLira via API:

    GET  /health                       -- smoke test
    POST /relatorio/consultar          -- consulta status de motorista/cavalo/carreta
    POST /relatorio/pdf_unificado      -- gera PDF unico com motorista + cavalo + carreta

Todos os endpoints usam a API publica AngelLira (auth + /profile/query)
via reportlab/svglib para gerar o PDF de Risk Assessment Document.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Permite rodar com `python backend/main.py` (path do package local)
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

from unificada_robo.relatorio_api import (
    consultar_status_relatorio,
    query_profile_records,
)
from unificada_robo.relatorio_api_pdf import gerar_pdf_unificado
from unificada_robo.risco_lamonica_pdf import gerar_risco_lamonica
from unificada_robo.logger import log_erro, log_info

app = FastAPI(title="Unificada Robo (API-only)", version="1.0.0")


@app.get("/health")
def health():
    return {"ok": True, "service": "unificada-robo (api-only)"}


# ── Consulta status ─────────────────────────────────────────────────────────

class ConsultarRequest(BaseModel):
    query_value: str
    q_for: str  # 'cpf' ou 'plate'


@app.post("/relatorio/consultar")
def consultar(p: ConsultarRequest):
    """Retorna o registro mais recente para o CPF/placa informado (1o item)."""
    try:
        records = query_profile_records(p.query_value, p.q_for)
        if not records:
            return {"ok": True, "encontrado": False, "registros": []}
        return {
            "ok": True,
            "encontrado": True,
            "total": len(records),
            "registro": records[0],
        }
    except Exception as exc:
        log_erro(f"[main] /relatorio/consultar falhou: {exc!r}")
        raise HTTPException(status_code=502, detail=str(exc))


class StatusRequest(BaseModel):
    query_value: str
    q_for: str


@app.post("/relatorio/status")
def status(p: StatusRequest):
    """Verifica se o registro esta Conforme (status_description)."""
    try:
        r = consultar_status_relatorio(p.query_value, p.q_for)
        return {
            "ok": True,
            "status": r.status,
            "query_value": r.query_value,
            "q_for": r.q_for,
            "status_description": r.status_description,
            "item": r.item,
            "erro": r.erro,
        }
    except Exception as exc:
        log_erro(f"[main] /relatorio/status falhou: {exc!r}")
        raise HTTPException(status_code=502, detail=str(exc))


# ── Gera PDF unificado (motorista + cavalo + carreta) ───────────────────────

class PdfUnificadoRequest(BaseModel):
    cpf: Optional[str] = None
    placa_cavalo: Optional[str] = None
    placa_carreta: Optional[str] = None


@app.post("/relatorio/pdf_unificado")
def pdf_unificado(p: PdfUnificadoRequest):
    """Gera o PDF Risk Assessment Document. Retorna o arquivo binario."""
    if not (p.cpf or p.placa_cavalo or p.placa_carreta):
        raise HTTPException(
            status_code=400,
            detail="Informe pelo menos um de: cpf, placa_cavalo, placa_carreta",
        )
    tmp = Path(tempfile.gettempdir()) / f"angellira_unificado_{int(time.time())}.pdf"
    try:
        result = gerar_pdf_unificado(
            cpf=p.cpf,
            placa_cavalo=p.placa_cavalo,
            placa_carreta=p.placa_carreta,
            output_path=tmp,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=502, detail={
                "erro": "Falha ao gerar PDF",
                "components": result.get("components"),
                "warnings": result.get("warnings"),
            })
        log_info(f"[main] PDF gerado em {tmp} (cpf={p.cpf} cavalo={p.placa_cavalo} carreta={p.placa_carreta})")
        return FileResponse(
            path=str(tmp),
            media_type="application/pdf",
            filename=tmp.name,
            headers={
                "X-Components": str(result.get("components") or {}),
                "X-Warnings": str(result.get("warnings") or []),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log_erro(f"[main] /relatorio/pdf_unificado falhou: {exc!r}")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


# ── Gera PDF do Gerenciador de Risco a partir do NOSSO cadastro (sem AngelLira) ──

class PdfLamonicaRequest(BaseModel):
    """Recebe o `dados` do cadastro (shape pending_driver_registrations.dados):
    { motorista, cavalo, carretas[], transportador?, protocolo? }."""
    dados: dict
    protocolo: Optional[str] = None
    usuario: Optional[str] = None
    validade_dias: Optional[int] = None


@app.post("/relatorio/pdf_lamonica")
def pdf_lamonica(p: PdfLamonicaRequest):
    """Gera o Gerenciador de Risco (layout Lamônica) a partir do cadastro, SEM
    consultar o AngelLira. Retorna o arquivo binário — mesmo contrato do
    /relatorio/pdf_unificado (FileResponse + X-Components/X-Warnings)."""
    if not p.dados or not isinstance(p.dados, dict):
        raise HTTPException(status_code=400, detail="Informe 'dados' do cadastro.")
    tmp = Path(tempfile.gettempdir()) / f"risco_lamonica_{int(time.time())}.pdf"
    try:
        kwargs = {}
        if p.protocolo:
            kwargs["protocolo"] = p.protocolo
        if p.usuario:
            kwargs["usuario"] = p.usuario
        if p.validade_dias:
            kwargs["validade_dias"] = p.validade_dias
        result = gerar_risco_lamonica(p.dados, tmp, **kwargs)
        if not result.get("ok"):
            raise HTTPException(status_code=502, detail={
                "erro": "Falha ao gerar PDF",
                "components": result.get("components"),
                "warnings": result.get("warnings"),
            })
        log_info(f"[main] PDF Lamônica gerado em {tmp} (componentes={list(result.get('components') or {})})")
        return FileResponse(
            path=str(tmp),
            media_type="application/pdf",
            filename=tmp.name,
            headers={
                "X-Components": str(result.get("components") or {}),
                "X-Warnings": str(result.get("warnings") or []),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        log_erro(f"[main] /relatorio/pdf_lamonica falhou: {exc!r}")
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}")


def main():
    import uvicorn
    host = os.getenv("UNIFICADA_HOST") or "127.0.0.1"
    port = int(os.getenv("UNIFICADA_PORT") or 8001)
    log_info(f"[unificada-robo] iniciando em http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
