import { beforeEach, describe, expect, it } from "vitest";

import {
  clearStoredRegistrationDrafts,
  purgeExpiredRegistrationDrafts,
} from "./localStorageHygiene";

/**
 * Higiene do localStorage (DC-283 / MED-4).
 *
 * O rascunho guarda a ficha inteira do motorista. O que estes testes travam:
 * que o prazo de 72h vale mesmo sem ninguém reabrir o rascunho, e que sair da
 * conta não deixa PII de um motorista visível para o próximo.
 */

const DRAFT = "lamonica-cadastro-v2-draft";
const AGORA = 1_770_000_000_000;

function gravarRascunho(dono: string, expiresAt: number | null) {
  window.localStorage.setItem(
    `${DRAFT}:${dono}`,
    JSON.stringify({
      driverUserId: dono,
      cargaId: "carga-1",
      // O que de fato mora aí.
      data: { motorista: { cpf: "11122233344", cnh: { registro: "123456789" } } },
      currentStep: "tela0",
      updatedAt: AGORA,
      ...(expiresAt === null ? {} : { expiresAt }),
    }),
  );
}

describe("higiene do localStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("apaga rascunho vencido e preserva o que ainda vale", () => {
    gravarRascunho("motorista-vencido", AGORA - 1);
    gravarRascunho("motorista-vivo", AGORA + 60_000);

    const removidos = purgeExpiredRegistrationDrafts(AGORA);

    expect(removidos).toBe(1);
    expect(window.localStorage.getItem(`${DRAFT}:motorista-vencido`)).toBeNull();
    expect(window.localStorage.getItem(`${DRAFT}:motorista-vivo`)).not.toBeNull();
  });

  it("apaga entrada sem prazo ou corrompida — PII sem validade nao fica", () => {
    gravarRascunho("sem-prazo", null);
    window.localStorage.setItem(`${DRAFT}:corrompido`, "{ isto nao e json");

    expect(purgeExpiredRegistrationDrafts(AGORA)).toBe(2);
    expect(window.localStorage.getItem(`${DRAFT}:sem-prazo`)).toBeNull();
    expect(window.localStorage.getItem(`${DRAFT}:corrompido`)).toBeNull();
  });

  it("nao encosta em chave de outro dominio", () => {
    window.localStorage.setItem("lamonica-operator-auth", "sessao-do-operador");
    window.localStorage.setItem("theme", "dark");
    gravarRascunho("alguem", AGORA - 1);

    purgeExpiredRegistrationDrafts(AGORA);

    // Limpar a sessao aqui derrubaria o operador junto quando ele e o motorista
    // dividem o mesmo navegador — quem cuida dessa chave e o supabase-js.
    expect(window.localStorage.getItem("lamonica-operator-auth")).toBe("sessao-do-operador");
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });

  it("no logout, nenhuma ficha sobra pro proximo usuario do aparelho", () => {
    gravarRascunho("motorista-a", AGORA + 60_000);
    gravarRascunho("motorista-b", AGORA + 60_000);
    window.localStorage.setItem("lamonica-driver-auth", "sessao");

    const removidos = clearStoredRegistrationDrafts();

    expect(removidos).toBe(2);
    // Nem o rascunho ainda dentro do prazo: o ponto e o aparelho compartilhado.
    expect(window.localStorage.getItem(`${DRAFT}:motorista-a`)).toBeNull();
    expect(window.localStorage.getItem(`${DRAFT}:motorista-b`)).toBeNull();
    // A sessao segue com o supabase-js, que a remove no proprio signOut.
    expect(window.localStorage.getItem("lamonica-driver-auth")).toBe("sessao");
  });

  it("nao sobra CPF nem CNH no storage depois da limpeza", () => {
    gravarRascunho("motorista-a", AGORA + 60_000);
    clearStoredRegistrationDrafts();

    const tudo = Object.keys(window.localStorage)
      .map((k) => window.localStorage.getItem(k) || "")
      .join("|");
    expect(tudo).not.toContain("11122233344");
    expect(tudo).not.toContain("123456789");
  });
});
