/**
 * DriverClientDetails — CONTAGEM DE REQUESTS do fan-out de cargas do cliente
 * (workstream de egress, PONTO 8).
 *
 * Por que este arquivo existe: a tela /motorista/cliente/:clienteId lista as
 * cargas abertas de UM cliente reusando o read model do portal
 * (`GET /api/driver/loads`, escopado por `clienteId`). Cada página é uma
 * execução COMPLETA do read model no servidor (varre todas as cargas OPEN +
 * JOINs e pagina em memória — ver `fetchDriverLoadsReadModelUncached`), então
 * cada request extra aqui custa uma varredura inteira, multiplicada por
 * motorista.
 *
 * O teto de linhas por request é do BACKEND, não do frontend:
 * `parseDriverLoadsQuery` (backend/src/domain/operator-admin/schemas.js) chama
 * `parsePaginationQuery(query, { defaultPageSize: 12, maxPageSize: 24 })`, e
 * `parsePaginationQuery` faz `Math.min(pageSize, maxPageSize)`. Ou seja: pedir
 * pageSize > 24 é silenciosamente reduzido a 24. O mínimo de requests para
 * listar L cargas é, portanto, `ceil(L / 24)` — e é o que a tela já emite.
 *
 * O `createFakeDriverLoadsServer` abaixo REPLICA esse clamp
 * (SERVER_MAX_PAGE_SIZE = 24) e o `buildPaginationMeta` do backend de
 * propósito: sem isso um teste poderia "provar" uma redução pedindo
 * pageSize=200 — algo que o servidor real não honra.
 *
 * Os testes travam as três propriedades que mantêm o fan-out no mínimo:
 *   1. pageSize enviado = 24 (o máximo aceito). Voltar ao default (12) DOBRA
 *      o número de varreduras.
 *   2. o loop PARA na última página (`meta.hasNextPage === false`) — não
 *      caminha até a trava de segurança de 40 páginas nem pede uma página
 *      vazia a mais.
 *   3. `clienteId` vai em TODA request (escopo por cliente preservado).
 * Mais o comportamento: o conjunto de cargas renderizado e a contagem do
 * cabeçalho batem exatamente com o total do servidor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { DriverLoadReadModelItem } from "@/services/readModels";

// --- Mocks ------------------------------------------------------------------

const CLIENTE_ID = "11111111-1111-1111-1111-111111111111";

const clienteRow = {
  id: CLIENTE_ID,
  nome: "Cliente Fan-out",
  descricao: "Cliente de teste",
  logo_url: null,
  forma_pagamento: "PIX",
  prazo_pagamento: "15 dias",
  exige_antt: true,
  exige_carga_monitorada: false,
  exige_rastreamento: true,
  exige_seguro: false,
  reputacao_boa_comunicacao: true,
  reputacao_bom_pagador: true,
  reputacao_carga_organizada: false,
  reputacao_liberacao_rapida: false,
  reputacao_pagamento_rapido: true,
  custom_exigencias: null,
  custom_reputacoes: null,
};

vi.mock("@/integrations/supabase/public-client", () => ({
  publicSupabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: clienteRow, error: null }),
    })),
  },
}));

const fetchDriverLoadsMock = vi.fn();
vi.mock("@/services/readModels", async () => {
  const actual = await vi.importActual<typeof import("@/services/readModels")>(
    "@/services/readModels",
  );
  return {
    ...actual,
    fetchDriverLoads: (params: Record<string, string | string[]>) => fetchDriverLoadsMock(params),
  };
});

import DriverClientDetails from "./DriverClientDetails";

// --- Fake server (espelha o backend) ----------------------------------------

/** Espelha `maxPageSize: 24` de parseDriverLoadsQuery. NAO aumentar aqui sem
 *  aumentar no backend — o clamp e do servidor. */
const SERVER_MAX_PAGE_SIZE = 24;

