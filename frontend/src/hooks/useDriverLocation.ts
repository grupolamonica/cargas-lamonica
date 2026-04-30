import { useEffect, useState } from "react";

export interface DriverLocation {
  city: string;
  uf: string;
}

interface UseDriverLocationResult {
  location: DriverLocation | null;
  loading: boolean;
  error: string | null;
}

async function resolveByIP(): Promise<DriverLocation | null> {
  const apis: Array<() => Promise<DriverLocation | null>> = [
    async () => {
      const res = await fetch("https://ipapi.co/json/", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const d = await res.json();
      const city: string = d.city ?? "";
      const uf: string = (d.region_code ?? "").toUpperCase();
      return city || uf ? { city, uf } : null;
    },
    async () => {
      const res = await fetch("https://ip-api.com/json/?fields=city,region&lang=pt-BR", {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const d = await res.json();
      if (d.status === "fail") return null;
      const city: string = d.city ?? "";
      const uf: string = (d.region ?? "").toUpperCase().slice(0, 2);
      return city || uf ? { city, uf } : null;
    },
    async () => {
      const res = await fetch("https://ipwho.is/", { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const d = await res.json();
      if (!d.success) return null;
      const city: string = d.city ?? "";
      const uf: string = (d.region_code ?? "").toUpperCase();
      return city || uf ? { city, uf } : null;
    },
  ];

  for (const api of apis) {
    try {
      const result = await api();
      if (result) return result;
    } catch {
      // try next
    }
  }
  return null;
}

async function resolveByGPS(latitude: number, longitude: number): Promise<DriverLocation> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&accept-language=pt-BR`,
    { headers: { "User-Agent": "Lamonica-Cargas-Portal/1.0" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error("Falha ao reverter coordenadas");
  const data = await res.json();
  const addr = data.address ?? {};
  const city: string = addr.city ?? addr.town ?? addr.municipality ?? addr.village ?? "";
  const stateCode: string = addr["ISO3166-2-lvl4"] ?? addr.state_code ?? "";
  const uf = (stateCode.includes("-") ? stateCode.split("-").pop() ?? "" : stateCode).toUpperCase();
  return { city, uf };
}

export function useDriverLocation(): UseDriverLocationResult {
  const [location, setLocation] = useState<DriverLocation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);

    // Non-HTTPS: browsers block navigator.geolocation. Fall back to IP geolocation.
    if (!window.isSecureContext) {
      resolveByIP()
        .then((loc) => {
          if (loc) setLocation(loc);
          else setError("Localização não disponível");
        })
        .finally(() => setLoading(false));
      return;
    }

    if (!navigator.geolocation) {
      resolveByIP()
        .then((loc) => {
          if (loc) setLocation(loc);
          else setError("Geolocalização não suportada");
        })
        .finally(() => setLoading(false));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const loc = await resolveByGPS(position.coords.latitude, position.coords.longitude);
          setLocation(loc);
        } catch {
          // GPS resolved but geocoding failed — try IP as fallback
          const ipLoc = await resolveByIP();
          if (ipLoc) setLocation(ipLoc);
          else setError("Não foi possível obter localização");
        } finally {
          setLoading(false);
        }
      },
      async () => {
        // Permission denied — try IP as fallback
        const ipLoc = await resolveByIP();
        if (ipLoc) setLocation(ipLoc);
        else setError("Permissão de localização negada");
        setLoading(false);
      },
      { timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  }, []);

  return { location, loading, error };
}
