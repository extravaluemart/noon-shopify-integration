/**
 * Shopify Admin API client
 * Store: Extra Value Mart (extravaluemart.myshopify.com)
 */

const axios = require('axios');

const STORE = process.env.SHOPIFY_STORE || 'extravaluemart';
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const BASE = `https://${STORE}.myshopify.com/admin/api/2024-04`;

const client = axios.create({
  baseURL: BASE,
  headers: {
    'X-Shopify-Access-Token': TOKEN,
    'Content-Type': 'application/json'
  }
});

// ─── SKU → Variant ID cache ───────────────────────────────────────────
const skuCache = {};

/**
 * Look up Shopify variant IDs by SKU.
 * Shopify requires variant_id to create line items properly.
 */
async function lookupVariantsBySKU(lineItems) {
  const enriched = [];

  for (const item of lineItems) {
    if (item.sku && !skuCache[item.sku]) {
      try {
        const res = await client.get('/variants.json', {
          params: { limit: 1 }
        });
        // Use GraphQL for SKU lookup since REST doesn't filter by SKU directly
        const gql = await client.post('/graphql.json', {
          query: `{
            productVariants(first: 1, query: "sku:${item.sku}") {
              edges { node { id legacyResourceId price title product { title } } }
            }
          }`
        });
        const edge = gql.data?.data?.productVariants?.edges?.[0];
        if (edge) {
          skuCache[item.sku] = {
            variantId: edge.node.legacyResourceId,
            title: edge.node.product.title,
            variantTitle: edge.node.title,
            price: edge.node.price
          };
        }
      } catch (e) {
        console.error(`SKU lookup failed for ${item.sku}:`, e.message);
      }
    }

    const cached = skuCache[item.sku];
    if (cached) {
      enriched.push({
        variant_id: cached.variantId,
        quantity: item.quantity,
        price: item.price || cached.price,
        title: item.title || cached.title
      });
    } else {
      // Fallback: use title/price without variant_id (custom line item)
      enriched.push({
        title: item.title || item.sku || 'Noon Product',
        quantity: item.quantity,
        price: item.price || '0.00',
        requires_shipping: true,
        sku: item.sku
      });
    }
  }

  return enriched;
}

/**
 * Create a Shopify order from a Noon event.
 */
async function createOrder(payload) {
  const res = await client.post('/orders.json', { order: payload });
  return res.data.order;
}

/**
 * Find a Shopify order that was created from a Noon order (by note/tag search).
 */
async function findOrderByNoonId(noonOrderId) {
  const res = await client.get('/orders.json', {
    params: {
      status: 'any',
      limit: 1,
      // Shopify doesn't support note search via REST, so we tag every Noon order
      // with noon-{order_id} for reliable lookup
    }
  });
  // Search by tag
  const tagged = await client.get(`/orders.json?status=any&tag=noon-${noonOrderId}&limit=1`);
  return tagged.data.orders?.[0] || null;
}

/**
 * Cancel a Shopify order by its Noon order ID.
 */
async function cancelOrderByNoonId(noonOrderId) {
  const order = await findOrderByNoonId(noonOrderId);
  if (!order) throw new Error(`No Shopify order found for Noon ID: ${noonOrderId}`);
  const res = await client.post(`/orders/${order.id}/cancel.json`, {
    reason: 'customer',
    email: false,
    restock: true
  });
  return res.data.order;
}

/**
 * Get current inventory level for a SKU (by location).
 * Returns { sku, quantity, inventoryItemId, locationId }
 */
async function getInventoryBySKU(sku) {
  const gql = await client.post('/graphql.json', {
    query: `{
      productVariants(first: 1, query: "sku:${sku}") {
        edges {
          node {
            sku
            inventoryQuantity
            inventoryItem {
              id
              inventoryLevels(first: 5) {
                edges {
                  node {
                    quantities(names: ["available"]) { name quantity }
                    location { id name }
                  }
                }
              }
            }
          }
        }
      }
    }`
  });
  const node = gql.data?.data?.productVariants?.edges?.[0]?.node;
  if (!node) return null;
  return {
    sku: node.sku,
    quantity: node.inventoryQuantity,
    inventoryItem: node.inventoryItem
  };
}

/**
 * Get all active products with their SKUs and inventory quantities.
 * Used for the full inventory sync push to Noon.
 */
async function getAllInventory() {
  let allVariants = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const cursorPart = cursor ? `, after: "${cursor}"` : '';
    const gql = await client.post('/graphql.json', {
      query: `{
        productVariants(first: 50, query: "status:active"${cursorPart}) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              sku
              price
              inventoryQuantity
              product { title status }
            }
          }
        }
      }`
    });

    const data = gql.data?.data?.productVariants;
    if (!data) break;

    const variants = data.edges
      .map(e => e.node)
      .filter(v => v.sku && v.product.status === 'ACTIVE');

    allVariants = allVariants.concat(variants);
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return allVariants;
}

/**
 * Create a fulfillment on a Shopify order (marks it as shipped).
 * Called after we get a shipment confirmation from Noon side (if Noon handles shipping).
 */
async function createFulfillment(orderId, trackingNumber, trackingCompany) {
  // First get fulfillment orders
  const foRes = await client.get(`/orders/${orderId}/fulfillment_orders.json`);
  const fo = foRes.data.fulfillment_orders?.[0];
  if (!fo) throw new Error('No fulfillment order found');

  const res = await client.post('/fulfillments.json', {
    fulfillment: {
      line_items_by_fulfillment_order: [
        { fulfillment_order_id: fo.id }
      ],
      tracking_info: {
        number: trackingNumber,
        company: trackingCompany || 'Noon Logistics',
        url: `https://www.noon.com/uae-en/track-order/${trackingNumber}`
      },
      notify_customer: true
    }
  });
  return res.data.fulfillment;
}

module.exports = {
  lookupVariantsBySKU,
  createOrder,
  findOrderByNoonId,
  cancelOrderByNoonId,
  getInventoryBySKU,
  getAllInventory,
  createFulfillment
};