function buildLoad(index: number): DriverLoadReadModelItem {
  return {
    id: `carga-${String(index).padStart(3, "0")}`,
    data: "2026-09-10",
    horario: "08:30:00",
    origem: `Origem ${index}`,
    destino: `Destino ${index}`,
    perfil: "CARRETA",
    valor: 1_000 + index,
  } as unknown as DriverLoadReadModelItem;
}

interface RecordedCall {
  page: number;
  pageSize: number;
  clienteId: string | string[] | undefined;
}

function createFakeDriverLoadsServer(totalLoads: number) {
  const allLoads = Array.from({ length: totalLoads }, (_, index) => buildLoad(index));
  const calls: RecordedCall[] = [];

  // Espelha parsePositiveInteger + Math.min(pageSize, maxPageSize) do backend.
  const parsePositiveInteger = (value: unknown, fallback: number) => {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const handler = async (params: Record<string, string | string[]>) => {
    const page = parsePositiveInteger(params.page, 1);
    const pageSize = Math.min(parsePositiveInteger(params.pageSize, 12), SERVER_MAX_PAGE_SIZE);
    calls.push({ page, pageSize, clienteId: params.clienteId });

    const offset = (page - 1) * pageSize;
    const items = allLoads.slice(offset, offset + pageSize);
    // Espelha buildPaginationMeta (backend/src/domain/operator-admin/route-utils.js).
    const totalPages = Math.max(Math.ceil(totalLoads / pageSize), 1);

    return {
      items,
      summary: { totalCount: totalLoads, uniqueStateCount: 1, uniqueProfileCount: 1 },
      meta: {
        page,
        pageSize,
        totalCount: totalLoads,
        totalPages,
        hasNextPage: page < totalPages,
        maxPageSize: SERVER_MAX_PAGE_SIZE,
        correlationId: "test-correlation-id",
      },
    };
  };

  return { handler, calls, allLoads };
}

// --- Helpers ----------------------------------------------------------------

function renderClientDetails() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/motorista/cliente/${CLIENTE_ID}`]}>
        <Routes>
          <Route path="/motorista/cliente/:clienteId" element={<DriverClientDetails />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Links de carga renderizados na lista (exclui os "Voltar para cargas"). */
function renderedLoadHrefs(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a[href^="/motorista/cargas/"]')).map((anchor) =>
    anchor.getAttribute("href"),
  );
}

/**
 * Texto do cabecalho "N carga(s) disponivel(is)".
 *
 * Lido por textContent (e nao por getByRole/name): o JSX monta o plural em
 * text nodes separados (`{n} carga{"s"} disponivel{"is"}`) e o calculo de
 * accessible name insere espaco entre eles ("105 carga s disponivel is"),
 * enquanto textContent concatena igual ao que o motorista le na tela.
 */
function loadsCountHeadingText(container: HTMLElement) {
  const heading = Array.from(container.querySelectorAll("h2")).find((element) =>
    /dispon[íi]ve/i.test(element.textContent ?? ""),
  );
  return (heading?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Valida a CONTAGEM do cabecalho (a garantia de comportamento: o total exibido
 * tem que ser o total do servidor) sem travar a cauda da palavra.
 *
 * Motivo de nao asserir o texto inteiro: o componente concatena `disponivel` +
 * `is` e hoje renderiza "N cargas disponivelis" (erro de copy PRE-EXISTENTE —
 * o plural correto e "disponiveis"). Corrigir isso e mudanca visivel ao
 * motorista, fora do escopo deste workstream de performance; fica reportado,
 * nao silenciosamente consertado aqui.
 */
function expectLoadsCountHeading(container: HTMLElement, total: number) {
  const noun = total === 1 ? "carga" : "cargas";
  expect(loadsCountHeadingText(container)).toMatch(
    new RegExp(`^${total} ${noun} dispon[íi]ve`),
  );
}

// --- Testes -----------------------------------------------------------------

describe("DriverClientDetails — fan-out de paginas do read model", () => {
  beforeEach(() => {
    fetchDriverLoadsMock.mockReset();
  });

  it("emite exatamente ceil(total/24) requests — nao caminha as 40 paginas da trava", async () => {
    const totalLoads = 105; // caso real citado no DC-265 (105 cargas do cliente)
    const server = createFakeDriverLoadsServer(totalLoads);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expectLoadsCountHeading(container, totalLoads);
    });

    // Minimo dado o clamp de 24 do servidor: ceil(105/24) = 5.
    const expectedCalls = Math.ceil(totalLoads / SERVER_MAX_PAGE_SIZE);
    expect(expectedCalls).toBe(5);
    expect(fetchDriverLoadsMock).toHaveBeenCalledTimes(expectedCalls);
    // Guarda explicita contra o walk cego ate a trava de seguranca.
    expect(fetchDriverLoadsMock.mock.calls.length).toBeLessThan(40);

    // Paginas pedidas em sequencia, sem buraco e sem repeticao.
    expect(server.calls.map((call) => call.page)).toEqual([1, 2, 3, 4, 5]);

    // Comportamento preservado: TODAS as cargas do servidor aparecem na lista.
    expect(renderedLoadHrefs(container)).toEqual(
      server.allLoads.map((load) => `/motorista/cargas/${load.id}`),
    );
  });

  it("pede pageSize=24 (o maximo aceito pelo backend) em toda pagina", async () => {
    const server = createFakeDriverLoadsServer(50);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expectLoadsCountHeading(container, 50);
    });

    // Se alguem remover o pageSize explicito, o backend cai no default 12 e o
    // numero de varreduras quase dobra (5 em vez de 3 para 50 cargas).
    expect(server.calls.every((call) => call.pageSize === SERVER_MAX_PAGE_SIZE)).toBe(true);
    expect(fetchDriverLoadsMock).toHaveBeenCalledTimes(Math.ceil(50 / SERVER_MAX_PAGE_SIZE));
  });

  it("para na ultima pagina cheia — nao pede uma pagina vazia a mais", async () => {
    // 48 = 2 paginas EXATAS. hasNextPage e false na pagina 2, entao a pagina 3
    // (vazia) nunca deve ser pedida.
    const server = createFakeDriverLoadsServer(48);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expectLoadsCountHeading(container, 48);
    });

    expect(fetchDriverLoadsMock).toHaveBeenCalledTimes(2);
    expect(server.calls.map((call) => call.page)).toEqual([1, 2]);
    expect(renderedLoadHrefs(container)).toHaveLength(48);
  });

  it("cliente sem carga: 1 request so, e mostra o estado vazio", async () => {
    const server = createFakeDriverLoadsServer(0);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expect(screen.getByText(/Nenhuma carga ativa encontrada/i)).toBeInTheDocument();
    });

    expect(fetchDriverLoadsMock).toHaveBeenCalledTimes(1);
    expect(renderedLoadHrefs(container)).toHaveLength(0);
    expectLoadsCountHeading(container, 0);
  });

  it("escopa por clienteId em TODA request (nao vaza carga de outro cliente)", async () => {
    const server = createFakeDriverLoadsServer(30);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expectLoadsCountHeading(container, 30);
    });

    expect(server.calls).toHaveLength(2);
    expect(server.calls.every((call) => call.clienteId === CLIENTE_ID)).toBe(true);
  });

  it("uma unica carga: cabecalho no singular (contagem preservada)", async () => {
    const server = createFakeDriverLoadsServer(1);
    fetchDriverLoadsMock.mockImplementation(server.handler);

    const { container } = renderClientDetails();

    await waitFor(() => {
      expectLoadsCountHeading(container, 1);
    });

    expect(fetchDriverLoadsMock).toHaveBeenCalledTimes(1);
    expect(renderedLoadHrefs(container)).toEqual(["/motorista/cargas/carga-000"]);
  });
});
