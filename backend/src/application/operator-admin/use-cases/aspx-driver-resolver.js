import { driverNamesMatch, normNameForMatch } from "../sheet-monitor-enrichment.js";

// Resolve o driver_id do ASPX (roster de motoristas atribuíveis do SPX) a partir
// do NOME do motorista do sistema. O "Atribuir no ASPX" usava match EXATO por nome
// normalizado (só tirava acento/caixa) → falhava com divergências reais: conectivo
// ("WESLEY ARAUJO SOARES" ≠ "WESLEY DE ARAUJO SOARES"), ordem ("MARCOS JOSE" ≠
// "JOSE MARCOS") ou nome do meio. Aqui casamos com o mesmo matcher tolerante
// (driverNamesMatch) usado no resto do Monitor.
//
// É uma ação de ESCRITA no ASPX (Shopee) → TRAVA de ambiguidade: se mais de um
// motorista do roster casar o nome (homônimo ou correspondência ambígua), NÃO
// resolve — melhor "confira o CPF" do que atribuir para a pessoa errada. Usa o modo
// ESTRITO (minSubsetTokens:3) porque o roster é grande (nome genérico de 2 tokens
// não pode casar outra pessoa).

// Pré-normaliza o roster uma vez (evita re-normalizar milhares de nomes por carga).
// drivers: [{ name, driver_id }]. Retorna { list, byNorm }.
export function prepareAspxRoster(drivers) {
  const list = (drivers || [])
    .filter((d) => d && d.name != null && d.driver_id != null)
    .map((d) => ({ driver_id: d.driver_id, name: d.name, norm: normNameForMatch(d.name) }));
  const byNorm = new Map();
  for (const d of list) {
    const arr = byNorm.get(d.norm);
    if (arr) arr.push(d);
    else byNorm.set(d.norm, [d]);
  }
  return { list, byNorm };
}

// Retorna { driverId } no match único, ou { driverId: null, reason } quando não
// resolve (não encontrado / homônimo / ambíguo / sem motorista).
export function resolveAspxDriverId(motoristaName, prepared) {
  const target = normNameForMatch(motoristaName);
  if (!target) return { driverId: null, reason: "carga sem motorista no sistema" };
  const list = prepared?.list ?? [];
  const byNorm = prepared?.byNorm ?? new Map();

  // 1) Match EXATO normalizado (rápido, O(1)). >1 id = homônimo → não resolve.
  const exact = byNorm.get(target) || [];
  const exactIds = [...new Set(exact.map((d) => d.driver_id))];
  if (exactIds.length === 1) return { driverId: exact[0].driver_id };
  if (exactIds.length > 1) {
    return { driverId: null, reason: "motorista homônimo no ASPX (mesmo nome, CPFs diferentes) — confira o CPF" };
  }

  // 2) Match TOLERANTE (mesma pessoa: acento/conectivo/ordem/nome-do-meio), estrito.
  const fuzzy = list.filter((d) => driverNamesMatch(motoristaName, d.name, { minSubsetTokens: 3 }));
  const fuzzyIds = [...new Set(fuzzy.map((d) => d.driver_id))];
  if (fuzzyIds.length === 1) return { driverId: fuzzy[0].driver_id };
  if (fuzzyIds.length > 1) {
    return { driverId: null, reason: "correspondência ambígua no ASPX — confira o CPF" };
  }

  return { driverId: null, reason: "motorista não encontrado no ASPX" };
}
