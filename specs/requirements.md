# Requirements: Stripe Demo Shop

## Purpose

A small demo store for learning how Stripe payments work from start to finish. It runs only on the developer's machine and uses Stripe **test mode** only. It never accepts real card details and never moves real money.

## Scope

**In scope**
- A tiny product catalog with a checkout flow built on Stripe
- Two ways to pay: Stripe-hosted Checkout, and an embedded Payment Element
- Payment confirmation through Stripe webhooks, forwarded to the local server by the Stripe CLI. Every event is verified, stored and applied once.
- Keeping orders and webhook events in a local SQLite database
- Order status and a webhook event log that visitors can see
- Automated unit and integration tests
- Opt-in end-to-end tests against real Stripe test mode, driven through Stripe's API (N2b)

**Out of scope**
- Browser automation of the site or of Stripe-hosted pages (hosted Checkout, 3D Secure challenges). These stay manual acceptance checks.
- Deploying anywhere or making the app reachable from the internet
- Live-mode keys, real cards and real payouts
- User accounts, authentication, shopping carts with several items, inventory, tax and shipping
- Database servers, migration tooling and ORMs
- Subscriptions, Connect and other Stripe products

## Constraints

- **C1 Local only.** The frontend and backend run on the loopback address `127.0.0.1`. The only outbound network traffic is to Stripe (the API, Stripe.js and hosted Checkout) and the Stripe CLI's webhook forwarding.
- **C2 Test mode only.** The system accepts only Stripe test keys (`sk_test_…`, `pk_test_…`).
- **C3 No card data on our server.** Card details are entered only into Stripe-hosted or Stripe-rendered fields. Our server never receives, logs or stores card numbers.
- **C4 Secrets out of source control.** API keys and the webhook signing secret come from environment variables or a git-ignored `.env` file.
- **C5 Stack.** Node.js (v24+) with Express on the backend, and plain HTML, CSS and JS on the frontend. The backend, tests and e2e suite are written in TypeScript and run directly by Node's built-in type stripping. There is no build or transpile step anywhere, so the frontend stays JavaScript. The frontend is served by the backend. Data is stored in SQLite through Node's built-in `node:sqlite` module.

## Glossary

- **Product:** an item for sale, with a name, description and price in USD cents.
- **Order:** our local record of one attempt to buy one product. It links to a Stripe Checkout Session or PaymentIntent.
- **Order status:** one of `pending`, `paid`, `failed`, `canceled` or `refunded`.
- **Webhook event:** an Event object that Stripe sends to our webhook endpoint, identified by its Stripe event ID (`evt_…`).

## Functional requirements

Priority is **Must**, **Should** or **Could**.

### R1 Product catalog (Must)
**User story:** As a visitor, I want to see the products for sale so that I can pick one to buy.

- R1.1 The home page lists every product with its name, description and price, formatted as dollars (for example `$12.00`).
- R1.2 Each product offers a "Buy with Checkout" action and a "Buy with embedded form" action.
- R1.3 The product list is defined on the server. The client cannot change prices: the server looks up the amount by product ID and ignores any price sent from the browser.

### R2 Hosted Checkout (Must)
**User story:** As a visitor, I want to pay on Stripe's hosted page so that I can finish a purchase with a test card.

- R2.1 When the visitor chooses "Buy with Checkout", the server creates a local order with status `pending` and a Stripe Checkout Session for that product's price and quantity 1. The browser is then redirected to the session URL.
- R2.2 The Checkout Session carries our order ID in its metadata so that later webhook events can be matched to the order.
- R2.3 After a successful payment, Stripe sends the visitor back to a local success page that shows the order ID and its current status.
- R2.4 If the visitor cancels on the Checkout page, they return to a local cancel page. The order becomes `canceled`, or stays `pending` until the session expires.
- R2.5 A request with an unknown product ID gets a 4xx error, and no order or session is created.

### R3 Embedded Payment Element (Should)
**User story:** As a visitor, I want to pay without leaving the site so that I can see how an embedded payment form works.

- R3.1 When the visitor chooses "Buy with embedded form", the server creates a local order with status `pending` and a Stripe PaymentIntent for the product's amount. The PaymentIntent carries our order ID in its metadata. Only its `client_secret` is returned to the browser.
- R3.2 The payment page mounts the Stripe Payment Element with the publishable key and that client secret.
- R3.3 When the visitor submits, the page confirms the payment with Stripe.js and then shows success, a decline message or a 3D Secure challenge as needed.
- R3.4 A decline shows Stripe's error message on the page, and the visitor can try again with a different card without reloading.

