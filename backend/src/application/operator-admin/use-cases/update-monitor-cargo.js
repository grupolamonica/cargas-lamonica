import { withPgTransaction } from "../../../infrastructure/pg/postgres.js";
import { insertSecurityAuditEvent } from "../../../infrastructure/security-audit.js";
import { buildAuditChanges } from "../../../domain/operator-admin/audit-diff.js";
import { ConflictError, NotFoundError, ValidationError } from "../../../domain/load-claims/errors.js";
import { syncedCarregamentoLabel } from "../../../domain/cargo-schedule.js";
import { cancelPublicLoadLead } from "../../load-claims/public-leads.js";
import { reconcileMonitorLoadStatus } from "./reconcile-monitor-load-status.js";
import { writeAllocationsToSheet, formatSheetDateLabel } from "../../google-sheets/sheet-writeback.js";
import { describeConflicts, duplicateAllocWarnEnabled, findAllocationConflicts } from "./find-allocation-conflicts.js";
import { alocacaoDesatualizada, concurrentEditWarnEnabled, descreverAlteracaoConcorrente } from "./check-allocation-freshness.js";

// pg devolve DATE como Date (UTC-midnight) e TIME como string. Normaliza pro
// formato de parede 'YYYY-MM-DD' / 'HH:MM' (UTC, evita off-by-one).
function fmtDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}
function fmtTime(v) {
  if (!v) return null;
  return String(v).slice(0, 5);
}

// Descarga vem do front como datetime-local 'YYYY-MM-DDTHH:MM' (ou '' = limpar).
// Guarda em sheet_data_descarga como 'YYYY-MM-DD HH:MM' (texto, ordenável).
function normDescarga(v) {
  const t = (v ?? "").toString().trim();
  if (t === "") return null;
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : t;
}

/**
 * Edita uma carga do SISTEMA (sheet_lh nulo) direto no grid do Monitor, como se
 * fosse uma linha de planilha. Diferente das linhas da planilha (que só aceitam
 * override de motorista/veículo/status via alloc_*), a carga do sistema é a
 * fonte da verdade — então aqui gravamos:
 *   - motorista/cavalo/carreta + status OPERACIONAL → alloc_* (mesmas colunas
 *     que o Monitor exibe; para o sistema não há sheet_* por baixo);
 *   - Rota (origem/destino) e Agenda (data/horário) → colunas canônicas;
 *   - LH livre → lh_manual.
 * Não há sync sobrepondo essas colunas (o sync ignora sheet_lh nulo).
 *
 * Atualização PARCIAL: só os campos presentes no payload são tocados. Para os
 * alloc_*, "" → null (limpa). Carga FIXA (alloc_pinned) trava motorista/veículo.
 *
 * @param {{ cargoId: string, operatorId: string, payload: object, requestIp?: string, correlationId?: string }} args
 */
