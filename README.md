# Stripe Demo Shop

A tiny shop for learning how Stripe payments work from start to finish: creating a payment, confirming it through webhooks, and recording the result.

- **Local only.** The server listens on `127.0.0.1` and is never meant to be deployed.
- **Test mode only.** The server refuses to start unless the keys are `sk_test_…` and `pk_test_…`. Live keys (`sk_live_…`) are rejected with an error.
- **No real money.** Test mode uses Stripe's test cards. Real card numbers are never accepted.

Stack: Node 24, Express, SQLite through the built-in `node:sqlite` module, and plain HTML/JS pages with no build step.

## Prerequisites

- Node.js 24 or later
- The Stripe CLI, which forwards webhooks to your machine:

  ```sh
  brew install stripe/stripe-cli/stripe
  stripe login
  ```

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create your `.env`:

   ```sh
   cp .env.example .env
   ```

   Turn on **Test mode** in the Stripe Dashboard, open **Developers → API keys**, and copy the keys into `.env`:
   - `STRIPE_SECRET_KEY=sk_test_…`
   - `STRIPE_PUBLISHABLE_KEY=pk_test_…`

   `PORT` (default `3000`) and `DATABASE_PATH` (default `data/stripe-demo.db`) are optional.

3. In a second terminal, forward webhooks to the app:

   ```sh
   stripe listen --forward-to 127.0.0.1:3000/webhook
   ```

   It prints a signing secret (`whsec_…`). Paste it into `.env` as `STRIPE_WEBHOOK_SECRET`. Keep this terminal running while you use the app.

4. Start the app and open <http://127.0.0.1:3000>:

   ```sh
   npm start
   ```

**Why `127.0.0.1` and not `localhost`?** The server binds to IPv4 `127.0.0.1` only. On macOS, `localhost` can resolve to the IPv6 address `::1`, where nothing is listening, so requests to `localhost` may fail. Use `127.0.0.1` in the browser and in the `stripe listen` target. If you change `PORT`, change the port in the forward target too.

If `STRIPE_WEBHOOK_SECRET` is missing, the server still starts, but it prints a warning banner and rejects every webhook with `503` until you set it and restart.

## Test cards

| Card number | Result |
|---|---|
| `4242 4242 4242 4242` | Succeeds |
| `4000 0000 0000 9995` | Declined (insufficient funds) |
| `4000 0025 0000 3155` | Requires 3D Secure authentication |

Use any future expiry date, any CVC and any ZIP code.

## Two ways to pay

Each product has two buttons:

- **Buy with Checkout:** the server creates an order and a Checkout Session, then redirects you to Stripe's hosted payment page. After paying you return to the local success page. If you cancel, you land on the cancel page. The server then expires the session, and the resulting `checkout.session.expired` webhook marks the order `canceled`.
- **Buy with embedded form:** the Stripe Payment Element is rendered inside our own page (`pay.html`). The server creates a PaymentIntent and sends only its client secret to the browser. A decline shows Stripe's error message inline, and you can retry with another card without reloading. 3D Secure appears as a modal.

In both cases the price comes from the server's catalog; anything the browser sends is ignored. The success page never marks an order paid by itself: it polls the order for up to 30 seconds until a webhook changes its status.

## Webhooks

Webhooks are the only thing that changes an order's status. Every event is signature-checked, recorded in the event log, and applied at most once.

### Handled events

| Event type | Sets the order to | Condition |
|---|---|---|
| `checkout.session.completed` | `paid` | `payment_status` is `paid` |
| `payment_intent.succeeded` | `paid` | always |
| `payment_intent.payment_failed` | `failed` | always |
| `checkout.session.expired` | `canceled` | always |
| `charge.refunded` | `refunded` | full refund only (`refunded` is `true`) |

Any other event type is acknowledged and logged as `ignored_unhandled_type`. Stripe sends many of these during a normal payment (for example `payment_intent.created` and `charge.succeeded`), so expect to see them on the events page.

### Allowed status transitions

```
pending → paid | failed | canceled
failed  → paid        (a retry that succeeds)
paid    → refunded
```

Stripe doesn't guarantee event order, so any other change, such as `payment_intent.payment_failed` arriving after `paid`, is logged as `ignored_transition` and leaves the order alone.

### Event log outcomes

| Outcome | Meaning |
|---|---|
| `applied` | The order's status changed |
| `ignored_duplicate` | This event ID was already processed (even before a restart) |
| `ignored_transition` | The requested change isn't an allowed transition |
| `ignored_unknown_order` | No local order matches the event |
| `ignored_unhandled_type` | The event makes no status request |

**Checkout sends two events per payment.** A hosted Checkout payment produces both `payment_intent.succeeded` and `checkout.session.completed`, in either order. The first one marks the order `paid`. The second asks for `paid → paid`, so it shows as `ignored_transition` ("already paid"). This is expected: one payment often produces more than one event.

### Exercising webhooks without buying anything

```sh
stripe trigger payment_intent.succeeded
```

This creates a real test payment that has no matching local order, so the `payment_intent.succeeded` event shows on the events page as `ignored_unknown_order`.

```sh
stripe events resend <evt_id>
```

Copy an event ID (`evt_…`) from the events page. Resending an event that was already processed adds an `ignored_duplicate` entry and leaves the order unchanged.

### Why the webhook secret matters

Stripe signs every webhook with HMAC-SHA256, using the signing secret over the event's timestamp and exact raw body. The server recomputes the signature and rejects the event with `400` if it's missing, wrong, or more than 5 minutes old. Without this check, anyone who could reach `/webhook` could post a fake `payment_intent.succeeded` and mark an order paid.

HMAC uses a symmetric secret: the same `whsec_…` value both creates and checks signatures. Anyone who has it can forge events that the server will accept, so treat it like a password and keep it out of source control.

## Data

Orders, the event log and the IDs of processed events are stored in SQLite at `data/stripe-demo.db` (set `DATABASE_PATH` to change it). They survive restarts, and `data/` is git-ignored.

To reset, stop the server and delete the directory:

```sh
rm -rf data/
```

The schema is recreated on the next start. There is no migration tooling, so this is also the fix after a schema change.

## Tests

```sh
npm test
```

The tests use Node's built-in test runner. They run offline and need no Stripe keys or `.env`: Stripe API calls go through a fake gateway, and webhook tests sign payloads with a test secret using Stripe's real signing scheme.

## Project layout

```
src/        Express server: config, catalog, SQLite repositories, Stripe gateway,
            webhook verifier and processor, routes
public/     Static pages: shop, embedded payment, success, cancel, orders, events
test/       Unit and HTTP integration tests, plus helpers
specs/      requirements.md, design.md, tasks.md
```

For how it works in detail, see [`specs/requirements.md`](specs/requirements.md) (what it must do) and [`specs/design.md`](specs/design.md) (architecture, database schema, webhook processing and API).

## Security notes

- Secrets live in `.env`, which is git-ignored. Only `.env.example`, which has placeholder values, is committed. The server never logs secrets or client secrets.
- Card data never touches this server. Card details are typed only into Stripe's hosted Checkout page or into the Payment Element, which runs in a Stripe iframe.
- The server listens on `127.0.0.1` only, so it isn't reachable from other machines.
