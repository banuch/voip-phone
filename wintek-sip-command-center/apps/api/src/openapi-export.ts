/* Writes the OpenAPI document to docs/openapi.json (needs DATABASE_URL reachable). */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.WORKERS_ENABLED = 'false';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildOpenApi, createApp } = require('./bootstrap') as typeof import('./bootstrap');

(async () => {
  const app = await createApp({ logger: false });
  await app.init();
  const out = join(__dirname, '../../../docs/openapi.json');
  writeFileSync(out, JSON.stringify(buildOpenApi(app), null, 2));
  console.log(`wrote ${out}`);
  await app.close();
  process.exit(0);
})();
