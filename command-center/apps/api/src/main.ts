import { SwaggerModule } from '@nestjs/swagger';
import { buildOpenApi, createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const cfg = config(); // validates env; refuses unsafe production settings
  const app = await createApp();
  if (cfg.NODE_ENV !== 'production') SwaggerModule.setup('api/docs', app, buildOpenApi(app));
  await app.listen(cfg.PORT, '0.0.0.0');
  console.log(`Wintek API ${cfg.NODE_ID} listening on :${cfg.PORT} (SIP driver: ${cfg.SIP_DRIVER})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
