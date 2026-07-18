"""
Robô Nestlé — Embarques (adaptado do Projeto Galileu para o Cargas Lamônica).

Enriquece as cargas Nestlé ACEITAS com o estado REAL da viagem: motorista, placa,
status (AGUARDANDO INICIO / EM VIAGEM / FINALIZADO) e etapas de coleta/entrega.

Fluxo (dinâmico): lê os codembarque das ofertas já coletadas (nestle_ofertas) que ainda
não estão FINALIZADAS em nestle_embarques, busca o detalhe de cada
(EmbarqueServicePlus.getInfoConfirmacaoEntrega) e faz upsert em nestle_embarques.
A tela Programação junta essa tabela às ofertas (motorista/placa/status; FINALIZADO →
concluído). Destino = Supabase do Lamônica (via nestle/supabase_client).
"""

from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta

from nestle.galileu_client import _rpc, get_token
from nestle.supabase_client import registrar_log, get_client

_BRT = timezone(timedelta(hours=-3))


def _to_ts(val):
    if not val:
        return None
    s = str(val).strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            pass
    return s or None


def _to_bool(val):
    if val is None:
        return None
    return str(val).lower().strip() in ("t", "true", "1", "s", "sim")


def _to_num(val):
    if val is None or str(val).strip() == "":
        return None
    try:
        return float(str(val).replace(",", "."))
    except (ValueError, TypeError):
        return None


def _stage(ops, tipo):
    if not ops:
        return {}
    op = ops[0] if tipo == "coleta" else ops[-1]
    return {
        "cidade": (str(op.get("cidade")).strip() or None) if op.get("cidade") not in (None, "") else None,
        "previni": _to_ts(op.get("dtahrprevini")),
        "chegada": _to_ts(op.get("dtahrchegadaoperacao")),
        "fim": _to_ts(op.get("dtahrfimoperacao")),
    }


def buscar_detalhe(codembarque: str) -> dict:
    d = _rpc("EmbarqueServicePlus", "getInfoConfirmacaoEntrega", {"codembarque": codembarque})
    return d.get("payload") or {}


def _mapear(cod: str, detalhe: dict) -> dict:
    emb = detalhe.get("embarque") or {}
    ops = detalhe.get("operacoes") or []
    col, ent = _stage(ops, "coleta"), _stage(ops, "entrega")
    return {
        "codembarque": str(cod),
        "codstatembarque": emb.get("codstatembarque"),
        "descrstatembarque": emb.get("descrstatembarque"),
        "dtahrstatembarque": _to_ts(emb.get("dtahrstatembarque")),
        "descrtpoper": emb.get("descrtpoper"),
        "temocorrencia": _to_bool(emb.get("temocorrencia")),
        "codmot1": emb.get("codmot1"),
        "mot1_nome": (emb.get("mot1_nome") or "").strip() or None,
        "codveic": emb.get("codveic"),
        "veic_id": emb.get("veic_id"),
        "placacarreta": emb.get("placacarreta"),
        "totnumvol": _to_num(emb.get("totnumvol")),
        "totpeso": _to_num(emb.get("totpeso")),
        "totvol": _to_num(emb.get("totvol")),
        "coleta_cidade": col.get("cidade"),
        "coleta_dtahrprevini": col.get("previni"),
        "coleta_dtahrchegada": col.get("chegada"),
        "coleta_dtahrfim": col.get("fim"),
        "entrega_cidade": ent.get("cidade"),
        "entrega_dtahrprevini": ent.get("previni"),
        "entrega_dtahrchegada": ent.get("chegada"),
        "entrega_dtahrfim": ent.get("fim"),
        "atualizado_em": datetime.now(_BRT).isoformat(),
    }


def _codembarques_pendentes(db) -> list[str]:
    """codembarque das ofertas aceitas que ainda NÃO estão FINALIZADAS em nestle_embarques
    (idempotência: não re-busca viagens já concluídas). Pagina (teto de 1000 do Supabase)."""
    # 1) ofertas com codembarque
    ofertas = set()
    offset = 0
    while True:
        res = db.table("nestle_ofertas").select("codembarque").neq("codembarque", None).range(offset, offset + 999).execute()
        bloco = res.data or []
        for r in bloco:
            if r.get("codembarque"):
                ofertas.add(str(r["codembarque"]).strip())
        if len(bloco) < 1000:
            break
        offset += 1000
    # 2) embarques já finalizados
    finalizados = set()
    offset = 0
    while True:
        res = db.table("nestle_embarques").select("codembarque").eq("descrstatembarque", "FINALIZADO").range(offset, offset + 999).execute()
        bloco = res.data or []
        for r in bloco:
            finalizados.add(str(r["codembarque"]).strip())
        if len(bloco) < 1000:
            break
        offset += 1000
    return sorted(ofertas - finalizados)


def executar():
    print("[INFO] Robô Embarques (Lamônica) iniciado")
    db = get_client()
    try:
        cods = _codembarques_pendentes(db)
    except Exception as e:
        registrar_log("ERROR", f"Robô Embarques — falha ao listar codembarque: {e}")
        return
    print(f">> {len(cods)} embarque(s) a enriquecer (não-finalizados)")
    if not cods:
        registrar_log("INFO", "Robô Embarques — nada a atualizar.")
        return

    get_token()
    rows, erros = [], []

    def _um(cod):
        try:
            return _mapear(cod, buscar_detalhe(cod))
        except Exception as e:
            return {"_erro": f"[{cod}] {e}"}

    with ThreadPoolExecutor(max_workers=6) as ex:
        for fut in as_completed({ex.submit(_um, c): c for c in cods}):
            r = fut.result()
            if r.get("_erro"):
                erros.append(r["_erro"])
            else:
                rows.append(r)

    if rows:
        LOTE = 50
        total = 0
        for i in range(0, len(rows), LOTE):
            lote = rows[i:i + LOTE]
            try:
                db.table("nestle_embarques").upsert(lote, on_conflict="codembarque", ignore_duplicates=False).execute()
                total += len(lote)
            except Exception as e:
                erros.append(f"upsert lote {i // LOTE + 1}: {e}")
        print(f"[INFO] {total} embarque(s) atualizado(s)")

    if erros:
        registrar_log("ERROR", f"Robô Embarques — erros: {' | '.join(erros[:10])}")
    else:
        registrar_log("INFO", f"Robô Embarques — {len(rows)} embarque(s) atualizado(s).")


if __name__ == "__main__":
    executar()
