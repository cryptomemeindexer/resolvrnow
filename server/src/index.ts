import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Platform } from './engine/platform.js';
import { selectModules } from './modules/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const platform = new Platform({
    dbFile: config.dbFile,
    modules: selectModules(),
    demo: config.demo,
    autoProcess: true,
  }).boot();
  platform.start();
  const app = await buildApp(platform, config, { logger: true });
  const shutdown = async () => {
    await app.close();
    platform.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await app.listen({ port: config.port, host: config.host });
  const initial = platform.services.get('initialAdminPassword');
  app.log.info(
    `ResolvrNow is running on http://localhost:${config.port}  (data: ${config.dataDir}${config.webDir ? '' : ', web UI not built'})`,
  );
  if (initial) app.log.info(`Initial admin password: ${String(initial)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
