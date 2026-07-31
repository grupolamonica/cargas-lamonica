"""
Gerador Mock AngelLira — FastAPI app.

Clone de estudo/teste do AngelLira Unificador. Recebe um JSON no formato do
AngelLira e renderiza o MESMO PDF (layout, logo, secoes) — SEM conectar no
portal AngelLira, sem login, sem token.
"""
from __future__ import annotations

import base64
import datetime
import json
import os
import re
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Header
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

# Paths relativos — funciona em dev e empacotado (PyInstaller onefile).
BASE_DIR = Path(getattr(sys, '_MEIPASS', None) or Path(__file__).parent)
sys.path.insert(0, str(BASE_DIR))

try:
    from dotenv import load_dotenv
    _exe_dir = Path(sys.executable).resolve().parent
    for env_candidate in [_exe_dir / ".env", BASE_DIR / ".env"]:
        if env_candidate.exists():
            load_dotenv(dotenv_path=env_candidate)
            break
except ImportError:
    pass

from shared.mock_source import normalize_input, get_sample            # noqa: E402
from shared.pdf_render import gerar_pdf_from_records, render_pdf_bytes  # noqa: E402

app = FastAPI(title="Gerador Mock AngelLira")

DOWNLOADS = Path(os.path.expanduser("~")) / "Downloads"
DEFAULT_OUT = BASE_DIR / "data" / "out"

# API key opcional para o microservico (protege /api/render em rede aberta).
# Se API_KEY estiver definido no ambiente, exige o header X-API-Key.
API_KEY = (os.getenv("API_KEY") or "").strip()


def _check_api_key(provided: str | None) -> None:
    if API_KEY and (provided or "").strip() != API_KEY:
        raise HTTPException(status_code=401, detail="API key invalida ou ausente (header X-API-Key).")


def _bool_param(value, default: bool = False) -> bool:
    if value is None:
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "sim", "on")


@app.middleware("http")
async def _no_cache_static(request, call_next):
    """Forca o navegador a sempre baixar HTML/CSS/JS atualizados."""
    response = await call_next(request)
    path = request.url.path
    if path.endswith((".html", ".css", ".js")) or path == "/" or path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# ── Logs in-memory ──────────────────────────────────────────────────────

execution_logs: list[dict] = []


def add_log(level, msg, step=None, total=None):
    entry = {
        "time": datetime.datetime.now().strftime("%H:%M:%S"),
        "level": level.upper(),
        "msg": msg,
    }
    if step is not None:
        entry["step"] = step
        entry["total"] = total
    execution_logs.append(entry)
    if len(execution_logs) > 200:
        execution_logs.pop(0)


# ── Helpers de nome de arquivo ────────────────────────────────────────────

_INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|]')


def _sanitizar_para_arquivo(nome: str, max_len: int = 80) -> str:
    if not nome:
        return ""
    limpo = _INVALID_FILENAME_CHARS.sub("", nome)
    limpo = " ".join(limpo.split())
    return limpo[:max_len].strip()


def _driver_plate(rec: dict | None, prefix: str) -> str:
    if not isinstance(rec, dict):
        return ""
    return str((rec.get('history') or {}).get(f'{prefix}Plate') or '').strip().upper()


