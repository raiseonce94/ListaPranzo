'use strict';

const API    = `${window.location.origin}/api`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

let ws               = null;
let wsReconnectTimer = null;
let collegeName      = localStorage.getItem('collegeName') || '';
let places           = [];
let menus            = [];
let sessionState     = { state: 'voting', winning_place_id: null, winning_place_ids: [] };
let selectedPlaceIds = new Set();
let hasVoted         = false;
let hasOrdered       = false;
let currentOrderText = '';
let selectedOrderPlaceId = null; // which place user picked in split mode
let allOrders        = []; // all orders for today, shown after user has ordered
let loginStep        = 'name'; // 'name' | 'password' | 'set-password'
let timerInterval    = null;
let preOrders = {}; // { [placeId]: { checks: [...], custom: '' } }
let allVotes  = []; // all votes for today
let asportoOrders    = []; // all asporto orders for today
let myAsportoOrders  = []; // my own asporto orders today
let asportoPrevScreen = 'voting'; // screen to return to from asporto
const today = new Date().toISOString().split('T')[0];

async function loadPreOrders() {
  const rows = await apiFetch(`/preorders/${today}/${encodeURIComponent(collegeName)}`);
  if (rows) {
    preOrders = {};
    rows.forEach(r => { preOrders[r.place_id] = { checks: r.checks || [], custom: r.custom || '' }; });
  }
}

async function savePreOrderForPlace(placeId, data) {
  preOrders[placeId] = data;
  apiFetch(`/preorders/${today}/${encodeURIComponent(collegeName)}/${placeId}`, 'PUT', data);
}

