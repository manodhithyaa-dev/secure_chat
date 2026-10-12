import express from 'express';
import cors from 'cors';
import config from './config.js';
import { cookieParser } from './middleware/cookies.js';
import { rateLimit } from './middleware/rateLimit.js';
import { AppError } from './middleware/errors.js';

import authRoutes from './auth/routes.js';
import userRoutes from './users/routes.js';
import friendRoutes from './friends/routes.js';
import deviceRoutes from './devices/routes.js';
import messageRoutes from './messages/routes.js';
import attachmentRoutes from './attachments/routes.js';
import callRoutes from './calls/routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser);
  app.use(rateLimit());

  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true, version: '0.1.0' });
  });

  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/', friendRoutes);
  api.use('/', deviceRoutes);
  api.use('/', messageRoutes);
  api.use('/', attachmentRoutes);
  api.use('/', callRoutes);
  app.use('/api/v1', api);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Endpoint not found' } });
  });

  // Central error handler. Never leaks stack traces or secrets.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
    }
    console.error('[server] unhandled error:', err?.message);
    return res
      .status(500)
      .json({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  return app;
}

export default createApp;
