# Design: Stripe Demo Shop

This document explains how the app works and why it's built this way. [requirements.md](requirements.md) says *what* it must do (requirement IDs such as R4.2 point there), and [tasks.md](tasks.md) records how it was built. The code is the final word on details. Where this document gives a contract (a signature, a status code, a schema), the code matches it.

**How to read it:** §1 gives the mental model, and §2 follows a payment from start to finish. Those two are enough to understand the app. The rest is a guide to each part.

---

## 1. The big picture

A tiny shop that runs on your laptop against Stripe **test mode**. Visitors buy a product or make a donation, pay with a test card, and watch Stripe's webhooks move the order from `pending` to `paid`.

### Three ideas behind the design

1. **The browser starts a payment; only a verified webhook finishes it.** Redirects and success pages prove nothing, because anyone can open a URL. An order changes status only when Stripe sends a signed event saying so (R4).
2. **The server decides what things cost, and never sees a card.**
   - Product prices come from the server's catalog. The only amount the browser supplies is a donation, and the server validates it (R1.3, R10).
   - Card details go straight from the visitor to Stripe, through Stripe's hosted page or Stripe's iframe (C3).
3. **Everything runs locally, and connections go outward.** The server listens only on `127.0.0.1`. Stripe events arrive through `stripe listen`, and visitors can arrive through an optional ngrok tunnel. Both open *outbound* connections from the laptop, so nothing on the machine accepts connections from the internet (C1).

### The core loop

The whole app is built around one loop: a payment starts in the browser, happens at Stripe, and comes back as a verified event that the order's state machine either applies or ignores.

```
 Browser ──── starts a payment ────▶ Express app ──── creates it (secret key) ────▶ Stripe
    ▲                                    │                                          │
    │ shows status                       │ order saved as "pending"                 │ card entered on Stripe's page
    │ (polls the order)                  ▼                                          │ or in Stripe's iframe
    │                                 SQLite ◀──────────┐                           │
    │                                                   │ one transaction           │ signed event
    └──────────────── Express app ◀── state machine ◀── verifier ◀── POST /webhook ◀┘
                                     (current status + event
                                      → next status, or ignored)
```

**Stripe owns the payment. The app owns order state. Signed webhooks are the only bridge from one to the other.** §2 follows the loop through each payment flow, §3 describes the state machine, and §4 covers the webhook side.

### The pieces

| Piece | Role |
|---|---|
| **Browser pages** (`public/`) | Show the shop, start payments, and show order status. Plain HTML and JavaScript, with no build step |
| **Express app** (`src/`) | Owns prices, orders and the event log. Talks to Stripe with the secret key. Receives webhooks |
| **SQLite** (`data/stripe-demo.db`) | Stores orders, the event log, and the IDs of events already processed. Survives restarts |
| **Stripe** | Takes card details, moves the (test) money, and emits events |
| **`stripe listen`** | Carries events from Stripe to `127.0.0.1:3000/webhook`. `npm start` runs it automatically (§10) |
| **ngrok** (optional) | Gives the site a public HTTPS URL for sharing, by forwarding to `127.0.0.1:3000` (§10) |

### Technology choices

| Choice | Why |
|---|---|
| Node 24, TypeScript run directly (type stripping), ESM | Types with no build or transpile step. `tsc` only type-checks (§12) |
| Express 5 | Small and familiar, and its async errors reach the error handler |
| `node:sqlite` (built in) | No extra dependency. Each webhook is processed in one SQLite transaction, which is what keeps it correct (§4) |
| `stripe` npm package, used in exactly one module | All Stripe API calls go through `stripe-gateway.ts`, which tests swap for a fake (§5) |
| Plain HTML and JS pages, no framework | Nothing to build, and every line is readable when you're learning |
| Built-in `node:test` | No test dependencies. Runtime dependencies are just `express`, `stripe` and `dotenv` (N3) |

---

## 2. How a payment works

### 2.1 Buying through hosted Checkout

```
Browser                          Server                                   Stripe
  │ POST checkout (productId)      │                                        │
  ├───────────────────────────────▶│ price ← catalog (browser can't set it) │
  │                                │ INSERT order ord_… (pending)           │
  │                                │ create Checkout Session ──────────────▶│
  │                                │   metadata.order_id = ord_…            │
  │                                │   payment_intent_data.metadata = same  │
  │◀─── 303 to checkout.stripe.com ┤◀───────────── { id: cs_…, url }        │
  │ visitor enters card on Stripe's page ──────────────────────────────────▶│ charges card
  │◀──────────── redirect to BASE_URL/success.html?order_id=ord_…           │
  │ success page polls the order every 1 s (still "pending")               │
  │                                │◀════ webhooks via stripe listen ═══════┤
  │                                │   checkout.session.completed → paid    │
  │ next poll shows "paid"         │                                        │
```

