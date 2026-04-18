'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const cors = require('cors');
const db = require('./database');
const crypto = require('crypto');

// ── Password helpers ───────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
}
function makeHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}
function checkPassword(password, salt, storedHash) {
  return hashPassword(password, salt) === storedHash;
}

// ── Audit logger ──────────────────────────────────────────
function logAudit(action, details = {}) {
  const entry = db.audit.insert({
    timestamp: new Date().toISOString(),
    date: details.date || new Date().toISOString().split('T')[0],
    action,
    ...details
  });
  broadcast({ type: 'audit_updated', entry });
}

// ── Vote timers ───────────────────────────────────────────
const voteTimers = {};

function clearVoteTimer(date) {
  if (voteTimers[date]) { clearTimeout(voteTimers[date]); delete voteTimers[date]; }
}

function autoCloseVoting(date) {
  delete voteTimers[date];
  const session = db.session.findOne({ date });
  if (!session || session.state !== 'voting') return;
  let winning_place_id = null;
  const votes = db.votes.find({ date });
  if (votes.length > 0) {
    const counts = {};
    votes.forEach(v => { counts[v.place_id] = (counts[v.place_id] || 0) + 1; });
    winning_place_id = parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], 10);
  }
  db.session.update({ date }, { state: 'ordering', winning_place_id, winning_place_ids: winning_place_id ? [winning_place_id] : [], timer_end: null });
  broadcast({ type: 'session_updated', session: db.session.findOne({ date }) });
  autoSubmitPreOrders(date);
}

function armVoteTimer(date, timerEnd) {
  clearVoteTimer(date);
  const delay = new Date(timerEnd) - Date.now();
  if (delay <= 0) { autoCloseVoting(date); return; }
  voteTimers[date] = setTimeout(() => autoCloseVoting(date), delay);
}

// ── Server-side pre-order auto-submit ──────────────────────
// Called whenever the session transitions to 'ordering'.
// Mirrors the client-side autoSubmitFromPreOrder() logic so that
// users who are offline when voting closes still get their order saved.
function autoSubmitPreOrders(date) {
  const session = db.session.findOne({ date });
  if (!session || session.state !== 'ordering') return;

  const splitPids = Array.isArray(session.winning_place_ids) && session.winning_place_ids.length > 1
    ? session.winning_place_ids : [];

  const allPreorders = db.preorders.find({ date });

  // Group preorders by normalized colleague name
  const byUser = new Map();
  allPreorders.forEach(po => {
    const colleague_name = (po.colleague_name || '').trim();
    if (!colleague_name) return;
    if (!byUser.has(colleague_name)) byUser.set(colleague_name, []);
    byUser.get(colleague_name).push(po);
  });

  const created = [];

  byUser.forEach((userPreorders, colleague_name) => {
    // Skip if this user already has an order today
    if (db.orders.findOne({ colleague_name, date })) return;

    let pid = null;

    if (splitPids.length > 0) {
      // Split mode: find preorders for winning places that have content
      const candidates = splitPids
        .filter(id => {
          const po = userPreorders.find(p => p.place_id === id);
          return po && ((po.checks || []).length > 0 || (po.custom || '').trim());
        });
      if (candidates.length === 0) return; // no preorder for any winning place
      if (candidates.length > 1) return;   // ambiguous — let user choose manually
      pid = candidates[0];
    } else {
      pid = session.winning_place_id;
      if (!pid) return;
    }

    const po = userPreorders.find(p => p.place_id === pid);
    if (!po) return;

    const checks = po.checks || [];
    const custom = (po.custom || '').trim();
    const parts  = custom ? [...checks, custom] : checks;
    if (!parts.length) return;

    const order_text = parts.join(', ');
    db.orders.upsert(
      { colleague_name, date },
      { place_id: pid, order_text, created_at: new Date().toISOString() }
    );
    created.push({ colleague_name, place_id: pid, order_text });
  });

  if (created.length > 0) {
    const orders = db.orders.find({ date })
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
    broadcast({ type: 'orders_updated', date, orders });
    created.forEach(({ colleague_name, place_id, order_text }) => {
      const place_name_log = db.places.findOne({ id: place_id })?.name || '';
      logAudit('order_auto', { date, colleague_name, place_name: place_name_log, order_text });
    });
  }
}

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// ── Web UI fallback (no Electron needed) ─────────────────
// Open http://localhost:3000/admin  → Admin UI
// Open http://localhost:3000/client → Client UI
app.use('/admin',  express.static(path.join(__dirname, '..', 'admin-app',  'renderer')));
app.use('/client', express.static(path.join(__dirname, '..', 'client-app', 'renderer')));
app.get('/', (req, res) => res.redirect('/client'));

