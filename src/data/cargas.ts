export interface ClienteCarga {
  id: string;
  nome: string;
  cnpj: string;
  segmento: string;
  contato: string;
  telefone: string;
  email: string;
  endereco: string;
  cidade: string;
  estado: string;
  horarioAtendimento: string;
}

export interface CargaDetalhada {
  id: string;
  status: string;
  dateTime: string;
  dataCarregamento: string;
  dataDescarga: string;
  origemCidade: string;
  origemEstado: string;
  origemEndereco: string;
  origemReferencia: string;
  destinoCidade: string;
  destinoEstado: string;
  destinoEndereco: string;
  destinoReferencia: string;
  tipoVeiculo: string;
  distancia: string;
  pagamento: string;
  produto: string;
  peso: string;
  volume: string;
  tipoCarga: string;
  prazoAgendamento: string;
  documentos: string[];
  exigencias: string[];
  observacoes: string[];
  cliente: ClienteCarga;
}

export const cargasDetalhadas: CargaDetalhada[] = [
  {
    id: "88291",
    status: "Disponivel",
    dateTime: "Hoje, 14:30",
    dataCarregamento: "2026-04-04T14:30:00-03:00",
    dataDescarga: "2026-04-05T05:00:00-03:00",
    origemCidade: "Santos",
    origemEstado: "SP",
    origemEndereco: "Av. Portuaria, 1800 - Armazem 4",
    origemReferencia: "Retirada com conferencia no gate 3",
    destinoCidade: "Curitiba",
    destinoEstado: "PR",
    destinoEndereco: "Rua Joao Bettega, 4550 - CIC",
    destinoReferencia: "Entrega no centro de distribuicao ate 05:00",
    tipoVeiculo: "Carreta LS",
    distancia: "450 km",
    pagamento: "R$ 4.250",
    produto: "Papel kraft paletizado",
    peso: "27 toneladas",
    volume: "32 pallets",
    tipoCarga: "Carga seca",
    prazoAgendamento: "Agendar descarga com 3h de antecedencia",
    documentos: ["RNTRC ativo", "CIOT", "Seguro da carga", "Comprovante bancario"],
    exigencias: ["Rastreador ativo", "Lona sem avarias", "Motorista com treinamento portuario"],
    observacoes: ["Cliente exige foto da carreta antes da liberacao", "Carga pronta para coleta imediata"],
    cliente: {
      id: "CLI-401",
      nome: "Porto Sul Embalagens",
      cnpj: "18.224.330/0001-19",
      segmento: "Industria de embalagens",
      contato: "Mariana Araujo",
      telefone: "(13) 3321-8800",
      email: "operacao@portosul.com.br",
      endereco: "Av. Portuaria, 1800 - Santos",
      cidade: "Santos",
      estado: "SP",
      horarioAtendimento: "Seg a Sab, 06:00 as 22:00",
    },
  },
  {
    id: "88290",
    status: "Disponivel",
    dateTime: "Hoje, 13:15",
    dataCarregamento: "2026-04-04T13:15:00-03:00",
    dataDescarga: "2026-04-05T16:15:00-03:00",
    origemCidade: "Campinas",
    origemEstado: "SP",
    origemEndereco: "Rod. Dom Pedro I, km 87 - Galpao 2",
    origemReferencia: "Check-in na portaria 2 com nota e documento",
    destinoCidade: "Porto Alegre",
    destinoEstado: "RS",
    destinoEndereco: "Av. das Industrias, 9200 - Sarandi",
    destinoReferencia: "Entrega com agenda confirmada no turno da tarde",
    tipoVeiculo: "Truck",
    distancia: "1.120 km",
    pagamento: "R$ 7.800",
    produto: "Equipamentos de refrigeracao",
    peso: "14 toneladas",
    volume: "18 caixas industriais",
    tipoCarga: "Carga seca de alto valor",
    prazoAgendamento: "Descarga apenas com agendamento confirmado",
    documentos: ["RNTRC ativo", "Seguro RCTR-C", "Comprovante ANTT"],
    exigencias: ["Baixa em aplicativo do cliente", "Baú fechado", "Monitoramento 24h"],
    observacoes: ["Cliente prefere motorista com experiencia em industria", "Sem pernoite no patio"],
    cliente: {
      id: "CLI-402",
      nome: "FrioMax Solutions",
      cnpj: "42.810.991/0001-50",
      segmento: "Industria HVAC",
      contato: "Eduardo Menezes",
      telefone: "(19) 4004-7788",
      email: "logistica@friomax.com.br",
      endereco: "Rod. Dom Pedro I, km 87 - Campinas",
      cidade: "Campinas",
      estado: "SP",
      horarioAtendimento: "Seg a Sex, 07:00 as 18:00",
    },
  },
  {
    id: "88289",
    status: "Disponivel",
    dateTime: "Hoje, 12:00",
    dataCarregamento: "2026-04-04T12:00:00-03:00",
    dataDescarga: "2026-04-05T15:30:00-03:00",
    origemCidade: "Sao Paulo",
    origemEstado: "SP",
    origemEndereco: "Rua das Oficinas, 955 - Mooca",
    origemReferencia: "Carga sai por ordem de chegada",
    destinoCidade: "Caxias do Sul",
    destinoEstado: "RS",
    destinoEndereco: "Av. Perimetral Bruno Segalla, 7010",
    destinoReferencia: "Descarga pelo doca 5",
    tipoVeiculo: "Carreta",
    distancia: "1.050 km",
    pagamento: "R$ 6.900",
    produto: "Autopecas paletizadas",
    peso: "23 toneladas",
    volume: "28 pallets",
    tipoCarga: "Carga seca",
    prazoAgendamento: "Janela de descarga entre 08:00 e 12:00",
    documentos: ["RNTRC ativo", "Manifesto", "Comprovante de seguradora"],
    exigencias: ["Cinta para amarracao", "Entrega sem avaria", "Atualizacao via WhatsApp"],
    observacoes: ["Motorista deve usar EPI na descarga", "Cliente aceita antecipacao se avisado"],
    cliente: {
      id: "CLI-403",
      nome: "Metal Parts Brasil",
      cnpj: "05.330.129/0001-66",
      segmento: "Autopecas",
      contato: "Renata Fiorin",
      telefone: "(11) 2890-5300",
      email: "supply@metalparts.com.br",
      endereco: "Rua das Oficinas, 955 - Sao Paulo",
      cidade: "Sao Paulo",
      estado: "SP",
      horarioAtendimento: "Seg a Sex, 08:00 as 17:30",
    },
  },
  {
    id: "88288",
    status: "Disponivel",
    dateTime: "Hoje, 11:40",
    dataCarregamento: "2026-04-04T11:40:00-03:00",
    dataDescarga: "2026-04-05T00:10:00-03:00",
    origemCidade: "Guarulhos",
    origemEstado: "SP",
    origemEndereco: "Rua do Aeroporto, 550 - Cidade Industrial",
    origemReferencia: "Apresentar liberacao do expedidor na doca",
    destinoCidade: "Florianopolis",
    destinoEstado: "SC",
    destinoEndereco: "Rod. SC-401, 3400 - Saco Grande",
    destinoReferencia: "Entrega em operacao noturna",
    tipoVeiculo: "Bitrem",
    distancia: "750 km",
    pagamento: "R$ 5.500",
    produto: "Bebidas nao alcoolicas",
    peso: "29 toneladas",
    volume: "36 pallets",
    tipoCarga: "Carga seca",
    prazoAgendamento: "Descarga programada para virada de turno",
    documentos: ["CIOT", "RNTRC ativo", "Comprovante de curso MOPP nao obrigatorio"],
    exigencias: ["Tacografo regular", "Check-list do bau", "Proibido transbordo"],
    observacoes: ["Cliente aceita substituicao de veiculo antes da coleta", "Contato da descarga responde por telefone"],
    cliente: {
      id: "CLI-404",
      nome: "Costa Leste Distribuicao",
      cnpj: "61.227.987/0001-04",
      segmento: "Distribuicao alimentar",
      contato: "Paulo Farias",
      telefone: "(11) 2440-9900",
      email: "operacoes@costaleste.com.br",
      endereco: "Rua do Aeroporto, 550 - Guarulhos",
      cidade: "Guarulhos",
      estado: "SP",
      horarioAtendimento: "24 horas",
    },
  },
  {
    id: "88287",
    status: "Disponivel",
    dateTime: "Hoje, 10:20",
    dataCarregamento: "2026-04-04T10:20:00-03:00",
    dataDescarga: "2026-04-04T21:50:00-03:00",
    origemCidade: "Sorocaba",
    origemEstado: "SP",
    origemEndereco: "Av. Independencia, 2100 - Distrito Industrial",
    origemReferencia: "Retirar documento no escritorio fiscal",
    destinoCidade: "Londrina",
    destinoEstado: "PR",
    destinoEndereco: "Rua Tiete, 1450 - Parque Industrial",
    destinoReferencia: "Descarga na lateral do galpao principal",
    tipoVeiculo: "Carreta LS",
    distancia: "520 km",
    pagamento: "R$ 3.800",
    produto: "Tintas embaladas",
    peso: "21 toneladas",
    volume: "24 pallets",
    tipoCarga: "Carga fracionada consolidada",
    prazoAgendamento: "Coleta e descarga no mesmo dia",
    documentos: ["RNTRC ativo", "Ficha de emergencia", "Seguro da operacao"],
    exigencias: ["Proibido atraso superior a 30 minutos", "Uso de cinta e calco", "Comprovacao de entrega via foto"],
    observacoes: ["Carga exige cuidado com empilhamento", "Sem devolucao de pallet"],
    cliente: {
      id: "CLI-405",
      nome: "ColorPrime Quimica",
      cnpj: "77.554.002/0001-81",
      segmento: "Industria quimica",
      contato: "Juliana Serra",
      telefone: "(15) 3201-4400",
      email: "transporte@colorprime.com.br",
      endereco: "Av. Independencia, 2100 - Sorocaba",
      cidade: "Sorocaba",
      estado: "SP",
      horarioAtendimento: "Seg a Sex, 06:30 as 16:30",
    },
  },
  {
    id: "88286",
    status: "Disponivel",
    dateTime: "Hoje, 09:50",
    dataCarregamento: "2026-04-04T09:50:00-03:00",
    dataDescarga: "2026-04-05T14:20:00-03:00",
    origemCidade: "Ribeirao Preto",
    origemEstado: "SP",
    origemEndereco: "Anel Viario Sul, km 311 - Patio 7",
    origemReferencia: "Entrada pela balanca principal",
    destinoCidade: "Novo Hamburgo",
    destinoEstado: "RS",
    destinoEndereco: "Rua Guia Lopes, 890 - Canudos",
    destinoReferencia: "Entrega mediante conferencia cega",
    tipoVeiculo: "Truck",
    distancia: "1.200 km",
    pagamento: "R$ 8.100",
    produto: "Insumos agricolas ensacados",
    peso: "15 toneladas",
    volume: "300 sacas",
    tipoCarga: "Carga seca",
    prazoAgendamento: "Cliente aceita entrega antecipada mediante aviso",
    documentos: ["RNTRC ativo", "CIOT", "Apolice do seguro"],
    exigencias: ["Lona obrigatoria", "Motorista com app do cliente", "Atualizacao de macro a cada 4 horas"],
    observacoes: ["Entrega com fila media de 1h30", "Necessario contato 1h antes de chegar"],
    cliente: {
      id: "CLI-406",
      nome: "AgroBase Insumos",
      cnpj: "29.004.187/0001-71",
      segmento: "Agronegocio",
      contato: "Diego Fossati",
      telefone: "(16) 3512-8800",
      email: "fretes@agrobase.com.br",
      endereco: "Anel Viario Sul, km 311 - Ribeirao Preto",
      cidade: "Ribeirao Preto",
      estado: "SP",
      horarioAtendimento: "Seg a Sab, 05:00 as 20:00",
    },
  },
];

export function getCargaById(id: string) {
  return cargasDetalhadas.find((carga) => carga.id === id);
}

export function getCargaPath(id: string) {
  return `/cargas/${id}`;
}

export function getCargaShareUrl(origin: string, id: string) {
  const normalizedOrigin = origin.endsWith("/") ? origin.slice(0, -1) : origin;

  return `${normalizedOrigin}${getCargaPath(id)}`;
}
