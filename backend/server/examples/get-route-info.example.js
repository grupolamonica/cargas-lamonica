import "../config/load-env.js";
import { getRouteInfo } from "../services/geoapify/index.js";

async function main() {
  try {
    const routeInfo = await getRouteInfo("Fortaleza, CE", "Sao Paulo, SP");
    console.log("Route info:", routeInfo);
  } catch (error) {
    console.error("Failed to calculate route info.", {
      name: error?.name,
      code: error?.code,
      message: error?.message,
    });
    process.exitCode = 1;
  }
}

console.log("Using GEOAPIFY_API_KEY from the project .env or current environment.");
await main();