// ── WebSocket ─────────────────────────────────────────────

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on('connection', ws => {
  ws.on('error', err => console.error('WS error:', err));
});

// ── Places ────────────────────────────────────────────────

app.get('/api/places', (req, res) => {
  res.json(db.places.find().sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/places', (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const place = db.places.insert({ name: name.trim(), description: (description || '').trim() });
  broadcast({ type: 'places_updated' });
  res.status(201).json(place);
});

app.put('/api/places/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, description, max_dishes } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const changed = db.places.update({ id }, {
    name: name.trim(),
    description: (description || '').trim(),
    max_dishes: Math.max(0, parseInt(max_dishes, 10) || 0)
  });
  if (!changed) return res.status(404).json({ error: 'Place not found' });
  broadcast({ type: 'places_updated' });
  res.json(db.places.findOne({ id }));
});

app.patch('/api/places/:id/presets', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { presets } = req.body;
  if (!Array.isArray(presets)) return res.status(400).json({ error: 'presets must be an array' });
  const sanitized = presets.map(p => String(p).trim()).filter(p => p);
  const changed = db.places.update({ id }, { presets: sanitized });
  if (!changed) return res.status(404).json({ error: 'Place not found' });
  broadcast({ type: 'places_updated' });
  res.json(db.places.findOne({ id }));
});

app.delete('/api/places/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const changed = db.places.remove({ id });
  if (!changed) return res.status(404).json({ error: 'Place not found' });
  // Manual cascade
  db.menus.remove({ place_id: id });
  db.votes.remove({ place_id: id });
  broadcast({ type: 'places_updated' });
  res.json({ ok: true });
});

// ── Menus ─────────────────────────────────────────────────

app.get('/api/menus/:date', (req, res) => {
  const menus = db.menus.find({ date: req.params.date }).map(m => ({
    ...m,
    place_name: db.places.findOne({ id: m.place_id })?.name || ''
  }));
  res.json(menus);
});

app.post('/api/menus', (req, res) => {
  const { place_id, date, menu_text } = req.body;
  if (!place_id || !date) return res.status(400).json({ error: 'place_id and date are required' });
  db.menus.upsert(
    { place_id: parseInt(place_id, 10), date },
    { menu_text: (menu_text || '').trim() }
  );
  broadcast({ type: 'menus_updated', date });
  res.json({ ok: true });
});

app.delete('/api/menus/:date', (req, res) => {
  const date = req.params.date;
  db.menus.remove({ date });
  broadcast({ type: 'menus_updated', date });
  res.json({ ok: true });
});

// ── Session State ─────────────────────────────────────────

function getOrCreateSession(date) {
  let s = db.session.findOne({ date });
  if (!s) s = db.session.insert({ date, state: 'voting', winning_place_id: null, winning_place_ids: [] });
  return s;
}

app.get('/api/session/:date', (req, res) => {
  res.json(getOrCreateSession(req.params.date));
});

app.put('/api/session/:date', (req, res) => {
  const { state, winning_place_id, winning_place_ids } = req.body;
  if (!['voting', 'ordering', 'closed'].includes(state))
    return res.status(400).json({ error: 'Invalid state' });
  clearVoteTimer(req.params.date);
  getOrCreateSession(req.params.date);
  const ids = Array.isArray(winning_place_ids)
    ? winning_place_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id))
    : [];
  const singleId = ids.length === 1 ? ids[0] : (winning_place_id != null ? parseInt(winning_place_id, 10) : null);
  db.session.update(
    { date: req.params.date },
    { state, winning_place_id: singleId, winning_place_ids: ids, timer_end: null }
  );
  const session = db.session.findOne({ date: req.params.date });
  broadcast({ type: 'session_updated', session });
  if (state === 'ordering') autoSubmitPreOrders(req.params.date);
  const winning_place_names = ids.map(id => db.places.findOne({ id })?.name || String(id));
  logAudit('session_change', { date: req.params.date, state, winning_place_ids: ids, winning_place_names });
  res.json(session);
});

// ── Users / Auth ───────────────────────────────────────────

app.get('/api/users/exists/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name).trim();
  res.json({ exists: !!db.users.findOne({ name }) });
});

app.post('/api/users/register', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'name and password required' });
  if (db.users.findOne({ name: name.trim() })) return res.status(409).json({ error: 'User already exists' });
  const { salt, hash } = makeHash(password);
  db.users.insert({ name: name.trim(), salt, hash });
  res.json({ ok: true });
});

