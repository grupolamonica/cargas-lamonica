import { z } from "zod";
import { positiveIntSchema } from "./common.js";

/** Query params for GET /api/operator/motoristas/:driverId (PATCH body) — params handled by driver-schemas */

/** Query params for sheet monitor */
export const sheetMonitorQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
}).passthrough();

/** Query params for sheet monitor row detail */
export const sheetMonitorRowQuerySchema = z.object({
  lh: z.string().min(1, "Query param 'lh' is required"),
});

/** Query params for GET /api/operator/vehicle-checklist?placas=A,B */
export const vehicleChecklistQuerySchema = z.object({
  placas: z.string().trim().min(1, "Query param 'placas' is required").max(2000),
});

/** Body for POST /api/operator/sheet-monitor/enrich */
export const sheetMonitorEnrichBodySchema = z.object({
  force: z.boolean().optional(),
  forceSessionStart: z.string().optional().nullable(),
}).passthrough();

/** Body for PATCH /api/operator/sheet-monitor — alocação editada no Monitor (Fase 0).
 *  Cada campo: string = define override; null/"" = limpa o override (volta ao valor da planilha). */
export const sheetMonitorAllocationBodySchema = z.object({
  lh: z.string().trim().min(1).max(120),
  motorista: z.string().trim().max(180).nullable().optional(),
  cavalo: z.string().trim().max(40).nullable().optional(),
  carreta: z.string().trim().max(40).nullable().optional(),
  status: z.string().trim().max(60).nullable().optional(),
  // Tipo da carga (ForeCast/Spot/Tendência) — override editável no Monitor.
  tipo: z.string().trim().max(60).nullable().optional(),
  // Motivo da troca de motorista/veículo (modal "Confirmar troca"). Obrigatório
  // no front ao trocar m/v; opcional no schema (edições que só mexem status/tipo).
  descricao: z.string().trim().max(500).nullable().optional(),
  // Vínculo do motorista (col H da planilha: AGREGADO/TERCEIRO/PME/FROTA…).
  vinculo: z.string().trim().max(80).nullable().optional(),
}).strict();

/** Body for POST /api/operator/sheet-monitor/reassign — reordenar a fila de
 *  motoristas/veículos (F3). Cada move grava a alocação relocada numa carga;
 *  "" = vazio explícito (sobrepõe a planilha → carga sem motorista). */
export const sheetMonitorReassignBodySchema = z.object({
  moves: z.array(z.object({
    // Carga da planilha → lh; carga do SISTEMA → cargoId (uuid). Ao menos um.
    lh: z.string().trim().max(120).optional(),
    cargoId: z.string().uuid().optional(),
    motorista: z.string().trim().max(180).optional().default(""),
    cavalo: z.string().trim().max(40).optional().default(""),
    carreta: z.string().trim().max(40).optional().default(""),
  }).refine((m) => (m.lh && m.lh.length > 0) || !!m.cargoId, {
    message: "Cada movimentação precisa de lh ou cargoId.",
  })).min(1).max(500),
}).strict();

/** Body for POST /api/operator/sheet-monitor/descend — descer a fila (manual).
 *  O front manda só a ORDEM exibida da rota (`orderedLhs`, topo→base, já
 *  respeitando os filtros da tela), a carga de origem (`sourceLh`) e a de destino
 *  (`targetLh`, onde foi solto). O backend é AUTORITATIVO: lê pinned/status/alocação
 *  reais e calcula a cascata — carga fixada nunca é movida (pulada), o que sobra
 *  vira reserva. */
export const sheetMonitorDescendBodySchema = z.object({
  sourceLh: z.string().trim().min(1).max(120),
  targetLh: z.string().trim().min(1).max(120),
  orderedLhs: z.array(z.string().trim().min(1).max(120)).min(1).max(3000),
}).strict();

/** Body for POST /api/operator/sheet-monitor/aspx-assigned — consulta, por viagem
 *  SPX ("LT…"), se o motorista informado (efetivo da carga) é o mesmo ATRIBUÍDO
 *  àquela viagem no SPX/ASPX. Usado pelo selo "S" (verde = atribuído). */
export const sheetMonitorAspxAssignedBodySchema = z.object({
  items: z.array(z.object({
    lh: z.string().trim().min(1).max(120),
    motorista: z.string().trim().max(180).optional().default(""),
  })).max(3000),
}).strict();

/** Body for POST /api/operator/sheet-monitor/assign-reserva — puxa um motorista
 *  em standby (monitor_reservas) para uma carga da planilha (arrastar reserva → carga). */
export const sheetMonitorAssignReservaBodySchema = z.object({
  reservaId: z.string().uuid(),
  targetLh: z.string().trim().min(1).max(120),
}).strict();

/** Body for POST /api/operator/sheet-monitor/reserva — cria uma reserva (standby)
 *  de motorista para uma rota (origem → destino). */
export const sheetMonitorCreateReservaBodySchema = z.object({
  motorista: z.string().trim().min(1).max(180),
  cavalo: z.string().trim().max(40).optional().default(""),
  carreta: z.string().trim().max(40).optional().default(""),
  origem: z.string().trim().min(1).max(180),
  destino: z.string().trim().min(1).max(180),
}).strict();

