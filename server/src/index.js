import http from 'node:http';
import config from './config.js';
import { openDatabase, closeDatabase } from './database/db.js';
import { runMigrations } from './database/migrate.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { cleanupExpiredMessages } from './messages/service.js';
import { cleanupExpiredSessions } from './auth/sessions.js';
import { cleanupChallenges } from './auth/challenges.js';

function startCleanupJob() {
  const run = () => {
    try {
      const messages = cleanupExpiredMessages();
      const sessions = cleanupExpiredSessions();
      const challenges = cleanupChallenges();
      if (messages || sessions || challenges) {
        console.log(
          `[cleanup] removed ${messages} expired messages, ${sessions} expired sessions, ${challenges} challenges`,
        );
      }
    } catch (err) {
      console.error('[cleanup] failed:', err.message);
    }
  };
  const timer = setInterval(run, config.cleanupIntervalMs);
  timer.unref?.();
  return timer;
}

export function startServer({ port = config.port } = {}) {
  const db = openDatabase();
  runMigrations(db);

  const app = createApp();
  const httpServer = http.createServer(app);
  createSocketServer(httpServer);
  const cleanupTimer = startCleanupJob();

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`[server] SecureChat API listening on http://localhost:${port}`);
      resolve({ httpServer, app, cleanupTimer });
    });
  });
}

const isMain = process.argv[1] && process.argv[1].endsWith('index.js');
if (isMain) {
  startServer()
    .then(() => {
      console.log(`[server] database: ${config.databaseFile}`);
    })
    .catch((err) => {
      console.error('[server] failed to start:', err);
      process.exit(1);
    });

  const shutdown = () => {
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default startServer;