app.post('/api/users/login', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'name and password required' });
  const user = db.users.findOne({ name: name.trim() });
  if (!user) return res.status(401).json({ error: 'Utente non trovato' });
  if (!checkPassword(password, user.salt, user.hash)) return res.status(401).json({ error: 'Password errata' });
  res.json({ ok: true });
});

app.post('/api/users/change-password', (req, res) => {
  const { name, old_password, new_password } = req.body;
  if (!name?.trim() || !old_password || !new_password) return res.status(400).json({ error: 'Fields missing' });
  const user = db.users.findOne({ name: name.trim() });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (!checkPassword(old_password, user.salt, user.hash)) return res.status(401).json({ error: 'Password attuale errata' });
  const { salt, hash } = makeHash(new_password);
  db.users.update({ name: name.trim() }, { salt, hash });
  res.json({ ok: true });
});

// ── Vote Timer ───────────────────────────────────────────

app.post('/api/session/:date/timer', (req, res) => {
  const { minutes } = req.body;
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'minutes must be >= 1' });
  const session = getOrCreateSession(req.params.date);
  if (session.state !== 'voting') return res.status(400).json({ error: 'Not in voting state' });
  const timer_end = new Date(Date.now() + minutes * 60000).toISOString();
  db.session.update({ date: req.params.date }, { timer_end });
  armVoteTimer(req.params.date, timer_end);
  const updated = db.session.findOne({ date: req.params.date });
  broadcast({ type: 'session_updated', session: updated });
  res.json(updated);
});

app.delete('/api/session/:date/timer', (req, res) => {
  clearVoteTimer(req.params.date);
  db.session.update({ date: req.params.date }, { timer_end: null });
  const updated = db.session.findOne({ date: req.params.date });
  if (updated) broadcast({ type: 'session_updated', session: updated });
  res.json({ ok: true });
});

// ── Votes ─────────────────────────────────────────────────

app.get('/api/votes/:date', (req, res) => {
  const votes = db.votes.find({ date: req.params.date }).map(v => ({
    ...v,
    place_name: db.places.findOne({ id: v.place_id })?.name || ''
  }));
  res.json(votes);
});

app.post('/api/votes', (req, res) => {
  const { place_ids, colleague_name, date } = req.body;
  if (!Array.isArray(place_ids) || !place_ids.length || !colleague_name?.trim() || !date)
    return res.status(400).json({ error: 'place_ids (array), colleague_name, and date are required' });

  const session = getOrCreateSession(date);
  if (session.state !== 'voting')
    return res.status(400).json({ error: 'Voting is closed' });

  // Replace all existing votes for this user on this date
  const voted_at = new Date().toISOString();
  db.votes.remove({ colleague_name: colleague_name.trim(), date });
  place_ids.forEach(pid => {
    db.votes.insert({ colleague_name: colleague_name.trim(), date, place_id: parseInt(pid, 10), voted_at });
  });

  const votes = db.votes.find({ date }).map(v => ({
    ...v, place_name: db.places.findOne({ id: v.place_id })?.name || ''
  }));
  broadcast({ type: 'votes_updated', date, votes });
  const place_names = place_ids.map(pid => db.places.findOne({ id: parseInt(pid, 10) })?.name || String(pid));
  logAudit('vote', { date, colleague_name: colleague_name.trim(), place_ids: place_ids.map(id => parseInt(id, 10)), place_names });
  res.json({ ok: true });
});

// ── Pre-orders ────────────────────────────────────────────

app.get('/api/preorders/:date/:colleague_name', (req, res) => {
  const { date, colleague_name } = req.params;
  res.json(db.preorders.find({ date, colleague_name: decodeURIComponent(colleague_name) }));
});

app.put('/api/preorders/:date/:colleague_name/:place_id', (req, res) => {
  const { date, colleague_name, place_id } = req.params;
  const { checks, custom } = req.body;
  if (!Array.isArray(checks)) return res.status(400).json({ error: 'checks must be an array' });
  db.preorders.upsert(
    { date, colleague_name: decodeURIComponent(colleague_name), place_id: parseInt(place_id, 10) },
    { checks, custom: (custom || '').trim() }
  );
  res.json({ ok: true });
});

// ── Orders ────────────────────────────────────────────────

