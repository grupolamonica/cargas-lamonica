/**
 * Converte `pending_driver_registrations.dados` no formato esperado pelo
 * sidecar SPX (`POST /spx/motorista`). Sidecar usa snake_case e exige campos
 * SPX-específicos (contract_type, function_type_list, vehicle_type_name, etc).
 *
 * Defaults LAMONICA (agency 297), alinhados à PRODUÇÃO (lib/spx_payload.js):
 *   - contract_type=364 ("line haul"); function_type_list=[1] (DELIVERY — é o que os
 *     motoristas reais/aprovados da LAMONICA usam; [3]/LINE_HAUL dá "Station not exist")
 *   - linehaul_station default 'SoC_BA_Simoes Filho'
 *   - vehicle_type CARRETA quando há carreta, senão TRUCK - EXPRESSA
 *   - datas via toIsoDate robusto (separadores ./-/, ano 2/4 díg, valida)
 *   - cnh_remarks só da whitelist do SPX
 *   - vehicle_manufacturer = só a MARCA (uppercase) p/ bater 1:1 com o OCR do CRLV
 *   - vehicle_owner_name = proprietário REAL do CRLV (fallback motorista)
 *   - do_draft_save=true (salva rascunho antes do submit)
 *
 * Os *_path/risk_doc_path/rad_expire_date entram via overrides (injetados pelo
 * dispatch-pipeline após estagiar anexos + gerar dossiê + resolver vigência).
 *
 * Epic DC-111 / extensão SPX (Fase 4: defaults + fixes da produção).
 */

