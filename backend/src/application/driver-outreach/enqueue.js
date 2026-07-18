/**
 * driver-outreach — enfileira uma oportunidade para envio assíncrono.
 * Idempotente por (driver_key, trigger): ON CONFLICT DO NOTHING evita
 * re-enfileirar a mesma oportunidade para o mesmo motorista.
 */

export async function enqueueDriverOutreach(
  client,
  { driverKey, trigger, phone, message, correlationId } = {},
) {
  if (!driverKey || !trigger || !phone || !message) return null;
  const { rows } = await client.query(
    `
      INSERT INTO public.pending_driver_outreach
        (driver_key, trigger, phone, message, correlation_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (driver_key, trigger) DO NOTHING
      RETURNING id
    `,
    [driverKey, trigger, phone, message, correlationId || null],
  );
  return rows[0]?.id ?? null; // null = já existia (dedupe)
}
