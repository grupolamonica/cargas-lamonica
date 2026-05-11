/**
 * Generates a PNG Blob of the "carga" share card using the Canvas 2D API.
 * Visually matches the lg:block desktop LoadCard layout.
 */

export interface ShareCardData {
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

// Canvas dimensions — logical pixels; actual render = W*DPR × H*DPR
const W = 760;
const H = 448;
const DPR = 2;
const PH = 32; // horizontal padding

// ── Colors — hardcoded to match desktop CSS variables ──────────────────────
const PRIMARY = "#0a37b3";           // hsl(224 94% 37%) = --primary (driver theme)
const PRIMARY_80 = "rgba(10,55,179,0.80)"; // primary/80 — carregamento dates
const PRIMARY_DARK = "#0a2ea6";      // hsl(226 88% 29%) — text-gradient-primary start
const ACCENT = "#24b773";            // hsl(152 67% 43%) = --accent (driver theme)
const ACCENT_80 = "rgba(36,183,115,0.80)"; // accent/80 — descarga dates
// admin-accent-tint gradient (route box background)
const ACCENT_TINT_TOP = "#f5f8ff";   // hsl(223 100% 98%)
const ACCENT_TINT_BOT = "#eef2fc";   // hsl(220 60% 96%)
const ACCENT_TINT_BORDER = "#dce5f7"; // hsl(var(--primary) / 0.12) approx
// admin-card-surface gradient (vehicle box background)
const CARD_SURFACE_TOP = "#ffffff";
const CARD_SURFACE_BOT = "#f7f9fc";  // hsl(220 36% 98%)
const MUTED_BG = "#f8fafc";          // muted/25 badge backgrounds
const MUTED_BORDER = "#e2e8f0";      // border/50
const MUTED_TEXT = "#64748b";        // slate-500 — muted-foreground
const MUTED_TEXT_80 = "#8295a5";     // muted-foreground/80 — section labels
const FG = "#0f172a";                // slate-950 — card-foreground
const FONTS = "'Segoe UI', system-ui, -apple-system, sans-serif";

// ── helpers ──────────────────────────────────────────────────────────────────

function setFont(ctx: CanvasRenderingContext2D, size: number, weight: number | string = 400) {
  ctx.font = `${weight} ${size}px ${FONTS}`;
}

function rrPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fillRR(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
  fill: string | CanvasGradient,
  stroke?: string,
  strokeW = 1,
) {
  rrPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeW;
    ctx.stroke();
  }
}

function linearGrad(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  stops: [number, string][],
): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [pos, color] of stops) g.addColorStop(pos, color);
  return g;
}

async function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    setTimeout(() => resolve(null), 6000);
    img.src = src;
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

