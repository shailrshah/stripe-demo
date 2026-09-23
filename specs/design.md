# Design: Stripe Demo Shop

This document covers how to build what [requirements.md](requirements.md) asks for. Requirement IDs (R…, N…) are referenced inline.

## 1. Architecture overview

```
 Browser (127.0.0.1:3000)                     Stripe (test mode)
 ┌──────────────────────┐   redirect    ┌────────────────────────┐
 │ static HTML/JS pages │ ────────────▶ │ Hosted Checkout page   │
 │ Stripe.js + Payment  │ ◀──────────── │                        │
 │ Element (iframe)     │  card data ──▶│ api.stripe.com         │
 └─────────┬────────────┘   (never to   └──────▲───────────┬─────┘
           │ fetch / form     our server)       │ API calls │ events
 ┌─────────▼────────────────────────────────────┴──┐        │
 │ Express app (127.0.0.1 only)                    │  ┌─────▼──────────┐
 │  routes ─▶ stripe-gateway ──────────────────────┘  │ stripe listen   │
 │    │                                               │ (Stripe CLI)    │
 │    ├─▶ orders repo ──┐                             └─────┬───────────┘
 │    └─▶ webhook route ─▶ verifier ─▶ processor ──┐        │ POST /webhook
 │                       ▲                         ▼        │
 │                       └─────────────── SQLite (node:sqlite, sync)
 └─────────────────────────────────────────────────────────┘
```

Key decisions:

| Decision | Choice | Why |
|---|---|---|
| Module format | ESM (`"type": "module"`) | Node 24 native; `stripe` v22 supports it |
| Language | TypeScript for `src/`, `test/` and `e2e/`, run through Node's type stripping; JavaScript for `public/` | Types without a build step (C5, N5). See §17 |
| Wiring | Factory functions with injected dependencies (`createApp({ db, gateway, verifier, … })`) | Tests swap the gateway and database without mocking libraries (N1) |
| Stripe API calls | One `stripe-gateway` module | The only code that talks to `api.stripe.com`; faked in tests |
| Webhook verification | Static `Stripe.webhooks.constructEvent` | Needs no API key, so tests verify real signatures (N2a) |
| Database | `node:sqlite` `DatabaseSync`, WAL mode | Built in, with zero dependencies (N3). Synchronous calls mean a webhook transaction can't interleave with other requests |
| Prices | Inline `price_data` from the server's catalog | No Products or Prices to set up in the Dashboard; the server stays authoritative (R1.3) |
| Frontend | Static files in `public/`, no build | C5 |
| Test runner | Built-in `node:test` + global `fetch` against `app.listen(0)` | No test dependencies at all (N3) |
| Host for URLs | `127.0.0.1` everywhere, including the Stripe CLI forward target | On macOS `localhost` may resolve to `::1`, which the server doesn't listen on (R7.4) |

## 2. Repository layout

```
stripe-demo/
├── package.json            # "type":"module"; scripts: start, test
├── .env.example
├── .gitignore              # node_modules, .env, data/
├── README.md
├── specs/
├── src/
│   ├── server.js           # entry point: wires everything and listens
│   ├── config.js           # loadConfig(env)
│   ├── catalog.js          # PRODUCTS, getProduct, formatPrice
│   ├── db.js               # openDb(path): opens the DB and applies the schema
│   ├── orders.js           # createOrdersRepo(db)
│   ├── event-log.js        # createEventLog(db)
│   ├── transitions.js      # canTransition, eventTarget
│   ├── webhook-processor.js# createWebhookProcessor({ db, orders, eventLog, logger })
│   ├── webhook-verifier.js # createWebhookVerifier(secret)
│   ├── stripe-gateway.js   # createStripeGateway(secretKey)
│   ├── app.js              # createApp(deps): express app, mounts routes
│   └── routes/
│       ├── api.js          # products, config, payment-intents, orders, refunds, events
│       ├── checkout.js     # POST /checkout, GET /cancel
│       └── webhook.js      # POST /webhook
├── public/
│   ├── styles.css
│   ├── common.js           # fetchJson, statusBadge, outcomeBadge
│   ├── index.html  + index.js    # catalog (R1)
│   ├── pay.html    + pay.js      # Payment Element (R3)
│   ├── success.html+ success.js  # polls order status (R2.3, R4.5)
│   ├── cancel.html                # R2.4
│   ├── orders.html + orders.js   # order list + refund (R5.1, R5.2, R6)
│   ├── order.html  + order.js    # order detail + its events (R5.4)
│   └── events.html + events.js   # event log (R5.3)
└── test/
    ├── helpers/
    │   ├── fake-gateway.js     # records calls, returns canned ids
    │   ├── stripe-events.js    # event fixture builders + real signing
    │   └── test-server.js      # startTestServer(overrides) → { url, db, gateway, close }
    ├── config.test.js
    ├── catalog.test.js
    ├── db.test.js
    ├── orders.test.js
    ├── event-log.test.js
    ├── transitions.test.js
    ├── stripe-gateway.test.js
    ├── webhook-verifier.test.js
    ├── stripe-events.test.js
    ├── webhook-processor.test.js
    ├── api.test.js
    ├── checkout.test.js
    ├── webhook-router.test.js
    ├── app.test.js
    ├── webhook.integration.test.js
    └── persistence.integration.test.js
```

