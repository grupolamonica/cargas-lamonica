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
  // "Aquece" as vozes de TTS (getVoices costuma vir vazio na 1ª chamada até o
  // onvoiceschanged disparar) para o speakSpot já achar a voz pt-BR.
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    /* ignore */
  }
}

/**
 * Bip CURTO de atenção (dois toques rápidos) que antecede a fala — só pra o
 * operador olhar antes da voz começar. Best-effort: silencioso se bloquear áudio.
 */
export function playSpotBeep() {
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    const step = 0.13;
    const freqs = [988, 1319]; // dois bips ascendentes rápidos
    for (let i = 0; i < 2; i++) {
      const at = t0 + i * step;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freqs[i];
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.4, at + 0.008);
      gain.gain.setValueAtTime(0.4, at + step - 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + step - 0.01);
      osc.connect(gain).connect(master);
      osc.start(at);
      osc.stop(at + step);
    }
  } catch {
    /* áudio indisponível — silencioso */
  }
}

/**
 * Fala a frase em pt-BR (Web Speech API, voz do próprio sistema — sem asset).
 * "Spot disponível" (1 carga) ou "Programação disponível" (leva). Best-effort.
 */
export function speakSpot(text: string): void {
  if (typeof window === "undefined") return;
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel(); // interrompe qualquer fala anterior
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "pt-BR";
    u.rate = 1;
    u.pitch = 1;
    u.volume = 1;
    const voices = synth.getVoices();
    const pt = voices.find((v) => /pt[-_]?br/i.test(v.lang)) || voices.find((v) => /^pt/i.test(v.lang));
    if (pt) u.voice = pt;
    synth.speak(u);
  } catch {
    /* TTS indisponível — silencioso */
  }
}

// Loop de fala: repete a frase até o operador dispensar/aceitar (DC-279). Um teto
// de segurança evita "nag" infinito caso a aba seja abandonada.
let speechTimer: number | null = null;
let speechRepeats = 0;
const SPEECH_INTERVAL_MS = 3000; // menor intervalo entre as falas
const SPEECH_MAX_REPEATS = 60; // teto de segurança (~3 min)

/** Começa a repetir a frase (fala já e depois a cada ~5s) até stopSpeakingLoop(). */
export function startSpeakingLoop(text: string): void {
  if (typeof window === "undefined") return;
  stopSpeakingLoop();
  speechRepeats = 0;
  const tick = () => {
    // Se a janela sumiu (ex.: teardown de teste jsdom) ou bateu o teto, para o loop —
    // um tick órfão nunca deve tocar `window` fora de guarda (evita flaky "window is not defined").
    if (typeof window === "undefined" || speechRepeats >= SPEECH_MAX_REPEATS) {
      stopSpeakingLoop();
      return;
    }
    speechRepeats += 1;
    speakSpot(text);
  };
  tick();
  speechTimer = window.setInterval(tick, SPEECH_INTERVAL_MS);
}

/** Para o loop de fala (dispensar/aceitar). */
export function stopSpeakingLoop(): void {
  if (speechTimer !== null) {
    if (typeof window !== "undefined") window.clearInterval(speechTimer);
    speechTimer = null;
  }
  try {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
}

// Ícone raster (PNG) gerado uma vez via canvas — quadrado azul arredondado com um
// caminhão, para a notificação do SO ficar bonita/reconhecível (DC-279).
let spotIcon: string | null | undefined;
function spotIconDataUrl(): string | undefined {
  if (spotIcon !== undefined) return spotIcon ?? undefined;
  try {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      spotIcon = null;
      return undefined;
    }
    const r = 22;
    ctx.fillStyle = "#2563eb";
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.arcTo(size, 0, size, size, r);
    ctx.arcTo(size, size, 0, size, r);
    ctx.arcTo(0, size, 0, 0, r);
    ctx.arcTo(0, 0, size, 0, r);
    ctx.closePath();
    ctx.fill();
    ctx.font = "56px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🚚", size / 2, size / 2 + 4);
    spotIcon = canvas.toDataURL("image/png");
    return spotIcon;
  } catch {
    spotIcon = null;
    return undefined;
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
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: spotIconDataUrl(),
      badge: spotIconDataUrl(),
      requireInteraction: true, // fica na tela até o operador interagir (alerta importante)
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* falha ao criar notificação — silencioso */
  }
}