### R4 Webhooks as the source of truth (Must)
**User story:** As the shop owner, I want payment status confirmed by Stripe's server-to-server events so that orders aren't marked paid on the strength of a browser redirect.

- R4.1 The server has a webhook endpoint that checks every event's signature using the webhook signing secret. Events with a missing or invalid signature get a 400 response and change nothing.
- R4.2 Order status changes only in response to verified webhook events:
  - `checkout.session.completed` with `payment_status=paid`, or `payment_intent.succeeded`: `paid`
  - `payment_intent.payment_failed`: `failed`
  - `checkout.session.expired`: `canceled`
  - `charge.refunded`: `refunded`
- R4.3 Webhook handling is idempotent. The IDs of processed events are saved in the database. An event that is received again, even after a server restart, gets a 2xx response and changes nothing.
- R4.4 Events for unknown orders, or of types we don't handle, are acknowledged with a 2xx response and logged, and change nothing.
- R4.5 The success page never marks an order `paid` by itself. It shows whatever the latest webhook set, and it may poll until the status stops being `pending`.
- R4.6 Stripe doesn't guarantee that events arrive in order, so order status moves only along these transitions:
  - `pending` → `paid`, `failed` or `canceled`
  - `failed` → `paid` (a retry that succeeds)
  - `paid` → `refunded`

  Any other transition, such as `payment_intent.payment_failed` arriving after `paid`, is ignored and logged. It still counts as processed.
- R4.7 Every verified event is written to an event log. Each entry records the event ID, type, Stripe `created` time, when we received it, the related order (if any) and the outcome: `applied`, `ignored_duplicate`, `ignored_transition`, `ignored_unknown_order` or `ignored_unhandled_type`.
- R4.8 Recording an event and changing the order status happen in one database transaction, so a crash can't leave an event marked processed without its status change, or the reverse.
- R4.9 If processing fails unexpectedly, the endpoint returns a 5xx response and does not mark the event processed, so Stripe will retry it.

### R5 Order visibility (Must)
**User story:** As a learner, I want to see orders and their status so that I can check what Stripe told the server.

- R5.1 An orders page lists every stored order, newest first: ID, product, amount, payment method (Checkout or embedded), status, the Stripe object ID and when it was created.
- R5.2 Each order links to the matching object in the Stripe test Dashboard.
- R5.3 An events page lists the webhook event log (R4.7), newest first. Each entry links to the event in the Stripe test Dashboard.
- R5.4 The order detail view shows the events that affected that order, in the order they were received.

### R6 Refunds (Could)
**User story:** As a learner, I want to refund a paid order so that I can see how refunds and their webhooks work.

- R6.1 The orders page shows a "Refund" action for `paid` orders. It asks Stripe for a full refund.
- R6.2 The order becomes `refunded` only after the matching `charge.refunded` webhook arrives (see R4.2).

### R7 Startup safety (Must)
- R7.1 The server refuses to start, and prints a clear error, if the secret key is missing or does not start with `sk_test_`.
- R7.2 The server refuses to start if the publishable key is missing or does not start with `pk_test_`.
- R7.3 If the webhook signing secret is missing, the server starts but logs a prominent warning, and the webhook endpoint rejects every event.
- R7.4 The server listens on `127.0.0.1` only, on a port that is configurable and defaults to `3000`.

### R8 Developer experience (Must)
- R8.1 A README explains setup: getting test keys, creating `.env` from `.env.example`, installing the Stripe CLI, running `stripe listen --all-snapshot --forward-to 127.0.0.1:<port>/webhook` and starting the app.
- R8.2 The README lists the test cards to try, at least:
  - `4242 4242 4242 4242`: succeeds
  - `4000 0000 0000 9995`: declined for insufficient funds
  - `4000 0025 0000 3155`: requires 3D Secure
- R8.3 `npm start` runs the app and `npm test` runs the test suite.
- R8.4 The README explains how to exercise webhooks without clicking through a purchase: `stripe trigger <event>` and `stripe events resend <evt_id>` (to see duplicate handling). It also explains how to reset the database by deleting its file.

### R9 Persistence (Must)
**User story:** As a learner, I want orders and events to survive restarts so that the app behaves like a real integration.