/** Body for PATCH /api/operator/sheet-monitor/reserva — edita uma reserva ativa.
 *  Parcial: só os campos enviados são alterados. */
export const sheetMonitorUpdateReservaBodySchema = z.object({
  reservaId: z.string().uuid(),
  motorista: z.string().trim().min(1).max(180).optional(),
  cavalo: z.string().trim().max(40).optional(),
  carreta: z.string().trim().max(40).optional(),
}).strict();

/** Body for DELETE /api/operator/sheet-monitor/reserva — remove (soft) uma reserva. */
export const sheetMonitorDeleteReservaBodySchema = z.object({
  reservaId: z.string().uuid(),
}).strict();

/** Body for POST /api/operator/sheet-monitor/pin — fixar/desafixar a alocação de
 *  uma carga (motorista/veículo intocável por arrasto, edição e cascata). */
export const sheetMonitorPinBodySchema = z.object({
  lh: z.string().trim().min(1).max(120),
  pinned: z.boolean(),
}).strict();

/** Body for PATCH /api/operator/sheet-monitor/cargo — edita uma carga do SISTEMA
 *  (sheet_lh nulo) direto no grid do Monitor. Parcial: só os campos enviados são
 *  alterados. Rota/Agenda são NOT NULL (min length quando enviados); motorista/
 *  veículo/status são alloc_* ("" limpa). LH livre vai em lh_manual. */
export const sheetMonitorCargoUpdateBodySchema = z.object({
  cargoId: z.string().uuid(),
  motorista: z.string().trim().max(180).nullable().optional(),
  cavalo: z.string().trim().max(40).nullable().optional(),
  carreta: z.string().trim().max(40).nullable().optional(),
  status: z.string().trim().max(60).nullable().optional(),
  origem: z.string().trim().min(2).max(180).optional(),
  destino: z.string().trim().min(2).max(180).optional(),
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horario: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  // Descarga (data+hora juntas) — datetime-local 'YYYY-MM-DDTHH:MM' ou '' p/ limpar.
  descarga: z.string().trim().max(40).optional(),
  lh: z.string().trim().max(120).nullable().optional(),
  // Tipo da carga (ForeCast/Spot/Tendência) — gravado em alloc_tipo.
  tipo: z.string().trim().max(60).nullable().optional(),
  // Motivo da troca de motorista/veículo (modal "Confirmar troca") → alloc_descricao.
  descricao: z.string().trim().max(500).nullable().optional(),
  // Vínculo do motorista → alloc_vinculo.
  vinculo: z.string().trim().max(80).nullable().optional(),
}).strict();

/** Body for POST /api/operator/sheet-monitor/aspx-assign — confirma a atribuição
 *  no ASPX das cargas (LHs) selecionadas. dryRun força simulação mesmo com o
 *  kill switch ligado. */
export const sheetMonitorAspxAssignBodySchema = z.object({
  lhs: z.array(z.string().trim().min(1).max(120)).min(1).max(300),
  dryRun: z.boolean().optional().default(false),
}).strict();

/** Body for POST /api/operator/sheet-monitor/aspx-accept — aceita (reserva) viagens
 *  line_haul no ASPX (passo anterior ao assign). Aceita por trip_id direto e/ou por
 *  LH (trip_number LT…, resolvido p/ trip_id no servidor). Ao menos um dos dois é
 *  obrigatório. dryRun força simulação mesmo com o kill switch ligado. */
export const sheetMonitorAspxAcceptBodySchema = z.object({
  tripIds: z.array(z.number().int().positive()).max(300).optional(),
  lhs: z.array(z.string().trim().min(1).max(120)).max(300).optional(),
  dryRun: z.boolean().optional().default(false),
}).strict().refine((v) => (v.tripIds?.length ?? 0) + (v.lhs?.length ?? 0) > 0, {
  message: "Informe ao menos uma viagem em tripIds ou lhs.",
});

/** Body for POST /api/operator/programacao/launch — lança uma carga do sistema a
 *  partir de uma viagem SPX (tela Programação). O LH vira sheet_lh (dedup pelo
 *  índice único). data/origem/destino vêm da viagem; horario/perfil têm default. */
export const programacaoLaunchBodySchema = z.object({
  lh: z.string().trim().min(1).max(120),
  origem: z.string().trim().min(2).max(180),
  destino: z.string().trim().min(2).max(180),
  // Opcional: sem data, a carga entra "a confirmar" (agenda definida depois).
  data: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horario: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  dataDescarga: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  horarioDescarga: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  nome: z.string().trim().max(180).optional(),
  perfil: z.string().trim().max(60).optional(),
}).strict();

/** Query params for PII redaction POST */
export const piiRedactionQuerySchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(365).optional(),
  batchSize: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Query params for /api/operator/dashboard */
export const dashboardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(24).default(12),
  search: z.string().optional(),
  status: z.string().optional(),
  driverVisibility: z.string().optional(),
}).passthrough();

/** Query params for /api/operator/audit-logs */
export const auditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();

/** Query params for /api/operator/driver-flow-metrics */
export const driverFlowMetricsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();
