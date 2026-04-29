'use strict';

const API    = `${window.location.origin}/api`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

// ── State ─────────────────────────────────────────────────
let ws               = null;
let wsReconnectTimer = null;
let collegeName      = localStorage.getItem('collegeName') || '';
let userRole         = localStorage.getItem('userRole')   || 'user';  // 'admin'|'manager'|'user'|'restaurant'
let userGroupId      = parseInt(localStorage.getItem('userGroupId'), 10) || null;
let userGroupName    = localStorage.getItem('userGroupName') || '';
let userPlaceId      = parseInt(localStorage.getItem('userPlaceId'), 10) || null;
let userPlaceName    = localStorage.getItem('userPlaceName') || '';

let places           = [];
let menus            = [];
let sessionState     = { state: 'voting', winning_place_id: null, winning_place_ids: [] };
let selectedPlaceIds = new Set();
let hasVoted         = false;
let hasOrdered       = false;
let currentOrderText = '';
let selectedOrderPlaceId = null;
let allOrders        = [];
// loginStep kept for compatibility but no longer drives flow
let timerInterval    = null;
let preOrders        = {};
let allVotes         = [];
let asportoOrders    = [];
let myAsportoOrders  = [];
let asportoPrevScreen = 'voting';
let orderPrevScreen   = null;   // set to 'manager' when ordering is opened from manager screen
let mgrTimerInterval  = null;
let mgrJoinRequests   = [];
let mgrMembers        = [];
let mgrPendingCount   = 0;
let availableGroups   = [];
let lateRoundWATexts  = {};
let restaurantToken   = null;

const today = new Date().toISOString().split('T')[0];

// ── Lock-count helpers (backward compat with legacy orders_locked boolean) ────
function sessionLockCount() {
  if (typeof sessionState.orders_lock_count === 'number') return sessionState.orders_lock_count;
  return sessionState.orders_locked ? 1 : 0;
}
function orderLateRound(o) {
  if (typeof o.late_round === 'number') return o.late_round;
  return o.is_late ? 1 : 0;
}

// ── Helpers ───────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtTime(ts) {
  if (!ts) return '';
  try { return ` <small class="audit-time">${new Date(ts).toLocaleTimeString('it-IT', { hour:'2-digit', minute:'2-digit' })}</small>`; }
  catch (_) { return ''; }
}

async function apiFetch(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`Errore: ${err.error || res.statusText}`);
      return null;
    }
    return res.json();
  } catch (_) {
    return null;
  }
}

// Silent variant — returns { data, error } without showing a toast
async function apiFetchSilent(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`${API}${path}`, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { data: null, error: json.error || res.statusText };
    return { data: json, error: null };
  } catch (_) {
    return { data: null, error: 'Backend non raggiungibile.' };
  }
}

let toastTimer = null;
function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
  if (name === 'manager' && userRole === 'manager') {
    mgrPendingCount = 0;
    updateMgrNotification();
    document.getElementById('hdr-group-manager').textContent = userGroupName;
    renderManagerScreen();
  }
  if (name === 'restaurant') {
    document.getElementById('hdr-restaurant-name').textContent = collegeName;
    document.getElementById('hdr-place-name').textContent = userPlaceName;
    renderRestaurantScreen();
  }
}
function updateMgrNotification() {
  document.querySelectorAll('.btn-manager').forEach(btn => {
    let badge = btn.querySelector('.mgr-notif-badge');
    if (mgrPendingCount > 0) {
      if (!badge) { badge = document.createElement('span'); badge.className = 'mgr-notif-badge'; btn.appendChild(badge); }
      badge.textContent = mgrPendingCount;
    } else {
      badge?.remove();
    }
  });
}

function showBackendError() {
  showToast('Backend non raggiungibile. Assicurati che il server sia in esecuzione.', 5000);
}

// ── Init ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('today-label').textContent =
    new Date().toLocaleDateString('it-IT', { weekday:'long', day:'numeric', month:'long' });
  setInterval(() => {
    if (new Date().toISOString().split('T')[0] !== today) window.location.reload();
  }, 60000);

  // Login
  document.getElementById('login-btn').addEventListener('click', signIn);
  document.getElementById('register-btn').addEventListener('click', register);
  document.getElementById('btn-show-register').addEventListener('click', showRegisterForm);
  document.getElementById('btn-show-signin').addEventListener('click', showSignInForm);
  document.getElementById('login-name').addEventListener('keydown',     e => { if (e.key === 'Enter') signIn(); });
  document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') signIn(); });
  document.getElementById('reg-name').addEventListener('keydown',       e => { if (e.key === 'Enter') register(); });
  document.getElementById('reg-password').addEventListener('keydown',   e => { if (e.key === 'Enter') register(); });
  document.getElementById('reg-password2').addEventListener('keydown',  e => { if (e.key === 'Enter') register(); });

  // User controls
  document.getElementById('btn-change-name').addEventListener('click', changeName);
  document.getElementById('btn-change-name-setup').addEventListener('click', changeName);
  document.getElementById('btn-change-name-order').addEventListener('click', changeName);
  document.getElementById('btn-change-name-confirm').addEventListener('click', changeName);
  document.getElementById('btn-change-password').addEventListener('click', changePassword);

  // Voting
  document.getElementById('btn-submit-vote').addEventListener('click', submitVote);
  document.getElementById('btn-change-vote').addEventListener('click', changeVote);

  // Ordering
  document.getElementById('btn-submit-order').addEventListener('click', submitOrder);
  document.getElementById('btn-edit-order').addEventListener('click', editOrder);
  document.getElementById('btn-cancel-order').addEventListener('click', cancelOrder);

  // Manager button (all screens)
  ['btn-manager-vote','btn-manager-order','btn-manager-confirm'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () => showScreen('manager'))
  );
  document.getElementById('btn-back-manager').addEventListener('click', backFromManager);

  // Asporto
  ['btn-asporto-vote','btn-asporto-order','btn-asporto-confirm'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', showAsportoScreen)
  );
  document.getElementById('btn-back-asporto').addEventListener('click', backFromAsporto);
  document.getElementById('asporto-place-select').addEventListener('change', onAsportoPlaceChange);
  document.getElementById('btn-submit-asporto').addEventListener('click', submitAsportoOrder);
  document.getElementById('my-asporto-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="delete-asporto"]');
    if (btn) deleteMyAsportoOrder(parseInt(btn.dataset.id, 10));
  });

  // Split place picker
  document.getElementById('split-places-pick').addEventListener('click', e => {
    const btn = e.target.closest('.split-pick-btn');
    if (!btn) return;
    pickOrderPlace(parseInt(btn.dataset.placeId, 10));
  });

  // Place card events (voting)
  document.getElementById('places-list').addEventListener('click', e => {
    if (e.target.closest('.preorder-panel') || e.target.closest('.btn-preorder')) return;
    const card = e.target.closest('.place-card');
    if (card && !hasVoted) selectPlace(parseInt(card.dataset.placeId, 10));
  });
  document.getElementById('places-list').addEventListener('click', e => {
    const btn = e.target.closest('.btn-preorder');
    if (!btn) return;
    e.stopPropagation();
    const panel = document.getElementById(`preorder-panel-${btn.dataset.placeId}`);
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('places-list').addEventListener('change', e => {
    if (!e.target.closest('.preorder-panel')) return;
    const panel   = e.target.closest('.preorder-panel');
    const placeId = parseInt(panel.dataset.placeId, 10);
    const checks  = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    const custom  = panel.querySelector('.preorder-custom')?.value || '';
    savePreOrderForPlace(placeId, { checks, custom });
    const badge = document.getElementById(`preorder-badge-${placeId}`);
    if (badge) badge.style.display = checks.length || custom ? 'inline' : 'none';
  });
  document.getElementById('places-list').addEventListener('input', e => {
    if (!e.target.classList.contains('preorder-custom')) return;
    const panel   = e.target.closest('.preorder-panel');
    const placeId = parseInt(panel.dataset.placeId, 10);
    const checks  = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    savePreOrderForPlace(placeId, { checks, custom: e.target.value });
    const badge = document.getElementById(`preorder-badge-${placeId}`);
    if (badge) badge.style.display = checks.length || e.target.value ? 'inline' : 'none';
  });

  // Setup group screen
  document.getElementById('btn-request-group').addEventListener('click', requestNewGroup);
  document.getElementById('groups-list-setup').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="join-group"]');
    if (btn) requestJoinGroup(parseInt(btn.dataset.gid, 10));
  });
  document.getElementById('btn-cancel-group-request').addEventListener('click', cancelGroupRequest);
  document.getElementById('btn-cancel-join-request').addEventListener('click', cancelJoinRequest);
  document.getElementById('new-group-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') requestNewGroup();
  });

  // Manager dashboard
  document.getElementById('btn-mgr-close-voting').addEventListener('click',   mgrCloseVoting);
  document.getElementById('btn-mgr-reopen-voting').addEventListener('click',  mgrReopenVoting);
  document.getElementById('btn-mgr-clear-votes').addEventListener('click',    mgrClearVotes);
  document.getElementById('btn-mgr-force-split').addEventListener('click',    mgrForceSplit);
  document.getElementById('btn-mgr-change-winner').addEventListener('click',  mgrChangeWinner);
  document.getElementById('btn-mgr-close-session').addEventListener('click',  mgrCloseSession);
  document.getElementById('btn-mgr-start-timer').addEventListener('click',    mgrStartTimer);
  document.getElementById('btn-mgr-stop-timer').addEventListener('click',     mgrStopTimer);
  document.getElementById('btn-mgr-add-member').addEventListener('click',     mgrAddMember);
  document.getElementById('mgr-add-member-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') mgrAddMember();
  });
  document.getElementById('btn-mgr-clear-orders').addEventListener('click',   mgrClearOrders);
  document.getElementById('btn-mgr-wa').addEventListener('click',             mgrConfirmAndGenerateWA);
  document.getElementById('btn-mgr-regen-wa').addEventListener('click',       mgrGenerateWA);
  document.getElementById('btn-mgr-copy-msg').addEventListener('click',       mgrCopyMsg);
  document.getElementById('btn-mgr-send-wa').addEventListener('click',        mgrOpenWA);
  document.getElementById('btn-mgr-unlock-orders').addEventListener('click',  mgrUnlockOrders);
  document.getElementById('mgr-late-rounds-container').addEventListener('click', async e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const round = parseInt(btn.dataset.round, 10);
    const id    = btn.dataset.id ? parseInt(btn.dataset.id, 10) : null;
    switch (btn.dataset.action) {
      case 'confirm-late-round': await mgrConfirmLateRound(round); break;
      case 'regen-late-wa':      mgrRegenLateWA(round); break;
      case 'copy-late-msg': {
        const text = lateRoundWATexts[round] || '';
        try { await navigator.clipboard.writeText(text); showToast('Copiato!'); }
        catch (_) { showToast('Copia fallita.'); }
        break;
      }
      case 'send-late-wa': {
        const text = lateRoundWATexts[round] || '';
        if (text.trim()) window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
        break;
      }
      case 'delete-late-order': if (id) mgrDeleteOrder(id); break;
    }
  });
  document.getElementById('btn-mgr-asporto-wa').addEventListener('click',         mgrGenerateAsportoWA);
  document.getElementById('btn-mgr-copy-asporto-msg').addEventListener('click',   async () => {
    const text = document.getElementById('mgr-wa-asporto-text').value;
    try { await navigator.clipboard.writeText(text); showToast('Copiato!'); }
    catch (_) { showToast('Copia fallita.'); }
  });
  document.getElementById('btn-mgr-send-asporto-wa').addEventListener('click', () => {
    const text = document.getElementById('mgr-wa-asporto-text').value;
    if (!text.trim()) return;
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
  });
  document.getElementById('mgr-asporto-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="delete-asporto-mgr"]');
    if (btn) mgrDeleteAsportoOrder(parseInt(btn.dataset.id, 10));
  });
  document.getElementById('mgr-orders-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="delete-order"]');
    if (btn) mgrDeleteOrder(parseInt(btn.dataset.id, 10));
  });
  document.getElementById('mgr-join-requests-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const rid = parseInt(btn.dataset.rid, 10);
    if (btn.dataset.action === 'approve-join') mgrApproveJoin(rid);
    if (btn.dataset.action === 'reject-join')  mgrRejectJoin(rid);
  });
  document.getElementById('mgr-members-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const name = btn.dataset.name;
    if (btn.dataset.action === 'remove-member')  mgrRemoveMember(name);
    if (btn.dataset.action === 'promote-member') mgrSetMemberRole(name, 'manager');
    if (btn.dataset.action === 'demote-member')  mgrSetMemberRole(name, 'user');
  });

  // Restaurant dashboard
  document.getElementById('btn-restaurant-logout').addEventListener('click', changeName);
  document.getElementById('btn-restaurant-refresh').addEventListener('click', refreshRestaurantOrders);
  document.getElementById('restaurant-date').addEventListener('change', refreshRestaurantOrders);
  document.getElementById('btn-restaurant-save-menu').addEventListener('click', saveRestaurantMenu);
  document.getElementById('btn-restaurant-load-menu').addEventListener('click', loadRestaurantMenu);
  document.getElementById('restaurant-menu-date').addEventListener('change', loadRestaurantMenu);
  document.getElementById('btn-restaurant-save-status').addEventListener('click', saveRestaurantStatus);
  document.getElementById('btn-restaurant-add-dish').addEventListener('click', addRestaurantDish);
  document.getElementById('restaurant-new-dish').addEventListener('keydown', e => { if (e.key === 'Enter') addRestaurantDish(); });
  document.getElementById('btn-restaurant-clear-menu').addEventListener('click', () => {
    document.getElementById('restaurant-menu-text').value = '';
    document.getElementById('restaurant-menu-text').focus();
  });
  // Expand/collapse all
  document.getElementById('btn-expand-all').addEventListener('click', () => {
    restaurantCollapsed.clear();
    renderRestaurantOrders();
  });
  document.getElementById('btn-collapse-all').addEventListener('click', () => {
    restaurantOrders.forEach(t => restaurantCollapsed.add(t.group_id));
    renderRestaurantOrders();
  });
  // Sort buttons
  document.querySelectorAll('.restaurant-sort-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.restaurant-sort-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      restaurantSort = btn.dataset.sort;
      renderRestaurantOrders();
    });
  });
  // Restaurant sub-tabs
  document.querySelectorAll('.rtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rtab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.rtab').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`rtab-${btn.dataset.rtab}`).classList.add('active');
      if (btn.dataset.rtab === 'orders')  renderRestaurantOrders();
      if (btn.dataset.rtab === 'summary') renderRestaurantSummary();
      if (btn.dataset.rtab === 'asporto') renderRestaurantAsportoTab();
    });
  });

  if (collegeName) startApp();
});

