'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const cors = require('cors');
const db = require('./database');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// ── JWT config ─────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET || (() => {
  // Stable secret: derive from a fixed seed + machine info so restarts keep tokens valid
  const seed = process.env.JWT_SEED || 'listapranzo-default-seed';
  return crypto.createHash('sha256').update(seed).digest('hex');
})();
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

function generateToken(user) {
  const role = user.isAdmin ? 'admin' : (user.role || 'user');
  return jwt.sign(
    { sub: user.name, name: user.name, role, group_id: user.group_id || null, place_id: user.place_id || null },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ── JWT Middleware ─────────────────────────────────────────
// Reads Bearer token if present; sets req.authUser — never blocks
function optionalAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    try { req.authUser = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { /* invalid or expired — authUser stays undefined */ }
  }
  next();
}

// Requires a valid Bearer token
function requireAuth(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Token mancante o non valido' });
  next();
}

// Requires admin role via JWT
function requireAdmin(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Autenticazione richiesta' });
  if (req.authUser.role !== 'admin') return res.status(403).json({ error: 'Accesso admin richiesto' });
  next();
}

// Requires restaurant role via JWT
function requireRestaurant(req, res, next) {
  if (!req.authUser) return res.status(401).json({ error: 'Autenticazione richiesta' });
  if (req.authUser.role !== 'restaurant') return res.status(403).json({ error: 'Accesso ristoratore richiesto' });
  if (!req.authUser.place_id) return res.status(403).json({ error: 'Nessun ristorante associato all\u2019account' });
  next();
}

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
    date:      details.date || new Date().toISOString().split('T')[0],
    action,
    ...details
  });
  broadcast({ type: 'audit_updated', entry });
}

// ── Auth helper ────────────────────────────────────────────
function requireManager(manager_name, group_id, req) {
  // JWT auth takes priority when Bearer token is present
  if (req && req.authUser) {
    const u = req.authUser;
    if (u.role === 'admin') return null;
    if (u.role !== 'manager') return 'Non autorizzato';
    if (u.group_id !== group_id) return 'Non autorizzato per questo gruppo';
    return null;
  }
  // Legacy: manager_name in request body
  if (!manager_name) return 'manager_name mancante';
  const user = db.users.findOne({ name: manager_name });
  if (!user) return 'Utente non trovato';
  if (user.isAdmin || user.role === 'admin') return null;
  if (user.role !== 'manager') return 'Non autorizzato';
  if (user.group_id !== group_id) return 'Non autorizzato per questo gruppo';
  return null;
}

// ── Vote timers (per group) ────────────────────────────────
const voteTimers = {};

function timerKey(date, group_id) { return `${date}_${group_id}`; }

function clearVoteTimer(date, group_id) {
  const key = timerKey(date, group_id);
  if (voteTimers[key]) { clearTimeout(voteTimers[key]); delete voteTimers[key]; }
}

function autoCloseVoting(date, group_id) {
  delete voteTimers[timerKey(date, group_id)];
  const session = db.session.findOne({ date, group_id });
  if (!session || session.state !== 'voting') return;
  let winning_place_id = null;
  const votes = db.votes.find({ date, group_id });
  if (votes.length > 0) {
    const counts = {};
    votes.forEach(v => { counts[v.place_id] = (counts[v.place_id] || 0) + 1; });
    winning_place_id = parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0], 10);
  }
  db.session.update({ date, group_id }, {
    state: 'ordering', winning_place_id,
    winning_place_ids: winning_place_id ? [winning_place_id] : [],
    timer_end: null
  });
  broadcast({ type: 'session_updated', session: db.session.findOne({ date, group_id }) });
  autoSubmitPreOrders(date, group_id);
}

function armVoteTimer(date, group_id, timerEnd) {
  clearVoteTimer(date, group_id);
  const delay = new Date(timerEnd) - Date.now();
  if (delay <= 0) { autoCloseVoting(date, group_id); return; }
  voteTimers[timerKey(date, group_id)] = setTimeout(() => autoCloseVoting(date, group_id), delay);
}

// ── Server-side pre-order auto-submit ─────────────────────
function autoSubmitPreOrders(date, group_id) {
  const session = db.session.findOne({ date, group_id });
  if (!session || session.state !== 'ordering') return;
  const splitPids = Array.isArray(session.winning_place_ids) && session.winning_place_ids.length > 1
    ? session.winning_place_ids : [];
  const memberNames = new Set(db.users.find({ group_id }).map(u => u.name));
  const byUser = {};
  db.preorders.find({ date }).filter(po => memberNames.has(po.colleague_name)).forEach(po => {
    if (!byUser[po.colleague_name]) byUser[po.colleague_name] = [];
    byUser[po.colleague_name].push(po);
  });
  const created = [];
  Object.entries(byUser).forEach(([colleague_name, userPreorders]) => {
    if (db.orders.findOne({ colleague_name, date, group_id })) return;
    let pid = null;
    if (splitPids.length > 0) {
      const candidates = splitPids.filter(id => {
        const po = userPreorders.find(p => p.place_id === id);
        return po && ((po.checks || []).length > 0 || (po.custom || '').trim());
      });
      if (candidates.length === 0 || candidates.length > 1) return;
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
      { colleague_name, date, group_id },
      { place_id: pid, order_text, created_at: new Date().toISOString() }
    );
    created.push({ colleague_name, place_id: pid, order_text });
  });
  if (created.length > 0) {
    const orders = db.orders.find({ date, group_id })
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
      .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
    broadcast({ type: 'orders_updated', date, group_id, orders });
    created.forEach(({ colleague_name, place_id, order_text }) => {
      logAudit('order_auto', {
        date, group_id, colleague_name,
        place_name: db.places.findOne({ id: place_id })?.name || '',
        order_text
      });
    });
  }
}

// ── Express / WS ───────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(optionalAuth);   // sets req.authUser from Bearer token (non-blocking)
app.use('/admin',  express.static(path.join(__dirname, '..', 'admin-app',  'renderer')));
app.use('/client', express.static(path.join(__dirname, '..', 'client-app', 'renderer')));
app.get('/', (req, res) => res.redirect('/client'));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
wss.on('connection', ws => { ws.on('error', err => console.error('WS error:', err)); });

// ═══ AUTH (JWT) ═══════════════════════════════════════════
/**
 * POST /api/auth/login
 * Login for any user (admin, manager, user). Returns a signed JWT.
 * Body: { name, password }
 * Response: { token, name, role, group_id, group_name }
 */
app.post('/api/auth/login', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'name e password richiesti' });
  const user = db.users.findOne({ name: name.trim() });
  if (!user) return res.status(401).json({ error: 'Credenziali non valide' });
  if (!checkPassword(password, user.salt, user.hash)) return res.status(401).json({ error: 'Credenziali non valide' });
  const role  = user.isAdmin ? 'admin' : (user.role || 'user');
  const group = user.group_id ? db.groups.findOne({ id: user.group_id }) : null;
  res.json({
    token:      generateToken(user),
    name:       user.name,
    role,
    group_id:   user.group_id || null,
    group_name: group?.name || null
  });
});

/**
 * GET /api/auth/me
 * Returns the authenticated user's profile. Requires Bearer token.
 */
app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.users.findOne({ name: req.authUser.name });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  const role  = user.isAdmin ? 'admin' : (user.role || 'user');
  const group = user.group_id ? db.groups.findOne({ id: user.group_id }) : null;
  res.json({
    name:       user.name,
    role,
    group_id:   user.group_id || null,
    group_name: group?.name || null
  });
});

// ═══ PLACES (global) ══════════════════════════════════════
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
    name: name.trim(), description: (description || '').trim(),
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
  if (!db.places.update({ id }, { presets: sanitized }))
    return res.status(404).json({ error: 'Place not found' });
  broadcast({ type: 'places_updated' });
  res.json(db.places.findOne({ id }));
});
app.delete('/api/places/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.places.remove({ id })) return res.status(404).json({ error: 'Place not found' });
  db.menus.remove({ place_id: id });
  db.votes.remove({ place_id: id });
  broadcast({ type: 'places_updated' });
  res.json({ ok: true });
});

