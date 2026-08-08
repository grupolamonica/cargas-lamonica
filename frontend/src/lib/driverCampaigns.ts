/**
 * Campanhas promocionais do portal do motorista (/motorista).
 *
 * Cada campanha é um card-pôster na lista de cargas que, ao ser tocado, aplica o
 * filtro da rota anunciada — o motorista não precisa procurar origem/destino no
 * dropdown depois de ver o banner.
 *
 * `origem`/`destino` são os valores CRUS do facet (`/api/driver/loads/facets`),
 * sem acento e em caixa alta — o backend casa por igualdade, então "Jaboatão"
 * (acentuado) devolve zero. A resolução para o valor exato da opção acontece em
 * runtime (ver `resolveCampaignFilterValue`), com estas strings como fallback.
 *
 * A janela é gravada em UTC porque a promoção é anunciada em horário de Brasília
 * (BRT = UTC-3) e o navegador do motorista pode estar em qualquer fuso.
 */
export interface DriverCampaign {
  id: string;
  /** Caminho público da arte (frontend/public/…). */
  imageSrc: string;
  /**
   * Como a arte ocupa o slot panorâmico do carrossel (1536x785).
   * `cover` — arte já é panorâmica, preenche 100% sem faixa lateral.
   * `contain` — arte fora de proporção; aparece inteira, com as laterais
   * preenchidas por uma cópia desfocada dela mesma.
   */
  fit: "cover" | "contain";
  /** Descrição textual da arte para leitor de tela. */
  alt: string;
  /** Rótulo da ação (usado no aria-label do slide). */
  ctaLabel: string;
  /** Quanto tempo o slide fica na tela antes de o carrossel virar. */
  autoplayDelayMs: number;
  /** Valor cru do facet de origem. */
  origem: string;
  /** Valor cru do facet de destino. */
  destino: string;
  /** Rótulo humano da rota (toast de confirmação). */
  rotaLabel: string;
  /** Início da vigência, em UTC. */
  startsAt: string;
  /** Fim da vigência, em UTC — depois disso o card some sozinho. */
  endsAt: string;
}

export const DRIVER_CAMPAIGNS: DriverCampaign[] = [
  {
    id: "campanha-8-8-simoes-jaboatao",
    imageSrc: "/campanhas/campanha-8-8-simoes-jaboatao.jpg",
    fit: "cover",
    alt:
      "Campanha 8.8: bônus de R$ 400,00 em todas as cargas participantes da rota " +
      "Simões Filho x Jaboatão dos Guararapes. Frete de R$ 5.300,00 mais R$ 400,00 " +
      "de bônus, total de R$ 5.700,00. Válido de 08/08 às 08h até 10/08 às 12h, " +
      "para motoristas que atingirem a meta de qualidade e cumprirem o agendamento.",
    ctaLabel: "Ver as cargas dessa campanha",
    /**
     * Dwell maior que o dos patrocinadores (10 s): a peça tem muita informação
     * (rota, janela de validade, frete + bônus + total) e no celular o motorista
     * não termina de ler antes do carrossel virar.
     */
    autoplayDelayMs: 25000,
    origem: "SIMOES FILHO",
    destino: "JABOATAO DOS GUARARAPES",
    rotaLabel: "Simões Filho → Jaboatão dos Guararapes",
    startsAt: "2026-08-08T11:00:00.000Z", // 08/08/2026 08:00 BRT
    endsAt: "2026-08-10T15:00:00.000Z", // 10/08/2026 12:00 BRT
  },
];

/** Campanha vigente agora — `null` fora da janela (o card simplesmente não renderiza). */
export const getActiveDriverCampaign = (
  now: Date = new Date(),
  campaigns: DriverCampaign[] = DRIVER_CAMPAIGNS,
): DriverCampaign | null => {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  return (
    campaigns.find((campaign) => {
      const start = Date.parse(campaign.startsAt);
      const end = Date.parse(campaign.endsAt);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
      return nowMs >= start && nowMs <= end;
    }) ?? null
  );
};
