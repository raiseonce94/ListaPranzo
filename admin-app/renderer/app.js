'use strict';

const API    = `${window.location.origin}/api`;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

let ws               = null;
let wsReconnectTimer = null;
let currentTab       = 'places';
let places           = [];
let currentAuditLog = [];
let adminGroups     = [];        // list of all groups
let pendingGroupRequests = [];   // pending manager requests
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

  // Event delegation for dynamic lists
  document.getElementById('places-list').addEventListener('click', onPlacesListClick);
  document.getElementById('places-list').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const presetInput = e.target.closest('[id^="preset-input-"]');
    if (presetInput) { addPreset(parseInt(presetInput.id.replace('preset-input-', ''), 10)); return; }
    const maxInput = e.target.closest('[id^="max-dishes-input-"]');
    if (maxInput) saveMaxDishes(parseInt(maxInput.id.replace('max-dishes-input-', ''), 10));
  });
  document.getElementById('menus-list').addEventListener('click', onMenusListClick);

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

  // Audit
  document.getElementById('audit-date').value = today;
  document.getElementById('audit-date').addEventListener('change', loadAuditLog);
  document.getElementById('audit-group-filter').addEventListener('change', renderAuditLog);
  document.getElementById('audit-action-filter').addEventListener('change', renderAuditLog);
  document.getElementById('btn-refresh-audit').addEventListener('click', loadAuditLog);
  document.getElementById('btn-export-audit').addEventListener('click', exportAuditCSV);
  document.getElementById('btn-clear-audit').addEventListener('click', clearAuditLog);

  // Groups tab
  document.getElementById('btn-reload-groups').addEventListener('click', loadAdminGroupsTab);
  document.getElementById('btn-create-group-admin').addEventListener('click', createGroupAdmin);
  document.getElementById('new-group-name-admin').addEventListener('keydown', e => { if (e.key === 'Enter') createGroupAdmin(); });
  document.getElementById('group-requests-list').addEventListener('click', onGroupsTabClick);
  document.getElementById('admin-groups-list').addEventListener('click',   onGroupsTabClick);

  // Restaurant accounts tab
  document.getElementById('btn-create-restaurant-acc').addEventListener('click', createRestaurantAccount);
  document.getElementById('btn-reload-restaurants').addEventListener('click', () => { loadRestaurantAccounts().then(renderRestaurantAccounts); });
  document.getElementById('restaurant-accounts-list').addEventListener('click', onRestaurantAccountsClick);
  document.getElementById('reset-restaurant-pw-cancel').addEventListener('click', closeResetRestaurantPwModal);
  document.getElementById('reset-restaurant-pw-confirm').addEventListener('click', confirmResetRestaurantPassword);
  document.getElementById('reset-restaurant-pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmResetRestaurantPassword(); });

  // Bootstrap
  Promise.all([loadAdminGroups(), loadAdminUsers()]).then(() => loadAuditLog());
  Promise.all([loadPlaces(), loadGroupRequests()]);
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
  if (res.token) sessionStorage.setItem('adminToken', res.token);
  sessionStorage.setItem('adminAuth', '1');
  document.getElementById('admin-login-overlay').classList.add('hidden');
}

function adminLogout() {
  sessionStorage.removeItem('adminAuth');
  sessionStorage.removeItem('adminToken');
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
  if (tab === 'menus')       loadMenus();
  if (tab === 'users')       loadUsers();
  if (tab === 'audit')       loadAuditLog();
  if (tab === 'groups')      loadAdminGroupsTab();
  if (tab === 'restaurants') loadRestaurantAccountsTab();
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
    case 'audit_updated': {
      const filterDate = document.getElementById('audit-date')?.value;
      if (!filterDate || data.entry.date === filterDate) {
        currentAuditLog.unshift(data.entry);
        if (currentTab === 'audit') renderAuditLog();
      }
      break;
    }
    case 'group_request_created':
    case 'group_request_updated':
      loadGroupRequests();
      if (currentTab === 'groups') renderGroupRequests();
      break;
    case 'group_updated':
      loadAdminGroups();
      if (currentTab === 'groups') loadAdminGroupsTab();
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
  if (currentTab === 'menus') loadMenus();
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

// ── Group selector helpers ────────────────────────────────

async function loadAdminGroups() {
  adminGroups = (await apiFetch('/admin/groups')) || [];
  // refresh the audit group filter dropdown
  const sel  = document.getElementById('audit-group-filter');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Tutti i gruppi —</option>' +
      adminGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    if (prev) sel.value = prev;
  }
}