// ═══ MENUS (global) ═══════════════════════════════════════
app.get('/api/menus/:date', (req, res) => {
  res.json(db.menus.find({ date: req.params.date }).map(m => ({
    ...m, place_name: db.places.findOne({ id: m.place_id })?.name || ''
  })));
});
app.post('/api/menus', (req, res) => {
  const { place_id, date, menu_text } = req.body;
  if (!place_id || !date) return res.status(400).json({ error: 'place_id and date are required' });
  db.menus.upsert({ place_id: parseInt(place_id, 10), date }, { menu_text: (menu_text || '').trim() });
  broadcast({ type: 'menus_updated', date });
  res.json({ ok: true });
});
app.delete('/api/menus/:date', (req, res) => {
  db.menus.remove({ date: req.params.date });
  broadcast({ type: 'menus_updated', date: req.params.date });
  res.json({ ok: true });
});

// ═══ USER AUTH ════════════════════════════════════════════
function getUserInfo(name) {
  const user = db.users.findOne({ name });
  if (!user) return null;
  const role  = user.isAdmin ? 'admin' : (user.role || 'user');
  const group = user.group_id ? db.groups.findOne({ id: user.group_id }) : null;
  const place = (role === 'restaurant' && user.place_id) ? db.places.findOne({ id: user.place_id }) : null;
  return {
    name: user.name, role,
    group_id: user.group_id || null, group_name: group?.name || null,
    place_id: user.place_id || null, place_name: place?.name || null
  };
}
app.get('/api/users/exists/:name', (req, res) => {
  res.json({ exists: !!db.users.findOne({ name: decodeURIComponent(req.params.name).trim() }) });
});
app.get('/api/users/me/:name', (req, res) => {
  const info = getUserInfo(decodeURIComponent(req.params.name).trim());
  if (!info) return res.status(404).json({ error: 'Utente non trovato' });
  res.json(info);
});
app.post('/api/users/register', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'name and password required' });
  if (db.users.findOne({ name: name.trim() })) return res.status(409).json({ error: 'User already exists' });
  const { salt, hash } = makeHash(password);
  db.users.insert({ name: name.trim(), salt, hash, role: 'user', group_id: null });
  res.json({ ok: true });
});
app.post('/api/users/login', (req, res) => {
  const { name, password } = req.body;
  if (!name?.trim() || !password) return res.status(400).json({ error: 'name and password required' });
  const user = db.users.findOne({ name: name.trim() });
  if (!user) return res.status(401).json({ error: 'Utente non trovato' });
  if (!checkPassword(password, user.salt, user.hash)) return res.status(401).json({ error: 'Password errata' });
  const info = getUserInfo(name.trim());
  res.json({ ok: true, ...info, token: generateToken(user) });
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

// ═══ GROUPS ═══════════════════════════════════════════════
app.get('/api/groups', (req, res) => {
  res.json(db.groups.find().map(g => ({
    ...g, member_count: db.users.find({ group_id: g.id }).length
  })));
});
app.get('/api/groups/:gid/members', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  res.json(db.users.find({ group_id }).map(({ id, name, role }) => ({ id, name, role })));
});
app.post('/api/groups/:gid/members', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { user_name, manager_name } = req.body;
  if (!user_name?.trim()) return res.status(400).json({ error: 'user_name required' });
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const group = db.groups.findOne({ id: group_id });
  if (!group) return res.status(404).json({ error: 'Gruppo non trovato' });
  const user = db.users.findOne({ name: user_name.trim() });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (user.group_id) return res.status(409).json({ error: `Utente già nel gruppo "${db.groups.findOne({id:user.group_id})?.name}"` });
  db.users.update({ name: user_name.trim() }, { group_id, role: 'user' });
  broadcast({ type: 'group_updated', group_id });
  logAudit('member_added', { group_id, group_name: group.name, user_name: user_name.trim() });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/members/:uname', (req, res) => {
  const group_id  = parseInt(req.params.gid, 10);
  const user_name = decodeURIComponent(req.params.uname);
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const user = db.users.findOne({ name: user_name, group_id });
  if (!user) return res.status(404).json({ error: 'Utente non trovato nel gruppo' });
  // Prevent removing the last manager
  if (user.role === 'manager') {
    const managerCount = db.users.find({ group_id, role: 'manager' }).length;
    if (managerCount <= 1) return res.status(400).json({ error: 'Non puoi rimuovere l\'unico manager del gruppo' });
  }
  db.users.update({ name: user_name }, { group_id: null, role: 'user' });
  broadcast({ type: 'group_updated', group_id });
  logAudit('member_removed', { group_id, user_name });
  res.json({ ok: true });
});
// Manager promotes/demotes a member within their group
app.put('/api/groups/:gid/members/:uname/role', (req, res) => {
  const group_id  = parseInt(req.params.gid, 10);
  const user_name = decodeURIComponent(req.params.uname);
  const { role, manager_name } = req.body;
  if (!['manager', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be manager or user' });
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const user = db.users.findOne({ name: user_name, group_id });
  if (!user) return res.status(404).json({ error: 'Utente non trovato nel gruppo' });
  if (role === 'user') {
    const managerCount = db.users.find({ group_id, role: 'manager' }).length;
    if (managerCount <= 1) return res.status(400).json({ error: 'Deve esserci almeno un manager nel gruppo' });
  }
  db.users.update({ name: user_name, group_id }, { role });
  broadcast({ type: 'group_updated', group_id });
  logAudit('role_changed', { group_id, user_name, role, changed_by: manager_name });
  res.json({ ok: true });
});

// ═══ GROUP REQUESTS (user requests to create group + become manager) ══
app.post('/api/group-requests', (req, res) => {
  const { user_name, group_name } = req.body;
  if (!user_name?.trim() || !group_name?.trim())
    return res.status(400).json({ error: 'user_name e group_name sono richiesti' });
  const user = db.users.findOne({ name: user_name.trim() });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (user.group_id) return res.status(409).json({ error: 'Sei già in un gruppo' });
  if (db.group_requests.findOne({ user_name: user_name.trim(), status: 'pending' }))
    return res.status(409).json({ error: 'Hai già una richiesta in attesa' });
  db.group_requests.insert({
    user_name: user_name.trim(), group_name: group_name.trim(),
    status: 'pending', created_at: new Date().toISOString()
  });
  broadcast({ type: 'group_request_created' });
  res.json({ ok: true });
});
app.get('/api/group-requests/my/:name', (req, res) => {
  const user_name = decodeURIComponent(req.params.name).trim();
  const reqs = db.group_requests.find({ user_name }).sort((a, b) => b.id - a.id);
  res.json(reqs[0] || null);
});

// ═══ JOIN REQUESTS (user requests to join existing group) ══
app.post('/api/groups/:gid/join-requests', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { user_name } = req.body;
  if (!user_name?.trim()) return res.status(400).json({ error: 'user_name required' });
  const user = db.users.findOne({ name: user_name.trim() });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (user.group_id) return res.status(409).json({ error: 'Sei già in un gruppo' });
  const group = db.groups.findOne({ id: group_id });
  if (!group) return res.status(404).json({ error: 'Gruppo non trovato' });
  if (db.join_requests.findOne({ user_name: user_name.trim(), group_id, status: 'pending' }))
    return res.status(409).json({ error: 'Richiesta già in attesa' });
  db.join_requests.insert({
    user_name: user_name.trim(), group_id, group_name: group.name,
    status: 'pending', created_at: new Date().toISOString()
  });
  broadcast({ type: 'join_request_created', group_id });
  res.json({ ok: true });
});
app.get('/api/groups/:gid/join-requests', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  res.json(db.join_requests.find({ group_id, status: 'pending' }));
});
app.put('/api/groups/:gid/join-requests/:rid/approve', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const rid = parseInt(req.params.rid, 10);
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const request = db.join_requests.findOne({ id: rid, group_id, status: 'pending' });
  if (!request) return res.status(404).json({ error: 'Richiesta non trovata' });
  const user = db.users.findOne({ name: request.user_name });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  if (user.group_id) return res.status(409).json({ error: 'Utente già in un gruppo' });
  db.users.update({ name: request.user_name }, { group_id, role: 'user' });
  db.join_requests.update({ id: rid }, { status: 'approved', reviewed_at: new Date().toISOString() });
  broadcast({ type: 'group_updated', group_id });
  broadcast({ type: 'join_request_updated', user_name: request.user_name, status: 'approved', group_id });
  logAudit('member_added', { group_id, group_name: request.group_name, user_name: request.user_name });
  res.json({ ok: true });
});
app.put('/api/groups/:gid/join-requests/:rid/reject', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const rid = parseInt(req.params.rid, 10);
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const request = db.join_requests.findOne({ id: rid, group_id, status: 'pending' });
  if (!request) return res.status(404).json({ error: 'Richiesta non trovata' });
  db.join_requests.update({ id: rid }, { status: 'rejected', reviewed_at: new Date().toISOString() });
  broadcast({ type: 'join_request_updated', user_name: request.user_name, status: 'rejected' });
  res.json({ ok: true });
});
app.get('/api/join-requests/my/:name', (req, res) => {
  const user_name = decodeURIComponent(req.params.name).trim();
  const reqs = db.join_requests.find({ user_name }).sort((a, b) => b.id - a.id);
  res.json(reqs[0] || null);
});