def _nome_final(records: dict) -> tuple[str, str]:
    """Deriva (nome_do_arquivo, tipo_label) a partir dos registros — mesma
    logica do unificador real (RELATORIO x DOSSIE)."""
    mot = records.get('motorista')
    cav = records.get('cavalo')
    car = records.get('carreta')
    presentes = [k for k, v in records.items() if v]
    n = len(presentes)

    nome_motorista = ""
    if isinstance(mot, dict):
        hist = mot.get('history') or {}
        drv = mot.get('driver') or {}
        nome_motorista = (hist.get('driverName') or drv.get('name') or '').strip()
    nome_safe = _sanitizar_para_arquivo(nome_motorista)

    cavalo_placa = _driver_plate(cav, 'cab')
    carreta_placa = _driver_plate(car, 'tow')

    if n == 1:
        if mot:
            base = f"RELATORIO MOTORISTA - {nome_safe}" if nome_safe else "RELATORIO MOTORISTA"
        elif cav:
            base = f"RELATORIO CAVALO - {cavalo_placa}" if cavalo_placa else "RELATORIO CAVALO"
        else:
            base = f"RELATORIO CARRETA - {carreta_placa}" if carreta_placa else "RELATORIO CARRETA"
        return f"{base}.pdf", "Relatorio"

    if mot and nome_safe:
        base = f"DOSSIE - {nome_safe}"
    else:
        placas = [p for p in (cavalo_placa, carreta_placa) if p]
        base = f"DOSSIE - {' + '.join(placas)}" if placas else "DOSSIE_UNIFICADO"
    return f"{base}.pdf", "Dossie"


# ── API Endpoints ─────────────────────────────────────────────────────────

@app.get("/api/logs")
async def get_logs():
    return execution_logs


@app.get("/api/exemplo")
async def get_exemplo():
    """Retorna o JSON de exemplo (formato aceito pelo /api/gerar)."""
    return get_sample()


@app.post("/api/gerar")
async def gerar(data: dict, background_tasks: BackgroundTasks):
    """Gera o PDF (layout AngelLira) a partir de um JSON.

    Body: {
        payload: <json no formato AngelLira — rotulado, cru {data:[...]}, lista ou rec unico>,
        enforce_conforme?: bool,   # default False (modo estudo)
        output_dir?: str,          # default ~/Downloads
        filename?: str,            # opcional — sobrescreve o nome derivado
        to_downloads?: bool        # default True; se False, salva em data/out
    }
    """
    payload = data.get("payload", data.get("dados"))
    if payload is None:
        raise HTTPException(status_code=400, detail="Body precisa conter 'payload' com o JSON dos dados.")

    enforce = bool(data.get("enforce_conforme", False))
    filename_override = (data.get("filename") or "").strip()
    to_downloads = data.get("to_downloads", True)
    if data.get("output_dir"):
        out_dir = Path(str(data["output_dir"]))
    else:
        out_dir = DOWNLOADS if to_downloads else DEFAULT_OUT

    # Normaliza o JSON em {motorista, cavalo, carreta}.
    try:
        records, norm_warnings = normalize_input(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"JSON invalido: {e}")

    presentes = [k for k, v in records.items() if v]
    if not presentes:
        raise HTTPException(
            status_code=400,
            detail="Nenhum componente reconhecido no JSON (motorista/cavalo/carreta).",
        )

    def run_task():
        work_dir = None
        try:
            add_log("INFO", f"Lendo JSON... componentes: {', '.join(presentes)}", step=1, total=3)
            for w in norm_warnings:
                add_log("WARNING", w)

            work_dir = Path(tempfile.mkdtemp(prefix="mock_angellira_"))
            tmp_pdf = work_dir / "dossie.pdf"

            add_log("INFO", "Renderizando PDF (layout AngelLira)...", step=2, total=3)
            result = gerar_pdf_from_records(records, tmp_pdf, enforce_conforme=enforce)

            if not result.get("ok"):
                for w in result.get("warnings", []):
                    add_log("ERROR", w)
                add_log("ERROR", "Geracao cancelada.", step=3, total=3)
                return

            for chave, info in (result.get("components") or {}).items():
                if info.get("found"):
                    add_log("SUCCESS", f"{chave.capitalize()}: {info.get('status') or '-'}")

            nome_final = f"{_sanitizar_para_arquivo(filename_override)}.pdf" if filename_override else None
            if not nome_final:
                nome_final, tipo_label = _nome_final(records)
            else:
                tipo_label = "PDF"
            if not nome_final.lower().endswith(".pdf"):
                nome_final += ".pdf"

            out_dir.mkdir(parents=True, exist_ok=True)
            dest_final = out_dir / nome_final
            add_log("INFO", f"Salvando em {out_dir}...", step=3, total=3)
            try:
                if dest_final.exists():
                    dest_final.unlink()
                import shutil
                shutil.move(str(tmp_pdf), str(dest_final))
            except Exception as move_err:
                add_log("ERROR", f"Falha ao salvar: {move_err}", step=3, total=3)
                return

            from pypdf import PdfReader
            total_pages = len(PdfReader(str(dest_final)).pages)
            size_kb = dest_final.stat().st_size / 1024
            n_found = sum(1 for v in (result.get("components") or {}).values() if v.get("found"))
            add_log(
                "SUCCESS",
                f"{tipo_label} gerado! {nome_final} "
                f"({size_kb:.0f} KB, {total_pages} pag, {n_found} componente(s)) -> {dest_final}",
                step=3, total=3,
            )
        except Exception as e:
            add_log("ERROR", f"Falha no processo: {str(e)[:200]}", step=3, total=3)
        finally:
            if work_dir is not None:
                import shutil
                shutil.rmtree(work_dir, ignore_errors=True)

    background_tasks.add_task(run_task)
    return {"status": "ok", "message": "Processo iniciado", "components": presentes}


