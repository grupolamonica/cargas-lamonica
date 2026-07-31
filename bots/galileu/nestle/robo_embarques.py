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
from nestle.change_guard import UpsertMirror

_BRT = timezone(timedelta(hours=-3))

# ── Guarda anti no-op do upsert (perf: WAL/bloat/egresso) ─────────────────────
# Colunas comparadas = as 22 que `_mapear` escreve MENOS `atualizado_em`.
# `atualizado_em` FICA DE FORA da comparação (é `now()` a cada ciclo — dentro da
# comparação, toda linha pareceria mudada e a guarda seria no-op) mas CONTINUA sendo
# gravada nas linhas que realmente mudam. Ninguém lê essa coluna: a Programação usa
# só mot1_nome / placacarreta / descrstatembarque / entrega_dtahrfim
# (get-programacao.js). `idcargas` não está no payload e segue intacto — o upsert do
# PostgREST só faz DO UPDATE das chaves enviadas.
# ACOPLAMENTO: mexeu em `_mapear`, mexa aqui.
_ESPELHO = UpsertMirror(
    tabela="nestle_embarques",
    chave="codembarque",
    colunas_texto=(
        "codembarque", "codstatembarque", "descrstatembarque", "dtahrstatembarque",
        "descrtpoper", "codmot1", "mot1_nome", "codveic", "veic_id", "placacarreta",
        "coleta_cidade", "coleta_dtahrprevini", "coleta_dtahrchegada", "coleta_dtahrfim",
        "entrega_cidade", "entrega_dtahrprevini", "entrega_dtahrchegada", "entrega_dtahrfim",
    ),
    colunas_numericas=("totnumvol", "totpeso", "totvol"),
    colunas_bool=("temocorrencia",),
    ttl_env="NESTLE_EMBARQUES_SNAPSHOT_TTL_SEC",
)


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


def _codembarques_pendentes(db, ofertas_codembarques: set[str] | None = None) -> list[str]:
    """codembarque das ofertas que ainda NÃO estão FINALIZADAS em nestle_embarques
    (idempotência: não re-busca viagens já concluídas). Pagina (teto de 1000 do Supabase).

    ATENÇÃO ao docstring antigo ("ofertas aceitas"): não há filtro de status aqui — o
    conjunto é TODA oferta com codembarque, inclusive cancelada/recusada. Mantido.

    `ofertas_codembarques` (perf) vem do espelho de `robo_coleta` — um snapshot da
    tabela nestle_ofertas INTEIRA, portanto o mesmo conjunto que a varredura do passo
    (1) devolveria. Quando é None (cold start, snapshot falhou, guarda desligada) a
    varredura acontece normalmente.
    """
    # 1) ofertas com codembarque
    if ofertas_codembarques is not None:
        ofertas = {str(c).strip() for c in ofertas_codembarques if c not in (None, "")}
    else:
        ofertas = set()
        offset = 0
        while True:
            # .order(codprogcoleta): sem ORDER BY a paginação pode pular/duplicar
            # linhas enquanto o próprio coletor escreve na tabela.
            res = db.table("nestle_ofertas").select("codembarque").neq("codembarque", None).order("codprogcoleta").range(offset, offset + 999).execute()
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
        res = db.table("nestle_embarques").select("codembarque").eq("descrstatembarque", "FINALIZADO").order("codembarque").range(offset, offset + 999).execute()
        bloco = res.data or []
        for r in bloco:
            finalizados.add(str(r["codembarque"]).strip())
        if len(bloco) < 1000:
            break
        offset += 1000
    return sorted(ofertas - finalizados)


def executar(ofertas_codembarques: set[str] | None = None):
    print("[INFO] Robô Embarques (Lamônica) iniciado")
    db = get_client()
    try:
        cods = _codembarques_pendentes(db, ofertas_codembarques)
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

    # Duplicata de codembarque no mesmo lote quebra o upsert inteiro
    # (Postgres 21000). Mantém a última ocorrência.
    rows = list({r["codembarque"]: r for r in rows}.values())

    if rows:
        # ── Espelho + guarda anti no-op: só grava o que mudou de verdade ──
        try:
            _ESPELHO.sincronizar(db)
        except Exception as e:
            # Nunca cacheia erro: mantém o espelho anterior; sem espelho grava tudo.
            erros.append(f"falha ao espelhar nestle_embarques: {e}")
        envio = _ESPELHO.selecionar_mudancas(rows)
        inalterados = len(rows) - len(envio)
        LOTE = 50
        total = 0
        for i in range(0, len(envio), LOTE):
            lote = envio[i:i + LOTE]
            try:
                db.table("nestle_embarques").upsert(lote, on_conflict="codembarque", ignore_duplicates=False).execute()
                total += len(lote)
                _ESPELHO.confirmar(lote)  # só o que o banco aceitou
            except Exception as e:
                _ESPELHO.descartar(lote)  # reenviado no próximo ciclo
                erros.append(f"upsert lote {i // LOTE + 1}: {e}")
        print(f"[INFO] {total} embarque(s) atualizado(s) ({inalterados} inalterado(s))")

    if erros:
        registrar_log("ERROR", f"Robô Embarques — erros: {' | '.join(erros[:10])}")
    else:
        registrar_log("INFO", f"Robô Embarques — {len(rows)} embarque(s) atualizado(s).")


if __name__ == "__main__":
    executar()
