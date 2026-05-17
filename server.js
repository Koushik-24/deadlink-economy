// ════════════════════════════════════════════════════════════════════════════
// server.js — DeadLink Economy Backend
// Deploy FREE on Render.com
// Stack: Node.js 18 + Express + PostgreSQL (Supabase) + Stripe
// ════════════════════════════════════════════════════════════════════════════

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
      id           SERIAL PRIMARY KEY,
      name         TEXT UNIQUE NOT NULL,
      niche        TEXT,
      dr           INTEGER DEFAULT 0,
      opr_score    REAL DEFAULT 0,
      backlinks    INTEGER DEFAULT 0,
      traffic      INTEGER DEFAULT 0,
      age_years    INTEGER DEFAULT 0,
      expired_at   TEXT,
      reason       TEXT,
      status       TEXT DEFAULT 'expired',
      wayback_url  TEXT,
      first_seen   TEXT,
      last_seen    TEXT,
      scored       INTEGER DEFAULT 0,
      score_source TEXT DEFAULT 'estimated',
      created_at   TIMESTAMP DEFAULT NOW()
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

// Stripe webhook needs raw body — handle before express.json()
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    express.json()(req, res, next);
  }
});

// Serve static files (index.html etc.)
app.use(express.static(path.join(__dirname)));

