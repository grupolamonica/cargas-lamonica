/**
 * Monta o `driver_info` do `importar_motorista_matched` (bot SPX) para o caso
 * IS_MATCHED_OUTRA (motorista já existe em OUTRA agência do SPX).
 *
 * Problema: nesse caso o SPX devolve só o código de bloqueio cross-agency — NÃO
 * devolve o perfil do motorista (nome/CNH vêm vazios). O bot então barrava com
 * "Perfil da outra agência não foi recuperado (nome e CNH vazio)".
 *
 * Solução: usamos o que JÁ temos no NOSSO cadastro (o mesmo `payload` mapeado do
 * cadastro novo — nome/CNH/endereço) como base, e deixamos qualquer valor que o
 * SPX porventura devolver PREVALECER por cima (só quando não-vazio). Datas
 * (birth_day / license_expire_date) seguem em ISO — o bot normaliza p/ unix.
 *
 * @param {object} payload   — saída de mapSpxMotoristaPayload(dados)
 * @param {object} [precheck] — { driverInfo?, existingDriverId? } do performSpxPrecheck
 * @returns {object} driver_info pronto p/ o botImportarMatched
 */
export function buildImportedDriverInfo(payload, precheck = {}) {
  const fromCadastro = {
    cpf: payload.cpf,
    driver_name: payload.driver_name,
    license_number: payload.license_number,
    license_type: payload.license_type,
    license_expire_date: payload.license_expire_date, // ISO — bot converte p/ unix
    birth_day: payload.birth_day, // ISO — idem
    contact_number: payload.contact_number,
    gender: payload.gender,
    city_name: payload.city_name,
    neighbourhood_name: payload.neighbourhood_name,
    street_name: payload.street_name,
    address_number: payload.address_number,
    zip_code: payload.zip_code,
  };
  const spxInfo =
    precheck?.driverInfo && typeof precheck.driverInfo === "object" ? precheck.driverInfo : {};
  const merged = { ...fromCadastro };
  for (const [k, v] of Object.entries(spxInfo)) {
    if (v !== null && v !== undefined && v !== "") merged[k] = v; // SPX prevalece onde tiver valor
  }
  if (precheck?.existingDriverId) merged.driver_id = precheck.existingDriverId;
  return merged;
}
