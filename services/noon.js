/**
 * Noon Partner FBPI API client
 *
 * Authentication: RS256 JWT client assertion (apijwt type)
 *
 * Credentials come from store_credentials.json downloaded from
 * Noon Partner Dashboard → User Access → API Users (type: apijwt).
 *
 * Required env vars:
 *   NOON_CLIENT_ID      → key_id from credentials JSON
 *   NOON_CLIENT_SECRET  → private_key PEM (newlines can be literal \n or \\n)
 *   NOON_CHANNEL_ID     → channel_identifier from credentials JSON
 *   NOON_PROJECT_ID     → project_code (e.g. PRJ474943)
 *   NOON_ENV            → ae | sa | eg (default: ae)
 */

const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const KEY_ID         = process.env.NOON_CLIENT_ID;
const CHANNEL_ID     = process.env.NOON_CHANNEL_ID;   // channel_identifier
const PROJECT_ID     = process.env.NOON_PROJECT_ID;   // e.g. "PRJ474943"
const ENV            = process.env.NOON_ENV || 'ae';

// Handle private key stored with escaped newlines (common in env vars / Vercel)
const PRIVATE_KEY = (process.env.NOON_CLIENT_SECRET || '').replace(/\\n/g, '\n');

// Derive IDP token endpoint from channel_identifier
// Format: storename@{realm}.idp.noon.partners
// → https://idp.noon.partners/auth/realms/{realm}/protocol/openid-connect/token
function getTokenEndpoint() {
  if (!CHANNEL_ID) throw new Error('NOON_CHANNEL_ID is not set');
  // Extract realm from "extravaluemart@p474943.idp.noon.partners"
  const match = CHANNEL_ID.match(/@([^.]+)\.idp\.noon\.partners/);
  if (!match) throw new Error(`Cannot parse realm from NOON_CHANNEL_ID: ${CHANNEL_ID}`);
  const realm = match[1];
  return `https://idp.noon.partners/auth/realms/${realm}/protocol/openid-connect/token`;
}

const BASE_URL = 'https://api.noon.partners/v1';

let _token = null;
let _tokenExpiry = 0;

/**
 * Get a valid Noon access token using RS256 JWT client assertion.
 * Auto-refreshes when expired.
 */
async function getToken() {
  if (_token && Date.now() < _tokenExpiry - 30000) return _token;

  const tokenEndpoint = getTokenEndpoint();
  const now = Math.floor(Date.now() / 1000);

  // Build the JWT assertion signed with the RS256 private key
  const assertion = jwt.sign(
    {
      iss: KEY_ID,
      sub: KEY_ID,
      aud: tokenEndpoint,
      jti: uuidv4(),
      iat: now,
      exp: now + 300   // 5-minute validity
    },
    PRIVATE_KEY,
    {
      algorithm: 'RS256',
      header: { kid: KEY_ID, alg: 'RS256' }
    }
  );

  // Exchange the JWT assertion for an access token
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: KEY_ID,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion
  });

  const res = await axios.post(tokenEndpoint, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  _token = res.data.access_token;
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
 */
async function updateInventory(sku, quantity, warehouseId) {
  return request('PUT', '/fulfillment/inventory', {
    project_id: PROJECT_ID,
    warehouse_id: warehouseId,
    items: [{ sku, quantity: Math.max(0, quantity) }]
  });
}

/**
 * Bulk update inventory for multiple SKUs (batches of 100).
 */
async function bulkUpdateInventory(items, warehouseId) {
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

async function acknowledgeOrder(orderId) {
  return request('POST', `/fulfillment/orders/${orderId}/acknowledge`, {
    project_id: PROJECT_ID
  });
}

async function rejectOrder(orderId, reason = 'out_of_stock') {
  return request('POST', `/fulfillment/orders/${orderId}/reject`, {
    project_id: PROJECT_ID,
    reason
  });
}

// ─── SHIPMENTS ─────────────────────────────────────────────────────────

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