Two things to notice:
- The redirect to the success page changes nothing. The order became `paid` because of `checkout.session.completed`.
- Stripe sends **several events per payment**, in no guaranteed order: `payment_intent.created`, `charge.succeeded`, `payment_intent.succeeded`, `checkout.session.completed`, `charge.updated`. One of them applies `pending → paid`. The other "paid" event is logged as `ignored_transition` ("already paid"), and the rest as `ignored_unhandled_type`. See §3 and §4.

### 2.2 Paying with the embedded form (Payment Element)

1. `pay.html?product=duck` fetches the publishable key (`GET api/config`).
2. It calls `POST api/payment-intents`. The server creates a `pending` order and a PaymentIntent, and returns **only** `{ orderId, clientSecret }`.
3. It fetches the new order (`GET api/orders/:id`) to show "Rubber Duck: $5.00", so the amount shown is the one the server accepted.
4. It mounts Stripe's Payment Element, an iframe served from `js.stripe.com`. Our JavaScript can't read what's typed into it.
5. On submit, it calls `stripe.confirmPayment({ redirect: 'if_required' })`. The card goes from the iframe straight to Stripe.
   - **Declined** (for example `4000 0000 0000 9995`): Stripe's message appears inline, and the visitor can try another card. Stripe sends `payment_intent.payment_failed`, so the order becomes `failed`. A successful retry then moves it `failed → paid`.
   - **3D Secure** (for example `4000 0025 0000 3155`): Stripe.js shows the challenge itself.
   - **Success:** the page goes to `success.html?order_id=…`, which polls as in 2.1 until `payment_intent.succeeded` marks the order `paid`.

The client secret only lets the browser confirm *that* PaymentIntent. It can't change the amount, which needs the secret key. The server never logs it.

### 2.3 Donating

A donation uses the same two flows. The only difference is where the amount comes from. The Donate page sends `productId=donation` plus `amount` in dollars, such as `"12.50"`. The server's `resolveItem` validates it: $1.00–$1,000.00, at most two decimal places, converted to cents with string arithmetic so `19.99` becomes exactly `1999`. It then builds an item named "Donation" with that amount (§7). From that point on, a donation is an ordinary order with `product_id = 'donation'`.

### 2.4 Cancelling hosted Checkout

Stripe's "back" link goes to `cancel?order_id=…`. Loading that page changes nothing on its own. The page's script then sends `POST api/orders/:id/cancel`, and the server asks Stripe to **expire** the session. Stripe sends `checkout.session.expired`, and the webhook moves the order to `canceled`. So even a cancellation takes effect through a webhook.

The state change is a POST from the page rather than a side effect of `GET /cancel`, because link prefetchers, crawlers and browser extensions fetch URLs freely but don't run page scripts.

### 2.5 Refunding

The Refund button on the Orders page calls `POST api/orders/:id/refund`.
- **Accepted:** for a `paid` order with a PaymentIntent, the server asks Stripe for a full refund and returns `202`. The order stays `paid` until `charge.refunded` arrives and applies `paid → refunded`.
- **Rejected:** any other order gets `409`, and no call to Stripe.

Refunds work for Checkout orders too. Checkout creates the PaymentIntent itself, and the first event that mentions it saves its ID on the order (§4).

### 2.6 When a webhook is missed

`stripe listen` doesn't retry deliveries, and it doesn't replay events that happened while it wasn't running. If an order stays `pending` after a successful payment:
1. Make sure the listener is running. `npm start` runs it and warns loudly if it dies.
2. Find the event (`stripe events list`, or the Stripe Dashboard) and redeliver it with `stripe events resend <evt_id>`.

Resending is always safe. An event that was already processed is recognised by its ID and logged as `ignored_duplicate` (§4). In production, Stripe itself retries failed deliveries for up to 3 days.

---

## 3. The order lifecycle

Every order has one of five statuses. Only webhooks change them, and only along these arrows (R4.6):

```
            ┌──────────▶ paid ──────────▶ refunded
 pending ───┼──────────▶ failed ──┐
            └──────────▶ canceled │
                         paid ◀───┘   (a retry that succeeds)
```

`canceled` and `refunded` are final. Any other move is refused, for example `payment_intent.payment_failed` arriving *after* `paid`, which can happen because Stripe doesn't guarantee event order. It's logged as `ignored_transition`, and the order stays as it was.

