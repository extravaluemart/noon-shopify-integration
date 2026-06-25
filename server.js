/**
 * Noon ↔ Shopify Integration Server
 * Extra Value Mart (extravaluemart.myshopify.com)
 *
 * Flows handled:
 *   1. Noon → Shopify: New/cancelled/shipped orders via webhook
 *   2. Shopify → Noon: Fulfillments, cancellations, inventory via webhook
 *   3. Scheduled: Full inventory sync every hour (Shopify → Noon)
 */

require('dotenv').config();

const express = require('express');
const path    = require('path');
const cron    = require('node-cron');
const axios   = require('axios');

const noonWebhookRouter   = require('./routes/noon-webhook');
const shopifyWebhookRouter = require('./routes/shopify-webhook');
const apiRouter            = require('./routes/api');
const shopify              = require('./services/shopify');
const noon                 = require('./services/noon');
const log                  = require('./store/events');

const app = express();
const PORT = process.env.PORT || 3000;
const WAREHOUSE_ID = process.env.NOON_WAREHOUSE_ID || '';

// ─── Middleware ────────────────────────────────────────────────────────
// Webhooks need the raw body for HMAC validation — must come BEFORE express.json()
app.use('/webhook', express.raw({ type: '*/*', limit: '5mb' }));

// Everything else gets parsed as JSON
app.use(express.json());

// Serve the dashboard as static files
app.use(express.static(path.join(__dirname, 'dashboard')));

// ─── Routes ───────────────────────────────────────────────────────────
app.use('/webhook/noon',    noonWebhookRouter);
app.use('/webhook/shopify', shopifyWebhookRouter);
app.use('/api',             apiRouter);

// Dashboard root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ─── OAuth Callback (for initial token acquisition) ───────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, state, shop } = req.query;
  if (!code) return res.status(400).json({ error: 'No code provided' });
  const clientId     = process.env.SHOPIFY_CLIENT_ID     || 'd784b60d8ac0fc3f4bd024c718541ef3';
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || '';
  const shopDomain   = shop || `${process.env.SHOPIFY_STORE}.myshopify.com`;
  try {
    const tokenRes = await axios.post(`https://${shopDomain}/admin/oauth/access_token`, {
      client_id: clientId, client_secret: clientSecret, code
    });
    const { access_token, scope } = tokenRes.data;
    res.json({ success: true, access_token, scope });
  } catch (err) {
    res.status(500).json({ error: err.message, details: err.response?.data });
  }
});

// ─── Shopify Webhook Registration ────────────────────────────────────
// Registers the required Shopify webhooks pointing to THIS server.
// Run once on startup — Shopify silently ignores duplicates.
async function registerShopifyWebhooks(serverUrl) {
  const SHOPIFY_STORE  = process.env.SHOPIFY_STORE || 'extravaluemart';
  const SHOPIFY_TOKEN  = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!SHOPIFY_TOKEN) {
    console.warn('[startup] SHOPIFY_ACCESS_TOKEN not set — skipping webhook registration');
    return;
  }

  const webhooks = [
    { topic: 'fulfillments/create',      address: `${serverUrl}/webhook/shopify` },
    { topic: 'fulfillments/update',      address: `${serverUrl}/webhook/shopify` },
    { topic: 'orders/cancelled',         address: `${serverUrl}/webhook/shopify` },
    { topic: 'inventory_levels/update',  address: `${serverUrl}/webhook/shopify` }
  ];

  for (const wh of webhooks) {
    try {
      await axios.post(
        `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-04/webhooks.json`,
        { webhook: { topic: wh.topic, address: wh.address, format: 'json' } },
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' } }
      );
      console.log(`[startup] ✅ Shopify webhook registered: ${wh.topic}`);
    } catch (err) {
      // 422 = already exists, which is fine
      if (err.response?.status !== 422) {
        console.warn(`[startup] ⚠️  Shopify webhook ${wh.topic}: ${err.response?.data?.errors || err.message}`);
      } else {
        console.log(`[startup] ℹ️  Shopify webhook already exists: ${wh.topic}`);
      }
    }
  }
}

// ─── Scheduled: Full Inventory Sync (Shopify → Noon) ─────────────────
// Runs every hour. Pulls all active SKUs from Shopify and pushes quantities to Noon.
async function runInventorySync() {
  if (!WAREHOUSE_ID) {
    console.warn('[inventory-sync] NOON_WAREHOUSE_ID not set — skipping');
    return;
  }

  console.log('[inventory-sync] Starting full inventory sync...');
  try {
    const variants = await shopify.getAllInventory();

    // Build SKU map for real-time webhook updates
    global.skuByInventoryItemId = {};

    const items = variants
      .filter(v => v.sku)
      .map(v => ({ sku: v.sku, quantity: v.inventoryQuantity }));

    if (items.length === 0) {
      console.log('[inventory-sync] No variants with SKUs found');
      return;
    }

    await noon.bulkUpdateInventory(items, WAREHOUSE_ID);

    log.add({
      type: 'inventory_sync',
      source: 'shopify→noon',
      itemCount: items.length,
      message: `✅ Full inventory sync complete: ${items.length} SKUs pushed to Noon`
    });

    console.log(`[inventory-sync] ✅ Synced ${items.length} SKUs to Noon`);
  } catch (err) {
    log.add({
      type: 'error',
      source: 'inventory-sync',
      message: `❌ Inventory sync failed: ${err.message}`
    });
    console.error('[inventory-sync] ❌ Error:', err.message);
  }
}

// ─── Start Server ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║   Noon ↔ Shopify Integration — Extra Value Mart     ║
  ║   Running on port ${PORT}                               ║
  ╚══════════════════════════════════════════════════════╝

  Endpoints:
    Dashboard:           http://localhost:${PORT}/
    Noon Webhook URL:    https://YOUR-VERCEL-URL.vercel.app/webhook/noon
    Shopify Webhook URL: https://YOUR-VERCEL-URL.vercel.app/webhook/shopify
    API Health:          http://localhost:${PORT}/api/health
  `);

  // Register Shopify webhooks (uses the server's public URL from env)
  const serverUrl = process.env.SERVER_URL || `http://localhost:${PORT}`;
  await registerShopifyWebhooks(serverUrl);

  // Run inventory sync on startup + schedule hourly
  if (process.env.NODE_ENV === 'production') {
    await runInventorySync();
    // Every hour at :00
    cron.schedule('0 * * * *', runInventorySync);
    console.log('[scheduler] ✅ Inventory sync scheduled: every hour');
  }
});

module.exports = app;
