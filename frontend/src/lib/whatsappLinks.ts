const MOBILE_WHATSAPP_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod/i;

function extractWhatsAppPayload(whatsappUrl: string) {
  try {
    const parsedUrl = new URL(whatsappUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    const isWaMeUrl = hostname === "wa.me" || hostname.endsWith(".wa.me");
    const isWhatsAppWebUrl = hostname === "api.whatsapp.com" || hostname.endsWith(".whatsapp.com");

    if (!isWaMeUrl && !isWhatsAppWebUrl) {
      return null;
    }

    const rawPhone = isWaMeUrl
      ? parsedUrl.pathname.replace(/\//g, "")
      : parsedUrl.searchParams.get("phone") || "";
    const phone = rawPhone.replace(/[^\d]/g, "");

    if (!phone) {
      return null;
    }

    return {
      phone,
      text: parsedUrl.searchParams.get("text") || "",
    };
  } catch {
    return null;
  }
}

export function shouldPreferDirectWhatsAppAppNavigation(userAgent = "") {
  return MOBILE_WHATSAPP_USER_AGENT_PATTERN.test(userAgent);
}

export function buildWhatsAppAppUrl(whatsappUrl: string) {
  const payload = extractWhatsAppPayload(whatsappUrl);

  if (!payload) {
    return null;
  }

  const query = new URLSearchParams({
    phone: payload.phone,
  });

  if (payload.text) {
    query.set("text", payload.text);
  }

  return `whatsapp://send?${query.toString()}`;
}