The five events we act on (`src/transitions.ts`, R4.2):

| Event | Asks for | Only when |
|---|---|---|
| `checkout.session.completed` | `paid` | `payment_status` is `paid` |
| `payment_intent.succeeded` | `paid` | always |
| `payment_intent.payment_failed` | `failed` | always |
| `checkout.session.expired` | `canceled` | always |
| `charge.refunded` | `refunded` | `refunded` is `true` (a full refund) |

Every other event type is recorded and acknowledged, but changes nothing.

---

## 4. Inside the webhook

`POST /webhook` is the heart of the app. It runs in three stages.

### Stage 1: verify the signature (`routes/webhook.ts`, `webhook-verifier.ts`)

Stripe signs each delivery with HMAC-SHA256 over `timestamp + "." + raw body`, using the shared `whsec_…` secret. The route reads the **raw bytes** itself, using `express.raw`, before any JSON parsing, because re-serialized JSON wouldn't match the signature. It then calls `Stripe.webhooks.constructEvent`, which also rejects signatures more than 5 minutes old.

| Result | Response |
|---|---|
| No secret configured | `503` |
| Missing, wrong or expired signature | `400`, and nothing is written (R4.1) |
| Verified, but processing threw | `500`, and the transaction is rolled back (R4.9) |
| Verified and processed | `200 { received: true, outcome }` |

### Stage 2: decide, inside one transaction (`webhook-processor.ts`)

Everything below runs in **one SQLite transaction** (`BEGIN IMMEDIATE` … `COMMIT`), and any error triggers `ROLLBACK` (R4.8). That transaction is the correctness boundary: the dedupe record, the status change and the log row are all written, or none are. (With `node:sqlite` the calls are also synchronous, so no other request runs in the middle, but correctness doesn't depend on that. `BEGIN IMMEDIATE` takes the write lock up front either way.)

**1. Find the order,** trying each of these until one matches:
1. `data.object.metadata.order_id`. We set it on every Checkout Session, and on every PaymentIntent, including the ones Checkout creates.
2. For a Checkout Session: look up by the session ID.
3. For a PaymentIntent: look up by the PaymentIntent ID.
4. For a Charge: look up by `charge.payment_intent`. Refund events rely on this.

Stripe types `payment_intent` as "an ID, or the expanded object", and the processor accepts both. A metadata `order_id` that doesn't exist falls through to the ID lookups. An event matching nothing is an **unknown order**, such as the fixtures that `stripe trigger` creates.

**2. Link the PaymentIntent.** If the order has no PaymentIntent ID yet, save the one the event carries: the PaymentIntent's own ID, or a session's or charge's `payment_intent`. It's skipped if another order already owns that ID. Checkout orders learn their PaymentIntent this way, and it also repairs an order whose ID was never saved (see "When things fail halfway"). This only happens for handled events that matched an order, so it's done between rules c and d below.

**3. Choose the outcome.** The first rule that matches wins:

| # | Rule | Outcome | Detail |
|---|---|---|---|
| a | Already processed this event ID | `ignored_duplicate` | — |
| b | Not one of the five types in §3 | `ignored_unhandled_type` | — |
| c | No order found | `ignored_unknown_order` | — |
| d | The event asks for no change (unpaid session, partial refund) | `ignored_transition` | `no status change requested` |
| e | The order already has the requested status | `ignored_transition` | `already paid` |
| f | The move is allowed (§3) | `applied`: the status is updated | `pending → paid` |
| g | Otherwise | `ignored_transition` | `paid → failed not allowed` |

Rules d–g are the order state machine. They're one pure function, `applyPaymentEvent(currentStatus, event)` in `transitions.ts`, with no database and no Stripe calls. It returns either "apply, moving to X" or "ignore, because Y". The processor only adds what surrounds it: deduplication, finding the order, linking IDs, and writing the result.

**4. Record it:**
- Unless it was a duplicate, insert the event ID into `processed_events`.
- Then append a row to the event log, `webhook_events`. This is deliberately the **last write**, so if logging fails, the whole decision rolls back.
- After the commit, log one line: `webhook <type> <evt_id>: <outcome> (<detail>)`.

### Stage 3: acknowledge

Return `200` with the outcome. Every verified event gets a 2xx, even one that's ignored, so Stripe never retries an event we deliberately ignored (R4.4).

**API versions:** API calls use the version pinned by the `stripe` library (`2026-08-26.dahlia`). Webhook payloads, however, are rendered in the account's default API version, which `stripe listen` prints when it starts, and which can differ. The processor deliberately depends on a minimal set of fields: `id`, `type`, `object`, `metadata`, `payment_status`, `payment_intent` and `refunded`. Those fields haven't changed across the versions in use, but that's an observation, not a guarantee. The e2e suite (§13) is what checks compatibility against the account's real version, so run it after changing either version.

### When things fail halfway

Payments cross two systems, our database and Stripe, and no operation can commit to both at once. This is how each partial failure is recovered:

| What fails | What happens | Why it's safe |
|---|---|---|
| Processing a webhook throws | Rollback, then `500`. The event isn't recorded as processed | A redelivery (Stripe's retries, or `stripe events resend`) is processed from scratch |
| Stripe rejects creating a session or PaymentIntent | The order row already exists, stays `pending` with no Stripe ID, and the route returns `502` | An order with no Stripe object never receives events, so it never changes. It's visible but harmless |
| Stripe creates the object, but the server fails before saving its ID | The order has no Stripe ID locally, while Stripe has an object carrying `metadata.order_id` | Every event finds the order by that metadata, and step 2 saves the missing PaymentIntent ID, so the payment is recorded and refunds still work. `webhook-processor.test.ts` simulates exactly this |
| The listener is down when an event happens | The event never arrives, and the order stays `pending` | `npm start` warns loudly when the listener dies. The fix is `stripe events resend`, which is always safe thanks to deduplication (§2.6) |
| Events arrive twice, or out of order | Duplicates are caught by ID; disallowed moves are ignored | The event-ID ledger plus the one-way state machine (§3) |

