'use strict';

const API    = `${window.location.origin}/api`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

let ws               = null;
let wsReconnectTimer = null;
let currentTab       = 'places';
let places           = [];
let sessionState     = { state: 'voting', winning_place_id: null };
let currentVotes     = [];
let currentOrders    = [];
let currentAsportoOrders = [];
let currentAuditLog = [];
let adminTimerInterval = null;
const today = new Date().toISOString().split('T')[0];

// ── Init ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // ── Admin auth gate
  const overlay = document.getElementById('admin-login-overlay');
  document.getElementById('admin-login-btn').addEventListener('click', adminLogin);
  document.getElementById('admin-password').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
  document.getElementById('admin-logout-btn').addEventListener('click', adminLogout);

  if (sessionStorage.getItem('adminAuth') === '1') {
    overlay.classList.add('hidden');
  }

  // Date defaults
  document.getElementById('menu-date').value = today;

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab))
  );

  // Place add
  document.getElementById('add-place-btn').addEventListener('click', addPlace);
  document.getElementById('place-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') addPlace();
  });

  // Menus date change
  document.getElementById('menu-date').addEventListener('change', loadMenus);
  document.getElementById('btn-clear-menus').addEventListener('click', clearMenus);

  // Voting controls
  document.getElementById('btn-close-voting').addEventListener('click', closeVoting);
  document.getElementById('btn-reopen-voting').addEventListener('click', reopenVoting);
  document.getElementById('btn-clear-votes').addEventListener('click', clearVotesAndRestart);
  document.getElementById('btn-force-apply').addEventListener('click', forceApplyWinner);
  document.getElementById('btn-force-split').addEventListener('click', forceSplit);
  document.getElementById('btn-change-winner').addEventListener('click', changeWinner);
  document.getElementById('btn-apply-split-change').addEventListener('click', changeSplit);
  document.getElementById('btn-start-timer').addEventListener('click', startTimer);
  document.getElementById('btn-stop-timer').addEventListener('click', stopTimer);

  // Orders
  document.getElementById('btn-generate').addEventListener('click', generateMessage);
  document.getElementById('btn-generate-asporto').addEventListener('click', generateAsportoMessage);
  document.getElementById('btn-clear-orders').addEventListener('click', clearAllOrders);
  document.getElementById('btn-clear-asporto').addEventListener('click', clearAllAsportoOrders);
  document.getElementById('asporto-orders-list').addEventListener('click', onAsportoOrdersListClick);
  document.getElementById('asporto-messages-container').addEventListener('click', onAsportoMessageCardClick);

  // Data tab
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('import-file').addEventListener('change', onImportFileChange);
  document.getElementById('btn-import').addEventListener('click', importData);

  // Users tab
  document.getElementById('btn-reload-users').addEventListener('click', loadUsers);
  document.getElementById('reset-pw-cancel').addEventListener('click', closeResetModal);
  document.getElementById('reset-pw-confirm').addEventListener('click', confirmResetPassword);
  document.getElementById('reset-pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmResetPassword(); });
  document.getElementById('users-list').addEventListener('click', onUsersListClick);

  // Message card — delegated (buttons rendered dynamically)
  document.getElementById('messages-container').addEventListener('click', onMessageCardClick);

  // Event delegation for dynamic lists
  document.getElementById('places-list').addEventListener('click', onPlacesListClick);
  document.getElementById('places-list').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const presetInput = e.target.closest('[id^="preset-input-"]');
    if (presetInput) {
      const id = parseInt(presetInput.id.replace('preset-input-', ''), 10);
      addPreset(id);
      return;
    }
    const maxInput = e.target.closest('[id^="max-dishes-input-"]');
    if (maxInput) {
      const id = parseInt(maxInput.id.replace('max-dishes-input-', ''), 10);
      saveMaxDishes(id);
    }
  });
  document.getElementById('menus-list').addEventListener('click', onMenusListClick);
  document.getElementById('orders-list').addEventListener('click', onOrdersListClick);

  // Audit
  document.getElementById('audit-date').value = today;
  document.getElementById('audit-date').addEventListener('change', loadAuditLog);
  document.getElementById('btn-refresh-audit').addEventListener('click', loadAuditLog);
  document.getElementById('btn-clear-audit').addEventListener('click', clearAuditLog);

  // Bootstrap
  Promise.all([loadPlaces(), loadSession(), loadVotes(), loadOrders(), loadAsportoOrders(), loadAuditLog()]);
  connectWebSocket();
});

// ── Admin Auth ────────────────────────────────────────────

async function adminLogin() {
  const password = document.getElementById('admin-password').value;
  if (!password) return;
  const res = await apiFetch('/admin/login', 'POST', { password });
  if (!res) {
    const errEl = document.getElementById('admin-login-err');
    errEl.textContent = 'Password non valida.';
    errEl.style.display = 'block';
    return;
  }
  sessionStorage.setItem('adminAuth', '1');
  document.getElementById('admin-login-overlay').classList.add('hidden');
}

function adminLogout() {
  sessionStorage.removeItem('adminAuth');
  document.getElementById('admin-password').value = '';
  document.getElementById('admin-login-err').style.display = 'none';
  document.getElementById('admin-login-overlay').classList.remove('hidden');
}

// ── Tabs ─────────────────────────────────────────────────

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );
  document.querySelectorAll('.tab').forEach(s =>
    s.classList.toggle('active', s.id === `tab-${tab}`)
  );
  if (tab === 'menus')  loadMenus();
  if (tab === 'voting') loadVotes();
  if (tab === 'orders') { loadOrders(); loadAsportoOrders(); }
  if (tab === 'users')  loadUsers();
  if (tab === 'audit')  loadAuditLog();
}

