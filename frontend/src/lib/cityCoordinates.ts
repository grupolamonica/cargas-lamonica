interface CityCoord {
  lat: number;
  lon: number;
}

const CITY_COORDS: Record<string, CityCoord> = {
  "sao jose do rio preto": { lat: -20.8113, lon: -49.3758 },
  "sj rio preto": { lat: -20.8113, lon: -49.3758 },
  "pedreira": { lat: -22.8332, lon: -46.9012 },
  "jaguariuna": { lat: -22.7042, lon: -46.9831 },
  "simoes filho": { lat: -12.7847, lon: -38.4022 },
  "salvador": { lat: -12.9714, lon: -38.5014 },
  "feira de santana": { lat: -12.2664, lon: -38.9663 },
  "jaboatao dos guararapes": { lat: -8.1133, lon: -35.0056 },
  "campo grande": { lat: -20.4697, lon: -54.6201 },
  "camacari": { lat: -12.6977, lon: -38.3245 },
  "camaçari": { lat: -12.6977, lon: -38.3245 },
  "recife": { lat: -8.0578, lon: -34.8829 },
  "fortaleza": { lat: -3.7172, lon: -38.5433 },
  "manaus": { lat: -3.1190, lon: -60.0217 },
  "belem": { lat: -1.4558, lon: -48.5044 },
  "curitiba": { lat: -25.4284, lon: -49.2733 },
  "porto alegre": { lat: -30.0346, lon: -51.2177 },
  "belo horizonte": { lat: -19.9167, lon: -43.9345 },
  "goiania": { lat: -16.6869, lon: -49.2648 },
  "ribeirao preto": { lat: -21.1775, lon: -47.8103 },
  "campinas": { lat: -22.9056, lon: -47.0608 },
  "sao paulo": { lat: -23.5505, lon: -46.6333 },
};

function normalizeOriginKey(origem: string): string {
  return origem
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s*\/\s*[a-z]{2}\s*$/i, "")
    .replace(/[-\s]+\d+\s*$/, "")
    .trim();
}

export function getOriginCoords(origem: string): CityCoord | null {
  const key = normalizeOriginKey(origem);
  const coords = CITY_COORDS[key] ?? null;
  // Dev-only: log misses para mapear cidades faltando no whitelist.
  // TODO: substituir lookup hardcoded por Geoapify geocoding (refactor futuro — D-01).
  if (!coords && import.meta.env?.DEV) {
    // eslint-disable-next-line no-console
    console.info(`[cityCoordinates] miss: "${key}" (origem original: "${origem}")`);
  }
  return coords;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
