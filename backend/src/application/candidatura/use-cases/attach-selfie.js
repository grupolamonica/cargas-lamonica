// attach-selfie (motorista) — anexa a selfie-com-CNH a um cadastro ja
// aprovado/concluido do PROPRIO motorista, SEM passar pelo submit da candidatura.
//
// Usado pelo passo StepASelfieOnly do wizard quando o pre-check devolve a
// pendencia SELFIE_REQUIRED (motorista ja cadastrado, faltando so a selfie).
//
// Por que um endpoint dedicado (e nao o /candidatura/submit): rotear "so a
// selfie" pelo submit arrastava efeitos colaterais serios — o short-circuit de
// duplicidade (cpf,placa) descartava a selfie em silencio, o merge por
// driver_user_id falhava em cadastro importado (driver_user_id NULL) gerando
// 422, e o submit fabricava cavalo/ANTT. Aqui atualizamos a PROPRIA linha
// aprovada/concluida no lugar: a selfie aparece de imediato e o pre-check
// seguinte ja ve hasSelfie=true (some o re-prompt). Espelha o endpoint do
// operador `anexar-selfie` (PR #333): mesmo slot `motorista_selfie_cnh`.
//
// Seguranca: o path precisa estar sob a pasta do CPF do proprio motorista
// (uploadDraftFile escopa a pasta por CPF no upload) — impede apontar para
// arquivo de outro CPF. Match por CPF (mesma consulta do pre-check
// getLocalCadastroStatus) — funciona inclusive para cadastro importado com
// driver_user_id NULL. Endpoint publico + rate-limit no handler: mesmo modelo
// de confianca do pre-check/submit publicos.

import { withPgClient } from "../../../infrastructure/pg/postgres.js";
import { logStructuredEvent } from "../../../infrastructure/security-log.js";
import { getAdminClient } from "../../load-claims/auth.js";
import { DRAFT_FILE_BUCKET } from "./upload-draft-file.js";

const SELFIE_SLOT = "motorista_selfie_cnh";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Confirma que o arquivo REALMENTE existe no bucket cadastro-drafts, no caminho
 * informado. Sem isto o endpoint aceitaria qualquer string bem-formada e gravaria
 * um selfie_cnh_url "fantasma" — suprimindo o re-prompt e escondendo a pendencia
 * de selfie na revisao do operador (achado de seguranca). Best-effort: erro de
 * storage devolve false (nao anexa) em vez de assumir que existe.
 */
async function selfieFileExists(client, storagePath) {
  const lastSlash = storagePath.lastIndexOf("/");
  if (lastSlash <= 0) return false;
  const prefix = storagePath.slice(0, lastSlash);
  const filename = storagePath.slice(lastSlash + 1);
  try {
    const { data, error } = await client.storage
      .from(DRAFT_FILE_BUCKET)
      .list(prefix, { limit: 100 });
    if (error || !Array.isArray(data)) return false;
    return data.some((entry) => entry?.name === filename);
  } catch {
    return false;
  }
}

/**
 * Anexa a selfie ao cadastro aprovado/concluido mais recente do CPF.
 *
 * @param {Object} args
 * @param {string} args.cpf                 CPF do motorista (com ou sem pontuacao).
 * @param {string} args.selfieStoragePath   storage_path devolvido por uploadDraftFile
 *                                           (slot motorista_selfie_cnh), sob a pasta do CPF.
 * @param {string|null} [args.correlationId]
 * @returns {Promise<{ ok: boolean, code?: string, cadastroId?: string, selfie_cnh_url?: string }>}
 */
export async function attachSelfieToCadastro({
  cpf,
  selfieStoragePath,
  correlationId = null,
  // Injetavel para testes (Supabase admin client mockado), como em uploadDraftFile.
  supabaseClient,
} = {}) {
  const digits = digitsOnly(cpf);
  if (digits.length !== 11) {
    return { ok: false, code: "INVALID_CPF" };
  }

  const path = String(selfieStoragePath || "").trim();
  // Path esperado (uploadDraftFile): `${cpf}/${cargaId}/motorista_selfie_cnh_${ts}.${ext}`.
  // Exigir o prefixo do CPF + o slot impede anexar arquivo de outro CPF / de
  // outro tipo de documento. `..` barrado explicitamente (defesa contra traversal
  // — o prefixo do CPF ja cobre, mas deixamos explicito).
  if (
    !path ||
    !path.startsWith(`${digits}/`) ||
    !path.includes(SELFIE_SLOT) ||
    path.includes("..")
  ) {
    return { ok: false, code: "INVALID_PATH" };
  }

  // Confirma que o arquivo existe no storage (nao aceita path "fantasma").
  const storageClient = supabaseClient || getAdminClient();
  const exists = await selfieFileExists(storageClient, path);
  if (!exists) {
    return { ok: false, code: "FILE_NOT_FOUND" };
  }

  return withPgClient(async (client) => {
    // Mesma ordenacao do pre-check (getLocalCadastroStatus: created_at DESC) para
    // atualizar exatamente a linha que o motorista viu no wizard.
    const { rows } = await client.query(
      `
        SELECT id, dados
        FROM public.pending_driver_registrations
        WHERE regexp_replace(coalesce(dados->'motorista'->>'cpf', ''), '\\D', '', 'g') = $1
          AND status IN ('aprovado', 'concluido')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [digits],
    );

    if (!rows || rows.length === 0) {
      return { ok: false, code: "NOT_FOUND" };
    }

    const { id, dados } = rows[0];
    const baseDados = dados && typeof dados === "object" ? dados : {};
    const baseMotorista =
      baseDados.motorista && typeof baseDados.motorista === "object" ? baseDados.motorista : {};
    const nextDados = {
      ...baseDados,
      motorista: { ...baseMotorista, selfie_cnh_url: path },
    };

    await client.query(
      `UPDATE public.pending_driver_registrations SET dados = $1::jsonb WHERE id = $2`,
      [JSON.stringify(nextDados), id],
    );

    logStructuredEvent("info", "candidatura.attach-selfie.ok", {
      correlationId,
      cadastroId: id,
    });

    return { ok: true, cadastroId: id, selfie_cnh_url: path };
  });
}