// ── WebSocket ─────────────────────────────────────────────

function connectWebSocket() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    clearTimeout(wsReconnectTimer);
    setConnectionUI(true);
  };

  ws.onmessage = ev => {
    try { handleWSMessage(JSON.parse(ev.data)); } catch (_) {}
  };

  ws.onclose = () => {
    setConnectionUI(false);
    wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = () => ws.close();
}

function setConnectionUI(connected) {
  document.getElementById('conn-dot').className   = `dot ${connected ? 'dot-on' : 'dot-off'}`;
  document.getElementById('conn-label').textContent = connected ? 'connesso' : 'disconnesso';
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'places_updated':
      loadPlaces();
      break;
    case 'menus_updated':
      if (currentTab === 'menus') loadMenus();
      break;
    case 'votes_updated':
      if (data.date === today) { currentVotes = data.votes; renderVotes(); }
      break;
    case 'orders_updated':
      if (data.date === today) { currentOrders = data.orders; renderOrders(); }
      break;
    case 'asporto_updated':
      if (data.date === today) { currentAsportoOrders = data.orders; renderAsportoOrders(); }
      break;
    case 'audit_updated': {
      const filterDate = document.getElementById('audit-date')?.value;
      if (!filterDate || data.entry.date === filterDate) {
        currentAuditLog.unshift(data.entry);
        if (currentTab === 'audit') renderAuditLog();
      }
      break;
    }
    case 'session_updated':
      if (data.session.date === today) {
        sessionState = data.session;
        renderSessionState();
        if (sessionState.state === 'voting') updateAdminTimer();
      }
      break;
  }
}

// ── Places ───────────────────────────────────────────────

async function loadPlaces() {
  const res = await apiFetch('/places');
  if (!res) return;
  // Remember which preset panels are currently open
  const openPanels = new Set(
    places.map(p => p.id).filter(id => {
      const el = document.getElementById(`presets-panel-${id}`);
      return el && el.style.display !== 'none';
    })
  );
  places = res;
  renderPlaces();
  // Re-open panels that were open before the reload
  openPanels.forEach(id => {
    const el = document.getElementById(`presets-panel-${id}`);
    if (el) el.style.display = 'block';
  });
  populateWinnerSelects();
  if (currentTab === 'menus') loadMenus();
}

function populateWinnerSelects() {
  ['force-winner-select', 'change-winner-select'].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    const firstOpt = sel.options[0].outerHTML;
    sel.innerHTML = firstOpt + places.map(p =>
      `<option value="${p.id}" ${sessionState.winning_place_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');
    if (prev) sel.value = prev;
    if (id === 'change-winner-select' && sessionState.winning_place_id)
      sel.value = sessionState.winning_place_id;
  });

  // Populate split checkboxes (force-split-row — used during voting)
  const splitCheckList = document.getElementById('split-check-list');
  if (splitCheckList) {
    splitCheckList.innerHTML = places.map(p =>
      `<label class="split-check-label">
        <input type="checkbox" class="split-place-check" value="${p.id}" />
        ${esc(p.name)}
      </label>`
    ).join('');
  }

  // Populate change-split checkboxes (shown during ordering/closed when split active)
  const changeSplitList = document.getElementById('change-split-check-list');
  if (changeSplitList) {
    const activeSplitIds = new Set(Array.isArray(sessionState.winning_place_ids) ? sessionState.winning_place_ids : []);
    changeSplitList.innerHTML = places.map(p =>
      `<label class="split-check-label">
        <input type="checkbox" class="change-split-place-check" value="${p.id}" ${activeSplitIds.has(p.id) ? 'checked' : ''} />
        ${esc(p.name)}
      </label>`
    ).join('');
  }
}

function renderPlaces() {
  const list = document.getElementById('places-list');
  if (!places.length) {
    list.innerHTML = '<p class="empty">Nessun ristorante. Aggiungine uno sopra.</p>';
    return;
  }
  list.innerHTML = places.map(p => {
    const presets = p.presets || [];
    return `
    <div class="place-item">
      <div class="place-info">
        <strong>${esc(p.name)}</strong>
        ${p.description ? `<span>${esc(p.description)}</span>` : ''}
        ${(p.max_dishes > 0) ? `<span class="max-dishes-badge">Max ${p.max_dishes} ${p.max_dishes === 1 ? 'piatto' : 'piatti'}</span>` : ''}
      </div>
      <div class="place-actions">
        <button class="btn btn-secondary btn-sm" data-action="toggle-presets" data-id="${p.id}">📋 Preset (${presets.length})</button>
        <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${p.id}">Modifica</button>
        <button class="btn btn-danger btn-sm"    data-action="delete" data-id="${p.id}">Elimina</button>
      </div>
    </div>
    <div id="presets-panel-${p.id}" class="presets-panel" style="display:none">
      <div class="presets-panel-inner">
        <div class="presets-section">
          <p class="presets-title">Numero massimo piatti:</p>
          <div class="row gap-sm">
            <input id="max-dishes-input-${p.id}" type="number" min="0" max="99" value="${p.max_dishes || 0}" class="max-dishes-input" />
            <span class="presets-hint" style="align-self:center">0 = nessun limite</span>
            <button class="btn btn-primary btn-sm" data-action="save-max-dishes" data-id="${p.id}">Salva</button>
          </div>
        </div>
        <p class="presets-title">Ordini preset per <strong>${esc(p.name)}</strong> <span class="presets-hint">(sempre disponibili come checkbox insieme al menu del giorno)</span>:</p>
        <div id="presets-list-${p.id}" class="presets-list">
          ${presets.length
            ? presets.map((item, i) => `
                <div class="preset-item">
                  <span>${esc(item)}</span>
                  <button class="btn btn-danger btn-xs" data-action="remove-preset" data-id="${p.id}" data-index="${i}">&times;</button>
                </div>`).join('')
            : '<em class="empty-presets">Nessun preset. Aggiungine uno sotto.</em>'}
        </div>
        <div class="row gap-sm preset-add-row">
          <input id="preset-input-${p.id}" type="text" placeholder="Es: Primo, Secondo, Dessert…" style="flex:1" />
          <button class="btn btn-primary btn-sm" data-action="add-preset" data-id="${p.id}">Aggiungi</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function onPlacesListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  if (btn.dataset.action === 'edit')           editPlace(id);
  if (btn.dataset.action === 'delete')         deletePlace(id);
  if (btn.dataset.action === 'toggle-presets') togglePresetsPanel(id);
  if (btn.dataset.action === 'add-preset')     addPreset(id);
  if (btn.dataset.action === 'remove-preset')  removePreset(id, parseInt(btn.dataset.index, 10));
  if (btn.dataset.action === 'save-max-dishes') saveMaxDishes(id);
}

function togglePresetsPanel(id) {
  const panel = document.getElementById(`presets-panel-${id}`);
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    const input = document.getElementById(`preset-input-${id}`);
    if (input) setTimeout(() => input.focus(), 80);
  }
}