// ── Groups tab ────────────────────────────────────────────

async function loadAdminGroupsTab() {
  await Promise.all([loadAdminGroups(), loadAdminUsers(), loadGroupRequests()]);
  renderAdminGroupsTab();
}

async function loadGroupRequests() {
  pendingGroupRequests = (await apiFetch('/admin/group-requests')) || [];
  updateGroupRequestsBadge();
}

function updateGroupRequestsBadge() {
  const pending = pendingGroupRequests.filter(r => r.status === 'pending');
  const badge   = document.getElementById('group-requests-badge');
  if (!badge) return;
  badge.style.display = pending.length ? 'inline' : 'none';
  badge.textContent   = pending.length;
}

function renderAdminGroupsTab() {
  renderGroupRequests();
  renderAdminGroups();
}

function renderGroupRequests() {
  const container = document.getElementById('group-requests-list');
  if (!container) return;
  const pending = pendingGroupRequests.filter(r => r.status === 'pending');
  if (!pending.length) { container.innerHTML = '<p class="empty">Nessuna richiesta in attesa.</p>'; return; }
  container.innerHTML = pending.map(r => `
    <div class="group-req-item">
      <div class="group-req-info">
        <strong>${esc(r.user_name)}</strong> vuole creare il gruppo
        "<strong>${esc(r.group_name)}</strong>"
        <span class="audit-time">${new Date(r.created_at).toLocaleDateString('it-IT')}</span>
      </div>
      <div class="row gap-sm">
        <button class="btn btn-primary btn-sm" data-action="approve-req" data-id="${r.id}">✓ Approva</button>
        <button class="btn btn-danger btn-sm"  data-action="reject-req"  data-id="${r.id}">✗ Rifiuta</button>
      </div>
    </div>`).join('');
}

// allAdminUsers is populated by loadAdminUsers() called alongside loadAdminGroups()
let allAdminUsers = [];

async function loadAdminUsers() {
  allAdminUsers = (await apiFetch('/admin/users')) || [];
}

function renderAdminGroups() {
  const container = document.getElementById('admin-groups-list');
  if (!container) return;
  if (!adminGroups.length) { container.innerHTML = '<p class="empty">Nessun gruppo ancora.</p>'; return; }
  const stateLabel = { voting: 'votazione', ordering: 'ordini', closed: 'chiuso' };
  container.innerHTML = adminGroups.map(g => {
    const managers = g.manager_names || (g.manager_name ? [g.manager_name] : []);
    const managerPills = managers.map(m => `<span class="role-badge role-manager">👑 ${esc(m)}</span>`).join(' ');
    const memberRows = (g.members || []).map(m => {
      const isManager = m.role === 'manager';
      return `
        <div class="admin-member-row">
          <span class="admin-member-name">${esc(m.name)}</span>
          <span class="role-badge role-${m.role}">${m.role}</span>
          <button class="btn btn-secondary btn-xs"
            data-action="${isManager ? 'demote-member' : 'promote-member'}"
            data-gid="${g.id}" data-name="${esc(m.name)}"
            title="${isManager ? 'Declassa a utente' : 'Promuovi a manager'}">
            ${isManager ? '↓ Utente' : '↑ Manager'}
          </button>
          <button class="btn btn-danger btn-xs"
            data-action="remove-member-admin" data-gid="${g.id}" data-name="${esc(m.name)}"
            title="Rimuovi dal gruppo">&times;</button>
        </div>`;
    }).join('');
    return `
      <div class="admin-group-item">
        <div class="admin-group-header">
          <div class="admin-group-info">
            <strong id="group-name-display-${g.id}">${esc(g.name)}</strong>
            ${managerPills}
            ${g.today_session ? `<span class="badge badge-${g.today_session.state}" style="font-size:0.69rem;padding:2px 8px">${stateLabel[g.today_session.state] || g.today_session.state}</span>` : ''}
            <span class="admin-group-meta">${g.member_count} ${g.member_count === 1 ? 'membro' : 'membri'}</span>
          </div>
          <div class="row gap-sm">
            <button class="btn btn-secondary btn-sm" data-action="rename-group" data-id="${g.id}">✏️ Rinomina</button>
            <button class="btn btn-danger btn-sm"    data-action="delete-group"  data-id="${g.id}">🗑️ Elimina</button>
          </div>
        </div>
        <div class="admin-group-members">
          ${memberRows || '<p class="empty" style="margin:4px 0">Nessun membro.</p>'}
        </div>
        <div class="admin-group-add-member" style="margin-top:12px">
          <div class="add-member-label">Aggiungi utenti al gruppo:</div>
          ${(() => {
            const avail = allAdminUsers.filter(u => !u.group_id && !u.isAdmin);
            if (!avail.length) return '<p class="empty" style="margin:4px 0;font-size:0.82rem">Nessun utente libero disponibile.</p>';
            return `
              <div class="add-member-checklist" id="add-member-list-${g.id}">
                ${avail.map(u => `
                  <label class="add-member-check-item">
                    <input type="checkbox" value="${esc(u.name)}" />
                    <span class="add-member-check-name">${esc(u.name)}</span>
                  </label>`).join('')}
              </div>
              <div class="row gap-sm" style="margin-top:8px">
                <button class="btn btn-secondary btn-sm" data-action="select-all-members" data-gid="${g.id}">Seleziona tutti</button>
                <button class="btn btn-primary btn-sm" data-action="add-member-admin" data-gid="${g.id}">+ Aggiungi selezionati</button>
              </div>`;
          })()}
        </div>
      </div>`;
  }).join('');
}

function onGroupsTabClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id  = parseInt(btn.dataset.id, 10);
  const gid = parseInt(btn.dataset.gid, 10);
  const name = btn.dataset.name || '';
  if (btn.dataset.action === 'approve-req')        approveGroupRequest(id);
  if (btn.dataset.action === 'reject-req')          rejectGroupRequest(id);
  if (btn.dataset.action === 'delete-group')        deleteAdminGroup(id);
  if (btn.dataset.action === 'rename-group')        renameAdminGroup(id);
  if (btn.dataset.action === 'add-member-admin')    addMemberAdmin(gid);
  if (btn.dataset.action === 'select-all-members')  selectAllMembers(gid);
  if (btn.dataset.action === 'remove-member-admin') removeMemberAdmin(gid, name);
  if (btn.dataset.action === 'promote-member')      changeRoleAdmin(gid, name, 'manager');
  if (btn.dataset.action === 'demote-member')       changeRoleAdmin(gid, name, 'user');
}

async function approveGroupRequest(id) {
  const res = await apiFetch(`/admin/group-requests/${id}/approve`, 'PUT');
  if (res) { showToast('✅ Gruppo creato e manager approvato!'); await loadAdminGroupsTab(); }
}

async function rejectGroupRequest(id) {
  if (!confirm('Rifiutare questa richiesta?')) return;
  const res = await apiFetch(`/admin/group-requests/${id}/reject`, 'PUT');
  if (res) { showToast('Richiesta rifiutata.'); await loadAdminGroupsTab(); }
}

async function deleteAdminGroup(id) {
  const group = adminGroups.find(g => g.id === id);
  if (!confirm(`Eliminare il gruppo "${group?.name}"?\nTutti i membri verranno rimossi dal gruppo.`)) return;
  const res = await apiFetch(`/admin/groups/${id}`, 'DELETE');
  if (res) { showToast('Gruppo eliminato.'); await loadAdminGroupsTab(); }
}

async function createGroupAdmin() {
  const input = document.getElementById('new-group-name-admin');
  const name = input?.value.trim();
  if (!name) { showToast('Inserisci un nome per il gruppo.'); return; }
  const res = await apiFetch('/admin/groups', 'POST', { name });
  if (res) {
    showToast(`Gruppo "${name}" creato.`);
    if (input) input.value = '';
    await loadAdminGroupsTab();
  }
}

async function renameAdminGroup(id) {
  const group = adminGroups.find(g => g.id === id);
  const newName = prompt('Nuovo nome del gruppo:', group?.name || '');
  if (!newName?.trim() || newName.trim() === group?.name) return;
  const res = await apiFetch(`/admin/groups/${id}`, 'PUT', { name: newName.trim() });
  if (res) { showToast('Gruppo rinominato.'); await loadAdminGroupsTab(); }
}

function selectAllMembers(gid) {
  const list = document.getElementById(`add-member-list-${gid}`);
  if (!list) return;
  const boxes = list.querySelectorAll('input[type="checkbox"]');
  const allChecked = [...boxes].every(b => b.checked);
  boxes.forEach(b => { b.checked = !allChecked; });
}

