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
from nestle.change_guard import UpsertMirror

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

# ── Guarda anti no-op do upsert (perf: WAL/bloat/egresso) ─────────────────────
# As colunas comparadas são EXATAMENTE as 41 que `_mapear` escreve
# (CAMPOS_TEXT ∪ CAMPOS_TIMESTAMP ∪ CAMPOS_NUMERIC ∪ CAMPOS_BOOL ∪ {tipo}).
# ACOPLAMENTO: se `_mapear` ganhar/perder coluna, atualize esta lista — coluna escrita
# e não comparada CONGELA na tela Programação. `created_at`/`atualizado_em` ficam de
# fora de propósito: o coletor não os escreve (se entrassem, o espelho nunca casaria e
# a guarda viraria no-op). Os CAMPOS_TIMESTAMP são `text` no schema (ISO naive, BRT).
_ESPELHO = UpsertMirror(
    tabela="nestle_ofertas",
    chave="codprogcoleta",
    colunas_texto=CAMPOS_TEXT | CAMPOS_TIMESTAMP | {"tipo"},
    colunas_numericas=CAMPOS_NUMERIC,
    colunas_bool=CAMPOS_BOOL,
    colunas_projetadas=("codembarque",),
    ttl_env="NESTLE_OFERTAS_SNAPSHOT_TTL_SEC",
)


def codembarques_conhecidos() -> set[str] | None:
    """codembarque presentes em `nestle_ofertas`, servidos do espelho (snapshot da
    tabela INTEIRA + o que este processo gravou) — é o MESMO conjunto que
    `robo_embarques._codembarques_pendentes` obtinha varrendo a tabela toda, sem filtro
    de status, e por construção um superconjunto dele (nada é deletado da tabela).

    NÃO derivar de `rows`: `rows` é pós-filtro de `finalizados`, e 'EMBARQUE EMITIDO'
    (que está em STATUS_FINAIS) é justamente o ponto do ciclo de vida em que o
    codembarque existe — o conjunto colapsaria e a Programação perderia
    motorista/placa/status/entrega das viagens aceitas.

    Retorna None quando o espelho não foi semeado por snapshot (ou a guarda está
    desligada); nesse caso o chamador volta a varrer o banco.
    """
    return _ESPELHO.valores_projetados("codembarque")


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
    """Coleta as programações do Galileo e grava as que MUDARAM em nestle_ofertas.

    Retorna o conjunto de codembarque conhecidos (ou None) para a etapa de embarques
    reaproveitar — ver `codembarques_conhecidos`.
    """
    erros_msgs = []

    # ── Autenticação + busca ──
    print(">> Autenticando e buscando programações...")
    try:
        programacoes = listar_programacoes(limit=1500, apenas_pendentes=False)
    except Exception as e:
        registrar_log("ERROR", f"Robô Coleta — falha ao listar programações: {e}")
        return codembarques_conhecidos()

    # ── Carrega codprogcoleta já em status final no Supabase (não atualizar) ──
    # NOTA: este select segue SEM paginação de propósito. Paginá-lo aumentaria o
    # conjunto `finalizados` e CONGELARIA permanentemente linhas 'EMBARQUE EMITIDO',
    # que é status VIVO na tela Programação (get-programacao.js: NESTLE_OFERTA_ACEITA,
    # aba "aceito", podeLancar) e cujas docas (dtahrprevatual/dtahrpreventrega) a Nestlé
    # ainda remarca. Quem elimina a reescrita redundante agora é a guarda de conteúdo
    # abaixo, sem congelar nada.
    STATUS_FINAIS = {"RECUSA LEILAO", "CANCELADO", "DECLINADA", "EMBARQUE EMITIDO", "EXPIRADA"}
    try:
        res = get_client().table("nestle_ofertas").select("codprogcoleta").in_(
            "descrstatprogcoleta", list(STATUS_FINAIS)
        ).execute()
        finalizados = {r["codprogcoleta"] for r in (res.data or [])}
    except Exception as e:
        erros_msgs.append(f"falha ao carregar finalizados: {e}")
        finalizados = set()

    # ── Espelho do estado atual da tabela (guarda anti no-op) ──
    try:
        _ESPELHO.sincronizar(get_client())
    except Exception as e:
        # Nunca cacheia erro: mantém o espelho anterior e tenta de novo no próximo
        # ciclo. Sem espelho a guarda simplesmente grava tudo (comportamento original).
        erros_msgs.append(f"falha ao espelhar nestle_ofertas: {e}")

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

    # A API pode devolver a mesma programação 2x; duplicata dentro do mesmo
    # lote quebra o upsert inteiro (Postgres 21000). Mantém a última ocorrência.
    rows = list({r["codprogcoleta"]: r for r in rows}.values())

    if not rows:
        print("[INFO] Nenhuma oferta mapeada para registrar")
        if erros_msgs:
            registrar_log("ERROR", f"Robô Coleta — erros: {' | '.join(erros_msgs)}")
        else:
            registrar_log("INFO", "Robô Coleta — tudo funcionando perfeitamente.")
        return codembarques_conhecidos()

    # ── Guarda anti no-op: só vai ao banco o que é novo ou realmente mudou ──
    envio = _ESPELHO.selecionar_mudancas(rows)
    inalteradas = len(rows) - len(envio)
    print(f">> {len(rows)} ofertas mapeadas ({inalteradas} inalteradas, {len(envio)} a gravar). Enviando para Supabase...")

    # ── Upsert em lotes de 100 para evitar timeout ──
    LOTE = 100
    total_enviado = 0
    for i in range(0, len(envio), LOTE):
        lote = envio[i:i + LOTE]
        try:
            get_client().table("nestle_ofertas").upsert(
                lote,
                on_conflict="codprogcoleta",
                ignore_duplicates=False,
            ).execute()
            total_enviado += len(lote)
            # Espelha só o que o banco aceitou.
            _ESPELHO.confirmar(lote)
            print(f"   Lote {i // LOTE + 1}: {total_enviado}/{len(envio)} registros enviados")
        except Exception as e:
            # Lote perdido sai do espelho → reenviado no próximo ciclo.
            _ESPELHO.descartar(lote)
            erros_msgs.append(f"upsert lote {i // LOTE + 1}: {e}")

    print(f"[INFO] Coleta finalizada — {total_enviado} oferta(s) salvas/atualizadas ({inalteradas} inalteradas)")

    if erros_msgs:
        registrar_log("ERROR", f"Robô Coleta — erros: {' | '.join(erros_msgs)}")
    else:
        registrar_log("INFO", "Robô Coleta — tudo funcionando perfeitamente.")

    return codembarques_conhecidos()


if __name__ == "__main__":
    executar()