async function saveMaxDishes(id) {
  const input = document.getElementById(`max-dishes-input-${id}`);
  if (!input) return;
  const max_dishes = Math.max(0, parseInt(input.value, 10) || 0);
  const place = places.find(p => p.id === id);
  if (!place) return;
  await apiFetch(`/places/${id}`, 'PUT', {
    name: place.name,
    description: place.description || '',
    max_dishes
  });
  showToast('Limite piatti salvato!');
}

async function addPreset(id) {
  const input = document.getElementById(`preset-input-${id}`);
  if (!input) return;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  const place = places.find(p => p.id === id);
  if (!place) return;
  const presets = [...(place.presets || []), text];
  const res = await apiFetch(`/places/${id}/presets`, 'PATCH', { presets });
  if (res) input.value = '';
}

async function removePreset(id, index) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  if (!confirm(`Rimuovere il preset "${place.presets[index]}"?`)) return;
  const presets = (place.presets || []).filter((_, i) => i !== index);
  await apiFetch(`/places/${id}/presets`, 'PATCH', { presets });
}

async function addPlace() {
  const name = document.getElementById('place-name').value.trim();
  const desc = document.getElementById('place-desc').value.trim();
  if (!name) { showToast('Inserisci il nome del ristorante'); return; }
  const res = await apiFetch('/places', 'POST', { name, description: desc });
  if (res) {
    document.getElementById('place-name').value = '';
    document.getElementById('place-desc').value = '';
    await loadPlaces();
  }
}

async function editPlace(id) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  const name = prompt('Nome ristorante:', place.name);
  if (!name || !name.trim()) return;
  const desc = prompt('Descrizione:', place.description || '') || '';
  await apiFetch(`/places/${id}`, 'PUT', { name: name.trim(), description: desc.trim(), max_dishes: place.max_dishes || 0 });
}

async function deletePlace(id) {
  const place = places.find(p => p.id === id);
  if (!place) return;
  if (!confirm(`Eliminare "${place.name}"?\nVoterò e menu associati verranno cancellati.`)) return;
  await apiFetch(`/places/${id}`, 'DELETE');
}

// ── Menus ─────────────────────────────────────────────────

async function loadMenus() {
  const date  = document.getElementById('menu-date').value;
  const menus = await apiFetch(`/menus/${date}`);
  if (!menus) return;
  renderMenus(menus, date);
}

function renderMenus(menus, date) {
  const list = document.getElementById('menus-list');
  if (!places.length) {
    list.innerHTML = '<p class="empty">Aggiungi prima dei ristoranti nella tab "Ristoranti".</p>';
    return;
  }
  list.innerHTML = places.map(place => {
    const menu = menus.find(m => m.place_id === place.id);
    return `
      <div class="menu-block">
        <div class="menu-block-header">
          <strong>${esc(place.name)}</strong>
          <button class="btn btn-primary btn-sm" data-action="save-menu"
            data-place-id="${place.id}" data-date="${date}">Salva</button>
        </div>
        <textarea id="menu-${place.id}" rows="5"
          placeholder="Inserisci il menu del giorno...">${menu ? esc(menu.menu_text) : ''}</textarea>
      </div>`;
  }).join('');
}

function onMenusListClick(e) {
  const btn = e.target.closest('[data-action="save-menu"]');
  if (!btn) return;
  saveMenu(parseInt(btn.dataset.placeId, 10), btn.dataset.date);
}

async function saveMenu(placeId, date) {
  const menu_text = document.getElementById(`menu-${placeId}`).value;
  await apiFetch('/menus', 'POST', { place_id: placeId, date, menu_text });
  showToast('Menu salvato!');
}

async function clearMenus() {
  const date = document.getElementById('menu-date').value;
  if (!date) { showToast('Seleziona prima una data.'); return; }
  if (!confirm(`Cancellare tutti i menu del ${date}?`)) return;
  const res = await apiFetch(`/menus/${date}`, 'DELETE');
  if (res) showToast('Menu cancellati!');
}

