import { forwardRef } from "react";

export interface ShareCardPreviewData {
  dateTime: string;
  clienteNome?: string | null;
  origemCidade: string;
  origemEstado: string;
  destinoCidade: string;
  destinoEstado: string;
  carregamentoLabel: string;
  descargaLabel: string;
  kmLabel: string;
  routeDurationValue: string | null;
  pagamento: string;
  paymentDetails?: string | null;
  tipoVeiculo: string;
  clientLogoUrl?: string | null;
}

// Hardcoded colors — NO CSS variables so html-to-image captures correctly
const C = {
  primary: "#0a37b3",
  accent: "#22c55e",
  bg: "#f8fafc",
  border: "#e2e8f0",
  muted: "#64748b",
  fg: "#0f172a",
  badge: "#eff6ff",
  badgeBorder: "#bfdbfe",
  badgeText: "#1d4ed8",
};

const F = (size: number, weight: number | string = 400) =>
  `${weight} ${size}px 'Segoe UI', system-ui, -apple-system, sans-serif`;

export const ShareCardPreview = forwardRef<HTMLDivElement, ShareCardPreviewData>(
  (
    {
      dateTime,
      clienteNome,
      origemCidade,
      origemEstado,
      destinoCidade,
      destinoEstado,
      carregamentoLabel,
      descargaLabel,
      kmLabel,
      routeDurationValue,
      pagamento,
      paymentDetails,
      tipoVeiculo,
      clientLogoUrl,
    },
    ref,
  ) => {
    const originLabel = origemEstado ? `${origemCidade}, ${origemEstado}` : origemCidade;
    const destLabel = destinoEstado ? `${destinoCidade}, ${destinoEstado}` : destinoCidade;
    const clientName = clienteNome?.trim() || null;
    const hasKm = Boolean(kmLabel && kmLabel !== "A confirmar");
    const hasCarregamento = Boolean(carregamentoLabel && carregamentoLabel !== "A confirmar");
    const hasDescarga = Boolean(descargaLabel && descargaLabel !== "A confirmar");

    const lineHeight =
      hasCarregamento && hasDescarga ? 92 : hasCarregamento || hasDescarga ? 74 : 60;

    return (
      <div
        ref={ref}
        style={{
          width: 760,
          background: "#ffffff",
          borderRadius: 20,
          padding: "28px 32px 22px",
          fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
          boxSizing: "border-box",
          border: `1px solid ${C.border}`,
          color: C.fg,
        }}
      >
        {/* ── HEADER ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 22,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              background: C.badge,
              color: C.badgeText,
              border: `1px solid ${C.badgeBorder}`,
              borderRadius: 999,
              padding: "6px 14px",
              font: F(13, 600),
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: C.primary,
                flexShrink: 0,
              }}
            />
            {dateTime}
          </span>

          {clientLogoUrl ? (
            <img
              src={clientLogoUrl}
              alt={clientName ?? ""}
              style={{ height: 38, width: "auto", objectFit: "contain" }}
              crossOrigin="anonymous"
            />
          ) : clientName ? (
            <span
              style={{
                font: F(13, 600),
                color: C.muted,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: "5px 13px",
              }}
            >
              {clientName}
            </span>
          ) : null}
        </div>

        {/* ── ROUTE + BOX ── */}
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
          {/* Timeline */}
          <div
            style={{
              flex: 1,
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
              minWidth: 0,
            }}
          >
            {/* Dots + connecting line */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                paddingTop: 4,
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  border: `2.5px solid ${C.primary}`,
                  background: "#fff",
                  boxShadow: `0 0 0 3px rgba(10,55,179,0.1)`,
                }}
              />
              <div
                style={{
                  width: 2,
                  height: lineHeight,
                  background: "linear-gradient(180deg,#94a3b8,#64748b)",
                  margin: "4px 0",
                  borderRadius: 1,
                }}
              />
              <div
                style={{
                  width: 13,
                  height: 13,
                  borderRadius: "50%",
                  background: C.accent,
                  boxShadow: `0 0 0 3px rgba(34,197,94,0.15)`,
                }}
              />
            </div>

            {/* City labels */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <p
                style={{
                  font: F(10, 700),
                  textTransform: "uppercase",
                  letterSpacing: "0.14em",
                  color: C.muted,
                  margin: "0 0 2px",
                }}
              >
                Coleta
              </p>
              <p
                style={{
                  font: F(21, 800),
                  color: C.fg,
                  margin: 0,
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {originLabel}
              </p>
              {hasCarregamento ? (
                <p style={{ font: F(13, 600), color: C.primary, margin: "3px 0 0" }}>
                  {carregamentoLabel}
                </p>
              ) : null}

              <div style={{ height: hasCarregamento ? 18 : 24 }} />

              <p
                style={{
                  font: F(10, 700),
                  textTransform: "uppercase",
                  letterSpacing: "0.14em",
                  color: C.muted,
                  margin: "0 0 2px",
                }}
              >
                Entrega
              </p>
              <p
                style={{
                  font: F(21, 800),
                  color: C.fg,
                  margin: 0,
                  lineHeight: 1.2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {destLabel}
              </p>
              {hasDescarga ? (
                <p style={{ font: F(13, 600), color: C.accent, margin: "3px 0 0" }}>
                  {descargaLabel}
                </p>
              ) : null}
            </div>
          </div>

          {/* Route metric box */}
          {hasKm ? (
            <div
              style={{
                width: 190,
                flexShrink: 0,
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 18,
                padding: "15px 16px",
              }}
            >
              <div
                style={{
                  width: 34,
                  height: 34,
                  background: "#fff",
                  borderRadius: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  marginBottom: 10,
                  boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={C.primary}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polygon points="3 11 22 2 13 21 11 13 3 11" />
                </svg>
              </div>
              <p
                style={{
                  font: F(9, 700),
                  textTransform: "uppercase",
                  letterSpacing: "0.14em",
                  color: C.muted,
                  margin: "0 0 4px",
                }}
              >
                Percurso recomendado
              </p>
              <p style={{ font: F(22, 800), color: C.fg, margin: 0, lineHeight: 1.1 }}>
                {kmLabel}
              </p>
              {routeDurationValue ? (
                <>
                  <p
                    style={{
                      font: F(9, 700),
                      textTransform: "uppercase",
                      letterSpacing: "0.12em",
                      color: C.muted,
                      margin: "8px 0 2px",
                    }}
                  >
                    Tempo estimado
                  </p>
                  <p style={{ font: F(14, 600), color: C.muted, margin: 0 }}>
                    {routeDurationValue}
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ── DIVIDER ── */}
        <div style={{ height: 1, background: C.border, margin: "18px 0 16px" }} />

        {/* ── PAYMENT + VEHICLE ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <p
              style={{
                font: F(10, 700),
                textTransform: "uppercase",
                letterSpacing: "0.16em",
                color: C.muted,
                margin: "0 0 6px",
              }}
            >
              Pagamento total
            </p>
            <p
              style={{
                font: F(26, 800),
                color: C.primary,
                margin: "0 0 4px",
                lineHeight: 1.1,
              }}
            >
              {pagamento}
            </p>
            {paymentDetails ? (
              <p
                style={{
                  font: F(12, 400),
                  color: C.muted,
                  margin: 0,
                  lineHeight: 1.55,
                  maxWidth: 380,
                }}
              >
                {paymentDetails}
              </p>
            ) : null}
          </div>

          <div
            style={{
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 12,
              padding: "10px 16px",
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            <p
              style={{
                font: F(9, 700),
                textTransform: "uppercase",
                letterSpacing: "0.16em",
                color: C.muted,
                margin: "0 0 4px",
              }}
            >
              Veículo
            </p>
            <p style={{ font: F(16, 800), color: C.fg, margin: 0 }}>{tipoVeiculo}</p>
          </div>
        </div>

        {/* ── FOOTER ── */}
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <p style={{ font: F(11, 600), color: "#cbd5e1", margin: 0, letterSpacing: "0.04em" }}>
            lamonica.com.br
          </p>
        </div>
      </div>
    );
  },
);

ShareCardPreview.displayName = "ShareCardPreview";