// ═══ LOGIN ════════════════════════════════════════════════
function showSignInForm() {
  document.getElementById('login-register-form').style.display = 'none';
  document.getElementById('login-signin-form').style.display   = 'block';
  setLoginError('');
  document.getElementById('login-name').focus();
}

function showRegisterForm() {
  document.getElementById('login-signin-form').style.display   = 'none';
  document.getElementById('login-register-form').style.display = 'block';
  setRegError('');
  document.getElementById('reg-name').focus();
}

function setLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function setRegError(msg) {
  const el = document.getElementById('reg-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

async function signIn() {
  const name     = document.getElementById('login-name').value.trim();
  const password = document.getElementById('login-password').value;
  setLoginError('');
  if (!name)     { setLoginError('Inserisci il nome utente.'); return; }
  if (!password) { setLoginError('Inserisci la password.'); return; }
  document.getElementById('login-btn').disabled = true;
  const { data, error } = await apiFetchSilent('/users/login', 'POST', { name, password });
  document.getElementById('login-btn').disabled = false;
  if (error) {
    if (error.toLowerCase().includes('non trovato') || error.toLowerCase().includes('not found')) {
      setLoginError(`Utente "${name}" non trovato. Controlla il nome o registrati.`);
    } else if (error.toLowerCase().includes('password')) {
      setLoginError('Password errata. Riprova.');
    } else {
      setLoginError(error);
    }
    return;
  }
  setUserSession(data);
  if (data.role === 'restaurant' && data.token) {
    restaurantToken = data.token;
    sessionStorage.setItem('restaurantToken', data.token);
  }
  startApp();
}

async function register() {
  const name      = document.getElementById('reg-name').value.trim();
  const password  = document.getElementById('reg-password').value;
  const confirm   = document.getElementById('reg-password2').value;
  setRegError('');
  if (!name)              { setRegError('Inserisci un nome utente.'); return; }
  if (name.length < 2)    { setRegError('Il nome deve avere almeno 2 caratteri.'); return; }
  if (!password)          { setRegError('Inserisci una password.'); return; }
  if (password.length < 4){ setRegError('La password deve avere almeno 4 caratteri.'); return; }
  if (password !== confirm){ setRegError('Le password non coincidono.'); return; }
  document.getElementById('register-btn').disabled = true;
  const { data, error } = await apiFetchSilent('/users/register', 'POST', { name, password });
  document.getElementById('register-btn').disabled = false;
  if (error) {
    if (error.toLowerCase().includes('exists') || error.toLowerCase().includes('esiste')) {
      setRegError(`Il nome "${name}" è già in uso. Scegline un altro o accedi.`);
    } else {
      setRegError(error);
    }
    return;
  }
  // Auto sign-in after registration
  collegeName = name; userRole = 'user'; userGroupId = null; userGroupName = '';
  saveUserSession();
  startApp();
}

function setUserSession(info) {
  collegeName   = info.name;
  userRole      = info.role   || 'user';
  userGroupId   = info.group_id   || null;
  userGroupName = info.group_name || '';
  userPlaceId   = info.place_id   || null;
  userPlaceName = info.place_name || '';
  saveUserSession();
}

function saveUserSession() {
  localStorage.setItem('collegeName',   collegeName);
  localStorage.setItem('userRole',      userRole);
  localStorage.setItem('userGroupId',   userGroupId ?? '');
  localStorage.setItem('userGroupName', userGroupName);
  localStorage.setItem('userPlaceId',   userPlaceId ?? '');
  localStorage.setItem('userPlaceName', userPlaceName);
}

function loginBack() { showSignInForm(); }

function changeName() {
  ['collegeName','userRole','userGroupId','userGroupName','userPlaceId','userPlaceName'].forEach(k => localStorage.removeItem(k));
  sessionStorage.removeItem('restaurantToken');
  collegeName = ''; userRole = 'user'; userGroupId = null; userGroupName = '';
  userPlaceId = null; userPlaceName = ''; restaurantToken = null;
  hasVoted = false; hasOrdered = false; selectedPlaceIds = new Set(); allVotes = [];
  document.getElementById('login-name').value     = '';
  document.getElementById('login-password').value = '';
  showSignInForm();
  showScreen('login');
}

async function changePassword() {
  const oldPw = prompt('Password attuale:');
  if (oldPw === null) return;
  const newPw = prompt('Nuova password:');
  if (!newPw?.trim()) return;
  const confirm = prompt('Conferma nuova password:');
  if (newPw !== confirm) { alert('Le password non coincidono.'); return; }
  const res = await apiFetch('/users/change-password', 'POST',
    { name: collegeName, old_password: oldPw, new_password: newPw });
  if (res) showToast('✅ Password cambiata con successo!');
}

// ═══ APP START ════════════════════════════════════════════
async function startApp() {
  if (userRole === 'restaurant') { startRestaurantApp(); return; }
  if (collegeName) {
    const check = await apiFetch(`/users/exists/${encodeURIComponent(collegeName)}`).catch(() => null);
    if (!check || !check.exists) { changeName(); return; }
    // Refresh user info (role/group may have changed since last login)
    const info = await apiFetch(`/users/me/${encodeURIComponent(collegeName)}`);
    if (info) setUserSession(info);
  }
  updateNameDisplays();
  updateManagerButtons();

  if (!userGroupId && userRole !== 'admin') {
    // User has no group — show setup screen
    connectWebSocket();
    await loadSetupGroupScreen();
    showScreen('setup-group');
    return;
  }

  try {
    await loadSession();
    await Promise.all([loadPlaces(), loadMenus(), loadVotes()]);
    await Promise.all([checkMyVote(), checkMyOrder()]);
    await loadPreOrders();
    await Promise.all([loadAllOrders(), loadAsportoOrders()]);
    const autoSent = await autoSubmitFromPreOrder();
    connectWebSocket();
    if (!autoSent) updateScreen();
    if (hasOrdered) renderConfirmationOrders();
  } catch (_) {
    showBackendError();
  }
}

function updateNameDisplays() {
  ['vote','order','confirm','asporto'].forEach(s => {
    const el = document.getElementById(`hdr-name-${s}`);
    if (el) el.textContent = collegeName;
  });
  document.getElementById('hdr-name-setup').textContent  = collegeName;
  document.getElementById('hdr-group-manager').textContent = userGroupName;
  // Group pills
  const pillText = userGroupName ? `👥 ${userGroupName}` : '';
  ['vote','order','confirm'].forEach(s => {
    const el = document.getElementById(`hdr-group-${s}`);
    if (el) el.textContent = pillText;
  });
}

function updateManagerButtons() {
  const visible = (userRole === 'manager');
  ['btn-manager-vote','btn-manager-order','btn-manager-confirm'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  });
}

// ═══ SETUP GROUP SCREEN ══════════════════════════════════
async function loadSetupGroupScreen() {
  // Check pending manager request
  const managerReq = await apiFetch(`/group-requests/my/${encodeURIComponent(collegeName)}`);
  // Check pending join request
  const joinReq    = await apiFetch(`/join-requests/my/${encodeURIComponent(collegeName)}`);
  // Load available groups
  availableGroups  = (await apiFetch('/groups')) || [];

  const pendingMgrCard  = document.getElementById('pending-manager-card');
  const pendingJoinCard = document.getElementById('pending-join-card');
  const setupOptions    = document.getElementById('setup-options');

  if (managerReq && managerReq.status === 'pending') {
    pendingMgrCard.style.display  = 'block';
    pendingJoinCard.style.display = 'none';
    setupOptions.style.display    = 'none';
    document.getElementById('pending-manager-text').textContent =
      `Hai richiesto di creare il gruppo "${managerReq.group_name}". In attesa di approvazione dall'admin.`;
  } else if (joinReq && joinReq.status === 'pending') {
    pendingMgrCard.style.display  = 'none';
    pendingJoinCard.style.display = 'block';
    setupOptions.style.display    = 'none';
    document.getElementById('pending-join-text').textContent =
      `Hai richiesto di unirti al gruppo "${joinReq.group_name}". In attesa di approvazione dal manager.`;
  } else {
    pendingMgrCard.style.display  = 'none';
    pendingJoinCard.style.display = 'none';
    setupOptions.style.display    = 'block';
    renderGroupsList();
  }
}

function renderGroupsList() {
  const container = document.getElementById('groups-list-setup');
  if (!availableGroups.length) {
    container.innerHTML = '<p class="empty">Nessun gruppo disponibile. Creane uno nuovo!</p>';
    return;
  }
  container.innerHTML = availableGroups.map(g => `
    <div class="setup-group-item">
      <div class="setup-group-info">
        <strong>${esc(g.name)}</strong>
        <span class="setup-group-meta">👤 ${g.manager_name} · ${g.member_count} ${g.member_count === 1 ? 'membro' : 'membri'}</span>
      </div>
      <button class="btn btn-primary btn-sm" data-action="join-group" data-gid="${g.id}">Richiedi →</button>
    </div>`).join('');
}

async function requestNewGroup() {
  const groupName = document.getElementById('new-group-name').value.trim();
  if (!groupName) { showToast('Inserisci un nome per il gruppo.'); return; }
  const res = await apiFetch('/group-requests', 'POST', { user_name: collegeName, group_name: groupName });
  if (res) {
    document.getElementById('new-group-name').value = '';
    showToast('✅ Richiesta inviata! L\'admin la esaminerà a breve.');
    await loadSetupGroupScreen();
  }
}

async function requestJoinGroup(group_id) {
  const res = await apiFetch(`/groups/${group_id}/join-requests`, 'POST', { user_name: collegeName });
  if (res) {
    showToast('✅ Richiesta inviata! Il manager la esaminerà a breve.');
    await loadSetupGroupScreen();
  }
}

async function cancelGroupRequest() {
  // We can't actually delete the request from the server (no DELETE endpoint), 
  // but we can just reload and it'll show as pending. 
  // For now, just tell user to contact admin.
  showToast('Contatta l\'admin per annullare la richiesta.', 4000);
}

async function cancelJoinRequest() {
  showToast('Contatta il manager del gruppo per annullare la richiesta.', 4000);
}

// ═══ SCREEN ROUTING ════════════════════════════════════════
function updateScreen() {
  if (!collegeName) { showScreen('login'); return; }
  if (!userGroupId && userRole !== 'admin') { showScreen('setup-group'); return; }

  if (sessionState.state === 'voting') {
    selectedOrderPlaceId = null;
    showScreen('voting');
    renderVotingScreen();
    return;
  }
  if (sessionState.state === 'ordering') {
    if (hasOrdered) { updateCancelButtonVisibility(); showScreen('confirmation'); return; }
    // If coming from manager, track it so submit can return there
    if (document.getElementById('screen-manager').classList.contains('active')) {
      orderPrevScreen = 'manager';
    }
    showScreen('ordering');
    renderOrderingScreen();
    return;
  }
  updateCancelButtonVisibility();
  showScreen('confirmation');
}

function updateCancelButtonVisibility() {
  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  document.getElementById('btn-cancel-order').style.display =
    (isSplit && sessionState.state === 'ordering') ? 'block' : 'none';
}

// ═══ WEBSOCKET ════════════════════════════════════════════
function connectWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);
  ws.onopen  = () => { clearTimeout(wsReconnectTimer); setDots(true); };
  ws.onclose = () => { setDots(false); wsReconnectTimer = setTimeout(connectWebSocket, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    try { handleWSMessage(JSON.parse(ev.data)); } catch (_) {}
  };
}