## 3. Configuration (`src/config.js`)

`loadConfig(env = process.env)` returns a frozen object or throws `ConfigError`. `server.js` imports `dotenv/config` before calling it; tests pass a plain object instead.

| Env var | Field | Rule |
|---|---|---|
| `STRIPE_SECRET_KEY` | `stripeSecretKey` | Required; must start with `sk_test_` (R7.1). An `sk_live_` key gets a message saying live keys are forbidden |
| `STRIPE_PUBLISHABLE_KEY` | `stripePublishableKey` | Required; must start with `pk_test_` (R7.2) |
| `STRIPE_WEBHOOK_SECRET` | `webhookSecret` | Optional; `null` if unset (R7.3). Must start with `whsec_` if set |
| `PORT` | `port` | Integer 1–65535; defaults to `3000` (R7.4) |
| `DATABASE_PATH` | `databasePath` | Defaults to `data/stripe-demo.db` (R9.1) |
| (derived) | `baseUrl` | `http://127.0.0.1:${port}` |

On `ConfigError`, `server.js` prints the message and runs `process.exit(1)`. Secret values never appear in the message; the key's prefix is enough to explain a failure (N4).

## 4. Catalog (`src/catalog.js`)

```js
export const PRODUCTS = [
  { id: 'duck',     name: 'Rubber Duck',        description: 'For debugging conversations.', amountCents: 500 },
  { id: 'beans',    name: 'Coffee Beans (1 lb)', description: 'Fuel for late-night deploys.', amountCents: 1250 },
  { id: 'keyboard', name: 'Mechanical Keyboard', description: 'Clicky. Very clicky.',         amountCents: 8900 },
];
export function getProduct(id)       // → product | undefined
export function formatPrice(cents)   // 1250 → "$12.50"
```

Every price is at least $0.50, which is Stripe's minimum charge in USD. The currency is always `usd`.

## 5. Data model (`src/db.js`)

`openDb(path)` does the following:
1. Creates the parent directory unless the path is `:memory:`.
2. Opens a `DatabaseSync`.
3. Sets `PRAGMA journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`.
4. Runs the schema below. Every statement is `IF NOT EXISTS`, so starting against an existing database keeps its data (R9.2).

```sql
CREATE TABLE IF NOT EXISTS orders (
  id                          TEXT PRIMARY KEY,               -- 'ord_' + 16 hex chars
  product_id                  TEXT    NOT NULL,
  amount_cents                INTEGER NOT NULL CHECK (amount_cents > 0),
  currency                    TEXT    NOT NULL DEFAULT 'usd',
  method                      TEXT    NOT NULL CHECK (method IN ('checkout', 'embedded')),
  status                      TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'refunded')),
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  created_at                  TEXT    NOT NULL,               -- UTC ISO-8601 (R9.4)
  updated_at                  TEXT    NOT NULL
);

-- Dedupe ledger: exactly one row per Stripe event ever processed (R4.3)
CREATE TABLE IF NOT EXISTS processed_events (
  stripe_event_id  TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
);

-- Audit log: one row per verified delivery, duplicates included (R4.7)
CREATE TABLE IF NOT EXISTS webhook_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id    TEXT NOT NULL,
  type               TEXT NOT NULL,
  stripe_created_at  TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  order_id           TEXT REFERENCES orders(id),
  outcome            TEXT NOT NULL CHECK (outcome IN
                       ('applied', 'ignored_duplicate', 'ignored_transition',
                        'ignored_unknown_order', 'ignored_unhandled_type')),
  detail             TEXT
);
CREATE INDEX IF NOT EXISTS webhook_events_order_idx ON webhook_events(order_id);
```

Deduplication (`processed_events`) and the audit log (`webhook_events`) are separate tables. A resent event needs a new log row with outcome `ignored_duplicate` (acceptance check 9), and a primary key can't allow that and deduplicate in the same table.

There is no migration tooling (out of scope). If the schema changes during development, delete `data/` (R8.4).

## 6. Repositories