// ═══ GROUP SESSION ════════════════════════════════════════
function getOrCreateGroupSession(date, group_id) {
  let s = db.session.findOne({ date, group_id });
  if (!s) s = db.session.insert({
    date, group_id, state: 'voting',
    winning_place_id: null, winning_place_ids: [], timer_end: null
  });
  return s;
}
app.get('/api/groups/:gid/session/:date', (req, res) => {
  res.json(getOrCreateGroupSession(req.params.date, parseInt(req.params.gid, 10)));
});
app.put('/api/groups/:gid/session/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { state, winning_place_id, winning_place_ids, manager_name } = req.body;
  if (!['voting', 'ordering', 'closed'].includes(state))
    return res.status(400).json({ error: 'Invalid state' });
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  clearVoteTimer(req.params.date, group_id);
  getOrCreateGroupSession(req.params.date, group_id);
  const ids = Array.isArray(winning_place_ids)
    ? winning_place_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id)) : [];
  const singleId = ids.length === 1 ? ids[0] : (winning_place_id != null ? parseInt(winning_place_id, 10) : null);
  db.session.update({ date: req.params.date, group_id },
    { state, winning_place_id: singleId, winning_place_ids: ids, timer_end: null });
  const session = db.session.findOne({ date: req.params.date, group_id });
  broadcast({ type: 'session_updated', session });
  if (state === 'ordering') autoSubmitPreOrders(req.params.date, group_id);
  logAudit('session_change', {
    date: req.params.date, group_id,
    group_name: db.groups.findOne({ id: group_id })?.name,
    state, winning_place_ids: ids,
    winning_place_names: ids.map(id => db.places.findOne({ id })?.name || String(id))
  });
  res.json(session);
});
app.post('/api/groups/:gid/session/:date/timer', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { minutes, manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'minutes must be >= 1' });
  const session = getOrCreateGroupSession(req.params.date, group_id);
  if (session.state !== 'voting') return res.status(400).json({ error: 'Not in voting state' });
  const timer_end = new Date(Date.now() + minutes * 60000).toISOString();
  db.session.update({ date: req.params.date, group_id }, { timer_end });
  armVoteTimer(req.params.date, group_id, timer_end);
  const updated = db.session.findOne({ date: req.params.date, group_id });
  broadcast({ type: 'session_updated', session: updated });
  res.json(updated);
});
app.delete('/api/groups/:gid/session/:date/timer', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  clearVoteTimer(req.params.date, group_id);
  db.session.update({ date: req.params.date, group_id }, { timer_end: null });
  const updated = db.session.findOne({ date: req.params.date, group_id });
  if (updated) broadcast({ type: 'session_updated', session: updated });
  res.json({ ok: true });
});
app.patch('/api/groups/:gid/session/:date/winner', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { winning_place_id, manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const sid = winning_place_id ? parseInt(winning_place_id, 10) : null;
  db.session.update({ date: req.params.date, group_id },
    { winning_place_id: sid, winning_place_ids: sid ? [sid] : [] });
  const session = db.session.findOne({ date: req.params.date, group_id });
  broadcast({ type: 'session_updated', session });
  res.json(session);
});

// ═══ GROUP VOTES ══════════════════════════════════════════
app.get('/api/groups/:gid/votes/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  res.json(db.votes.find({ date: req.params.date, group_id }).map(v => ({
    ...v, place_name: db.places.findOne({ id: v.place_id })?.name || ''
  })));
});
app.post('/api/groups/:gid/votes', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { place_ids, colleague_name, date } = req.body;
  if (!Array.isArray(place_ids) || !place_ids.length || !colleague_name?.trim() || !date)
    return res.status(400).json({ error: 'place_ids, colleague_name e date sono richiesti' });
  const session = getOrCreateGroupSession(date, group_id);
  if (session.state !== 'voting') return res.status(400).json({ error: 'Votazione chiusa' });
  const voted_at = new Date().toISOString();
  db.votes.remove({ colleague_name: colleague_name.trim(), date, group_id });
  place_ids.forEach(pid => db.votes.insert({
    colleague_name: colleague_name.trim(), date, group_id,
    place_id: parseInt(pid, 10), voted_at
  }));
  const votes = db.votes.find({ date, group_id }).map(v => ({
    ...v, place_name: db.places.findOne({ id: v.place_id })?.name || ''
  }));
  broadcast({ type: 'votes_updated', date, group_id, votes });
  logAudit('vote', {
    date, group_id, colleague_name: colleague_name.trim(),
    place_ids: place_ids.map(id => parseInt(id, 10)),
    place_names: place_ids.map(pid => db.places.findOne({ id: parseInt(pid, 10) })?.name || String(pid))
  });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/votes/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { date } = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  db.votes.remove({ date, group_id });
  clearVoteTimer(date, group_id);
  const existing = db.session.findOne({ date, group_id });
  if (existing) db.session.update({ date, group_id }, { state: 'voting', winning_place_id: null, winning_place_ids: [], timer_end: null });
  else db.session.insert({ date, group_id, state: 'voting', winning_place_id: null, winning_place_ids: [], timer_end: null });
  broadcast({ type: 'votes_updated', date, group_id, votes: [] });
  broadcast({ type: 'session_updated', session: db.session.findOne({ date, group_id }) });
  logAudit('votes_cleared', { date, group_id });
  res.json({ ok: true });
});

// ═══ PRE-ORDERS (user-scoped, no group) ══════════════════
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

// ─── Lock / unlock orders ─────────────────────────────────
app.put('/api/groups/:gid/session/:date/lock-orders', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { date }  = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const session = db.session.findOne({ date, group_id });
  if (!session) return res.status(404).json({ error: 'Sessione non trovata' });
  const lockCount = typeof session.orders_lock_count === 'number' ? session.orders_lock_count
    : (session.orders_locked ? 1 : 0);
  db.session.update({ date, group_id }, { orders_lock_count: lockCount + 1 });
  const updated = db.session.findOne({ date, group_id });
  broadcast({ type: 'session_updated', session: updated });
  logAudit('orders_locked', { date, group_id, round: lockCount + 1 });
  res.json({ ok: true });
});

app.put('/api/groups/:gid/session/:date/unlock-orders', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { date }  = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const session = db.session.findOne({ date, group_id });
  if (!session) return res.status(404).json({ error: 'Sessione non trovata' });
  const lockCount = typeof session.orders_lock_count === 'number' ? session.orders_lock_count
    : (session.orders_locked ? 1 : 0);
  const newCount = Math.max(0, lockCount - 1);
  db.session.update({ date, group_id }, { orders_lock_count: newCount });
  const updated = db.session.findOne({ date, group_id });
  broadcast({ type: 'session_updated', session: updated });
  logAudit('orders_unlocked', { date, group_id });
  res.json({ ok: true });
});

