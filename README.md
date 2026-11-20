# YXY Inventory Dashboard

A live stock dashboard for the YXY Shopify store (yxy.com.sg).

- Shows every product variant's **available**, **on hand** and **committed** stock at your Shopify location.
- **Editing a number and pressing Save (or Enter) updates Shopify immediately**, so the website shows the new stock right away.
- **Live updates.** When a customer buys something on the website, or someone changes stock in Shopify admin, the row updates on every open dashboard and appears in the *Live activity* feed.
- **Safe edits.** Each save tells Shopify what stock the dashboard expected. If an order came in while you were typing, Shopify rejects the save and the dashboard shows the new figure, so you don't overwrite a sale by accident.
- Search, filters (low stock / out of stock / not tracked), product status filter, sorting, and a layout that works on a phone.

No dependencies: it needs only Node.js 22.9 or later.

## Try it without Shopify

```bash
npm run demo
```

Open http://localhost:3000. Demo mode uses made-up products and simulates a website order every few seconds.

## Test it safely before it controls the website

Work through these stages in order. Only the last one can change the website.

| Stage | Command | Uses real store data? | Can change the website? |
|---|---|---|---|
| 1. Demo | `npm run demo` | No, made-up products | No |
| 2. Test mode | `npm run test-run` | Yes, live stock from Shopify | **No.** Saving only shows what *would* change |
| 3. Live | `npm start` | Yes | Yes |

**Test mode** (stage 2) is the real dashboard connected to your real store, with every write switched off:
- A banner on the page says you're in test mode.
- Pressing Save shows "would change 42 → 500" and adds a "Test · not sent" entry to the activity feed. Nothing is sent to Shopify.
- The server refuses to register webhooks or change stock even if asked. It just re-reads stock every 30 seconds.
- For extra safety during testing, give the Shopify app only the **read** permissions (`read_products`, `read_inventory`, `read_locations`). Then even a bug couldn't write. Add `write_inventory` when you're ready for stage 3.

While in test mode, compare a few products against Shopify admin. Then buy something or change a number in Shopify admin, and check that the dashboard updates within about 30 seconds.

**Before going fully live**, you can try one real edit on a product that doesn't matter: for example a draft product, or a test product you create and hide. Run `npm start`, change its stock on the dashboard, and confirm it changes in Shopify admin.

You can also set `TEST_MODE=true` as an environment variable instead of using `npm run test-run`, which is handy on a hosting service.

## Connect it to the store

### 1. Create a Shopify app with inventory access

Shopify no longer lets you create new custom apps inside the Shopify admin. Use the Dev Dashboard:

1. Go to **dev.shopify.com** → **Apps** → **Create app**. Use the same organization that owns the store.
2. Create a version with these Admin API scopes:
   `read_products`, `read_inventory`, `write_inventory`, `read_locations`
3. Install the app on **yxy-zugo.myshopify.com**.
4. Copy the app's **Client ID** and **Client secret**.

(If you already have an older admin-created custom app with those scopes, you can use its `shpat_…` Admin API access token instead. See `.env.example`.)

### 2. Configure

```bash
cp .env.example .env
```

Fill in at least:

| Variable | What to put |
|---|---|
| `SHOPIFY_SHOP` | `yxy-zugo.myshopify.com` |
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | From step 1 |
| `DASHBOARD_PASSWORD` | A password staff will enter to open the dashboard |
| `PUBLIC_URL` | The dashboard's public https address, once it's hosted (enables instant updates) |

### 3. Run

```bash
npm start
```

## How "real time" works

| Setup | How website changes reach the dashboard |
|---|---|
| `PUBLIC_URL` set (hosted on the internet) | On startup the server registers Shopify **webhooks** (`inventory_levels/update`, `products/update`, …). Shopify pushes each change to the dashboard within seconds. A full re-sync also runs every 10 minutes as a safety net. |
| No `PUBLIC_URL` (e.g. running on an office PC) | The server re-syncs every product with Shopify every 30 seconds (`REFRESH_INTERVAL_SECONDS`). |

Either way, open browsers get changes pushed to them through a live connection (Server-Sent Events), and edits made on the dashboard go to Shopify immediately.

## Hosting

Any host that runs a Node.js server works, for example Render, Railway, Fly.io or a small VPS. Set the variables from `.env.example` in the host's settings, use `npm start` as the start command, and set `PUBLIC_URL` to the address the host gives you. Keep `DASHBOARD_PASSWORD` set: anyone who can open the dashboard can change website stock.

The server keeps its state in memory, so run **one** instance.

## Notes

- The number you edit is Shopify's **available** quantity (what the website sells against). On hand changes by the same amount, and committed (ordered but not yet shipped) is left alone.
- Variants with *Track quantity* turned off in Shopify show "Not tracked" and can't be edited, because the website doesn't enforce stock for them. Turn tracking on in Shopify to manage them here.
- Each edit is recorded in Shopify's inventory history with the reason "correction".

## Files

```
server.js          HTTP server, Shopify sync, webhooks, live push
lib/shopify.js     Shopify Admin GraphQL client (API 2026-10)
lib/mock.js        Fake store for demo mode
public/            Dashboard page (HTML/CSS/JS)
```