Each repository wraps prepared statements on the shared `db`. They don't open transactions themselves; the caller controls transactions.

### `src/orders.js`: `createOrdersRepo(db, { now = () => new Date() } = {})`

```js
create({ productId, amountCents, method })            // → order (status 'pending')
attachCheckoutSession(orderId, sessionId)
attachPaymentIntent(orderId, paymentIntentId)         // no-op if already set to the same id
get(orderId)                                          // → order | undefined
findByCheckoutSession(sessionId)                      // → order | undefined
findByPaymentIntent(paymentIntentId)                  // → order | undefined
list()                                                // → orders, newest first (R5.1)
setStatus(orderId, status)                            // updates status and updated_at
```

Rows come back in camelCase (`amountCents`, `stripePaymentIntentId`, …).

### `src/event-log.js`: `createEventLog(db, { now })`

```js
isProcessed(stripeEventId)                             // → boolean
markProcessed(stripeEventId)
append({ event, orderId, outcome, detail })            // derives type, stripe_created_at from event
list({ limit = 200 } = {})                             // newest first (R5.3)
listForOrder(orderId)                                  // oldest first (R5.4)
```

## 7. Status transitions (`src/transitions.js`)

These are pure functions, and the processor's rules come entirely from them.

```js
const ALLOWED = {
  pending:  ['paid', 'failed', 'canceled'],
  failed:   ['paid'],
  paid:     ['refunded'],
  canceled: [],
  refunded: [],
};
export function canTransition(from, to)  // (R4.6)

// Maps a Stripe event to the status it asks for, or null if the event
// makes no status request (unhandled type, or completed-but-unpaid session).
export function eventTarget(event)       // (R4.2)
```

| Event type | Target status | Condition |
|---|---|---|
| `checkout.session.completed` | `paid` | `data.object.payment_status === 'paid'` |
| `payment_intent.succeeded` | `paid` | always |
| `payment_intent.payment_failed` | `failed` | always |
| `checkout.session.expired` | `canceled` | always |
| `charge.refunded` | `refunded` | `data.object.refunded === true` (full refund) |
| anything else | `null` | → `ignored_unhandled_type` |

`HANDLED_TYPES` is exported so the README and tests share one list.

## 8. Webhook processing

### 8.1 Verifier (`src/webhook-verifier.js`)

```js
createWebhookVerifier(secret)  // secret may be null
  .verify(rawBody: Buffer, signatureHeader: string | undefined) → event
```

- If `secret` is null, it throws `WebhookNotConfiguredError` (R7.3).
- Otherwise it calls `Stripe.webhooks.constructEvent(rawBody, header, secret)` with the default 300-second tolerance. Any failure is rethrown as `WebhookSignatureError`, whether the header is missing, the signature doesn't match or the timestamp has expired.

### 8.2 Route (`src/routes/webhook.js`): `POST /webhook`

This route is mounted **before** `express.json()`, with `express.raw({ type: 'application/json' })`, because the signature is computed over the exact raw bytes.

| Condition | Response |
|---|---|
| `WebhookNotConfiguredError` | `503` |
| `WebhookSignatureError` | `400` `{ error }`, and nothing is written (R4.1) |
| Processor throws | `500`. The transaction is rolled back and the event isn't marked processed, so a redelivery is processed normally (R4.9) |
| Otherwise | `200` `{ received: true, outcome }` (R4.3, R4.4) |

**Retries:** in production, Stripe retries any non-2xx response with backoff for up to 3 days. `stripe listen` does **not** retry forwarded events. Locally, a redelivery means `stripe events resend <evt_id>` (T16 checks that this reaches the listen session).

### 8.3 Processor (`src/webhook-processor.js`)

`createWebhookProcessor({ db, orders, eventLog, logger }).process(event) → outcome`

The entire body runs inside `BEGIN IMMEDIATE … COMMIT`. On any exception it runs `ROLLBACK` and rethrows (R4.8). There is no `await` inside, so nothing interleaves.

```
1. order = resolveOrder(event)                     // read-only; may be null
2. outcome/detail, first match wins:
   a. eventLog.isProcessed(event.id)          → 'ignored_duplicate'      (skip step 3)
   b. event.type not in HANDLED_TYPES         → 'ignored_unhandled_type'
   c. order is null                           → 'ignored_unknown_order'
   d. otherwise:
        backfill: checkout.session.completed with a payment_intent id and
                  the order has none → orders.attachPaymentIntent(...)  (enables refund lookup)
        target = eventTarget(event)
        target is null                 → 'ignored_transition', detail "no status change requested"
        target === order.status        → 'ignored_transition', detail "already <status>"
        canTransition(status, target)  → orders.setStatus; 'applied', detail "<from> → <to>"
        else                           → 'ignored_transition', detail "<from> → <to> not allowed"
3. eventLog.markProcessed(event.id)
4. eventLog.append({ event, orderId: order?.id ?? null, outcome, detail })   ← last write on purpose
5. commit; logger.info(type, id, outcome, detail)                            (N4)
```

