import './env.js';
import { createApp } from './app.js';
import { initDb } from './db/index.js';
import { startHealthChecker } from './services/health.js';

const PORT = process.env.PORT ?? 3001;

// Prevent the process from crashing on unhandled errors.
// Node 15+ exits by default on unhandled rejections; a single async
// route handler bug can take down the whole server. Log and continue.
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] Unhandled rejection — server continues:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception — server continues:', err);
});

async function main() {
  initDb();
  const app = createApp();

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Proxy endpoint: http://0.0.0.0:${PORT}/v1/chat/completions`);
    startHealthChecker();
  });
}

main().catch(console.error);
