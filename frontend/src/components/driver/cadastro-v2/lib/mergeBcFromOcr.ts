import type { BcData } from "../steps/BcDetalhesCavalo";

/**
 * Merge dos campos do sub-card "Detalhes do cavalo/carreta" com o que vem do
 * OCR do CRLV.
 *
 * Política: **OCR só preenche campos vazios**. Se o motorista já editou um
 * campo manualmente, o valor manual é preservado. Em 19/05 o sub-card foi
 * removido da UI (CRLV invisivel ao motorista), mas o merge segue alimentado
 * pelo OCR pra o payload final manter todos os campos.
 *
 * Uso em StepBCavalo (cavalo) e StepDCarretas (cada carreta).
 */
export function mergeBcFromOcr(
  prev: BcData | undefined,
  ocr: Partial<BcData>,
): BcData {
  return {
    ...(prev ?? {}),
    modelo: prev?.modelo || ocr.modelo,
    tipo: prev?.tipo || ocr.tipo,
    carroceria: prev?.carroceria || ocr.carroceria,
    ano_fabricacao: prev?.ano_fabricacao || ocr.ano_fabricacao,
    eixos: prev?.eixos || ocr.eixos,
    uf_emplacamento: prev?.uf_emplacamento || ocr.uf_emplacamento,
    cidade_emplacamento: prev?.cidade_emplacamento || ocr.cidade_emplacamento,
    ultimo_licenciamento: prev?.ultimo_licenciamento || ocr.ultimo_licenciamento,
  };
}