The pattern throughout: **write our order first, put our order ID in Stripe's metadata, and let webhooks reconcile.** Stripe's copy always carries enough to find ours.

---

## 5. Server code map

```
server.ts ── startup: config → db → gateway → stripe listen → verifier → app.listen
   │
   └─ app.ts ── wires everything; mounts the webhook at /webhook and the site under basePath
        ├─ routes/webhook.ts ─▶ webhook-verifier.ts        (signature check)
        │                    └▶ webhook-processor.ts ─▶ transitions.ts   (status rules)
        │                                            ├▶ orders.ts        ┐
        │                                            └▶ event-log.ts     ├─▶ db.ts (SQLite)
        ├─ routes/checkout.ts ─▶ catalog.ts, orders.ts, stripe-gateway.ts
        └─ routes/api.ts      ─▶ catalog.ts, orders.ts, event-log.ts, stripe-gateway.ts
```

| Module | Responsibility |
|---|---|
| `config.ts` | Reads and validates environment variables; refuses non-test keys (§10) |
| `catalog.ts` | Products, prices and images; donation parsing; `resolveItem` (§7) |
| `db.ts` | Opens SQLite (WAL, foreign keys on) and creates the schema if it's missing (§6) |
| `orders.ts`, `event-log.ts` | Repositories: prepared statements and camelCase rows. They never open transactions; their callers do |
| `transitions.ts` | The order state machine, as pure functions: `applyPaymentEvent(status, event)`, built from `eventTarget` (which status an event asks for) and `canTransition` (whether a move is allowed) |
| `webhook-verifier.ts` | Signature verification, with its two error types |
| `webhook-processor.ts` | Everything around the state machine from §4: dedupe, order lookup, PaymentIntent linking, persistence, in one transaction |
| `stripe-gateway.ts` | The **only** code that calls Stripe's API: create and expire sessions, create PaymentIntents and refunds |
| `routes/*.ts` | HTTP handlers. Each is a factory that returns an `express.Router` |
| `app.ts` | Builds the repositories and processor, mounts the routers, handles 404s and errors |
| `server.ts` | Entry point: startup, `stripe listen`, and shutdown |
| `stripe-listener.ts` | Runs `stripe listen` as a supervised child process (§10) |
| `types.ts` | Shared types only (§12) |

**Wiring:** every module is a factory that receives its dependencies, for example `createApp({ config, db, gateway, verifier, logger })`. Tests pass a fake gateway, an in-memory database and a silent logger, with no mocking library (N1).

**The gateway contract** (`stripe-gateway.ts`) returns only the fields callers need, never Stripe's full objects:

| Method | Sends to Stripe | Returns |
|---|---|---|
| `createCheckoutSession({ orderId, product, successUrl, cancelUrl })` | `mode: 'payment'`, one inline `price_data` line item (no Products or Prices need to exist in the Dashboard), `metadata.order_id`, `payment_intent_data.metadata.order_id`, the return URLs | `{ id, url }` |
| `expireCheckoutSession(sessionId)` | expire | nothing |
| `createPaymentIntent({ orderId, product })` | `amount`, `currency: 'usd'`, `metadata.order_id`, `automatic_payment_methods` | `{ id, clientSecret }` |
| `createRefund({ paymentIntentId, orderId })` | a full refund, with `metadata.order_id` | `{ id }` |