function setDots(connected) {
  const cls = connected ? 'dot dot-on' : 'dot dot-off';
  ['vote','order','confirm','asporto','manager','restaurant'].forEach(s => {
    const el = document.getElementById(`ws-dot-${s}`);
    if (el) el.className = cls;
  });
}

async function handleWSMessage(data) {
  switch (data.type) {
    case 'places_updated':
      loadPlaces().then(() => { if (sessionState.state === 'voting') renderVotingScreen(); });
      break;
    case 'menus_updated':
      if (userRole === 'restaurant') {
        // Only reload menu tab if it's visible and for their place
        const menuTab = document.getElementById('rtab-menu');
        if (menuTab && menuTab.classList.contains('active') && data.place_id !== userPlaceId)
          loadRestaurantMenu();
        break;
      }
      if (data.date === today)
        loadMenus().then(() => { if (sessionState.state === 'voting') renderVotingScreen(); });
      break;
    case 'session_updated':
      if (data.session?.date === today && data.session?.group_id === userGroupId) {
        const prevLockCount = sessionLockCount();
        sessionState = data.session;
        if (sessionState.state === 'ordering') {
          const autoSent = await autoSubmitFromPreOrder();
          if (!autoSent) updateScreen();
          // If lock state changed and user is on ordering screen, update the button
          if (prevLockCount !== sessionLockCount()) {
            const orderScr = document.getElementById('screen-ordering');
            if (orderScr && orderScr.classList.contains('active')) renderOrderingScreen();
          }
        } else {
          updateScreen();
          if (sessionState.state === 'voting') updateTimerDisplay();
        }
        if (document.getElementById('screen-manager').classList.contains('active'))
          renderManagerScreen();
      }
      break;
    case 'votes_updated':
      if (data.date === today && data.group_id === userGroupId) {
        allVotes = data.votes || [];
        const myVotes = allVotes.filter(v => v.colleague_name === collegeName);
        if (myVotes.length) { hasVoted = true; selectedPlaceIds = new Set(myVotes.map(v => v.place_id)); }
        else if (hasVoted)  { hasVoted = false; selectedPlaceIds = new Set(); }
        if (sessionState.state === 'voting') renderVotingScreen();
        if (document.getElementById('screen-manager').classList.contains('active'))
          renderMgrVotes();
      }
      break;
    case 'orders_updated':
      if (userRole === 'restaurant') { refreshRestaurantOrders(); break; }
      if (data.date === today && data.group_id === userGroupId) {
        allOrders = data.orders || [];
        if (hasOrdered) renderConfirmationOrders();
        if (document.getElementById('screen-manager').classList.contains('active'))
          renderMgrOrders();
      }
      break;
    case 'asporto_updated':
      if (userRole === 'restaurant') { refreshRestaurantOrders(); break; }
      if (data.date === today && data.group_id === userGroupId) {
        asportoOrders    = data.orders || [];
        myAsportoOrders  = asportoOrders.filter(o => o.colleague_name === collegeName);
        const asportoScr = document.getElementById('screen-asporto');
        if (asportoScr.classList.contains('active')) {
          renderMyAsportoOrders(); renderAsportoScreen();
        }
        if (document.getElementById('screen-manager').classList.contains('active'))
          renderMgrAsportoOrders();
      }
      break;
    case 'group_request_updated':
      // Our request was approved or rejected
      if (data.user_name === collegeName) {
        if (data.status === 'approved') {
          showToast('🎉 Richiesta approvata! Benvenuto nel tuo gruppo!', 4000);
          const info = await apiFetch(`/users/me/${encodeURIComponent(collegeName)}`);
          if (info) {
            setUserSession(info);
            updateNameDisplays();
            updateManagerButtons();
            await startApp();
          }
        } else if (data.status === 'rejected') {
          showToast('❌ La tua richiesta è stata rifiutata.', 4000);
          await loadSetupGroupScreen();
        }
      }
      break;
    case 'join_request_updated':
      if (data.user_name === collegeName) {
        if (data.status === 'approved') {
          showToast('🎉 Sei stato aggiunto al gruppo!', 4000);
          const info = await apiFetch(`/users/me/${encodeURIComponent(collegeName)}`);
          if (info) {
            setUserSession(info);
            updateNameDisplays();
            updateManagerButtons();
            await startApp();
          }
        } else {
          showToast('❌ La richiesta di iscrizione è stata rifiutata.', 4000);
          await loadSetupGroupScreen();
        }
      }
      break;
    case 'group_updated':
      if (data.group_id === userGroupId) {
        // Refresh members in manager screen
        if (document.getElementById('screen-manager').classList.contains('active'))
          loadMgrData();
      }
      break;
    case 'join_request_created':
      if (userRole === 'manager' && data.group_id === userGroupId) {
        loadJoinRequests().then(renderMgrJoinRequests);
        mgrPendingCount++;
        updateMgrNotification();
      }
      break;
  }
}

// ═══ AUTO-SUBMIT FROM PRE-ORDER ════════════════════════════
async function autoSubmitFromPreOrder() {
  if (sessionState.state !== 'ordering' || hasOrdered) return false;
  const splitPids = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1
    ? sessionState.winning_place_ids : [];
  const pid = splitPids.length > 0
    ? (() => {
        const candidates = splitPids
          .filter(id => preOrders[id])
          .map(id => ({ id, po: preOrders[id] }))
          .filter(({ po }) => (po.checks || []).length > 0 || (po.custom || '').trim());
        if (!candidates.length || candidates.length > 1) return null;
        return candidates[0].id;
      })()
    : sessionState.winning_place_id;
  if (!pid) return false;
  const po = preOrders[pid];
  if (!po) return false;
  const checks = po.checks || [];
  const custom = (po.custom || '').trim();
  const parts  = custom ? [...checks, custom] : checks;
  if (!parts.length) return false;
  const orderText = parts.join(', ');
  const res = await apiFetch(`/groups/${userGroupId}/orders`, 'POST', {
    colleague_name: collegeName, place_id: pid, order_text: orderText, date: today
  });
  if (res) {
    hasOrdered = true;
    selectedOrderPlaceId = pid;
    currentOrderText = orderText;
    setConfirmText(`✅ Ordine inviato automaticamente dal tuo pre-ordine: "${orderText}"`);
    showScreen('confirmation');
    renderConfirmationOrders();
    return true;
  }
  return false;
}

// ═══ DATA LOADING ═════════════════════════════════════════
function gp(path) { return `/groups/${userGroupId}${path}`; }