- R9.1 Orders and webhook events are stored in a SQLite file. Its path is configurable and defaults to `data/stripe-demo.db`, and it is git-ignored.
- R9.2 On startup the server creates the database file and schema if they don't exist. Starting against an existing database keeps its data.
- R9.3 A server restart loses no orders, event log entries or processed-event records.
- R9.4 Amounts are stored as whole numbers of cents, and timestamps as UTC ISO-8601 strings.

## Non-functional requirements

- **N1 Testability.** Stripe API calls go through a single module that can be swapped out, so tests run without network access or real keys. The database path can be injected, so tests use an in-memory database or a temporary file.
- **N2 Tests.** The automated tests cover at least:
  - Refusing to start with missing or live keys (R7)
  - Server-side price lookup and rejecting unknown products (R1.3, R2.5)
  - Creating Checkout Sessions and PaymentIntents with the right amount and metadata (R2.1, R2.2, R3.1)
- **N2a Webhook integration tests.** These send HTTP requests to the running Express app with payloads signed by the `stripe` library's real signing scheme and a test secret. Signature checks are not mocked. They cover:
  - Valid, invalid, missing and expired signatures (R4.1)
  - Every status change in R4.2, checked against the database
  - Duplicate delivery, both within one run and after reopening the same database file (R4.3, R9.3)
  - Out-of-order delivery (R4.6)
  - Unknown orders and unhandled event types (R4.4)
  - Event log entries and their outcomes (R4.7)
  - Returning 5xx and not recording the event when processing fails (R4.9)
- **N2b End-to-end tests (opt-in).** `npm run test:e2e` runs the real app against real Stripe test mode, with events delivered by a real `stripe listen`. Payments are driven through Stripe's API with test payment methods; there's no browser.
  - It's separate from `npm test`, which stays offline.
  - It reads only the two API keys from `.env`, and refuses to run with anything but test keys (C2).
  - It gets the webhook secret from `stripe listen --print-secret` rather than from `.env`.
  - It uses its own port and a temporary database, so it never touches the developer's `data/`.
  - A missing prerequisite (keys, the Stripe CLI or a CLI login) fails fast with a message saying what to fix. So does a webhook that doesn't arrive in time.
  - It covers:
    - an embedded payment succeeding (R3.1, R4.2)
    - a decline followed by a successful retry, `failed` → `paid` (R4.6)
    - a refund (R6)
    - creating a Checkout Session and cancelling it, ending `canceled` (R2.1, R2.4)
    - a real resend of a processed event, logged as `ignored_duplicate` (R4.3)
    - `stripe trigger`, logged as `ignored_unknown_order` (R4.4)
- **N3 Simplicity.** Keep dependencies to a minimum: `express`, `stripe` and `dotenv` at runtime. The only dev dependencies are `typescript`, `@types/node` (pinned to the Node major version in use) and `@types/express`, all for type checking. Use the built-in `node:sqlite` module, not a third-party database driver.
- **N5 Type safety.** `npm test` type-checks the whole backend, test and e2e code in strict mode before running the tests, and a type error fails it. Stripe objects use the `stripe` package's own types (`Stripe.Event`, `Stripe.Checkout.Session`, …) rather than hand-written copies.
- **N4 Logging.** The server logs each webhook event's type and ID and each order status change. It never logs secrets or client secrets.

## Acceptance criteria (end to end, done by hand)

N2b automates checks 2 (through the API instead of the form), 5, 9 and 10, plus the cancel half of check 4. Checks 1 and 3, and the page-level parts of the others, need a browser and stay manual.


1. With test keys set and `stripe listen` running, buying a product through Checkout with `4242 4242 4242 4242` ends at the success page, and the order shows `paid`.
2. Buying through the embedded form with `4000 0000 0000 9995` shows a decline message inline. Retrying with `4242…` succeeds, and the order shows `paid`.
3. `4000 0025 0000 3155` shows a 3D Secure challenge. Completing it marks the order `paid`.
4. Cancelling on the Checkout page lands on the cancel page, and the order does not show `paid`.
5. (If R6 is built) Refunding a paid order changes its status to `refunded` after the webhook arrives.
6. Starting the server with an `sk_live_…` key fails with a clear error.
7. `npm test` passes offline, with no Stripe keys set.
8. After a paid purchase, restarting the server still shows the order as `paid` and its events on the events page.
9. Running `stripe events resend <evt_id>` on an already-processed event adds an `ignored_duplicate` entry to the event log and leaves the order unchanged.
10. `stripe trigger payment_intent.succeeded` shows up on the events page as `ignored_unknown_order`.