`orderId` is `null` whenever no order row matched. `webhook_events.order_id` is a foreign key, so storing a metadata `order_id` that doesn't exist would fail.

A handled type whose `eventTarget` is `null` gets `ignored_transition` with the detail "no status change requested", not `ignored_unhandled_type`. Examples are a partial refund, or a completed session that isn't paid. The event type *is* handled; it just doesn't ask for a status change.

**Resolving the order**, trying each in turn until one matches:
1. `data.object.metadata.order_id`
2. For a `checkout.session`: `orders.findByCheckoutSession(object.id)`
3. For a `payment_intent`: `orders.findByPaymentIntent(object.id)`
4. For a `charge`: `orders.findByPaymentIntent(object.payment_intent)`

A metadata `order_id` that doesn't exist in the database counts as unknown. That covers `stripe trigger` fixtures, which carry no metadata at all (acceptance check 10).

**Same-status events:** a hosted Checkout payment sends both `payment_intent.succeeded` and `checkout.session.completed`, in either order. Whichever arrives second asks for `paid → paid`, which isn't in `ALLOWED`, so it's logged as `ignored_transition` with the detail "already paid" (step 2d). This is expected and teaches that you often receive more than one event per payment.

## 9. Stripe gateway (`src/stripe-gateway.js`)

`createStripeGateway(secretKey, { client } = {})` wraps `client ?? new Stripe(secretKey)`. The optional `client` lets the unit test check the exact parameters sent to Stripe without network access. It uses the library's pinned API version (`2026-08-26.dahlia` for stripe@22). No other module imports `stripe`, except the verifier, which uses only the static `Stripe.webhooks`.

```js
createCheckoutSession({ orderId, product, successUrl, cancelUrl })  // → { id, url }
expireCheckoutSession(sessionId)                                     // → void
createPaymentIntent({ orderId, product })                            // → { id, clientSecret }
createRefund({ paymentIntentId, orderId })                           // → { id }
```

The parameters sent to Stripe:

- **Checkout Session:**
  - `mode: 'payment'`
  - `line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount, product_data: { name, description } } }]`
  - `metadata: { order_id }`
  - `payment_intent_data: { metadata: { order_id } }`, so the PaymentIntent that Checkout creates can also be traced back to the order (R2.2)
  - `success_url`, `cancel_url`
- **PaymentIntent:** `amount`, `currency: 'usd'`, `metadata: { order_id }`, `automatic_payment_methods: { enabled: true }` (R3.1)
- **Refund:** `payment_intent`, `metadata: { order_id }` (R6.1)

## 10. HTTP API (`src/app.js`, `src/routes/*`)

Each route module exports a factory that returns an `express.Router`, so each can be built and tested without `app.js`:

```js
createWebhookRouter({ verifier, processor, logger })                     // routes/webhook.js: applies express.raw itself
createCheckoutRouter({ config, orders, gateway, logger, publicDir })     // routes/checkout.js
createApiRouter({ config, orders, eventLog, gateway, logger })           // routes/api.js: mounted at /api
```

`logger` is anything with `info`, `warn` and `error` methods: `console` in production, and a silent stub in tests.

`createApp({ config, db, gateway, verifier, logger })` builds the repositories and the processor, then mounts, in this order:
1. The webhook router (raw body)
2. `express.json()` and `express.urlencoded()`
3. The checkout router
4. The API router at `/api`
5. `express.static('public')`
6. A JSON 404 handler and an error handler

Errors are returned as `{ "error": { "message": "…" } }`.

| Method & path | Body / query | Success | Errors | Req |
|---|---|---|---|---|
| `GET /api/config` | – | `200 { publishableKey }` | | R3.2 |
| `GET /api/products` | – | `200 [{ id, name, description, amountCents, price }]` | | R1.1 |
| `POST /checkout` | form: `productId` | `303 Location: <session.url>` | `400` unknown product | R2.1, R2.5 |
| `GET /cancel` | `?order_id=` | `200` cancel.html | – | R2.4 |
| `POST /api/payment-intents` | JSON `{ productId }` | `201 { orderId, clientSecret }` | `400` unknown product | R3.1 |
| `GET /api/orders` | – | `200 [order + productName, price, dashboardUrl]` | | R5.1, R5.2 |
| `GET /api/orders/:id` | – | `200 { order: order + productName, price, dashboardUrl, events: [event log rows + dashboardUrl] }` | `404` | R4.5, R5.4 |
| `POST /api/orders/:id/refund` | – | `202 { refundId }` | `404`; `409` unless `paid` with a PaymentIntent id | R6 |
| `GET /api/events` | – | `200 [event log rows + dashboardUrl]` | | R5.3 |
| `POST /webhook` | raw Stripe event | see §8.2 | | R4 |

