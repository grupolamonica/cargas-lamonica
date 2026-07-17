/**
 * message-templates — central de controle das mensagens automáticas.
 *
 * Cada mensagem tem uma `key`, um TEXTO padrão (com variáveis) e um flag
 * enabled. O operador edita o texto e liga/desliga na tela de Mensagens; os
 * overrides ficam em `driver_outreach_message_templates`. O código sempre tem
 * um default — a tabela guarda só o que o operador mudou.
 *
 * Variáveis suportadas (substituídas por `renderMessage`):
 *   {nome}      primeiro nome do motorista
 *   {rota}      origem → destino
 *   {detalhes}  bloco de detalhes da carga (montado pelo sistema — inclui
 *               perfil+eixos, valor e o aviso do bônus)
 *   {link}      link do portal
 *   {ajuste}, {retorno}, {aviso_cadastro}, {openLoad}, {reason} — contextuais
 *
 * Spintax: {a|b|c} sorteia uma opção por envio (evita texto idêntico em massa).
 *
 * Cache in-memory (refresh periódico + no save) para os composers renderizarem
 * de forma síncrona, sem passar client por toda parte.
 */

import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { formatVehicleProfile, BONUS_DISCLAIMER } from "../../domain/driver-outreach/cargo-format.js";

// ─── Helpers de formatação ────────────────────────────────────────────────────

export function firstName(nome) {
  const f = String(nome || "").trim().split(/\s+/)[0] || "";
  return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : "amigo";
}
function fmtBRL(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function toIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}
function fmtDateBR(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
const DOW_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function weekdayNamePt(iso) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(iso || ""))) return "";
  return DOW_PT[new Date(`${iso}T12:00:00Z`).getUTCDay()] || "";
}

/** Expande spintax {a|b|c} — só grupos com pipe (placeholders {nome} passam). */
export function spin(text) {
  return String(text || "").replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => {
    const opts = g.split("|");
    return opts[Math.floor(Math.random() * opts.length)];
  });
}

/**
 * Monta o bloco de detalhes da carga (formato do portal /motorista), com
 * perfil+eixos e o aviso do bônus. Aceita origem/destino OU rota, data OU
 * dateIso. Retorna "" se não houver dados.
 */
export function buildCargoDetails(load = {}) {
  if (!load) return "";
  const rota =
    load.rota || (load.origem && load.destino ? `${load.origem} → ${load.destino}` : "");
  const dateIso = load.dateIso || toIso(load.data);
  const lines = [];
  if (rota) lines.push(`📍 *Rota:* ${rota}`);
  if (dateIso) {
    const wd = weekdayNamePt(dateIso);
    lines.push(`📅 *Data de carregamento:* ${fmtDateBR(dateIso)}${wd ? ` (${wd})` : ""}`);
  }
  if (load.horario) lines.push(`⏰ *Horário:* ${String(load.horario).slice(0, 5)}`);
  const perfilTxt = formatVehicleProfile(load.perfil, load.eixos);
  if (perfilTxt) lines.push(`🚛 *Perfil do veículo:* ${perfilTxt}`);
  if (load.valor) lines.push(`💰 *Valor:* ${fmtBRL(load.valor)}`);
  if (load.bonus) {
    lines.push(`🎯 *Bônus:* ${fmtBRL(load.bonus)}`);
    lines.push(BONUS_DISCLAIMER);
  }
  return lines.join("\n");
}

// ─── Registry: defaults de cada mensagem ──────────────────────────────────────

