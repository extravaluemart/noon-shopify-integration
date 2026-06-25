# Noon ↔ Shopify Integration — Setup Guide
## Extra Value Mart

---

## Step 1 — Push to GitHub

1. Create a new **private** repository on github.com (e.g. `noon-shopify-integration`)
2. Open a terminal in this folder and run:

```bash
git init
git add .
git commit -m "Initial integration setup"
git remote add origin https://github.com/YOUR_USERNAME/noon-shopify-integration.git
git push -u origin main
```

---

## Step 2 — Deploy to Vercel (Free)

1. Go to [vercel.com](https://vercel.com) → Sign in with GitHub
2. Click **Add New Project** → import your `noon-shopify-integration` repo
3. Framework preset: **Other**
4. Click **Deploy** (first deploy will fail without env vars — that's OK)

---

## Step 3 — Set Environment Variables in Vercel

In your Vercel project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `NOON_CLIENT_ID` | From your `store_credentials.json` |
| `NOON_CLIENT_SECRET` | From your `store_credentials.json` |
| `NOON_PROJECT_ID` | e.g. `PRJ123456` |
| `NOON_ENV` | `ae` |
| `NOON_WAREHOUSE_ID` | From Noon FBPI warehouse dashboard |
| `NOON_WEBHOOK_SECRET` | A strong random string you invent (save it!) |
| `SHOPIFY_STORE` | `extravaluemart` |
| `SHOPIFY_ACCESS_TOKEN` | From Shopify Admin → Settings → Apps → Develop apps |
| `SHOPIFY_WEBHOOK_SECRET` | From the same Shopify app |
| `SERVER_URL` | `https://YOUR-PROJECT.vercel.app` |
| `NODE_ENV` | `production` |

After adding all variables → **Redeploy**.

---

## Step 4 — Get Your Shopify Admin API Token

1. Go to Shopify Admin → **Settings → Apps and sales channels**
2. Click **Develop apps** → **Create an app**
3. Name it: `Noon Integration`
4. Click **Configure Admin API scopes**, enable:
   - `read_orders`, `write_orders`
   - `read_inventory`, `write_inventory`
   - `read_products`
   - `read_fulfillments`, `write_fulfillments`
5. Click **Save** → **Install app** → copy the **Admin API access token**
6. Also copy the **API secret key** (this is your `SHOPIFY_WEBHOOK_SECRET`)

---

## Step 5 — Configure Noon FBPI Warehouse

1. Go to: `https://fbpi.noon.partners/en-ae?project=PRJ(YOUR_PROJECT_NR)`
2. Click **Add New Warehouse** → name it → select UAE → **Create**
3. Click **Configure Warehouse** → select **"Act as your own integrator"** (Webhook option)
4. Enter:
   - **Webhook URL:** `https://YOUR-PROJECT.vercel.app/webhook/noon`
   - **Webhook API Key:** the same value as your `NOON_WEBHOOK_SECRET`
5. Click **OK**
6. Fill in **Processing Time** and **Delivery Model** → **Save**
7. Toggle warehouse to **Active**

---

## Step 6 — Verify Everything Works

Open your dashboard:
```
https://YOUR-PROJECT.vercel.app/
```

You should see:
- ✅ Status dot: Online
- 📊 Inventory table populated with your Tiny Buds SKUs
- 📡 Event feed ready and waiting

**Test the integration:**
1. Place a test order on your Noon listing
2. Within seconds, your dashboard should show:
   - A new event in the feed: `✅ Noon ORDER_ID → Shopify #ORDXXXX`
   - Noon orders stat increments
3. Fulfill the order in Shopify (add tracking number)
4. Dashboard shows: `📦 Shopify order fulfilled → Noon shipment created`

---

## Webhook URLs Summary

| Endpoint | Purpose |
|---|---|
| `POST /webhook/noon` | Noon → Shopify (paste this in Noon FBPI config) |
| `POST /webhook/shopify` | Shopify → Noon (auto-registered by server on startup) |
| `GET /api/health` | Server health check |
| `GET /api/stats` | Dashboard metrics |
| `GET /api/inventory` | Current Shopify inventory |
| `GET /` | Dashboard UI |

---

## Adding More SKUs to Noon

The integration uses **SKU codes** to match products between Noon and Shopify.
When listing a product on Noon, set the **Partner SKU Code** to exactly match
the SKU in Shopify. Your current Shopify SKUs start with `021959...`.

---

## Need Help?

- Noon support: seller@noon.com
- Noon FBPI docs: https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-integration-a-comprehensive-guide
