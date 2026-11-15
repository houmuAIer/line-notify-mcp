import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared by the tests in a file, so each one starts from empty tables and an empty bucket.
beforeEach(async () => {
  await env.DB.batch(
    ['messages', 'devices', 'pairing_codes', 'exclusions', 'media'].map((table) => env.DB.prepare(`DELETE FROM ${table}`))
  );
  const { objects } = await env.MEDIA.list();
  if (objects.length) await env.MEDIA.delete(objects.map((o) => o.key));
});