app.get('/api/orders/:date', (req, res) => {
  const orders = db.orders.find({ date: req.params.date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  res.json(orders);
});

app.post('/api/orders', (req, res) => {
  const { colleague_name, place_id, order_text, date } = req.body;
  if (!colleague_name?.trim() || !order_text?.trim() || !date)
    return res.status(400).json({ error: 'colleague_name, order_text, and date are required' });

  db.orders.upsert(
    { colleague_name: colleague_name.trim(), date },
    {
      place_id:   place_id ? parseInt(place_id, 10) : null,
      order_text: order_text.trim(),
      created_at: new Date().toISOString()
    }
  );

  const orders = db.orders.find({ date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'orders_updated', date, orders });
  const place_name_log = db.places.findOne({ id: place_id ? parseInt(place_id, 10) : null })?.name || '';
  logAudit('order', { date, colleague_name: colleague_name.trim(), place_name: place_name_log, order_text: order_text.trim() });
  res.json({ ok: true });
});

app.delete('/api/orders/:date', (req, res) => {
  const date = req.params.date;
  db.orders.remove({ date });
  broadcast({ type: 'orders_updated', date, orders: [] });
  logAudit('orders_cleared', { date });
  res.json({ ok: true });
});

app.delete('/api/orders/:date/:id', (req, res) => {
  const date = req.params.date;
  const id   = parseInt(req.params.id, 10);
  const order = db.orders.findOne({ id, date });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.orders.remove({ id, date });
  const orders = db.orders.find({ date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'orders_updated', date, orders });
  logAudit('order_deleted', { date, colleague_name: order.colleague_name });
  res.json({ ok: true });
});

// ── Asporto Orders ───────────────────────────────────────────────────────────

app.get('/api/asporto/:date', (req, res) => {
  const orders = db.asporto.find({ date: req.params.date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  res.json(orders);
});

app.post('/api/asporto', (req, res) => {
  const { colleague_name, place_id, order_text, date } = req.body;
  if (!colleague_name?.trim() || !order_text?.trim() || !date || !place_id)
    return res.status(400).json({ error: 'colleague_name, place_id, order_text, and date are required' });
  db.asporto.upsert(
    { colleague_name: colleague_name.trim(), date, place_id: parseInt(place_id, 10) },
    { order_text: order_text.trim(), created_at: new Date().toISOString() }
  );
  const orders = db.asporto.find({ date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'asporto_updated', date, orders });
  const asporto_place_name = db.places.findOne({ id: parseInt(place_id, 10) })?.name || '';
  logAudit('asporto_order', { date, colleague_name: colleague_name.trim(), place_name: asporto_place_name, order_text: order_text.trim() });
  res.json({ ok: true });
});

app.delete('/api/asporto/:date', (req, res) => {
  const date = req.params.date;
  db.asporto.remove({ date });
  broadcast({ type: 'asporto_updated', date, orders: [] });
  logAudit('asporto_cleared', { date });
  res.json({ ok: true });
});

app.delete('/api/asporto/:date/:id', (req, res) => {
  const date = req.params.date;
  const id   = parseInt(req.params.id, 10);
  const asporto = db.asporto.findOne({ id, date });
  if (!asporto) return res.status(404).json({ error: 'Asporto order not found' });
  db.asporto.remove({ id, date });
  const orders = db.asporto.find({ date })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'asporto_updated', date, orders });
  logAudit('asporto_deleted', { date, colleague_name: asporto.colleague_name });
  res.json({ ok: true });
});

// ── Force winner ──────────────────────────────────────────

app.patch('/api/session/:date/winner', (req, res) => {
  const { winning_place_id } = req.body;
  getOrCreateSession(req.params.date);
  const sid = winning_place_id ? parseInt(winning_place_id, 10) : null;
  db.session.update(
    { date: req.params.date },
    { winning_place_id: sid, winning_place_ids: sid ? [sid] : [] }
  );
  const session = db.session.findOne({ date: req.params.date });
  broadcast({ type: 'session_updated', session });
  res.json(session);
});

// ── Restore timers after restart ──────────────────────────
(function restoreTimers() {
  db.session.find().forEach(s => {
    if (s.state === 'voting' && s.timer_end) armVoteTimer(s.date, s.timer_end);
  });
})();

// ── Seed admin user ───────────────────────────────────────
(function seedAdmin() {
  if (!db.users.findOne({ name: 'admin' })) {
    const { salt, hash } = makeHash('admin');
    db.users.insert({ name: 'admin', salt, hash, isAdmin: true });
  }
})();

// ── Admin login ───────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const user = db.users.findOne({ name: 'admin' });
  if (!user || !checkPassword(password, user.salt, user.hash))
    return res.status(401).json({ error: 'Credenziali non valide' });
  res.json({ ok: true });
});

// ── Admin user management ─────────────────────────────────

// List all users (strips sensitive fields)
app.get('/api/admin/users', (req, res) => {
  const list = db.users.find().map(({ id, name, isAdmin }) => ({ id, name, isAdmin: !!isAdmin }));
  res.json(list);
});

