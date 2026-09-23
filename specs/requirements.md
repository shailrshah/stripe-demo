# Requirements: Stripe Demo Shop

## Purpose

A small demo store for learning how Stripe payments work from start to finish. It runs only on the developer's machine and uses Stripe **test mode** only. It never accepts real card details and never moves real money.

## Scope

**In scope**
- A tiny product catalog with a checkout flow built on Stripe
- Two ways to pay: Stripe-hosted Checkout, and an embedded Payment Element
- Payment confirmation through webhooks
- Order status tracking that visitors can see
- Automated tests

**Out of scope**
- Deploying anywhere or making the app reachable from the internet
- Live-mode keys, real cards and real payouts
- User accounts, authentication, shopping carts with several items, inventory, tax and shipping
- Keeping data across server restarts
- Subscriptions, Connect and other Stripe products

## Constraints

- **C1 Local only.** The frontend and backend run on `localhost`. The only outbound network traffic is to Stripe (the API, Stripe.js and hosted Checkout) and the Stripe CLI's webhook forwarding.
- **C2 Test mode only.** The system accepts only Stripe test keys (`sk_test_…`, `pk_test_…`).
- **C3 No card data on our server.** Card details are entered only into Stripe-hosted or Stripe-rendered fields. Our server never receives, logs or stores card numbers.
- **C4 Secrets out of source control.** API keys and the webhook signing secret come from environment variables or a git-ignored `.env` file.
- **C5 Stack.** Node.js (v24+) with Express on the backend, and plain HTML, CSS and JS on the frontend (no build step). The frontend is served by the backend.

## Glossary

- **Product:** an item for sale, with a name, description and price in USD cents.
- **Order:** our local record of one attempt to buy one product. It links to a Stripe Checkout Session or PaymentIntent.
- **Order status:** one of `pending`, `paid`, `failed`, `canceled` or `refunded`.

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
- R4.3 Webhook handling is idempotent. Receiving the same event again does not change the result or cause an error.
- R4.4 Events for unknown orders, or of types we don't handle, are acknowledged with a 2xx response and logged, and change nothing.
- R4.5 The success page never marks an order `paid` by itself. It shows whatever the latest webhook set, and it may poll until the status stops being `pending`.

### R5 Order visibility (Must)
**User story:** As a learner, I want to see orders and their status so that I can check what Stripe told the server.

- R5.1 An orders page lists every order in the current server session: ID, product, amount, payment method (Checkout or embedded), status, the Stripe object ID and when it was created.
- R5.2 Each order links to the matching object in the Stripe test Dashboard.

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
- R8.1 A README explains setup: getting test keys, creating `.env` from `.env.example`, installing the Stripe CLI, running `stripe listen --forward-to localhost:<port>/webhook` and starting the app.
- R8.2 The README lists the test cards to try, at least:
  - `4242 4242 4242 4242`: succeeds
  - `4000 0000 0000 9995`: declined for insufficient funds
  - `4000 0025 0000 3155`: requires 3D Secure
- R8.3 `npm start` runs the app and `npm test` runs the test suite.

## Non-functional requirements

- **N1 Testability.** Stripe is reached through a single module that can be swapped out, so tests run without network access or real keys.
- **N2 Tests.** The automated tests cover at least:
  - Refusing to start with missing or live keys (R7)
  - Server-side price lookup and rejecting unknown products (R1.3, R2.5)
  - Creating Checkout Sessions and PaymentIntents with the right amount and metadata (R2.1, R2.2, R3.1)
  - Webhook signature checks, with valid, invalid and missing signatures (R4.1)
  - Every status change in R4.2, plus idempotency (R4.3) and unknown events and orders (R4.4)
- **N3 Simplicity.** Keep dependencies to a minimum: `express`, `stripe` and `dotenv` at runtime, plus a test runner. Orders live in memory.
- **N4 Logging.** The server logs each webhook event's type and ID and each order status change. It never logs secrets or client secrets.

## Acceptance criteria (end to end, done by hand)

1. With test keys set and `stripe listen` running, buying a product through Checkout with `4242 4242 4242 4242` ends at the success page, and the order shows `paid`.
2. Buying through the embedded form with `4000 0000 0000 9995` shows a decline message inline. Retrying with `4242…` succeeds, and the order shows `paid`.
3. `4000 0025 0000 3155` shows a 3D Secure challenge. Completing it marks the order `paid`.
4. Cancelling on the Checkout page lands on the cancel page, and the order does not show `paid`.
5. (If R6 is built) Refunding a paid order changes its status to `refunded` after the webhook arrives.
6. Starting the server with an `sk_live_…` key fails with a clear error.
7. `npm test` passes offline, with no Stripe keys set.
