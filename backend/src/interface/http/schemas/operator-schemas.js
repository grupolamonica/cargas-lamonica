import { z } from "zod";
import { positiveIntSchema } from "./common.js";

/** Query params for GET /api/operator/motoristas/:driverId (PATCH body) — params handled by driver-schemas */

/** Query params for sheet monitor */
export const sheetMonitorQuerySchema = z.object({
  refresh: z.enum(["true", "false"]).optional(),
}).passthrough();

/** Query params for sheet monitor row detail */
export const sheetMonitorRowQuerySchema = z.object({
  lh: z.string().min(1, "Query param 'lh' is required"),
});

/** Body for POST /api/operator/sheet-monitor/enrich */
export const sheetMonitorEnrichBodySchema = z.object({
  force: z.boolean().optional(),
  forceSessionStart: z.string().optional().nullable(),
}).passthrough();

/** Query params for PII redaction POST */
export const piiRedactionQuerySchema = z.object({
  retentionDays: z.coerce.number().int().min(1).max(365).optional(),
  batchSize: z.coerce.number().int().min(1).max(1000).optional(),
});

/** Query params for /api/operator/dashboard */
export const dashboardQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(24).default(12),
  search: z.string().optional(),
  status: z.string().optional(),
  driverVisibility: z.string().optional(),
}).passthrough();

/** Query params for /api/operator/audit-logs */
export const auditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();

/** Query params for /api/operator/driver-flow-metrics */
export const driverFlowMetricsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
}).passthrough();
