// ════════════════════════════════════════════════════════════════════════════
// server.js — DeadLink Economy Backend
// Deploy FREE on Render.com (render.com/free)
// Stack: Node.js + Express + Stripe + SQLite (no paid DB needed)
// ════════════════════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Database = require('better-sqlite3');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

const app        = express();
const PORT       = process.env.PORT || 3000;
const YOUR_DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
// SQLite file lives alongside this script — persists on Render disk (free tier)
const db = new Database(path.join(__dirname, 'deadlink.db'));
db.exec('PRAGMA journal_mode=WAL'); // Better concurrent read/write

// Create tables if they don't exist yet.
// The `domains` table is also created and populated by crawler.py — this
// ensures the table exists even before the first crawl runs.
db.exec(`
  CREATE TABLE IF NOT EXISTS domains (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT UNIQUE,
    domain       TEXT,
    product_type TEXT,
    email        TEXT,
    amount       INTEGER,
    paid         INTEGER DEFAULT 0,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT,
    niche      TEXT,
    min_dr     INTEGER,
    session_id TEXT,
    active     INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_domains_niche  ON domains(niche);
  CREATE INDEX IF NOT EXISTS idx_domains_dr     ON domains(dr);
  CREATE INDEX IF NOT EXISTS idx_domains_scored ON domains(scored);
`);

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: YOUR_DOMAIN }));