These are the flows that have more than one step:

- **`POST /checkout`:** look up the product (400 if unknown, before any write) → `orders.create(method='checkout')` → `gateway.createCheckoutSession` with:
  - `successUrl = ${baseUrl}/success.html?order_id=${id}`
  - `cancelUrl = ${baseUrl}/cancel?order_id=${id}`

  → `orders.attachCheckoutSession` → `303` to `session.url`. It's a plain HTML form post, so this path needs no frontend JS.
- **`GET /cancel`:** if the order is `pending` and has a session, call `gateway.expireCheckoutSession`. Stripe then sends `checkout.session.expired`, and the webhook moves the order to `canceled`. That keeps webhooks the only thing that changes status (R4.2). Errors are logged and swallowed, since the page must still render. It then serves `cancel.html`.
- **`POST /api/payment-intents`:** look up the product → `orders.create(method='embedded')` → `gateway.createPaymentIntent` → `orders.attachPaymentIntent` → return **only** `{ orderId, clientSecret }`. The client secret is never logged (N4).
- **Refund:** calls `gateway.createRefund` and returns `202`. The status doesn't change until `charge.refunded` arrives (R6.2).

If the gateway fails after the order row was created, the order stays `pending` with no Stripe ID, and the route returns `502`. That's harmless: an order in that state is visible and never moves anywhere.

**Dashboard links** (R5.2, R5.3) are built on the server:
- An order with a PaymentIntent links to `https://dashboard.stripe.com/test/payments/<pi_id>`.
- An order with only a Checkout Session links to `https://dashboard.stripe.com/test/checkout/sessions/<cs_id>`.
- An event links to `https://dashboard.stripe.com/test/events/<evt_id>`.

## 11. Frontend

These are plain ES modules loaded with `<script type="module">`. Stripe.js is loaded from `https://js.stripe.com/v3/`, which is required to come from Stripe and can't be bundled, and it's included only on `pay.html`.

| Page | Behavior |
|---|---|
| `index.html` | Fetches `/api/products` and renders cards. Each card has a `<form method="post" action="/checkout">` with a hidden `productId` (R2), plus a link to `pay.html?product=<id>` (R3) |
| `pay.html` | Fetches `/api/config`, then `POST /api/payment-intents`, then `stripe.elements({ clientSecret })` and mounts a `payment` element. On submit it calls `stripe.confirmPayment({ elements, redirect: 'if_required', confirmParams: { return_url: success URL } })`. On `error` it shows `error.message` inline and keeps the element mounted so the visitor can retry (R3.3, R3.4). On success it goes to `success.html?order_id=…`. 3D Secure appears as a modal in the same flow |
| `success.html` | Polls `GET /api/orders/:id` every 1 s while the status is `pending`, up to 30 s. It shows the status, and after the timeout it suggests checking that `stripe listen` is running (R4.5) |
| `cancel.html` | A static message with a link back home and to the orders page |
| `orders.html` | A table from `/api/orders` with status badges and Dashboard links. `paid` rows get a Refund button (`POST …/refund`), after which the page polls the row until it changes (R5.1, R5.2, R6) |
| `order.html` | The order's fields plus the events that affected it, from `/api/orders/:id` (R5.4) |
| `events.html` | A table from `/api/events`: time, type, order link, outcome and Dashboard link (R5.3) |

