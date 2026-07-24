// DC-279 — alerta sonoro + notificação do navegador para novas cargas spot.
// Tudo best-effort e silencioso em falha: se o browser bloquear áudio/notificação,
// o alerta visual do sino + toast continuam valendo.

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    return audioCtx;
  } catch {
    return null;
  }
}

/**
 * Destrava o áudio num GESTO do usuário (política de autoplay): cria/retoma o
 * AudioContext. Chamar ao abrir o sino garante que o 1º beep de spot toque mesmo
 * que o operador ainda não tenha interagido com a página (review DC-279 #9).
 */
export function unlockSpotAudio(): void {
  const ctx = getAudioCtx();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** Beep curto sintetizado (sem asset). Dois bips ascendentes, chamativo mas breve. */
export function playSpotBeep() {
  try {
    if (!getAudioCtx()) return;
    const ctx = audioCtx!;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const start = ctx.currentTime;
    [
      { at: 0, freq: 880 },
      { at: 0.18, freq: 1175 },
    ].forEach(({ at, freq }) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start + at);
      gain.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.15);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start + at);
      osc.stop(start + at + 0.16);
    });
  } catch {
    /* áudio indisponível — silencioso */
  }
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Pede permissão de notificação do navegador (idempotente; melhor chamar num gesto). */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    return (await Notification.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

/** Notificação do SO (visível mesmo com a aba em segundo plano). onClick foca a janela. */
export function showDesktopNotification(opts: {
  title: string;
  body?: string;
  tag?: string;
  onClick?: () => void;
}): void {
  try {
    if (!notificationsSupported() || Notification.permission !== "granted") return;
    const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* falha ao criar notificação — silencioso */
  }
}
