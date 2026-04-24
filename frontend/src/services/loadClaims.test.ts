import { afterEach, describe, expect, it, vi } from "vitest";

import { registerDriverAccount } from "@/services/loadClaims";

const driverRegistrationPayload = {
  email: "motorista@teste.com",
  password: "123456",
  profile: {
    full_name: "Motorista Teste",
    phone: "71999999999",
    document_number: "123456789",
    vehicle_profile: "CARRETA",
    documents_valid: true,
    antt_valid: true,
    tracking_enabled: true,
    insurance_valid: true,
    monitoring_capable: true,
    allowed_regions: ["BA"],
    metadata: {},
  },
};

describe("loadClaims requestJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("propaga a mensagem de erro retornada pela API em JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "This email is already registered." }), {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        }),
      ),
    );

    await expect(registerDriverAccount(driverRegistrationPayload)).rejects.toThrow("This email is already registered.");
  });

  it("retorna erro legivel quando a API responde sem corpo JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 500,
        }),
      ),
    );

    await expect(registerDriverAccount(driverRegistrationPayload)).rejects.toThrow(
      "A API /api/drivers/register respondeu sem corpo (500).",
    );
  });
});
