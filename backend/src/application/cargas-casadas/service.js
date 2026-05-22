/**
 * Facade — re-exports dos use cases de cargas_casadas (pacote de cargas).
 * Mesmo pattern de operator-admin/service.js.
 */
export { createPacote } from "./use-cases/create-pacote.js";
export { updatePacote } from "./use-cases/update-pacote.js";
export { addCargaToPacote } from "./use-cases/add-carga.js";
export { removeCargaFromPacote } from "./use-cases/remove-carga.js";
export { reorderCargasInPacote } from "./use-cases/reorder-carga.js";
export { publishPacote } from "./use-cases/publish-pacote.js";
export { cancelPacote } from "./use-cases/cancel-pacote.js";
export { listPacotes } from "./use-cases/list-pacotes.js";
export { getPacote } from "./use-cases/get-pacote.js";
