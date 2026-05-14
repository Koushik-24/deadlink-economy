const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');
const { Pool } = require('pg');

const app         = express();
const PORT        = process.env.PORT || 3000;
const YOUR_DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

// ─── DATABASE — Supabase PostgreSQL ──────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS domains (
      id          SERIAL PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      niche       TEXT,
      dr          INTEGER DEFAULT 0,
      backlinks   INTEGER DEFAULT 0,
      traffic     INTEGER DEFAULT 0,
      age_years   INTEGER DEFAULT 0,
      expired_at  TEXT,
      reason      TEXT,
      status      TEXT DEFAULT 'expired',
      wayback_url TEXT,
      first_seen  TEXT,
      last_seen   TEXT,
      scored      INTEGER DEFAULT 0,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id           SERIAL PRIMARY KEY,
      session_id   TEXT UNIQUE,
      domain       TEXT,
      product_type TEXT,
      email        TEXT,
      amount       INTEGER,
      paid         INTEGER DEFAULT 0,
      created_at   TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id         SERIAL PRIMARY KEY,
      email      TEXT,
      niche      TEXT,
      min_dr     INTEGER,
      session_id TEXT,
      active     INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Database ready');
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: YOUR_DOMAIN }));
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.static(path.join(__dirname)));

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────
const PRODUCTS = {
  domain_report:  { amount: 299, name: 'Full Domain Intelligence Report' },
  weekly_list:    { amount: 499, name: 'Curated Weekly Expired Domain List' },
  niche_search:   { amount: 199, name: 'Niche Deep Search' },
  expiry_alert:   { amount: 99,  name: 'Domain Expiry Alert' },
  domain_compare: { amount: 399, name: 'Side-by-Side Domain Comparison' },
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.get('/api/stats', async (req, res) => {
  try {
    const total   = await pool.query('SELECT COUNT(*) as c FROM domains');
    const today   = await pool.query("SELECT COUNT(*) as c FROM domains WHERE DATE(created_at) = CURRENT_DATE");
    const avg_dr  = await pool.query('SELECT ROUND(AVG(dr)) as avg FROM domains WHERE scored=1 AND dr>0');
    res.json({
      total:   parseInt(total.rows[0].c),
      today:   parseInt(today.rows[0].c),
      avg_dr:  parseInt(avg_dr.rows[0].avg) || 0,
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/domains', async (req, res) => {
  const { niche='', min_dr=0, sort='dr', keyword='', limit=50 } = req.query;
  let query  = 'SELECT name,niche,dr,backlinks,traffic,age_years,expired_at,reason,wayback_url,scored FROM domains WHERE dr>=$1';
  const params = [parseInt(min_dr)||0];
  let idx = 2;
  if(niche)  { query += ` AND niche=$${idx++}`;                    params.push(niche); }
  if(keyword){ query += ` AND (name ILIKE $${idx} OR niche ILIKE $${idx++})`; params.push(`%${keyword}%`); }
  if(sort==='backlinks')    query += ' ORDER BY scored DESC, backlinks DESC';
  else if(sort==='traffic') query += ' ORDER BY scored DESC, traffic DESC';
  else                      query += ' ORDER BY scored DESC, dr DESC';
  query += ` LIMIT $${idx}`;
  params.push(Math.min(parseInt(limit)||50, 200));
  try {
    const result = await pool.query(query, params);
    const domains = result.rows.map(r => ({
      ...r, age: r.age_years||1, expired: r.expired_at||'Recently', price: 2.99
    }));
    res.json({ domains });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { product_type, domain='', email, niche='', min_dr='' } = req.body;
    const product = PRODUCTS[product_type];
    if(!product) return res.status(400).json({ error: 'Invalid product' });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email||undefined,
      line_items: [{ price_data: { currency:'usd', product_data:{ name:product.name }, unit_amount:product.amount }, quantity:1 }],
      mode: 'payment',
      success_url: `${YOUR_DOMAIN}?success=true&domain=${encodeURIComponent(domain)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${YOUR_DOMAIN}?canceled=true`,
      metadata: { product_type, domain, niche, min_dr: String(min_dr) },
    });
    await pool.query('INSERT INTO purchases (session_id,domain,product_type,amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [session.id, domain, product_type, product.amount]);
    res.json({ url: session.url });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/verify-session', async (req, res) => {
  const { session_id } = req.query;
  const r = await pool.query('SELECT * FROM purchases WHERE session_id=$1', [session_id]);
  if(!r.rows.length) return res.status(404).json({ verified: false });
  res.json({ verified: r.rows[0].paid===1, domain: r.rows[0].domain });
});

app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = secret && sig ? stripe.webhooks.constructEvent(req.body, sig, secret) : JSON.parse(req.body.toString());
  } catch(err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  if(event.type === 'checkout.session.completed') {
    const s = event.data.object;
    await pool.query('UPDATE purchases SET paid=1, email=$1 WHERE session_id=$2', [s.customer_email||'', s.id]);
    console.log(`Payment confirmed: ${s.id}`);
  }
  res.json({ received: true });
});

app.get('/api/admin/stats', async (req, res) => {
  if(req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const rev = await pool.query("SELECT SUM(amount) as rev, COUNT(*) as cnt FROM purchases WHERE paid=1");
  res.json({ revenue: rev.rows[0] });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── START ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`DeadLink running → http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