async function addMemberAdmin(gid) {
  const list = document.getElementById(`add-member-list-${gid}`);
  const selected = list
    ? [...list.querySelectorAll('input[type="checkbox"]:checked')].map(b => b.value)
    : [];
  if (!selected.length) { showToast('Seleziona almeno un utente.'); return; }
  let added = 0;
  for (const user_name of selected) {
    const res = await apiFetch(`/admin/groups/${gid}/members`, 'POST', { user_name });
    if (res) added++;
  }
  if (added) showToast(`${added} utente${added > 1 ? 'i' : ''} aggiunto${added > 1 ? 'i' : ''} al gruppo.`);
  await loadAdminGroupsTab();
}

async function removeMemberAdmin(gid, user_name) {
  if (!confirm(`Rimuovere "${user_name}" dal gruppo?`)) return;
  const res = await apiFetch(`/admin/groups/${gid}/members/${encodeURIComponent(user_name)}`, 'DELETE');
  if (res) { showToast(`${user_name} rimosso.`); await loadAdminGroupsTab(); }
}

async function changeRoleAdmin(gid, user_name, role) {
  const label = role === 'manager' ? 'manager' : 'utente';
  const res = await apiFetch(`/admin/groups/${gid}/members/${encodeURIComponent(user_name)}/role`, 'PUT', { role });
  if (res) { showToast(`${user_name} è ora ${label}.`); await loadAdminGroupsTab(); }
}

// ── Copy / WhatsApp ────────────────────────────────────────
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
    const c = res.imported;
    resultEl.textContent = `✅ Importazione completata: ${c.places} ristoranti, ${c.menus} menu, ${c.users} utenti, ${c.groups} gruppi, ${c.orders} ordini.`;
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
    const token = sessionStorage.getItem('adminToken');
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
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
  const date    = document.getElementById('audit-date').value;
  const groupId = document.getElementById('audit-group-filter')?.value || '';
  const params  = [];
  if (date)    params.push(`date=${encodeURIComponent(date)}`);
  if (groupId) params.push(`group_id=${encodeURIComponent(groupId)}`);
  const entries = await apiFetch(`/audit${params.length ? '?' + params.join('&') : ''}`);
  if (!entries) return;
  currentAuditLog = entries;
  // Refresh group filter options
  const sel  = document.getElementById('audit-group-filter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Tutti i gruppi —</option>' +
    adminGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
  if (prev) sel.value = prev;
  renderAuditLog();
}