// Delete a user (cannot delete admin)
app.delete('/api/admin/users/:name', (req, res) => {
  const name = req.params.name;
  if (name === 'admin') return res.status(403).json({ error: 'Cannot delete admin user' });
  const removed = db.users.remove({ name });
  if (!removed) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// Reset a user's password
app.post('/api/admin/users/:name/reset-password', (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  const user = db.users.findOne({ name: req.params.name });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { salt, hash } = makeHash(new_password);
  db.users.update({ name: req.params.name }, { salt, hash });
  res.json({ ok: true });
});

// ── Data export / import ────────────────────────────────────

// Export: places, menus, preorders, users (persistent config — not votes/orders/session)
app.get('/api/data/export', (req, res) => {
  const payload = {
    exportedAt: new Date().toISOString(),
    places:    db.places.find(),
    menus:     db.menus.find(),
    preorders: db.preorders.find(),
    users:     db.users.find(),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition',
    `attachment; filename="listapranzo-backup-${new Date().toISOString().split('T')[0]}.json"`);
  res.json(payload);
});

// Import: restore places, menus, preorders, users from a backup file
app.post('/api/data/import', (req, res) => {
  const { places, menus, preorders, users } = req.body;
  if (!Array.isArray(places) || !Array.isArray(menus) || !Array.isArray(users))
    return res.status(400).json({ error: 'Invalid backup: places, menus and users arrays required' });

  // ── Places
  db.places.rows = [];
  db.places.seq  = 1;
  places.forEach(p => {
    db.places.rows.push(p);
    if (p.id >= db.places.seq) db.places.seq = p.id + 1;
  });
  db.places._save();

  // ── Menus
  db.menus.rows = [];
  db.menus.seq  = 1;
  menus.forEach(m => {
    db.menus.rows.push(m);
    if (m.id >= db.menus.seq) db.menus.seq = m.id + 1;
  });
  db.menus._save();

  // ── Preorders (optional in older backups)
  if (Array.isArray(preorders)) {
    db.preorders.rows = [];
    db.preorders.seq  = 1;
    preorders.forEach(p => {
      db.preorders.rows.push(p);
      if (p.id >= db.preorders.seq) db.preorders.seq = p.id + 1;
    });
    db.preorders._save();
  }

  // ── Users (preserve existing admin if not in backup)
  const importedNames = new Set(users.map(u => u.name));
  const existingAdmin = db.users.findOne({ name: 'admin' });
  db.users.rows = [];
  db.users.seq  = 1;
  users.forEach(u => {
    db.users.rows.push(u);
    if (u.id >= db.users.seq) db.users.seq = u.id + 1;
  });
  // Keep existing admin if not in backup (avoid lockout)
  if (existingAdmin && !importedNames.has('admin')) {
    db.users.rows.push(existingAdmin);
  }
  db.users._save();

  broadcast({ type: 'places_updated' });
  res.json({ ok: true, imported: { places: places.length, menus: menus.length, users: users.length } });
});

// ── Clear votes ───────────────────────────────────────────

app.delete('/api/votes/:date', (req, res) => {
  const date = req.params.date;
  db.votes.remove({ date });
  clearVoteTimer(date);
  const session = db.session.findOne({ date });
  if (session) {
    db.session.update({ date }, { state: 'voting', winning_place_id: null, winning_place_ids: [], timer_end: null });
  } else {
    db.session.insert({ date, state: 'voting', winning_place_id: null, winning_place_ids: [], timer_end: null });
  }
  const updated = db.session.findOne({ date });
  broadcast({ type: 'votes_updated', date, votes: [] });
  broadcast({ type: 'session_updated', session: updated });
  logAudit('votes_cleared', { date });
  res.json({ ok: true });
});

// ── Audit ─────────────────────────────────────────────────

app.get('/api/audit', (req, res) => {
  const { date } = req.query;
  const entries = date ? db.audit.find({ date }) : db.audit.find();
  res.json([...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
});

app.delete('/api/audit', (req, res) => {
  const date = req.query.date;
  if (date) {
    db.audit.remove({ date });
  } else {
    db.audit.remove({});
  }
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips = ['localhost'];
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  console.log('ListaPranzo backend listening on:');
  ips.forEach(ip => console.log(`  http://${ip}:${PORT}/admin    (Admin UI)`));
  ips.forEach(ip => console.log(`  http://${ip}:${PORT}/client   (Client UI)`));
  console.log(`WebSocket on ws://0.0.0.0:${PORT}`);
});