// ═══ GROUP ORDERS ═════════════════════════════════════════
app.get('/api/groups/:gid/orders/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  res.json(db.orders.find({ date: req.params.date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' })));
});
app.post('/api/groups/:gid/orders', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { colleague_name, place_id, order_text, date } = req.body;
  if (!colleague_name?.trim() || !order_text?.trim() || !date)
    return res.status(400).json({ error: 'colleague_name, order_text e date richiesti' });
  const session = db.session.findOne({ date, group_id });
  const lockCount = typeof session?.orders_lock_count === 'number' ? session.orders_lock_count
    : (session?.orders_locked ? 1 : 0);
  db.orders.upsert(
    { colleague_name: colleague_name.trim(), date, group_id },
    { place_id: place_id ? parseInt(place_id, 10) : null, order_text: order_text.trim(),
      late_round: lockCount, is_late: lockCount > 0, created_at: new Date().toISOString() }
  );
  const orders = db.orders.find({ date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'orders_updated', date, group_id, orders });
  logAudit('order', {
    date, group_id, colleague_name: colleague_name.trim(),
    place_name: db.places.findOne({ id: place_id ? parseInt(place_id, 10) : null })?.name || '',
    order_text: order_text.trim()
  });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/orders/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { date } = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  db.orders.remove({ date, group_id });
  broadcast({ type: 'orders_updated', date, group_id, orders: [] });
  logAudit('orders_cleared', { date, group_id });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/orders/:date/:oid', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const id = parseInt(req.params.oid, 10);
  const { date } = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  const order = db.orders.findOne({ id, date, group_id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.orders.remove({ id, date, group_id });
  const orders = db.orders.find({ date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'orders_updated', date, group_id, orders });
  logAudit('order_deleted', { date, group_id, colleague_name: order.colleague_name });
  res.json({ ok: true });
});

// ═══ GROUP ASPORTO ════════════════════════════════════════
app.get('/api/groups/:gid/asporto/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  res.json(db.asporto.find({ date: req.params.date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' })));
});
app.post('/api/groups/:gid/asporto', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { colleague_name, place_id, order_text, date } = req.body;
  if (!colleague_name?.trim() || !order_text?.trim() || !date || !place_id)
    return res.status(400).json({ error: 'colleague_name, place_id, order_text e date richiesti' });
  db.asporto.upsert(
    { colleague_name: colleague_name.trim(), date, group_id, place_id: parseInt(place_id, 10) },
    { order_text: order_text.trim(), created_at: new Date().toISOString() }
  );
  const orders = db.asporto.find({ date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'asporto_updated', date, group_id, orders });
  logAudit('asporto_order', {
    date, group_id, colleague_name: colleague_name.trim(),
    place_name: db.places.findOne({ id: parseInt(place_id, 10) })?.name || '',
    order_text: order_text.trim()
  });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/asporto/:date', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { date } = req.params;
  const { manager_name } = req.body;
  const authErr = requireManager(manager_name, group_id, req);
  if (authErr) return res.status(403).json({ error: authErr });
  db.asporto.remove({ date, group_id });
  broadcast({ type: 'asporto_updated', date, group_id, orders: [] });
  logAudit('asporto_cleared', { date, group_id });
  res.json({ ok: true });
});
app.delete('/api/groups/:gid/asporto/:date/:aid', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const id = parseInt(req.params.aid, 10);
  const { date } = req.params;
  const { manager_name, colleague_name } = req.body;
  const order = db.asporto.findOne({ id, date, group_id });
  if (!order) return res.status(404).json({ error: 'Asporto order not found' });
  // Allow owner to delete their own order, or manager to delete any
  const isOwner = colleague_name && order.colleague_name === colleague_name;
  const isManager = manager_name && !requireManager(manager_name, group_id, req);
  if (!isOwner && !isManager) return res.status(403).json({ error: 'Non autorizzato' });
  db.asporto.remove({ id, date, group_id });
  const orders = db.asporto.find({ date, group_id })
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ ...o, place_name: db.places.findOne({ id: o.place_id })?.name || '' }));
  broadcast({ type: 'asporto_updated', date, group_id, orders });
  logAudit('asporto_deleted', { date, group_id, colleague_name: order.colleague_name });
  res.json({ ok: true });
});

// ═══ ADMIN ════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'password required' });
  const user = db.users.findOne({ name: 'admin' });
  if (!user || !checkPassword(password, user.salt, user.hash))
    return res.status(401).json({ error: 'Credenziali non valide' });
  res.json({ ok: true, token: generateToken(user) });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.users.find().map(u => {
    const group = u.group_id ? db.groups.findOne({ id: u.group_id }) : null;
    return { id: u.id, name: u.name, role: u.isAdmin ? 'admin' : (u.role || 'user'),
      isAdmin: !!u.isAdmin, group_id: u.group_id || null, group_name: group?.name || null };
  }));
});
app.delete('/api/admin/users/:name', requireAdmin, (req, res) => {
  const { name } = req.params;
  if (name === 'admin') return res.status(403).json({ error: 'Cannot delete admin user' });
  if (!db.users.remove({ name })) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});
app.post('/api/admin/users/:name/reset-password', requireAdmin, (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  const user = db.users.findOne({ name: req.params.name });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { salt, hash } = makeHash(new_password);
  db.users.update({ name: req.params.name }, { salt, hash });
  res.json({ ok: true });
});
app.get('/api/admin/groups', requireAdmin, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.json(db.groups.find().map(g => {
    const members = db.users.find({ group_id: g.id });
    const managers = members.filter(u => u.role === 'manager').map(u => u.name);
    const session = db.session.findOne({ date: today, group_id: g.id });
    return {
      ...g,
      manager_names: managers,
      manager_name: managers[0] || g.manager_name || '',
      member_count: members.length,
      members: members.map(({ id, name, role }) => ({ id, name, role })),
      today_session: session
        ? { state: session.state, winning_place_id: session.winning_place_id }
        : { state: 'voting', winning_place_id: null }
    };
  }));
});
app.post('/api/admin/groups', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const group = db.groups.insert({ name: name.trim(), manager_name: '', created_at: new Date().toISOString() });
  broadcast({ type: 'group_updated' });
  res.status(201).json(group);
});
app.put('/api/admin/groups/:gid', requireAdmin, (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const changed = db.groups.update({ id: group_id }, { name: name.trim() });
  if (!changed) return res.status(404).json({ error: 'Group not found' });
  broadcast({ type: 'group_updated' });
  res.json({ ok: true });
});
app.delete('/api/admin/groups/:gid', requireAdmin, (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  if (!db.groups.findOne({ id: group_id })) return res.status(404).json({ error: 'Group not found' });
  db.users.find({ group_id }).forEach(u => db.users.update({ name: u.name }, { group_id: null, role: 'user' }));
  db.groups.remove({ id: group_id });
  broadcast({ type: 'group_updated' });
  res.json({ ok: true });
});
app.post('/api/admin/groups/:gid/members', requireAdmin, (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { user_name } = req.body;
  if (!user_name?.trim()) return res.status(400).json({ error: 'user_name required' });
  const group = db.groups.findOne({ id: group_id });
  if (!group) return res.status(404).json({ error: 'Gruppo non trovato' });
  const user = db.users.findOne({ name: user_name.trim() });
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  db.users.update({ name: user_name.trim() }, { group_id, role: 'user' });
  broadcast({ type: 'group_updated', group_id });
  res.json({ ok: true });
});
app.delete('/api/admin/groups/:gid/members/:uname', requireAdmin, (req, res) => {
  const group_id  = parseInt(req.params.gid, 10);
  const user_name = decodeURIComponent(req.params.uname);
  const group     = db.groups.findOne({ id: group_id });
  if (!group) return res.status(404).json({ error: 'Gruppo non trovato' });
  const user = db.users.findOne({ name: user_name, group_id });
  if (!user) return res.status(404).json({ error: 'Utente non trovato nel gruppo' });
  // Prevent removing last manager
  if (user.role === 'manager') {
    const managerCount = db.users.find({ group_id, role: 'manager' }).length;
    if (managerCount <= 1) return res.status(400).json({ error: 'Non puoi rimuovere l\'unico manager del gruppo' });
  }
  db.users.update({ name: user_name }, { group_id: null, role: 'user' });
  broadcast({ type: 'group_updated', group_id });
  logAudit('member_removed', { group_id, user_name });
  res.json({ ok: true });
});
// Admin changes role of a group member
app.put('/api/admin/groups/:gid/members/:uname/role', requireAdmin, (req, res) => {
  const group_id  = parseInt(req.params.gid, 10);
  const user_name = decodeURIComponent(req.params.uname);
  const { role } = req.body;
  if (!['manager', 'user'].includes(role)) return res.status(400).json({ error: 'Role must be manager or user' });
  const user = db.users.findOne({ name: user_name, group_id });
  if (!user) return res.status(404).json({ error: 'Utente non trovato nel gruppo' });
  if (role === 'user') {
    const managerCount = db.users.find({ group_id, role: 'manager' }).length;
    if (managerCount <= 1) return res.status(400).json({ error: 'Deve esserci almeno un manager nel gruppo' });
  }
  db.users.update({ name: user_name, group_id }, { role });
  broadcast({ type: 'group_updated', group_id });
  logAudit('role_changed', { group_id, user_name, role });
  res.json({ ok: true });
});
app.get('/api/admin/group-requests', requireAdmin, (req, res) => {
  res.json(db.group_requests.find().sort((a, b) => b.id - a.id));
});
app.put('/api/admin/group-requests/:id/approve', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const request = db.group_requests.findOne({ id });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  const user = db.users.findOne({ name: request.user_name });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const group = db.groups.insert({
    name: request.group_name, manager_name: request.user_name,
    created_at: new Date().toISOString()
  });
  db.users.update({ name: request.user_name }, { role: 'manager', group_id: group.id });
  db.group_requests.update({ id }, { status: 'approved', reviewed_at: new Date().toISOString(), group_id: group.id });
  broadcast({ type: 'group_request_updated', user_name: request.user_name, status: 'approved', group_id: group.id });
  logAudit('group_created', { group_name: request.group_name, manager_name: request.user_name });
  res.json({ ok: true, group });
});
app.put('/api/admin/group-requests/:id/reject', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const request = db.group_requests.findOne({ id });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  db.group_requests.update({ id }, { status: 'rejected', reviewed_at: new Date().toISOString() });
  broadcast({ type: 'group_request_updated', user_name: request.user_name, status: 'rejected' });
  res.json({ ok: true });
});
app.get('/api/admin/sessions/:date', requireAdmin, (req, res) => {
  const { date } = req.params;
  res.json(db.groups.find().map(g => ({
    group: g,
    session: db.session.findOne({ date, group_id: g.id }) || { state: 'voting', winning_place_id: null, winning_place_ids: [] },
    vote_count:  db.votes.find({ date, group_id: g.id }).length,
    order_count: db.orders.find({ date, group_id: g.id }).length
  })));
});