`common.js` exports `fetchJson(url, opts)` (which throws on non-2xx using the API's error message), `statusBadge(status)` and `outcomeBadge(outcome)`. Pages insert data with `textContent`, never `innerHTML` with data in it.

## 12. Startup (`src/server.js`)

```
import 'dotenv/config'
config   = loadConfig()                    → on ConfigError: print, exit(1)   (R7.1, R7.2)
db       = openDb(config.databasePath)                                        (R9.2)
gateway  = createStripeGateway(config.stripeSecretKey)
verifier = createWebhookVerifier(config.webhookSecret)
if (!config.webhookSecret) console.warn(<prominent banner>)                   (R7.3)
app      = createApp({ config, db, gateway, verifier, logger: console })
app.listen(config.port, '127.0.0.1')                                          (R7.4)
print: app URL, and "stripe listen --all-snapshot --forward-to 127.0.0.1:<port>/webhook"
```

## 13. Testing strategy

Every test uses `node:test` and `node:assert/strict`, and `npm test` runs `node --test`. No test needs network access or real keys (N1, acceptance check 7).

### Helpers
- **`fake-gateway.js`:** `createFakeGateway()` returns the gateway interface. It records every call in `calls[]` and returns deterministic IDs (`cs_test_fake_1`, `pi_test_fake_1`, …) and URLs. `failNext(method)` makes the next call reject, for testing the `502` path.
- **`stripe-events.js`:**
  - Builders such as `checkoutSessionCompleted({ orderId, sessionId, paymentIntentId })`, `paymentIntentSucceeded(…)`, `paymentIntentFailed(…)`, `checkoutSessionExpired(…)`, `chargeRefunded(…)` and `unhandled(type)`. Each returns an event object with a unique `evt_…` ID unless one is given.
  - `sign(event, secret, { timestamp })`: returns `{ body, header }` using the real `Stripe.webhooks.generateTestHeaderString`.
- **`test-server.js`:** `startTestServer({ databasePath = ':memory:', webhookSecret = 'whsec_test_secret', gateway })` builds the real app with the fake gateway and real verifier, listens on port 0, and returns `{ url, db, gateway, postWebhook(event, opts), close() }`.

### Coverage map

| Test file | Level | Covers |
|---|---|---|
| `config.test.js` | unit | Missing, live and malformed keys; defaults; `whsec_` check; the error message doesn't contain the secret (R7, N4) |
| `catalog.test.js` | unit | `getProduct`, `formatPrice`, and every price ≥ 50 cents |
| `db.test.js` | unit | Schema created; reopening a temp file keeps the rows; CHECK constraints reject bad status and outcome values (R9) |
| `orders.test.js` | unit | Repository CRUD, lookups and newest-first ordering |
| `transitions.test.js` | unit | Every pair in the `ALLOWED` table, and every row of the event→target table (R4.2, R4.6) |
| `webhook-processor.test.js` | unit (real DB) | Each outcome; checkout `payment_intent` backfill; both arrival orders for checkout's two events; rollback when a temporary trigger makes the log insert fail (R4.8) |
| `api.test.js` | HTTP | Products and config; payment-intent creation (amount from the catalog, a client price ignored, metadata, response contains only `orderId` and `clientSecret`); unknown product → 400 and no order; refund 202/404/409; orders and events listing (R1.3, R3.1, R5, R6) |
| `checkout.test.js` | HTTP | 303 to the session URL; session parameters (amount, both metadata fields, success and cancel URLs); unknown product → 400 and no gateway call; `/cancel` expires only pending orders and still renders when the gateway fails; gateway failure → 502 (R2) |
| `webhook.integration.test.js` | HTTP + real signatures | Valid, tampered-body, wrong-secret, missing-header and expired-timestamp cases; no secret → 503; every R4.2 transition checked in the DB; duplicate → `ignored_duplicate` with the DB unchanged; out-of-order failed-after-paid; unknown order and unhandled type → 2xx; failure → 500 with no `processed_events` row, then a resend succeeds (R4, N2a) |
| `persistence.integration.test.js` | HTTP + temp file | Create and pay an order → close the server → start a new server on the same file → order still `paid`, event log intact, and resending the same event gives `ignored_duplicate` (R4.3, R9.3) |

**Forcing a processor failure without test hooks in production code:** the test runs `CREATE TEMP TRIGGER fail_log BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT, 'boom'); END;` on the test database. The order update runs before the log insert, so the test can check that the rollback undid it.

## 14. Requirement traceability

| Requirement | Implemented in |
|---|---|
| R1 | `catalog.js`, `GET /api/products`, `index.html` |
| R2 | `routes/checkout.js`, `stripe-gateway.createCheckoutSession`/`expireCheckoutSession`, `success.html`, `cancel.html` |
| R3 | `POST /api/payment-intents`, `stripe-gateway.createPaymentIntent`, `pay.html` |
| R4 | `webhook-verifier.js`, `routes/webhook.js`, `webhook-processor.js`, `transitions.js`, `event-log.js` |
| R5 | `GET /api/orders[/:id]`, `GET /api/events`, `orders.html`, `order.html`, `events.html` |
| R6 | `POST /api/orders/:id/refund`, `stripe-gateway.createRefund`, `orders.html` |
| R7 | `config.js`, `server.js` |
| R8 | `README.md`, `package.json` scripts |
| R9 | `db.js`, `orders.js`, `event-log.js` |
| N1–N4 | §1 wiring, §13 tests, `package.json` dependencies, logger calls in the processor and routes |

## 15. Parallelization boundaries (input to tasks.md)

Once the contracts in §3–§10 are fixed, modules depend only on those interfaces, not on each other's implementations. [tasks.md](tasks.md) has the actual waves and file ownership. In summary:
- The frontend and README need only the contracts.
- Leaf modules need only `package.json` and the schema.
- The processor and routers need the leaf modules.
- `app.js` puts everything together, and the integration tests come last.

## 16. End-to-end tests (N2b)

These tests use the real app, real Stripe test mode and a real `stripe listen`, all in one opt-in command. There's no browser: the tests drive payments with Stripe's API, the same way Stripe.js would in the browser.

### Layout and running
```
e2e/
├── harness.js        # startE2E() → { url, db, stripe, api, waitFor, stripeCli, stop }
└── flows.e2e.js      # the flows, run in sequence
```
- The script is `"test:e2e": "node --test --test-concurrency=1 'e2e/**/*.e2e.js'"`.
- The directory sits outside `test/`, and its files are named `*.e2e.js`, so plain `node --test` (`npm test`) never picks them up.

### Harness: `startE2E()`
1. **Keys:** read `.env` with `dotenv.config({ processEnv: {}, quiet: true })`, which parses the file without touching `process.env`. Take only `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, then pass them through `loadConfig`. That rejects live keys (C2), and a missing key fails with the `ConfigError` message.
2. **Stripe CLI:** run `stripe version`. If the CLI is missing (ENOENT), fail with the `brew install` command.
3. **Webhook secret:** run `stripe listen --print-secret`, expecting a `whsec_…` value. If it fails, tell the user to run `stripe login`. The secret is never logged or written anywhere.
4. **App:** runs in-process on port 0 on `127.0.0.1`.
   - It's built with `createApp`, using the real `createStripeGateway` and `createWebhookVerifier`.
   - The database is a temp file under `os.tmpdir()`.
   - Log lines are collected in memory and printed only when a test fails.
5. **Listener:**
   1. Start `stripe listen --all-snapshot --forward-to 127.0.0.1:<port>/webhook`.
   2. Wait for `Ready!` in its output, for up to 30 seconds.
   3. Start the tests.

   This is a second listen session. Any other session you have open, such as your dev server's, gets the same events and logs them as `ignored_unknown_order`, which is harmless.
6. **Helpers:**
   - `stripe`: a `Stripe` client created with the test secret key, used to drive payments.
   - `api(method, path, body?)`: sends a JSON or form request and returns `{ status, headers, body }`.
   - `waitFor(fn, { what, timeout = 30_000 })`: polls every 250 ms. On timeout it names what it was waiting for and suggests likely causes: `stripe listen` not forwarding, or the CLI logged into a different account from `STRIPE_SECRET_KEY`.
   - `stripeCli(...args)`: runs `stripe` synchronously and throws if it exits non-zero.
7. **`stop()`:** stop the listener, close the server and the database, and delete the temp directory.

### Flows (`flows.e2e.js`)

The flows share one harness and run in order. Each test has a 60-second timeout, and each one filters the event log by its own order or event IDs, because other activity on the account also arrives.

| # | Flow | Steps | Asserts |
|---|---|---|---|
| 1 | Embedded success | `POST /api/payment-intents`, then `stripe.paymentIntents.confirm(pi, { payment_method: 'pm_card_visa', return_url })` | Order becomes `paid`; `payment_intent.succeeded` is logged `applied` |
| 2 | Decline, then retry | New order. Confirming with `pm_card_chargeDeclinedInsufficientFunds` rejects with a `card_declined` error. Wait for `failed`, then confirm again with `pm_card_visa` | `pending → failed`, then `failed → paid`, both `applied` |
| 3 | Refund | `POST /api/orders/<order from flow 1>/refund` returns `202` | Order becomes `refunded`; `charge.refunded` is logged `applied` |
| 4 | Checkout cancel | `POST /checkout` (form, `redirect: 'manual'`) returns `303` to `https://checkout.stripe.com/…`. Then `GET /cancel?order_id=…` | Order becomes `canceled` through `checkout.session.expired` |
| 5 | Real resend | `stripe events resend <flow 1's applied evt> --confirm` | A second log row for that event appears with `ignored_duplicate`; the order is unchanged |
| 6 | Trigger | `stripe trigger payment_intent.succeeded` | A new `payment_intent.succeeded` row appears with `order_id` NULL and `ignored_unknown_order` |

Confirming on the server with the secret key uses the same PaymentIntent and produces the same webhooks as `stripe.confirmPayment` in the browser. What this skips is the Payment Element UI, which stays a manual check.

## 17. TypeScript

### Toolchain
- **Running:** Node 24 runs `.ts` files directly by erasing the type syntax. Nothing is compiled or emitted:
  - `npm start` runs `node src/server.ts`.
  - `npm test` runs `node --test`, which picks up `test/**/*.test.ts` by default.
- **Checking:** `tsc` only type-checks.
  - `npm run typecheck` runs `tsc -p .`.
  - `npm test` runs `npm run typecheck && node --test`.
- **Frontend:** `public/` stays JavaScript and is excluded from `tsc`.

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "e2e"]
}
```
- `erasableSyntaxOnly` rejects syntax that type stripping can't delete: `enum`, `namespace` and constructor parameter properties. Use union types and plain objects instead.
- `verbatimModuleSyntax` means type-only imports must be written `import type …`, because stripping deletes them.
- Relative imports use the `.ts` extension: `import { openDb } from './db.ts'`.

### Shared types (`src/types.ts`)
This is the contract every module is typed against. It contains types only and has no runtime code.

```ts
import type Stripe from 'stripe';

