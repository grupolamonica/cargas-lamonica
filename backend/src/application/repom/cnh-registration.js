/**
 * Repom — Fase 3b: monta o `dados.motorista` a partir da extração da CNH e
 * grava/atualiza o cadastro em pending_driver_registrations.
 *
 * O mapeamento OCR→schema espelha o que o wizard do Cargas faz
 * (frontend `cadastroApi.ts`), pra o cadastro nascer IDÊNTICO ao do wizard e
 * o operador aprovar do mesmo jeito:
 *  - chaves canônicas: `cnh.registro` (não numero_registro), `cnh.primeira_emissao`;
 *  - dados pessoais no TOPO de `motorista` (nome/cpf/rg/...); dados da carteira em `motorista.cnh`;
 *  - `validade`/`primeira_emissao` em ISO (AAAA-MM-DD); `data_nascimento` fica BR;
 *  - `cnh_url` = storage_path do bucket cadastro-drafts.
 *
 * Decisões (Samuel): sempre operador aprova (nunca auto-aprova); status gravado
 * = 'pendente' (garante aparecer na fila) + motivos de revisão em `observacoes`.
 *
 * Progresso da coleta (Fase 3d): grava `dados.repom` (origem + coleta_status +
 * etapa_atual), DERIVADO de `dados.motorista` via repom-flow. É o que o painel
 * usa pra mostrar o rótulo "EM ANDAMENTO" — sem status novo (o status segue
 * 'pendente', senão o cadastro sumiria do read-model do operador).
 */

import { isCadastroCompleto, proximoPasso } from "./repom-flow.js";

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

/** Bloco `dados.repom` derivado do estado atual do motorista (progresso da coleta). */
export function buildRepomProgress(motorista, nowIso) {
  const dados = { motorista: motorista || {} };
  const proximo = proximoPasso(dados);
  return {
    origem: "whatsapp",
    coleta_status: isCadastroCompleto(dados) ? "concluida" : "coletando",
    etapa_atual: proximo?.key || null,
    ultima_interacao: nowIso || new Date().toISOString(),
  };
}

/** DD/MM/AAAA → AAAA-MM-DD; já-ISO mantém; outro formato mantém (operador corrige). */
export function brDateToIso(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return s;
}

/**
 * Constrói o objeto `dados.motorista` a partir dos campos achatados do OCR.
 * @param {Record<string,unknown>} fields  saída de flattenOcrCampos
 * @param {object} p
 * @param {string} p.cpf  CPF da sessão (11 dígitos) — chave do dedup
 */
export function buildMotoristaFromCnhFields(fields, { cpf } = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = fields?.[k];
      if (v !== null && v !== undefined && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };
  const motorista = { cpf: onlyDigits(cpf) };
  const set = (k, v) => {
    if (v !== null && v !== undefined && v !== "") motorista[k] = v;
  };

  set("nome", pick("nome"));
  set("data_nascimento", pick("data_nascimento", "nascimento")); // mantém BR (paridade com wizard)
  set("nome_pai", pick("nome_pai"));
  set("nome_mae", pick("nome_mae"));
  set("naturalidade", pick("naturalidade"));
  set("rg", pick("rg_numero", "rg"));
  set("rg_orgao", pick("rg_orgao"));
  set("rg_uf", pick("rg_uf"));

  const cnh = {};
  const setC = (k, v) => {
    if (v !== null && v !== undefined && v !== "") cnh[k] = v;
  };
  setC("registro", pick("numero_registro", "registro"));
  setC("categoria", pick("categoria"));
  setC("validade", brDateToIso(pick("validade")));
  const primeira = brDateToIso(pick("primeira_habilitacao", "primeira_emissao"));
  if (primeira && primeira !== cnh.validade) setC("primeira_emissao", primeira);
  setC("codigo_seguranca", pick("codigo_seguranca"));
  setC("numero_espelho", pick("numero_espelho", "espelho"));
  setC("uf_emissor", pick("uf_emissor"));
  if (Object.keys(cnh).length) motorista.cnh = cnh;

  return motorista;
}