// ═══ DATA EXPORT / IMPORT ═════════════════════════════════
app.get('/api/data/export', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition',
    `attachment; filename="listapranzo-backup-${new Date().toISOString().split('T')[0]}.json"`);
  res.json({
    exportedAt:     new Date().toISOString(),
    version:        2,
    places:         db.places.find(),
    menus:          db.menus.find(),
    preorders:      db.preorders.find(),
    users:          db.users.find(),
    groups:         db.groups.find(),
    group_requests: db.group_requests.find(),
    join_requests:  db.join_requests.find(),
    orders:         db.orders.find(),
    votes:          db.votes.find(),
    session:        db.session.find(),
    asporto:        db.asporto.find(),
    audit:          db.audit.find(),
  });
});
app.post('/api/data/import', (req, res) => {
  const { places, menus, preorders, users, groups,
          group_requests, join_requests, orders, votes, session, asporto, audit } = req.body;
  if (!Array.isArray(places) || !Array.isArray(menus) || !Array.isArray(users))
    return res.status(400).json({ error: 'Invalid backup' });
  const restore = (store, arr) => {
    store.rows = []; store.seq = 1;
    arr.forEach(r => { store.rows.push(r); if (r.id >= store.seq) store.seq = r.id + 1; });
    store._save();
  };
  restore(db.places, places); restore(db.menus, menus);
  if (Array.isArray(preorders))      restore(db.preorders,      preorders);
  if (Array.isArray(groups))         restore(db.groups,         groups);
  if (Array.isArray(group_requests)) restore(db.group_requests, group_requests);
  if (Array.isArray(join_requests))  restore(db.join_requests,  join_requests);
  if (Array.isArray(orders))         restore(db.orders,         orders);
  if (Array.isArray(votes))          restore(db.votes,          votes);
  if (Array.isArray(session))        restore(db.session,        session);
  if (Array.isArray(asporto))        restore(db.asporto,        asporto);
  if (Array.isArray(audit))          restore(db.audit,          audit);
  const importedNames = new Set(users.map(u => u.name));
  const existingAdmin = db.users.findOne({ name: 'admin' });
  restore(db.users, users);
  if (existingAdmin && !importedNames.has('admin')) { db.users.rows.push(existingAdmin); db.users._save(); }
  broadcast({ type: 'places_updated' });
  const counts = { places: places.length, menus: menus.length, users: users.length,
    groups: (groups||[]).length, orders: (orders||[]).length };
  res.json({ ok: true, imported: counts });
});

// ═══ AUDIT ════════════════════════════════════════════════
app.get('/api/audit', (req, res) => {
  const { date, group_id } = req.query;
  let entries = db.audit.find();
  if (date)     entries = entries.filter(e => e.date === date);
  if (group_id) entries = entries.filter(e => e.group_id === parseInt(group_id, 10));
  res.json([...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
});
app.delete('/api/audit', (req, res) => {
  const date = req.query.date;
  if (date) db.audit.remove({ date }); else db.audit.remove({});
  res.json({ ok: true });
});

// ═══ RESTAURANT ═══════════════════════════════════════════
app.get('/api/restaurant/me', requireRestaurant, (req, res) => {
  const place = db.places.findOne({ id: req.authUser.place_id });
  if (!place) return res.status(404).json({ error: 'Ristorante non trovato' });
  res.json({ name: req.authUser.name, place });
});

app.get('/api/restaurant/orders/:date', requireRestaurant, (req, res) => {
  const { date } = req.params;
  const placeId = req.authUser.place_id;
  const groupsMap = {};
  db.groups.find().forEach(g => { groupsMap[g.id] = g.name; });
  const orders = db.orders.find({ date }).filter(o => o.place_id === placeId);
  const byGroup = {};
  orders.forEach(o => {
    const gid = o.group_id;
    if (!byGroup[gid]) byGroup[gid] = { group_id: gid, group_name: groupsMap[gid] || `Gruppo ${gid}`, orders: [] };
    byGroup[gid].orders.push({
      id: o.id, colleague_name: o.colleague_name, order_text: o.order_text,
      late_round: o.late_round || 0, is_late: !!o.is_late, created_at: o.created_at
    });
  });
  // Sort each group's orders by creation time
  Object.values(byGroup).forEach(g => g.orders.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '')));
  res.json(Object.values(byGroup));
});

app.get('/api/restaurant/asporto/:date', requireRestaurant, (req, res) => {
  const { date } = req.params;
  const placeId = req.authUser.place_id;
  const orders = db.asporto.find({ date }).filter(o => o.place_id === placeId);
  res.json(orders
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map(o => ({ id: o.id, colleague_name: o.colleague_name, order_text: o.order_text, location: o.location || '', created_at: o.created_at })));
});

app.get('/api/restaurant/menus/:date', requireRestaurant, (req, res) => {
  const { date } = req.params;
  const placeId = req.authUser.place_id;
  const menu = db.menus.findOne({ date, place_id: placeId });
  res.json(menu || { place_id: placeId, date, menu_text: '' });
});

app.post('/api/restaurant/menus', requireRestaurant, (req, res) => {
  const { date, menu_text } = req.body;
  if (!date) return res.status(400).json({ error: 'date richiesta' });
  const placeId = req.authUser.place_id;
  const existing = db.menus.findOne({ date, place_id: placeId });
  if (existing) {
    db.menus.update({ date, place_id: placeId }, { menu_text: menu_text || '' });
  } else {
    db.menus.insert({ place_id: placeId, date, menu_text: menu_text || '' });
  }
  broadcast({ type: 'menus_updated', date, place_id: placeId });
  res.json({ ok: true });
});

// ═══ ADMIN: RESTAURANT ACCOUNTS ═══════════════════════════
app.get('/api/admin/restaurant-accounts', requireAdmin, (req, res) => {
  const accounts = db.users.find({ role: 'restaurant' }).map(u => {
    const place = u.place_id ? db.places.findOne({ id: u.place_id }) : null;
    return { name: u.name, place_id: u.place_id || null, place_name: place?.name || null };
  });
  res.json(accounts);
});

app.post('/api/admin/restaurant-accounts', requireAdmin, (req, res) => {
  const { name, password, place_id } = req.body;
  if (!name?.trim() || !password || !place_id)
    return res.status(400).json({ error: 'name, password e place_id richiesti' });
  const pid = parseInt(place_id, 10);
  if (!db.places.findOne({ id: pid })) return res.status(404).json({ error: 'Ristorante non trovato' });
  if (db.users.findOne({ name: name.trim() })) return res.status(409).json({ error: 'Nome già in uso' });
  const { salt, hash } = makeHash(password);
  const user = db.users.insert({ name: name.trim(), salt, hash, role: 'restaurant', group_id: null, place_id: pid });
  logAudit('restaurant_account_created', { user_name: user.name, place_id: pid });
  res.status(201).json({ ok: true, name: user.name, place_id: pid });
});