// ── Session ───────────────────────────────────────────────

async function loadSession() {
  const session = await apiFetch(`/session/${today}`);
  if (!session) return;
  sessionState = session;
  renderSessionState();
}

function renderSessionState() {
  const badge          = document.getElementById('session-badge');
  const btnClose       = document.getElementById('btn-close-voting');
  const btnReopen      = document.getElementById('btn-reopen-voting');
  const timerSection   = document.getElementById('timer-section');
  const forceRow       = document.getElementById('force-winner-row');
  const forceSplitRow  = document.getElementById('force-split-row');
  const changeRow      = document.getElementById('change-winner-row');
  const changeSplitRow = document.getElementById('change-split-row');

  const labels = { voting: 'Votazione aperta', ordering: 'Ordini aperti', closed: 'Sessione chiusa' };
  badge.textContent = labels[sessionState.state] || sessionState.state;
  badge.className   = `badge badge-${sessionState.state}`;

  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;

  btnClose.style.display  = sessionState.state === 'voting'   ? 'inline-block' : 'none';
  btnReopen.style.display = sessionState.state !== 'voting'   ? 'inline-block' : 'none';

  timerSection.style.display  = sessionState.state === 'voting' ? 'flex'  : 'none';
  forceRow.style.display      = sessionState.state === 'voting' ? 'flex'  : 'none';
  forceSplitRow.style.display = sessionState.state === 'voting' ? 'flex'  : 'none';
  changeRow.style.display     = sessionState.state !== 'voting' && !isSplit ? 'flex' : 'none';
  changeSplitRow.style.display= sessionState.state !== 'voting' && isSplit  ? 'flex' : 'none';

  populateWinnerSelects();
  if (sessionState.state === 'voting') updateAdminTimer();
  else { clearInterval(adminTimerInterval); adminTimerInterval = null; }
}

async function closeVoting() {
  // Use forced winner if selected, otherwise auto-pick by votes
  const forcedId = parseInt(document.getElementById('force-winner-select').value, 10) || null;
  let winning_place_id = forcedId;
  if (!winning_place_id && currentVotes.length > 0) {
    const counts = {};
    currentVotes.forEach(v => { counts[v.place_id] = (counts[v.place_id] || 0) + 1; });
    const topEntries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const topCount   = topEntries[0][1];
    const tied       = topEntries.filter(([, c]) => c === topCount);
    if (tied.length > 1) {
      const names = tied.map(([pid]) => places.find(p => p.id === parseInt(pid, 10))?.name || pid).join(', ');
      showToast(`⚠️ Parità tra: ${names}. Seleziona un vincitore forzato.`);
      return;
    }
    winning_place_id = parseInt(topEntries[0][0], 10);
  }
  await apiFetch(`/session/${today}`, 'PUT', { state: 'ordering', winning_place_id });
  showToast('Votazione chiusa — ordini aperti!');
}

async function reopenVoting() {
  if (!confirm('Riaprire la votazione? Gli ordini già inseriti rimarranno salvati.')) return;
  await apiFetch(`/session/${today}`, 'PUT', { state: 'voting', winning_place_id: null });
  showToast('Votazione riaperta.');
}

async function clearVotesAndRestart() {
  if (!confirm('Azzerare tutti i voti e riavviare la votazione da zero?\nQuesta operazione non può essere annullata.')) return;
  const res = await apiFetch(`/votes/${today}`, 'DELETE');
  if (res) showToast('Voti azzerati — votazione riavviata!');
}

async function forceApplyWinner() {
  const id = parseInt(document.getElementById('force-winner-select').value, 10);
  if (!id) { showToast('Seleziona un ristorante prima.'); return; }
  await apiFetch(`/session/${today}`, 'PUT', { state: 'ordering', winning_place_id: id });
  showToast('Vincitore forzato — ordini aperti!');
}

async function forceSplit() {
  const ids = [...document.querySelectorAll('.split-place-check:checked')]
    .map(c => parseInt(c.value, 10));
  if (ids.length < 2) { showToast('Seleziona almeno 2 ristoranti per il split.'); return; }
  await apiFetch(`/session/${today}`, 'PUT', { state: 'ordering', winning_place_ids: ids });
  showToast(`Split attivato con ${ids.length} ristoranti — ordini aperti!`);
}

async function changeWinner() {
  const id = parseInt(document.getElementById('change-winner-select').value, 10) || null;
  await apiFetch(`/session/${today}/winner`, 'PATCH', { winning_place_id: id });
  showToast('Vincitore aggiornato!');
}

async function changeSplit() {
  const ids = [...document.querySelectorAll('.change-split-place-check:checked')]
    .map(c => parseInt(c.value, 10));
  if (!ids.length) { showToast('Seleziona almeno 1 ristorante.'); return; }
  if (ids.length === 1) {
    await apiFetch(`/session/${today}/winner`, 'PATCH', { winning_place_id: ids[0] });
    showToast('Vincitore aggiornato (split rimosso)!');
  } else {
    await apiFetch(`/session/${today}`, 'PUT', { state: sessionState.state, winning_place_ids: ids });
    showToast('Split aggiornato!');
  }
}

async function clearAllOrders() {
  if (!confirm('Cancellare tutti gli ordini di oggi?')) return;
  const res = await apiFetch(`/orders/${today}`, 'DELETE');
  if (res) showToast('Ordini cancellati!');
}

