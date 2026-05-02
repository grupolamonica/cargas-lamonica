/**
 * Free IP geolocation via ip-api.com (HTTP, no API key, 45 req/min free tier).
 * Used for automatic driver region tracking — no browser permission required.
 */
import http from "node:http";

// Private/loopback/unroutable IPs — skip geolocation for these
const SKIP_IP_RE =
  /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1$|^$|localhost)/i;

/**
 * Returns { state, city } for the given IP, or null if the lookup fails
 * or the IP is private/loopback.
 *
 * @param {string} ip - IPv4 or IPv6 address
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ state: string; city: string | null } | null>}
 */
export async function getIpRegion(ip, { timeoutMs = 3000 } = {}) {
  if (!ip || SKIP_IP_RE.test(ip)) return null;

  // Strip IPv6-mapped IPv4 prefix (e.g. "::ffff:177.11.0.1" → "177.11.0.1")
  const cleanIp = ip.replace(/^::ffff:/, "");

  return new Promise((resolve) => {
    const url = `http://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,regionName,city&lang=pt-BR`;

    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data.status === "success" && data.regionName) {
            resolve({ state: data.regionName, city: data.city ?? null });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}
