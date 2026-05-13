/**
 * Pino logger config for nestjs-pino (P0-7).
 *
 * - JSON to stdout in production.
 * - Pretty-print in dev via pino-pretty transport.
 * - Redacts auth/secret-bearing paths anywhere in the log object.
 * - Adds a per-request `requestId` (uuid) via pino-http genReqId.
 * - Callers attach `module` via child loggers: `logger.child({ module: 'pipeline' })`.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';

const REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.access_token',
  '*.client_secret',
  '*.refresh_token',
  '*.password',
];

export function buildPinoOptions(): Params {
  const isProd = process.env.NODE_ENV === 'production';
  const level = process.env.LOG_LEVEL ?? 'info';

  return {
    pinoHttp: {
      level,
      // uuid per request, exposed as `req.id` and included on each log line.
      genReqId: (req: IncomingMessage, res: ServerResponse) => {
        const incoming =
          (req.headers['x-request-id'] as string | undefined) ??
          (req.headers['x-correlation-id'] as string | undefined);
        const id = incoming && incoming.length > 0 ? incoming : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      customProps: (req: IncomingMessage & { id?: string }) => ({
        requestId: req.id,
      }),
      redact: {
        paths: REDACTION_PATHS,
        censor: '[REDACTED]',
        remove: false,
      },
      // pino-pretty transport only in dev. In prod we emit JSON to stdout.
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              singleLine: false,
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
    },
  };
}
