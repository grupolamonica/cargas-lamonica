import "../infrastructure/config/load-env.js";

import { syncDriverVinculos } from "../application/google-sheets/driver-vinculos.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

async function main() {
  const result = await syncDriverVinculos();

  console.log(
    JSON.stringify(
      {
        action: result.skipped ? "skipped" : "synced",
        reason: result.reason ?? null,
        upserted: result.upserted,
        deleted: result.deleted,
        csvUrl: result.csvUrl ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[sync-driver-vinculos] Failed", error);
  process.exitCode = 1;
});
