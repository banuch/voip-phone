/** Keys whose values must never reach logs, audit rows or events. */
const SECRET_KEY = /pass(word)?|secret|token|authorization|cookie|ha1|credential|api[-_]?key|private/i;

export function redact<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out as T;
}

/** pino redaction paths for request logging. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.sipPassword',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.sipPassword',
  '*.ha1',
];
