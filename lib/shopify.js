// Minimal Shopify Admin GraphQL client for the inventory dashboard.
// Supports either a fixed Admin API access token (legacy admin-created custom
// apps) or the client-credentials grant (Dev Dashboard apps), which yields a
// token that expires every 24h and is refreshed automatically here.

import { randomUUID } from 'node:crypto';

export class ShopifyClient {
  constructor({ shop, apiVersion, accessToken, clientId, clientSecret, readOnly = false }) {
    if (!shop) throw new Error('SHOPIFY_SHOP is required (e.g. your-store.myshopify.com)');
    if (!accessToken && !(clientId && clientSecret)) {
      throw new Error('Set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
    }
    this.shop = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.apiVersion = apiVersion;
    this.staticToken = accessToken || null;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.readOnly = readOnly;
  }

  assertWritable() {
    if (this.readOnly) throw new Error('Read-only test mode: refusing to write to Shopify');
  }

  async getToken() {
    if (this.staticToken) return this.staticToken;
    // Refresh 5 minutes before expiry.
    if (this.token && Date.now() < this.tokenExpiresAt - 5 * 60_000) return this.token;
    const res = await fetch(`https://${this.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + (json.expires_in ?? 86399) * 1000;
    return this.token;
  }

  async graphql(query, variables = {}, attempt = 0) {
    const res = await fetch(`https://${this.shop}/admin/api/${this.apiVersion}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await this.getToken(),
      },
      body: JSON.stringify({ query, variables }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return this.graphql(query, variables, attempt + 1);
    }
    if (res.status === 401 && !this.staticToken && attempt < 1) {
      this.token = null; // token may have been revoked/expired early
      return this.graphql(query, variables, attempt + 1);
    }
    if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors?.length) {
      const throttled = json.errors.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < 4) {
        await sleep(1000 * 2 ** attempt);
        return this.graphql(query, variables, attempt + 1);
      }
      throw new Error(`Shopify GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data;
  }

  async getPrimaryLocation(preferredId) {
    const data = await this.graphql(`{ locations(first: 50) { nodes { id name isActive } } }`);
    const active = data.locations.nodes.filter((l) => l.isActive);
    if (preferredId) {
      const found = active.find((l) => l.id === preferredId || l.id.endsWith(`/${preferredId}`));
      if (!found) throw new Error(`Location ${preferredId} not found or inactive`);
      return found;
    }
    if (!active.length) throw new Error('No active Shopify locations found');
    return active[0];
  }

  /** Fetches every product variant with its stock at the given location. */
  async fetchAllVariants(locationId) {
    const query = `
      query Variants($after: String, $loc: ID!) {
        productVariants(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id title sku
            product {
              id title status handle
              featuredMedia { preview { image { url(transform: { maxWidth: 96, maxHeight: 96 }) } } }
            }
            inventoryItem {
              id tracked
              inventoryLevel(locationId: $loc) {
                quantities(names: ["available", "on_hand", "committed"]) { name quantity }
              }
            }
          }
        }
      }`;
    const out = [];
    let after = null;
    do {
      const data = await this.graphql(query, { after, loc: locationId });
      const page = data.productVariants;
      for (const v of page.nodes) out.push(normaliseVariant(v));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  /**
   * Sets the "available" quantity. `expected` is the quantity the dashboard
   * last saw; Shopify rejects the change if stock moved in the meantime
   * (e.g. a customer just placed an order), so nothing gets overwritten blindly.
   */
  async setAvailable({ inventoryItemId, locationId, quantity, expected }) {
    this.assertWritable();
    const mutation = `
      mutation SetStock($input: InventorySetQuantitiesInput!, $key: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $key) {
          inventoryAdjustmentGroup { changes { name delta quantityAfterChange } }
          userErrors { code field message }
        }
      }`;
    const data = await this.graphql(mutation, {
      key: randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: `yxy-inventory-dashboard://manual/${new Date().toISOString()}`,
        quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: expected ?? null }],
      },
    });
    return data.inventorySetQuantities.userErrors;
  }

  async fetchVariantByInventoryItem(inventoryItemId, locationId) {
    const data = await this.graphql(
      `query One($id: ID!, $loc: ID!) {
        inventoryItem(id: $id) {
          id tracked
          variants(first: 1) { nodes { id title sku product { id title status handle
            featuredMedia { preview { image { url(transform: { maxWidth: 96, maxHeight: 96 }) } } } } } }
          inventoryLevel(locationId: $loc) {
            quantities(names: ["available", "on_hand", "committed"]) { name quantity }
          }
        }
      }`,
      { id: inventoryItemId, loc: locationId },
    );
    const item = data.inventoryItem;
    const variant = item?.variants?.nodes?.[0];
    if (!variant) return null;
    const { variants, ...inventoryItem } = item;
    return normaliseVariant({ ...variant, inventoryItem });
  }

  /** Subscribes Shopify webhooks to this server so stock changes arrive instantly. */
  async ensureWebhooks(callbackUrl, topics) {
    this.assertWritable();
    const existing = await this.graphql(`{ webhookSubscriptions(first: 100) { nodes { id topic uri } } }`);
    const have = new Set(existing.webhookSubscriptions.nodes.filter((w) => w.uri === callbackUrl).map((w) => w.topic));
    const created = [];
    for (const topic of topics) {
      if (have.has(topic)) continue;
      const data = await this.graphql(
        `mutation Sub($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }`,
        { topic, sub: { uri: callbackUrl, format: 'JSON' } },
      );
      const errs = data.webhookSubscriptionCreate.userErrors;
      if (errs.length) throw new Error(`Webhook ${topic}: ${errs.map((e) => e.message).join('; ')}`);
      created.push(topic);
    }
    return created;
  }
}

export function normaliseVariant(v) {
  const q = Object.fromEntries((v.inventoryItem.inventoryLevel?.quantities ?? []).map((x) => [x.name, x.quantity]));
  return {
    variantId: v.id,
    inventoryItemId: v.inventoryItem.id,
    productId: v.product.id,
    productTitle: v.product.title,
    productStatus: v.product.status,
    handle: v.product.handle,
    variantTitle: v.title === 'Default Title' ? '' : v.title,
    sku: v.sku || '',
    image: v.product.featuredMedia?.preview?.image?.url || '',
    tracked: v.inventoryItem.tracked,
    stocked: Boolean(v.inventoryItem.inventoryLevel),
    available: q.available ?? 0,
    onHand: q.on_hand ?? 0,
    committed: q.committed ?? 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
