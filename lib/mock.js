// In-memory stand-in for Shopify, used by `npm run demo` so the dashboard can be
// tried without store credentials. It also simulates customer orders so the
// live updates are visible.

const PRODUCTS = [
  ['YXY Dried Bird\'s Nest Yantiao (37.5g)', [''], 'ACTIVE'],
  ['YXY Dried Bird\'s Nest 4A Grade (37.5g)', [''], 'DRAFT'],
  ['Concentrate Birdnest Ginseng', ['0%', '50%', '100%'], 'ACTIVE'],
  ['Concentrate Birdnest Rock Sugar', ['0%', '50%', '100%'], 'ACTIVE'],
  ['Concentrate Birdnest Pandan', ['0%', '50%', '100%'], 'ACTIVE'],
  ['Bird\'s Nest Gift Set Premium', ['6 bottles', '12 bottles'], 'ACTIVE'],
  ['Bird\'s Nest with Red Dates', ['Single', 'Box of 6'], 'ACTIVE'],
  ['White Fungus Dessert', [''], 'ARCHIVED'],
];

export class MockShopify {
  constructor() {
    this.shop = 'demo-store.myshopify.com';
    this.items = new Map();
    let n = 1;
    for (const [title, variants, status] of PRODUCTS) {
      const productId = `gid://shopify/Product/${n}`;
      for (const vt of variants) {
        const available = [0, 3, 8, 42, 150, 730][n % 6];
        const committed = n % 4;
        this.items.set(`gid://shopify/InventoryItem/${n}`, {
          variantId: `gid://shopify/ProductVariant/${n}`,
          inventoryItemId: `gid://shopify/InventoryItem/${n}`,
          productId,
          productTitle: title,
          productStatus: status,
          handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          variantTitle: vt,
          sku: `YXY-${String(n).padStart(3, '0')}`,
          image: '',
          tracked: n !== 2,
          stocked: true,
          available,
          onHand: available + committed,
          committed,
        });
        n++;
      }
    }
  }

  async getPrimaryLocation() {
    return { id: 'gid://shopify/Location/1', name: 'Shop location', isActive: true };
  }

  async fetchAllVariants() {
    return [...this.items.values()].map((v) => ({ ...v }));
  }

  async fetchVariantByInventoryItem(id) {
    const v = this.items.get(id);
    return v ? { ...v } : null;
  }

  async setAvailable({ inventoryItemId, quantity, expected }) {
    const v = this.items.get(inventoryItemId);
    if (!v) return [{ code: 'NOT_FOUND', message: 'Inventory item not found' }];
    if (expected != null && v.available !== expected) {
      return [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'The quantity changed since you loaded it' }];
    }
    v.onHand += quantity - v.available;
    v.available = quantity;
    return [];
  }

  async ensureWebhooks() {
    return [];
  }

  /** Simulates a customer order on the website: calls onChange(inventoryItemId). */
  startSimulatedOrders(onChange, everyMs = 8000) {
    setInterval(() => {
      const candidates = [...this.items.values()].filter((v) => v.tracked && v.available > 0);
      if (!candidates.length) return;
      const v = candidates[Math.floor(Math.random() * candidates.length)];
      v.available -= 1;
      v.committed += 1;
      onChange(v.inventoryItemId);
    }, everyMs).unref();
  }
}
