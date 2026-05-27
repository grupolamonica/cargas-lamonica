/**
 * Catálogo canônico de bancos brasileiros (COMPE/SPB).
 *
 * Usado em BankSelector (Steps C e E do cadastro v2) e validado server-side
 * em backend (validate-bank-compe). Manter sincronizado entre os dois lados.
 *
 * Fonte: Banco Central do Brasil - SPB/COMPE.
 */

export interface BrazilianBank {
  /** Código COMPE (3 dígitos, zero-padded). */
  compe: string;
  /** Nome comercial usual da instituição. */
  nome: string;
}

export const BRAZILIAN_BANKS: BrazilianBank[] = [
  { compe: "001", nome: "Banco do Brasil" },
  { compe: "003", nome: "Banco da Amazônia" },
  { compe: "004", nome: "Banco do Nordeste" },
  { compe: "021", nome: "Banestes" },
  { compe: "025", nome: "Banco Alfa" },
  { compe: "033", nome: "Santander" },
  { compe: "036", nome: "Banco Bradesco BBI" },
  { compe: "037", nome: "Banpará" },
  { compe: "041", nome: "Banrisul" },
  { compe: "047", nome: "Banese" },
  { compe: "070", nome: "BRB - Banco de Brasília" },
  { compe: "077", nome: "Banco Inter" },
  { compe: "082", nome: "Banco Topázio" },
  { compe: "084", nome: "Uniprime Norte do Paraná" },
  { compe: "085", nome: "Ailos" },
  { compe: "104", nome: "Caixa Econômica Federal" },
  { compe: "121", nome: "Banco Agibank" },
  { compe: "136", nome: "Unicred" },
  { compe: "151", nome: "Banco Nossa Caixa" },
  { compe: "184", nome: "Banco Itaú BBA" },
  { compe: "208", nome: "Banco BTG Pactual" },
  { compe: "212", nome: "Banco Original" },
  { compe: "218", nome: "Banco BS2" },
  { compe: "237", nome: "Bradesco" },
  { compe: "246", nome: "Banco ABC Brasil" },
  { compe: "260", nome: "Nu Pagamentos (Nubank)" },
  { compe: "265", nome: "Banco Fator" },
  { compe: "290", nome: "PagSeguro (PagBank)" },
  { compe: "323", nome: "Mercado Pago" },
  { compe: "335", nome: "Banco Digio" },
  { compe: "336", nome: "Banco C6" },
  { compe: "341", nome: "Itaú Unibanco" },
  { compe: "356", nome: "Banco Real" },
  { compe: "366", nome: "Banco Société Générale Brasil" },
  { compe: "380", nome: "PicPay" },
  { compe: "389", nome: "Banco Mercantil do Brasil" },
  { compe: "394", nome: "Banco Bradesco Financiamentos" },
  { compe: "399", nome: "HSBC" },
  { compe: "403", nome: "Cora SCFI" },
  { compe: "422", nome: "Banco Safra" },
  { compe: "456", nome: "Banco MUFG Brasil" },
  { compe: "464", nome: "Banco Sumitomo Mitsui Brasileiro" },
  { compe: "473", nome: "Banco Caixa Geral - Brasil" },
  { compe: "477", nome: "Citibank" },
  { compe: "479", nome: "Banco ItauBank" },
  { compe: "487", nome: "Deutsche Bank" },
  { compe: "604", nome: "Banco Industrial do Brasil" },
  { compe: "623", nome: "Banco Pan" },
  { compe: "633", nome: "Banco Rendimento" },
  { compe: "637", nome: "Banco Sofisa" },
  { compe: "643", nome: "Banco Pine" },
  { compe: "652", nome: "Itaú Unibanco Holding" },
  { compe: "655", nome: "Banco Votorantim (BV)" },
  { compe: "707", nome: "Banco Daycoval" },
  { compe: "735", nome: "Banco Neon" },
  { compe: "739", nome: "Banco Cetelem" },
  { compe: "741", nome: "Banco Ribeirão Preto" },
  { compe: "743", nome: "Banco Semear" },
  { compe: "745", nome: "Citibank N.A." },
  { compe: "748", nome: "Sicredi" },
  { compe: "756", nome: "Sicoob" },
];