Stripe's types mark `session.url` and `client_secret` as nullable. The gateway throws a clear error if either is `null`, rather than passing `null` on to the browser.

---

## 6. HTTP interface

### Where things are mounted

- **The webhook**, `POST /webhook`, is always at the root. Only the local `stripe listen` calls it.
- **Everything else** (pages, `checkout`, `cancel` and `api/…`) is mounted under `basePath`. That's empty by default, or something like `/stripe-demo` when `BASE_URL` includes a path (§10).
- **Redirects:** with a `basePath`, both `/` and the bare `/stripe-demo` redirect to `/stripe-demo/`. The trailing slash matters, because pages use relative URLs (§8).
- **Errors:** unknown paths get a JSON `404`. Every error has the shape `{ "error": { "message": "…" } }`, and a `500` never reveals internal details.

### Routes

| Route | Input | Success | Errors |
|---|---|---|---|
| `GET api/config` | — | `{ publishableKey }` | |
| `GET api/products` | — | `[{ id, name, description, amountCents, imageUrl, price }]` | |
| `POST checkout` | form `productId`, plus `amount` for a donation | `303` to Stripe Checkout | `400` bad product or amount; `502` Stripe failed |
| `GET cancel?order_id=` | — | the cancel page only, with no side effects | |
| `POST api/orders/:id/cancel` | — | `202 { requested: true }`: Stripe is asked to expire the session, and the status changes when the webhook arrives | `404`; `409` unless a pending Checkout order; `502` |
| `POST api/payment-intents` | JSON `{ productId, amount? }` | `201 { orderId, clientSecret }` | `400`; `502` |
| `GET api/orders` | — | every order, newest first, plus `productName`, `price` and `dashboardUrl` | |
| `GET api/orders/:id` | — | `{ order (enriched as above), events (oldest first, each with dashboardUrl) }` | `404` |
| `POST api/orders/:id/refund` | — | `202 { refundId }` | `404`; `409` unless `paid` with a PaymentIntent; `502` |
| `GET api/events` | — | the latest 200 event-log rows, newest first, each with `dashboardUrl` | |
| `POST /webhook` | raw signed event | see §4 | |

**Validation before writing:** a bad product or amount is rejected before anything is written. If Stripe fails *after* the order row exists, the order stays `pending` with no Stripe ID, and the route returns `502`. That's harmless, because such an order never changes.

**Dashboard links** point at Stripe's test Dashboard:
- A PaymentIntent: `…/test/payments/<pi>`
- A session-only order: `…/test/checkout/sessions/<cs>`
- An event: `…/test/events/<evt>`

---

## 7. Money and the catalog (`catalog.ts`)

- **Products:** `PRODUCTS` is a frozen list: Rubber Duck $5.00, Coffee Beans $12.50, Mechanical Keyboard $89.00. Each has an `imageUrl`, a hotlinked Unsplash photo cropped to 600×400. All amounts are integer cents in USD, at least Stripe's $0.50 minimum.
- **`resolveItem({ productId, amount })`** is the single place a request becomes something payable. Both payment routes call it.
  - For a catalog product it returns the catalog entry and **ignores** any `amount` (R1.3).
  - For `donation` it validates `amount` and builds a Donation item (R10).
  - Otherwise it returns an error, which the route turns into a `400`.
- **`parseDollars`** accepts only strings like `12`, `12.5` or `12.50`, up to 7 digits before the point and 2 after. It converts them to cents without floating point.
- **Donation limits:** `DONATION_MIN_CENTS = 100` and `DONATION_MAX_CENTS = 100_000`.
- **`formatPrice`** gives `$1,234.50`, and **`itemName`** gives the display name, including "Donation".

---

## 8. Frontend (`public/`)

Static pages served by Express. Each has its own small ES-module script, and they share `common.js` and `styles.css`.

| Page | What it does |
|---|---|
| `index.html` (Shop) | Product cards from `api/products`. Each card has a "Buy with Checkout" form and a "Buy with embedded form" link |
| `donate.html` | $5, $10 and $25 presets plus a custom amount (`min=1`, `max=1000`, `step=0.01`). It checks the amount before either button proceeds; the server checks again |
| `pay.html` | The embedded Payment Element flow from §2.2 |
| `success.html` | Polls the order every 1 s for up to 30 s while it's `pending`, then suggests checking `stripe listen`. Explains why the redirect alone proves nothing |
| `cancel.html` | Sends `POST api/orders/:id/cancel` from its script, then explains that the order becomes `canceled` once the expiry webhook arrives. Stays quiet on a `409`, such as on a reload |
| `orders.html` | Every order, with status badges and Dashboard links. `paid` rows get a Refund button, which then polls until the webhook updates the row |
| `order.html` | One order's fields, plus every event that touched it |
| `events.html` | The whole event log, with outcome badges. Has a Refresh button |

