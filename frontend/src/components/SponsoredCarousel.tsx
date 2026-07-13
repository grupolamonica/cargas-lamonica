import { useCallback, useEffect, useRef, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface Slide {
  src: string;
  alt: string;
  href: string;
  brand: string;
  tagline: string;
  cta: string;
  objectPosition?: string;
  /**
   * Quando true, a imagem ja contem TODO o conteudo visual (titulo + texto +
   * CTA renderizados pela equipe de design) e nao deve ganhar overlay extra
   * por cima. Usa object-contain para preservar a imagem inteira (sem crop)
   * com letterbox lateral quando o aspect ratio nao bate com 16/7.
   */
  selfContained?: boolean;
}

const SLIDES: Slide[] = [
  {
    src: "/sponsors/anuncie-aqui_1200x628.jpg",
    alt: "Anuncie aqui no portal Lamônica — produtos e acessórios, serviços e lubrificantes, pneus, lavagens e peças. Mais visibilidade, mais oportunidades, mais vendas.",
    href: "https://wa.me/557139950665?text=Ol%C3%A1%2C%20vi%20o%20espa%C3%A7o%20Anuncie%20aqui%20no%20portal%20Lam%C3%B4nica%20e%20quero%20anunciar%20meu%20produto%20ou%20servi%C3%A7o.",
    brand: "ANUNCIE AQUI",
    tagline: "Divulgue seu produto ou serviço no portal",
    cta: "Quero anunciar",
    selfContained: true,
  },
  {
    src: "/sponsors/agregar_fill.jpg",
    alt: "Venha agregar com a gente — rotas no eixo BA x PE, mais produtividade, operação mais dinâmica e atendimento diferenciado. Vem pra Lamônica.",
    href: "https://wa.me/557139950665?text=Ol%C3%A1%2C%20vi%20a%20campanha%20%22Venha%20Agregar%22%20no%20portal%20e%20quero%20agregar%20com%20a%20Lam%C3%B4nica.",
    brand: "LAMONICA AGREGADOS",
    tagline: "Agregue com a gente — eixo BA x PE",
    cta: "Quero agregar",
    selfContained: true,
  },
  {
    src: "/sponsors/lamonica-postos-pe.png",
    alt: "Lamônica Postos — nova parceria: 3 novos postos em Pernambuco com valor diferenciado para agregados e parceiros",
    href: "https://wa.me/557139950665?text=Ol%C3%A1%2C%20vi%20a%20parceria%20dos%20postos%20em%20PE%20no%20portal%20e%20quero%20saber%20mais%20sobre%20o%20valor%20diferenciado.",
    brand: "LAMONICA POSTOS",
    tagline: "Nova parceria — 3 postos em Pernambuco",
    cta: "Saiba mais",
    selfContained: true,
  },
  {
    src: "/sponsors/autolave_fill.jpg",
    alt: "Auto Lave — serviços de lavagem e lubrificação em geral: rodotrem, carretas, containers, silders, automóveis e caçambas. Rod. BA 093, Simões Filho — Bahia.",
    href: "https://wa.me/5571974006128?text=Ol%C3%A1%2C%20vim%20pelo%20portal%20Lamonica%20e%20quero%20um%20or%C3%A7amento%20de%20lavagem.",
    brand: "AUTO LAVE",
    tagline: "Lavagem de carretas, rodotrem, contêineres e mais",
    cta: "Falar no WhatsApp",
    selfContained: true,
  },
  {
    src: "/sponsors/parabrisa_X4_2407x1607.jpg",
    alt: "Rotula X Parabrisa — instalação profissional de para-brisas",
    href: "https://wa.me/5571987473049?text=Ol%C3%A1%2C%20vim%20pelo%20portal%20Lamonica%20e%20preciso%20de%20um%20or%C3%A7amento%20de%20parabrisa.",
    brand: "ROTULA X PARABRISA",
    tagline: "Para-brisas e vidros automotivos",
    cta: "Falar no WhatsApp",
  },
  {
    src: "/sponsors/parabrisa_X12_1000x667.jpg",
    alt: "Rotula X Parabrisa — troca de parabrisa em caminhões e automóveis",
    href: "https://wa.me/5571987473049?text=Ol%C3%A1%2C%20vim%20pelo%20portal%20Lamonica%20e%20preciso%20de%20um%20or%C3%A7amento%20de%20parabrisa.",
    brand: "ROTULA X PARABRISA",
    tagline: "Caminhões, carretas e automóveis",
    cta: "Pedir orçamento",
    objectPosition: "72% 8%",
  },
];

const AUTOPLAY_DELAY = 4000;

export function SponsoredCarousel({ inline = false }: { inline?: boolean }) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const autoplayRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopAutoplay = useCallback(() => {
    if (autoplayRef.current !== null) {
      clearInterval(autoplayRef.current);
      autoplayRef.current = null;
    }
  }, []);

  const startAutoplay = useCallback(() => {
    stopAutoplay();
    autoplayRef.current = setInterval(() => {
      emblaApi?.scrollNext();
    }, AUTOPLAY_DELAY);
  }, [emblaApi, stopAutoplay]);

  const scrollPrev = useCallback(() => {
    emblaApi?.scrollPrev();
    startAutoplay();
  }, [emblaApi, startAutoplay]);

  const scrollNext = useCallback(() => {
    emblaApi?.scrollNext();
    startAutoplay();
  }, [emblaApi, startAutoplay]);

  useEffect(() => {
    if (!emblaApi) return;
    const onSelect = () => setSelectedIndex(emblaApi.selectedScrollSnap());
    emblaApi.on("select", onSelect);
    return () => { emblaApi.off("select", onSelect); };
  }, [emblaApi]);

  useEffect(() => {
    startAutoplay();
    return stopAutoplay;
  }, [startAutoplay, stopAutoplay]);

  const wrapperClass = inline
    ? "w-full"
    : "w-full bg-[#0a0b0f] px-3 py-3 sm:px-4 sm:py-3.5";

  const innerClass = inline ? "w-full" : "mx-auto max-w-lg";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        <div className="relative overflow-hidden rounded-2xl">
          <div ref={emblaRef} className="overflow-hidden rounded-2xl">
            <div className="flex">
              {SLIDES.map((slide, i) => (
                <div key={i} className="min-w-0 shrink-0 grow-0 basis-full">
                  <a
                    href={slide.href}
                    target="_blank"
                    rel="noreferrer"
                    className="relative block overflow-hidden"
                    style={{ aspectRatio: "1536 / 785" }}
                    onClick={() => {
                      void fetch("/api/driver/sponsor-click", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ brand: slide.brand }),
                      }).catch(() => {});
                    }}
                  >
                    {/* Card na proporcao do banner self-contained (1536x785) — a banner
                        Lamonica Postos preenche 100% sem corte nem barra. As fotos de
                        patrocinio (Rotula) se adaptam via object-cover sem prejuizo. */}
                    <img
                      src={slide.src}
                      alt={slide.alt}
                      className="absolute inset-0 h-full w-full object-cover"
                      style={{ objectPosition: slide.objectPosition ?? "center" }}
                    />

                    {/* Overlay (gradiente + texto + CTA) so quando a imagem NAO e self-contained.
                        Slides self-contained ja trazem o copy embutido no design. */}
                    {!slide.selfContained ? (
                      <>
                        {/* gradient overlay */}
                        <div
                          className="absolute inset-0"
                          style={{
                            background:
                              "linear-gradient(to right, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.38) 55%, rgba(0,0,0,0.10) 100%)",
                          }}
                        />

                        {/* content */}
                        <div className="relative flex h-full flex-col justify-center px-4 py-3 sm:px-5">
                          <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/60 sm:text-[10px]">
                            Parceiro
                          </p>
                          <p className="mt-0.5 text-sm font-extrabold leading-tight tracking-wide text-white sm:text-base">
                            {slide.brand}
                          </p>
                          <p className="mt-0.5 text-[11px] text-white/75 sm:text-xs">
                            {slide.tagline}
                          </p>
                          <span className="mt-2.5 inline-flex w-fit items-center gap-1.5 rounded-full bg-green-500 px-3 py-1 text-[11px] font-semibold text-white shadow sm:text-xs">
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden="true">
                              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
                              <path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.852L0 24l6.335-1.508A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.007-1.375l-.36-.214-3.727.977.994-3.634-.235-.373A9.77 9.77 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z" />
                            </svg>
                            {slide.cta}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </a>
                </div>
              ))}
            </div>
          </div>

          {/* carousel-control-prev */}
          <button
            type="button"
            onClick={scrollPrev}
            aria-label="Previous"
            className="absolute left-0 top-0 flex h-full w-[12%] items-center justify-start pl-1.5 text-white/70 transition hover:text-white"
          >
            <ChevronLeft className="h-6 w-6 drop-shadow" />
            <span className="sr-only">Previous</span>
          </button>

          {/* carousel-control-next */}
          <button
            type="button"
            onClick={scrollNext}
            aria-label="Next"
            className="absolute right-0 top-0 flex h-full w-[12%] items-center justify-end pr-1.5 text-white/70 transition hover:text-white"
          >
            <ChevronRight className="h-6 w-6 drop-shadow" />
            <span className="sr-only">Next</span>
          </button>

          {/* carousel-indicators */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1.5">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                aria-current={i === selectedIndex}
                onClick={() => { emblaApi?.scrollTo(i); startAutoplay(); }}
                className={`h-[3px] rounded-full transition-all duration-300 ${
                  i === selectedIndex
                    ? "w-6 bg-white"
                    : "w-3 bg-white/45"
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
