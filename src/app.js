import express from 'express';
import { fileURLToPath } from 'node:url';
import { createOrdersRepo } from './orders.js';
import { createEventLog } from './event-log.js';
import { createWebhookProcessor } from './webhook-processor.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createCheckoutRouter } from './routes/checkout.js';
import { createApiRouter } from './routes/api.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

export function createApp({ config, db, gateway, verifier, logger }) {
  const orders = createOrdersRepo(db);
  const eventLog = createEventLog(db);
  const processor = createWebhookProcessor({ db, orders, eventLog, logger });

  const app = express();
  // Mounted before the body parsers: signature verification needs the untouched raw body.
  app.use(createWebhookRouter({ verifier, processor, logger }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(createCheckoutRouter({ config, orders, gateway, logger, publicDir }));
  app.use('/api', createApiRouter({ config, orders, eventLog, gateway, logger }));
  app.use(express.static(publicDir));

  app.use((req, res) => {
    res.status(404).json({ error: { message: 'Not found' } });
  });
  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) logger.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    res.status(status).json({ error: { message: status === 500 ? 'Internal server error' : err.message } });
  });

  return app;
}
