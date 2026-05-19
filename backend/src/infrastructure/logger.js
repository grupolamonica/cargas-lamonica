// backend/src/infrastructure/logger.js
//
// Logger estruturado via pino. Centraliza saída de logs em JSON para permitir
// agregação (docker logs | jq, Loki, Datadog, etc.).
//
// Uso:
//   import { logger, createChildLogger } from '../infrastructure/logger.js';
//   logger.info({ correlationId }, 'message');
//   const reqLog = createChildLogger({ correlationId: req.correlationId });
//   reqLog.warn({ statusCode: 403 }, 'forbidden');
//
// Levels: trace < debug < info < warn < error < fatal
// Produção (NODE_ENV=production): nível mínimo info.
// Dev: debug.
//
// Integração com X-Correlation-Id:
//   Em cada request use createChildLogger({ correlationId: req.correlationId })
//   para propagar o ID sem mudar assinaturas de funções de negócio.

import pino from 'pino';

const level = process.env.LOG_LEVEL?.toLowerCase() ||
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  base: { service: 'lamonica-backend' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'password',
      'senha',
      'token',
      '*.token',
      '*.password',
      '*.senha',
      'authorization',
      'headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
});

/**
 * Cria child logger com contexto fixo (ex: correlationId por request).
 * Herda level, redact e serializers do pai.
 */
export function createChildLogger(bindings = {}) {
  return logger.child(bindings);
}
