/**
 * Facade — re-exports all operator-admin use cases.
 * Preserves existing import paths without changes.
 */
export { createOperatorCargo } from "./use-cases/create-cargo.js";
export { importOperatorCargas } from "./use-cases/import-cargas.js";
export { updateOperatorCargo } from "./use-cases/update-cargo.js";
export { duplicateOperatorCargo } from "./use-cases/duplicate-cargo.js";
export { toggleOperatorCargoStatus } from "./use-cases/toggle-cargo-status.js";
export { deleteOperatorCargo } from "./use-cases/delete-cargo.js";
export { createOperatorCliente } from "./use-cases/create-cliente.js";
export { updateOperatorCliente } from "./use-cases/update-cliente.js";
export { deleteOperatorCliente } from "./use-cases/delete-cliente.js";
export { attachClienteRota } from "./use-cases/attach-cliente-rota.js";
export { detachClienteRota } from "./use-cases/detach-cliente-rota.js";
export { listClienteRotas } from "./use-cases/list-cliente-rotas.js";
export { createOperatorRoute } from "./use-cases/create-route.js";
export { updateOperatorRoute } from "./use-cases/update-route.js";
export { saveRouteTrecho } from "./use-cases/save-route-trecho.js";
export { lookupCargoByCodigoViagem } from "./use-cases/lookup-cargo-by-codigo-viagem.js";
export { fetchCargoHistoryByLh } from "./use-cases/fetch-cargo-history.js";
export { fetchVehicleChecklist, fetchVehicleChecklistLevels } from "./use-cases/fetch-vehicle-checklist.js";
export { fetchOperatorDashboardReadModel, fetchDriverLoadsReadModel, fetchDriverLoadFacets } from "./use-cases/dashboard-read-model.js";
export { getHealthSnapshot } from "./use-cases/health-snapshot.js";
export { redactExpiredPublicLeadPii } from "./use-cases/redact-public-lead-pii.js";
export { updateOperatorDriverProfile } from "./use-cases/update-driver-profile.js";
export { lookupCachedAngelliraValidation, lookupCachedAngelliraPlate, syncDriverAngelliraValidation, syncVehicleAngelliraLookup } from "./use-cases/angellira-cache.js";
export { revalidateAllVehiclesAngellira } from "./use-cases/revalidate-vehicles-angellira.js";
