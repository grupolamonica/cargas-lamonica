import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AdminLogin from "@/pages/AdminLogin";

vi.mock("@/components/Logo", () => ({
  default: () => <div>Logo</div>,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      getUser: vi.fn(),
      signOut: vi.fn(),
    },
  },
}));

describe("AdminLogin", () => {
  it(
    "nao expoe mais a auto-criacao publica de operadores",
    async () => {
      render(<AdminLogin />);

      expect(await screen.findByText("Entrar no cockpit operacional")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Criar conta" })).not.toBeInTheDocument();
      expect(screen.queryByText("Criar conta agora")).not.toBeInTheDocument();
    },
    15_000,
  );
});