function onOrdersListClick(e) {
  const btn = e.target.closest('[data-action="delete-order"]');
  if (!btn) return;
  deleteOrder(parseInt(btn.dataset.id, 10));
}

async function deleteOrder(id) {
  await apiFetch(`/orders/${today}/${id}`, 'DELETE');
}

async function startTimer() {
  const minutes = parseInt(document.getElementById('timer-minutes').value, 10);
  if (!minutes || minutes < 1) { showToast('Inserisci un numero di minuti valido.'); return; }
  await apiFetch(`/session/${today}/timer`, 'POST', { minutes });
}

async function stopTimer() {
  await apiFetch(`/session/${today}/timer`, 'DELETE');
}

function updateAdminTimer() {
  const display  = document.getElementById('admin-timer-display');
  const btnStart = document.getElementById('btn-start-timer');
  const btnStop  = document.getElementById('btn-stop-timer');
  clearInterval(adminTimerInterval);
  adminTimerInterval = null;
  if (sessionState.timer_end) {
    btnStart.style.display = 'none';
    btnStop.style.display  = 'inline-block';
    function tick() {
      const remaining = Math.max(0, new Date(sessionState.timer_end) - Date.now());
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      display.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      if (remaining === 0) { clearInterval(adminTimerInterval); adminTimerInterval = null; }
    }
    tick();
    adminTimerInterval = setInterval(tick, 1000);
  } else {
    btnStart.style.display = 'inline-block';
    btnStop.style.display  = 'none';
    display.textContent    = '';
  }
}

// ── Votes ─────────────────────────────────────────────────

async function loadVotes() {
  const votes = await apiFetch(`/votes/${today}`);
  if (!votes) return;
  currentVotes = votes;
  renderVotes();
}

function renderVotes() {
  const list = document.getElementById('votes-list');
  if (!currentVotes.length) {
    list.innerHTML = '<p class="empty">Nessun voto ancora.</p>';
    return;
  }

  const groups = {};
  currentVotes.forEach(v => {
    if (!groups[v.place_id]) groups[v.place_id] = { name: v.place_name, votes: [] };
    groups[v.place_id].votes.push({ name: v.colleague_name, voted_at: v.voted_at });
  });

  const total  = currentVotes.length;
  const sorted = Object.entries(groups).sort((a, b) => b[1].votes.length - a[1].votes.length);

  list.innerHTML = sorted.map(([, group], i) => {
    const pct = Math.round((group.votes.length / total) * 100);
    return `
      <div class="vote-group" style="--delay:${i * 0.07}s">
        <div class="vote-header">
          <strong>${esc(group.name)}</strong>
          <span class="vote-count">${group.votes.length} vot${group.votes.length === 1 ? 'o' : 'i'} (${pct}%)</span>
        </div>
        <div class="vote-bar"><div class="vote-bar-fill" style="width:${pct}%"></div></div>
        <div class="vote-names">${group.votes.map(v => `${esc(v.name)}${fmtTime(v.voted_at)}`).join(', ')}</div>
      </div>`;
  }).join('');
}

// ── Orders ────────────────────────────────────────────────

async function loadOrders() {
  const orders = await apiFetch(`/orders/${today}`);
  if (!orders) return;
  currentOrders = orders;
  renderOrders();
}

function renderOrders() {
  const list = document.getElementById('orders-list');
  if (!currentOrders.length) {
    list.innerHTML = '<p class="empty">Nessun ordine ancora.</p>';
    return;
  }

  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;

  if (isSplit) {
    const splitPids   = sessionState.winning_place_ids;
    const splitPidSet = new Set(splitPids);
    let html = '';

    splitPids.forEach(pid => {
      const placeOrders = currentOrders.filter(o => o.place_id === pid);
      if (!placeOrders.length) return;
      const placeName = places.find(p => p.id === pid)?.name || `Ristorante #${pid}`;
      html += `<div class="orders-place-header">${esc(placeName)}</div>`;
      html += placeOrders.map((o, i) => `
        <div class="order-item" style="--delay:${i * 0.05}s">
          <div class="order-item-info">
            <strong>${esc(o.colleague_name)}${fmtTime(o.created_at)}</strong>
            <span>${esc(o.order_text)}</span>
          </div>
          <button class="btn btn-danger btn-sm" data-action="delete-order" data-id="${o.id}" title="Elimina ordine">&times;</button>
        </div>`).join('');
    });

    const otherOrders = currentOrders.filter(o => o.place_id == null || !splitPidSet.has(o.place_id));
    if (otherOrders.length) {
      html += `<div class="orders-place-header">Altro</div>`;
      html += otherOrders.map((o, i) => `
        <div class="order-item" style="--delay:${i * 0.05}s">
          <div class="order-item-info">
            <strong>${esc(o.colleague_name)}${fmtTime(o.created_at)}</strong>
            <span>${esc(o.order_text)}</span>
          </div>
          <button class="btn btn-danger btn-sm" data-action="delete-order" data-id="${o.id}" title="Elimina ordine">&times;</button>
        </div>`).join('');
    }

    list.innerHTML = html || '<p class="empty">Nessun ordine ancora.</p>';
  } else {
    list.innerHTML = currentOrders.map((o, i) => `
      <div class="order-item" style="--delay:${i * 0.05}s">
        <div class="order-item-info">
          <strong>${esc(o.colleague_name)}${fmtTime(o.created_at)}</strong>
          <span>${esc(o.order_text)}</span>
        </div>
        <button class="btn btn-danger btn-sm" data-action="delete-order" data-id="${o.id}" title="Elimina ordine">&times;</button>
      </div>`).join('');
  }
}

