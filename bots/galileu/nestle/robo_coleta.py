"""
Robô Nestlé — Coleta de Ofertas (adaptado do Projeto Galileu para o Cargas Lamônica)
Execução: python run_coleta.py

Busca todas as programações do Galileo e faz upsert em nestle_ofertas do banco do
Lamônica (via nestle/supabase_client.get_client → NESTLE_SUPABASE_*). Lógica idêntica
ao original; muda apenas o Supabase de destino.
"""

from nestle.galileu_client import listar_programacoes
from nestle.supabase_client import registrar_log, get_client
from nestle.classificador import classificar

CAMPOS_TIMESTAMP = {
    "dtahrincl", "dtahrprevatual", "dtahrpreventrega", "dtahraceite",
    "dtahrrecusa", "dtahrcancelado", "dtaremessa", "dtahragendamento",
    "dtahrlimiteaceite",
}

CAMPOS_NUMERIC = {
    "totalcarga", "totalnumvol", "totalpeso", "totalvol", "totalnumpalete",
}

CAMPOS_BOOL = {
    "leilao", "broadcast", "pode_aceitar", "pode_recusar", "pode_cancelar",
    "pode_alterar_data", "pode_alterar_data_entrega",
}

CAMPOS_TEXT = {
    "codprogcoleta", "codembarque", "codcarga", "grupos_id", "descrstatprogcoleta",
    "empembar_nome", "empembar_nomeciduf", "tpveic_nome", "tpcarga_descr", "descrtpoper",
    "empdest_nome", "empdest_nomeciduf", "emporig_nomecid", "emporig_uf", "emporig_nomeciduf",
    "empdest_nomecid", "empdest_uf", "senhaagendamento", "numciot",
}


def _log(nivel: str, mensagem: str, detalhes: dict | None = None):
    print(f"[{nivel}] {mensagem}")
    try:
        registrar_log(nivel, mensagem, detalhes)
    except Exception as e:
        print(f"  [WARN] Falha ao gravar log no Supabase: {e}")


def _to_bool(val) -> bool | None:
    if val is None:
        return None
    return str(val).lower().strip() == "t"


def _to_numeric(val):
    if val is None or str(val).strip() == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _to_timestamp(val) -> str | None:
    if val is None or str(val).strip() == "":
        return None
    s = str(val).strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            from datetime import datetime
            dt = datetime.strptime(s, fmt)
            return dt.isoformat()
        except ValueError:
            continue
    return s  # fallback: passa como string se não reconhecer


def _mapear(carga: dict) -> dict:
    row = {}
    for campo in CAMPOS_TEXT:
        v = carga.get(campo)
        row[campo] = str(v).strip() if v not in (None, "") else None
    for campo in CAMPOS_TIMESTAMP:
        row[campo] = _to_timestamp(carga.get(campo))
    for campo in CAMPOS_NUMERIC:
        row[campo] = _to_numeric(carga.get(campo))
    for campo in CAMPOS_BOOL:
        row[campo] = _to_bool(carga.get(campo))
    row["tipo"] = classificar(carga)
    return row


def executar():
    erros_msgs = []

    # ── Autenticação + busca ──
    print(">> Autenticando e buscando programações...")
    try:
        programacoes = listar_programacoes(limit=1500, apenas_pendentes=False)
    except Exception as e:
        registrar_log("ERROR", f"Robô Coleta — falha ao listar programações: {e}")
        return

    # ── Carrega codprogcoleta já em status final no Supabase (não atualizar) ──
    STATUS_FINAIS = {"RECUSA LEILAO", "CANCELADO", "DECLINADA", "EMBARQUE EMITIDO", "EXPIRADA"}
    try:
        res = get_client().table("nestle_ofertas").select("codprogcoleta").in_(
            "descrstatprogcoleta", list(STATUS_FINAIS)
        ).execute()
        finalizados = {r["codprogcoleta"] for r in (res.data or [])}
    except Exception as e:
        erros_msgs.append(f"falha ao carregar finalizados: {e}")
        finalizados = set()

    # ── Mapeamento ──
    print(">> Mapeando campos...")
    rows = []
    puladas = 0
    for c in programacoes:
        cod = str(c.get("codprogcoleta", "")).strip()
        if not cod:
            continue
        if cod in finalizados:
            puladas += 1
            continue
        try:
            rows.append(_mapear(c))
        except Exception as e:
            erros_msgs.append(f"[{cod}] erro ao mapear: {e}")

    if not rows:
        print("[INFO] Nenhuma oferta mapeada para registrar")
        if erros_msgs:
            registrar_log("ERROR", f"Robô Coleta — erros: {' | '.join(erros_msgs)}")
        else:
            registrar_log("INFO", "Robô Coleta — tudo funcionando perfeitamente.")
        return

    print(f">> {len(rows)} ofertas mapeadas. Enviando para Supabase...")

    # ── Upsert em lotes de 100 para evitar timeout ──
    LOTE = 100
    total_enviado = 0
    for i in range(0, len(rows), LOTE):
        lote = rows[i:i + LOTE]
        try:
            get_client().table("nestle_ofertas").upsert(
                lote,
                on_conflict="codprogcoleta",
                ignore_duplicates=False,
            ).execute()
            total_enviado += len(lote)
            print(f"   Lote {i // LOTE + 1}: {total_enviado}/{len(rows)} registros enviados")
        except Exception as e:
            erros_msgs.append(f"upsert lote {i // LOTE + 1}: {e}")

    print(f"[INFO] Coleta finalizada — {total_enviado} oferta(s) salvas/atualizadas")

    if erros_msgs:
        registrar_log("ERROR", f"Robô Coleta — erros: {' | '.join(erros_msgs)}")
    else:
        registrar_log("INFO", "Robô Coleta — tudo funcionando perfeitamente.")


if __name__ == "__main__":
    executar()
