import { readFileSync } from 'node:fs';
import { z } from 'zod';

const bool = z.preprocess((v: unknown) => v === true || v === 'true' || v === '1', z.boolean());
const int = (fallback: number) => z.coerce.number().int().default(fallback);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_PORT: int(3000),
  WORKER_HEALTH_PORT: int(3002),
  SCHEDULER_HEALTH_PORT: int(3003),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3001'),
  CORS_ORIGINS: z.string().default('http://localhost:3001'),
  TRUST_PROXY: bool.default(false),
  MONGODB_HOST: z.string().default('localhost'),
  MONGODB_PORT: int(27017),
  MONGODB_DATABASE: z.string().min(1).default('email_backup'),
  MONGODB_REPLICA_SET: z.string().default('rs0'),
  MONGODB_AUTH_SOURCE: z.string().default('admin'),
  MONGODB_APP_USERNAME: z.string().min(1),
  MONGODB_APP_PASSWORD: z.string().min(1),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: int(6379),
  REDIS_PASSWORD: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(1),
  ADMIN_INITIAL_EMAIL: z.string().email().default('dev.imshahid@gmail.com'),
  ADMIN_INITIAL_PASSWORD: z.string().min(12),
  JWT_ACCESS_TTL_SECONDS: int(900),
  JWT_REFRESH_TTL_SECONDS: int(2592000),
  IMAP_DEFAULT_HOST: z.string().default('imap.hostinger.com'),
  IMAP_DEFAULT_PORT: int(993),
  IMAP_DEFAULT_TLS: bool.default(true),
  IMAP_IDLE_ENABLED: bool.default(true),
  IMAP_POLL_INTERVAL_SECONDS: int(300),
  IMAP_CONNECTION_TIMEOUT_SECONDS: int(30),
  IMAP_MAX_GLOBAL_CONNECTIONS: int(20),
  IMAP_MAX_CONNECTIONS_PER_MAILBOX: int(2),
  SYNC_BATCH_SIZE: int(100),
  SYNC_FOLDER_CONCURRENCY: int(2),
  SYNC_MESSAGE_CONCURRENCY: int(5),
  EXPORT_DIRECTORY: z.string().default('/data/exports'),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace','silent']).default('info'),
  METRICS_ENABLED: bool.default(true),
  SWAGGER_ENABLED: bool.default(false),
  SWAGGER_PATH: z.string().default('api/docs'),
  OPENAPI_JSON_ENABLED: bool.default(false),
  OPENAPI_JSON_PATH: z.string().default('api/openapi.json'),
  FOLDER_DISCOVERY_CRON: z.string().default('0 */6 * * *'),
  RECONCILIATION_CRON: z.string().default('0 2 * * *'),
  INTEGRITY_SAMPLE_CRON: z.string().default('0 3 * * *'),
  FULL_INTEGRITY_CRON: z.string().default('0 4 * * 0'),
  EXPORT_CLEANUP_CRON: z.string().default('0 * * * *'),
  STATISTICS_REFRESH_CRON: z.string().default('*/15 * * * *'),
  CONNECTIVITY_CHECK_CRON: z.string().default('0 * * * *'),
  STALE_LOCK_CLEANUP_CRON: z.string().default('*/10 * * * *'),
});

export type AppConfig = z.infer<typeof schema>;

const secretMappings = [
  ['MONGODB_APP_USERNAME', 'mongodb_app_username'],
  ['MONGODB_APP_PASSWORD', 'mongodb_app_password'],
  ['REDIS_PASSWORD', 'redis_password'],
  ['JWT_ACCESS_SECRET', 'jwt_access_secret'],
  ['JWT_REFRESH_SECRET', 'jwt_refresh_secret'],
  ['CREDENTIAL_ENCRYPTION_KEY', 'credential_encryption_key'],
  ['ADMIN_INITIAL_PASSWORD', 'admin_initial_password'],
] as const;

function hydrateSecrets(input: NodeJS.ProcessEnv): Record<string, unknown> {
  const output: Record<string, unknown> = { ...input };
  for (const [name, defaultFile] of secretMappings) {
    if (output[name]) continue;
    const file = input[`${name}_FILE`] ?? `/run/secrets/${defaultFile}`;
    try { output[name] = readFileSync(file, 'utf8').trim(); } catch { /* validation reports missing secret */ }
  }
  return output;
}

export function parseConfig(input: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = schema.parse(hydrateSecrets(input));
  if (config.NODE_ENV === 'production' && (config.SWAGGER_ENABLED || config.OPENAPI_JSON_ENABLED)) {
    throw new Error('Unsafe production configuration: Swagger and OpenAPI routes must be disabled');
  }
  const key = Buffer.from(config.CREDENTIAL_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return config;
}

export function buildMongoUri(config: AppConfig): string {
  const user = encodeURIComponent(config.MONGODB_APP_USERNAME);
  const password = encodeURIComponent(config.MONGODB_APP_PASSWORD);
  return `mongodb://${user}:${password}@${config.MONGODB_HOST}:${config.MONGODB_PORT}/${config.MONGODB_DATABASE}?authSource=${encodeURIComponent(config.MONGODB_AUTH_SOURCE)}&replicaSet=${encodeURIComponent(config.MONGODB_REPLICA_SET)}&retryWrites=true&w=majority`;
}