// Stripe webhook MUST receive raw body — handle before express.json()
app.use((req, res, next) => {
  if(req.originalUrl === '/api/webhook'){
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Serve frontend static files (index.html, etc.) from the same directory
app.use(express.static(path.join(__dirname)));

// ─── PRODUCTS & PRICING ───────────────────────────────────────────────────────
const PRODUCTS = {
  domain_report:  { amount: 299, name: 'Full Domain Intelligence Report',  description: 'Complete backlink analysis, traffic history, and buy verdict' },
  weekly_list:    { amount: 499, name: 'Curated Weekly Expired Domain List', description: 'Top 50 expired domains this week, scored and niche-sorted' },
  niche_search:   { amount: 199, name: 'Niche Deep Search',                description: 'Filtered search results with full data unlocked' },
  expiry_alert:   { amount: 99,  name: 'Domain Expiry Alert',              description: 'Email notification when a qualifying domain expires' },
  domain_compare: { amount: 399, name: 'Side-by-Side Domain Comparison',   description: 'Compare two expired domains across all SEO metrics' },
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check — also used by Render to detect app is up
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0.0' });
});

// ── GET /api/stats — for hero section live counters ─────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const total   = db.prepare('SELECT COUNT(*) as c FROM domains').get().c;
    const today   = db.prepare("SELECT COUNT(*) as c FROM domains WHERE DATE(created_at) = DATE('now')").get().c;
    const avg_obj = db.prepare('SELECT ROUND(AVG(dr)) as avg FROM domains WHERE scored=1 AND dr>0').get();
    const avg_dr  = avg_obj ? (avg_obj.avg || 0) : 0;
    const high_dr = db.prepare('SELECT COUNT(*) as c FROM domains WHERE dr >= 50').get().c;
    res.json({ total, today, avg_dr, high_dr });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/domains — domain listing with filter/sort/search ───────────────
app.get('/api/domains', (req, res) => {
  const {
    niche   = '',
    min_dr  = 0,
    sort    = 'dr',
    keyword = '',
    limit   = 50,
  } = req.query;

  let query  = 'SELECT name, niche, dr, backlinks, traffic, age_years, expired_at, reason, wayback_url, scored FROM domains WHERE dr >= ?';
  const params = [parseInt(min_dr) || 0];

  if(niche){
    query += ' AND niche = ?';
    params.push(niche);
  }
  if(keyword){
    query += ' AND (name LIKE ? OR niche LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  // Prefer scored domains first, then sort by chosen metric
  if(sort === 'backlinks')    query += ' ORDER BY scored DESC, backlinks DESC';
  else if(sort === 'traffic') query += ' ORDER BY scored DESC, traffic DESC';
  else                        query += ' ORDER BY scored DESC, dr DESC';

  query += ' LIMIT ?';
  params.push(Math.min(parseInt(limit)||50, 200));

  try {
    const rows = db.prepare(query).all(...params);
    // Normalize field names so frontend works with both scored and unscored rows
    const domains = rows.map(r => ({
      name:       r.name,
      niche:      r.niche || 'General',
      dr:         r.dr || 0,
      backlinks:  r.backlinks || 0,
      traffic:    r.traffic || 0,
      age:        r.age_years || 1,
      age_years:  r.age_years || 1,
      expired:    r.expired_at || 'Recently',
      expired_at: r.expired_at || 'Recently',
      reason:     r.reason || 'Domain lapsed',
      wayback_url:r.wayback_url || null,
      price:      2.99,
    }));
    res.json({ domains, meta: { total: domains.length } });
  } catch(err){
    console.error('Domains query error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/create-checkout-session — initiates Stripe payment ─────────────
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { product_type, domain = '', email, niche = '', min_dr = '' } = req.body;
    const product = PRODUCTS[product_type];
    if(!product) return res.status(400).json({ error: `Unknown product type: ${product_type}` });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            description: domain ? `Full report for ${domain}` : product.description,
          },
          unit_amount: product.amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      // After payment, Stripe sends user back here with session_id
      success_url: `${YOUR_DOMAIN}?success=true&domain=${encodeURIComponent(domain)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${YOUR_DOMAIN}?canceled=true`,
      metadata: { product_type, domain, niche, min_dr: String(min_dr) },
    });

    // Log the pending purchase
    db.prepare(`
      INSERT OR IGNORE INTO purchases (session_id, domain, product_type, amount)
      VALUES (?, ?, ?, ?)
    `).run(session.id, domain, product_type, product.amount);

    res.json({ url: session.url });
  } catch(err){
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/verify-session — frontend calls this after Stripe redirect ───────
app.get('/api/verify-session', (req, res) => {
  const { session_id } = req.query;
  if(!session_id) return res.status(400).json({ verified: false });
  try {
    const row = db.prepare('SELECT * FROM purchases WHERE session_id = ?').get(session_id);
    if(!row) return res.status(404).json({ verified: false });
    res.json({
      verified:     row.paid === 1,
      domain:       row.domain,
      product_type: row.product_type,
    });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/webhook — Stripe calls this when payment is confirmed ───────────
// IMPORTANT: This must be registered BEFORE express.json() middleware,
// and it needs the raw body. The middleware block at the top handles this.
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // If no webhook secret configured, skip signature verification (dev mode)
  let event;
  if(webhookSecret && sig){
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch(err){
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    // Dev mode: trust the raw payload (never do this in production)
    try {
      event = JSON.parse(req.body.toString());
    } catch(err){
      return res.status(400).send('Invalid JSON');
    }
  }

  if(event.type === 'checkout.session.completed'){
    const session = event.data.object;
    const meta    = session.metadata || {};

    // Mark purchase as paid
    db.prepare('UPDATE purchases SET paid=1, email=? WHERE session_id=?')
      .run(session.customer_email || '', session.id);

    // If it was an alert purchase, activate the alert
    if(meta.product_type === 'expiry_alert'){
      db.prepare(`
        INSERT INTO alerts (email, niche, min_dr, session_id, active)
        VALUES (?, ?, ?, ?, 1)
      `).run(
        session.customer_email || '',
        meta.niche || '',
        parseInt(meta.min_dr) || 40,
        session.id
      );
      console.log(`Alert activated: ${session.customer_email} | ${meta.niche} DR${meta.min_dr}+`);
    }

    console.log(`✅ Payment confirmed: ${session.id} | $${(session.amount_total||0)/100} | ${meta.domain||meta.product_type}`);
  }

  res.json({ received: true });
});

// ── GET /api/admin/stats — revenue dashboard (protected by header key) ────────
app.get('/api/admin/stats', (req, res) => {
  const adminKey = process.env.ADMIN_KEY;
  if(adminKey && req.headers['x-admin-key'] !== adminKey){
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const revenue    = db.prepare("SELECT SUM(amount) as rev, COUNT(*) as cnt FROM purchases WHERE paid=1").get();
    const today      = db.prepare("SELECT SUM(amount) as rev, COUNT(*) as cnt FROM purchases WHERE paid=1 AND DATE(created_at)=DATE('now')").get();
    const by_product = db.prepare("SELECT product_type, COUNT(*) as cnt, SUM(amount) as rev FROM purchases WHERE paid=1 GROUP BY product_type ORDER BY rev DESC").all();
    const domains    = db.prepare("SELECT COUNT(*) as total, SUM(scored) as scored, ROUND(AVG(dr)) as avg_dr FROM domains WHERE dr>0").get();
    const alerts     = db.prepare("SELECT COUNT(*) as total, SUM(active) as active FROM alerts").get();
    res.json({ revenue, today, by_product, domains, alerts });
  } catch(err){
    res.status(500).json({ error: err.message });
  }
});

// ── Catch-all: serve frontend for any non-API route ─────────────────────────
// This makes the app work as a single-page app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🔗 DeadLink Economy running → http://localhost:${PORT}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY ? 'configured ✓' : 'NOT configured (demo mode)'}`);
  console.log(`   Domain: ${YOUR_DOMAIN}`);
});