// ─── PRODUCTS & PRICING ───────────────────────────────────────────────────────
const PRODUCTS = {
  domain_report:  { amount: 299, name: 'Full Domain Intelligence Report' },
  weekly_list:    { amount: 499, name: 'Curated Weekly Expired Domain List' },
  niche_search:   { amount: 199, name: 'Niche Deep Search' },
  expiry_alert:   { amount: 99,  name: 'Domain Expiry Alert' },
  domain_compare: { amount: 399, name: 'Side-by-Side Domain Comparison' },
};

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Platform stats — used by hero section counters
app.get('/api/stats', async (req, res) => {
  try {
    const total  = await pool.query('SELECT COUNT(*) as c FROM domains');
    const today  = await pool.query("SELECT COUNT(*) as c FROM domains WHERE DATE(created_at) = CURRENT_DATE");
    const avg_dr = await pool.query('SELECT ROUND(AVG(dr)) as avg FROM domains WHERE scored=1 AND dr>0');
    res.json({
      total:  parseInt(total.rows[0].c)       || 0,
      today:  parseInt(today.rows[0].c)       || 0,
      avg_dr: parseInt(avg_dr.rows[0].avg)    || 0,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Domain listing — supports keyword, niche, min_dr, sort, limit
app.get('/api/domains', async (req, res) => {
  const { niche='', min_dr=0, sort='dr', keyword='', limit=50 } = req.query;

  let query  = `SELECT name, niche, dr, opr_score, backlinks, traffic,
                       age_years, expired_at, reason, wayback_url,
                       scored, score_source
                FROM domains WHERE dr >= $1`;
  const params = [parseInt(min_dr) || 0];
  let idx = 2;

  if (niche) {
    query += ` AND niche = $${idx++}`;
    params.push(niche);
  }
  if (keyword) {
    query += ` AND (name ILIKE $${idx} OR niche ILIKE $${idx++})`;
    params.push(`%${keyword}%`);
  }

  if (sort === 'backlinks')    query += ' ORDER BY scored DESC, backlinks DESC';
  else if (sort === 'traffic') query += ' ORDER BY scored DESC, traffic DESC';
  else                         query += ' ORDER BY scored DESC, dr DESC';

  query += ` LIMIT $${idx}`;
  params.push(Math.min(parseInt(limit) || 50, 200));

  try {
    const result  = await pool.query(query, params);
    const domains = result.rows.map(r => ({
      ...r,
      age:          r.age_years    || 1,
      expired:      r.expired_at   || 'Recently',
      price:        2.99,
      opr_score:    r.opr_score    || 0,
      score_source: r.score_source || 'estimated',
    }));
    res.json({ domains });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Stripe Checkout session
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { product_type, domain = '', email, niche = '', min_dr = '' } = req.body;
    const product = PRODUCTS[product_type];
    if (!product) return res.status(400).json({ error: `Invalid product type: ${product_type}` });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: product.name },
          unit_amount: product.amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${YOUR_DOMAIN}?success=true&domain=${encodeURIComponent(domain)}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${YOUR_DOMAIN}?canceled=true`,
      metadata: { product_type, domain, niche, min_dr: String(min_dr) },
    });

    await pool.query(
      'INSERT INTO purchases (session_id, domain, product_type, amount) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [session.id, domain, product_type, product.amount]
    );

    res.json({ url: session.url });
  } catch(err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Verify Stripe session after redirect back from Stripe
app.get('/api/verify-session', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ verified: false });
  try {
    const r = await pool.query('SELECT * FROM purchases WHERE session_id = $1', [session_id]);
    if (!r.rows.length) return res.status(404).json({ verified: false });
    res.json({ verified: r.rows[0].paid === 1, domain: r.rows[0].domain });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — called by Stripe when payment confirmed
// IMPORTANT: must receive raw body for signature verification
app.post('/api/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = (secret && sig)
      ? stripe.webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString());
  } catch(err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s    = event.data.object;
    const meta = s.metadata || {};
    await pool.query(
      'UPDATE purchases SET paid=1, email=$1 WHERE session_id=$2',
      [s.customer_email || '', s.id]
    );
    // Activate alert if it was an alert purchase
    if (meta.product_type === 'expiry_alert') {
      await pool.query(
        'INSERT INTO alerts (email, niche, min_dr, session_id, active) VALUES ($1,$2,$3,$4,1)',
        [s.customer_email || '', meta.niche || '', parseInt(meta.min_dr) || 40, s.id]
      );
    }
    console.log(`Payment confirmed: ${s.id} | $${(s.amount_total || 0) / 100}`);
  }

  res.json({ received: true });
});

// Admin revenue dashboard — protected by x-admin-key header
app.get('/api/admin/stats', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const revenue    = await pool.query("SELECT SUM(amount) as rev, COUNT(*) as cnt FROM purchases WHERE paid=1");
    const today      = await pool.query("SELECT SUM(amount) as rev, COUNT(*) as cnt FROM purchases WHERE paid=1 AND DATE(created_at)=CURRENT_DATE");
    const by_product = await pool.query("SELECT product_type, COUNT(*) as cnt, SUM(amount) as rev FROM purchases WHERE paid=1 GROUP BY product_type ORDER BY rev DESC");
    const domains    = await pool.query("SELECT COUNT(*) as total, SUM(CASE WHEN scored=1 THEN 1 ELSE 0 END) as scored, ROUND(AVG(dr)) as avg_dr FROM domains WHERE dr>0");
    res.json({
      revenue:    revenue.rows[0],
      today:      today.rows[0],
      by_product: by_product.rows,
      domains:    domains.rows[0],
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SEO ROUTES ───────────────────────────────────────────────────────────────

// robots.txt — allows Google to crawl the site
// Render's default blocks crawlers on free subdomains — this overrides it
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(
    `User-agent: *\n` +
    `Allow: /\n` +
    `\n` +
    `Sitemap: ${YOUR_DOMAIN}/sitemap.xml`
  );
});

// sitemap.xml — tells Google what pages exist
app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.type('application/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `  <url>\n` +
    `    <loc>${YOUR_DOMAIN}/</loc>\n` +
    `    <changefreq>daily</changefreq>\n` +
    `    <priority>1.0</priority>\n` +
    `    <lastmod>${today}</lastmod>\n` +
    `  </url>\n` +
    `</urlset>`
  );
});

// ─── CATCH-ALL — serve frontend for all non-API routes ───────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`DeadLink running -> http://localhost:${PORT}`);
      console.log(`Stripe:   ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'NOT configured (demo mode)'}`);
      console.log(`Database: ${process.env.SUPABASE_DB_URL   ? 'configured' : 'NOT configured'}`);
      console.log(`Domain:   ${YOUR_DOMAIN}`);
    });
  })
  .catch(err => {
    console.error('DB init failed:', err.message);
    process.exit(1);
  });
