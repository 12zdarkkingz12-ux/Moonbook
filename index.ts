import dotenv from 'dotenv';
import { ensureBaseDirs } from './utils';
import { createDiscordClient, startDiscordBot } from './discord';
import { createWebApp } from './web';

dotenv.config();

async function main() {
  await ensureBaseDirs();

  const discordClient = createDiscordClient();
  const app = createWebApp(discordClient);

  const port = Number(process.env.PORT || 3000);
  const webBaseUrl = process.env.WEB_BASE_URL || `http://localhost:${port}`;

  app.listen(port, () => {
    console.log(`[web] Moonbook running at ${webBaseUrl}`);
  });

  await startDiscordBot(discordClient);
}

main().catch((error) => {
  console.error('[fatal]', error);
  process.exit(1);
});