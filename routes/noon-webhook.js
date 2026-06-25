/**
 * POST /webhook/noon
 *
 * Receives events FROM Noon FBPI and syncs them to Shopify.
 *
 * Events handled:
 *   - new / confirmed  → create Shopify order
 *   - cancelled        → cancel Shopify order + restock inventory
 *   - shipped          → mark Shopify order as fulfilled
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const shopify = require('../services/shopify');
const noon    = require('../services/noon');
const log     = require('../store/events');

// ─── Signature Validation ──────────────────────────────────────────────
function validateNoonSignature(req) {
  const secret = process.env.NOON_WEBHOOK_SECRET;
  if (!secret) return true; // Skip validation in dev if secret not set

  // Noon sends the signature in X-Noon-Signature header
  const signature = req.headers['x-noon-signature'] || req.headers['x-hub-signature-256'] || '';
  const body = req.body; // raw Buffer (set up in server.js)

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature.padEnd(expected.length)),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// ─── Webhook Endpoint ──────────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!validateNoonSignature(req)) {
    log.add({ type: 'error', source: 'noon-webhook', message: 'Invalid webhook signature — request rejected' });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Always respond 200 immediately — process async
  res.status(200).json({ received: true });

  setImmediate(() => processNoonEvent(event));
});

// ─── Event Processor ───────────────────────────────────────────────────
async function processNoonEvent(event) {
  const { order_id, status, items = [], customer = {}, shipping_address = {}, total_amount } = event;

  log.add({
    type: 'noon_event',
    source: 'noon',
    orderId: order_id,
    status,
    message: `Noon webhook received: order ${order_id} [${status}]`
  });

  // ── NEW ORDER: Noon → Shopify ────────────────────────────────────────
  if (status === 'new' || status === 'confirmed' || status === 'created') {
    try {
      // Resolve Shopify variant IDs from Noon SKUs
      const lineItems = await shopify.lookupVariantsBySKU(
        items.map(item => ({
          sku: item.sku || item.partner_sku,
          quantity: item.quantity,
          price: String(item.unit_price || item.price || '0.00'),
          title: item.title || item.name
        }))
      );

      const shopifyOrder = await shopify.createOrder({
        note: `Noon FBPI Order ID: ${order_id}`,
        // Tag format: noon-order + noon-{id} for quick lookup
        tags: `noon-order, noon-${order_id}, partner-fulfilled`,
        financial_status: 'pending',
        send_receipt: false,
        send_fulfillment_receipt: false,
        line_items: lineItems,
        customer: {
          first_name: customer.first_name || 'Noon',
          last_name:  customer.last_name  || 'Customer',
          email:      customer.email      || undefined,
          phone:      customer.phone      || undefined
        },
        shipping_address: {
          first_name: shipping_address.first_name || customer.first_name || 'Noon',
          last_name:  shipping_address.last_name  || customer.last_name  || 'Customer',
          address1:   shipping_address.address1   || shipping_address.street || '',
          address2:   shipping_address.address2   || '',
          city:       shipping_address.city        || 'Dubai',
          country:    shipping_address.country     || 'United Arab Emirates',
          country_code: 'AE',
          zip:        shipping_address.zip         || '',
          phone:      shipping_address.phone       || customer.phone || ''
        },
        currency: 'AED'
      });

      log.add({
        type: 'order_synced',
        source: 'noon→shopify',
        noonOrderId: order_id,
        shopifyOrderId: shopifyOrder.id,
        shopifyOrderName: shopifyOrder.name,
        amount: total_amount,
        message: `✅ Noon ${order_id} → Shopify ${shopifyOrder.name} (AED ${total_amount || '—'})`
      });

    } catch (err) {
      log.add({
        type: 'error',
        source: 'noon→shopify',
        orderId: order_id,
        message: `❌ Failed to create Shopify order for Noon ${order_id}: ${err.message}`
      });
      console.error('[noon-webhook] order create error:', err.message);
    }
  }

  // ── CANCELLED ORDER ──────────────────────────────────────────────────
  else if (status === 'cancelled' || status === 'canceled') {
    try {
      const order = await shopify.findOrderByNoonId(order_id);
      if (order) {
        await shopify.cancelOrderByNoonId(order_id);
        log.add({
          type: 'order_cancelled',
          source: 'noon→shopify',
          noonOrderId: order_id,
          shopifyOrderId: order.id,
          message: `🚫 Noon order ${order_id} cancelled → Shopify order ${order.name} cancelled`
        });
      } else {
        log.add({
          type: 'error',
          source: 'noon→shopify',
          orderId: order_id,
          message: `Cancel: no Shopify order found for Noon ID ${order_id}`
        });
      }
    } catch (err) {
      log.add({
        type: 'error',
        source: 'noon→shopify',
        orderId: order_id,
        message: `❌ Failed to cancel Shopify order for Noon ${order_id}: ${err.message}`
      });
    }
  }

  // ── SHIPPED (Noon confirms pickup/delivery) ──────────────────────────
  else if (status === 'shipped' || status === 'dispatched') {
    try {
      const order = await shopify.findOrderByNoonId(order_id);
      if (order && event.tracking_number) {
        await shopify.createFulfillment(
          order.id,
          event.tracking_number,
          event.tracking_company || 'Noon Logistics'
        );
        log.add({
          type: 'shipment_confirmed',
          source: 'noon→shopify',
          noonOrderId: order_id,
          trackingNumber: event.tracking_number,
          message: `📦 Noon ${order_id} shipped — Shopify fulfillment created (${event.tracking_number})`
        });
      }
    } catch (err) {
      log.add({
        type: 'error',
        source: 'noon→shopify',
        orderId: order_id,
        message: `❌ Failed to create Shopify fulfillment for Noon ${order_id}: ${err.message}`
      });
    }
  }
}

module.exports = router;