async function loadSession() {
  const s = await apiFetch(gp(`/session/${today}`));
  if (s) sessionState = s;
}
async function loadPlaces() {
  const p = await apiFetch('/places');
  if (p) places = p;
}
async function loadMenus() {
  const m = await apiFetch(`/menus/${today}`);
  if (m) menus = m;
}
async function loadVotes() {
  const v = await apiFetch(gp(`/votes/${today}`));
  if (v) allVotes = v;
}
async function loadAllOrders() {
  const o = await apiFetch(gp(`/orders/${today}`));
  if (o) allOrders = o;
}
async function loadAsportoOrders() {
  const a = await apiFetch(gp(`/asporto/${today}`));
  if (a) { asportoOrders = a; myAsportoOrders = a.filter(o => o.colleague_name === collegeName); }
}
async function loadPreOrders() {
  const rows = await apiFetch(`/preorders/${today}/${encodeURIComponent(collegeName)}`);
  if (rows) { preOrders = {}; rows.forEach(r => { preOrders[r.place_id] = { checks: r.checks || [], custom: r.custom || '' }; }); }
}
async function savePreOrderForPlace(placeId, data) {
  preOrders[placeId] = data;
  apiFetch(`/preorders/${today}/${encodeURIComponent(collegeName)}/${placeId}`, 'PUT', data);
}
async function checkMyVote() {
  const votes = await apiFetch(gp(`/votes/${today}`));
  if (!votes) return;
  const mine = votes.filter(v => v.colleague_name === collegeName);
  if (mine.length) { hasVoted = true; selectedPlaceIds = new Set(mine.map(v => v.place_id)); }
}
async function checkMyOrder() {
  const orders = await apiFetch(gp(`/orders/${today}`));
  if (!orders) return;
  const mine = orders.find(o => o.colleague_name === collegeName);
  if (mine) { hasOrdered = true; currentOrderText = mine.order_text; setConfirmText(mine.order_text); selectedOrderPlaceId = mine.place_id || null; }
}

function setConfirmText(text) {
  document.getElementById('confirm-text').textContent = `Il tuo ordine è stato ricevuto: "${text}"`;
}

// ═══ VOTING SCREEN ════════════════════════════════════════
function selectPlace(placeId) {
  if (hasVoted) return;
  if (selectedPlaceIds.has(placeId)) selectedPlaceIds.delete(placeId);
  else selectedPlaceIds.add(placeId);
  renderVotingScreen();
}

