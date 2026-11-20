// YXY Inventory Dashboard server.
// - Serves the dashboard page (public/)
// - Keeps an in-memory copy of every variant's stock, refreshed from Shopify
// - Pushes changes to open dashboards instantly via Server-Sent Events
// - Writes stock edits back to Shopify, which updates the website immediately
// - Receives Shopify webhooks so website sales show up on the dashboard live

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShopifyClient } from './lib/shopify.js';
import { MockShopify } from './lib/mock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const DEMO = env.DEMO_MODE === 'true' || process.argv.includes('--demo');
// Test mode: reads real stock from Shopify but never writes anything back
// (no stock changes, no webhook registration).
const TEST_MODE = env.TEST_MODE === 'true' || process.argv.includes('--test');
const PORT = Number(env.PORT || 3000);
const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/$/, '');
const PASSWORD = env.DASHBOARD_PASSWORD || '';
const LOW_STOCK = Number(env.LOW_STOCK_THRESHOLD || 10);
const WEBHOOK_SECRET = env.SHOPIFY_WEBHOOK_SECRET || env.SHOPIFY_CLIENT_SECRET || '';
// With webhooks, a periodic full refresh is only a safety net; without them it is the live feed.
const REFRESH_SECONDS = Number(env.REFRESH_INTERVAL_SECONDS || (PUBLIC_URL ? 600 : 30));
const WEBHOOK_PATH = '/webhooks/shopify';
const WEBHOOK_TOPICS = [
  'INVENTORY_LEVELS_UPDATE',
  'INVENTORY_LEVELS_CONNECT',
  'INVENTORY_LEVELS_DISCONNECT',
  'INVENTORY_ITEMS_UPDATE',
  'PRODUCTS_CREATE',
  'PRODUCTS_UPDATE',
  'PRODUCTS_DELETE',
];

const shopify = DEMO
  ? new MockShopify()
  : new ShopifyClient({
      shop: env.SHOPIFY_SHOP,
      apiVersion: env.SHOPIFY_API_VERSION || '2026-10',
      accessToken: env.SHOPIFY_ADMIN_TOKEN,
      clientId: env.SHOPIFY_CLIENT_ID,
      clientSecret: env.SHOPIFY_CLIENT_SECRET,
      readOnly: TEST_MODE,
    });

if (!DEMO && !PASSWORD) {
  console.warn('WARNING: DASHBOARD_PASSWORD is not set — anyone who can reach this server can change stock.');
}

// ---------- state ----------
const state = { location: null, items: new Map(), updatedAt: null, error: null, liveMode: 'polling' };
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

function sameStock(a, b) {
  return a && b && a.available === b.available && a.onHand === b.onHand && a.committed === b.committed &&
    a.tracked === b.tracked && a.stocked === b.stocked && a.productTitle === b.productTitle &&
    a.variantTitle === b.variantTitle && a.sku === b.sku && a.productStatus === b.productStatus && a.image === b.image;
}

function upsert(item, source) {
  const prev = state.items.get(item.inventoryItemId);
  state.items.set(item.inventoryItemId, item);
  state.updatedAt = new Date().toISOString();
  if (!sameStock(prev, item)) broadcast('item', { item, source, previous: prev?.available ?? null });
}

let refreshing = null;
async function fullRefresh(reason) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const list = await shopify.fetchAllVariants(state.location.id);
      const seen = new Set();
      const first = state.items.size === 0;
      for (const item of list) {
        seen.add(item.inventoryItemId);
        if (first) state.items.set(item.inventoryItemId, item);
        else upsert(item, 'sync');
      }
      for (const id of [...state.items.keys()]) {
        if (!seen.has(id)) {
          state.items.delete(id);
          broadcast('remove', { inventoryItemId: id });
        }
      }
      state.updatedAt = new Date().toISOString();
      if (state.error) broadcast('status', { error: null });
      state.error = null;
      if (first) broadcast('reload', {});
      console.log(`[sync] ${list.length} variants loaded (${reason})`);
    } catch (err) {
      state.error = err.message;
      broadcast('status', { error: err.message });
      console.error('[sync] failed:', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

let refreshTimer = null;
function scheduleRefresh(reason, delayMs = 3000) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => fullRefresh(reason), delayMs);
}

async function refreshOne(inventoryItemId, source) {
  const item = await shopify.fetchVariantByInventoryItem(inventoryItemId, state.location.id);
  if (item) upsert(item, source);
  return item;
}