// ── Init ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('today-label').textContent =
    new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

  // Reload when the calendar day rolls over (handles overnight open tabs)
  setInterval(() => {
    if (new Date().toISOString().split('T')[0] !== today) window.location.reload();
  }, 60000);

  document.getElementById('login-btn').addEventListener('click', login);
  document.getElementById('login-back').addEventListener('click', loginBack);
  ['login-name', 'login-password', 'login-password2'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  });

  document.getElementById('btn-change-name').addEventListener('click', changeName);
  document.getElementById('btn-change-password').addEventListener('click', changePassword);
  document.getElementById('btn-submit-vote').addEventListener('click', submitVote);
  document.getElementById('btn-change-vote').addEventListener('click', changeVote);
  document.getElementById('btn-submit-order').addEventListener('click', submitOrder);
  document.getElementById('btn-edit-order').addEventListener('click', editOrder);
  document.getElementById('btn-cancel-order').addEventListener('click', cancelOrder);
  ['btn-asporto-vote', 'btn-asporto-order', 'btn-asporto-confirm'].forEach(id =>
    document.getElementById(id).addEventListener('click', showAsportoScreen)
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

  // Event delegation for place card selection
  document.getElementById('places-list').addEventListener('click', e => {
    if (e.target.closest('.preorder-panel') || e.target.closest('.btn-preorder')) return;
    const card = e.target.closest('.place-card');
    if (card && !hasVoted) selectPlace(parseInt(card.dataset.placeId, 10));
  });

  // Pre-order: toggle panel
  document.getElementById('places-list').addEventListener('click', e => {
    const btn = e.target.closest('.btn-preorder');
    if (!btn) return;
    e.stopPropagation();
    const panel = document.getElementById(`preorder-panel-${btn.dataset.placeId}`);
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // Pre-order: auto-save on checkbox/textarea change (bubbles from place cards)
  document.getElementById('places-list').addEventListener('change', e => {
    if (!e.target.closest('.preorder-panel')) return;
    const panel   = e.target.closest('.preorder-panel');
    const placeId = parseInt(panel.dataset.placeId, 10);
    const checks  = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    const custom  = (panel.querySelector('.preorder-custom')?.value || '');
    savePreOrderForPlace(placeId, { checks, custom });
    const badge = document.getElementById(`preorder-badge-${placeId}`);
    if (badge) badge.style.display = checks.length || custom ? 'inline' : 'none';
  });

  document.getElementById('places-list').addEventListener('input', e => {
    if (!e.target.classList.contains('preorder-custom')) return;
    const panel   = e.target.closest('.preorder-panel');
    const placeId = parseInt(panel.dataset.placeId, 10);
    const checks  = [...panel.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);
    const custom  = e.target.value;
    savePreOrderForPlace(placeId, { checks, custom });
    const badge = document.getElementById(`preorder-badge-${placeId}`);
    if (badge) badge.style.display = checks.length || custom ? 'inline' : 'none';
  });


  if (collegeName) {
    startApp();
  }
});

// ── Login ─────────────────────────────────────────────────

async function login() {
  if (loginStep === 'name') {
    const name = document.getElementById('login-name').value.trim();
    if (!name) return;
    const res = await apiFetch(`/users/exists/${encodeURIComponent(name)}`);
    if (res === null) return;
    if (res.exists) {
      loginStep = 'password';
      document.getElementById('login-subtitle').textContent = `Ciao ${name}! Inserisci la tua password.`;
      document.getElementById('login-pw-section').style.display = 'block';
      document.getElementById('login-name').disabled = true;
      document.getElementById('login-btn').textContent = 'Accedi →';
      document.getElementById('login-back').style.display = 'block';
      document.getElementById('login-password').focus();
    } else {
      loginStep = 'set-password';
      document.getElementById('login-subtitle').textContent = 'Nuovo utente! Scegli una password.';
      document.getElementById('login-pw-section').style.display = 'block';
      document.getElementById('login-password2').style.display = 'block';
      document.getElementById('login-name').disabled = true;
      document.getElementById('login-btn').textContent = 'Registrati →';
      document.getElementById('login-back').style.display = 'block';
      document.getElementById('login-password').focus();
    }
    return;
  }
  const name = document.getElementById('login-name').value.trim();
  if (loginStep === 'password') {
    const password = document.getElementById('login-password').value;
    if (!password) return;
    const res = await apiFetch('/users/login', 'POST', { name, password });
    if (!res) return;
    collegeName = name;
    localStorage.setItem('collegeName', name);
    startApp();
    return;
  }
  if (loginStep === 'set-password') {
    const password = document.getElementById('login-password').value;
    const confirm  = document.getElementById('login-password2').value;
    if (!password) return;
    if (password !== confirm) { alert('Le password non coincidono.'); return; }
    const res = await apiFetch('/users/register', 'POST', { name, password });
    if (!res) return;
    collegeName = name;
    localStorage.setItem('collegeName', name);
    startApp();
  }
}

function loginBack() {
  loginStep = 'name';
  document.getElementById('login-subtitle').textContent = 'Inserisci il tuo nome per iniziare';
  document.getElementById('login-name').disabled = false;
  document.getElementById('login-pw-section').style.display = 'none';
  document.getElementById('login-password2').style.display = 'none';
  document.getElementById('login-password').value = '';
  document.getElementById('login-password2').value = '';
  document.getElementById('login-btn').textContent = 'Continua →';
  document.getElementById('login-back').style.display = 'none';
}

function changeName() {
  localStorage.removeItem('collegeName');
  collegeName = '';
  hasVoted = false;
  hasOrdered = false;
  selectedPlaceIds = new Set();
  allVotes = [];
  loginBack();
  showScreen('login');
}

async function changePassword() {
  const oldPw = prompt('Password attuale:');
  if (oldPw === null) return;
  const newPw = prompt('Nuova password:');
  if (!newPw || !newPw.trim()) return;
  const confirm = prompt('Conferma nuova password:');
  if (newPw !== confirm) { alert('Le password non coincidono.'); return; }
  const res = await apiFetch('/users/change-password', 'POST', {
    name: collegeName, old_password: oldPw, new_password: newPw
  });
  if (res) alert('✅ Password cambiata con successo!');
}

async function startApp() {
  // Verify user still exists in backend (handles server resets)
  if (collegeName) {
    const check = await apiFetch(`/users/exists/${encodeURIComponent(collegeName)}`).catch(() => null);
    if (!check || !check.exists) {
      localStorage.removeItem('collegeName');
      collegeName = '';
      loginBack();
      showScreen('login');
      return;
    }
  }
  updateNameDisplays();
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
  document.getElementById('hdr-name-vote').textContent    = collegeName;
  document.getElementById('hdr-name-order').textContent   = collegeName;
  document.getElementById('hdr-name-confirm').textContent = collegeName;
  document.getElementById('hdr-name-asporto').textContent = collegeName;
}

// ── Screen routing ────────────────────────────────────────

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`).classList.add('active');
}

function updateScreen() {
  if (!collegeName) { showScreen('login'); return; }

  if (sessionState.state === 'voting') {
    selectedOrderPlaceId = null;
    showScreen('voting');
    renderVotingScreen();
    return;
  }

  if (sessionState.state === 'ordering') {
    if (hasOrdered) {
      updateCancelButtonVisibility();
      showScreen('confirmation');
      return;
    }
    showScreen('ordering');
    renderOrderingScreen();
    return;
  }

  // closed
  updateCancelButtonVisibility();
  showScreen('confirmation');
}

function updateCancelButtonVisibility() {
  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const btn = document.getElementById('btn-cancel-order');
  btn.style.display = (isSplit && sessionState.state === 'ordering') ? 'block' : 'none';
}

// ── WebSocket ─────────────────────────────────────────────

function connectWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    clearTimeout(wsReconnectTimer);
    setDots(true);
  };

  ws.onmessage = ev => {
    try { handleWSMessage(JSON.parse(ev.data)); } catch (_) {}
  };

  ws.onclose = () => {
    setDots(false);
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

function setDots(connected) {
  const cls = connected ? 'dot dot-on' : 'dot dot-off';
  document.getElementById('ws-dot-vote').className    = cls;
  document.getElementById('ws-dot-order').className   = cls;
  document.getElementById('ws-dot-confirm').className = cls;
  document.getElementById('ws-dot-asporto').className = cls;
}

async function handleWSMessage(data) {
  switch (data.type) {
    case 'places_updated':
      loadPlaces().then(() => { if (sessionState.state === 'voting') renderVotingScreen(); });
      break;
    case 'menus_updated':
      if (data.date === today)
        loadMenus().then(() => { if (sessionState.state === 'voting') renderVotingScreen(); });
      break;
    case 'session_updated':
      if (data.session.date === today) {
        sessionState = data.session;
        if (sessionState.state === 'ordering') {
          const autoSent = await autoSubmitFromPreOrder();
          if (!autoSent) updateScreen();
        } else {
          updateScreen();
          if (sessionState.state === 'voting') updateTimerDisplay();
        }
      }
      break;
    case 'votes_updated':
      if (data.date === today) {
        allVotes = data.votes || [];
        // Sync client vote state with server (e.g. after admin resets votes)
        const myVotes = allVotes.filter(v => v.colleague_name === collegeName);
        if (myVotes.length) {
          hasVoted = true;
          selectedPlaceIds = new Set(myVotes.map(v => v.place_id));
        } else if (hasVoted) {
          hasVoted = false;
          selectedPlaceIds = new Set();
        }
        if (sessionState.state === 'voting') renderVotingScreen();
      }
      break;
    case 'orders_updated':
      if (data.date === today) {
        allOrders = data.orders || [];
        if (hasOrdered) renderConfirmationOrders();
      }
      break;
    case 'asporto_updated':
      if (data.date === today) {
        asportoOrders = data.orders || [];
        myAsportoOrders = asportoOrders.filter(o => o.colleague_name === collegeName);
        if (document.getElementById('screen-asporto').classList.contains('active')) {
          renderMyAsportoOrders();
          renderAsportoScreen();
        }
      }
      break;
  }
}

// ── Auto-submit from pre-order ───────────────────────────

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
        if (!candidates.length) return null;
        // If the user has pre-orders for more than one split place, let them choose manually
        if (candidates.length > 1) return null;
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
  const res = await apiFetch('/orders', 'POST', {
    colleague_name: collegeName,
    place_id: pid,
    order_text: orderText,
    date: today
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

async function loadAllOrders() {
  const orders = await apiFetch(`/orders/${today}`);
  if (orders) allOrders = orders;
}

function renderConfirmationOrders() {
  const container = document.getElementById('all-orders-list');
  if (!container) return;

  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const myPlaceId = selectedOrderPlaceId || sessionState.winning_place_id;

  // In split mode show only colleagues ordering from the same place
  const others = allOrders.filter(o => {
    if (o.colleague_name === collegeName) return false;
    if (isSplit && myPlaceId != null) return o.place_id === myPlaceId;
    return true;
  });

  const label = isSplit && myPlaceId != null
    ? (() => {
        const place = places.find(p => p.id === myPlaceId);
        return place ? `Colleghi che ordinano da <strong>${esc(place.name)}</strong>` : 'Colleghi dello stesso posto';
      })()
    : 'Ordini dei colleghi';

  const titleEl = container.closest('.card')?.querySelector('.confirm-orders-title');
  if (titleEl) titleEl.innerHTML = label;

  if (!others.length) {
    container.innerHTML = '<em class="empty-orders-msg">Nessun altro ordine ancora.</em>';
    return;
  }
  container.innerHTML = others.map(o => `
    <div class="confirm-order-item">
      <span class="confirm-order-name">${esc(o.colleague_name)}</span>
      <span class="confirm-order-text">${esc(o.order_text)}</span>
    </div>`).join('');
}

// ── Data loading ──────────────────────────────────────────

async function loadSession() {
  const s = await apiFetch(`/session/${today}`);
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
  const v = await apiFetch(`/votes/${today}`);
  if (v) allVotes = v;
}

async function loadAsportoOrders() {
  const a = await apiFetch(`/asporto/${today}`);
  if (a) {
    asportoOrders = a;
    myAsportoOrders = a.filter(o => o.colleague_name === collegeName);
  }
}

async function checkMyVote() {
  const votes = await apiFetch(`/votes/${today}`);
  if (!votes) return;
  const mine = votes.filter(v => v.colleague_name === collegeName);
  if (mine.length) {
    hasVoted = true;
    selectedPlaceIds = new Set(mine.map(v => v.place_id));
  }
}

async function checkMyOrder() {
  const orders = await apiFetch(`/orders/${today}`);
  if (!orders) return;
  const mine = orders.find(o => o.colleague_name === collegeName);
  if (mine) {
    hasOrdered = true;
    currentOrderText = mine.order_text;
    setConfirmText(mine.order_text);
  }
}

function setConfirmText(text) {
  document.getElementById('confirm-text').textContent =
    `Il tuo ordine è stato ricevuto: "${text}"`;
}

function editOrder() {
  hasOrdered = false;
  // Parse the previously submitted order text back into pre-order state
  // so all checkboxes are pre-filled when the user edits
  const pid = selectedOrderPlaceId || sessionState.winning_place_id;
  if (pid && currentOrderText) {
    const winningPlace = places.find(p => p.id === pid);
    const winningMenu  = menus.find(m => m.place_id === pid);
    const menuLines    = (winningMenu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
    const presetLines  = winningPlace?.presets || [];
    const knownItems   = new Set([...menuLines, ...presetLines]);
    const parts        = currentOrderText.split(',').map(s => s.trim()).filter(s => s);
    const checks       = parts.filter(p => knownItems.has(p));
    const custom       = parts.filter(p => !knownItems.has(p)).join(', ');
    preOrders[pid] = { checks, custom };
  }
  renderOrderingScreen();
  showScreen('ordering');
}

async function cancelOrder() {
  if (!confirm('Annullare il tuo ordine e scegliere un altro posto?')) return;
  // Delete current order from server
  const myOrder = allOrders.find(o => o.colleague_name === collegeName);
  if (myOrder?.id) {
    await apiFetch(`/orders/${today}/${myOrder.id}`, 'DELETE');
  }
  hasOrdered = false;
  currentOrderText = '';
  selectedOrderPlaceId = null;
  renderOrderingScreen();
  showScreen('ordering');
}

// ── Voting screen ─────────────────────────────────────────

function selectPlace(placeId) {
  if (hasVoted) return;
  if (selectedPlaceIds.has(placeId)) {
    selectedPlaceIds.delete(placeId);
  } else {
    selectedPlaceIds.add(placeId);
  }
  renderVotingScreen();
}

function renderVotingScreen() {
  const list = document.getElementById('places-list');

  if (!places.length) {
    list.innerHTML = '<p class="empty">L\'admin non ha ancora aggiunto ristoranti.</p>';
  } else {
    const totalVotes = allVotes.length;
    list.innerHTML = places.map((place, _i) => {
      const menu       = menus.find(m => m.place_id === place.id);
      const isSelected = selectedPlaceIds.has(place.id);
      const po         = preOrders[place.id] || { checks: [], custom: '' };
      const hasPreorder = po.checks.length > 0 || po.custom;
      const menuLines  = (menu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
      const voteCount  = allVotes.filter(v => v.place_id === place.id).length;
      const votePct    = totalVotes > 0 ? Math.round(voteCount / totalVotes * 100) : 0;

      const checkboxesHtml = (() => {
        const presetLines = place.presets || [];
        let html = '';
        if (menuLines.length) {
          html += '<p class="checkbox-group-label">Menu del giorno:</p>';
          html += menuLines.map(line => `
            <label class="preorder-check-item">
              <input type="checkbox" value="${esc(line)}" ${po.checks.includes(line) ? 'checked' : ''} />
              <span>${esc(line)}</span>
            </label>`).join('');
        }
        if (presetLines.length) {
          html += '<p class="checkbox-group-label">Sempre disponibili:</p>';
          html += presetLines.map(line => `
            <label class="preorder-check-item">
              <input type="checkbox" value="${esc(line)}" ${po.checks.includes(line) ? 'checked' : ''} />
              <span>${esc(line)}</span>
            </label>`).join('');
        }
        if (!menuLines.length && !presetLines.length) {
          html = '<em class="empty-check">Nessuna voce di menu o preset disponibile.</em>';
        }
        return html;
      })();

      return `
        <div class="place-card ${isSelected ? 'selected' : ''} ${hasVoted ? 'voted' : ''}"
             style="--delay:${_i * 0.06}s"
             data-place-id="${place.id}">
          <div class="place-card-header">
            <strong>${esc(place.name)}</strong>
            <div class="card-header-right">
              ${isSelected ? '<span class="sel-badge">✓ Tua scelta</span>' : ''}
              <span id="preorder-badge-${place.id}" class="preorder-badge" style="display:${hasPreorder ? 'inline' : 'none'}">📝</span>
              <button class="btn-preorder" data-place-id="${place.id}" title="Pre-ordina per questo posto">Pre-ordina</button>
            </div>
          </div>
          ${place.description ? `<p class="place-desc-text">${esc(place.description)}</p>` : ''}
          ${voteCount > 0 ? `<div class="place-vote-bar"><span class="place-vote-count">${voteCount} vot${voteCount === 1 ? 'o' : 'i'} · ${votePct}%</span><div class="place-vote-fill" style="width:${votePct}%"></div></div>` : ''}
          <div class="place-menu-text">
            ${menu && menu.menu_text
              ? `<pre>${esc(menu.menu_text)}</pre>`
              : '<em>Menu non ancora disponibile</em>'}
          </div>
          <div id="preorder-panel-${place.id}" class="preorder-panel" data-place-id="${place.id}" style="display:none">
            <p class="preorder-panel-title">Il tuo pre-ordine per <strong>${esc(place.name)}</strong>:</p>
            <div class="preorder-checks">${checkboxesHtml}</div>
            <textarea class="preorder-custom" rows="2" placeholder="Variazione o aggiunta…">${esc(po.custom)}</textarea>
          </div>
        </div>`;
    }).join('');
  }

  const submitBtn    = document.getElementById('btn-submit-vote');
  const alreadyVoted = document.getElementById('already-voted');

  updateTimerDisplay();

  if (hasVoted) {
    submitBtn.style.display    = 'none';
    alreadyVoted.style.display = 'flex';
  } else {
    submitBtn.style.display    = 'block';
    submitBtn.disabled         = selectedPlaceIds.size === 0;
    submitBtn.textContent      = selectedPlaceIds.size > 1
      ? `Vota (${selectedPlaceIds.size} posti)`
      : 'Vota';
    alreadyVoted.style.display = 'none';
  }
}

async function submitVote() {
  if (!selectedPlaceIds.size || hasVoted) return;
  if (!collegeName) { showScreen('login'); return; }
  const res = await apiFetch('/votes', 'POST', {
    place_ids: [...selectedPlaceIds],
    colleague_name: collegeName,
    date: today
  });
  if (res) {
    hasVoted = true;
    renderVotingScreen();
  }
}

function changeVote() {
  hasVoted = false;
  renderVotingScreen();
}

// ── Ordering screen ───────────────────────────────────────

function renderOrderingScreen() {
  const splitPids = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1
    ? sessionState.winning_place_ids : [];
  const isSplit     = splitPids.length > 0;
  const pickSection = document.getElementById('split-pick-section');
  const formSection = document.getElementById('order-form-section');

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

  // Show vote results
  const summaryEl = document.getElementById('order-votes-summary');
  if (summaryEl) {
    if (allVotes.length > 0) {
      const groups = {};
      allVotes.forEach(v => {
        if (!groups[v.place_id]) groups[v.place_id] = { name: v.place_name || (places.find(p => p.id === v.place_id)?.name || ''), count: 0 };
        groups[v.place_id].count++;
      });
      const sorted = Object.entries(groups).sort((a, b) => b[1].count - a[1].count);
      summaryEl.innerHTML = '<strong>📊 Risultati votazione:</strong> ' +
        sorted.map(([, g]) => `${esc(g.name)}: <strong>${g.count}</strong>`).join(' &nbsp;·&nbsp; ');
      summaryEl.style.display = 'block';
    } else {
      summaryEl.style.display = 'none';
    }
  }

  const container = document.getElementById('menu-checkboxes');
  const menuText  = winningMenu?.menu_text || '';
  const menuLines = menuText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const presetLines = winningPlace?.presets || [];

  // Pre-fill from pre-orders if available
  const po = preOrders[pid] || { checks: [], custom: '' };

  const maxDishes = winningPlace?.max_dishes || 0; // 0 = no limit
  const limitLabel = maxDishes > 0
    ? `<span id="dishes-limit-label" class="dishes-limit-label">Seleziona al massimo <strong>${maxDishes}</strong> ${maxDishes === 1 ? 'piatto' : 'piatti'}</span>`
    : '';

  let html = limitLabel;
  if (menuLines.length) {
    html += '<p class="checkbox-group-label">Menu del giorno:</p>';
    html += menuLines.map((line, i) => `
      <label class="menu-check-item" style="animation:fadeUp 0.28s var(--ease) ${i * 0.05}s both">
        <input type="checkbox" name="menu-item" value="${esc(line)}" id="mc-${i}" ${po.checks.includes(line) ? 'checked' : ''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (presetLines.length) {
    html += `<p class="checkbox-group-label" style="margin-top:10px">Sempre disponibili:</p>`;
    html += presetLines.map((line, i) => `
      <label class="menu-check-item" style="animation:fadeUp 0.28s var(--ease) ${(menuLines.length + i) * 0.05}s both">
        <input type="checkbox" name="menu-item" value="${esc(line)}" id="pc-${i}" ${po.checks.includes(line) ? 'checked' : ''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (!menuLines.length && !presetLines.length) {
    html = '<em class="empty-check">Nessuna voce di menu — usa il campo sotto.</em>';
  }
  container.innerHTML = html;

  // Enforce max_dishes limit on checkbox change
  if (maxDishes > 0) {
    container.querySelectorAll('input[name="menu-item"]').forEach(cb => {
      cb.addEventListener('change', () => enforceMaxDishes(container, maxDishes));
    });
    enforceMaxDishes(container, maxDishes);
  }

  document.getElementById('order-custom').value = po.custom || '';
}

function renderSplitPicker(pids) {
  const container = document.getElementById('split-places-pick');
  const totalVotes = allVotes.length;
  container.innerHTML = pids.map(pid => {
    const place = places.find(p => p.id === pid);
    if (!place) return '';
    const voteCount = allVotes.filter(v => v.place_id === pid).length;
    const votePct   = totalVotes > 0 ? Math.round(voteCount / totalVotes * 100) : 0;
    return `
      <button class="split-pick-btn" data-place-id="${pid}">
        <strong>${esc(place.name)}</strong>
        ${place.description ? `<span>${esc(place.description)}</span>` : ''}
        ${voteCount > 0 ? `<span class="split-vote-label">${voteCount} vot${voteCount === 1 ? 'o' : 'i'} · ${votePct}%</span>` : ''}
      </button>`;
  }).join('');
}

function pickOrderPlace(id) {
  selectedOrderPlaceId = id;
  renderOrderingScreen();
}

function enforceMaxDishes(container, max) {
  const all     = [...container.querySelectorAll('input[name="menu-item"]')];
  const checked = all.filter(cb => cb.checked);
  const reached = checked.length >= max;
  all.forEach(cb => {
    if (!cb.checked) cb.disabled = reached;
  });
  const label = document.getElementById('dishes-limit-label');
  if (label) {
    label.classList.toggle('dishes-limit-reached', reached);
  }
}

async function submitOrder() {
  const allItems = [...document.querySelectorAll('input[name="menu-item"]')];
  const checked  = allItems.filter(cb => cb.checked).map(cb => cb.value);
  const custom   = document.getElementById('order-custom').value.trim();

  const parts = custom ? [...checked, custom] : checked;
  if (!parts.length) { document.getElementById('order-custom').focus(); return; }
  const orderText = parts.join(', ');
  const res = await apiFetch('/orders', 'POST', {
    colleague_name: collegeName,
    place_id: selectedOrderPlaceId || sessionState.winning_place_id || null,
    order_text: orderText,
    date: today
  });
  if (res) {
    hasOrdered = true;
    selectedOrderPlaceId = selectedOrderPlaceId || sessionState.winning_place_id || null;
    currentOrderText = orderText;
    setConfirmText(orderText);
    showScreen('confirmation');
    renderConfirmationOrders();
  }
}
// ── Asporto ─────────────────────────────────────────────────────

function showAsportoScreen() {
  const active = document.querySelector('.screen.active');
  asportoPrevScreen = active ? active.id.replace('screen-', '') : 'voting';
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
  const menuPlaces = places.filter(p => {
    const m = menus.find(x => x.place_id === p.id);
    return m && m.menu_text?.trim();
  });
  sel.innerHTML = '<option value="">— Scegli il ristorante —</option>' +
    menuPlaces.map(p => {
      const has = myAsportoOrders.some(o => o.place_id === p.id);
      return `<option value="${p.id}"${cur === p.id ? ' selected' : ''}>${esc(p.name)}${has ? ' ✓' : ''}</option>`;
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
  const place = places.find(p => p.id === placeId);
  const menu  = menus.find(m => m.place_id === placeId);
  const myOrder     = myAsportoOrders.find(o => o.place_id === placeId);
  const menuLines   = (menu?.menu_text || '').split('\n').map(l => l.trim()).filter(l => l);
  const presetLines = place?.presets || [];
  let existingChecks = [];
  let existingCustom = '';
  if (myOrder) {
    const knownItems = new Set([...menuLines, ...presetLines]);
    const parts = myOrder.order_text.split(',').map(s => s.trim()).filter(s => s);
    existingChecks = parts.filter(p => knownItems.has(p));
    existingCustom = parts.filter(p => !knownItems.has(p)).join(', ');
  }
  let html = '';
  if (menuLines.length) {
    html += '<p class="checkbox-group-label">Menu del giorno:</p>';
    html += menuLines.map(line => `
      <label class="menu-check-item">
        <input type="checkbox" name="asporto-item" value="${esc(line)}" ${existingChecks.includes(line) ? 'checked' : ''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (presetLines.length) {
    html += '<p class="checkbox-group-label">Sempre disponibili:</p>';
    html += presetLines.map(line => `
      <label class="menu-check-item">
        <input type="checkbox" name="asporto-item" value="${esc(line)}" ${existingChecks.includes(line) ? 'checked' : ''} />
        <span>${esc(line)}</span>
      </label>`).join('');
  }
  if (!menuLines.length && !presetLines.length) {
    html = '<em class="empty-check">Nessuna voce di menu — usa il campo sotto.</em>';
  }
  document.getElementById('asporto-checkboxes').innerHTML = html;
  document.getElementById('asporto-custom').value = existingCustom;
  document.getElementById('btn-submit-asporto').textContent = myOrder ? '🛵 Aggiorna Ordine' : '🛵 Invia Ordine Asporto';
  document.getElementById('asporto-form-section').style.display = 'block';
}

async function submitAsportoOrder() {
  const pid = parseInt(document.getElementById('asporto-place-select').value, 10);
  if (!pid) { document.getElementById('asporto-place-select').focus(); return; }
  const checked = [...document.querySelectorAll('input[name="asporto-item"]:checked')].map(c => c.value);
  const custom  = document.getElementById('asporto-custom').value.trim();
  const parts   = custom ? [...checked, custom] : checked;
  if (!parts.length) { document.getElementById('asporto-custom').focus(); return; }
  const res = await apiFetch('/asporto', 'POST', {
    colleague_name: collegeName,
    place_id: pid,
    order_text: parts.join(', '),
    date: today
  });
  if (res) renderAsportoScreen();
}

function renderMyAsportoOrders() {
  const card = document.getElementById('my-asporto-card');
  const list = document.getElementById('my-asporto-list');
  if (!list) return;
  if (!myAsportoOrders.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  list.innerHTML = myAsportoOrders.map(o => `
    <div class="asporto-order-item">
      <div class="asporto-order-info">
        <span class="asporto-order-place">${esc(o.place_name)}</span>
        <span class="asporto-order-text">${esc(o.order_text)}</span>
      </div>
      <button class="btn btn-danger btn-sm" data-action="delete-asporto" data-id="${o.id}" title="Annulla">&times;</button>
    </div>`).join('');
}

async function deleteMyAsportoOrder(id) {
  if (!confirm('Annullare questo ordine asporto?')) return;
  await apiFetch(`/asporto/${today}/${id}`, 'DELETE');
}
// ── Timer ─────────────────────────────────────────────────

function updateTimerDisplay() {
  const timerEl     = document.getElementById('vote-timer');
  const countdownEl = document.getElementById('timer-countdown');
  if (!timerEl) return;
  clearInterval(timerInterval);
  timerInterval = null;
  if (!sessionState.timer_end) { timerEl.style.display = 'none'; return; }
  timerEl.style.display = 'block';
  function tick() {
    const remaining = Math.max(0, new Date(sessionState.timer_end) - Date.now());
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    countdownEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    if (remaining === 0) { clearInterval(timerInterval); timerInterval = null; }
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ── Utilities ─────────────────────────────────────────────

async function apiFetch(path, method = 'GET', body = null) {
  try {
    const opts = { method, headers: {} };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || `Errore: ${res.statusText}`);
      return null;
    }
    return res.json();
  } catch (_) {
    return null;
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showBackendError() {
  const list = document.getElementById('places-list');
  if (list) list.innerHTML =
    '<p class="empty">⚠️ Backend non raggiungibile.<br>Avvia il server e ricarica l\'app.</p>';
  showScreen('voting');
  updateNameDisplays();
}
