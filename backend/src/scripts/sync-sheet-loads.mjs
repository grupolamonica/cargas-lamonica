import "../infrastructure/config/load-env.js";

import { syncGoogleSheetLoads } from "../application/google-sheets/google-sheet-loads.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

async function main() {
  const result = await syncGoogleSheetLoads();

  console.log(
    JSON.stringify(
      {
        action: "synced",
        availableLoadsCount: result.availableLoadsCount,
        unlinkedLoadsCount: result.unlinkedLoadsCount,
        sheetUrl: result.sheetUrl,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[sync-sheet-loads] Failed", error);
  process.exitCode = 1;
});
