import "../config/load-env.js";

import { processExpiredLoadClaims } from "../services/load-claims/service.js";
import { redactExpiredPublicLeadPii } from "../services/operator-admin/service.js";

process.on("unhandledRejection", (reason) => {
  console.error("[script] Unhandled promise rejection:", reason);
  process.exit(1);
});

async function main() {
  const claimsMaintenance = await processExpiredLoadClaims({});
  const publicLeadPiiMaintenance = await redactExpiredPublicLeadPii({
    batchSize: Number.parseInt(process.env.PUBLIC_LEAD_PII_REDACTION_BATCH_SIZE || "", 10) || 50,
    retentionDays: Number.parseInt(process.env.PUBLIC_LEAD_PII_RETENTION_DAYS || "", 10) || 30,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        ...claimsMaintenance,
        publicLeadPiiMaintenance,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[process-expired-load-claims] Failed", error);
  process.exitCode = 1;
});