**Conventions:**
- **Relative URLs everywhere** (`api/orders`, `orders.html`, `./`), so the same files work at `/` and under any `basePath`.
- **Data goes in with `textContent`,** never `innerHTML`.
- **`common.js`** provides `fetchJson`, which throws with the API's error message and HTTP `status`, plus `statusBadge` and `outcomeBadge`.
- **Stripe.js** loads from `js.stripe.com` on `pay.html` only. It can't be bundled.
- **One shared layout:** a 1280px column; a header whose nav is Shop · Donate · Orders · Events · GitHub ↗ with the current section highlighted; and a few building blocks from `styles.css`:
  - `.lead`: muted intro text
  - `.note`: an explanatory callout
  - `.panel`: a bordered card
  - `.details`: a label-and-value grid
  - `.table-wrap`: a table that scrolls sideways on small screens
  - `.btn`, `.btn-primary`, `.btn-sm`: buttons
  - status and outcome badges

---

## 9. Data (`db.ts`)

```sql
orders (
  id                          TEXT PRIMARY KEY,        -- 'ord_' + 16 hex characters
  product_id                  TEXT NOT NULL,           -- a catalog id or 'donation'
  amount_cents                INTEGER NOT NULL CHECK (amount_cents > 0),
  currency                    TEXT NOT NULL DEFAULT 'usd',
  method                      TEXT NOT NULL CHECK (method IN ('checkout', 'embedded')),
  status                      TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','paid','failed','canceled','refunded')),
  stripe_checkout_session_id  TEXT UNIQUE,
  stripe_payment_intent_id    TEXT UNIQUE,
  created_at, updated_at      TEXT NOT NULL            -- UTC ISO-8601
)

processed_events (                                     -- "have we handled this event?"
  stripe_event_id  TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
)

webhook_events (                                       -- "what happened on each delivery?"
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_event_id    TEXT NOT NULL,
  type               TEXT NOT NULL,
  stripe_created_at  TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  order_id           TEXT REFERENCES orders(id),       -- NULL when no order matched
  outcome            TEXT NOT NULL CHECK (outcome IN ('applied','ignored_duplicate',
                       'ignored_transition','ignored_unknown_order','ignored_unhandled_type')),
  detail             TEXT
)
-- plus an index on webhook_events(order_id)
```

**Why two event tables?** Deduplication needs one row per event ID, so a primary key does the job. The audit log needs one row *per delivery*, so a resend shows up as its own `ignored_duplicate` row. One table can't do both.

**Other conventions:**
- **Types:** money is stored as integer cents, and times as UTC ISO-8601 strings.
- **Creating the schema:** every statement is `IF NOT EXISTS`, so restarting keeps the data.
- **Changing the schema:** there's no migration tooling. After a schema change, delete `data/`.
- **Tests** use `:memory:` or a temporary file.

---

## 10. Configuration, startup and sharing

### Environment (`config.ts`, `.env`)

| Variable | Meaning |
|---|---|
| `STRIPE_SECRET_KEY` | Required, and must be `sk_test_…`. A live key is refused with an explicit "live keys are forbidden" (R7.1) |
| `STRIPE_PUBLISHABLE_KEY` | Required, and must be `pk_test_…` (R7.2) |
| `STRIPE_WEBHOOK_SECRET` | Optional. Only needed when `stripe listen` isn't started automatically |
| `PORT` | Defaults to `3000` |
| `DATABASE_PATH` | Defaults to `data/stripe-demo.db` |
| `BASE_URL` | The public URL, used for Checkout's return URLs. It may include a path, such as `https://….ngrok-free.dev/stripe-demo`, which then becomes `basePath`. It must be http(s), with no query or fragment. Defaults to `http://127.0.0.1:<port>` (R7.5) |
| `STRIPE_LISTEN` | Set to `false` to stop `npm start` running `stripe listen` (R8.5) |

- **Empty values:** an empty value counts as unset.
- **Returned config:** frozen.
- **Errors:** an error message shows only a key's prefix, never its value.

### Startup (`server.ts`)