function renderVotingScreen() {
  const list = document.getElementById('places-list');
  if (!places.length) {
    list.innerHTML = '<p class="empty">L\'admin non ha ancora aggiunto ristoranti.</p>';
  } else {
    const totalVotes = allVotes.length;
    list.innerHTML = places.map((place, _i) => {
      const menu        = menus.find(m => m.place_id === place.id);
      const isSelected  = selectedPlaceIds.has(place.id);
      const po          = preOrders[place.id] || { checks: [], custom: '' };
      const hasPreorder = po.checks.length > 0 || po.custom;
      const menuLines   = (menu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
      const voteCount   = allVotes.filter(v => v.place_id === place.id).length;
      const votePct     = totalVotes > 0 ? Math.round(voteCount / totalVotes * 100) : 0;
      const presetLines = place.presets || [];
      let checkboxesHtml = '';
      if (menuLines.length) {
        checkboxesHtml += '<p class="checkbox-group-label">Menu del giorno:</p>';
        checkboxesHtml += menuLines.map(line => `
          <label class="preorder-check-item">
            <input type="checkbox" value="${esc(line)}" ${po.checks.includes(line) ? 'checked' : ''} />
            <span>${esc(line)}</span>
          </label>`).join('');
      }
      if (presetLines.length) {
        checkboxesHtml += '<p class="checkbox-group-label">Sempre disponibili:</p>';
        checkboxesHtml += presetLines.map(line => `
          <label class="preorder-check-item">
            <input type="checkbox" value="${esc(line)}" ${po.checks.includes(line) ? 'checked' : ''} />
            <span>${esc(line)}</span>
          </label>`).join('');
      }
      if (!menuLines.length && !presetLines.length)
        checkboxesHtml = '<em class="empty-check">Nessuna voce di menu o preset disponibile.</em>';
      return `
        <div class="place-card ${isSelected ? 'selected' : ''} ${hasVoted ? 'voted' : ''}"
             style="--delay:${_i * 0.06}s" data-place-id="${place.id}">
          <div class="place-card-header">
            <strong>${esc(place.name)}</strong>
            <div class="card-header-right">
              ${isSelected ? '<span class="sel-badge">✓ Tua scelta</span>' : ''}
              <span id="preorder-badge-${place.id}" class="preorder-badge" style="display:${hasPreorder ? 'inline' : 'none'}">📝</span>
              <button class="btn-preorder" data-place-id="${place.id}" title="Pre-ordina">Pre-ordina</button>
            </div>
          </div>
          ${place.description ? `<p class="place-desc-text">${esc(place.description)}</p>` : ''}
          ${voteCount > 0 ? `<div class="place-vote-bar"><span class="place-vote-count">${voteCount} vot${voteCount===1?'o':'i'} · ${votePct}%</span><div class="place-vote-fill" style="width:${votePct}%"></div></div>` : ''}
          <div class="place-menu-text">
            ${menu?.menu_text ? `<pre>${esc(menu.menu_text)}</pre>` : '<em>Menu non ancora disponibile</em>'}
          </div>
          <div id="preorder-panel-${place.id}" class="preorder-panel" data-place-id="${place.id}" style="display:none">
            <p class="preorder-panel-title">Il tuo pre-ordine per <strong>${esc(place.name)}</strong>:</p>
            <div class="preorder-checks">${checkboxesHtml}</div>
            <textarea class="preorder-custom" rows="2" placeholder="Variazione o aggiunta…">${esc(po.custom)}</textarea>
          </div>
        </div>`;
    }).join('');
  }
  updateTimerDisplay();
  const submitBtn    = document.getElementById('btn-submit-vote');
  const alreadyVoted = document.getElementById('already-voted');
  if (hasVoted) {
    submitBtn.style.display    = 'none';
    alreadyVoted.style.display = 'flex';
  } else {
    submitBtn.style.display    = 'block';
    submitBtn.disabled         = selectedPlaceIds.size === 0;
    submitBtn.textContent      = selectedPlaceIds.size > 1 ? `Vota (${selectedPlaceIds.size} posti)` : 'Vota';
    alreadyVoted.style.display = 'none';
  }
}

async function submitVote() {
  if (!selectedPlaceIds.size || hasVoted) return;
  const res = await apiFetch(gp('/votes'), 'POST', {
    place_ids: [...selectedPlaceIds], colleague_name: collegeName, date: today
  });
  if (res) { hasVoted = true; renderVotingScreen(); }
}

function changeVote() { hasVoted = false; renderVotingScreen(); }

function updateTimerDisplay() {
  const timerEl    = document.getElementById('vote-timer');
  const countdownEl = document.getElementById('timer-countdown');
  clearInterval(timerInterval);
  if (sessionState.timer_end && sessionState.state === 'voting') {
    timerEl.style.display = 'flex';
    function tick() {
      const remaining = Math.max(0, new Date(sessionState.timer_end) - Date.now());
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      countdownEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      if (remaining === 0) clearInterval(timerInterval);
    }
    tick();
    timerInterval = setInterval(tick, 1000);
  } else {
    timerEl.style.display = 'none';
  }
}

// ═══ ORDERING SCREEN ══════════════════════════════════════
function renderOrderingScreen() {
  const splitPids   = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1
    ? sessionState.winning_place_ids : [];
  const isSplit     = splitPids.length > 0;
  const pickSection = document.getElementById('split-pick-section');
  const formSection = document.getElementById('order-form-section');

  // Update submit button label based on lock state
  const submitBtn = document.getElementById('btn-submit-order');
  if (submitBtn) {
    submitBtn.textContent = sessionLockCount() > 0
      ? '🕐 Aggiungi all\'ordine, mi scuso per essere ritardat(ari)o'
      : 'Invia Ordine';
  }

  if (isSplit && !selectedOrderPlaceId) {
    pickSection.style.display = 'block';
    formSection.style.display = 'none';
    renderSplitPicker(splitPids);
    return;
  }
  pickSection.style.display = 'none';
  formSection.style.display = 'block';

  const pid          = selectedOrderPlaceId || sessionState.winning_place_id;
  const winningPlace = places.find(p => p.id === pid);
  const winningMenu  = menus.find(m => m.place_id === pid);
  document.getElementById('winning-place-title').textContent =
    winningPlace ? `📍 Ordina da: ${winningPlace.name}` : '📍 Inserisci il tuo ordine';

  const summaryEl = document.getElementById('order-votes-summary');
  if (summaryEl && allVotes.length > 0) {
    const groups = {};
    allVotes.forEach(v => {
      if (!groups[v.place_id]) groups[v.place_id] = { name: v.place_name || places.find(p => p.id === v.place_id)?.name || '', count: 0 };
      groups[v.place_id].count++;
    });
    summaryEl.innerHTML = '<strong>📊 Risultati:</strong> ' +
      Object.entries(groups).sort((a, b) => b[1].count - a[1].count)
        .map(([, g]) => `${esc(g.name)}: <strong>${g.count}</strong>`).join(' &nbsp;·&nbsp; ');
    summaryEl.style.display = 'block';
  } else if (summaryEl) summaryEl.style.display = 'none';

  const container   = document.getElementById('menu-checkboxes');
  const menuLines   = (winningMenu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
  const presetLines = winningPlace?.presets || [];
  const po          = preOrders[pid] || { checks: [], custom: '' };
  const maxDishes   = winningPlace?.max_dishes || 0;

  let html = maxDishes > 0
    ? `<span id="dishes-limit-label" class="dishes-limit-label">Seleziona al massimo <strong>${maxDishes}</strong> ${maxDishes===1?'piatto':'piatti'}</span>`
    : '';
  if (menuLines.length) {
    html += '<p class="checkbox-group-label">Menu del giorno:</p>';
    html += menuLines.map((line, i) => `
      <label class="menu-check-item" style="animation:fadeUp 0.28s var(--ease) ${i*0.05}s both">
        <input type="checkbox" name="menu-item" value="${esc(line)}" id="mc-${i}" ${po.checks.includes(line)?'checked':''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (presetLines.length) {
    html += '<p class="checkbox-group-label" style="margin-top:10px">Sempre disponibili:</p>';
    html += presetLines.map((line, i) => `
      <label class="menu-check-item" style="animation:fadeUp 0.28s var(--ease) ${(menuLines.length+i)*0.05}s both">
        <input type="checkbox" name="menu-item" value="${esc(line)}" id="pc-${i}" ${po.checks.includes(line)?'checked':''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (!menuLines.length && !presetLines.length)
    html = '<em class="empty-check">Nessuna voce di menu — usa il campo sotto.</em>';
  container.innerHTML = html;
  if (maxDishes > 0) {
    container.querySelectorAll('input[name="menu-item"]').forEach(cb =>
      cb.addEventListener('change', () => enforceMaxDishes(container, maxDishes))
    );
    enforceMaxDishes(container, maxDishes);
  }
  document.getElementById('order-custom').value = po.custom || '';
}

function renderSplitPicker(pids) {
  const container  = document.getElementById('split-places-pick');
  const totalVotes = allVotes.length;
  container.innerHTML = pids.map(pid => {
    const place    = places.find(p => p.id === pid);
    if (!place) return '';
    const voteCount = allVotes.filter(v => v.place_id === pid).length;
    const votePct   = totalVotes > 0 ? Math.round(voteCount / totalVotes * 100) : 0;
    return `
      <button class="split-pick-btn" data-place-id="${pid}">
        <strong>${esc(place.name)}</strong>
        ${place.description ? `<span>${esc(place.description)}</span>` : ''}
        ${voteCount > 0 ? `<span class="split-vote-label">${voteCount} vot${voteCount===1?'o':'i'} · ${votePct}%</span>` : ''}
      </button>`;
  }).join('');
}

function pickOrderPlace(id) { selectedOrderPlaceId = id; renderOrderingScreen(); }

function enforceMaxDishes(container, max) {
  const all     = [...container.querySelectorAll('input[name="menu-item"]')];
  const checked = all.filter(cb => cb.checked);
  const reached = checked.length >= max;
  all.forEach(cb => { if (!cb.checked) cb.disabled = reached; });
  document.getElementById('dishes-limit-label')?.classList.toggle('dishes-limit-reached', reached);
}

async function submitOrder() {
  const checked   = [...document.querySelectorAll('input[name="menu-item"]:checked')].map(cb => cb.value);
  const custom    = document.getElementById('order-custom').value.trim();
  const parts     = custom ? [...checked, custom] : checked;
  if (!parts.length) { document.getElementById('order-custom').focus(); return; }
  const orderText = parts.join(', ');
  const isLate    = sessionLockCount() > 0;
  const res = await apiFetch(gp('/orders'), 'POST', {
    colleague_name: collegeName,
    place_id: selectedOrderPlaceId || sessionState.winning_place_id || null,
    order_text: orderText, date: today
  });
  if (res) {
    hasOrdered = true;
    selectedOrderPlaceId = selectedOrderPlaceId || sessionState.winning_place_id || null;
    currentOrderText = orderText;
    if (isLate) {
      setConfirmText(`⏰ Ordine in ritardo aggiunto: "${orderText}"`);
    } else {
      setConfirmText(orderText);
    }
    if (orderPrevScreen === 'manager') {
      orderPrevScreen = null;
      showToast('✅ Ordine inviato!');
      showScreen('manager');
      await renderManagerScreen();
    } else {
      showScreen('confirmation');
      renderConfirmationOrders();
    }
  }
}

function editOrder() {
  hasOrdered = false;
  const pid = selectedOrderPlaceId || sessionState.winning_place_id;
  if (pid && currentOrderText) {
    const winningPlace = places.find(p => p.id === pid);
    const winningMenu  = menus.find(m => m.place_id === pid);
    const menuLines    = (winningMenu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
    const presetLines  = winningPlace?.presets || [];
    const knownItems   = new Set([...menuLines, ...presetLines]);
    const parts        = currentOrderText.split(',').map(s => s.trim()).filter(s => s);
    preOrders[pid]     = { checks: parts.filter(p => knownItems.has(p)), custom: parts.filter(p => !knownItems.has(p)).join(', ') };
  }
  renderOrderingScreen();
  showScreen('ordering');
}

async function cancelOrder() {
  if (!confirm('Annullare il tuo ordine e scegliere un altro posto?')) return;
  const myOrder = allOrders.find(o => o.colleague_name === collegeName);
  if (myOrder?.id) await apiFetch(gp(`/orders/${today}/${myOrder.id}`), 'DELETE', { manager_name: collegeName });
  hasOrdered = false; currentOrderText = ''; selectedOrderPlaceId = null;
  orderPrevScreen = null;
  renderOrderingScreen();
  showScreen('ordering');
}

function renderConfirmationOrders() {
  const container = document.getElementById('all-orders-list');
  if (!container) return;
  const isSplit   = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const myPlaceId = selectedOrderPlaceId || sessionState.winning_place_id;
  const others    = allOrders.filter(o => {
    if (o.colleague_name === collegeName) return false;
    if (isSplit && myPlaceId != null) return o.place_id === myPlaceId;
    return true;
  });
  const label = isSplit && myPlaceId != null
    ? `Colleghi che ordinano da <strong>${esc(places.find(p => p.id === myPlaceId)?.name || '')}</strong>`
    : 'Ordini dei colleghi';
  const titleEl = container.closest('.card')?.querySelector('.confirm-orders-title');
  if (titleEl) titleEl.innerHTML = label;
  if (!others.length) { container.innerHTML = '<em class="empty-orders-msg">Nessun altro ordine ancora.</em>'; return; }
  container.innerHTML = others.map(o => `
    <div class="confirm-order-item">
      <span class="confirm-order-name">${esc(o.colleague_name)}</span>
      <span class="confirm-order-text">${esc(o.order_text)}</span>
    </div>`).join('');
}

// ═══ ASPORTO ══════════════════════════════════════════════
function showAsportoScreen() {
  const active = document.querySelector('.screen.active');
  asportoPrevScreen = active ? active.id.replace('screen-','') : 'voting';
  renderAsportoScreen();
  showScreen('asporto');
}
function backFromAsporto() {
  showScreen(asportoPrevScreen);
  if (asportoPrevScreen === 'voting') renderVotingScreen();
}
function renderAsportoScreen() {
  const sel = document.getElementById('asporto-place-select');
  const cur = parseInt(sel.value, 10) || 0;
  const menuPlaces = places.filter(p => { const m = menus.find(x => x.place_id === p.id); return m && m.menu_text?.trim(); });
  sel.innerHTML = '<option value="">— Scegli il ristorante —</option>' +
    menuPlaces.map(p => {
      const has = myAsportoOrders.some(o => o.place_id === p.id);
      return `<option value="${p.id}"${cur===p.id?' selected':''}>${esc(p.name)}${has?' ✓':''}</option>`;
    }).join('');
  if (cur) renderAsportoForm(cur);
  renderMyAsportoOrders();
}
function onAsportoPlaceChange() {
  const pid = parseInt(document.getElementById('asporto-place-select').value, 10);
  if (!pid) { document.getElementById('asporto-form-section').style.display = 'none'; return; }
  renderAsportoForm(pid);
}
function renderAsportoForm(placeId) {
  const place       = places.find(p => p.id === placeId);
  const menu        = menus.find(m => m.place_id === placeId);
  const myOrder     = myAsportoOrders.find(o => o.place_id === placeId);
  const menuLines   = (menu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
  const presetLines = place?.presets || [];
  let existingChecks = [], existingCustom = '';
  if (myOrder) {
    const knownItems = new Set([...menuLines, ...presetLines]);
    const parts = myOrder.order_text.split(',').map(s => s.trim()).filter(s => s);
    existingChecks = parts.filter(p => knownItems.has(p));
    existingCustom = parts.filter(p => !knownItems.has(p)).join(', ');
  }
  let html = '';
  if (menuLines.length) {
    html += '<p class="checkbox-group-label">Menu del giorno:</p>';
    html += menuLines.map(line => `<label class="menu-check-item"><input type="checkbox" name="asporto-item" value="${esc(line)}" ${existingChecks.includes(line)?'checked':''} /><span>${esc(line)}</span></label>`).join('');
  }
  if (presetLines.length) {
    html += '<p class="checkbox-group-label">Sempre disponibili:</p>';
    html += presetLines.map(line => `<label class="menu-check-item"><input type="checkbox" name="asporto-item" value="${esc(line)}" ${existingChecks.includes(line)?'checked':''} /><span>${esc(line)}</span></label>`).join('');
  }
  if (!menuLines.length && !presetLines.length) html = '<em class="empty-check">Nessuna voce di menu — usa il campo sotto.</em>';
  document.getElementById('asporto-checkboxes').innerHTML = html;
  document.getElementById('asporto-custom').value = existingCustom;
  document.getElementById('btn-submit-asporto').textContent = myOrder ? '🛵 Aggiorna Ordine' : '🛵 Invia Ordine Asporto';
  document.getElementById('asporto-form-section').style.display = 'block';
}
function renderMyAsportoOrders() {
  const card = document.getElementById('my-asporto-card');
  const list = document.getElementById('my-asporto-list');
  if (!myAsportoOrders.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  list.innerHTML = myAsportoOrders.map(o => `
    <div class="confirm-order-item">
      <div>
        <strong>${esc(o.place_name)}</strong>
        <span class="confirm-order-text" style="display:block">${esc(o.order_text)}</span>
      </div>
      <button class="btn btn-danger btn-xs" data-action="delete-asporto" data-id="${o.id}">&times;</button>
    </div>`).join('');
}
async function submitAsportoOrder() {
  const pid     = parseInt(document.getElementById('asporto-place-select').value, 10);
  if (!pid) { document.getElementById('asporto-place-select').focus(); return; }
  const checked = [...document.querySelectorAll('input[name="asporto-item"]:checked')].map(c => c.value);
  const custom  = document.getElementById('asporto-custom').value.trim();
  const parts   = custom ? [...checked, custom] : checked;
  if (!parts.length) { document.getElementById('asporto-custom').focus(); return; }
  const res = await apiFetch(gp('/asporto'), 'POST', {
    colleague_name: collegeName, place_id: pid, order_text: parts.join(', '), date: today
  });
  if (res) { showToast('🛵 Ordine asporto salvato!'); renderAsportoScreen(); }
}
async function deleteMyAsportoOrder(id) {
  await apiFetch(gp(`/asporto/${today}/${id}`), 'DELETE', { colleague_name: collegeName });
}

// ═══ MANAGER DASHBOARD ════════════════════════════════════
function backFromManager() {
  orderPrevScreen = null;
  updateScreen();
}

async function loadMgrData() {
  await Promise.all([
    loadVotes(),
    loadAllOrders(),
    loadAsportoOrders(),
    loadJoinRequests()
  ]);
}

async function loadJoinRequests() {
  const jrs = await apiFetch(gp('/join-requests'));
  if (jrs) mgrJoinRequests = jrs;
}

async function renderManagerScreen() {
  // Reload data
  await loadMgrData();
  await loadSession(); // ensure session is fresh

  // Populate selectors
  populateMgrSelects();
  renderMgrSessionState();
  renderMgrVotes();
  renderMgrOrders();
  renderMgrAsportoOrders();
  renderMgrJoinRequests();
  await loadMgrMembers();
}

async function loadMgrMembers() {
  const members = await apiFetch(gp('/members'));
  if (members) {
    mgrMembers = members;
    renderMgrMembers();
  }
}

function populateMgrSelects() {
  ['mgr-force-winner-select','mgr-change-winner-select'].forEach(id => {
    const sel  = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">— nessuno —</option>' +
      places.map(p => `<option value="${p.id}" ${sessionState.winning_place_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('');
    if (prev) sel.value = prev;
  });
  const splitList = document.getElementById('mgr-split-check-list');
  if (splitList) {
    splitList.innerHTML = places.map(p => `
      <label class="split-check-label">
        <input type="checkbox" class="mgr-split-check" value="${p.id}" />
        ${esc(p.name)}
      </label>`).join('');
  }
}

function renderMgrSessionState() {
  const badge = document.getElementById('mgr-session-badge');
  const labels = { voting: 'Votazione aperta', ordering: 'Ordini aperti', closed: 'Sessione chiusa' };
  badge.textContent = labels[sessionState.state] || sessionState.state;
  badge.className   = `badge badge-${sessionState.state}`;

  const votingCtrl   = document.getElementById('mgr-voting-controls');
  const orderingCtrl = document.getElementById('mgr-ordering-controls');

  votingCtrl.style.display   = sessionState.state === 'voting'   ? 'block' : 'none';
  orderingCtrl.style.display = sessionState.state !== 'voting'   ? 'block' : 'none';

  renderMgrLockState();
  updateMgrTimer();
}

function updateMgrTimer() {
  const display   = document.getElementById('mgr-timer-display');
  const btnStart  = document.getElementById('btn-mgr-start-timer');
  const btnStop   = document.getElementById('btn-mgr-stop-timer');
  clearInterval(mgrTimerInterval);
  if (sessionState.timer_end && sessionState.state === 'voting') {
    btnStart.style.display = 'none';
    btnStop.style.display  = 'inline-block';
    display.style.display  = 'inline-block';
    function tick() {
      const remaining = Math.max(0, new Date(sessionState.timer_end) - Date.now());
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      display.textContent = `⏱ ${m}:${s.toString().padStart(2,'0')} rimasti`;
      if (remaining === 0) { clearInterval(mgrTimerInterval); }
    }
    tick();
    mgrTimerInterval = setInterval(tick, 1000);
  } else {
    btnStart.style.display = 'inline-block';
    btnStop.style.display  = 'none';
    display.textContent    = '';
    display.style.display  = 'none';
  }
}

function renderMgrVotes() {
  const list = document.getElementById('mgr-votes-list');
  if (!allVotes.length) { list.innerHTML = '<p class="empty">Nessun voto ancora.</p>'; return; }
  const groups = {};
  allVotes.forEach(v => {
    if (!groups[v.place_id]) groups[v.place_id] = { name: v.place_name || places.find(p => p.id === v.place_id)?.name || '', votes: [] };
    groups[v.place_id].votes.push(v.colleague_name);
  });
  const total  = allVotes.length;
  const sorted = Object.entries(groups).sort((a, b) => b[1].votes.length - a[1].votes.length);
  list.innerHTML = sorted.map(([, group]) => {
    const pct = Math.round((group.votes.length / total) * 100);
    return `
      <div class="mgr-vote-group">
        <div class="mgr-vote-header">
          <strong>${esc(group.name)}</strong>
          <span class="mgr-vote-count">${group.votes.length} vot${group.votes.length===1?'o':'i'} (${pct}%)</span>
        </div>
        <div class="mgr-vote-bar"><div class="mgr-vote-bar-fill" style="width:${pct}%"></div></div>
        <div class="mgr-vote-names">${group.votes.map(esc).join(', ')}</div>
      </div>`;
  }).join('');
}

function renderMgrOrders() {
  const list         = document.getElementById('mgr-orders-list');
  const normalOrders = allOrders.filter(o => orderLateRound(o) === 0);

  // ── Normal orders ──
  if (!normalOrders.length) {
    list.innerHTML = '<p class="empty">Nessun ordine.</p>';
  } else {
    const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
    if (isSplit) {
      let html = '';
      sessionState.winning_place_ids.forEach(pid => {
        const placeOrders = normalOrders.filter(o => o.place_id === pid);
        if (!placeOrders.length) return;
        const placeName = places.find(p => p.id === pid)?.name || `#${pid}`;
        html += `<div class="mgr-orders-place-header">${esc(placeName)}</div>`;
        html += placeOrders.map(o => `
          <div class="mgr-order-item">
            <div><strong>${esc(o.colleague_name)}</strong><span style="color:var(--text-muted)"> — ${esc(o.order_text)}</span></div>
            <button class="btn btn-danger btn-xs" data-action="delete-order" data-id="${o.id}">&times;</button>
          </div>`).join('');
      });
      list.innerHTML = html || '<p class="empty">Nessun ordine.</p>';
    } else {
      list.innerHTML = normalOrders.map(o => `
        <div class="mgr-order-item">
          <div><strong>${esc(o.colleague_name)}</strong><span style="color:var(--text-muted)"> — ${esc(o.order_text)}</span></div>
          <button class="btn btn-danger btn-xs" data-action="delete-order" data-id="${o.id}">&times;</button>
        </div>`).join('');
    }
  }

  renderLateRounds();
}

function renderMgrAsportoOrders() {
  const list = document.getElementById('mgr-asporto-list');
  if (!asportoOrders.length) {
    list.innerHTML = '<p class="empty">Nessun ordine asporto.</p>';
    return;
  }
  // Group by place
  const byPlace = {};
  asportoOrders.forEach(o => {
    const key = o.place_id || 0;
    if (!byPlace[key]) byPlace[key] = { name: o.place_name || places.find(p => p.id === o.place_id)?.name || 'Vario', orders: [] };
    byPlace[key].orders.push(o);
  });
  let html = '';
  Object.values(byPlace).forEach(({ name, orders }) => {
    html += `<div class="mgr-orders-place-header">${esc(name)}</div>`;
    html += orders.map(o => `
      <div class="mgr-order-item">
        <div><strong>${esc(o.colleague_name)}</strong><span style="color:var(--text-muted)"> — ${esc(o.order_text)}</span></div>
        <button class="btn btn-danger btn-xs" data-action="delete-asporto-mgr" data-id="${o.id}">&times;</button>
      </div>`).join('');
  });
  list.innerHTML = html;
}

function mgrGenerateAsportoWA() {
  if (!asportoOrders.length) { showToast('Nessun ordine asporto da aggregare.'); return; }
  const nameInput = document.getElementById('mgr-ordination-name');
  const name = nameInput?.value.trim() || localStorage.getItem('waOrderName_' + userGroupId) || userGroupName;
  // Group by place and build one block per restaurant
  const byPlace = {};
  asportoOrders.forEach(o => {
    const key = o.place_id || 0;
    const pName = o.place_name || places.find(p => p.id === o.place_id)?.name || 'Vario';
    if (!byPlace[key]) byPlace[key] = { name: pName, orders: [] };
    byPlace[key].orders.push(o);
  });
  const blocks = Object.values(byPlace).map(({ name: pName, orders }) => {
    const counts = {};
    orders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    let msg = `[${pName}]\nCiao,\n\n`;
    Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
    msg += `\nGrazie, ${name} x ${orders.length}`;
    return msg.trim();
  });
  document.getElementById('mgr-wa-asporto-text').value = blocks.join('\n\n---\n\n');
  document.getElementById('mgr-wa-asporto-block').style.display = 'block';
}

function renderMgrJoinRequests() {
  const card = document.getElementById('mgr-join-requests-card');
  const list = document.getElementById('mgr-join-requests-list');
  if (!mgrJoinRequests.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  list.innerHTML = mgrJoinRequests.map(r => `
    <div class="mgr-join-item">
      <span class="mgr-join-name">${esc(r.user_name)}</span>
      <div class="row gap-sm">
        <button class="btn btn-primary btn-xs"   data-action="approve-join" data-rid="${r.id}">✓ Approva</button>
        <button class="btn btn-danger btn-xs"    data-action="reject-join"  data-rid="${r.id}">✗ Rifiuta</button>
      </div>
    </div>`).join('');
}

function renderMgrMembers() {
  const list = document.getElementById('mgr-members-list');
  if (!mgrMembers.length) { list.innerHTML = '<p class="empty">Nessun membro.</p>'; return; }
  list.innerHTML = mgrMembers.map(m => {
    const isSelf = m.name === collegeName;
    const isManager = m.role === 'manager';
    return `
    <div class="mgr-member-item">
      <span class="mgr-member-name">${esc(m.name)}</span>
      <span class="role-badge role-${m.role}">${isManager ? '👑 manager' : 'utente'}</span>
      ${!isSelf && isManager  ? `<button class="btn btn-secondary btn-xs" data-action="demote-member"  data-name="${esc(m.name)}" title="Declassa a utente">↓ Utente</button>` : ''}
      ${!isSelf && !isManager ? `<button class="btn btn-secondary btn-xs" data-action="promote-member" data-name="${esc(m.name)}" title="Promuovi a manager">↑ Manager</button>` : ''}
      ${!isSelf ? `<button class="btn btn-danger btn-xs" data-action="remove-member" data-name="${esc(m.name)}" title="Rimuovi">&times;</button>` : ''}
    </div>`;
  }).join('');
}

// Manager actions
async function mgrCloseVoting() {
  let winning_place_id = parseInt(document.getElementById('mgr-force-winner-select').value, 10) || null;
  if (!winning_place_id && allVotes.length > 0) {
    const counts = {};
    allVotes.forEach(v => { counts[v.place_id] = (counts[v.place_id] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topCount = top[0][1];
    const tied = top.filter(([, c]) => c === topCount);
    if (tied.length > 1) {
      showToast(`⚠️ Parità tra: ${tied.map(([pid]) => places.find(p => p.id === parseInt(pid,10))?.name || pid).join(', ')}. Seleziona un vincitore.`);
      return;
    }
    winning_place_id = parseInt(top[0][0], 10);
  }
  await apiFetch(gp(`/session/${today}`), 'PUT',
    { state: 'ordering', winning_place_id, manager_name: collegeName });
  showToast('Votazione chiusa — ordini aperti!');
}
async function mgrReopenVoting() {
  if (!confirm('Riaprire la votazione?')) return;
  await apiFetch(gp(`/session/${today}`), 'PUT', { state: 'voting', winning_place_id: null, manager_name: collegeName });
  showToast('Votazione riaperta.');
}
async function mgrClearVotes() {
  if (!confirm('Azzerare tutti i voti?')) return;
  await apiFetch(gp(`/votes/${today}`), 'DELETE', { manager_name: collegeName });
  showToast('Voti azzerati!');
}
async function mgrForceSplit() {
  const ids = [...document.querySelectorAll('.mgr-split-check:checked')].map(c => parseInt(c.value, 10));
  if (ids.length < 2) { showToast('Seleziona almeno 2 ristoranti per il split.'); return; }
  await apiFetch(gp(`/session/${today}`), 'PUT',
    { state: 'ordering', winning_place_ids: ids, manager_name: collegeName });
  showToast(`Split con ${ids.length} ristoranti!`);
}
async function mgrChangeWinner() {
  const id = parseInt(document.getElementById('mgr-change-winner-select').value, 10) || null;
  await apiFetch(gp(`/session/${today}/winner`), 'PATCH', { winning_place_id: id, manager_name: collegeName });
  showToast('Vincitore aggiornato!');
}
async function mgrCloseSession() {
  if (!confirm('Chiudere la sessione di oggi?')) return;
  await apiFetch(gp(`/session/${today}`), 'PUT', { state: 'closed', manager_name: collegeName });
  showToast('Sessione chiusa.');
}
async function mgrStartTimer() {
  const minutes = parseInt(document.getElementById('mgr-timer-minutes').value, 10);
  if (!minutes || minutes < 1) { showToast('Inserisci un numero di minuti valido.'); return; }
  await apiFetch(gp(`/session/${today}/timer`), 'POST', { minutes, manager_name: collegeName });
}
async function mgrStopTimer() {
  await apiFetch(gp(`/session/${today}/timer`), 'DELETE', { manager_name: collegeName });
}
async function mgrClearOrders() {
  if (!confirm('Cancellare tutti gli ordini del gruppo?')) return;
  await apiFetch(gp(`/orders/${today}`), 'DELETE', { manager_name: collegeName });
  showToast('Ordini cancellati!');
}
async function mgrDeleteOrder(id) {
  await apiFetch(gp(`/orders/${today}/${id}`), 'DELETE', { manager_name: collegeName });
}
async function mgrDeleteAsportoOrder(id) {
  await apiFetch(gp(`/asporto/${today}/${id}`), 'DELETE', { manager_name: collegeName });
}
async function mgrAddMember() {
  const input = document.getElementById('mgr-add-member-input');
  const name  = input.value.trim();
  if (!name) return;
  const res = await apiFetch(gp('/members'), 'POST', { user_name: name, manager_name: collegeName });
  if (res) { input.value = ''; showToast(`${name} aggiunto al gruppo!`); await loadMgrMembers(); }
}
async function mgrRemoveMember(name) {
  const member = mgrMembers.find(m => m.name === name);
  const isManager = member?.role === 'manager';
  if (isManager && !confirm(`${name} è un manager. Rimuovendolo perderà il ruolo di manager. Continuare?`)) return;
  else if (!isManager && !confirm(`Rimuovere ${name} dal gruppo?`)) return;
  await apiFetch(gp(`/members/${encodeURIComponent(name)}`), 'DELETE', { manager_name: collegeName });
  await loadMgrMembers();
}

async function mgrSetMemberRole(name, role) {
  const label = role === 'manager' ? 'manager' : 'utente';
  if (!confirm(`Impostare ${name} come ${label}?`)) return;
  const res = await apiFetch(gp(`/members/${encodeURIComponent(name)}/role`), 'PUT', { role, manager_name: collegeName });
  if (res) { showToast(`${name} è ora ${label}.`); await loadMgrMembers(); }
}
async function mgrApproveJoin(rid) {
  await apiFetch(gp(`/join-requests/${rid}/approve`), 'PUT', { manager_name: collegeName });
  showToast('Richiesta approvata!');
  await loadJoinRequests();
  renderMgrJoinRequests();
  await loadMgrMembers();
}
async function mgrRejectJoin(rid) {
  await apiFetch(gp(`/join-requests/${rid}/reject`), 'PUT', { manager_name: collegeName });
  showToast('Richiesta rifiutata.');
  await loadJoinRequests();
  renderMgrJoinRequests();
}
async function mgrConfirmAndGenerateWA() {
  // If not yet locked, lock first
  if (sessionLockCount() === 0) {
    const res = await apiFetch(gp(`/session/${today}/lock-orders`), 'PUT', { manager_name: collegeName });
    if (!res) return;
    sessionState = { ...sessionState, orders_lock_count: 1 };
    renderMgrLockState();
  }
  mgrGenerateWA();
}

async function mgrUnlockOrders() {
  const res = await apiFetch(gp(`/session/${today}/unlock-orders`), 'PUT', { manager_name: collegeName });
  if (!res) return;
  sessionState = { ...sessionState, orders_lock_count: Math.max(0, sessionLockCount() - 1) };
  renderMgrLockState();
  renderLateRounds();
  showToast('Ordini sbloccati.');
}

function renderMgrLockState() {
  const banner  = document.getElementById('mgr-orders-locked-banner');
  const waBtn   = document.getElementById('btn-mgr-wa');
  const locked  = sessionLockCount() > 0;
  banner.style.display = locked ? 'flex' : 'none';
  if (waBtn) waBtn.textContent = sessionLockCount() > 0 ? '📲 Rigenera WhatsApp' : '🔒 Conferma & WhatsApp';
}

function mgrGenerateWA() {
  const normalOrders = allOrders.filter(o => orderLateRound(o) === 0);
  if (!normalOrders.length) { showToast('Nessun ordine da aggregare.'); return; }
  const nameInput = document.getElementById('location-name');
  if (nameInput) {
    const savedName = localStorage.getItem('waOrderName_' + userGroupId);
    if (!nameInput.value.trim()) nameInput.value = savedName || userGroupName;
    nameInput.onchange = () => {
      if (nameInput.value.trim()) localStorage.setItem('waOrderName_' + userGroupId, nameInput.value.trim());
    };
  }
  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const blocks  = [];
  if (isSplit) {
    sessionState.winning_place_ids.forEach(pid => {
      const placeOrders = normalOrders.filter(o => o.place_id === pid);
      if (!placeOrders.length) return;
      const placeName = places.find(p => p.id === pid)?.name || `#${pid}`;
      blocks.push(`[${placeName}]\n` + buildWAMessage(placeOrders, 'Ciao'));
    });
  } else {
    blocks.push(buildWAMessage(normalOrders, 'Ciao'));
  }
  const text = blocks.join('\n\n---\n\n');
  document.getElementById('mgr-wa-text').value = text;
  document.getElementById('mgr-wa-block').style.display = 'block';
}

function renderLateRounds() {
  const container = document.getElementById('mgr-late-rounds-container');
  if (!container) return;
  const lockCount  = sessionLockCount();
  // Collect all unique late rounds present in orders
  const rounds = [...new Set(allOrders.map(orderLateRound).filter(r => r > 0))].sort((a, b) => a - b);
  if (!rounds.length) { container.innerHTML = ''; return; }
  const multiRound = rounds.length > 1 || lockCount > 1;
  container.innerHTML = rounds.map(round => {
    const roundOrders = allOrders.filter(o => orderLateRound(o) === round);
    const isActive    = round === lockCount;  // still receiving orders
    const isClosed    = round < lockCount;    // already confirmed
    const waText      = lateRoundWATexts[round] || '';
    const title       = multiRound ? `⏰ Ritardatari — Turno ${round}` : '⏰ Ordini in ritardo';
    return `
      <div class="mgr-late-round-section">
        <div class="manager-card-head" style="margin-bottom:8px">
          <h3 class="mgr-late-title">${title}</h3>
          <div class="row gap-sm">
            ${isActive && roundOrders.length ? `<button class="btn btn-whatsapp btn-sm" data-action="confirm-late-round" data-round="${round}">🔒 Conferma & WhatsApp</button>` : ''}
            ${isClosed ? `<button class="btn btn-secondary btn-sm" data-action="regen-late-wa" data-round="${round}">↻ Rigenera</button>` : ''}
          </div>
        </div>
        <div>
          ${roundOrders.map(o => `
            <div class="mgr-order-item mgr-order-late">
              <div><strong>${esc(o.colleague_name)}</strong><span style="color:var(--text-muted)"> — ${esc(o.order_text)}</span></div>
              <button class="btn btn-danger btn-xs" data-action="delete-late-order" data-id="${o.id}">&times;</button>
            </div>`).join('') || '<p class="empty">Nessun ordine ancora.</p>'}
        </div>
        ${waText ? `
        <div style="margin-top:14px">
          <textarea class="mgr-wa-textarea" rows="6" readonly>${esc(waText)}</textarea>
          <div class="row gap-sm" style="justify-content:flex-end; margin-top:8px">
            <button class="btn btn-secondary btn-sm" data-action="copy-late-msg" data-round="${round}">📋 Copia</button>
            <button class="btn btn-whatsapp btn-sm" data-action="send-late-wa" data-round="${round}">📲 Apri WhatsApp</button>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');
}

async function mgrConfirmLateRound(round) {
  // Lock only if this is the currently active round
  if (round === sessionLockCount()) {
    const res = await apiFetch(gp(`/session/${today}/lock-orders`), 'PUT', { manager_name: collegeName });
    if (!res) return;
    sessionState = { ...sessionState, orders_lock_count: sessionLockCount() + 1 };
    renderMgrLockState();
  }
  const roundOrders = allOrders.filter(o => orderLateRound(o) === round);
  lateRoundWATexts[round] = buildLateRoundWA(roundOrders);
  renderLateRounds();
}

function mgrRegenLateWA(round) {
  const roundOrders = allOrders.filter(o => orderLateRound(o) === round);
  if (!roundOrders.length) { showToast('Nessun ordine in questo turno.'); return; }
  lateRoundWATexts[round] = buildLateRoundWA(roundOrders);
  renderLateRounds();
}

function buildLateRoundWA(orders) {
  if (!orders.length) return '';
  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const blocks  = [];
  if (isSplit) {
    sessionState.winning_place_ids.forEach(pid => {
      const placeOrders = orders.filter(o => o.place_id === pid);
      if (!placeOrders.length) return;
      const placeName = places.find(p => p.id === pid)?.name || `#${pid}`;
      blocks.push(`[${placeName}]\n` + buildWAMessage(placeOrders, 'Aggiungo'));
    });
  } else {
    blocks.push(buildWAMessage(orders, 'Aggiungo'));
  }
  return blocks.join('\n\n---\n\n');
}

function buildWAMessage(orders, greeting = 'Ciao') {
  const counts = {};
  orders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
  const nameInput = document.getElementById('mgr-ordination-name');
  const name = nameInput?.value.trim() || localStorage.getItem('waOrderName_' + userGroupId) || userGroupName;
  if (name && name !== userGroupName) localStorage.setItem('waOrderName_' + userGroupId, name);
  let msg = `${greeting},\n\n`;
  Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
  msg += `\nGrazie, ${name} x ${orders.length}`;
  return msg.trim();
}
async function mgrCopyMsg() {
  const text = document.getElementById('mgr-wa-text').value;
  try { await navigator.clipboard.writeText(text); showToast('Copiato!'); }
  catch (_) { showToast('Copia fallita.'); }
}
function mgrOpenWA() {
  const text = document.getElementById('mgr-wa-text').value;
  if (!text.trim()) return;
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener,noreferrer');
}


// ═══ RESTAURANT ════════════════════════════════════════════

// State for restaurant dashboard
let restaurantOrders   = [];   // [{group_id, group_name, last_order_at, orders:[...]}]
let restaurantAsporto  = [];   // flat list
let restaurantDishes   = [];   // [{id, name}] — dish library for this place
let restaurantStatus   = {};   // {closed, max_orders, notes}
let restaurantSort     = 'newest';  // 'newest' | 'oldest' | 'alpha'
let restaurantCollapsed = new Set(); // group_ids that are collapsed

// Fetch with JWT Bearer token (used by restaurant for requireRestaurant endpoints)
async function restaurantApiFetch(path, method = 'GET', body = null) {
  const token = restaurantToken || sessionStorage.getItem('restaurantToken');
  try {
    const opts = { method, headers: { 'Authorization': `Bearer ${token}` } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`Errore: ${err.error || res.statusText}`);
      return null;
    }
    return res.json();
  } catch (_) {
    return null;
  }
}

async function startRestaurantApp() {
  // Restore token from sessionStorage if available
  restaurantToken = sessionStorage.getItem('restaurantToken') || null;
  // Set today's date in both date pickers
  document.getElementById('restaurant-date').value = today;
  document.getElementById('restaurant-menu-date').value = today;
  // Show restaurant screen
  showScreen('restaurant');
  connectWebSocket();
  await Promise.all([
    refreshRestaurantOrders(),
    loadRestaurantMenu(),
    loadRestaurantDishes(),
    loadRestaurantStatus(),
  ]);
}

async function refreshRestaurantOrders() {
  const date = document.getElementById('restaurant-date').value || today;
  const [tables, asporto] = await Promise.all([
    restaurantApiFetch(`/restaurant/orders/${date}`),
    restaurantApiFetch(`/restaurant/asporto/${date}`)
  ]);
  restaurantOrders  = tables  || [];
  restaurantAsporto = asporto || [];
  renderRestaurantScreen();
}

function renderRestaurantScreen() {
  const activeRtab = document.querySelector('.rtab-btn.active')?.dataset?.rtab || 'orders';
  if (activeRtab === 'orders')  renderRestaurantOrders();
  if (activeRtab === 'summary') renderRestaurantSummary();
  if (activeRtab === 'asporto') renderRestaurantAsportoTab();
}

function renderRestaurantOrders() {
  const container = document.getElementById('restaurant-tables-list');
  const countEl   = document.getElementById('restaurant-orders-count');

  // Sort
  let tables = [...restaurantOrders];
  if (restaurantSort === 'newest') tables.sort((a, b) => (b.last_order_at || '').localeCompare(a.last_order_at || ''));
  else if (restaurantSort === 'oldest') tables.sort((a, b) => (a.first_order_at || '').localeCompare(b.first_order_at || ''));
  else tables.sort((a, b) => a.group_name.localeCompare(b.group_name, 'it'));

  // Only show groups that have at least one order
  tables = tables.filter(t => t.orders.length > 0);

  const totalOrders = tables.reduce((s, t) => s + t.orders.length, 0);
  if (countEl) countEl.textContent = tables.length
    ? `${tables.length} ${tables.length === 1 ? 'tavolo' : 'tavoli'} · ${totalOrders} ${totalOrders === 1 ? 'ordine' : 'ordini'}`
    : '';

  if (!tables.length) {
    container.innerHTML = '<p class="empty">Nessun ordine per questa data.</p>';
    return;
  }

  container.innerHTML = tables.map(table => {
    const collapsed = restaurantCollapsed.has(table.group_id);
    const orderRows = table.orders.map(o => {
      const timeStr = fmtTime(o.created_at);
      return `
        <div class="restaurant-order-row${o.is_late ? ' restaurant-order-late' : ''}">
          <span class="restaurant-order-name">${esc(o.colleague_name)}</span>
          <span class="restaurant-order-text">${esc(o.order_text)}</span>
          ${o.is_late ? `<span class="restaurant-late-badge">+ritardo</span>` : ''}
          ${timeStr}
        </div>`;
    }).join('');
    const lastTime = table.last_order_at ? fmtTime(table.last_order_at) : '';
    return `
      <div class="restaurant-table-card" data-group="${table.group_id}">
        <div class="restaurant-table-head restaurant-table-toggle" data-group="${table.group_id}">
          <span class="restaurant-table-icon">🪑</span>
          <strong class="restaurant-table-name">${esc(table.group_name)}</strong>
          <span class="restaurant-table-count">&times;${table.orders.length}</span>
          <span class="restaurant-table-time">${lastTime}</span>
          <span class="restaurant-collapse-icon">${collapsed ? '▶' : '▼'}</span>
        </div>
        <div class="restaurant-table-orders${collapsed ? ' hidden' : ''}">${orderRows}</div>
      </div>`;
  }).join('');

  // Collapse/expand via event delegation
  container.querySelectorAll('.restaurant-table-toggle').forEach(el => {
    el.addEventListener('click', () => {
      const gid = parseInt(el.dataset.group, 10);
      if (restaurantCollapsed.has(gid)) restaurantCollapsed.delete(gid);
      else restaurantCollapsed.add(gid);
      renderRestaurantOrders();
    });
  });
}

function renderRestaurantSummary() {
  const dateLabel = document.getElementById('restaurant-summary-date');
  const date = document.getElementById('restaurant-date').value || today;
  dateLabel.textContent = new Date(date + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  const dishContainer = document.getElementById('restaurant-dish-aggregate');
  const allOrds = restaurantOrders.flatMap(t => t.orders);
  if (!allOrds.length) {
    dishContainer.innerHTML = '<p class="empty">Nessun ordine per questa data.</p>';
  } else {
    const counts = {};
    allOrds.forEach(o => {
      const parts = o.order_text.split(',').map(s => s.trim()).filter(Boolean);
      parts.forEach(p => { const k = p.toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    dishContainer.innerHTML = `
      <div class="restaurant-aggregate-total">
        Totale ordini: <strong>${allOrds.length}</strong> da <strong>${restaurantOrders.length}</strong> ${restaurantOrders.length === 1 ? 'tavolo' : 'tavoli'}
      </div>
      <ul class="restaurant-dish-list">
        ${sorted.map(([dish, count]) => `
          <li class="restaurant-dish-row">
            <span class="restaurant-dish-count">&times;${count}</span>
            <span class="restaurant-dish-name">${esc(dish)}</span>
          </li>`).join('')}
      </ul>`;
  }

  const asportoContainer = document.getElementById('restaurant-asporto-aggregate');
  if (!restaurantAsporto.length) {
    asportoContainer.innerHTML = '<p class="empty" style="font-size:0.85rem">Nessun asporto.</p>';
  } else {
    const aCounts = {};
    restaurantAsporto.forEach(o => {
      const parts = o.order_text.split(',').map(s => s.trim()).filter(Boolean);
      parts.forEach(p => { const k = p.toLowerCase(); aCounts[k] = (aCounts[k] || 0) + 1; });
    });
    const aSorted = Object.entries(aCounts).sort((a, b) => b[1] - a[1]);
    asportoContainer.innerHTML = `
      <div class="restaurant-aggregate-total" style="font-size:0.85rem">
        Totale asporto: <strong>${restaurantAsporto.length}</strong>
      </div>
      <ul class="restaurant-dish-list">
        ${aSorted.map(([dish, count]) => `
          <li class="restaurant-dish-row">
            <span class="restaurant-dish-count">&times;${count}</span>
            <span class="restaurant-dish-name">${esc(dish)}</span>
          </li>`).join('')}
      </ul>`;
  }
}

function renderRestaurantAsportoTab() {
  const container = document.getElementById('restaurant-asporto-list');
  if (!restaurantAsporto.length) {
    container.innerHTML = '<p class="empty">Nessun ordine asporto per questa data.</p>';
    return;
  }
  container.innerHTML = restaurantAsporto.map(o => `
    <div class="restaurant-asporto-row">
      <div class="restaurant-asporto-info">
        <strong>${esc(o.colleague_name)}</strong>
        ${o.location ? `<span class="restaurant-asporto-location">📍 ${esc(o.location)}</span>` : ''}
      </div>
      <span class="restaurant-asporto-text">${esc(o.order_text)}</span>
      ${fmtTime(o.created_at)}
    </div>`).join('');
}

async function loadRestaurantMenu() {
  const date = document.getElementById('restaurant-menu-date').value || today;
  const [menu, status] = await Promise.all([
    restaurantApiFetch(`/restaurant/menus/${date}`),
    restaurantApiFetch(`/restaurant/status/${date}`)
  ]);
  if (menu !== null) {
    document.getElementById('restaurant-menu-text').value = menu.menu_text || '';
    const maxEl = document.getElementById('restaurant-menu-maxdishes');
    if (maxEl) maxEl.value = menu.max_dishes || 0;
  }
  if (status) {
    restaurantStatus = status;
    const closedEl = document.getElementById('restaurant-closed-toggle');
    const maxOrdEl = document.getElementById('restaurant-max-orders');
    if (closedEl) closedEl.checked = !!status.closed;
    if (maxOrdEl) maxOrdEl.value  = status.max_orders || 0;
  }
}

async function saveRestaurantMenu() {
  const date      = document.getElementById('restaurant-menu-date').value || today;
  const menu_text = document.getElementById('restaurant-menu-text').value;
  const max_dishes = parseInt(document.getElementById('restaurant-menu-maxdishes')?.value, 10) || 0;
  const res = await restaurantApiFetch('/restaurant/menus', 'POST', { date, menu_text, max_dishes });
  if (res) {
    showToast('✅ Menu salvato!');
    // Refresh dish library — saving menu auto-adds new lines as dishes
    await loadRestaurantDishes();
  }
}

async function saveRestaurantStatus() {
  const date      = document.getElementById('restaurant-menu-date').value || today;
  const closed    = document.getElementById('restaurant-closed-toggle')?.checked || false;
  const max_orders = parseInt(document.getElementById('restaurant-max-orders')?.value, 10) || 0;
  const res = await restaurantApiFetch('/restaurant/status', 'POST', { date, closed, max_orders });
  if (res) showToast(closed ? '🚫 Ristorante chiuso per questa data.' : '✅ Stato aggiornato.');
}

// ── Dish library ──────────────────────────────────────────────
async function loadRestaurantDishes() {
  const dishes = await restaurantApiFetch('/restaurant/dishes');
  if (dishes) {
    restaurantDishes = dishes;
    renderDishChips();
  }
}

function renderDishChips() {
  const container = document.getElementById('restaurant-dish-chips');
  if (!container) return;
  if (!restaurantDishes.length) {
    container.innerHTML = '<span class="empty" style="font-size:0.82rem">Nessun piatto salvato.</span>';
    return;
  }
  container.innerHTML = restaurantDishes.map(d => `
    <span class="dish-chip" data-id="${d.id}" data-name="${esc(d.name)}">
      ${esc(d.name)}
      <button class="dish-chip-del" data-id="${d.id}" title="Rimuovi dalla lista">×</button>
    </span>`).join('');

  // Click chip → append to menu textarea
  container.querySelectorAll('.dish-chip').forEach(chip => {
    chip.addEventListener('click', e => {
      if (e.target.classList.contains('dish-chip-del')) return;
      const name = chip.dataset.name;
      const ta = document.getElementById('restaurant-menu-text');
      const val = ta.value.trim();
      ta.value = val ? val + '\n' + name : name;
      ta.focus();
    });
  });

  // Click × → delete dish from library
  container.querySelectorAll('.dish-chip-del').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = parseInt(btn.dataset.id, 10);
      const res = await restaurantApiFetch(`/restaurant/dishes/${id}`, 'DELETE');
      if (res) {
        restaurantDishes = restaurantDishes.filter(d => d.id !== id);
        renderDishChips();
      }
    });
  });
}

async function addRestaurantDish() {
  const input = document.getElementById('restaurant-new-dish');
  const name = input?.value.trim();
  if (!name) { input?.focus(); return; }
  const res = await restaurantApiFetch('/restaurant/dishes', 'POST', { name });
  if (res) {
    input.value = '';
    restaurantDishes.push(res);
    restaurantDishes.sort((a, b) => a.name.localeCompare(b.name, 'it'));
    renderDishChips();
  }
}