import { mapMotoristaPayload, extractPlacas } from "../angellira/payload-mapper.js";
import { defaultExpiryIso } from "./risk-expiry.js";

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// ── Datas: toIsoDate robusto (portado de lib/spx_payload.js da produção) ──────
// Cobre 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD.MM.YY' etc, valida a data e, se inválida
// ou irreconhecível, devolve '' (vira 0 no Python, aceito) em vez de derrubar o
// disparo no _to_unix_seconds.
function _dataValida(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const ano = +m[1], mes = +m[2], dia = +m[3];
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || ano < 1900 || ano > 2100) return false;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}
function toIsoDate(value) {
  if (!value) return "";
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return _dataValida(iso) ? iso : "";
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    let ano = m[3];
    if (ano.length === 2) ano = (Number(ano) <= 29 ? "20" : "19") + ano;
    const iso = `${ano}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return _dataValida(iso) ? iso : "";
  }
  return "";
}

// ── CNH remarks (portado da produção): só a whitelist do SPX ──────────────────
export const CNH_REMARKS_VALIDOS = new Set([
  "EAR", "CETPP", "CETE", "CETCP", "CETVE", "CETCI", "CMTX", "CMTF",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "X",
]);
export function parseCnhRemarks(observacoes) {
  if (!observacoes) return [];
  const tokens = String(observacoes).toUpperCase().split(/[\s,;/|.]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (CNH_REMARKS_VALIDOS.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// Defaults LAMONICA (agency 297). Configuráveis via env.
const DEFAULTS = {
  contract_type: Number(process.env.SPX_DEFAULT_CONTRACT_TYPE || 364),
  // DELIVERY=1 — é o que os motoristas REAIS/aprovados da agência LAMONICA usam
  // (dump exemplo_motoristas_todos.json: todos [1], contract "line haul" 364,
  // station 8808). function_type_list [3] (LINE_HAUL) é REJEITADO pelo SPX no
  // validate/detail com "Station not exist" (-1100000) — confirmado ao vivo
  // 2026-06-22. Enum: DELIVERY=1, PICKUP=2, LINE_HAUL=3, RETURN=4.
  function_type_list: (process.env.SPX_DEFAULT_FUNCTION_TYPES || "1")
    .split(",").map((s) => Number(s.trim())).filter(Number.isFinite),
  linehaul_station_name: process.env.SPX_DEFAULT_STATION || "SoC_BA_Simoes Filho",
  // Cavalo-só = "TRUCK" (id 49). Os motoristas REAIS/aprovados da LAMONICA usam 49
  // p/ cavalo-só (e 51/CARRETA p/ cavalo+carreta). "TRUCK - EXPRESSA" (65) era o que
  // mandávamos e o SPX rejeita no validate/detail (271626003) — confirmado 2026-06-22.
  vehicle_type_name: process.env.SPX_DEFAULT_VEHICLE_TYPE || "TRUCK",
  gender: 1, // 1=male, 2=female
};

/**
 * Constrói o MotoristaPayload do bot SPX a partir do `dados` JSONB.
 *
 * @param {object} dados
 * @param {object} [overrides] — overrides do operador + injeções do pipeline
 *   (cnh_frente_path, cnh_verso_path, selfie_path, crlv_path, risk_doc_path,
 *    rad_expire_date, station, etc.)
 */
export function mapSpxMotoristaPayload(dados, overrides = {}) {
  const ang = mapMotoristaPayload(dados); // normalização compartilhada (Angellira)
  const motorista = dados?.motorista || {};
  const cnh = ang.cnh;
  const endereco = ang.endereco;
  const cavalo = dados?.cavalo || {};

  // Gênero — "M"/"F" do wizard
  const generoRaw = String(motorista.genero || motorista.sexo || "").toUpperCase();
  const gender = generoRaw.startsWith("F") ? 2 : (generoRaw.startsWith("M") ? 1 : DEFAULTS.gender);

  // CNH category → SPX CNHType id (DEVE espelhar K.CNHType do bot). C=0 é válido → usar ??.
  const cnhCategoryMap = { A: 3, B: 23, C: 0, D: 24, E: 25, AB: 26, AC: 27, AD: 28, AE: 29 };
  const cnhCategoria = String(cnh.categoria || "").toUpperCase().replace(/\s/g, "");
  const license_type = cnhCategoryMap[cnhCategoria] ?? cnhCategoryMap.E;

  // ── Regra CAVALO vs CAVALO+CARRETA (portado da produção) ────────────────────
  // Com carreta → vehicle_type=CARRETA + 2 placas "CAV,CAR" + plate_number_quantity=2.
  const { cavalo: placaCavalo, carreta: placaCarreta } = extractPlacas(dados || {});
  const hasCarreta = !!placaCarreta && placaCarreta !== placaCavalo;
  const license_plate = overrides.license_plate
    || (hasCarreta && placaCavalo ? `${placaCavalo},${placaCarreta}` : placaCavalo);
  const plate_number_quantity = overrides.plate_number_quantity ?? (hasCarreta ? 2 : 1);
  const vehicle_type_name = overrides.vehicle_type_name
    ?? (hasCarreta ? "CARRETA" : DEFAULTS.vehicle_type_name);

  // vehicle_manufacturer: SÓ a marca em UPPERCASE (sem modelo) p/ bater 1:1 com o OCR do CRLV.
  const marcaRaw = String(cavalo.marca || cavalo.marca_modelo || "").trim();
  const vehicle_manufacturer = marcaRaw.split("/")[0].trim().toUpperCase();

  // vehicle_owner_name: proprietário REAL do CRLV; senão owner cadastrado; senão motorista.
  const vehicle_owner_name = (
    String(cavalo.proprietario || "").trim()
    || String(dados?.cavalo_owner?.razao_social || dados?.cavalo_owner?.nome || "").trim()
    || String(ang.motorista.nome || "").trim()
  ).slice(0, 60);

  return {
    cpf: ang.motorista.cpf,
    driver_name: ang.motorista.nome,
    contact_number: digitsOnly(
      (Array.isArray(ang.motorista.telefones) && ang.motorista.telefones[0])
        || motorista.telefone_primario || motorista.telefone || "",
    ),
    gender,
    birth_day: toIsoDate(motorista.nascimento || motorista.data_nascimento),

    city_name: endereco.cidade,
    neighbourhood_name: endereco.bairro,
    street_name: endereco.logradouro,
    address_number: endereco.numero,
    zip_code: endereco.cep,

    contract_type: overrides.contract_type ?? DEFAULTS.contract_type,
    function_type_list: overrides.function_type_list ?? DEFAULTS.function_type_list,
    linehaul_station_name: overrides.linehaul_station_name ?? DEFAULTS.linehaul_station_name,
    pickup_station_name: overrides.pickup_station_name ?? null,
    delivery_station_name: overrides.delivery_station_name ?? null,
    return_station_name: overrides.return_station_name ?? null,

    license_number: digitsOnly(cnh.registro || cnh.numero),
    license_type,
    license_expire_date: toIsoDate(motorista.cnh_validade || cnh.validade),
    // Observações do verso (EAR etc.). O wizard persiste em motorista.cnh.observacoes
    // (nested) e o operador pode preencher no editor; mantém os aliases antigos.
    cnh_remarks: overrides.cnh_remarks
      ?? parseCnhRemarks(
        motorista.cnh_observacoes
        || motorista.cnh?.observacoes || motorista.cnh?.observacao
        || cnh.observacoes || cnh.observacao || "",
      ),

    vehicle_type_name,
    license_plate,
    plate_number_quantity,
    vehicle_manufacturer,
    vehicle_manufacturing_year: String(cavalo.ano_fab || cavalo.ano_fabricacao || cavalo.ano_modelo || "").slice(0, 4),
    vehicle_owner_name,
    renavam: digitsOnly(cavalo.renavam),

    // Arquivos — injetados pelo dispatch-pipeline (spx-anexos-stager + generate-dossie).
    cnh_frente_path: overrides.cnh_frente_path ?? null,
    cnh_verso_path: overrides.cnh_verso_path ?? null,
    selfie_path: overrides.selfie_path ?? null,
    crlv_path: overrides.crlv_path ?? null,
    risk_doc_path: overrides.risk_doc_path ?? null,
    // Vigência: SPX rejeita null → cai no default (hoje+90d) como cinto-e-suspensório.
    rad_expire_date: overrides.rad_expire_date ?? defaultExpiryIso(),

    dry_run: overrides.dry_run ?? false,
    do_draft_save: overrides.do_draft_save ?? true,
  };
}
