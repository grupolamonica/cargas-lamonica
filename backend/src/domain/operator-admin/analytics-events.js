/**
 * Analytics event helpers: sponsor clicks and driver region tracking.
 * Storage: public.analytics_events (event_type, data jsonb, created_at).
 */
import { withPgClient } from "../../infrastructure/pg/postgres.js";
import { getGeoapifyJson } from "../../infrastructure/geoapify/geoapify-client.js";

/**
 * Reverse-geocodes { lat, lon } via Geoapify and stores the Brazilian state
 * in analytics_events with event_type = 'DRIVER_REGION_VIEW'.
 * Fire-and-forget — caller must .catch(() => {}).
 */
export async function recordDriverRegion({ lat, lon }) {
  let state = null;
  let city = null;

  try {
    const geo = await getGeoapifyJson(
      "/v1/geocode/reverse",
      { lat, lon, format: "geojson" },
      { operation: "driver_region_lookup", timeoutMs: 5000 },
    );

    const props = geo?.features?.[0]?.properties;
    if (props) {
      state = props.state ?? props.state_code ?? null;
      city = props.city ?? props.county ?? null;
    }
  } catch {
    // If reverse geocode fails, skip state — still record the view
    state = null;
    city = null;
  }

  if (!state) return; // Don't store if we couldn't determine the state

  await withPgClient(async (client) => {
    await client.query(
      "INSERT INTO public.analytics_events (event_type, data) VALUES ($1, $2)",
      ["DRIVER_REGION_VIEW", JSON.stringify({ state, city })],
    );
  });
}