export async function updateMonitorCargo({ cargoId, operatorId, payload, requestIp, correlationId, knownSheetLhs = null }) {
  const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
  const normAlloc = (v) => {
    const t = (v ?? "").toString().trim();
    return t === "" ? null : t;
  };
  // Carimbo pós-gravação, devolvido ao front como baseline da próxima edição.
  let allocUpdatedAt = null;

  const result = await withPgTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, sheet_lh, alloc_pinned,
              alloc_motorista, alloc_cavalo, alloc_carreta, alloc_status, alloc_tipo, alloc_descricao, alloc_vinculo, alloc_tratativas,
              alloc_checklist_cavalo, alloc_checklist_carreta,
              origem, destino, data, horario, lh_manual, sheet_data_carregamento, sheet_data_descarga,
              status, reserved_public_lead_id, alloc_merged_into_cargo_id, retired_reason,
              alloc_updated_at, alloc_updated_by
       FROM public.cargas WHERE id = $1 FOR UPDATE`,
      [cargoId],
    );
    if (rows.length === 0) {
      throw new NotFoundError("Carga não encontrada.");
    }
    const row = rows[0];

    // Esta rota é só para cargas do sistema. Carga da planilha edita via
    // /api/operator/sheet-monitor (alloc_* por LH) — preserva cascata/pin/writeback.
    if (row.sheet_lh != null && String(row.sheet_lh).trim() !== "") {
      throw new ValidationError("Esta carga é da planilha; edite pela alocação do Monitor.");
    }

    // Carga MERGEADA (unificação da gêmea, TWIN_MERGE) ou APOSENTADA pelo sync: os
    // alloc_* dela já foram (ou nunca mais serão) a fonte da verdade — a carga viva é
    // a canônica da planilha, resolvida por LH via /api/operator/sheet-monitor. Sem
    // esta guarda, uma aba com este id ainda aberta (cargoId por parâmetro, sem
    // re-resolver por LH) gravaria 200 OK numa linha morta — já visto em produção após
    // uma aposentadoria (evento monitor_system_updated pós-twin_retired).
    if (row.alloc_merged_into_cargo_id != null || row.retired_reason != null) {
      throw new ConflictError(
        "Esta carga foi unificada com a linha da planilha; edite pela alocação do Monitor (LH).",
        { code: "CARGO_MERGED_OR_RETIRED" },
      );
    }

    // AVISO de edição SIMULTÂNEA (mesma regra do caminho por LH — ver
    // check-allocation-freshness.js): outra pessoa gravou aqui entre a leitura da tela
    // e agora? Checado antes de decidir campos, porque os valores pré-preenchidos no
    // formulário já são de um estado que deixou de existir.
    if (
      concurrentEditWarnEnabled() &&
      payload.confirmOverwrite !== true &&
      has("expectedAllocUpdatedAt") &&
      alocacaoDesatualizada({
        atualUpdatedAt: row.alloc_updated_at,
        esperadoUpdatedAt: payload.expectedAllocUpdatedAt,
      })
    ) {
      const info = await descreverAlteracaoConcorrente({ row });
      throw new ConflictError(info.mensagem, {
        code: "ALLOCATION_CHANGED",
        alteradoPor: info.alteradoPor,
        alteradoEm: info.alteradoEm,
        atual: info.atual,
        allocUpdatedAt: info.alteradoEm,
      });
    }

    const pinned = row.alloc_pinned === true;

    // alloc_* (motorista/veículo travam quando fixa; status operacional sempre livre)
    const allocMotorista = has("motorista") && !pinned ? normAlloc(payload.motorista) : row.alloc_motorista;
    const allocCavalo = has("cavalo") && !pinned ? normAlloc(payload.cavalo) : row.alloc_cavalo;
    const allocCarreta = has("carreta") && !pinned ? normAlloc(payload.carreta) : row.alloc_carreta;
    // "Disponível" = AÇÃO DE REABRIR, não um status operacional armazenável:
    // normaliza p/ null (sem status). O badge "Disponivel" vem da derivação
    // (OPEN + futura + sem motorista), não de um literal em alloc_status.
    //
    // COM motorista efetivo não é reabertura (seria duplo-booking) e o front já
    // barra: se chega assim — aba antiga, ou o valor pré-preenchido do select indo
    // junto num save de outro campo —, APAGARIA o status operacional e o overlay ao
    // vivo do SPX passaria a preencher a linha (viagem em CTE reaparecendo como
    // CARREGADO). Nesse caso trata como campo AUSENTE: preserva o alloc_status.
    const wantsAvailableRequested = has("status") && /^dispon[ií]vel$/i.test((payload.status ?? "").toString().trim());
    // Motorista EFETIVO após esta edição (a carga do sistema não tem sheet_* por baixo).
    const wantsAvailable = wantsAvailableRequested && String(allocMotorista ?? "").trim() === "";
    const availableIgnorado = wantsAvailableRequested && !wantsAvailable;
    const allocStatus = has("status") && !availableIgnorado
      ? (wantsAvailable ? null : normAlloc(payload.status))
      : row.alloc_status;
    const allocTipo = has("tipo") ? normAlloc(payload.tipo) : row.alloc_tipo;
    // Motivo da troca de motorista/veículo (modal "Confirmar troca"): ausente
    // preserva o último motivo.
    const allocDescricao = has("descricao") ? normAlloc(payload.descricao) : row.alloc_descricao;
    const allocVinculo = has("vinculo") ? normAlloc(payload.vinculo) : row.alloc_vinculo;
    // Observação de checklist (tratativas): nota livre do operador. Ausente preserva; "" limpa.
    const allocTratativas = has("tratativas") ? normAlloc(payload.tratativas) : row.alloc_tratativas;
    // Verdito manual do checklist por veículo ("Aprovado"/"Reprovado"). Ausente preserva; "" limpa.
    const allocChecklistCavalo = has("checklistCavalo") ? normAlloc(payload.checklistCavalo) : row.alloc_checklist_cavalo;
    const allocChecklistCarreta = has("checklistCarreta") ? normAlloc(payload.checklistCarreta) : row.alloc_checklist_carreta;

    // Motorista efetivo da carga do sistema = alloc_motorista (não há sheet_* por baixo).
    const effMotorista = (allocMotorista ?? "").toString().trim();
    // Reabrir quando o operador marca "Disponível" numa carga SEM motorista efetivo
    // (regra escolhida: só reabre se já estiver sem motorista — nunca remove o
    // motorista automaticamente). Força cargas.status = OPEN → volta pro painel.
    const reopening = wantsAvailable && !effMotorista;

    // Carga RESERVADA (o motorista reservou pelo portal): reabrir cancelando o lead
    // — quando o operador limpa o motorista OU marca "Disponível" sem motorista.
    // Resolvido FORA da transação (cancelPublicLoadLead abre a própria e trava a
    // mesma linha) — aqui só sinalizamos o lead a cancelar.
    const reopenLeadId =
      !pinned && !effMotorista &&
      ((has("motorista") && !allocMotorista) || reopening) &&
      row.status === "RESERVED" && row.reserved_public_lead_id
        ? row.reserved_public_lead_id
        : null;

    // canônicos (Rota/Agenda) — NOT NULL: só sobrescreve se vier valor válido
    const origem = has("origem") ? payload.origem : row.origem;
    const destino = has("destino") ? payload.destino : row.destino;
    const data = has("data") ? payload.data : row.data;
    const horario = has("horario") ? payload.horario : row.horario;
    const lhManual = has("lh") ? normAlloc(payload.lh) : row.lh_manual;

    // Código de viagem (lh_manual) ÚNICO: não pode colidir com o LH de OUTRA carga
    // — sheet_lh (planilha) ou lh_manual (outra carga do sistema) — nem com uma
    // viagem que só existe no snapshot da planilha (knownSheetLhs, montado pelo
    // handler). Sem isso a MESMA viagem aparecia duplicada no Monitor. Só valida
    // quando o LH MUDA p/ um valor novo (re-salvar o mesmo LH não bloqueia edição).
    if (has("lh") && lhManual && lhManual !== row.lh_manual) {
      const { rows: dup } = await client.query(
        `SELECT 1 FROM public.cargas WHERE id <> $1 AND (sheet_lh = $2 OR lh_manual = $2) LIMIT 1`,
        [cargoId, lhManual],
      );
      const inSnapshot = knownSheetLhs instanceof Set && knownSheetLhs.has(lhManual);
      if (dup.length > 0 || inSnapshot) {
        throw new ConflictError(
          `Já existe uma carga com o código de viagem "${lhManual}". Use um código diferente.`,
          { code: "DUPLICATE_TRIP_CODE" },
        );
      }
    }
    // Descarga (data+hora) → sheet_data_descarga (texto 'YYYY-MM-DD HH:MM').
    const descarga = has("descarga") ? normDescarga(payload.descarga) : row.sheet_data_descarga;
    // Rótulo denormalizado de carregamento: mantém em sincronia com data+horário
    // (só quando já preenchido — preserva NULL). Sem isso, editar a agenda no
    // Monitor deixava o campo velho e o painel de Cargas/Overview/detalhe do
    // motorista (que preferem esse rótulo) mostravam o horário antigo.
    const carregamento = syncedCarregamentoLabel(row.sheet_data_carregamento, data, horario);

    // AVISO de duplicidade (mesma regra do caminho por LH — ver
    // find-allocation-conflicts.js): motorista/placa entrando aqui já está em outra
    // carga do MESMO dia? Avisa e deixa confirmar; nunca bloqueia de vez. Só dispara
    // quando o valor MUDA para algo não-vazio, porque o modal reenvia os campos
    // pré-preenchidos e re-salvar a mesma alocação não é uma decisão nova.
    if (duplicateAllocWarnEnabled() && payload.confirmDuplicate !== true) {
      const antesMot = (row.alloc_motorista ?? "").toString().trim();
      const antesCav = (row.alloc_cavalo ?? "").toString().trim();
      const novoMot = (allocMotorista ?? "").toString().trim();
      const novoCav = (allocCavalo ?? "").toString().trim();
      const motMudou = novoMot !== "" && novoMot.toUpperCase() !== antesMot.toUpperCase();
      const cavMudou = novoCav !== "" && novoCav.toUpperCase() !== antesCav.toUpperCase();
      if (motMudou || cavMudou) {
        const conflitos = await findAllocationConflicts(client, {
          cargoId,
          lh: lhManual ?? row.lh_manual,
          data,
          motorista: motMudou ? novoMot : null,
          cavalo: cavMudou ? novoCav : null,
        });
        if (conflitos.length > 0) {
          throw new ConflictError(
            describeConflicts(conflitos, { motorista: novoMot, cavalo: novoCav }),
            { code: "DUPLICATE_ALLOCATION", conflitos },
          );
        }
      }
    }

    const touchesAlloc = has("motorista") || has("cavalo") || has("carreta") || has("status") || has("tipo");

    await client.query(
      `
        UPDATE public.cargas
        SET alloc_motorista = $2,
            alloc_cavalo = $3,
            alloc_carreta = $4,
            alloc_status = $5,
            alloc_tipo = $14,
            alloc_descricao = $16,
            alloc_vinculo = $17,
            alloc_tratativas = $18,
            alloc_checklist_cavalo = $19,
            alloc_checklist_carreta = $20,
            origem = $6,
            destino = $7,
            data = $8,
            horario = $9,
            lh_manual = $10,
            sheet_data_descarga = $13,
            sheet_data_carregamento = $15,
            alloc_source = CASE WHEN $11 THEN 'operator' ELSE alloc_source END,
            alloc_updated_at = CASE WHEN $11 THEN now() ELSE alloc_updated_at END,
            alloc_updated_by = CASE WHEN $11 THEN $12 ELSE alloc_updated_by END,
            updated_at = now()
        WHERE id = $1
        RETURNING alloc_updated_at
      `,
      [cargoId, allocMotorista, allocCavalo, allocCarreta, allocStatus, origem, destino, data, horario, lhManual, touchesAlloc, operatorId, descarga, allocTipo, carregamento, allocDescricao, allocVinculo, allocTratativas, allocChecklistCavalo, allocChecklistCarreta],
    ).then((r) => {
      // Carimbo REAL do banco → baseline da próxima edição no front (ver
      // check-allocation-freshness.js: usar timestamp do cliente geraria falso aviso).
      allocUpdatedAt = r.rows[0]?.alloc_updated_at ?? null;
    });

    // Reabrir a carga NÃO-reservada: "Disponível" sem motorista → força status=OPEN
    // (volta pro painel do motorista: mesmo gate do portal — OPEN + pública +
    // futura + sem motorista). A RESERVADA é reaberta pelo cancelPublicLoadLead
    // (reopenLeadId), que também baixa o lead do portal — evita duplo-booking.
    // "Disponível" também apaga o status operacional RESIDUAL vindo da planilha/ASPX
    // (sheet_status). Sem isso o operador NÃO conseguia tirar o rótulo da tela: a
    // leitura do Monitor é COALESCE(alloc_status, sheet_status), então zerar o
    // alloc_status (que é o que "Disponível" faz) só descobria o sheet_status
    // antigo — e o campo "voltava" para, p.ex., "AGUARDANDO CHEGAR NO CLIENTE".
    // A premissa original ("a carga do sistema não tem sheet_* por baixo") deixou de
    // valer quando o write-back de status do ASPX passou a gravar sheet_status na
    // carga LANÇADA.
    //
    // Sem a guarda `row.status !== "OPEN"`: numa carga JÁ aberta o bloco inteiro era
    // pulado, então o sheet_status residual nunca era limpo — justamente o caso do
    // operador que tenta reabrir uma carga que já está OPEN.
    if (reopening && !reopenLeadId) {
      await client.query(
        `UPDATE public.cargas
            SET status = CASE WHEN status <> 'OPEN' THEN 'OPEN' ELSE status END,
                sheet_status = NULL,
                updated_at = now()
          WHERE id = $1`,
        [cargoId],
      );
    }

    // Fecha/reabre a carga do sistema conforme a alocação efetiva: com motorista +
    // OPEN → RESERVED (para de aceitar candidatura pública); sem motorista +
    // RESERVED de Monitor → OPEN. Reserva real de lead (reopenLeadId acima) /
    // claim / pacote nunca é tocada. Ver reconcile-monitor-load-status.js.
    await reconcileMonitorLoadStatus(client, cargoId);

    await insertSecurityAuditEvent(client, {
      eventType: "operator.cargo.monitor_system_updated",
      actorUserId: operatorId,
      actorRole: "operator",
      resourceType: "cargo",
      resourceId: cargoId,
      action: "update",
      outcome: "success",
      requestIp,
      correlationId,
      metadata: {
        lh: lhManual,
        motorista: allocMotorista,
        cavalo: allocCavalo,
        carreta: allocCarreta,
        status: allocStatus,
        descricao: allocDescricao,
        origem,
        destino,
        data,
        horario,
        pinned,
        reopened: reopening,
        // `confirmDuplicate` é decisão de UI (o operador confirmou o aviso), não um
        // campo editado — fora da lista de campos tocados.
        fields: Object.keys(payload).filter(
          (k) => !["cargoId", "confirmDuplicate", "confirmOverwrite", "expectedAllocUpdatedAt"].includes(k),
        ),
        // DC-184: antes → depois. SEM cavalo/carreta (placas = sensível "plate"
        // no sanitizeLogPayload; chaves genéricas before/after não são redigidas
        // e vazariam no CSV do DC-186).
        changes: buildAuditChanges(
          {
            lh: row.lh_manual,
            motorista: row.alloc_motorista,
            status: row.alloc_status,
            tipo: row.alloc_tipo,
            vinculo: row.alloc_vinculo,
            checklistCavalo: row.alloc_checklist_cavalo,
            checklistCarreta: row.alloc_checklist_carreta,
            origem: row.origem,
            destino: row.destino,
            data: fmtDate(row.data),
            horario: fmtTime(row.horario),
          },
          {
            lh: lhManual,
            motorista: allocMotorista,
            status: allocStatus,
            tipo: allocTipo,
            vinculo: allocVinculo,
            checklistCavalo: allocChecklistCavalo,
            checklistCarreta: allocChecklistCarreta,
            origem,
            destino,
            data: fmtDate(data),
            horario: fmtTime(horario),
          },
          [
            { key: "lh", label: "LH" },
            { key: "motorista", label: "Motorista" },
            { key: "status", label: "Status" },
            { key: "tipo", label: "Tipo" },
            { key: "vinculo", label: "Vínculo" },
            // `tratativas` (texto livre, pode ter PII) fica FORA do diff do audit —
            // mesma política das placas e da observação de conformidade; valor só na
            // coluna alloc_tratativas. Verdito do checklist (enum) pode ficar.
            { key: "checklistCavalo", label: "Checklist cavalo" },
            { key: "checklistCarreta", label: "Checklist carreta" },
            { key: "origem", label: "Origem" },
            { key: "destino", label: "Destino" },
            { key: "data", label: "Data" },
            { key: "horario", label: "Horário" },
          ],
        ),
      },
    });

    return {
      statusCode: 200,
      payload: {
        ok: true,
        cargoId,
        rowKey: `cargo:${cargoId}`,
        // Baseline para a PRÓXIMA edição desta carga (concorrência otimista).
        allocUpdatedAt: allocUpdatedAt instanceof Date ? allocUpdatedAt.toISOString() : (allocUpdatedAt ?? null),
        cargo: {
          lh: lhManual ?? "",
          motorista: allocMotorista ?? "",
          cavalo: allocCavalo ?? "",
          carreta: allocCarreta ?? "",
          status: allocStatus ?? "",
          origem,
          destino,
          data: fmtDate(data),
          horario: fmtTime(horario),
          descarga: descarga ?? "",
        },
        meta: { correlationId },
      },
      reopenLeadId,
      // Espelho na planilha (fora da transação) — ver bloco abaixo.
      sheetMirror: {
        lh: (lhManual ?? "").toString().trim(),
        touchesAlloc: has("motorista") || has("cavalo") || has("carreta") || has("status"),
        // `availableIgnorado` = "Disponível" recusado (carga com motorista): o status
        // não foi decidido, então também NÃO espelha a coluna STATUS na planilha.
        statusInformado: has("status") && !availableIgnorado,
        effective: {
          motorista: allocMotorista ?? "",
          cavalo: allocCavalo ?? "",
          carreta: allocCarreta ?? "",
          status: allocStatus ?? "",
        },
        sheetSource: row.sheet_source ?? null,
        origem,
        destino,
        carregamentoLabel: syncedCarregamentoLabel(fmtDate(data), fmtTime(horario)),
        descargaLabel: descarga ?? "",
      },
    };
  });

  // Write-back best-effort na planilha (espelho) — FORA da transação e SEM await.
  //
  // PARIDADE com o caminho gêmeo (update-monitor-allocation.js): salvar a linha
  // "sistema" pelo modal do Monitor gravava alloc_* e NÃO espelhava nada, então a
  // carga lançada com motorista alocado aqui nunca aparecia na planilha (a Shopee
  // não via o motorista). Mesmos gates do gêmeo, sem regra nova:
  //   - só quando a edição toca alocação (motorista/cavalo/carreta/status);
  //   - createIfMissing (cria-ou-preenche com rota + agenda) SÓ com motorista
  //     efetivo — sem motorista não cria linha, p/ não poluir a planilha com spot
  //     vazio; sem motorista cai no update-only, no-op se a linha não existe;
  //   - gate LH "LT…": só linehaul SPX (planilha Shopee). Carga lançada não
  //     persiste sheet_source (NULL → roteia p/ shopee); o gate evita criar um LH
  //     de outra fonte (ex.: Nestlé) na planilha errada;
  //   - `status` só vai quando o payload informou o campo — senão re-estamparia a
  //     coluna STATUS com um alloc_status congelado.
  const mirror = result.sheetMirror;
  if (mirror?.lh && mirror.touchesAlloc) {
    const effMotorista = (mirror.effective.motorista ?? "").toString().trim();
    const isSpxLinehaul = mirror.lh.toUpperCase().startsWith("LT");
    const update = {
      lh: mirror.lh,
      source: mirror.sheetSource,
      motorista: mirror.effective.motorista,
      cavalo: mirror.effective.cavalo,
      carreta: mirror.effective.carreta,
    };
    if (mirror.statusInformado) update.status = mirror.effective.status;
    if (effMotorista && isSpxLinehaul) {
      update.createIfMissing = true;
      update.origem = mirror.origem;
      update.destino = mirror.destino;
      update.dataCarregamento = formatSheetDateLabel(mirror.carregamentoLabel);
      update.dataDescarga = formatSheetDateLabel(mirror.descargaLabel);
    }
    void writeAllocationsToSheet([update]).catch(() => {});
  }

  // Reabrir carga reservada do sistema: o operador limpou o motorista → cancela
  // o lead do portal (APPROVED → CANCELLED) e a carga volta a OPEN
  // (cancelPublicLoadLead zera reserved_*). Best-effort, fora da transação.
  if (result.reopenLeadId) {
    try {
      await cancelPublicLoadLead({ loadId: cargoId, leadId: result.reopenLeadId, operatorId, correlationId });
    } catch (reopenErr) {
      console.warn(
        `[update-monitor-cargo] reabrir carga reservada falhou para ${cargoId}:`,
        reopenErr instanceof Error ? reopenErr.message : reopenErr,
      );
    }
  }

  return result;
}
