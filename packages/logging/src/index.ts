import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
export function createLoggerConfig(level: string): Params {
  return {
    pinoHttp: {
      level,
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]',
          'password', '*.password', 'credential', '*.credential', '*.ciphertext',
          'raw', '*.raw', 'attachment', '*.attachment',
        ],
        censor: '[REDACTED]',
      },
      genReqId: (request) => String(request.headers['x-request-id'] ?? randomUUID()),
    },
  };
}