function renderAuditLog() {
  const list        = document.getElementById('audit-list');
  const statsEl     = document.getElementById('audit-stats');
  const actionFilter = document.getElementById('audit-action-filter')?.value || '';

  let entries = currentAuditLog;
  if (actionFilter) entries = entries.filter(e => e.action === actionFilter);

  // Stats bar
  if (entries.length) {
    const counts = {};
    entries.forEach(e => { counts[e.action] = (counts[e.action] || 0) + 1; });
    const statLabels = { vote:'Voti', order:'Ordini', asporto_order:'Asporto', session_change:'Sessioni',
      votes_cleared:'Voti az.', orders_cleared:'Ordini az.', order_deleted:'Ord. el.',
      asporto_cleared:'Asp. az.', asporto_deleted:'Asp. el.',
      member_added:'Membri ag.', member_removed:'Membri rim.', group_created:'Gruppi' };
    statsEl.innerHTML = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `<span class="audit-stat-chip">${statLabels[k] || k}: <strong>${v}</strong></span>`)
      .join('');
    statsEl.style.display = 'flex';
  } else {
    statsEl.style.display = 'none';
    statsEl.innerHTML = '';
  }

  if (!entries.length) {
    list.innerHTML = '<p class="empty">Nessuna attività registrata.</p>';
    return;
  }
  const labelMap = {
    vote:            { icon: '🗳️', label: 'Voto' },
    order:           { icon: '🍽️', label: 'Ordine' },
    asporto_order:   { icon: '🛵',  label: 'Asporto' },
    session_change:  { icon: '🔄',  label: 'Sessione' },
    votes_cleared:   { icon: '🗑️', label: 'Voti azzerati' },
    orders_cleared:  { icon: '🗑️', label: 'Ordini cancellati' },
    order_deleted:   { icon: '❌',  label: 'Ordine eliminato' },
    asporto_cleared: { icon: '🗑️', label: 'Asporto cancellati' },
    asporto_deleted: { icon: '❌',  label: 'Asporto eliminato' },
    member_added:    { icon: '➕',  label: 'Membro aggiunto' },
    member_removed:  { icon: '➖',  label: 'Membro rimosso' },
    group_created:   { icon: '🏢',  label: 'Gruppo creato' },
  };
  list.innerHTML = entries.map(e => {
    const { icon, label } = labelMap[e.action] || { icon: '📝', label: e.action };
    const ts = new Date(e.timestamp);
    const dateStr = ts.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = ts.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const groupName = adminGroups.find(g => g.id === e.group_id)?.name;
    let detail = '';
    if (e.action === 'vote') {
      detail = `${esc(e.colleague_name)} → ${(e.place_names || []).map(esc).join(', ')}`;
    } else if (e.action === 'order') {
      detail = `${esc(e.colleague_name)}: ${esc(e.order_text)}${e.place_name ? ` (${esc(e.place_name)})` : ''}`;
    } else if (e.action === 'asporto_order') {
      detail = `${esc(e.colleague_name)}: ${esc(e.order_text)} @ ${esc(e.place_name)}`;
    } else if (e.action === 'session_change') {
      const stateLabels = { voting: 'Votazione', ordering: 'Ordini', closed: 'Chiusa' };
      detail = `${stateLabels[e.state] || e.state}${e.winning_place_names?.length ? ` — ${e.winning_place_names.map(esc).join(', ')}` : ''}`;
    } else if (e.action === 'order_deleted' || e.action === 'asporto_deleted') {
      detail = esc(e.colleague_name);
    } else if (e.action === 'member_added' || e.action === 'member_removed') {
      detail = esc(e.user_name);
    } else if (e.action === 'group_created') {
      detail = `Manager: ${esc(e.manager_name)}`;
    }
    return `
      <div class="audit-item">
        <div class="audit-icon">${icon}</div>
        <div class="audit-body">
          <div class="audit-header">
            <span class="audit-label">${label}${groupName ? ` <span class="audit-group-pill">${esc(groupName)}</span>` : ''}</span>
            <span class="audit-time">${dateStr} ${timeStr}</span>
          </div>
          ${detail ? `<div class="audit-detail">${detail}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

function exportAuditCSV() {
  const actionFilter = document.getElementById('audit-action-filter')?.value || '';
  let entries = currentAuditLog;
  if (actionFilter) entries = entries.filter(e => e.action === actionFilter);
  if (!entries.length) { showToast('Nessun dato da esportare.'); return; }
  const rows = [['Timestamp', 'Data', 'Azione', 'Gruppo', 'Utente', 'Dettaglio']];
  entries.forEach(e => {
    const group = adminGroups.find(g => g.id === e.group_id)?.name || '';
    let detail = '';
    if (e.action === 'vote')           detail = `${e.colleague_name || ''} → ${(e.place_names || []).join(', ')}`;
    else if (e.action === 'order')     detail = `${e.colleague_name || ''}: ${e.order_text || ''}${e.place_name ? ` (${e.place_name})` : ''}`;
    else if (e.action === 'asporto_order') detail = `${e.colleague_name || ''}: ${e.order_text || ''} @ ${e.place_name || ''}`;
    else if (e.action === 'session_change') detail = `${e.state || ''}${e.winning_place_names?.length ? ` — ${e.winning_place_names.join(', ')}` : ''}`;
    else if (e.action === 'order_deleted' || e.action === 'asporto_deleted') detail = e.colleague_name || '';
    else if (e.action === 'member_added' || e.action === 'member_removed') detail = e.user_name || '';
    else if (e.action === 'group_created') detail = `Manager: ${e.manager_name || ''}`;
    rows.push([e.timestamp, e.date, e.action, group, e.colleague_name || e.manager_name || '', detail]);
  });
  const csv  = rows.map(r => r.map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a'); a.href = url; a.download = `audit-${today}.csv`; a.click();
  URL.revokeObjectURL(url);
}

async function clearAuditLog() {
  const date = document.getElementById('audit-date').value;
  const msg = date ? `Cancellare il log del ${date}?` : 'Cancellare tutto il registro audit?';
  if (!confirm(msg)) return;
  const params = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await apiFetch(`/audit${params}`, 'DELETE');
  if (res) { currentAuditLog = []; renderAuditLog(); showToast('Log audit cancellato.'); }
}

// ── Restaurant Accounts ───────────────────────────────────

let restaurantAccounts = [];
let resetRestaurantTarget = null;

async function loadRestaurantAccountsTab() {
  await Promise.all([loadPlaces(), loadRestaurantAccounts()]);
  // Populate place dropdown
  const sel = document.getElementById('restaurant-acc-place');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Scegli ristorante —</option>' +
      places.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (prev) sel.value = prev;
  }
  renderRestaurantAccounts();
}

async function loadRestaurantAccounts() {
  const data = await apiFetch('/admin/restaurant-accounts');
  if (data) restaurantAccounts = data;
}

function renderRestaurantAccounts() {
  const list = document.getElementById('restaurant-accounts-list');
  if (!restaurantAccounts.length) {
    list.innerHTML = '<p class="empty">Nessun account ristoratore creato.</p>';
    return;
  }
  list.innerHTML = restaurantAccounts.map(a => `
    <div class="user-item">
      <div class="user-info">
        <strong>${esc(a.name)}</strong>
        <span class="role-badge role-restaurant">🍽️ ristoratore</span>
        ${a.place_name ? `<span style="font-size:0.82rem;color:#6b7280">→ ${esc(a.place_name)}</span>` : '<span style="font-size:0.82rem;color:#dc2626">⚠️ ristorante non trovato</span>'}
      </div>
      <div class="user-actions">
        <button class="btn btn-secondary btn-sm" data-action="reset-restaurant-pw" data-name="${esc(a.name)}">🔑 Password</button>
        <button class="btn btn-danger btn-sm" data-action="delete-restaurant-acc" data-name="${esc(a.name)}">🗑️ Elimina</button>
      </div>
    </div>`).join('');
}

async function createRestaurantAccount() {
  const name     = document.getElementById('restaurant-acc-name').value.trim();
  const password = document.getElementById('restaurant-acc-password').value;
  const placeId  = parseInt(document.getElementById('restaurant-acc-place').value, 10);
  if (!name)     { showToast('Inserisci un nome account.'); return; }
  if (!password) { showToast('Inserisci una password.'); return; }
  if (!placeId)  { showToast('Scegli un ristorante.'); return; }
  const res = await apiFetch('/admin/restaurant-accounts', 'POST', { name, password, place_id: placeId });
  if (res) {
    document.getElementById('restaurant-acc-name').value     = '';
    document.getElementById('restaurant-acc-password').value = '';
    document.getElementById('restaurant-acc-place').value    = '';
    showToast(`✅ Account "${name}" creato!`);
    await loadRestaurantAccounts();
    renderRestaurantAccounts();
  }
}

function onRestaurantAccountsClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const name = btn.dataset.name || '';
  if (btn.dataset.action === 'delete-restaurant-acc')   deleteRestaurantAccount(name);
  if (btn.dataset.action === 'reset-restaurant-pw')     openResetRestaurantPwModal(name);
}

async function deleteRestaurantAccount(name) {
  if (!confirm(`Eliminare l'account ristoratore "${name}"?`)) return;
  const res = await apiFetch(`/admin/restaurant-accounts/${encodeURIComponent(name)}`, 'DELETE');
  if (res) { showToast(`Account "${name}" eliminato.`); await loadRestaurantAccounts(); renderRestaurantAccounts(); }
}

function openResetRestaurantPwModal(name) {
  resetRestaurantTarget = name;
  document.getElementById('reset-restaurant-pw-username').textContent = name;
  document.getElementById('reset-restaurant-pw-input').value = '';
  document.getElementById('reset-restaurant-pw-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('reset-restaurant-pw-input').focus(), 80);
}

function closeResetRestaurantPwModal() {
  resetRestaurantTarget = null;
  document.getElementById('reset-restaurant-pw-modal').style.display = 'none';
}

async function confirmResetRestaurantPassword() {
  const pw = document.getElementById('reset-restaurant-pw-input').value;
  if (!pw) { showToast('Inserisci una nuova password.'); return; }
  const res = await apiFetch(`/admin/users/${encodeURIComponent(resetRestaurantTarget)}/reset-password`, 'POST', { new_password: pw });
  if (res) { showToast('Password reimpostata.'); closeResetRestaurantPwModal(); }
}