export type OrderStatus = 'pending' | 'paid' | 'failed' | 'canceled' | 'refunded';
export type PaymentMethodKind = 'checkout' | 'embedded';
export type Outcome =
  | 'applied' | 'ignored_duplicate' | 'ignored_transition'
  | 'ignored_unknown_order' | 'ignored_unhandled_type';

export interface Product { id: string; name: string; description: string; amountCents: number }

export interface Order {
  id: string; productId: string; amountCents: number; currency: string;
  method: PaymentMethodKind; status: OrderStatus;
  stripeCheckoutSessionId: string | null; stripePaymentIntentId: string | null;
  createdAt: string; updatedAt: string;
}

export interface EventLogRow {
  id: number; stripeEventId: string; type: string; stripeCreatedAt: string; receivedAt: string;
  orderId: string | null; outcome: Outcome; detail: string | null;
}

export interface Config {
  stripeSecretKey: string; stripePublishableKey: string; webhookSecret: string | null;
  port: number; databasePath: string; baseUrl: string;
}

export interface Logger {
  info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void;
}

export interface Gateway {
  createCheckoutSession(args: { orderId: string; product: Product; successUrl: string; cancelUrl: string }):
    Promise<{ id: string; url: string }>;
  expireCheckoutSession(sessionId: string): Promise<void>;
  createPaymentIntent(args: { orderId: string; product: Product }): Promise<{ id: string; clientSecret: string }>;
  createRefund(args: { paymentIntentId: string; orderId: string }): Promise<{ id: string }>;
}