export const MESSAGE_DEFS = {
  reservation: {
    label: "Carga reservada",
    description: "Enviada quando o operador reserva uma carga para o motorista.",
    placeholders: ["{nome}", "{detalhes}"],
    default: [
      "Opa, {nome}! 🚚",
      "",
      "Aqui é a *Lamônica Cargas*. Guardei uma carga pra você:",
      "",
      "{detalhes}",
      "",
      "*Bora?* É só me responder *SIM* aqui.",
      "_Se não responder em 2h, a carga volta pra fila e passa pra outro motorista._",
    ].join("\n"),
  },
  reservation_thankyou: {
    label: "Confirmação da reserva (+ retorno)",
    description: "Quando o motorista confirma a reserva. Se houver carga de volta, é oferecida.",
    placeholders: ["{nome}", "{detalhes}", "{retorno}"],
    default: ["Show, {nome}! ✅", "", "Essa carga é sua:", "{detalhes}", "", "Boa viagem! 🚚{retorno}"].join("\n"),
  },
  mass_followup: {
    label: "Envio em massa — detalhes da carga",
    description: "Quando o motorista responde ao envio em massa e há carga na rota.",
    placeholders: ["{nome}", "{detalhes}"],
    default: ["Boa, {nome}! 🙌", "", "{detalhes}", "", "*Topa?* Responde *SIM* aqui que eu guardo pra você. 🚚"].join("\n"),
  },
  mass_no_load: {
    label: "Envio em massa — sem carga no momento",
    description: "Quando o motorista topa mas não há carga aberta na rota agora.",
    placeholders: ["{nome}", "{rota}"],
    default: [
      "Valeu, {nome}! 🙏",
      "",
      "Agora não tem carga aberta em *{rota}*, mas anotei aqui.",
      "Assim que aparecer uma que combine com você, eu te chamo. 📨",
    ].join("\n"),
  },
  mass_candidatura_confirm: {
    label: "Envio em massa — candidatura confirmada",
    description: "Quando o motorista confirma e a candidatura é registrada.",
    placeholders: ["{nome}", "{detalhes}", "{link}", "{aviso_cadastro}"],
    default: [
      "Prontinho, {nome}! ✅ Avisei a equipe e você tá na fila dessa carga.",
      "",
      "{detalhes}",
      "",
      "Se quiser trocar o cavalo ou a carreta, entra aqui:",
      "{link}{aviso_cadastro}",
      "",
      "Qualquer dúvida, me chama. 🤝",
    ].join("\n"),
  },
  route_need_invite: {
    label: "Chamado de carga órfã — convite",
    description: "Quando o sistema chama motoristas da rota para uma carga sem candidato.",
    placeholders: ["{nome}", "{rota}"],
    default: [
      "{Oi|Opa|E aí|Olá}, {nome}! 🚚",
      "",
      "Aqui é a *Lamônica Cargas*. Tô precisando de motorista pra uma carga de *{rota}*.",
      "Você já rodou essa rota — {topa|quer pegar|bora}?",
      "",
      "Se topar, é só responder *SIM* que eu já vejo o melhor dia pra você. 🙌",
    ].join("\n"),
  },
  route_need_ask_schedule: {
    label: "Chamado de carga órfã — pergunta dia/horário",
    description: "Depois que o motorista aceita o chamado, pergunta quando ele quer carregar.",
    placeholders: ["{nome}", "{rota}"],
    default: [
      "Boa, {nome}! 🙌",
      "",
      "Pra rota *{rota}*, {que dia e horário fica melhor pra você carregar?|quando você quer carregar? (dia e horário)|me diz o dia e a hora que você prefere carregar.}",
      "",
      '_Pode falar do seu jeito: "amanhã de manhã", "sexta", "dia 20", "o quanto antes"…_',
    ].join("\n"),
  },
  route_need_offer: {
    label: "Chamado de carga órfã — oferta da carga",
    description: "Oferece a carga da rota com a data mais próxima do que o motorista pediu.",
    placeholders: ["{nome}", "{detalhes}", "{ajuste}"],
    default: [
      "{nome}, achei essa carga pra você{ajuste}: 👇",
      "",
      "{detalhes}",
      "",
      "*Essa carga tá boa pra você?* Responde *SIM* que eu garanto no seu nome. 🚚",
    ].join("\n"),
  },
  route_need_no_load: {
    label: "Chamado de carga órfã — sem carga na data",
    description: "Quando não há carga na rota para a data que o motorista pediu.",
    placeholders: ["{nome}", "{rota}"],
    default: [
      "{nome}, por enquanto não achei carga em *{rota}* pra essa data. 😕",
      "",
      "Quer tentar outro dia? Me fala outra data que eu procuro.",
    ].join("\n"),
  },
  route_need_confirm: {
    label: "Chamado de carga órfã — candidatura confirmada",
    description: "Quando o motorista confirma a oferta e a candidatura é registrada.",
    placeholders: ["{nome}", "{detalhes}"],
    default: [
      "Fechado, {nome}! ✅ Garanti a carga no seu nome.",
      "",
      "{detalhes}",
      "",
      "A equipe vai confirmar os detalhes com você. Boa viagem! 🚚",
    ].join("\n"),
  },
  churn: {
    label: "Recuperação (motorista sumido)",
    description: "Motorista que não roda há um tempo. Gatilho FRIO (exige cold ligado).",
    placeholders: ["{nome}", "{dias}", "{openLoad}"],
    default:
      "Oi, {nome}! 🚚 Faz {dias} que você não roda com a gente. {openLoad}Bora voltar? Responde *SIM* aqui.",
  },
  lost_registration: {
    label: "Cadastro não finalizado",
    description: "Motorista que começou o cadastro e não terminou.",
    placeholders: ["{nome}"],
    default:
      "Oi, {nome}! Aqui é a *Lamônica Cargas*. 🚚 Vi que faltou terminar seu cadastro — é rapidinho. Se quiser que eu te ajude, me responde aqui.",
  },
  abandonment: {
    label: "Candidatura abandonada",
    description: "Motorista que demonstrou interesse e não fechou.",
    placeholders: ["{nome}"],
    default:
      "Oi, {nome}! Aqui é a *Lamônica Cargas*. Ficou tudo bem por aí? Você tinha demonstrado interesse numa carga e não fechamos. Se quiser tentar de novo, me chama.",
  },
  return_load: {
    label: "Carga de retorno",
    description: "Oferece uma carga para o motorista voltar carregado. Gatilho FRIO.",
    placeholders: ["{nome}", "{rota}"],
    default:
      "Oi, {nome}! 🚚 Achei uma carga pra você voltar carregado: {rota}. Bora? Responde *SIM* aqui que eu guardo pra você.",
  },
  suggested_load: {
    label: "Carga que combina com o perfil",
    description: "Oferece uma carga que casa com o que o motorista costuma rodar.",
    placeholders: ["{nome}", "{rota}"],
    default:
      "Oi, {nome}! 🚚 Tem uma carga que casa com o que você costuma rodar: {rota}. Bora? Responde *SIM* aqui.",
  },
  media_reply: {
    label: "Resposta a áudio/mídia",
    description: "Quando o motorista manda áudio/foto (o sistema ainda não lê).",
    placeholders: ["{nome}", "{midia}"],
    default: [
      "Oi, {nome}! 👋",
      "",
      "Recebi seu {midia} aqui, mas ainda não consigo ouvir/ver por aqui.",
      "Se puder, escreve rapidinho pra mim o que precisa? A equipe já foi avisada e vai te responder. 🙌",
    ].join("\n"),
  },
};

