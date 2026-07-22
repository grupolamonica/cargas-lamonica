import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { buildAuditChanges } from "../../../domain/operator-admin/audit-diff.js";
import { NotFoundError } from "../../../domain/load-claims/errors.js";
import { writeAllocationsToSheet } from "../../google-sheets/sheet-writeback.js";
import { cancelLoadCascade } from "./cancel-load-cascade.js";
import { cancelPublicLoadLead } from "../../load-claims/public-leads.js";
import { ensureMonitorSheetCargo } from "./_shared.js";

/**
 * Grava a ALOCAÇÃO editada no Monitor (motorista/cavalo/carreta/status operacional)
 * nas colunas `alloc_*` da carga — a "decisão" do operador, dona do sistema.
 *
 * Resolve a carga pelo id determinístico da planilha (createSheetLoadId(lh)),
 * trava com FOR UPDATE (mesma garantia de writeCargo) e escreve SOMENTE `alloc_*`
 * + metadados. O sync da planilha NUNCA toca `alloc_*`, então a edição do
 * operador nunca é sobrescrita. Leitura efetiva = COALESCE(alloc_*, sheet_*).
 *
 * Normalização: "" = vazio EXPLÍCITO → grava "" em alloc_* (NÃO null). Assim
 * COALESCE(alloc_*, sheet_*) devolve "" e a carga fica realmente sem
 * motorista/veículo, em vez de "voltar a refletir a planilha" (o que
 * ressuscitava o valor antigo ao limpar). Mesma semântica do arrastar
 * (reassign-monitor-allocations).
 *
 * @param {{ lh: string, operatorId: string, payload: object, requestIp?: string, correlationId?: string }} args
 * @returns {Promise<{ statusCode: number, payload: object }>}
 */