export interface OrdersRepo {
  create(args: { productId: string; amountCents: number; method: PaymentMethodKind }): Order;
  attachCheckoutSession(orderId: string, sessionId: string): void;
  attachPaymentIntent(orderId: string, paymentIntentId: string): void;
  get(orderId: string): Order | undefined;
  findByCheckoutSession(sessionId: string): Order | undefined;
  findByPaymentIntent(paymentIntentId: string): Order | undefined;
  list(): Order[];
  setStatus(orderId: string, status: OrderStatus): void;
}

export interface EventLog {
  isProcessed(stripeEventId: string): boolean;
  markProcessed(stripeEventId: string): void;
  append(args: { event: Stripe.Event; orderId: string | null; outcome: Outcome; detail?: string | null }): void;
  list(options?: { limit?: number }): EventLogRow[];
  listForOrder(orderId: string): EventLogRow[];
}

export interface WebhookVerifier { verify(rawBody: Buffer, signatureHeader: string | undefined): Stripe.Event }
export interface WebhookProcessor { process(event: Stripe.Event): Outcome }
```

### Typing rules
- **Factories:** each factory declares its return type from `types.ts`. For example, `createOrdersRepo(...): OrdersRepo`.
- **Database rows:** `node:sqlite` returns untyped rows (`Record<string, SQLOutputValue>`). Each repository casts rows once, at the point where it maps them to camelCase, and nowhere else.
- **Stripe events:** the processor and transitions take `Stripe.Event` and narrow on `event.type` to get a typed `data.object`.
  - Where a type isn't one of the five handled types, its `data.object` is read through a small structural type, `{ object: string; id: string; metadata?: Record<string, string> | null; payment_intent?: … }`.
- **Nullable Stripe fields:** Stripe types some fields as nullable even though they're set in our flows. Examples are `Checkout.Session.url` and `PaymentIntent.client_secret`. The gateway checks them and throws if one is `null`, rather than using non-null assertions.
- **Test event builders:** they build plain objects and cast them to `Stripe.Event` once, inside the helper (`as unknown as Stripe.Event`), so the tests themselves need no casts.
- **No `any`:** use `unknown` plus narrowing instead. The only exceptions are the documented boundaries above.
