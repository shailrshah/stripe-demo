import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createOrdersRepo } from './orders.ts';
import { createEventLog } from './event-log.ts';
import { createWebhookProcessor } from './webhook-processor.ts';
import { createWebhookRouter } from './routes/webhook.ts';
import { createCheckoutRouter } from './routes/checkout.ts';
import { createApiRouter } from './routes/api.ts';
import type { Config, Gateway, Logger, WebhookVerifier } from './types.ts';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

// Body parsers and routers throw errors carrying an HTTP `status`; only 4xx ones are safe to echo to the client.
function clientError(err: unknown): { status: number; message: unknown } | null {
  if (typeof err !== 'object' || err === null || !('status' in err)) return null;
  const { status } = err;
  if (typeof status !== 'number' || !(status >= 400 && status < 500)) return null;
  return { status, message: 'message' in err ? err.message : undefined };
}

export function createApp({ config, db, gateway, verifier, logger }: {
  config: Config; db: DatabaseSync; gateway: Gateway; verifier: WebhookVerifier; logger: Logger;
}): express.Express {
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
  // Express recognises error handlers by their four parameters, so `next` must stay even though it is unused.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const client = clientError(err);
    const status = client ? client.status : 500;
    if (!client) logger.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    res.status(status).json({ error: { message: client ? client.message : 'Internal server error' } });
  });

  return app;
}