// Traduz os códigos de issue dos gates para uma frase de revisão ao operador.
const ISSUE_PT = {
  ocr_suspeito: "possível erro de leitura (OCR) em CPF/registro",
  cpf_invalido: "CPF ilegível ou incompleto",
  nome_curto: "nome não lido",
  sem_registro_nem_categoria: "sem nº de registro nem categoria",
  validade_ilegivel: "validade ilegível",
  cnh_vencida: "CNH vencida",
  cpf_diverge_sessao: "CPF da CNH difere do informado",
};

const ORIGEM_TAG = "[Cadastro via WhatsApp]";

/** Monta a `observacoes` (marca de origem + motivos de revisão), ou só a marca. */
export function renderObservacoes(issues, extra = null) {
  const parts = [];
  if (Array.isArray(issues) && issues.length) {
    parts.push(`Revisar: ${issues.map((i) => ISSUE_PT[i.code] || i.code).join("; ")}.`);
  }
  if (extra) parts.push(extra);
  return `${ORIGEM_TAG}${parts.length ? ` ${parts.join(" ")}` : " cadastro iniciado pelo WhatsApp."}`;
}

/**
 * Grava (INSERT) ou atualiza (UPDATE) o cadastro no pending_driver_registrations.
 * `registrationId` presente (dedup continue/resume/reopen) → UPDATE (merge no
 * dados existente); ausente (create) → INSERT novo. Merge é read-modify-write
 * (o pg-mem dos testes não tem o operador `||` de jsonb), com o dado NOVO
 * prevalecendo (o motorista acabou de reenviar).
 *
 * @returns {Promise<{ id: string, created: boolean }>}
 */
/** Merge do motorista no dados existente da linha `rowId` (novo prevalece). */
async function mergeIntoPending(client, rowId, motorista, status, observacoes) {
  const { rows } = await client.query(
    `SELECT dados FROM public.pending_driver_registrations WHERE id = $1`,
    [rowId],
  );
  const dados = rows[0]?.dados && typeof rows[0].dados === "object" ? rows[0].dados : {};
  dados.motorista = { ...(dados.motorista || {}), ...motorista };
  dados.repom = buildRepomProgress(dados.motorista);
  // observacoes: COALESCE — ao mesclar um passo novo (ex.: selfie) sem motivo de
  // revisão (null), PRESERVA os motivos já gravados na CNH (ex.: "CNH vencida").
  // Só sobrescreve quando o caller manda uma observação nova de fato.
  await client.query(
    `UPDATE public.pending_driver_registrations
        SET dados = $2::jsonb, status = $3, observacoes = COALESCE($4, observacoes), updated_at = now()
      WHERE id = $1`,
    [rowId, JSON.stringify(dados), status, observacoes],
  );
  return { id: rowId, created: false };
}

export async function upsertPendingCnh(client, { cpf, registrationId, motorista, status = "pendente", observacoes = null }) {
  // 1) registrationId explícito (dedup continue/resume/reopen) → merge.
  if (registrationId) {
    const { rows } = await client.query(
      `SELECT id FROM public.pending_driver_registrations WHERE id = $1`,
      [registrationId],
    );
    if (rows[0]) return mergeIntoPending(client, registrationId, motorista, status, observacoes);
    // registrationId órfão → segue pelo id_cadastro.
  }

  // 2) Idempotência por id_cadastro (repom-<cpf>): se já existe (ex.: 2ª foto do
  //    MESMO CPF novo, ou corrida), faz merge em vez de criar linha duplicada.
  const idCadastro = `repom-${onlyDigits(cpf)}`;
  const existing = await client.query(
    `SELECT id FROM public.pending_driver_registrations WHERE id_cadastro = $1 LIMIT 1`,
    [idCadastro],
  );
  if (existing.rows[0]) return mergeIntoPending(client, existing.rows[0].id, motorista, status, observacoes);

  // 3) Novo cadastro.
  const { rows } = await client.query(
    `INSERT INTO public.pending_driver_registrations
       (id_cadastro, status, versao_cadastro, dados, observacoes)
     VALUES ($1, $2, 'v2', $3::jsonb, $4)
     RETURNING id`,
    [idCadastro, status, JSON.stringify({ motorista, repom: buildRepomProgress(motorista) }), observacoes],
  );
  return { id: rows[0]?.id, created: true };
}
