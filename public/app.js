const $ = (id) => document.getElementById(id);
const fmt = new Intl.NumberFormat();

const state = {
  items: new Map(),       // inventoryItemId -> item
  edits: new Map(),       // inventoryItemId -> { value, baseline, msg, msgType, saving }
  filter: 'all',
  status: 'ACTIVE',
  sort: 'name',
  search: '',
  low: 10,
  shop: '',
  testMode: false,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const numericId = (gid) => String(gid).split('/').pop();
const rowId = (id) => `r-${numericId(id)}`;

function level(item) {
  if (!item.tracked) return { cls: 'na', text: 'Not tracked' };
  if (!item.stocked) return { cls: 'na', text: 'Not stocked' };
  if (item.available <= 0) return { cls: 'out', text: 'Out' };
  if (item.available <= state.low) return { cls: 'low', text: 'Low' };
  return { cls: 'ok', text: 'In stock' };
}

function matches(item) {
  if (state.status !== 'all' && item.productStatus !== state.status) return false;
  const lv = level(item).cls;
  if (state.filter === 'low' && lv !== 'low') return false;
  if (state.filter === 'out' && lv !== 'out') return false;
  if (state.filter === 'untracked' && item.tracked) return false;
  if (state.search) {
    const hay = `${item.productTitle} ${item.variantTitle} ${item.sku}`.toLowerCase();
    if (!state.search.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function sorted(list) {
  const name = (a, b) => a.productTitle.localeCompare(b.productTitle) || a.variantTitle.localeCompare(b.variantTitle, undefined, { numeric: true });
  const cmp = {
    name,
    stockAsc: (a, b) => a.available - b.available || name(a, b),
    stockDesc: (a, b) => b.available - a.available || name(a, b),
    sku: (a, b) => (a.sku || '￿').localeCompare(b.sku || '￿') || name(a, b),
  }[state.sort];
  return list.sort(cmp);
}

function rowHtml(item) {
  const lv = level(item);
  const edit = state.edits.get(item.inventoryItemId);
  const editable = item.tracked && item.stocked;
  const value = edit ? edit.value : item.available;
  const adminUrl = state.shop ? `https://${state.shop}/admin/products/${numericId(item.productId)}` : '#';
  const thumb = item.image
    ? `<img class="thumb" src="${esc(item.image)}" alt="" loading="lazy">`
    : `<span class="thumb" aria-hidden="true"></span>`;
  const badge = item.productStatus !== 'ACTIVE' ? `<span class="badge ${esc(item.productStatus)}">${esc(item.productStatus.toLowerCase())}</span>` : '';
  const control = editable
    ? `<span class="stepper">
         <button type="button" data-act="dec" aria-label="Decrease">−</button>
         <input type="number" inputmode="numeric" min="0" step="1" value="${esc(value)}" data-act="input" aria-label="Available quantity for ${esc(item.productTitle)} ${esc(item.variantTitle)}">
         <button type="button" data-act="inc" aria-label="Increase">+</button>
       </span>
       <span class="actions">
         <button type="button" class="btn primary" data-act="save" ${edit?.saving ? 'disabled' : ''}>${edit?.saving ? 'Saving…' : 'Save'}</button>
         <button type="button" class="btn" data-act="cancel">Cancel</button>
       </span>`
    : `<span class="untracked" title="${item.tracked ? 'Not stocked at this location' : 'Turn on “Track quantity” for this product in Shopify to manage its stock here'}">${fmt.format(item.available)}</span>`;
  const msg = edit?.msg ? `<span class="row-msg ${edit.msgType || 'note'}">${esc(edit.msg)}</span>` : '';
  return `
    <td><div class="product">${thumb}<div>
      <div class="ptitle"><a href="${esc(adminUrl)}" target="_blank" rel="noopener">${esc(item.productTitle)}</a>${badge}</div>
      ${item.variantTitle ? `<div class="vtitle">${esc(item.variantTitle)}</div>` : ''}
    </div></div></td>
    <td class="sku col-sku">${esc(item.sku) || '—'}</td>
    <td class="num col-extra">${fmt.format(item.committed)}</td>
    <td class="num col-extra">${fmt.format(item.onHand)}</td>
    <td class="num"><span class="stock"><span class="level ${lv.cls}">${lv.text}</span>${control}</span>${msg}</td>`;
}

function renderTable() {
  const list = sorted([...state.items.values()].filter(matches));
  const tbody = $('rows');
  const frag = document.createDocumentFragment();
  for (const item of list) {
    const tr = document.createElement('tr');
    tr.id = rowId(item.inventoryItemId);
    tr.dataset.id = item.inventoryItemId;
    if (state.edits.has(item.inventoryItemId)) tr.classList.add('dirty');
    tr.innerHTML = rowHtml(item);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  $('empty').hidden = list.length > 0;
  $('count').textContent = `Showing ${fmt.format(list.length)} of ${fmt.format(state.items.size)} variants`;
}

function renderRow(id, flash = false) {
  const tr = document.getElementById(rowId(id));
  const item = state.items.get(id);
  if (!tr || !item) return;
  const focused = tr.contains(document.activeElement) && document.activeElement.dataset.act === 'input';
  tr.classList.toggle('dirty', state.edits.has(id));
  tr.innerHTML = rowHtml(item);
  if (focused) {
    const input = tr.querySelector('input');
    input?.focus({ preventScroll: true });
  }
  if (flash) {
    tr.classList.remove('flash');
    void tr.offsetWidth;
    tr.classList.add('flash');
  }
}

function renderStats() {
  let tracked = 0, low = 0, out = 0, units = 0;
  for (const item of state.items.values()) {
    if (state.status !== 'all' && item.productStatus !== state.status) continue;
    if (!item.tracked || !item.stocked) continue;
    tracked++;
    units += Math.max(0, item.available);
    if (item.available <= 0) out++;
    else if (item.available <= state.low) low++;
  }
  $('statTracked').textContent = fmt.format(tracked);
  $('statLow').textContent = fmt.format(low);
  $('statOut').textContent = fmt.format(out);
  $('statUnits').textContent = fmt.format(units);
  $('lowHint').textContent = `1–${state.low} left`;
}

function setFilter(f) {
  state.filter = f;
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('active', c.dataset.filter === f);
  renderTable();
}

let toastTimer;
function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), error ? 6000 : 2500);
}

function setSynced(iso) {
  if (!iso) return;
  const d = new Date(iso);
  $('synced').textContent = `Synced ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function showStatus(error) {
  if (error) banner(`Couldn't reach Shopify: ${error}`);
  else if (state.testMode) banner('Test mode: this is your real stock, but edits are NOT sent to the website. Saving only shows what would change.', true);
  else banner('');
}

function banner(text, info = false) {
  const b = $('banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.classList.toggle('info', info);
}

// ---------- activity feed ----------
const SOURCE = { website: 'Website', dashboard: 'Dashboard', sync: 'Shopify', test: 'Test · not sent' };
function logActivity(item, previous, source) {
  if (previous == null || previous === item.available) return;
  const list = $('activity');
  list.querySelector('.muted')?.remove();
  const delta = item.available - previous;
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="what">${esc(item.productTitle)}${item.variantTitle ? ` · ${esc(item.variantTitle)}` : ''}</div>
    <div class="meta">
      <span class="src">${SOURCE[source] || 'Shopify'}</span>
      <span>${fmt.format(previous)} → <strong>${fmt.format(item.available)}</strong></span>
      <span class="delta ${delta < 0 ? 'down' : 'up'}">${delta > 0 ? '+' : ''}${fmt.format(delta)}</span>
      <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>`;
  list.prepend(li);
  while (list.children.length > 50) list.lastChild.remove();
}

// ---------- editing ----------
function beginEdit(id, value) {
  const item = state.items.get(id);
  const edit = state.edits.get(id) || { baseline: item.available };
  edit.value = value;
  if (value === item.available && edit.baseline === item.available) {
    state.edits.delete(id);
  } else {
    state.edits.set(id, edit);
  }
  const tr = document.getElementById(rowId(id));
  tr?.classList.toggle('dirty', state.edits.has(id));
}

function cancelEdit(id) {
  state.edits.delete(id);
  renderRow(id);
}

async function save(id) {
  const edit = state.edits.get(id);
  const item = state.items.get(id);
  if (!edit || !item) return;
  const quantity = Number(edit.value);
  if (!Number.isInteger(quantity) || quantity < 0) {
    edit.msg = 'Enter a whole number, 0 or more';
    edit.msgType = 'error';
    return renderRow(id);
  }
  edit.saving = true;
  edit.msg = '';
  renderRow(id);
  try {
    const res = await fetch('/api/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inventoryItemId: id, quantity, expected: edit.baseline }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.testMode) {
      state.edits.delete(id);
      if (body.item) state.items.set(id, body.item);
      renderRow(id);
      logActivity({ ...item, available: quantity }, item.available, 'test');
      toast(`Test mode: would change ${fmt.format(item.available)} → ${fmt.format(quantity)}. Website not changed.`);
      return;
    }
    if (res.ok) {
      state.edits.delete(id);
      if (body.item) state.items.set(id, body.item);
      renderRow(id, true);
      renderStats();
      toast(`Saved — website now shows ${fmt.format(body.item?.available ?? quantity)} available`);
      return;
    }
    edit.saving = false;
    edit.msg = body.error || `Save failed (${res.status})`;
    edit.msgType = 'error';
    if (res.status === 409 && body.item) {
      // Website stock moved; rebase on the new figure, keep the user's typed value.
      state.items.set(id, body.item);
      edit.baseline = body.item.available;
    }
    renderRow(id);
    renderStats();
  } catch {
    edit.saving = false;
    edit.msg = 'Network error — not saved';
    edit.msgType = 'error';
    renderRow(id);
  }
}

$('rows').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const input = btn.closest('tr').querySelector('input');
  const act = btn.dataset.act;
  if (act === 'inc' || act === 'dec') {
    const next = Math.max(0, (parseInt(input.value, 10) || 0) + (act === 'inc' ? 1 : -1));
    input.value = next;
    beginEdit(id, next);
  } else if (act === 'save') save(id);
  else if (act === 'cancel') cancelEdit(id);
});
$('rows').addEventListener('input', (e) => {
  if (e.target.dataset.act !== 'input') return;
  const id = e.target.closest('tr').dataset.id;
  const v = e.target.value === '' ? '' : Number(e.target.value);
  beginEdit(id, v);
});
$('rows').addEventListener('keydown', (e) => {
  if (e.target.dataset.act !== 'input') return;
  const id = e.target.closest('tr').dataset.id;
  if (e.key === 'Enter') { e.preventDefault(); if (state.edits.has(id)) save(id); }
  if (e.key === 'Escape') { e.preventDefault(); cancelEdit(id); }
});
$('rows').addEventListener('focusin', (e) => {
  if (e.target.dataset.act === 'input' && !state.edits.has(e.target.closest('tr').dataset.id)) e.target.select();
});

// ---------- controls ----------
let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim().toLowerCase(); renderTable(); }, 120);
});
$('chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) setFilter(c.dataset.filter); });
for (const s of document.querySelectorAll('.stat[data-filter]')) s.addEventListener('click', () => setFilter(s.dataset.filter));
$('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; renderStats(); renderTable(); });
$('sort').addEventListener('change', (e) => { state.sort = e.target.value; renderTable(); });
$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await load();
    toast('Stock reloaded from Shopify');
  } catch {
    toast('Refresh failed', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh';
  }
});
window.addEventListener('beforeunload', (e) => { if (state.edits.size) { e.preventDefault(); e.returnValue = ''; } });

// ---------- data ----------
async function load() {
  const res = await fetch('/api/inventory');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.shop = data.shop;
  state.low = data.lowStockThreshold;
  state.items = new Map(data.items.map((i) => [i.inventoryItemId, i]));
  state.testMode = Boolean(data.testMode);
  $('store').textContent = `${data.shop} · ${data.location?.name ?? ''}${data.demo ? ' · demo data' : ''}${data.testMode ? ' · test mode' : ''}`;
  setSynced(data.updatedAt);
  showStatus(data.error);
  renderStats();
  renderTable();
}

function connectLive() {
  const pill = $('livePill');
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    const { liveMode } = JSON.parse(e.data);
    pill.className = 'live-pill on';
    $('liveText').textContent = liveMode === 'webhooks' ? 'Live' : liveMode === 'demo' ? 'Live (demo)' : 'Live · auto-sync';
    pill.title = liveMode === 'webhooks'
      ? 'Shopify notifies this dashboard the moment stock changes'
      : 'Stock is re-checked with Shopify every few seconds';
  });
  es.addEventListener('item', (e) => {
    const { item, source, previous } = JSON.parse(e.data);
    const prevLocal = state.items.get(item.inventoryItemId)?.available ?? previous;
    state.items.set(item.inventoryItemId, item);
    logActivity(item, prevLocal, source);
    const edit = state.edits.get(item.inventoryItemId);
    if (edit && !edit.saving && item.available !== edit.baseline) {
      edit.msg = `Website stock just changed to ${fmt.format(item.available)}`;
      edit.msgType = 'note';
    }
    if (document.getElementById(rowId(item.inventoryItemId))) renderRow(item.inventoryItemId, prevLocal !== item.available);
    else if (matches(item)) renderTable();
    renderStats();
    setSynced(new Date().toISOString());
  });
  es.addEventListener('remove', (e) => {
    const { inventoryItemId } = JSON.parse(e.data);
    state.items.delete(inventoryItemId);
    state.edits.delete(inventoryItemId);
    document.getElementById(rowId(inventoryItemId))?.remove();
    renderStats();
  });
  es.addEventListener('reload', () => load());
  es.addEventListener('status', (e) => {
    const { error } = JSON.parse(e.data);
    showStatus(error);
    if (!error) setSynced(new Date().toISOString());
  });
  es.onerror = () => {
    pill.className = 'live-pill off';
    $('liveText').textContent = 'Reconnecting…';
  };
  // EventSource reconnects on its own; resync the full list once it does.
  es.onopen = () => { if (state.items.size) load().catch(() => {}); };
}

load().catch((err) => banner(`Couldn't load inventory: ${err.message}`)).finally(connectLive);