1. Load `.env` and validate the config. Any config error prints a message and exits with code 1.
2. Open the database and create the Stripe gateway.
3. **Start `stripe listen`** unless `STRIPE_LISTEN=false` (`stripe-listener.ts`):
   1. Get the secret with `stripe listen --print-secret`. That secret wins over `STRIPE_WEBHOOK_SECRET`, because it's the one that signs what this listener forwards.
   2. Spawn `stripe listen --all-snapshot --forward-to 127.0.0.1:<port>/webhook`.
   3. Relay its output with a `[stripe]` prefix, with `whsec_…` values redacted.
   4. If it exits unexpectedly, print a loud warning that webhooks won't arrive.
   5. If the CLI is missing or not logged in, warn and carry on without it.
4. Create the verifier. With no secret at all, print a banner warning that webhooks will get `503`.
5. Listen on **`127.0.0.1` only** (R7.4). Print the local URL, the public URL if `BASE_URL` is set, and how webhooks are being received.
6. On Ctrl-C, SIGTERM or exit: stop the listener, so no `stripe listen` process is left behind.

**Why `127.0.0.1` and not `localhost`:** on macOS, `localhost` can resolve to IPv6 `::1`, where nothing is listening.

### Local networking

Nothing on the laptop accepts connections from the internet. Both inbound paths are tunnels that start *outbound* from the laptop:

```
 Visitor ──▶ ngrok's servers ══ tunnel ══▶ ngrok agent   ──▶ 127.0.0.1:3000   (the website, optional)
 Stripe  ──▶ Stripe's servers ═ tunnel ══▶ stripe listen ──▶ 127.0.0.1:3000/webhook   (events)
 127.0.0.1:3000 ─────────────────────────────────────────▶ api.stripe.com   (creating payments)
```

### Sharing through a tunnel

`ngrok http 127.0.0.1:3000 --url https://<static-domain>` gives the site a public HTTPS URL.
- **How it connects:** the ngrok agent opens an outbound connection to ngrok's servers, and makes local HTTP requests to our server on behalf of visitors.
- **Why `BASE_URL` matters:** the server can't tell it's behind a tunnel, because every request comes from `127.0.0.1`. `BASE_URL` tells it the public address, so Checkout sends visitors back to the right place.
- **Access:** there's no authentication, by choice. This is a dummy test-mode site, and orders and events are safe to show (C1).

---

## 11. Security and safety