// ---------- http helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorised(req) {
  if (!PASSWORD) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const pass = Buffer.from(header.slice(6), 'base64').toString().split(':').slice(1).join(':');
  const a = Buffer.from(pass);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyWebhook(raw, hmacHeader) {
  if (!WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest();
  const given = Buffer.from(hmacHeader, 'base64');
  return given.length === digest.length && timingSafeEqual(given, digest);
}

const gid = (type, id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/${type}/${id}`);

// ---------- routes ----------
async function handleWebhook(req, res) {
  const raw = await readBody(req);
  if (!verifyWebhook(raw, req.headers['x-shopify-hmac-sha256'])) return send(res, 401, 'Invalid signature');
  send(res, 200, 'ok'); // acknowledge fast; Shopify retries slow responses
  const topic = String(req.headers['x-shopify-topic'] || '');
  let payload = {};
  try { payload = JSON.parse(raw.toString()); } catch { return; }
  try {
    if (topic.startsWith('inventory_levels/')) {
      if (gid('Location', payload.location_id) !== state.location.id) return;
      await refreshOne(gid('InventoryItem', payload.inventory_item_id), 'website');
    } else if (topic === 'inventory_items/update') {
      await refreshOne(gid('InventoryItem', payload.admin_graphql_api_id || payload.id), 'website');
    } else if (topic.startsWith('products/')) {
      scheduleRefresh(`webhook ${topic}`);
    }
  } catch (err) {
    console.error(`[webhook ${topic}]`, err.message);
  }
}

async function handleSetStock(req, res) {
  let body;
  try { body = JSON.parse((await readBody(req)).toString()); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
  const { inventoryItemId, quantity, expected } = body;
  const item = state.items.get(inventoryItemId);
  if (!item) return send(res, 404, { error: 'Unknown product variant' });
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1_000_000) {
    return send(res, 400, { error: 'Quantity must be a whole number between 0 and 1,000,000' });
  }
  if (!item.tracked) return send(res, 422, { error: 'Inventory tracking is off for this variant in Shopify' });
  if (!item.stocked) return send(res, 422, { error: 'This variant is not stocked at this location' });

  if (TEST_MODE) {
    console.log(`[test] would set ${item.productTitle} ${item.variantTitle} ${item.available} -> ${quantity} (not sent)`);
    return send(res, 200, { testMode: true, item, wouldSet: quantity });
  }

  try {
    const errors = await shopify.setAvailable({
      inventoryItemId, locationId: state.location.id, quantity,
      expected: Number.isInteger(expected) ? expected : item.available,
    });
    if (errors.length) {
      // Most likely stock moved on the website since the dashboard loaded it.
      const latest = await refreshOne(inventoryItemId, 'website');
      const stale = errors.some((e) => /STALE|COMPARE|CHANGE_FROM/i.test(e.code || '') || /changed|compare/i.test(e.message));
      return send(res, stale ? 409 : 422, {
        error: stale
          ? `Stock changed on the website (now ${latest?.available}). Check the new number and save again.`
          : errors.map((e) => e.message).join('; '),
        item: latest,
      });
    }
    const updated = (await refreshOne(inventoryItemId, 'dashboard')) || { ...item, available: quantity };
    console.log(`[edit] ${item.productTitle} ${item.variantTitle} ${item.available} -> ${quantity}`);
    return send(res, 200, { item: updated });
  } catch (err) {
    console.error('[edit] failed:', err.message);
    return send(res, 502, { error: `Shopify did not accept the change: ${err.message}` });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === WEBHOOK_PATH) return await handleWebhook(req, res);
    if (url.pathname === '/healthz') return send(res, state.error ? 503 : 200, { ok: !state.error, updatedAt: state.updatedAt });

    if (!authorised(req)) {
      return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="YXY Inventory", charset="UTF-8"' });
    }

    if (req.method === 'GET' && url.pathname === '/api/inventory') {
      if (!state.updatedAt) await fullRefresh('first request');
      return send(res, 200, {
        shop: shopify.shop, location: state.location, demo: DEMO, testMode: TEST_MODE, liveMode: state.liveMode,
        lowStockThreshold: LOW_STOCK, updatedAt: state.updatedAt, error: state.error,
        items: [...state.items.values()],
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/inventory') return await handleSetStock(req, res);
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      await fullRefresh('manual');
      return send(res, 200, { updatedAt: state.updatedAt, error: state.error });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: hello\ndata: ${JSON.stringify({ liveMode: state.liveMode })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.join(__dirname, 'public', rel);
      if (!file.startsWith(path.join(__dirname, 'public') + path.sep)) return send(res, 404, 'Not found');
      try {
        const data = await readFile(file);
        return send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      } catch {
        return send(res, 404, 'Not found');
      }
    }
    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
  }
});

// ---------- startup ----------
async function start() {
  state.location = await shopify.getPrimaryLocation(env.SHOPIFY_LOCATION_ID);
  console.log(`Store: ${shopify.shop} · Location: ${state.location.name}${DEMO ? ' · DEMO MODE' : ''}${TEST_MODE ? ' · TEST MODE (read-only, nothing is sent to Shopify)' : ''}`);

  if (DEMO) {
    state.liveMode = 'demo';
    shopify.startSimulatedOrders((id) => refreshOne(id, 'website'));
  } else if (PUBLIC_URL && !TEST_MODE) {
    if (!WEBHOOK_SECRET) {
      console.warn('PUBLIC_URL is set but no SHOPIFY_CLIENT_SECRET/SHOPIFY_WEBHOOK_SECRET — webhooks disabled, polling instead.');
    } else {
      try {
        const created = await shopify.ensureWebhooks(PUBLIC_URL + WEBHOOK_PATH, WEBHOOK_TOPICS);
        state.liveMode = 'webhooks';
        console.log(`Webhooks active at ${PUBLIC_URL + WEBHOOK_PATH}${created.length ? ` (registered ${created.join(', ')})` : ''}`);
      } catch (err) {
        console.warn('Could not register webhooks, falling back to polling:', err.message);
      }
    }
  }
  const every = state.liveMode === 'webhooks' ? REFRESH_SECONDS : Math.min(REFRESH_SECONDS, 60);
  setInterval(() => fullRefresh('scheduled'), every * 1000).unref();

  server.listen(PORT, () => console.log(`Inventory dashboard on http://localhost:${PORT} (live mode: ${state.liveMode})`));
  await fullRefresh('startup');
}

start().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
