import { buildDriverLeadNotifications } from "@/lib/driverLeadNotifications";
import type { StoredLeadState } from "@/lib/driverLeadStorage";
import type { PublicLoadClaimStatusResponse } from "@/services/loadClaims";

function createStoredLeadState(overrides: Partial<StoredLeadState> = {}): StoredLeadState {
  return {
    loadId: "load-1",
    leadId: "lead-1",
    stage: "PRE_REGISTERED",
    form: {
      cpf: "123.456.789-01",
      phone: "(71) 99999-9999",
      horsePlate: "ABC1D23",
      trailerPlate: "DEF4G56",
      trailerPlate2: "",
      vehicleType: "CARRETA",
    },
    whatsappUrl: null,
    updatedAt: "2026-04-10T12:00:00.000Z",
    ...overrides,
  };
}

function createStatus(overrides: Partial<PublicLoadClaimStatusResponse> = {}): PublicLoadClaimStatusResponse {
  return {
    load: {
      id: "load-1",
      status: "OPEN",
      reservedUntil: null,
      origem: "Feira de Santana / BA",
      destino: "Salvador / BA",
      perfil: "CARRETA",
    },
    publicLead: null,
    claim: null,
    driverProfile: null,
    meta: {
      correlationId: "corr-1",
      publicLeadWhatsappConfigured: true,
    },
    ...overrides,
  };
}

describe("driverLeadNotifications", () => {
  it("creates a notification for pre-registrations that are still open", () => {
    const notifications = buildDriverLeadNotifications([
      {
        state: createStoredLeadState(),
        status: createStatus(),
        error: null,
      },
    ]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "PRE_REGISTERED",
      loadId: "load-1",
      title: "Candidatura salva nesta carga",
      origem: "Feira de Santana / BA",
      destino: "Salvador / BA",
    });
  });

  it("creates a notification for disputes that are already with the team", () => {
    const notifications = buildDriverLeadNotifications([
      {
        state: createStoredLeadState({
          stage: "QUEUED",
          updatedAt: "2026-04-10T12:05:00.000Z",
        }),
        status: createStatus({
          publicLead: {
            id: "lead-1",
            status: "QUEUED",
            queuedAt: "2026-04-10T12:06:00.000Z",
            whatsappClickedAt: "2026-04-10T12:06:00.000Z",
            approvedAt: null,
            approvedBy: null,
          },
        }),
        error: null,
      },
    ]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "QUEUED",
      title: "Candidatura em análise",
      happenedAt: "2026-04-10T12:06:00.000Z",
    });
  });

  it("prioritizes the approved notification once the load is reserved for the same lead", () => {
    const notifications = buildDriverLeadNotifications([
      {
        state: createStoredLeadState({
          stage: "QUEUED",
          updatedAt: "2026-04-10T12:05:00.000Z",
        }),
        status: createStatus({
          load: {
            id: "load-1",
            status: "RESERVED",
            reservedUntil: null,
            reservedAt: "2026-04-10T12:10:00.000Z",
            origem: "Feira de Santana / BA",
            destino: "Salvador / BA",
            perfil: "CARRETA",
          },
          publicLead: {
            id: "lead-1",
            status: "APPROVED",
            queuedAt: "2026-04-10T12:06:00.000Z",
            whatsappClickedAt: "2026-04-10T12:06:00.000Z",
            approvedAt: "2026-04-10T12:10:00.000Z",
            approvedBy: "operator-1",
          },
        }),
        error: null,
      },
    ]);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: "APPROVED",
      title: "Carga reservada para você",
      happenedAt: "2026-04-10T12:10:00.000Z",
    });
  });
});
