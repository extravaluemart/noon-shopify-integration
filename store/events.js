/**
 * In-memory event log with lightweight persistence.
 * Stores the last 500 integration events (orders, syncs, errors, etc.)
 * Resets on server restart — for persistent logging, swap this for a DB.
 */

const MAX_EVENTS = 500;

let events = [];
let stats = {
  noonOrdersReceived: 0,
  shopifyOrdersCreated: 0,
  shipmentsConfirmed: 0,
  inventorySyncs: 0,
  errors: 0,
  lastInventorySync: null,
  // revenue tracking
  totalNoonRevenue: 0,
  // daily buckets (last 7 days)
  daily: {}
};

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "2026-06-25"
}

function add(event) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    ...event
  };

  events.unshift(entry);
  if (events.length > MAX_EVENTS) events.pop();

  // Update stats
  const day = todayKey();
  if (!stats.daily[day]) {
    stats.daily[day] = { orders: 0, revenue: 0, shipments: 0, errors: 0 };
  }

  switch (event.type) {
    case 'noon_event':
      stats.noonOrdersReceived++;
      break;
    case 'order_synced':
      stats.shopifyOrdersCreated++;
      stats.daily[day].orders++;
      if (event.amount) {
        stats.totalNoonRevenue += Number(event.amount);
        stats.daily[day].revenue += Number(event.amount);
      }
      break;
    case 'shipment_confirmed':
      stats.shipmentsConfirmed++;
      stats.daily[day].shipments++;
      break;
    case 'inventory_sync':
      stats.inventorySyncs++;
      stats.lastInventorySync = entry.timestamp;
      break;
    case 'error':
      stats.errors++;
      stats.daily[day].errors++;
      break;
  }

  // Trim daily data to last 7 days
  const keys = Object.keys(stats.daily).sort().reverse();
  if (keys.length > 7) {
    keys.slice(7).forEach(k => delete stats.daily[k]);
  }

  return entry;
}

function getRecent(limit = 50) {
  return events.slice(0, limit);
}

function getStats() {
  return { ...stats };
}

function getErrors(limit = 20) {
  return events.filter(e => e.type === 'error').slice(0, limit);
}

function getDailyChart() {
  // Return last 7 days in order (oldest → newest)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      date: key,
      label: d.toLocaleDateString('en-AE', { month: 'short', day: 'numeric' }),
      ...(stats.daily[key] || { orders: 0, revenue: 0, shipments: 0, errors: 0 })
    });
  }
  return days;
}

module.exports = { add, getRecent, getStats, getErrors, getDailyChart };
