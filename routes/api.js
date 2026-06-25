/**
 * GET /api/*
 * Dashboard data API — serves metrics, events, and inventory data to the dashboard UI.
 */

const express  = require('express');
const router   = express.Router();
const log      = require('../store/events');
const shopify  = require('../services/shopify');

// ─── Health Check ──────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    store: 'Extra Value Mart',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime())
  });
});

// ─── Dashboard Stats ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  res.json(log.getStats());
});

// ─── Recent Events Feed ────────────────────────────────────────────────
router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(log.getRecent(limit));
});

// ─── Error Log ─────────────────────────────────────────────────────────
router.get('/errors', (req, res) => {
  res.json(log.getErrors(50));
});

// ─── Daily Chart Data ──────────────────────────────────────────────────
router.get('/chart', (req, res) => {
  res.json(log.getDailyChart());
});

// ─── Current Inventory (from Shopify) ─────────────────────────────────
router.get('/inventory', async (req, res) => {
  try {
    const variants = await shopify.getAllInventory();
    res.json(variants.map(v => ({
      sku: v.sku,
      title: v.product.title,
      quantity: v.inventoryQuantity,
      price: v.price,
      status: v.inventoryQuantity === 0 ? 'out_of_stock'
            : v.inventoryQuantity <= 5  ? 'low_stock'
            : 'in_stock'
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
