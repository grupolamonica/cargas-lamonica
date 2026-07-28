import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import NotificationsBell from "@/components/operator/NotificationsBell";

// react-query: mocka só useQuery/useQueryClient (padrão do repo p/ evitar flake de
// polling). useMutation segue real (usa o QueryClientProvider abaixo).
const { mockUseQuery, mockUseQueryClient } = vi.hoisted(() => ({
  mockUseQuery: vi.fn(),
  mockUseQueryClient: vi.fn(),
}));
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return { ...actual, useQuery: mockUseQuery, useQueryClient: mockUseQueryClient };
});

// spotAlert: todas as funções viram spies — é o que asseguramos (tocar/parar voz).
const spotAlert = vi.hoisted(() => ({
  unlockSpotAudio: vi.fn(),
  playSpotBeep: vi.fn(),
  showDesktopNotification: vi.fn(),
  startSpeakingLoop: vi.fn(),
  stopSpeakingLoop: vi.fn(),
  speakSpot: vi.fn(),
  ensureNotificationPermission: vi.fn().mockResolvedValue(false),
  notificationsSupported: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/spotAlert", () => spotAlert);

// sonner: captura o render do card p/ podermos clicar em "Dispensar".
const sonner = vi.hoisted(() => ({
  custom: vi.fn(() => "toast-id"),
  dismiss: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: sonner }));

const readModels = vi.hoisted(() => ({
  fetchOperatorNotifications: vi.fn(),
  markOperatorNotificationsSeen: vi.fn().mockResolvedValue({ ok: true, updated: 1 }),
  clearOperatorNotifications: vi.fn(),
  createTestSpotNotification: vi.fn(),
}));
vi.mock("@/services/readModels", () => readModels);

function notif(over: Record<string, unknown> = {}) {
  return {
    id: "n1",
    kind: "new_spot",
    title: "Nova carga spot: Simões Filho/BA → Jaboatão/PE",
    body: "08:00 · aceite na Programação",
    metadata: { lh: "LT-1", origem: "Simões Filho/BA", destino: "Jaboatão/PE" },
    seen: false,
    seen_at: null,
    created_at: "2026-07-28T12:00:00.000Z",
    ...over,
  };
}

function setData(value: unknown) {
  mockUseQuery.mockReturnValue({ data: value, error: null, isFetching: false, isLoading: false });
}

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationsBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationsBell — alarme de spot (DC-279)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseQueryClient.mockReturnValue({ invalidateQueries: vi.fn() });
    sonner.custom.mockReturnValue("toast-id");
    readModels.markOperatorNotificationsSeen.mockResolvedValue({ ok: true, updated: 1 });
  });

  it("TOCA o som quando chega spot FORECAST (metadata.is_forecast)", async () => {
    setData({ unseenCount: 0, items: [] }); // 1ª leva com dados só registra ids
    const { rerender } = renderBell();
    // chega um spot forecast
    setData({ unseenCount: 1, items: [notif({ id: "fc", metadata: { lh: "LT-FC", is_forecast: true, tipo: "forecast", origem: "A", destino: "B" } })] });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><NotificationsBell /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spotAlert.startSpeakingLoop).toHaveBeenCalledTimes(1));
    expect(spotAlert.playSpotBeep).toHaveBeenCalledTimes(1);
    expect(sonner.custom).toHaveBeenCalled(); // card visual também
  });

  it("NÃO toca o som quando o spot é ADHOC/FM Hub (só visual)", async () => {
    setData({ unseenCount: 0, items: [] });
    const { rerender } = renderBell();
    setData({ unseenCount: 1, items: [notif({ id: "ad", metadata: { lh: "LT-AD", is_forecast: false, tipo: "adhoc", origem: "A", destino: "B" } })] });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><NotificationsBell /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(sonner.custom).toHaveBeenCalled()); // card visual aparece
    expect(spotAlert.startSpeakingLoop).not.toHaveBeenCalled(); // mas SEM som
    expect(spotAlert.playSpotBeep).not.toHaveBeenCalled();
  });

  it("DISPENSAR marca as notificações do alarme como vistas (dispensar para todos)", async () => {
    setData({ unseenCount: 0, items: [] });
    const { rerender } = renderBell();
    setData({ unseenCount: 1, items: [notif({ id: "fc", metadata: { lh: "LT-FC", is_forecast: true, origem: "A", destino: "B" } })] });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><NotificationsBell /></MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(spotAlert.startSpeakingLoop).toHaveBeenCalled());

    // Renderiza o card do toast capturado e clica em "Dispensar".
    const renderCard = sonner.custom.mock.calls.at(-1)![0] as (id: string) => JSX.Element;
    const card = render(renderCard("toast-id"));
    fireEvent.click(card.getByRole("button", { name: "Dispensar" }));

    expect(readModels.markOperatorNotificationsSeen).toHaveBeenCalledWith({ ids: ["fc"] });
    expect(spotAlert.stopSpeakingLoop).toHaveBeenCalled();
  });

  it("PARA o loop em todas as telas quando a notificação do alarme vira `seen`", async () => {
    setData({ unseenCount: 0, items: [] });
    const { rerender } = renderBell();
    // Elemento NOVO a cada rerender (React ignora rerender com a mesma referência).
    const freshTree = () => (
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><NotificationsBell /></MemoryRouter>
      </QueryClientProvider>
    );
    setData({ unseenCount: 1, items: [notif({ id: "fc", seen: false, metadata: { lh: "LT-FC", is_forecast: true, origem: "A", destino: "B" } })] });
    rerender(freshTree());
    await waitFor(() => expect(spotAlert.startSpeakingLoop).toHaveBeenCalled());

    // Outro operador dispensou → a notificação vira seen=true no próximo poll.
    spotAlert.stopSpeakingLoop.mockClear();
    setData({ unseenCount: 0, items: [notif({ id: "fc", seen: true, metadata: { lh: "LT-FC", is_forecast: true, origem: "A", destino: "B" } })] });
    rerender(freshTree());
    await waitFor(() => expect(spotAlert.stopSpeakingLoop).toHaveBeenCalled());
  });
});