app.delete('/api/admin/restaurant-accounts/:name', requireAdmin, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const user = db.users.findOne({ name, role: 'restaurant' });
  if (!user) return res.status(404).json({ error: 'Account ristoratore non trovato' });
  db.users.remove({ name });
  logAudit('restaurant_account_deleted', { user_name: name });
  res.json({ ok: true });
});

// ═══ API DOCS ═════════════════════════════════════════════
const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'ListaPranzo API',
    version: '1.0.0',
    description: `REST API for ListaPranzo — a group lunch ordering application.

## Authentication
All endpoints (except login and registration) that need identity use a **Bearer JWT token**.

1. Call \`POST /api/auth/login\` with your credentials → receive a \`token\`
2. Include it in every request header:
   \`\`\`
   Authorization: Bearer <token>
   \`\`\`

## Roles
| Role | Description |
|------|-------------|
| \`admin\` | Full system access. Can manage users, groups, data. |
| \`manager\` | Can manage their group's session, orders, votes. |
| \`user\` | Regular member — can vote, order, manage preorders. |

## Legacy Support
Manager endpoints also accept \`manager_name\` in the request body (for backward compatibility with the web app). JWT tokens are the recommended approach for new integrations.`,
  },
  servers: [{ url: '/api', description: 'ListaPranzo server' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
    },
    schemas: {
      Error:      { type: 'object', properties: { error: { type: 'string' } } },
      Ok:         { type: 'object', properties: { ok: { type: 'boolean', example: true } } },
      User:       { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string', enum: ['admin','manager','user'] }, group_id: { type: 'integer', nullable: true }, group_name: { type: 'string', nullable: true } } },
      TokenResponse: { type: 'object', properties: { token: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, group_id: { type: 'integer', nullable: true }, group_name: { type: 'string', nullable: true } } },
      Place:      { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string' }, max_dishes: { type: 'integer' }, presets: { type: 'array', items: { type: 'string' } } } },
      Menu:       { type: 'object', properties: { id: { type: 'integer' }, place_id: { type: 'integer' }, place_name: { type: 'string' }, date: { type: 'string', format: 'date' }, menu_text: { type: 'string' } } },
      Group:      { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, member_count: { type: 'integer' } } },
      Member:     { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, role: { type: 'string', enum: ['manager','user'] } } },
      Session:    { type: 'object', properties: { id: { type: 'integer' }, date: { type: 'string' }, group_id: { type: 'integer' }, state: { type: 'string', enum: ['voting','ordering','closed'] }, winning_place_id: { type: 'integer', nullable: true }, winning_place_ids: { type: 'array', items: { type: 'integer' } }, timer_end: { type: 'string', nullable: true }, orders_lock_count: { type: 'integer' } } },
      Vote:       { type: 'object', properties: { id: { type: 'integer' }, colleague_name: { type: 'string' }, place_id: { type: 'integer' }, place_name: { type: 'string' }, date: { type: 'string' }, group_id: { type: 'integer' }, voted_at: { type: 'string' } } },
      Order:      { type: 'object', properties: { id: { type: 'integer' }, colleague_name: { type: 'string' }, place_id: { type: 'integer' }, place_name: { type: 'string' }, order_text: { type: 'string' }, date: { type: 'string' }, group_id: { type: 'integer' }, late_round: { type: 'integer' }, is_late: { type: 'boolean' }, created_at: { type: 'string' } } },
      Asporto:    { type: 'object', properties: { id: { type: 'integer' }, colleague_name: { type: 'string' }, place_id: { type: 'integer' }, place_name: { type: 'string' }, order_text: { type: 'string' }, date: { type: 'string' }, group_id: { type: 'integer' }, created_at: { type: 'string' } } },
      Preorder:   { type: 'object', properties: { id: { type: 'integer' }, colleague_name: { type: 'string' }, place_id: { type: 'integer' }, date: { type: 'string' }, checks: { type: 'array', items: { type: 'string' } }, custom: { type: 'string' } } },
      JoinRequest:{ type: 'object', properties: { id: { type: 'integer' }, user_name: { type: 'string' }, group_id: { type: 'integer' }, group_name: { type: 'string' }, status: { type: 'string', enum: ['pending','approved','rejected'] }, created_at: { type: 'string' } } },
      AuditEntry: { type: 'object', properties: { id: { type: 'integer' }, timestamp: { type: 'string' }, date: { type: 'string' }, action: { type: 'string' }, group_id: { type: 'integer' }, colleague_name: { type: 'string' } } }
    }
  },
  paths: {
    // ── Auth ──────────────────────────────────────────────
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Login — get JWT token',
        description: 'Authenticate with name + password. Returns a signed JWT valid for 30 days. Works for all roles: admin, manager, user.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','password'], properties: { name: { type: 'string', example: 'mario' }, password: { type: 'string', example: 'mypassword' } } } } } },
        responses: { 200: { description: 'Login successful', content: { 'application/json': { schema: { $ref: '#/components/schemas/TokenResponse' } } } }, 400: { description: 'Missing fields' }, 401: { description: 'Invalid credentials' } }
      }
    },
    '/auth/me': {
      get: {
        tags: ['Auth'], summary: 'Get current user', security: [{ bearerAuth: [] }],
        description: 'Returns the profile of the authenticated user.',
        responses: { 200: { description: 'User profile', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'Token missing or invalid' } }
      }
    },
    // ── Users ─────────────────────────────────────────────
    '/users/register': {
      post: {
        tags: ['Users'], summary: 'Register a new user',
        description: 'Creates a new user account with role `user`. After registration, users must request to join or create a group.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','password'], properties: { name: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { 200: { description: 'Registered', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } }, 409: { description: 'User already exists' } }
      }
    },
    '/users/login': {
      post: {
        tags: ['Users'], summary: 'Legacy login (no token)',
        description: 'Validates credentials and returns user info. **Prefer `/auth/login`** which returns a JWT token. This endpoint is kept for backward compatibility.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','password'], properties: { name: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } }, 401: { description: 'Invalid credentials' } }
      }
    },
    '/users/change-password': {
      post: {
        tags: ['Users'], summary: 'Change own password', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','old_password','new_password'], properties: { name: { type: 'string' }, old_password: { type: 'string' }, new_password: { type: 'string' } } } } } },
        responses: { 200: { description: 'Password changed' }, 401: { description: 'Wrong current password' } }
      }
    },
    // ── Places ────────────────────────────────────────────
    '/places': {
      get: {
        tags: ['Places'], summary: 'List all places (restaurants)',
        description: 'Returns all available restaurants/delivery places sorted by name.',
        responses: { 200: { description: 'List of places', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Place' } } } } } }
      },
      post: {
        tags: ['Places'], summary: 'Create a place', security: [{ bearerAuth: [] }],
        description: 'Admin only. Creates a new restaurant/place.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Place' } } } } }
      }
    },
    '/places/{id}': {
      put: {
        tags: ['Places'], summary: 'Update a place', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, max_dishes: { type: 'integer' } } } } } },
        responses: { 200: { description: 'Updated place', content: { 'application/json': { schema: { $ref: '#/components/schemas/Place' } } } } }
      },
      delete: {
        tags: ['Places'], summary: 'Delete a place', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Deleted' } }
      }
    },
    '/places/{id}/presets': {
      patch: {
        tags: ['Places'], summary: 'Set dish presets for a place', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['presets'], properties: { presets: { type: 'array', items: { type: 'string' }, example: ['Pizza Margherita','Pasta al pomodoro'] } } } } } },
        responses: { 200: { description: 'Updated place', content: { 'application/json': { schema: { $ref: '#/components/schemas/Place' } } } } }
      }
    },
    // ── Menus ─────────────────────────────────────────────
    '/menus/{date}': {
      get: {
        tags: ['Menus'], summary: 'Get menus for a date',
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date', example: '2026-04-26' } }],
        responses: { 200: { description: 'List of menus', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Menu' } } } } } }
      },
      delete: {
        tags: ['Menus'], summary: 'Delete all menus for a date', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'Deleted' } }
      }
    },
    '/menus': {
      post: {
        tags: ['Menus'], summary: 'Create or update a menu', security: [{ bearerAuth: [] }],
        description: 'Upserts the menu text for a specific place on a given date.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['place_id','date'], properties: { place_id: { type: 'integer' }, date: { type: 'string', format: 'date' }, menu_text: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK' } }
      }
    },
    // ── Groups ────────────────────────────────────────────
    '/groups': {
      get: {
        tags: ['Groups'], summary: 'List all groups',
        description: 'Returns all groups with their member count. Used to let users browse and request to join a group.',
        responses: { 200: { description: 'List of groups', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Group' } } } } } }
      }
    },
    '/groups/{gid}/members': {
      get: {
        tags: ['Groups'], summary: 'List group members', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Members', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Member' } } } } } }
      },
      post: {
        tags: ['Groups'], summary: 'Add member to group (manager)', security: [{ bearerAuth: [] }],
        description: 'Manager or admin only. Directly adds a user to the group (bypasses join request).',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_name'], properties: { user_name: { type: 'string' }, manager_name: { type: 'string', description: 'Legacy: manager name (not needed when using JWT)' } } } } } },
        responses: { 200: { description: 'Added' }, 403: { description: 'Not authorized' }, 409: { description: 'User already in a group' } }
      }
    },
    '/groups/{gid}/members/{uname}': {
      delete: {
        tags: ['Groups'], summary: 'Remove member from group (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'uname', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string', description: 'Legacy: not needed when using JWT' } } } } } },
        responses: { 200: { description: 'Removed' }, 400: { description: 'Cannot remove last manager' } }
      }
    },
    '/groups/{gid}/members/{uname}/role': {
      put: {
        tags: ['Groups'], summary: 'Change member role (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'uname', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['manager','user'] }, manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Role updated' } }
      }
    },
    // ── Group / Join Requests ─────────────────────────────
    '/group-requests': {
      post: {
        tags: ['Group Requests'], summary: 'Request to create a new group',
        description: 'User requests to create a new group and become its manager. Admin must approve.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_name','group_name'], properties: { user_name: { type: 'string' }, group_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Request submitted' }, 409: { description: 'Already in a group or pending request exists' } }
      }
    },
    '/group-requests/my/{name}': {
      get: {
        tags: ['Group Requests'], summary: 'Get my group creation request',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Request or null' } }
      }
    },
    '/groups/{gid}/join-requests': {
      get: {
        tags: ['Group Requests'], summary: 'List pending join requests (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Pending requests', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/JoinRequest' } } } } } }
      },
      post: {
        tags: ['Group Requests'], summary: 'Request to join a group',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_name'], properties: { user_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Request submitted' }, 409: { description: 'Already in a group or pending request' } }
      }
    },
    '/groups/{gid}/join-requests/{rid}/approve': {
      put: {
        tags: ['Group Requests'], summary: 'Approve a join request (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'rid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Approved' } }
      }
    },
    '/groups/{gid}/join-requests/{rid}/reject': {
      put: {
        tags: ['Group Requests'], summary: 'Reject a join request (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'rid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Rejected' } }
      }
    },
    '/join-requests/my/{name}': {
      get: {
        tags: ['Group Requests'], summary: 'Get my latest join request',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Request or null' } }
      }
    },
    // ── Session ───────────────────────────────────────────
    '/groups/{gid}/session/{date}': {
      get: {
        tags: ['Session'], summary: 'Get (or create) today\'s session',
        description: 'Returns the current session for the group on the given date. Creates a new `voting` session if none exists.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date', example: '2026-04-26' } }],
        responses: { 200: { description: 'Session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } } }
      },
      put: {
        tags: ['Session'], summary: 'Set session state (manager)', security: [{ bearerAuth: [] }],
        description: 'Transitions the session between `voting`, `ordering`, and `closed` states. When moving to `ordering`, `winning_place_ids` should be set.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['voting','ordering','closed'] }, winning_place_ids: { type: 'array', items: { type: 'integer' }, description: 'Set when moving to ordering state' }, manager_name: { type: 'string', description: 'Legacy' } } } } } },
        responses: { 200: { description: 'Updated session', content: { 'application/json': { schema: { $ref: '#/components/schemas/Session' } } } } }
      }
    },
    '/groups/{gid}/session/{date}/timer': {
      post: {
        tags: ['Session'], summary: 'Start a voting countdown timer (manager)', security: [{ bearerAuth: [] }],
        description: 'Starts a countdown. When it expires, voting closes automatically and the winning place is determined.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['minutes'], properties: { minutes: { type: 'integer', minimum: 1, example: 5 }, manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Session with timer_end set' } }
      },
      delete: {
        tags: ['Session'], summary: 'Cancel the voting timer (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Timer cancelled' } }
      }
    },
    '/groups/{gid}/session/{date}/lock-orders': {
      put: {
        tags: ['Session'], summary: 'Lock orders — start late-round (manager)', security: [{ bearerAuth: [] }],
        description: 'Increments `orders_lock_count`. New orders after this are stamped as late (`late_round > 0`). Call again to open another late round.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Orders locked' } }
      }
    },
    '/groups/{gid}/session/{date}/unlock-orders': {
      put: {
        tags: ['Session'], summary: 'Unlock orders (manager)', security: [{ bearerAuth: [] }],
        description: 'Decrements `orders_lock_count` (minimum 0). Allows normal (non-late) orders again.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Orders unlocked' } }
      }
    },
    // ── Votes ─────────────────────────────────────────────
    '/groups/{gid}/votes/{date}': {
      get: {
        tags: ['Votes'], summary: 'Get all votes for a date',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'Votes', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Vote' } } } } } }
      },
      delete: {
        tags: ['Votes'], summary: 'Clear all votes and reset session to voting (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Votes cleared' } }
      }
    },
    '/groups/{gid}/votes': {
      post: {
        tags: ['Votes'], summary: 'Cast vote(s) for a user', security: [{ bearerAuth: [] }],
        description: 'Upserts votes for a user. Pass multiple `place_ids` to vote for multiple places. Replaces any existing vote for this user on the same day.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['place_ids','colleague_name','date'], properties: { place_ids: { type: 'array', items: { type: 'integer' }, example: [1, 3] }, colleague_name: { type: 'string' }, date: { type: 'string', format: 'date' } } } } } },
        responses: { 200: { description: 'Vote recorded' }, 400: { description: 'Voting is closed' } }
      }
    },
    // ── Preorders ─────────────────────────────────────────
    '/preorders/{date}/{colleague_name}': {
      get: {
        tags: ['Preorders'], summary: 'Get preorders for a user on a date',
        description: 'Preorders are dish preferences per place that auto-submit as orders when the session moves to ordering.',
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }, { name: 'colleague_name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Preorders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Preorder' } } } } } }
      }
    },
    '/preorders/{date}/{colleague_name}/{place_id}': {
      put: {
        tags: ['Preorders'], summary: 'Save preorder for a user / place / date', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }, { name: 'colleague_name', in: 'path', required: true, schema: { type: 'string' } }, { name: 'place_id', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['checks'], properties: { checks: { type: 'array', items: { type: 'string' }, example: ['Pizza Margherita'] }, custom: { type: 'string', example: 'senza cipolla' } } } } } },
        responses: { 200: { description: 'Saved' } }
      }
    },
    // ── Orders ────────────────────────────────────────────
    '/groups/{gid}/orders/{date}': {
      get: {
        tags: ['Orders'], summary: 'Get all orders for a group on a date',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'Orders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } }
      },
      delete: {
        tags: ['Orders'], summary: 'Delete all orders for a group on a date (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Deleted' } }
      }
    },
    '/groups/{gid}/orders': {
      post: {
        tags: ['Orders'], summary: 'Place or update an order', security: [{ bearerAuth: [] }],
        description: 'Upserts an order for a user. If `orders_lock_count > 0`, the order is automatically stamped as a late order (`late_round` set to current lock count).',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['colleague_name','order_text','date'], properties: { colleague_name: { type: 'string' }, place_id: { type: 'integer' }, order_text: { type: 'string', example: 'Pizza Margherita, senza cipolla' }, date: { type: 'string', format: 'date' } } } } } },
        responses: { 200: { description: 'Order saved' } }
      }
    },
    '/groups/{gid}/orders/{date}/{oid}': {
      delete: {
        tags: ['Orders'], summary: 'Delete a single order (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }, { name: 'oid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Deleted' }, 404: { description: 'Order not found' } }
      }
    },
    // ── Asporto ───────────────────────────────────────────
    '/groups/{gid}/asporto/{date}': {
      get: {
        tags: ['Asporto'], summary: 'Get take-away orders for a group on a date',
        description: 'Asporto orders are independent take-away orders not tied to the group lunch.',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'Asporto orders', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Asporto' } } } } } }
      },
      delete: {
        tags: ['Asporto'], summary: 'Delete all asporto orders for a date (manager)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { manager_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Deleted' } }
      }
    },
    '/groups/{gid}/asporto': {
      post: {
        tags: ['Asporto'], summary: 'Place or update an asporto order', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['colleague_name','place_id','order_text','date'], properties: { colleague_name: { type: 'string' }, place_id: { type: 'integer' }, order_text: { type: 'string' }, date: { type: 'string', format: 'date' } } } } } },
        responses: { 200: { description: 'Saved' } }
      }
    },
    '/groups/{gid}/asporto/{date}/{aid}': {
      delete: {
        tags: ['Asporto'], summary: 'Delete a single asporto order', security: [{ bearerAuth: [] }],
        description: 'Can be called by the order owner (pass `colleague_name`) or by a manager (pass `manager_name`).',
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }, { name: 'aid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { colleague_name: { type: 'string', description: 'Pass this to delete your own order' }, manager_name: { type: 'string', description: 'Pass this to delete as manager' } } } } } },
        responses: { 200: { description: 'Deleted' }, 403: { description: 'Not authorized' } }
      }
    },
    // ── Admin ─────────────────────────────────────────────
    '/admin/login': {
      post: {
        tags: ['Admin'], summary: 'Admin login',
        description: 'Login with the admin password. Returns a JWT token. **Alternatively, use `POST /auth/login` with `name: "admin"`.**',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK + token', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, token: { type: 'string' } } } } } }, 401: { description: 'Wrong password' } }
      }
    },
    '/admin/users': {
      get: {
        tags: ['Admin'], summary: 'List all users', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'All users with group info' } }
      }
    },
    '/admin/users/{name}': {
      delete: {
        tags: ['Admin'], summary: 'Delete a user', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Deleted' }, 403: { description: 'Cannot delete admin' } }
      }
    },
    '/admin/users/{name}/reset-password': {
      post: {
        tags: ['Admin'], summary: 'Reset a user\'s password', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['new_password'], properties: { new_password: { type: 'string' } } } } } },
        responses: { 200: { description: 'Password reset' } }
      }
    },
    '/admin/groups': {
      get: {
        tags: ['Admin'], summary: 'List all groups with details', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Groups with members and today\'s session' } }
      },
      post: {
        tags: ['Admin'], summary: 'Create a group', security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { 201: { description: 'Created group' } }
      }
    },
    '/admin/groups/{gid}': {
      put: {
        tags: ['Admin'], summary: 'Rename a group', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Renamed' } }
      },
      delete: {
        tags: ['Admin'], summary: 'Delete a group', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Deleted' } }
      }
    },
    '/admin/groups/{gid}/members': {
      post: {
        tags: ['Admin'], summary: 'Add a user to a group (admin)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['user_name'], properties: { user_name: { type: 'string' } } } } } },
        responses: { 200: { description: 'Added' } }
      }
    },
    '/admin/groups/{gid}/members/{uname}': {
      delete: {
        tags: ['Admin'], summary: 'Remove a user from a group (admin)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'uname', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Removed' } }
      }
    },
    '/admin/groups/{gid}/members/{uname}/role': {
      put: {
        tags: ['Admin'], summary: 'Change a member\'s role (admin)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'gid', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'uname', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['role'], properties: { role: { type: 'string', enum: ['manager','user'] } } } } } },
        responses: { 200: { description: 'Role updated' } }
      }
    },
    '/admin/group-requests': {
      get: {
        tags: ['Admin'], summary: 'List all group creation requests', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Requests list' } }
      }
    },
    '/admin/group-requests/{id}/approve': {
      put: {
        tags: ['Admin'], summary: 'Approve a group creation request', security: [{ bearerAuth: [] }],
        description: 'Creates the group, assigns the user as manager.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Approved, group created' } }
      }
    },
    '/admin/group-requests/{id}/reject': {
      put: {
        tags: ['Admin'], summary: 'Reject a group creation request', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Rejected' } }
      }
    },
    '/admin/sessions/{date}': {
      get: {
        tags: ['Admin'], summary: 'Overview of all groups\' sessions for a date', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'date', in: 'path', required: true, schema: { type: 'string', format: 'date' } }],
        responses: { 200: { description: 'Sessions overview' } }
      }
    },
    // ── Data ──────────────────────────────────────────────
    '/data/export': {
      get: {
        tags: ['Data'], summary: 'Export full database backup (admin)', security: [{ bearerAuth: [] }],
        description: 'Returns a JSON file containing all data. Use to create backups.',
        responses: { 200: { description: 'JSON backup file', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    },
    '/data/import': {
      post: {
        tags: ['Data'], summary: 'Import a full database backup (admin)', security: [{ bearerAuth: [] }],
        description: '⚠️ Replaces ALL existing data with the backup contents.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Backup JSON produced by /data/export' } } } },
        responses: { 200: { description: 'Import successful', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, imported: { type: 'object' } } } } } } }
      }
    },
    // ── Audit ─────────────────────────────────────────────
    '/audit': {
      get: {
        tags: ['Audit'], summary: 'Get audit log entries', security: [{ bearerAuth: [] }],
        description: 'Returns audit events sorted by timestamp descending. Filter by date and/or group.',
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'group_id', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'Audit entries', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/AuditEntry' } } } } } }
      },
      delete: {
        tags: ['Audit'], summary: 'Clear audit log (admin)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'date', in: 'query', schema: { type: 'string', format: 'date', description: 'If omitted, clears all entries' } }],
        responses: { 200: { description: 'Cleared' } }
      }
    }
  },
  tags: [
    { name: 'Auth',           description: 'JWT authentication — login and token management' },
    { name: 'Users',          description: 'User registration, login and profile management' },
    { name: 'Places',         description: 'Restaurants and delivery places' },
    { name: 'Menus',          description: 'Daily menus per place' },
    { name: 'Groups',         description: 'User groups and membership management' },
    { name: 'Group Requests', description: 'Requests to create a group or join an existing one' },
    { name: 'Session',        description: 'Daily session lifecycle: voting → ordering → closed' },
    { name: 'Votes',          description: 'Vote for preferred restaurant(s)' },
    { name: 'Preorders',      description: 'Pre-set dish choices that auto-submit when ordering opens' },
    { name: 'Orders',         description: 'Lunch orders including late-round orders' },
    { name: 'Asporto',        description: 'Independent take-away orders' },
    { name: 'Admin',          description: 'System administration — requires admin role' },
    { name: 'Data',           description: 'Full database export/import' },
    { name: 'Audit',          description: 'Audit log of all relevant actions' }
  ]
};