export const MESSAGE_KEYS = Object.keys(MESSAGE_DEFS);

// ─── Cache in-memory ──────────────────────────────────────────────────────────

const cache = { overrides: new Map(), at: 0 };
const CACHE_TTL_MS = 60_000;

/** Recarrega overrides da tabela. Silencioso se a tabela não existir. */
export async function refreshMessageTemplateCache(client) {
  const run = async (c) => {
    const { rows } = await c
      .query(`SELECT key, enabled, template FROM public.driver_outreach_message_templates`)
      .catch((err) => {
        if (err?.code === "42P01") return { rows: [] };
        throw err;
      });
    const map = new Map();
    for (const r of rows) map.set(r.key, { enabled: r.enabled !== false, template: r.template });
    cache.overrides = map;
    cache.at = Date.now();
  };
  if (client) return run(client);
  return withPgClient(run).catch(() => {});
}

function ensureFreshSync() {
  // Best-effort: dispara refresh assíncrono se o cache está velho. NÃO bloqueia
  // (composers são síncronos). Na primeira vez usa defaults até o refresh chegar.
  if (Date.now() - cache.at > CACHE_TTL_MS) {
    cache.at = Date.now(); // evita rajada de refreshes
    refreshMessageTemplateCache().catch(() => {});
  }
}

/** {enabled, template, isDefault} efetivo de uma key. */
export function getMessageTemplate(key) {
  ensureFreshSync();
  const def = MESSAGE_DEFS[key];
  const ov = cache.overrides.get(key);
  return {
    enabled: ov ? ov.enabled !== false : true,
    template: ov && ov.template != null && ov.template !== "" ? ov.template : def?.default || "",
    isDefault: !ov || ov.template == null || ov.template === "",
  };
}

export function isMessageEnabled(key) {
  return getMessageTemplate(key).enabled;
}

/**
 * Renderiza a mensagem: substitui variáveis + spintax. Retorna `null` se a
 * mensagem está DESLIGADA (o caller não envia).
 * @param {string} key
 * @param {Record<string,string>} vars  ex.: { nome, rota, detalhes, link }
 */
export function renderMessage(key, vars = {}, { force = false } = {}) {
  const { enabled, template } = getMessageTemplate(key);
  if (!enabled && !force) return null;
  let text = String(template || "");
  for (const [k, v] of Object.entries(vars)) {
    text = text.split(`{${k}}`).join(v == null ? "" : String(v));
  }
  text = spin(text);
  // limpa linhas em branco excedentes deixadas por variáveis vazias
  text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
  return text;
}

// ─── Operador: listar + salvar ────────────────────────────────────────────────

/** Lista para a tela de Mensagens: default + override + metadados. */
export async function listMessageTemplates() {
  await refreshMessageTemplateCache().catch(() => {});
  return MESSAGE_KEYS.map((key) => {
    const def = MESSAGE_DEFS[key];
    const ov = cache.overrides.get(key);
    return {
      key,
      label: def.label,
      description: def.description,
      placeholders: def.placeholders,
      defaultTemplate: def.default,
      template: ov && ov.template != null && ov.template !== "" ? ov.template : def.default,
      enabled: ov ? ov.enabled !== false : true,
      customized: Boolean(ov && ov.template != null && ov.template !== ""),
    };
  });
}

/** Salva override (texto e/ou enabled) de uma mensagem. */
export async function saveMessageTemplate({ key, template, enabled, updatedBy } = {}) {
  if (!MESSAGE_DEFS[key]) throw new Error(`Mensagem desconhecida: ${key}`);
  // template === null ou "" (após trim) → volta ao default (grava NULL).
  const cleanTemplate =
    template == null ? null : String(template).trim() === "" ? null : String(template);
  const enabledVal = typeof enabled === "boolean" ? enabled : true;
  await withPgClient((c) =>
    c.query(
      `INSERT INTO public.driver_outreach_message_templates (key, enabled, template, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             template = EXCLUDED.template,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [key, enabledVal, cleanTemplate, updatedBy || null],
    ),
  );
  await refreshMessageTemplateCache().catch(() => {});
  return getMessageTemplate(key);
}
