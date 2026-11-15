import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared by the tests in a file, so each one starts from empty tables.
beforeEach(async () => {
  await env.DB.batch(
    ['messages', 'devices', 'pairing_codes', 'exclusions'].map((table) => env.DB.prepare(`DELETE FROM ${table}`))
  );
});
