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
    date:      details.date || new Date().toISOString().split('T')[0],
    action,
    ...details
  });
  broadcast({ type: 'audit_updated', entry });
}

// ── Auth helper ────────────────────────────────────────────
function requireManager(manager_name, group_id) {
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
app.use('/admin',  express.static(path.join(__dirname, '..', 'admin-app',  'renderer')));
app.use('/client', express.static(path.join(__dirname, '..', 'client-app', 'renderer')));
app.get('/', (req, res) => res.redirect('/client'));

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
wss.on('connection', ws => { ws.on('error', err => console.error('WS error:', err)); });

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
  return { name: user.name, role, group_id: user.group_id || null, group_name: group?.name || null };
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
  res.json({ ok: true, ...getUserInfo(name.trim()) });
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  db.orders.upsert(
    { colleague_name: colleague_name.trim(), date, group_id },
    { place_id: place_id ? parseInt(place_id, 10) : null, order_text: order_text.trim(), created_at: new Date().toISOString() }
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const authErr = requireManager(manager_name, group_id);
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
  const order = db.asporto.findOne({ id, date, group_id });
  if (!order) return res.status(404).json({ error: 'Asporto order not found' });
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
  res.json({ ok: true });
});
app.get('/api/admin/users', (req, res) => {
  res.json(db.users.find().map(u => {
    const group = u.group_id ? db.groups.findOne({ id: u.group_id }) : null;
    return { id: u.id, name: u.name, role: u.isAdmin ? 'admin' : (u.role || 'user'),
      isAdmin: !!u.isAdmin, group_id: u.group_id || null, group_name: group?.name || null };
  }));
});
app.delete('/api/admin/users/:name', (req, res) => {
  const { name } = req.params;
  if (name === 'admin') return res.status(403).json({ error: 'Cannot delete admin user' });
  if (!db.users.remove({ name })) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});
app.post('/api/admin/users/:name/reset-password', (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: 'new_password required' });
  const user = db.users.findOne({ name: req.params.name });
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { salt, hash } = makeHash(new_password);
  db.users.update({ name: req.params.name }, { salt, hash });
  res.json({ ok: true });
});
app.get('/api/admin/groups', (req, res) => {
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
app.post('/api/admin/groups', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const group = db.groups.insert({ name: name.trim(), manager_name: '', created_at: new Date().toISOString() });
  broadcast({ type: 'group_updated' });
  res.status(201).json(group);
});
app.put('/api/admin/groups/:gid', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const changed = db.groups.update({ id: group_id }, { name: name.trim() });
  if (!changed) return res.status(404).json({ error: 'Group not found' });
  broadcast({ type: 'group_updated' });
  res.json({ ok: true });
});
app.delete('/api/admin/groups/:gid', (req, res) => {
  const group_id = parseInt(req.params.gid, 10);
  if (!db.groups.findOne({ id: group_id })) return res.status(404).json({ error: 'Group not found' });
  db.users.find({ group_id }).forEach(u => db.users.update({ name: u.name }, { group_id: null, role: 'user' }));
  db.groups.remove({ id: group_id });
  broadcast({ type: 'group_updated' });
  res.json({ ok: true });
});
app.post('/api/admin/groups/:gid/members', (req, res) => {
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
app.delete('/api/admin/groups/:gid/members/:uname', (req, res) => {
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
app.put('/api/admin/groups/:gid/members/:uname/role', (req, res) => {
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
app.get('/api/admin/group-requests', (req, res) => {
  res.json(db.group_requests.find().sort((a, b) => b.id - a.id));
});
app.put('/api/admin/group-requests/:id/approve', (req, res) => {
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
app.put('/api/admin/group-requests/:id/reject', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const request = db.group_requests.findOne({ id });
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });
  db.group_requests.update({ id }, { status: 'rejected', reviewed_at: new Date().toISOString() });
  broadcast({ type: 'group_request_updated', user_name: request.user_name, status: 'rejected' });
  res.json({ ok: true });
});
app.get('/api/admin/sessions/:date', (req, res) => {
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

// ═══ STARTUP ══════════════════════════════════════════════
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
