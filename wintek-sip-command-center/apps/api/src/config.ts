import { z } from 'zod';

// Local development convenience: load apps/api/.env if present (Node 21.7+ built-in).
// Variables already set in the environment take precedence; tests never ship a .env.
if (process.env.NODE_ENV !== 'test') {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.('.env');
  } catch {
    /* no .env file */
  }
}

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  NODE_ID: z.string().default(`api-${process.pid}`),
  DATABASE_URL: z.string().default('postgres://wintek:wintek@localhost:5432/wintek'),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  /** Empty = run without Redis (single API node only). Required in production. */
  REDIS_URL: z.string().default(''),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-dev-only-secret-change-me'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().default(7),
  COOKIE_SECURE: bool.default('false'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** simulated = no Asterisk needed; ari = real Asterisk via ARI. */
  SIP_DRIVER: z.enum(['simulated', 'ari']).default('simulated'),
  ARI_URL: z.string().default('http://localhost:8088/ari'),
  ARI_USER: z.string().default('wintek'),
  ARI_PASSWORD: z.string().default('wintek'),
  ARI_APP: z.string().default('wintek'),
  MEDIA_NODE_ID: z.string().default('asterisk-1'),
  /** How the ATM leg is dialled. Stage 1: Asterisk is the registrar. Stage 2: via Kamailio. */
  ATM_DIAL_MODE: z.enum(['asterisk-registrar', 'kamailio']).default('asterisk-registrar'),
  KAMAILIO_TRUNK_ENDPOINT: z.string().default('kamailio'),
  SIP_DOMAIN: z.string().default('sip.wintek.local'),
  SIP_REALM: z.string().default('sip.wintek.local'),
  WEBRTC_WSS_URL: z.string().default('wss://localhost:8089/ws'),
  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URL: z.string().default(''),
  TURN_SECRET: z.string().default(''),
  /** Shared secret for registrar/Kamailio -> API webhooks. */
  INTERNAL_WEBHOOK_SECRET: z.string().default('dev-internal-secret'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  AUDIT_RETENTION_DAYS: z.coerce.number().default(365),
  CALL_HISTORY_RETENTION_DAYS: z.coerce.number().default(365),
  /** Platform-wide ceiling on concurrent calls (capacity guard; size from load tests). */
  MAX_CONCURRENT_CALLS: z.coerce.number().default(250),
  /** Background workers (sweeper, dispatcher). Leader election still applies. */
  WORKERS_ENABLED: bool.default('true'),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (cfg.JWT_SECRET.startsWith('dev-only')) problems.push('JWT_SECRET must be set');
    if (cfg.INTERNAL_WEBHOOK_SECRET.startsWith('dev-')) problems.push('INTERNAL_WEBHOOK_SECRET must be set');
    if (!cfg.REDIS_URL) problems.push('REDIS_URL is required in production (multi-node fan-out)');
    if (!cfg.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (cfg.SIP_DRIVER === 'simulated') problems.push('SIP_DRIVER=simulated is not allowed in production');
    if (problems.length) throw new Error(`Invalid production configuration: ${problems.join('; ')}`);
  }
  return cfg;
}

export function config(): AppConfig {
  return (cached ??= loadConfig());
}

export function setConfigForTests(overrides: Partial<Record<keyof AppConfig, string>>): AppConfig {
  cached = loadConfig({ ...process.env, ...overrides });
  return cached;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
