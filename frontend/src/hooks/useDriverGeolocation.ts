import { useEffect, useState } from "react";

export interface DriverGeolocation {
  lat: number;
  lon: number;
}

export function useDriverGeolocation() {
  const [location, setLocation] = useState<DriverGeolocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setUnavailable(true);
      setLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({ lat: position.coords.latitude, lon: position.coords.longitude });
        setLoading(false);
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setDenied(true);
        } else {
          // POSITION_UNAVAILABLE or TIMEOUT
          setUnavailable(true);
        }
        setLoading(false);
      },
      { timeout: 15000, maximumAge: 5 * 60_000 },
    );
  }, []);

  return { location, loading, denied, unavailable };
}
