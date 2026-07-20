import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStaleChunkReloadFlag, importWithReload, reloadOnceForStaleChunk } from "@/lib/lazyWithRetry";

const RELOAD_KEY = "lmc:chunk-reloaded";

describe("lazyWithRetry", () => {
  let reloadMock: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    window.sessionStorage.clear();
    reloadMock = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { ...originalLocation, reload: reloadMock },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  it("resolve o módulo e limpa o flag de reload no sucesso", async () => {
    window.sessionStorage.setItem(RELOAD_KEY, "1");
    const mod = { default: () => null };
    const result = await importWithReload(async () => mod);
    expect(result).toBe(mod);
    expect(window.sessionStorage.getItem(RELOAD_KEY)).toBeNull();
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("recarrega uma vez quando o import dinâmico falha (chunk stale)", async () => {
    // Fica pendente de propósito (a página "recarregaria"); só validamos o efeito.
    void importWithReload(async () => {
      throw new Error("Failed to fetch dynamically imported module");
    });
    await vi.waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));
    expect(window.sessionStorage.getItem(RELOAD_KEY)).not.toBeNull();
  });

  it("propaga o erro sem recarregar de novo se já recarregou nesta sessão", async () => {
    window.sessionStorage.setItem(RELOAD_KEY, "1");
    await expect(
      importWithReload(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("reloadOnceForStaleChunk não recarrega (evita loop) quando o sessionStorage falha", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("sessionStorage indisponível");
    });
    expect(reloadOnceForStaleChunk()).toBe(false);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("clearStaleChunkReloadFlag não lança quando o sessionStorage falha", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("sessionStorage indisponível");
    });
    expect(() => clearStaleChunkReloadFlag()).not.toThrow();
  });
});
