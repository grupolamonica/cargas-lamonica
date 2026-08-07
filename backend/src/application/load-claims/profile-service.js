import { withPgClient, withPgTransaction } from "../../infrastructure/pg/postgres.js";

import { createCorrelationId } from "./helpers.js";

export async function upsertDriverProfile({ userId, profile, correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  return withPgTransaction(async (client) => {
    // Capture old CPF/phone before upsert so we can cascade changes to public leads
    const { rows: existingRows } = await client.query(
      `SELECT document_number, phone FROM public.driver_profiles WHERE user_id = $1`,
      [userId],
    );
    const oldCpf = String(existingRows[0]?.document_number || "").replace(/\D/g, "");
    const oldPhone = String(existingRows[0]?.phone || "").replace(/\D/g, "");

    // Compliance flags are not listed here on purpose. They are the eligibility gates
    // and only the operator may set them (update-driver-profile.js, audited). On INSERT
    // the column defaults apply; on CONFLICT they are left untouched, so an
    // operator-approved value survives the driver's next profile save.
    const { rows } = await client.query(
      `
        INSERT INTO public.driver_profiles (
          user_id,
          full_name,
          phone,
          document_number,
          vehicle_profile,
          active,
          operational_blocked,
          allowed_regions,
          metadata
        )
        VALUES ($1, $2, $3, $4, $5, true, false, $6::text[], $7::jsonb)
        ON CONFLICT (user_id)
        DO UPDATE SET
          full_name = EXCLUDED.full_name,
          phone = EXCLUDED.phone,
          document_number = EXCLUDED.document_number,
          vehicle_profile = EXCLUDED.vehicle_profile,
          allowed_regions = EXCLUDED.allowed_regions,
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING *
      `,
      [
        userId,
        profile.full_name,
        profile.phone || null,
        profile.document_number || null,
        profile.vehicle_profile,
        profile.allowed_regions,
        JSON.stringify(profile.metadata ?? {}),
      ],
    );

    // Cascade CPF/phone changes to public leads so deduplication keeps matching
    const newCpf = String(rows[0]?.document_number || "").replace(/\D/g, "");
    const newPhone = String(rows[0]?.phone || "").replace(/\D/g, "");

    if (oldCpf && oldCpf !== newCpf) {
      await client.query(
        `UPDATE public.load_public_leads SET cpf = $1 WHERE REPLACE(REPLACE(REPLACE(cpf, '.', ''), '-', ''), '/', '') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newCpf, oldCpf],
      );
    }
    if (oldPhone && oldPhone !== newPhone) {
      await client.query(
        `UPDATE public.load_public_leads SET phone = $1 WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '(', ''), ')', ''), ' ', ''), '-', ''), '+', '') = $2 AND status IN ('QUEUED', 'APPROVED')`,
        [newPhone, oldPhone],
      );
    }

    return {
      statusCode: 200,
      payload: {
        profile: rows[0],
        meta: {
          correlationId: resolvedCorrelationId,
        },
      },
    };
  });
}

export async function getDriverProfileByUserId({ userId, correlationId }) {
  const resolvedCorrelationId = correlationId || createCorrelationId();

  return withPgClient(async (client) => {
    const { rows } = await client.query(
      `
        SELECT *
        FROM public.driver_profiles
        WHERE user_id = $1
      `,
      [userId],
    );

    return {
      statusCode: 200,
      payload: {
        profile: rows[0] ?? null,
        meta: {
          correlationId: resolvedCorrelationId,
        },
      },
    };
  });
}
