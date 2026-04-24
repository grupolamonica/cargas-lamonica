import { buildWhatsAppAppUrl, shouldPreferDirectWhatsAppAppNavigation } from "@/lib/whatsappLinks";

describe("whatsappLinks", () => {
  it("converts wa.me links into direct app links", () => {
    expect(buildWhatsAppAppUrl("https://wa.me/5571999999999?text=Oi%20time")).toBe(
      "whatsapp://send?phone=5571999999999&text=Oi+time",
    );
  });

  it("supports api.whatsapp.com send links", () => {
    expect(buildWhatsAppAppUrl("https://api.whatsapp.com/send?phone=5571912345678&text=Quero%20a%20carga")).toBe(
      "whatsapp://send?phone=5571912345678&text=Quero+a+carga",
    );
  });

  it("detects mobile devices for direct app navigation", () => {
    expect(shouldPreferDirectWhatsAppAppNavigation("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(true);
    expect(shouldPreferDirectWhatsAppAppNavigation("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
  });
});