| Concern | How it's handled |
|---|---|
| Real money | Test keys only. Live keys are refused at startup, and real cards are rejected by Stripe in test mode |
| Card data | Never touches our server or logs (hosted Checkout or Stripe's iframe). Routes read only `productId`, `amount` and IDs |
| Secrets | In git-ignored `.env`. Never logged or echoed. The client secret goes only to the browser that created the payment |
| Forged webhooks | Every event is signature-checked against the raw body, with a 5-minute window |
| Duplicates and out-of-order events | The event-ID ledger plus the one-way state machine |
| Price tampering | Catalog prices come from the server. Donation amounts are validated on the server |
| Accidental state changes | Every state-changing route is a POST. `GET` pages, including `cancel`, have no side effects, so prefetchers and crawlers can't change orders |
| XSS | Pages insert data with `textContent`. There's no Content-Security-Policy header yet (a possible hardening step) |
| Public exposure | Only through an explicit tunnel. Anyone with the URL can see orders and events and trigger refunds; accepted for a dummy site |

---

## 12. TypeScript

- **Running:** Node 24 runs `src/`, `test/` and `e2e/` as `.ts` files directly, by stripping the types. Nothing is compiled.
- **Checking:** `tsc` only type-checks (`tsconfig.json`: `strict`, `noEmit`), and `npm test` runs it first.
- **`erasableSyntaxOnly`** forbids syntax that can't simply be deleted: `enum`, `namespace` and constructor parameter properties. Use union types instead.
- **Other rules:**
  - Relative imports use `.ts` extensions.
  - Type-only imports use `import type`.
  - `public/` stays JavaScript, because browsers can't run TypeScript without a build.
- **`src/types.ts`** defines the shared shapes every module is checked against:
  - status and outcome types: `OrderStatus`, `PaymentMethodKind` and `Outcome`, as unions
  - data: `Product`, `Order`, `EventLogRow` and `Config`
  - contracts: `Logger`, `Gateway`, `OrdersRepo`, `EventLog`, `WebhookVerifier` and `WebhookProcessor`
- **Stripe events** use the `stripe` package's own `Stripe.Event` type. Checking `event.type` narrows `data.object` to the right Stripe object.
- **Casts** appear only at boundaries: database rows are cast once where they're mapped to camelCase, and test event builders cast once inside the helper. There's no `any`.

---

## 13. Testing

| Layer | Command | What it proves |
|---|---|---|
| Type check | part of `npm test` | Every module matches `types.ts` and Stripe's types |
| Unit and HTTP tests | `npm test` (offline, no keys) | Logic, routes, config, real HMAC signatures, transactions and rollback, restarts, serving under a prefix, the listener's supervision |
| End to end | `npm run test:e2e` | The real app against real Stripe test mode and a real `stripe listen` |
| Manual | a browser | Stripe's hosted page, 3D Secure, and how the pages look |

### Techniques worth knowing

- **Real signatures:** tests sign payloads with Stripe's own `generateTestHeaderString`. Signature checking is never mocked.
- **A fake gateway** (`test/helpers/fake-gateway.ts`) records calls as a union keyed by method. Checking `call.method` gives typed `call.args`, and `failNext(method)` simulates a Stripe failure.
- **Event builders** (`test/helpers/stripe-events.ts`) build realistic `Stripe.Event`s. Omitting `orderId` mimics `stripe trigger` fixtures, and passing a fixed `id` creates duplicates.
- **`startTestServer({ baseUrl, webhookSecret, … })`** runs the real app on port 0, with a `postWebhook` helper that signs and sends events.
- **Forcing a rollback without test hooks in production code:** a temporary SQLite trigger makes the event-log insert fail, and the test checks the order change was undone.
- **A fake Stripe CLI:** a shell script in a temp directory tests `stripe-listener.ts` offline.

### The end-to-end suite (`e2e/`)

- **Setup:** it reads only the two API keys from `.env`, gets its own webhook secret from the CLI, and runs its own server on a random port with a temporary database, plus its own `stripe listen`.
- **How it pays:** it confirms payments through Stripe's API with test payment methods such as `pm_card_visa`.
- **The flows:**
  - embedded payment
  - decline, then retry
  - custom-amount donation
  - refund
  - Checkout cancellation
  - a real `stripe events resend`, giving `ignored_duplicate`
  - `stripe trigger`, giving `ignored_unknown_order`
- **Isolation:** the files sit outside `test/` and are named `*.e2e.ts`, so `npm test` never runs them.

### Where each area is tested

| Area | Tests |
|---|---|
| Config and keys | `config.test.ts` |
| Catalog, donations, money | `catalog.test.ts` |
| Schema and repositories | `db.test.ts`, `orders.test.ts`, `event-log.test.ts` |
| Status rules | `transitions.test.ts` |
| Webhook decision logic | `webhook-processor.test.ts` |
| Signature and route behavior | `webhook-verifier.test.ts`, `webhook-router.test.ts`, `webhook.integration.test.ts` |
| Stripe parameters | `stripe-gateway.test.ts` |
| API and Checkout routes | `api.test.ts`, `checkout.test.ts` |
| App assembly, startup refusal, prefix mounting | `app.test.ts`, `base-path.test.ts` |
| Restarts | `persistence.integration.test.ts` |
| `stripe listen` supervision | `stripe-listener.test.ts` |
| Test helpers themselves | `stripe-events.test.ts` |

---

## 14. Requirement traceability

| Requirement | Where |
|---|---|
| R1 Catalog | `catalog.ts`, `GET api/products`, `index.html` |
| R2 Hosted Checkout | `routes/checkout.ts`, `POST api/orders/:id/cancel`, `stripe-gateway.ts`, `success.html`, `cancel.html`, `cancel.js` |
| R3 Embedded form | `POST api/payment-intents`, `stripe-gateway.ts`, `pay.html` |
| R4 Webhooks | `routes/webhook.ts`, `webhook-verifier.ts`, `webhook-processor.ts`, `transitions.ts`, `event-log.ts` |
| R5 Visibility | `GET api/orders[/:id]`, `GET api/events`, `orders.html`, `order.html`, `events.html` |
| R6 Refunds | `POST api/orders/:id/refund`, `stripe-gateway.ts`, `orders.html` |
| R7 Startup safety, `BASE_URL` | `config.ts`, `server.ts`, `app.ts` |
| R8 Developer experience, auto `stripe listen` | `README.md`, `package.json`, `stripe-listener.ts`, `server.ts` |
| R9 Persistence | `db.ts`, `orders.ts`, `event-log.ts` |
| R10 Donations | `catalog.ts` (`resolveItem`), both payment routes, `donate.html`, `pay.js` |
| N1–N5 | Factory wiring (§5), tests (§13), dependencies (§1), logging (§4), TypeScript (§12) |