function generateMessage() {
  const hasRegular = currentOrders.length > 0;
  const hasAsporto = currentAsportoOrders.length > 0;
  if (!hasRegular && !hasAsporto) { showToast('Nessun ordine da aggregare.'); return; }

  const isSplit = Array.isArray(sessionState.winning_place_ids) && sessionState.winning_place_ids.length > 1;
  const container = document.getElementById('messages-container');
  const blocks = [];

  // ── Regular orders
  if (hasRegular) {
    if (isSplit) {
      const splitPids = new Set(sessionState.winning_place_ids);
      sessionState.winning_place_ids.forEach(pid => {
        const placeOrders = currentOrders.filter(o => o.place_id === pid);
        if (!placeOrders.length) return;
        const placeName = places.find(p => p.id === pid)?.name || `Ristorante #${pid}`;
        const counts = {};
        placeOrders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
        let msg = `Ciao,\n\n`;
        Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
        msg += `\nGrazie, Braconi x ${placeOrders.length}`;
        blocks.push({ text: msg.trim(), placeName });
      });
      const otherOrders = currentOrders.filter(o => o.place_id == null || !splitPids.has(o.place_id));
      if (otherOrders.length) {
        const counts = {};
        otherOrders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
        let msg = `Ciao,\n\n`;
        Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
        msg += `\nGrazie, Braconi x ${otherOrders.length}`;
        blocks.push({ text: msg.trim(), placeName: 'Altro' });
      }
    } else {
      const counts = {};
      currentOrders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
      let msg = `Ciao,\n\n`;
      Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
      msg += `\nGrazie, Braconi x ${currentOrders.length}`;
      const winnerName = places.find(p => p.id === sessionState.winning_place_id)?.name || '';
      blocks.push({ text: msg.trim(), placeName: winnerName });
    }
  }

  // ── Asporto orders (one block per place)
  const asportoByPlace = {};
  currentAsportoOrders.forEach(o => {
    if (!asportoByPlace[o.place_id]) asportoByPlace[o.place_id] = { name: o.place_name, orders: [] };
    asportoByPlace[o.place_id].orders.push(o);
  });
  Object.entries(asportoByPlace).forEach(([, { name, orders }]) => {
    const counts = {};
    orders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    let msg = `Ciao,\n\n`;
    Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `• ${count}x ${text}\n` : `• ${text}\n`; });
    msg += `\nDA ASPORTO\nGrazie, Braconi x ${orders.length}`;
    blocks.push({ text: msg.trim(), placeName: `${name} (Asporto)` });
  });

  // ── Render
  const showLabels = blocks.length > 1;
  const single = blocks.length === 1;
  container.innerHTML = blocks.map(({ text, placeName }, i) => `
    <div class="msg-block">
      ${showLabels ? `<p class="msg-block-label">${esc(placeName)} (${i + 1} di ${blocks.length})</p>` : ''}
      <textarea class="msg-textarea" rows="${Math.max(6, text.split('\n').length + 2)}" readonly>${esc(text)}</textarea>
      <div class="row" style="justify-content:flex-end; margin-top:${single ? 10 : 8}px; gap:8px">
        <button class="btn btn-primary${single ? '' : ' btn-sm'}" data-action="copy-msg" data-index="${i}">📋 Copia${single ? ' negli Appunti' : ''}</button>
        <button class="btn btn-whatsapp${single ? '' : ' btn-sm'}" data-action="wa-msg" data-index="${i}">📲 WhatsApp</button>
      </div>
    </div>`).join('');

  document.getElementById('message-card').style.display = 'block';
}

function onMessageCardClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const textareas = document.getElementById('messages-container').querySelectorAll('.msg-textarea');
  const idx = parseInt(btn.dataset.index, 10);
  const text = textareas[idx]?.value || '';
  if (btn.dataset.action === 'copy-msg') copyText(text);
  if (btn.dataset.action === 'wa-msg')   openWhatsApp(text);
}

// ── Asporto orders (admin) ─────────────────────────────────────────────

async function loadAsportoOrders() {
  const orders = await apiFetch(`/asporto/${today}`);
  if (!orders) return;
  currentAsportoOrders = orders;
  renderAsportoOrders();
}

function renderAsportoOrders() {
  const list = document.getElementById('asporto-orders-list');
  if (!currentAsportoOrders.length) {
    list.innerHTML = '<p class="empty">Nessun ordine asporto ancora.</p>';
    return;
  }
  const byPlace = {};
  currentAsportoOrders.forEach(o => {
    if (!byPlace[o.place_id]) byPlace[o.place_id] = { name: o.place_name, orders: [] };
    byPlace[o.place_id].orders.push(o);
  });
  let html = '';
  Object.entries(byPlace).forEach(([, { name, orders }]) => {
    html += `<div class="orders-place-header">🛵 ${esc(name)}</div>`;
    html += orders.map((o, i) => `
      <div class="order-item" style="--delay:${i * 0.05}s">
        <div class="order-item-info">
          <strong>${esc(o.colleague_name)}${fmtTime(o.created_at)}</strong>
          <span>${esc(o.order_text)}</span>
        </div>
        <button class="btn btn-danger btn-sm" data-action="delete-asporto" data-id="${o.id}" title="Elimina">&times;</button>
      </div>`).join('');
  });
  list.innerHTML = html;
}

async function clearAllAsportoOrders() {
  if (!confirm('Cancellare tutti gli ordini asporto di oggi?')) return;
  const res = await apiFetch(`/asporto/${today}`, 'DELETE');
  if (res) showToast('Ordini asporto cancellati!');
}

