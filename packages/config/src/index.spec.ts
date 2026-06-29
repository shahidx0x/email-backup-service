import { parseConfig } from './index';
const base = {
  MONGODB_APP_USERNAME: 'app', MONGODB_APP_PASSWORD: 'password', REDIS_PASSWORD: 'redis-password',
  JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32), ADMIN_INITIAL_PASSWORD: 'initial-password-123',
  CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};
test('rejects Swagger in production', () => {
  expect(() => parseConfig({ ...base, NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toThrow(/Unsafe production/);
});
test('accepts secure production config', () => {
  expect(parseConfig({ ...base, NODE_ENV: 'production', SWAGGER_ENABLED: 'false', OPENAPI_JSON_ENABLED: 'false' }).NODE_ENV).toBe('production');
});
