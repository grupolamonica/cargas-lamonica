import { useEffect, useMemo, useState } from "react";

import {
  buildClientLogoSourceCandidates,
  findVisibleClientLogoBounds,
  removeLightNeutralBackground,
  shouldApplyWhiteSurfaceTreatmentForClientLogo,
  shouldUseAnonymousCrossOriginForClientLogo,
} from "@/lib/clientLogo";
import { cn } from "@/lib/utils";

interface ClientLogoProps {
  name: string;
  logoUrl?: string | null;
  alt?: string;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
  noBg?: boolean;
}

function buildClientInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

const ClientLogo = ({ name, logoUrl, alt, className, imageClassName, fallbackClassName, noBg = false }: ClientLogoProps) => {
  const [hasImageError, setHasImageError] = useState(false);
  const [displayLogoUrl, setDisplayLogoUrl] = useState("");
  const [usesWhiteSurfaceTreatment, setUsesWhiteSurfaceTreatment] = useState(false);
  const normalizedLogoUrl = logoUrl?.trim() || "";
  const logoSourceCandidates = useMemo(() => buildClientLogoSourceCandidates(normalizedLogoUrl), [normalizedLogoUrl]);
  const shouldRenderImage = Boolean(displayLogoUrl) && !hasImageError;
  const initials = useMemo(() => buildClientInitials(name) || "CL", [name]);

  useEffect(() => {
    setHasImageError(false);
    setDisplayLogoUrl(normalizedLogoUrl);
    setUsesWhiteSurfaceTreatment(false);

    if (!logoSourceCandidates.length) {
      return;
    }

    let isActive = true;
    let activeImage: HTMLImageElement | null = null;

    const loadCandidate = (candidateIndex: number) => {
      const currentSource = logoSourceCandidates[candidateIndex];

      if (!currentSource) {
        setHasImageError(true);
        return;
      }

      const image = new Image();
      activeImage = image;
      image.decoding = "async";
      const shouldProcessCandidateOnCanvas = shouldUseAnonymousCrossOriginForClientLogo(currentSource);

      if (shouldProcessCandidateOnCanvas) {
        image.crossOrigin = "anonymous";
      }

      image.onload = () => {
        if (!isActive) {
          return;
        }

        if (!shouldProcessCandidateOnCanvas) {
          setUsesWhiteSurfaceTreatment(shouldApplyWhiteSurfaceTreatmentForClientLogo(currentSource));
          setDisplayLogoUrl(currentSource);
          return;
        }

        try {
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;

          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          });

          if (!context) {
            setDisplayLogoUrl(currentSource);
            return;
          }

          context.drawImage(image, 0, 0);

          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          const cleanedPixels = removeLightNeutralBackground(imageData.data, canvas.width, canvas.height);
          imageData.data.set(cleanedPixels);
          context.putImageData(imageData, 0, 0);

          const visibleBounds = findVisibleClientLogoBounds(cleanedPixels, canvas.width, canvas.height);

          if (visibleBounds && (visibleBounds.width < canvas.width || visibleBounds.height < canvas.height)) {
            const trimmedCanvas = document.createElement("canvas");
            trimmedCanvas.width = visibleBounds.width;
            trimmedCanvas.height = visibleBounds.height;

            const trimmedContext = trimmedCanvas.getContext("2d");

            if (trimmedContext) {
              const trimmedImageData = context.getImageData(
                visibleBounds.x,
                visibleBounds.y,
                visibleBounds.width,
                visibleBounds.height,
              );
              trimmedContext.putImageData(trimmedImageData, 0, 0);
              setUsesWhiteSurfaceTreatment(false);
              setDisplayLogoUrl(trimmedCanvas.toDataURL("image/png"));
              return;
            }
          }

          setUsesWhiteSurfaceTreatment(false);
          setDisplayLogoUrl(canvas.toDataURL("image/png"));
        } catch {
          setUsesWhiteSurfaceTreatment(shouldApplyWhiteSurfaceTreatmentForClientLogo(currentSource));
          setDisplayLogoUrl(currentSource);
        }
      };

      image.onerror = () => {
        if (!isActive) {
          return;
        }

        if (candidateIndex < logoSourceCandidates.length - 1) {
          loadCandidate(candidateIndex + 1);
          return;
        }

        setHasImageError(true);
      };

      image.src = currentSource;
    };

    loadCandidate(0);

    return () => {
      isActive = false;
      if (activeImage) {
        activeImage.onload = null;
        activeImage.onerror = null;
      }
    };
  }, [logoSourceCandidates]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[28px] border border-white/70 shadow-[0_24px_54px_-32px_hsl(215_25%_12%/0.28)]",
        !noBg && (usesWhiteSurfaceTreatment ? "bg-white" : "admin-card-surface"),
        className,
      )}
    >
      {shouldRenderImage ? (
        <img
          src={displayLogoUrl}
          alt={alt || `Logo de ${name}`}
          className={cn(
            "h-full w-full object-contain p-4",
            usesWhiteSurfaceTreatment && "bg-white",
            imageClassName,
          )}
          loading="lazy"
          decoding="async"
          draggable="false"
          onError={() => setHasImageError(true)}
          style={
            usesWhiteSurfaceTreatment
              ? {
                  filter: "brightness(1.16) contrast(1.04) saturate(1.08)",
                }
              : undefined
          }
        />
      ) : (
        <div
          className={cn(
            "flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top_left,hsl(224_100%_93%),transparent_42%),linear-gradient(135deg,hsl(224_48%_16%),hsl(223_65%_28%))] text-white",
            fallbackClassName,
          )}
          aria-label={alt || `Logo de ${name}`}
        >
          <span className="text-[clamp(1.4rem,3vw,2.5rem)] font-black tracking-[0.14em]">{initials}</span>
        </div>
      )}
    </div>
  );
};

export default ClientLogo;