export async function generateShareCardBlob(data: ShareCardData): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(DPR, DPR);
  ctx.textBaseline = "middle";

  const hasCarg = Boolean(data.carregamentoLabel && data.carregamentoLabel !== "A confirmar");
  const hasDesc = Boolean(data.descargaLabel && data.descargaLabel !== "A confirmar");
  const hasKm = Boolean(data.kmLabel && data.kmLabel !== "A confirmar");

  const clientImg = data.clientLogoUrl ? await loadImg(data.clientLogoUrl) : null;

  // ── BACKGROUND ──────────────────────────────────────────────────────────────
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = MUTED_BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  // ── BADGE (top-left) ────────────────────────────────────────────────────────
  const BADGE_Y = 24;
  const BADGE_H = 32;
  setFont(ctx, 13, 600);
  const btw = ctx.measureText(data.dateTime).width;
  const bw = btw + 46;
  fillRR(ctx, PH, BADGE_Y, bw, BADGE_H, 999, "#eff6ff", "#bfdbfe");

  // pulse dot
  ctx.fillStyle = PRIMARY;
  ctx.beginPath();
  ctx.arc(PH + 15, BADGE_Y + 16, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1d4ed8";
  setFont(ctx, 13, 600);
  ctx.fillText(data.dateTime, PH + 26, BADGE_Y + 16);

  // ── CLIENT LOGO / NAME (top-right) ──────────────────────────────────────────
  if (clientImg) {
    const lh = 34;
    const lw = Math.min((clientImg.width / clientImg.height) * lh, 130);
    ctx.drawImage(clientImg, W - PH - lw, BADGE_Y + (BADGE_H - lh) / 2, lw, lh);
  } else if (data.clienteNome?.trim()) {
    const cn = data.clienteNome.trim();
    setFont(ctx, 13, 500);
    const cw = ctx.measureText(cn).width + 28;
    const cx = W - PH - cw;
    const cy = BADGE_Y + 2;
    const ch = 28;
    fillRR(ctx, cx, cy, cw, ch, 10, MUTED_BG, MUTED_BORDER);
    ctx.fillStyle = MUTED_TEXT;
    ctx.fillText(cn, cx + 14, cy + 14);
  }

  // ── TIMELINE ────────────────────────────────────────────────────────────────
  // Desktop grid: grid-cols-[18px_minmax(0,1fr)_156px] gap-5
  // DOT_X = center of 18px dots column
  // CITY_X = PH + 18px (dots col) + 20px (gap-5) = PH + 38
  const DOT_X = PH + 9;   // 41
  const CITY_X = PH + 38; // 70

  const ORI_DOT = 100;
  const DST_DOT = 204;

  // Origin dot — hollow, primary stroke (border-primary bg-card h-3 w-3)
  ctx.strokeStyle = PRIMARY;
  ctx.lineWidth = 2.5;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(DOT_X, ORI_DOT, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Destination dot — solid accent (bg-accent h-3 w-3)
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(DOT_X, DST_DOT, 6, 0, Math.PI * 2);
  ctx.fill();

  // Connecting line — gradient (from-primary/35 via-primary/16 to-accent/35), w-px
  const lineGrad = linearGrad(ctx, DOT_X, ORI_DOT + 9, DOT_X, DST_DOT - 9, [
    [0, "rgba(10,55,179,0.35)"],
    [0.5, "rgba(10,55,179,0.16)"],
    [1, "rgba(36,183,115,0.35)"],
  ]);
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(DOT_X, ORI_DOT + 9);
  ctx.lineTo(DOT_X, DST_DOT - 9);
  ctx.stroke();

  // "COLETA" label — 10px 700 uppercase muted-foreground/80
  setFont(ctx, 10, 700);
  ctx.fillStyle = MUTED_TEXT_80;
  ctx.fillText("COLETA", CITY_X, ORI_DOT - 22);

  // Origin city — 1.15rem ≈ 18px bold (text-[1.15rem] font-bold)
  setFont(ctx, 18, 700);
  ctx.fillStyle = FG;
  const originLabel = data.origemEstado
    ? `${data.origemCidade}, ${data.origemEstado}`
    : data.origemCidade;
  ctx.fillText(originLabel, CITY_X, ORI_DOT + 2);

  // Carregamento date — 0.76rem ≈ 12px semibold primary/80
  if (hasCarg) {
    setFont(ctx, 12, 600);
    ctx.fillStyle = PRIMARY_80;
    ctx.fillText(data.carregamentoLabel, CITY_X, ORI_DOT + 20);
  }

  // "ENTREGA" label — 10px 700 uppercase muted-foreground/80
  setFont(ctx, 10, 700);
  ctx.fillStyle = MUTED_TEXT_80;
  ctx.fillText("ENTREGA", CITY_X, DST_DOT - 23);

  // Destination city — 18px bold
  setFont(ctx, 18, 700);
  ctx.fillStyle = FG;
  const destLabel = data.destinoEstado
    ? `${data.destinoCidade}, ${data.destinoEstado}`
    : data.destinoCidade;
  ctx.fillText(destLabel, CITY_X, DST_DOT + 2);

  // Descarga date — 12px semibold accent/80
  if (hasDesc) {
    setFont(ctx, 12, 600);
    ctx.fillStyle = ACCENT_80;
    ctx.fillText(data.descargaLabel, CITY_X, DST_DOT + 20);
  }

  // ── ROUTE BOX — admin-accent-tint, 156px wide (matches desktop grid col 3) ──
  if (hasKm) {
    const BX = W - PH - 156; // 572
    const BY = 76;
    const BW = 156;
    const BH = 170;

    // admin-accent-tint: linear-gradient(180deg, #f5f8ff, #eef2fc)
    const routeBg = linearGrad(ctx, BX, BY, BX, BY + BH, [
      [0, ACCENT_TINT_TOP],
      [1, ACCENT_TINT_BOT],
    ]);
    fillRR(ctx, BX, BY, BW, BH, 22, routeBg, ACCENT_TINT_BORDER);

    // Icon circle — h-8 w-8 rounded-2xl bg-primary/10
    fillRR(ctx, BX + 14, BY + 14, 32, 32, 10, "rgba(10,55,179,0.10)");

    // Navigation icon (polygon "3 11 22 2 13 21 11 13 3 11" scaled to 16×16 box)
    ctx.save();
    ctx.translate(BX + 14 + 16, BY + 14 + 16);
    ctx.strokeStyle = PRIMARY;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(-5, 1);
    ctx.lineTo(6, -7);
    ctx.lineTo(3, 7);
    ctx.lineTo(0, 3);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // "PERCURSO RECOMENDADO" — 9px 700 muted-foreground/80
    setFont(ctx, 9, 700);
    ctx.fillStyle = MUTED_TEXT_80;
    ctx.fillText("PERCURSO RECOMENDADO", BX + 14, BY + 60);

    // km value — 0.98rem ≈ 16px 700 (text-[0.98rem] font-bold)
    setFont(ctx, 16, 700);
    ctx.fillStyle = FG;
    ctx.fillText(data.kmLabel, BX + 14, BY + 78);

    if (data.routeDurationValue) {
      // "TEMPO ESTIMADO" — 9px 700 (text-[0.62rem] font-semibold uppercase)
      setFont(ctx, 9, 700);
      ctx.fillStyle = MUTED_TEXT_80;
      ctx.fillText("TEMPO ESTIMADO", BX + 14, BY + 112);

      // Duration — 0.82rem ≈ 13px semibold (text-[0.82rem] font-semibold)
      setFont(ctx, 13, 600);
      ctx.fillStyle = MUTED_TEXT;
      ctx.fillText(data.routeDurationValue, BX + 14, BY + 130);
    }
  }

  // ── DIVIDER — border-t border-border/50 ─────────────────────────────────────
  const DIV_Y = 268;
  ctx.strokeStyle = MUTED_BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PH, DIV_Y);
  ctx.lineTo(W - PH, DIV_Y);
  ctx.stroke();

  // ── PAYMENT ─────────────────────────────────────────────────────────────────
  let pY = DIV_Y + 18;

  // "PAGAMENTO TOTAL" — 10px 700 muted-foreground/80
  setFont(ctx, 10, 700);
  ctx.fillStyle = MUTED_TEXT_80;
  ctx.fillText("PAGAMENTO TOTAL", PH, pY);
  pY += 18;

  // Payment value — 1.7rem ≈ 27px 700 text-gradient-primary (dark → medium blue)
  setFont(ctx, 27, 700);
  ctx.fillStyle = PRIMARY_DARK;
  ctx.fillText(data.pagamento, PH, pY + 14);
  pY += 34;

  // Payment details — 0.78rem ≈ 12px muted-foreground, word-wrap
  if (data.paymentDetails) {
    setFont(ctx, 12, 400);
    ctx.fillStyle = MUTED_TEXT;
    const maxW = hasKm ? 370 : 650;
    const words = data.paymentDetails.split(" ");
    let line = "";
    for (const word of words) {
      const test = line + (line ? " " : "") + word;
      if (ctx.measureText(test).width > maxW) {
        ctx.fillText(line, PH, pY + 6);
        line = word;
        pY += 17;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, PH, pY + 6);
  }

  // ── VEHICLE BOX — admin-card-surface rounded-[22px] text-right ──────────────
  const VW = 148;
  const VX = W - PH - VW;
  const VY = DIV_Y + 14;
  const VH = 58;

  // admin-card-surface: linear-gradient(180deg, #fff, #f7f9fc)
  const vehBg = linearGrad(ctx, VX, VY, VX, VY + VH, [
    [0, CARD_SURFACE_TOP],
    [1, CARD_SURFACE_BOT],
  ]);
  fillRR(ctx, VX, VY, VW, VH, 22, vehBg, MUTED_BORDER);

  ctx.textAlign = "right";

  // "VEÍCULO" — 9px 700 muted-foreground/80
  setFont(ctx, 9, 700);
  ctx.fillStyle = MUTED_TEXT_80;
  ctx.fillText("VEÍCULO", VX + VW - 14, VY + 17);

  // Vehicle name — 1.02rem ≈ 16px 700 (text-[1.02rem] font-bold)
  setFont(ctx, 16, 700);
  ctx.fillStyle = FG;
  ctx.fillText(data.tipoVeiculo, VX + VW - 14, VY + 38);

  ctx.textAlign = "left";

  // ── FOOTER ──────────────────────────────────────────────────────────────────
  setFont(ctx, 11, 600);
  ctx.fillStyle = "#cbd5e1";
  ctx.textAlign = "right";
  ctx.fillText("lamonica.com.br", W - PH, H - 14);
  ctx.textAlign = "left";

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}