function generateAsportoMessage() {
  if (!currentAsportoOrders.length) { showToast('Nessun ordine asporto da aggregare.'); return; }

  const container = document.getElementById('asporto-messages-container');
  const byPlace = {};
  currentAsportoOrders.forEach(o => {
    if (!byPlace[o.place_id]) byPlace[o.place_id] = { name: o.place_name, orders: [] };
    byPlace[o.place_id].orders.push(o);
  });

  const blocks = Object.values(byPlace).map(({ name, orders }) => {
    const counts = {};
    orders.forEach(o => { const k = o.order_text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
    let msg = `Ciao,\n\n`;
    Object.entries(counts).forEach(([text, count]) => { msg += count > 1 ? `\u2022 ${count}x ${text}\n` : `\u2022 ${text}\n`; });
    msg += `\nDA ASPORTO\nGrazie, Braconi x ${orders.length}`;
    return { text: msg.trim(), placeName: name };
  });

  const showLabels = blocks.length > 1;
  const single = blocks.length === 1;
  container.innerHTML = blocks.map(({ text, placeName }, i) => `
    <div class="msg-block">
      ${showLabels ? `<p class="msg-block-label">${esc(placeName)} (${i + 1} di ${blocks.length})</p>` : ''}
      <textarea class="msg-textarea" rows="${Math.max(6, text.split('\n').length + 2)}" readonly>${esc(text)}</textarea>
      <div class="row" style="justify-content:flex-end; margin-top:${single ? 10 : 8}px; gap:8px">
        <button class="btn btn-primary${single ? '' : ' btn-sm'}" data-action="copy-asporto-msg" data-index="${i}">\ud83d\udccb Copia${single ? ' negli Appunti' : ''}</button>
        <button class="btn btn-whatsapp${single ? '' : ' btn-sm'}" data-action="wa-asporto-msg" data-index="${i}">\ud83d\udcf2 WhatsApp</button>
      </div>
    </div>`).join('');

  document.getElementById('asporto-message-card').style.display = 'block';
}

function onAsportoMessageCardClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const textareas = document.getElementById('asporto-messages-container').querySelectorAll('.msg-textarea');
  const idx = parseInt(btn.dataset.index, 10);
  const text = textareas[idx]?.value || '';
  if (btn.dataset.action === 'copy-asporto-msg') copyText(text);
  if (btn.dataset.action === 'wa-asporto-msg')   openWhatsApp(text);
}

function onAsportoOrdersListClick(e) {
  const btn = e.target.closest('[data-action="delete-asporto"]');
  if (!btn) return;
  apiFetch(`/asporto/${today}/${parseInt(btn.dataset.id, 10)}`, 'DELETE');
}

async function copyText(text) {
  try {
    if (window.electronAPI) {
      await window.electronAPI.copyToClipboard(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    showToast('Messaggio copiato negli appunti!');
  } catch (_) {
    showToast('Copia fallita — seleziona il testo manualmente.');
  }
}

function openWhatsApp(text) {
  if (!text.trim()) { showToast('Nessun messaggio da inviare.'); return; }
  const url = 'https://wa.me/?text=' + encodeURIComponent(text);
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ── Users management ─────────────────────────────────────

let usersList = [];
let resetTargetName = null;

async function loadUsers() {
  const data = await apiFetch('/admin/users');
  if (!data) return;
  usersList = data;
  renderUsers();
}

function renderUsers() {
  const list = document.getElementById('users-list');
  if (!usersList.length) {
    list.innerHTML = '<p class="empty">Nessun utente registrato.</p>';
    return;
  }
  list.innerHTML = usersList.map(u => `
    <div class="user-item">
      <div class="user-info">
        <strong>${esc(u.name)}</strong>
        ${u.isAdmin ? '<span class="badge badge-ordering" style="font-size:0.7rem;padding:1px 7px">admin</span>' : ''}
      </div>
      <div class="user-actions">
        <button class="btn btn-secondary btn-sm" data-action="reset-pw" data-name="${esc(u.name)}">🔑 Reset Password</button>
        ${u.name !== 'admin' ? `<button class="btn btn-danger btn-sm" data-action="delete-user" data-name="${esc(u.name)}">&times; Elimina</button>` : ''}
      </div>
    </div>`).join('');
}

function onUsersListClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const name = btn.dataset.name;
  if (btn.dataset.action === 'delete-user') deleteUser(name);
  if (btn.dataset.action === 'reset-pw')    openResetModal(name);
}

async function deleteUser(name) {
  if (!confirm(`Eliminare l'utente "${name}"? L'operazione è irreversibile.`)) return;
  const res = await apiFetch(`/admin/users/${encodeURIComponent(name)}`, 'DELETE');
  if (res) { showToast(`Utente "${name}" eliminato.`); await loadUsers(); }
}

function openResetModal(name) {
  resetTargetName = name;
  document.getElementById('reset-pw-username').textContent = `Utente: ${name}`;
  document.getElementById('reset-pw-input').value = '';
  document.getElementById('reset-pw-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('reset-pw-input').focus(), 50);
}

function closeResetModal() {
  resetTargetName = null;
  document.getElementById('reset-pw-modal').style.display = 'none';
}

async function confirmResetPassword() {
  const pw = document.getElementById('reset-pw-input').value.trim();
  if (!pw) { showToast('Inserisci una nuova password.'); return; }
  const res = await apiFetch(`/admin/users/${encodeURIComponent(resetTargetName)}/reset-password`, 'POST', { new_password: pw });
  if (res) { showToast(`Password di "${resetTargetName}" reimpostata.`); closeResetModal(); }
}

// ── Data export / import ─────────────────────────────────

function exportData() {
  const url = `${API}/data/export`;
  const a   = document.createElement('a');
  a.href    = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

let importFileData = null;

function onImportFileChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById('import-filename').textContent = file.name;
  document.getElementById('btn-import').disabled = false;
  document.getElementById('import-result').style.display = 'none';
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      importFileData = JSON.parse(ev.target.result);
    } catch (_) {
      importFileData = null;
      document.getElementById('btn-import').disabled = true;
      document.getElementById('import-filename').textContent = '❌ JSON non valido';
    }
  };
  reader.readAsText(file);
}

async function importData() {
  if (!importFileData) { showToast('Seleziona prima un file valido.'); return; }
  if (!confirm('Importare il backup? Sovrascriverà ristoranti, menu, pre-ordini e utenti.')) return;
  const res = await apiFetch('/data/import', 'POST', importFileData);
  const resultEl = document.getElementById('import-result');
  if (res) {
    resultEl.textContent = `✅ Importazione completata: ${res.imported.places} ristoranti, ${res.imported.menus} menu, ${res.imported.users} utenti.`;
    resultEl.className = 'import-result import-result-ok';
    resultEl.style.display = 'block';
    importFileData = null;
    document.getElementById('import-file').value = '';
    document.getElementById('import-filename').textContent = 'Nessun file selezionato';
    document.getElementById('btn-import').disabled = true;
    await loadPlaces();
  } else {
    resultEl.textContent = '❌ Importazione fallita. Controlla il file e riprova.';
    resultEl.className = 'import-result import-result-err';
    resultEl.style.display = 'block';
  }
}

// ── Utilities ─────────────────────────────────────────────

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
    showToast('Backend non raggiungibile. Assicurati che sia in esecuzione.');
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

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return ` <small class="audit-time">${new Date(ts).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</small>`;
  } catch (_) { return ''; }
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Audit ─────────────────────────────────────────────────

async function loadAuditLog() {
  const date = document.getElementById('audit-date').value;
  const params = date ? `?date=${encodeURIComponent(date)}` : '';
  const entries = await apiFetch(`/audit${params}`);
  if (!entries) return;
  currentAuditLog = entries;
  renderAuditLog();
}

function renderAuditLog() {
  const list = document.getElementById('audit-list');
  if (!currentAuditLog.length) {
    list.innerHTML = '<p class="empty">Nessuna attivit\u00e0 registrata.</p>';
    return;
  }
  const labelMap = {
    vote:            { icon: '\ud83d\uddf3\ufe0f', label: 'Voto' },
    order:           { icon: '\ud83c\udf7d\ufe0f', label: 'Ordine' },
    asporto_order:   { icon: '\ud83d\udef5',  label: 'Asporto' },
    session_change:  { icon: '\ud83d\udd04',  label: 'Sessione' },
    votes_cleared:   { icon: '\ud83d\uddd1\ufe0f', label: 'Voti azzerati' },
    orders_cleared:  { icon: '\ud83d\uddd1\ufe0f', label: 'Ordini cancellati' },
    order_deleted:   { icon: '\u274c',  label: 'Ordine eliminato' },
    asporto_cleared: { icon: '\ud83d\uddd1\ufe0f', label: 'Asporto cancellati' },
    asporto_deleted: { icon: '\u274c',  label: 'Asporto eliminato' },
  };
  list.innerHTML = currentAuditLog.map(e => {
    const { icon, label } = labelMap[e.action] || { icon: '\ud83d\udcdd', label: e.action };
    const ts = new Date(e.timestamp);
    const dateStr = ts.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = ts.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let detail = '';
    if (e.action === 'vote') {
      detail = `${esc(e.colleague_name)} \u2192 ${(e.place_names || []).map(esc).join(', ')}`;
    } else if (e.action === 'order') {
      detail = `${esc(e.colleague_name)}: ${esc(e.order_text)}${e.place_name ? ` (${esc(e.place_name)})` : ''}`;
    } else if (e.action === 'asporto_order') {
      detail = `${esc(e.colleague_name)}: ${esc(e.order_text)} @ ${esc(e.place_name)}`;
    } else if (e.action === 'session_change') {
      const stateLabels = { voting: 'Votazione', ordering: 'Ordini', closed: 'Chiusa' };
      detail = `${stateLabels[e.state] || e.state}${e.winning_place_names?.length ? ` \u2014 ${e.winning_place_names.map(esc).join(', ')}` : ''}`;
    } else if (e.action === 'order_deleted' || e.action === 'asporto_deleted') {
      detail = esc(e.colleague_name);
    }
    return `
      <div class="audit-item">
        <div class="audit-icon">${icon}</div>
        <div class="audit-body">
          <div class="audit-header">
            <span class="audit-label">${label}</span>
            <span class="audit-time">${dateStr} ${timeStr}</span>
          </div>
          ${detail ? `<div class="audit-detail">${detail}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function clearAuditLog() {
  const date = document.getElementById('audit-date').value;
  const msg = date ? `Cancellare il log del ${date}?` : 'Cancellare tutto il registro audit?';
  if (!confirm(msg)) return;
  const params = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await apiFetch(`/audit${params}`, 'DELETE');
  if (res) { currentAuditLog = []; renderAuditLog(); showToast('Log audit cancellato.'); }
}