@app.get("/health")
async def health():
    """Healthcheck do microservico (usado pelo Docker/monitoramento da VPS)."""
    return {"ok": True, "service": "gerador-mock-angellira", "auth": bool(API_KEY)}


@app.post("/api/render")
async def render(request: Request, x_api_key: str | None = Header(default=None)):
    """Endpoint de INTEGRACAO (microservico). Sincrono: recebe o JSON e devolve o PDF.

    Body = o JSON do cadastro (ou formato AngelLira) — enviado direto, sem wrapper.

    Query params:
        format = 'pdf' (default) -> retorna application/pdf (bytes)
                 'base64'        -> retorna JSON { ok, filename, components, warnings, pdf_base64 }
        enforce = 'true'|'false' (default false) -> gate abort-all "Conforme"
        filename = nome do arquivo (opcional; senao deriva do motorista/placas)

    Auth: se API_KEY estiver setado no ambiente, exige header X-API-Key.
    """
    _check_api_key(x_api_key)

    try:
        payload = await request.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Body precisa ser JSON valido: {e}")
    if payload is None:
        raise HTTPException(status_code=400, detail="Body vazio — envie o JSON do cadastro.")

    qp = request.query_params
    fmt = (qp.get("format") or "pdf").strip().lower()
    enforce = _bool_param(qp.get("enforce"), default=False)
    filename_override = (qp.get("filename") or "").strip()

    try:
        records, norm_warnings = normalize_input(payload)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"JSON invalido: {e}")

    if not any(records.values()):
        raise HTTPException(
            status_code=422,
            detail="Nenhum componente reconhecido no JSON (motorista/cavalo/carreta).",
        )

    result = render_pdf_bytes(records, enforce_conforme=enforce)
    if not result.get("ok"):
        return Response(
            content=json.dumps({
                "ok": False,
                "components": result.get("components", {}),
                "warnings": (result.get("warnings") or []) + norm_warnings,
            }, ensure_ascii=False),
            media_type="application/json",
            status_code=422,
        )

    pdf_bytes = result["pdf"]
    nome_final = f"{_sanitizar_para_arquivo(filename_override)}.pdf" if filename_override else _nome_final(records)[0]
    if not nome_final.lower().endswith(".pdf"):
        nome_final += ".pdf"

    add_log("SUCCESS", f"[/api/render] {nome_final} ({len(pdf_bytes)} bytes, fmt={fmt})")

    if fmt == "base64":
        return {
            "ok": True,
            "filename": nome_final,
            "components": result.get("components", {}),
            "warnings": (result.get("warnings") or []) + norm_warnings,
            "pdf_base64": base64.b64encode(pdf_bytes).decode("ascii"),
        }

    # Default: PDF cru (bytes).
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{nome_final}"'},
    )


app.mount("/", StaticFiles(directory=str(BASE_DIR / "static"), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8002)