// Serve OpenAPI spec
app.get('/api/docs.json', (req, res) => res.json(openApiSpec));

// Serve Swagger UI at /api/docs
app.get('/api/docs', (req, res) => {
  const specUrl = `${req.protocol}://${req.get('host')}/api/docs.json`;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ListaPranzo API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '${specUrl}',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
      persistAuthorization: true
    });
  </script>
</body>
</html>`);
});


(function restoreTimers() {
  db.session.find().forEach(s => {
    if (s.state === 'voting' && s.timer_end && s.group_id)
      armVoteTimer(s.date, s.group_id, s.timer_end);
  });
})();

(function seedAdmin() {
  const admin = db.users.findOne({ name: 'admin' });
  if (!admin) {
    const { salt, hash } = makeHash('admin');
    db.users.insert({ name: 'admin', salt, hash, isAdmin: true, role: 'admin', group_id: null });
  } else if (!admin.role) {
    db.users.update({ name: 'admin' }, { role: 'admin' });
  }
})();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  const ips  = ['localhost'];
  for (const iface of Object.values(nets))
    for (const addr of iface)
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
  console.log('\n🍽️  ListaPranzo avviato!\n');
  ips.forEach(ip => console.log(`   → http://${ip}:${PORT}`));
  console.log('\n   Admin: /admin   Client: /client\n');
});
