/**
 * Noon Partner FBPI API client
 *
 * Base URLs per country:
 *   UAE: https://api.noon.partners/v1  (env = ae)
 *   KSA: https://api.noon.partners/v1  (env = sa)
 *   Egypt: https://api.noon.partners/v1 (env = eg)
 *
 * Authentication: JWT via client_credentials grant.
 * Credentials come from store_credentials.json downloaded from
 * Noon Partner Dashboard → User Access → API Users.
 */

const axios = require('axios');

const CLIENT_ID     = process.env.NOON_CLIENT_ID;
const CLIENT_SECRET = process.env.NOON_CLIENT_SECRET;
const PROJECT_ID    = process.env.NOON_PROJECT_ID;  // e.g. "PRJ123456"
const ENV           = process.env.NOON_ENV || 'ae'; // ae | sa | eg

// NOTE: Noon provides the exact base URL in your store_credentials.json.
// Update BASE_URL if yours differs.
const BASE_URL = `https://api.noon.partners/v1`;

let _token = null;
let _tokenExpiry = 0;

/**
 * Get a valid Noon JWT access token (auto-refreshes when expired).
 */
async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 30000) return _token;

  const res = await axios.post(`${BASE_URL}/auth/token`, {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  _token = res.data.access_token;
  // Typically expires in 3600s; subtract 60s buffer
  _tokenExpiry = Date.now() + ((res.data.expires_in || 3600) - 60) * 1000;
  return _token;
}

/**
 * Authenticated Noon API request.
 */
async function request(method, path, data = null, params = null) {
  const token = await getToken();
  const res = await axios({
    method,
    url: `${BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Noon-Project': PROJECT_ID
    },
    data,
    params
  });
  return res.data;
}

// ─── INVENTORY ─────────────────────────────────────────────────────────

/**
 * Update inventory for a single SKU on Noon.
 * @param {string} sku         - The partner SKU code (must match what's on Noon listing)
 * @param {number} quantity    - New available quantity
 * @param {string} warehouseId - Your Noon integration warehouse ID
 */
async function updateInventory(sku, quantity, warehouseId) {
  return request('PUT', '/fulfillment/inventory', {
    project_id: PROJECT_ID,
    warehouse_id: warehouseId,
    items: [{ sku, quantity: Math.max(0, quantity) }]
  });
}

/**
 * Bulk update inventory for multiple SKUs in one call.
 * @param {Array<{sku, quantity}>} items
 * @param {string} warehouseId
 */
async function bulkUpdateInventory(items, warehouseId) {
  // Noon supports batches; chunk to 100 items per call
  const BATCH = 100;
  const results = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const res = await request('PUT', '/fulfillment/inventory', {
      project_id: PROJECT_ID,
      warehouse_id: warehouseId,
      items: chunk.map(({ sku, quantity }) => ({ sku, quantity: Math.max(0, quantity) }))
    });
    results.push(res);
  }
  return results;
}

// ─── ORDERS ────────────────────────────────────────────────────────────

/**
 * Acknowledge a Noon order (confirm you can fulfill it).
 * @param {string} orderId - Noon order ID
 */
async function acknowledgeOrder(orderId) {
  return request('POST', `/fulfillment/orders/${orderId}/acknowledge`, {
    project_id: PROJECT_ID
  });
}

/**
 * Reject a Noon order (e.g. out of stock).
 * @param {string} orderId
 * @param {string} reason   - e.g. "out_of_stock"
 */
async function rejectOrder(orderId, reason = 'out_of_stock') {
  return request('POST', `/fulfillment/orders/${orderId}/reject`, {
    project_id: PROJECT_ID,
    reason
  });
}

// ─── SHIPMENTS ─────────────────────────────────────────────────────────

/**
 * Create a shipment on Noon (after packing & handing over to courier).
 * This is what closes the loop and tells Noon the order has shipped.
 *
 * @param {string} noonOrderId     - Noon order ID
 * @param {string} trackingNumber  - Courier tracking number
 * @param {string} trackingCompany - Courier name (e.g. "Aramex", "DHL")
 * @param {Array}  items           - [{sku, quantity}]
 * @param {string} warehouseId     - Your integration warehouse ID
 */
async function createShipment({ noonOrderId, trackingNumber, trackingCompany, items, warehouseId }) {
  return request('POST', '/fulfillment/shipments', {
    project_id: PROJECT_ID,
    warehouse_id: warehouseId,
    order_id: noonOrderId,
    tracking_number: trackingNumber,
    tracking_company: trackingCompany,
    items: items.map(({ sku, quantity }) => ({ sku, quantity }))
  });
}

/**
 * Get current status of a Noon order.
 */
async function getOrder(noonOrderId) {
  return request('GET', `/fulfillment/orders/${noonOrderId}`, null, {
    project_id: PROJECT_ID
  });
}

/**
 * List recent Noon orders (for dashboard sync check).
 */
async function listOrders({ status, limit = 20, page = 1 } = {}) {
  return request('GET', '/fulfillment/orders', null, {
    project_id: PROJECT_ID,
    status,
    limit,
    page
  });
}

module.exports = {
  getToken,
  updateInventory,
  bulkUpdateInventory,
  acknowledgeOrder,
  rejectOrder,
  createShipment,
  getOrder,
  listOrders
};
