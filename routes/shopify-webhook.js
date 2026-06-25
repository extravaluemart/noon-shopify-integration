/**
 * POST /webhook/shopify
 *
 * Receives events FROM Shopify and syncs them back to Noon FBPI.
 *
 * Shopify webhook topics registered (set up in server.js on startup):
 *   - fulfillments/create       → tell Noon the order has shipped
 *   - orders/cancelled          → tell Noon to cancel
 *   - inventory_levels/update   → push new stock level to Noon
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const noon     = require('../services/noon');
const log      = require('../store/events');

const WAREHOUSE_ID = process.env.NOON_WAREHOUSE_ID || '';

// ─── Shopify HMAC Validation ───────────────────────────────────────────
function validateShopifyHmac(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true;

  const hmacHeader = req.headers['x-shopify-hmac-sha256'] || '';
  const body = req.body; // raw Buffer

  const digest = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(hmacHeader),
      Buffer.from(digest)
    );
  } catch {
    return false;
  }
}

// ─── Webhook Endpoint ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!validateShopifyHmac(req)) {
    log.add({ type: 'error', source: 'shopify-webhook', message: 'Invalid Shopify HMAC — request rejected' });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const topic = req.headers['x-shopify-topic'] || '';
  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Respond immediately
  res.status(200).json({ received: true });

  setImmediate(() => processShopifyEvent(topic, payload));
});

// ─── Event Router ──────────────────────────────────────────────────────
async function processShopifyEvent(topic, payload) {
  switch (topic) {
    case 'fulfillments/create':
    case 'fulfillments/update':
      await handleFulfillment(payload);
      break;

    case 'orders/cancelled':
      await handleOrderCancelled(payload);
      break;

    case 'inventory_levels/update':
      await handleInventoryUpdate(payload);
      break;

    default:
      log.add({
        type: 'info',
        source: 'shopify-webhook',
        message: `Unhandled Shopify topic: ${topic}`
      });
  }
}

// ─── Fulfillment Created (Shopify → Noon) ─────────────────────────────
async function handleFulfillment(fulfillment) {
  const { order_id, tracking_number, tracking_company, line_items = [] } = fulfillment;

  // Only process Noon orders (tagged with "noon-order")
  // We check the order tags embedded in the fulfillment note
  // Note: Shopify embeds order tags in the order object retrieved separately
  // Here we rely on tracking_number being present
  if (!tracking_number) {
    log.add({
      type: 'info',
      source: 'shopify→noon',
      message: `Fulfillment for order ${order_id} has no tracking — skipping Noon push`
    });
    return;
  }

  // Extract Noon order ID from line item properties or order tags
  // We stored the Noon ID as a tag "noon-XXXXXXX" on the order
  const noonTag = (fulfillment.order_tags || '')
    .split(',')
    .map(t => t.trim())
    .find(t => t.startsWith('noon-') && t !== 'noon-order');

  if (!noonTag) {
    // Not a Noon order — ignore
    return;
  }

  const noonOrderId = noonTag.replace('noon-', '');

  try {
    await noon.createShipment({
      noonOrderId,
      trackingNumber: tracking_number,
      trackingCompany: tracking_company || 'Courier',
      items: line_items.map(li => ({ sku: li.sku, quantity: li.quantity })),
      warehouseId: WAREHOUSE_ID
    });

    log.add({
      type: 'shipment_confirmed',
      source: 'shopify→noon',
      noonOrderId,
      shopifyOrderId: order_id,
      trackingNumber: tracking_number,
      message: `📦 Shopify order ${order_id} fulfilled → Noon shipment created (${tracking_number})`
    });
  } catch (err) {
    log.add({
      type: 'error',
      source: 'shopify→noon',
      noonOrderId,
      shopifyOrderId: order_id,
      message: `❌ Failed to create Noon shipment for order ${noonOrderId}: ${err.message}`
    });
  }
}

// ─── Order Cancelled (Shopify → Noon) ─────────────────────────────────
async function handleOrderCancelled(order) {
  // Only process Noon orders
  const tags = (order.tags || '').split(',').map(t => t.trim());
  if (!tags.includes('noon-order')) return;

  const noonTag = tags.find(t => t.startsWith('noon-') && t !== 'noon-order');
  if (!noonTag) return;
  const noonOrderId = noonTag.replace('noon-', '');

  try {
    await noon.rejectOrder(noonOrderId, 'seller_cancelled');
    log.add({
      type: 'order_cancelled',
      source: 'shopify→noon',
      noonOrderId,
      shopifyOrderId: order.id,
      message: `🚫 Shopify order ${order.name} cancelled → Noon order ${noonOrderId} rejected`
    });
  } catch (err) {
    log.add({
      type: 'error',
      source: 'shopify→noon',
      noonOrderId,
      message: `❌ Failed to reject Noon order ${noonOrderId}: ${err.message}`
    });
  }
}

// ─── Inventory Update (Shopify → Noon) ────────────────────────────────
async function handleInventoryUpdate(level) {
  // level = { inventory_item_id, location_id, available, updated_at }
  // We need to find the SKU for this inventory item
  // This is resolved by the scheduled sync (server.js) which has the full SKU map.
  // Here we log it and let the next scheduled sync pick it up.
  log.add({
    type: 'inventory_sync',
    source: 'shopify→noon',
    inventoryItemId: level.inventory_item_id,
    available: level.available,
    message: `📊 Inventory update queued for item ${level.inventory_item_id}: ${level.available} units`
  });

  // If you have the SKU→inventoryItemId map cached, you can push immediately:
  if (global.skuByInventoryItemId && global.skuByInventoryItemId[level.inventory_item_id]) {
    const sku = global.skuByInventoryItemId[level.inventory_item_id];
    try {
      await noon.updateInventory(sku, level.available, WAREHOUSE_ID);
      log.add({
        type: 'inventory_sync',
        source: 'shopify→noon',
        sku,
        quantity: level.available,
        message: `✅ Noon inventory updated: ${sku} → ${level.available} units`
      });
    } catch (err) {
      log.add({
        type: 'error',
        source: 'shopify→noon',
        sku,
        message: `❌ Noon inventory update failed for ${sku}: ${err.message}`
      });
    }
  }
}

module.exports = router;