export async function updateMonitorAllocation({ lh, operatorId, payload, requestIp, correlationId }) {
  // Semântica de atualização PARCIAL:
  //  - campo AUSENTE no payload  → preserva o alloc_* atual (não mexe);
  //  - campo enviado como ""     → vazio EXPLÍCITO: grava "" (NÃO null);
  //  - campo enviado com valor   → define.
  // "" fica "" (não vira null) porque null = "sem override → COALESCE volta pra
  // planilha", que era exatamente o bug: limpar o campo ressuscitava o
  // motorista/veículo da planilha. Todos os consumidores tratam
  // COALESCE(alloc, sheet, '') = '' como "sem alocação", então "" é seguro.
  // Ausente ≠ vazio é essencial: o cancelamento manda só `status`, e o
  // motorista/veículo precisam sobreviver p/ a cascata poder relocá-los.
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
  const norm = (value) => (value ?? "").toString().trim();

  const result = await withPgTransaction(async (client) => {
    // Resolve a carga por id da PLANILHA OU por lh_manual (carga do SISTEMA lançada
    // na Programação); e, quando a linha da planilha ainda NÃO tem carga no sistema
    // (viagem SPX que entrou já atribuída — o sync só cria carga p/ linha
    // disponível), MATERIALIZA a carga a partir do snapshot. Sem isso a edição/
    // limpeza de motorista/placa dessas linhas falhava com "Carga da planilha não
    // encontrada" (não havia onde gravar o override alloc_*).
    const sheetRow = await ensureMonitorSheetCargo(client, lh, {
      columns: `id, sheet_lh, sheet_source, sheet_motorista, sheet_cavalo, sheet_carreta, sheet_status,
                alloc_pinned, alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_tipo,
                alloc_descricao, alloc_vinculo, status, reserved_public_lead_id`,
    });

    if (!sheetRow) {
      throw new NotFoundError("Carga da planilha não encontrada para este LH.");
    }

    // Id REAL da carga resolvida (planilha OU sistema) — usado em todas as
    // escritas/consultas abaixo (não `createSheetLoadId(lh)`, que só bate na carga
    // da planilha).
    const cargoId = sheetRow.id;
    // Carga do SISTEMA (lançada na Programação): sheet_lh nulo. Nesse caso NÃO há
    // planilha por baixo (sheet_* são nulos) e o write-back para a planilha é
    // pulado — senão editar só o status escreveria "" e apagaria o motorista/placa
    // vivos da linha da planilha (que vêm do snapshot, não das colunas sheet_*).
    const isSystemCargo = sheetRow.sheet_lh == null;

    // Carga FIXA: motorista/veículo são intocáveis — preserva o que já está
    // alocado (ignora os valores recebidos) e deixa passar só o status operacional.
    // Campo ausente no payload também preserva o alloc_* atual; enviado "" =
    // vazio explícito; enviado com valor = define.
    const pinned = sheetRow.alloc_pinned === true;
    // Campo ENVIADO pelo operador (e a carga não é fixa) = decisão deliberada, inclusive
    // LIMPAR ("" explícito → "remover de vez"): o efetivo e o write-back NÃO caem de volta
    // pro valor da planilha (senão o motorista da planilha ressuscitava e não saía).
    // Editar só o status (motorista AUSENTE no payload) preserva o valor da planilha.
    // NOTA: o modal (AllocEditDialog) só manda motorista/veículo quando o operador trocou
    // (allocEditable && mvChanged); já o editor INLINE sempre reenvia os campos. Isso é
    // seguro porque ambos vêm PRÉ-PREENCHIDOS com o valor EFETIVO exibido (alloc||planilha),
    // então reenviar reafirma o valor atual e "" só chega quando o operador esvaziou de fato.
    const explicit = (k) => has(k) && !pinned;
    const finalMotorista = pinned || !has("motorista") ? (sheetRow.alloc_motorista ?? null) : norm(payload.motorista);
    const finalCavalo = pinned || !has("cavalo") ? (sheetRow.alloc_cavalo ?? null) : norm(payload.cavalo);
    const finalCarreta = pinned || !has("carreta") ? (sheetRow.alloc_carreta ?? null) : norm(payload.carreta);
    // "Disponível" é a AÇÃO DE REABRIR, não um status operacional armazenável:
    // normaliza para "" (sem status). O badge "Disponivel" da linha vem da
    // derivação de disponibilidade (openLhSet: OPEN + pública + futura + sem
    // motorista), não de um literal em alloc_status. Sem isso o literal
    // "Disponível" ficava preso em alloc_status e a carga aparecia azul
    // "Disponivel" mesmo continuando BOOKED e com motorista (enganoso).
    const wantsAvailable = has("status") && /^dispon[ií]vel$/i.test(norm(payload.status));
    const finalStatus = has("status") ? (wantsAvailable ? "" : norm(payload.status)) : (sheetRow.alloc_status ?? null);
    const finalTipo = has("tipo") ? norm(payload.tipo) : (sheetRow.alloc_tipo ?? null);
    // Motivo da troca (modal "Confirmar troca"): ausente preserva o último motivo.
    const finalDescricao = has("descricao") ? norm(payload.descricao) : (sheetRow.alloc_descricao ?? null);
    // Vínculo (col H da planilha): override do operador. Ausente preserva; ""=limpa.
    const finalVinculo = has("vinculo") ? norm(payload.vinculo) : (sheetRow.alloc_vinculo ?? null);

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_motorista = $2,
            alloc_cavalo = $3,
            alloc_carreta = $4,
            alloc_status = $5,
            alloc_tipo = $7,
            alloc_descricao = $8,
            alloc_vinculo = $9,
            alloc_source = 'operator',
            alloc_updated_at = now(),
            alloc_updated_by = $6,
            updated_at = now()
        WHERE id = $1
      `,
      [cargoId, finalMotorista, finalCavalo, finalCarreta, finalStatus, operatorId, finalTipo, finalDescricao, finalVinculo],
    );

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.allocation_updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        lh,
        motorista: finalMotorista,
        cavalo: finalCavalo,
        carreta: finalCarreta,
        status: finalStatus,
        descricao: finalDescricao,
        pinned,
        cleared: !finalMotorista && !finalCavalo && !finalCarreta && !finalStatus,
        // DC-184: antes → depois. SEM cavalo/carreta (placas = sensível "plate"
        // no sanitizeLogPayload; as chaves genéricas before/after não são
        // redigidas e vazariam no CSV do DC-186).
        changes: buildAuditChanges(
          {
            motorista: sheetRow.alloc_motorista,
            status: sheetRow.alloc_status,
            tipo: sheetRow.alloc_tipo,
            vinculo: sheetRow.alloc_vinculo,
          },
          { motorista: finalMotorista, status: finalStatus, tipo: finalTipo, vinculo: finalVinculo },
          [
            { key: "motorista", label: "Motorista" },
            { key: "status", label: "Status" },
            { key: "tipo", label: "Tipo" },
            { key: "vinculo", label: "Vínculo" },
          ],
        ),
      },
    });

    // Motorista alocado numa carga NORMAL deixa de estar "em reserva": baixa as
    // reservas ativas desse motorista (senão aparece na carga E no standby). Não
    // baixa em cancelamento — aí quem move é a cascata.
    // Motorista EFETIVO = override real (alloc) OU planilha (`||`): um override
    // vazio ("") cai pra planilha. Assim NÃO reabrimos (status→OPEN) uma carga que
    // a planilha ainda escala — senão o portal ofereceria uma carga com motorista
    // vivo na planilha (duplo-booking). Só reabre quando não há motorista em lugar
    // nenhum (nem override, nem planilha).
    const effMotorista = (explicit("motorista") ? finalMotorista : (finalMotorista || sheetRow.sheet_motorista) || "").toString().trim();
    const cancelling = Boolean(finalStatus) && /cancel/i.test(finalStatus);
    // Status "Disponível" numa carga SEM motorista = reabrir pro painel do
    // motorista (volta pra fila do portal). Só quando não há motorista efetivo.
    const reopening = wantsAvailable && !effMotorista;
    if (effMotorista && !cancelling) {
      await client.query(
        `UPDATE public.monitor_reservas SET active = false, updated_at = now()
         WHERE active = true AND motorista = $1`,
        [effMotorista],
      );
    }

    // Limpou o motorista de uma carga RESERVADA (o motorista havia reservado pelo
    // portal): a reserva cai e a carga tem de voltar a ficar ABERTA pro motorista.
    // Resolvido FORA da transação (cancelPublicLoadLead abre a própria e trava a
    // mesma linha) — aqui só sinalizamos o lead a cancelar.
    const reopenLeadId =
      !effMotorista && !cancelling &&
      sheetRow.status === "RESERVED" && sheetRow.reserved_public_lead_id
        ? sheetRow.reserved_public_lead_id
        : null;

    // Reabrir a carga NÃO-reservada quando o operador marca "Disponível" sem
    // motorista: força cargas.status = OPEN → a carga volta pro painel do
    // motorista (mesmo gate do portal: OPEN + pública + futura + sem motorista).
    // A carga RESERVADA é reaberta pelo cancelPublicLoadLead (via reopenLeadId),
    // que também baixa o lead do portal — evita duplo-booking, então aqui só
    // tocamos as não-reservadas.
    if (reopening && !reopenLeadId) {
      await client.query(`UPDATE public.cargas SET status = 'OPEN', updated_at = now() WHERE id = $1`, [cargoId]);
    }

    return {
      statusCode: 200,
      payload: {
        ok: true,
        lh,
        allocation: { motorista: finalMotorista, cavalo: finalCavalo, carreta: finalCarreta, status: finalStatus, source: "operator" },
        meta: { correlationId },
      },
      resolvedStatus: finalStatus,
      reopenLeadId,
      // Id resolvido (planilha OU sistema) + flag de carga do sistema — usados
      // fora da transação (write-back e reabertura de reserva).
      cargoId,
      isSystemCargo,
      // Valor EFETIVO espelhado na planilha (write-back). Motorista/veículo usam
      // `||`: um override VAZIO ("" ou null) cai pro valor da planilha em vez de
      // LIMPAR a célula — assim editar só o status de uma carga (override de
      // motorista vazio) não apaga o motorista vivo da planilha. Para esvaziar de
      // verdade um motorista, o caminho é a planilha/cancelamento (a cascata tem
      // seu próprio write-back que limpa a célula da carga cancelada).
      effective: {
        // Roteia o write-back pra planilha da fonte certa (shopee vs nestle).
        source: sheetRow.sheet_source ?? null,
        // Enviado explicitamente → espelha o valor do operador (inclusive "" = limpa a
        // célula, "remover de vez"). Ausente (editou só status) → cai pro valor da
        // planilha (`||`) p/ NÃO apagar o motorista vivo da planilha sem querer.
        motorista: explicit("motorista") ? (finalMotorista ?? "") : (finalMotorista || sheetRow.sheet_motorista || ""),
        cavalo: explicit("cavalo") ? (finalCavalo ?? "") : (finalCavalo || sheetRow.sheet_cavalo || ""),
        carreta: explicit("carreta") ? (finalCarreta ?? "") : (finalCarreta || sheetRow.sheet_carreta || ""),
        // Status (col L): finalStatus é sempre o status enviado pelo modal ("" p/
        // Disponível/limpar a etapa) — espelha direto.
        status: finalStatus ?? sheetRow.sheet_status ?? "",
        // Vínculo (col H) só espelha quando o modal envia o campo (senão o robô
        // não toca H — evita apagar o vínculo de linhas não editadas).
        ...(has("vinculo") ? { vinculo: finalVinculo ?? "" } : {}),
      },
    };
  });

  // Cancelou no Monitor (status → CANCELADO) → dispara a cascata da rota: o
  // motorista desce a fila (Interpretação A) e o último sem carga vira reserva.
  const willCascade = Boolean(result.resolvedStatus) && /cancel/i.test(result.resolvedStatus);

  // Write-back best-effort pra planilha (espelho) — FORA da transação e SEM
  // await. Quando vai cascatear, o write-back fica por conta da cascata (que
  // sabe os valores relocados) — evita gravar o valor antigo e depois corrigir.
  // Carga do SISTEMA (lh_manual, sem sheet_lh) NÃO tem linha própria na planilha
  // para espelhar — pular evita escrever "" e apagar o motorista/placa vivos da
  // linha da planilha homônima (o operador enxerga o snapshot, não sheet_*).
  if (!willCascade && !result.isSystemCargo) {
    void writeAllocationsToSheet([{ lh, ...result.effective }]).catch(() => {});
  }

  let cascadeMovedLhs = [];
  // Carga do SISTEMA (lh_manual) não participa da cascata da rota: a fila de rota
  // (cancelLoadCascade) só considera cargas da planilha (sheet_lh IS NOT NULL) e
  // resolve o gatilho por createSheetLoadId(lh), que não existe p/ carga lançada —
  // rodá-la só produziria um NotFound engolido (falso alarme no log). Pula.
  if (willCascade && !result.isSystemCargo) {
    // Best-effort: a edição de status já está commitada; se a cascata falhar, o
    // sweep do próximo sync recupera (cancelLoadCascade é idempotente).
    try {
      const cascade = await cancelLoadCascade({ lh, operatorId, requestIp, correlationId });
      cascadeMovedLhs = cascade.movedLhs ?? [];
    } catch (cascadeErr) {
      console.warn(
        `[update-monitor-allocation] cascata de cancelamento falhou para ${lh}:`,
        cascadeErr instanceof Error ? cascadeErr.message : cascadeErr,
      );
    }
  }

  // Reabrir carga reservada: o operador limpou o motorista → cancela o lead do
  // portal (APPROVED → CANCELLED) e a carga volta a OPEN (cancelPublicLoadLead
  // zera reserved_* e faz status→OPEN). Best-effort: a limpeza já está commitada;
  // se falhar, a carga fica RESERVED sem motorista até o operador tentar de novo.
  if (result.reopenLeadId) {
    try {
      await cancelPublicLoadLead({ loadId: result.cargoId, leadId: result.reopenLeadId, operatorId, correlationId });
    } catch (reopenErr) {
      console.warn(
        `[update-monitor-allocation] reabrir carga reservada falhou para ${lh}:`,
        reopenErr instanceof Error ? reopenErr.message : reopenErr,
      );
    }
  }

  // movedLhs: o lh editado já é re-enriquecido pelo handler; aqui devolvemos as
  // linhas que a cascata realocou p/ o handler re-enriquecer também (fan-out).
  return { statusCode: result.statusCode, payload: result.payload, movedLhs: cascadeMovedLhs };
}
