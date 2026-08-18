/* =========================================================
   Expense Calculator

   Firestore is the source of truth. localStorage keeps a mirror so the
   first paint is instant and the app still works if the cloud can't be
   reached at all.
   ========================================================= */

import {
  initCloud, cloudSaveSettings, cloudAddExpense, cloudDeleteExpense,
  cloudReplaceAll, cloudClearAll, cloudMigrate,
  cloudSaveReceivable, cloudDeleteReceivable, cloudSaveExpenses,
  loginWithEmail, registerWithEmail, signInWithGoogle, continueAsGuest,
  resetPassword, signOutUser, changePassword, saveProfile,
  hasPasswordProvider, currentUser, authErrorMessage
} from './firebase.js';

const STORAGE_KEY = 'expense-calculator-v1';
const MIGRATED_KEY = 'expense-calculator-migrated';

/**
 * Accounts that see the sync diagnostics panel. This only decides what the
 * profile panel renders — it is not a security boundary, since anyone can
 * read this file. What actually protects the data is firestore.rules, which
 * scopes every document to its own uid.
 */
const OWNER_EMAILS = ['tayyabnaeem26102001@gmail.com'];

function isOwner(user) {
  return !!user?.email && OWNER_EMAILS.includes(user.email.toLowerCase());
}

const CURRENCY_SYMBOLS = {
  PKR: '₨', INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SAR: '﷼'
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const defaultState = () => ({
  currency: 'PKR',
  defaultIncome: 0,
  incomes: {},     // "YYYY-MM" -> number
  expenses: [],    // { id, date: "YYYY-MM-DD", amount, category, note }
  receivables: []  // { id, person, amount, note, date, payments: [...] }
});

let state = load();
let viewDate = new Date();           // which month the Monthly tab is showing
let modalDate = null;                // "YYYY-MM-DD" currently open in the modal
let openReceivableId = null;         // receivable shown in the detail modal
let cloudReady = false;              // true once Firestore has delivered data

/* ---------------- storage ---------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalize(Object.assign(defaultState(), JSON.parse(raw)));
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Older saves used numeric ids and had no createdAt. Firestore document ids
 * are strings, so bring everything onto the current shape.
 */
function normalize(data) {
  data.expenses = (data.expenses || []).map((e) => ({
    ...e,
    id: String(e.id),
    amount: Number(e.amount) || 0,
    createdAt: Number(e.createdAt) || Number(e.id) || 0,
    settled: e.settled === true,
    settledOn: e.settledOn || ''
  }));
  data.receivables = (data.receivables || []).map((r) => ({
    ...r,
    id: String(r.id),
    person: r.person || 'Unnamed',
    amount: Number(r.amount) || 0,
    note: r.note || '',
    createdAt: Number(r.createdAt) || 0,
    payments: (r.payments || []).map((pay) => ({
      id: String(pay.id),
      amount: Number(pay.amount) || 0,
      date: pay.date
    }))
  }));
  return data;
}

/* ---------------- receivable maths ---------------- */

const receivedOf = (r) => (r.payments || []).reduce((t, p) => t + (Number(p.amount) || 0), 0);
const remainingOf = (r) => Math.max(0, (Number(r.amount) || 0) - receivedOf(r));
const isSettled = (r) => remainingOf(r) <= 0.005;

function newId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthOf = (dateStr) => dateStr.slice(0, 7);

function symbol() {
  return CURRENCY_SYMBOLS[state.currency] || state.currency;
}

function fmt(n) {
  const value = Number(n) || 0;
  const shown = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
  return `${value < 0 ? '-' : ''}${symbol()}${shown}`;
}

function compact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e7) return symbol() + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e5) return symbol() + Math.round(v / 1e3) + 'k';
  if (v >= 1e4) return symbol() + (v / 1e3).toFixed(1) + 'k';
  return symbol() + Math.round(v).toLocaleString();
}

function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
}

function incomeFor(key) {
  return Object.prototype.hasOwnProperty.call(state.incomes, key)
    ? Number(state.incomes[key]) || 0
    : Number(state.defaultIncome) || 0;
}

function expensesFor(key) {
  return state.expenses.filter((e) => monthOf(e.date) === key);
}

/** Expenses for a month that still count as spending. */
function activeFor(key) {
  return expensesFor(key).filter((e) => !e.settled);
}

function sum(list) {
  return list.reduce((total, e) => total + (Number(e.amount) || 0), 0);
}

/* ---------------- monthly tab ---------------- */

function renderMonthly() {
  const key = monthKey(viewDate);
  const income = incomeFor(key);
  const monthExpenses = expensesFor(key);
  // reimbursed money left your pocket and came back, so it is not spending
  const active = monthExpenses.filter((e) => !e.settled);
  const settled = monthExpenses.filter((e) => e.settled);
  const spent = sum(active);
  const settledTotal = sum(settled);
  const remaining = income - spent;

  $('monthLabel').textContent = `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
  $('listMonthLabel').textContent = `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`;

  // income input reflects the month being viewed
  if (document.activeElement !== $('incomeInput')) {
    $('incomeInput').value = income ? income : '';
  }

  $('mIncome').textContent = fmt(income);
  $('mSpent').textContent = fmt(spent);
  $('mRemaining').textContent = fmt(remaining);
  $('mRemaining').classList.toggle('over', remaining < 0);
  $('mSettled').textContent = fmt(settledTotal);

  const pct = income > 0 ? (spent / income) * 100 : (spent > 0 ? 100 : 0);
  const fill = $('progressFill');
  fill.style.width = Math.min(pct, 100) + '%';
  fill.classList.toggle('over', pct > 100);
  $('progressText').textContent = income > 0
    ? `${pct.toFixed(1)}% of budget used · ${remaining >= 0 ? fmt(remaining) + ' left' : fmt(Math.abs(remaining)) + ' over budget'}`
    : 'Set a monthly income to track your budget';

  renderCalendar(active);
  renderMonthList(active);
  renderSettled(settled, key);
  renderBars($('categoryBreakdown'), groupBy(active, 'category'), 'No expenses this month yet.');
}

function renderCalendar(active) {
  const cal = $('calendar');
  cal.innerHTML = '';

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = dateKey(new Date());

  // per-day totals for this month
  const totals = {};
  for (const e of active) {
    totals[e.date] = (totals[e.date] || 0) + (Number(e.amount) || 0);
  }

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'day blank';
    cal.appendChild(blank);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const ds = `${year}-${pad(month + 1)}-${pad(day)}`;
    const total = totals[ds] || 0;

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'day' + (total > 0 ? ' has-exp' : '') + (ds === todayStr ? ' today' : '');
    cell.innerHTML = `<span class="day-num">${day}</span>` +
      (total > 0 ? `<span class="day-amt">${compact(total)}</span>` : '<span class="day-amt"></span>');
    cell.addEventListener('click', () => openModal(ds));
    cal.appendChild(cell);
  }
}

// categories the reader has folded away, kept across re-renders
const collapsedCategories = new Set();

function renderMonthList(list) {
  const box = $('monthList');
  const ascending = $('sortSelect').value === 'asc';
  const sorted = [...list].sort((a, b) => {
    const byDate = ascending
      ? a.date.localeCompare(b.date)
      : b.date.localeCompare(a.date);
    // entries sharing a date fall back to when they were added
    return byDate || (ascending ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
  });
  $('listCount').textContent = `${sorted.length} ${sorted.length === 1 ? 'entry' : 'entries'}`;

  box.innerHTML = '';
  if (!sorted.length) {
    box.innerHTML = '<p class="empty">No expenses recorded for this month. Click a date on the calendar to add one.</p>';
    return;
  }

  if ($('groupSelect').value === 'none') {
    box.classList.remove('grouped');
    for (const e of sorted) box.appendChild(entryRow(e));
    return;
  }

  box.classList.add('grouped');
  const monthTotal = sum(sorted);

  const groups = new Map();
  for (const e of sorted) {
    const key = e.category || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  // biggest spend first, so the categories that matter are at the top
  const ordered = [...groups.entries()].sort((a, b) => sum(b[1]) - sum(a[1]));

  for (const [category, items] of ordered) {
    const total = sum(items);
    const share = monthTotal > 0 ? (total / monthTotal) * 100 : 0;

    const group = document.createElement('details');
    group.className = 'cat-group';
    group.open = !collapsedCategories.has(category);
    group.innerHTML = `
      <summary class="cat-head">
        <span class="cat-caret" aria-hidden="true">›</span>
        <span class="cat-name">${escapeHtml(category)}</span>
        <span class="pill cat-count">${items.length}</span>
        <span class="cat-figures">
          <strong>${fmt(total)}</strong>
          <small>${share.toFixed(1)}%</small>
        </span>
        <button type="button" class="cat-settle" title="Mark this category as reimbursed">Settle</button>
      </summary>
      <span class="bar-track cat-bar"><span class="bar-fill" style="width:${share}%"></span></span>`;

    const body = document.createElement('div');
    body.className = 'cat-body';
    for (const e of items) body.appendChild(entryRow(e, { showCategory: false }));
    group.appendChild(body);

    group.addEventListener('toggle', () => {
      if (group.open) collapsedCategories.delete(category);
      else collapsedCategories.add(category);
    });

    // the button lives inside a <summary>, which would otherwise fold the group
    group.querySelector('.cat-settle').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      settleCategory(category, items, total);
    });

    box.appendChild(group);
  }
}

function entryRow(e, { showDate = true, showCategory = true } = {}) {
  // whichever label is not already implied by the surrounding context leads
  const primary = showCategory ? (e.category || 'Other')
    : showDate ? prettyDate(e.date)
    : 'Expense';
  const trailing = showCategory && showDate ? prettyDate(e.date) : '';

  const row = document.createElement('div');
  row.className = 'entry';
  row.innerHTML = `
    <div class="entry-main">
      <div class="entry-top">
        <span class="entry-cat">${escapeHtml(primary)}</span>
        ${trailing ? `<span class="entry-date">${trailing}</span>` : ''}
      </div>
      ${e.note ? `<div class="entry-note">${escapeHtml(e.note)}</div>` : ''}
    </div>
    <span class="entry-amt">${fmt(e.amount)}</span>
    <button class="del-btn" title="Delete">✕</button>`;
  row.querySelector('.del-btn').addEventListener('click', () => deleteExpense(e.id));
  return row;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- totals tab ---------------- */

function renderTotal() {
  // the totals tab has to agree with the monthly one, so settled is excluded
  // from spending here as well
  const active = state.expenses.filter((e) => !e.settled);
  const totalSpent = sum(active);
  const totalSettled = sum(state.expenses.filter((e) => e.settled));

  // months that matter: any month with an expense, plus any month with a saved income
  const keys = new Set(state.expenses.map((e) => monthOf(e.date)));
  Object.keys(state.incomes).forEach((k) => keys.add(k));
  const sortedKeys = [...keys].sort();

  const totalIncome = sortedKeys.reduce((total, k) => total + incomeFor(k), 0);

  $('tSpent').textContent = fmt(totalSpent);
  $('tIncome').textContent = fmt(totalIncome);
  $('tNet').textContent = fmt(totalIncome - totalSpent);
  $('tNet').classList.toggle('over', totalIncome - totalSpent < 0);
  $('tCount').textContent = state.expenses.length;
  $('tSettled').textContent = fmt(totalSettled);

  // spending by month
  const byMonth = {};
  for (const k of sortedKeys) byMonth[monthTitle(k)] = sum(activeFor(k));
  renderBars($('monthlyChart'), byMonth, 'Nothing recorded yet.', false);

  renderBars($('totalCategory'), groupBy(active, 'category'), 'Nothing recorded yet.');

  // summary table
  const body = $('summaryBody');
  body.innerHTML = '';
  if (!sortedKeys.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No data yet — add an income and some expenses to get started.</td></tr>';
    return;
  }

  for (const k of [...sortedKeys].reverse()) {
    const income = incomeFor(k);
    const list = activeFor(k);
    const spent = sum(list);
    const remaining = income - spent;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${monthTitle(k)}</td>
      <td>${fmt(income)}</td>
      <td class="t-bad">${fmt(spent)}</td>
      <td class="${remaining >= 0 ? 't-good' : 't-bad'}">${fmt(remaining)}</td>
      <td>${list.length}</td>`;
    body.appendChild(tr);
  }
}

function monthTitle(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

function groupBy(list, field) {
  const out = {};
  for (const e of list) {
    const k = e[field] || 'Other';
    out[k] = (out[k] || 0) + (Number(e.amount) || 0);
  }
  return out;
}

function renderBars(container, data, emptyMsg, sortDesc = true) {
  let pairs = Object.entries(data).filter(([, v]) => v > 0);
  if (!pairs.length) {
    container.innerHTML = `<p class="empty">${emptyMsg}</p>`;
    return;
  }
  if (sortDesc) pairs.sort((a, b) => b[1] - a[1]);

  // bars are a share of the total, so the widths add up to the whole
  const total = pairs.reduce((running, [, v]) => running + v, 0);
  container.innerHTML = '';
  for (const [label, value] of pairs) {
    const share = total > 0 ? (value / total) * 100 : 0;
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${share}%"></span></span>
      <span class="bar-val">${fmt(value)}<span class="bar-pct">${share.toFixed(1)}%</span></span>`;
    container.appendChild(row);
  }
}

/* ---------------- expense actions ---------------- */

function addExpense(date, amount, category, note) {
  const expense = {
    id: newId(),
    date,
    amount: Number(amount),
    category,
    note: note.trim(),
    createdAt: Date.now()
  };

  // apply locally first so the UI never waits on the network; the Firestore
  // snapshot reconciles afterwards
  state.expenses.push(expense);
  save();
  renderAll();
  push(() => cloudAddExpense(expense));
}

function deleteExpense(id) {
  state.expenses = state.expenses.filter((e) => e.id !== id);
  save();
  renderAll();
  if (modalDate) renderModalList();
  push(() => cloudDeleteExpense(id));
}

function saveSettings() {
  save();
  push(() => cloudSaveSettings({
    currency: state.currency,
    defaultIncome: state.defaultIncome,
    incomes: state.incomes
  }));
}

/** Fires a cloud write, surfacing failures instead of losing them silently. */
function push(fn) {
  if (!cloudReady) return;
  Promise.resolve()
    .then(fn)
    .catch((err) => {
      console.error('[cloud write]', err);
      showBanner(`Could not save to the cloud: ${err.message}`);
    });
}

/* ---------------- modal ---------------- */

function openModal(dateStr) {
  modalDate = dateStr;
  $('modalTitle').textContent = prettyDate(dateStr);
  $('expDate').value = dateStr;
  $('expAmount').value = '';
  $('expNote').value = '';
  $('modal').hidden = false;
  renderModalList();
  setTimeout(() => $('expAmount').focus(), 50);
}

function closeModal() {
  $('modal').hidden = true;
  modalDate = null;
}

function renderModalList() {
  const list = state.expenses
    .filter((e) => e.date === modalDate)
    .sort((a, b) => b.createdAt - a.createdAt);

  $('dayTotal').textContent = fmt(sum(list));
  const box = $('dayList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="empty">Nothing logged for this day yet.</p>';
    return;
  }
  for (const e of list) box.appendChild(entryRow(e, { showDate: false }));
}

function renderSettled(settled, key) {
  const card = $('settledCard');
  card.hidden = !settled.length;
  if (!settled.length) return;

  $('settledTotalPill').textContent = fmt(sum(settled));

  const groups = new Map();
  for (const e of settled) {
    const cat = e.category || 'Other';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(e);
  }

  const box = $('settledList');
  box.innerHTML = '';
  for (const [category, items] of [...groups.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    const total = sum(items);
    const when = items.map((e) => e.settledOn).filter(Boolean).sort().pop();

    const group = document.createElement('details');
    group.className = 'cat-group settled-group';
    group.open = false;   // archived, so folded until asked for
    group.innerHTML = `
      <summary class="cat-head">
        <span class="cat-caret" aria-hidden="true">›</span>
        <span class="cat-name">${escapeHtml(category)}</span>
        <span class="pill cat-count">${items.length}</span>
        <span class="cat-figures">
          <strong class="muted-strong">${fmt(total)}</strong>
          <small>${when ? 'settled ' + prettyDate(when) : 'settled'}</small>
        </span>
        <button type="button" class="cat-settle undo" title="Put these back into this month's spending">Undo</button>
      </summary>`;

    const body = document.createElement('div');
    body.className = 'cat-body';
    for (const e of items) body.appendChild(entryRow(e, { showCategory: false }));
    group.appendChild(body);

    group.querySelector('.cat-settle').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      unsettleCategory(category, items);
    });

    box.appendChild(group);
  }
}

/**
 * Marks every entry in one category, for the month on screen, as reimbursed.
 * They stop counting toward spending but stay on record.
 */
function settleCategory(category, items, total) {
  const month = `${MONTH_NAMES[viewDate.getMonth()]} ${viewDate.getFullYear()}`;
  const question = `Mark ${items.length} ${category} ${items.length === 1 ? 'entry' : 'entries'} `
    + `(${fmt(total)}) in ${month} as settled?

`
    + 'They will stop counting toward this month’s spending, which frees up that much budget.';
  if (!confirm(question)) return;

  const today = dateKey(new Date());
  const changed = items.map((e) => Object.assign(e, { settled: true, settledOn: today }));
  save();
  renderAll();
  push(() => cloudSaveExpenses(changed));
}

function unsettleCategory(category, items) {
  if (!confirm(`Put ${items.length} ${category} ${items.length === 1 ? 'entry' : 'entries'} back into this month’s spending?`)) return;
  const changed = items.map((e) => Object.assign(e, { settled: false, settledOn: '' }));
  save();
  renderAll();
  push(() => cloudSaveExpenses(changed));
}

/* ---------------- to-receive tab ---------------- */

function renderReceivables() {
  const list = state.receivables;
  const totalLent = list.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const totalPaid = list.reduce((t, r) => t + receivedOf(r), 0);
  const outstanding = list.reduce((t, r) => t + remainingOf(r), 0);
  const owing = new Set(list.filter((r) => !isSettled(r)).map((r) => r.person.toLowerCase()));

  $('rOutstanding').textContent = fmt(outstanding);
  $('rReceived').textContent = fmt(totalPaid);
  $('rTotal').textContent = fmt(totalLent);
  $('rPeople').textContent = owing.size;

  const filter = $('recFilter').value;
  const shown = list.filter((r) =>
    filter === 'all' ? true : filter === 'settled' ? isSettled(r) : !isSettled(r));

  // unsettled first, then biggest outstanding, then newest
  shown.sort((a, b) =>
    Number(isSettled(a)) - Number(isSettled(b)) ||
    remainingOf(b) - remainingOf(a) ||
    b.createdAt - a.createdAt);

  $('recCount').textContent = `${shown.length} ${shown.length === 1 ? 'entry' : 'entries'}`;

  const box = $('receivableList');
  box.innerHTML = '';
  if (!shown.length) {
    box.innerHTML = `<p class="empty">${
      filter === 'settled' ? 'Nothing settled yet.'
      : filter === 'all' ? 'No one owes you anything yet. Add an entry above.'
      : 'Nothing outstanding — everyone has paid you back.'}</p>`;
    return;
  }
  for (const r of shown) box.appendChild(receivableRow(r));
}

function receivableRow(r) {
  const received = receivedOf(r);
  const remaining = remainingOf(r);
  const settled = isSettled(r);
  const pct = r.amount > 0 ? (received / r.amount) * 100 : 0;

  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'rec-row' + (settled ? ' settled' : '');
  row.innerHTML = `
    <span class="rec-avatar">${escapeHtml(r.person.trim().charAt(0).toUpperCase() || '?')}</span>
    <span class="rec-main">
      <span class="rec-top">
        <span class="rec-person">${escapeHtml(r.person)}</span>
        ${settled ? '<span class="rec-badge">Settled</span>' : ''}
      </span>
      ${r.note ? `<span class="rec-note-line">${escapeHtml(r.note)}</span>` : ''}
      <span class="bar-track"><span class="bar-fill good" style="width:${Math.min(pct, 100)}%"></span></span>
      <span class="rec-meta">${fmt(received)} received of ${fmt(r.amount)}${r.date ? ` · given ${prettyDate(r.date)}` : ''}</span>
    </span>
    <span class="rec-amount">
      <strong class="${settled ? 'good-text' : 'danger-text'}">${settled ? fmt(0) : fmt(remaining)}</strong>
      <small>${settled ? 'cleared' : 'remaining'}</small>
    </span>`;
  row.addEventListener('click', () => openReceivable(r.id));
  return row;
}

/* ---------------- receivable detail ---------------- */

function openReceivable(id) {
  openReceivableId = id;
  $('payAmount').value = '';
  $('payDate').value = dateKey(new Date());
  $('recModal').hidden = false;
  renderReceivableModal();
}

function closeReceivableModal() {
  $('recModal').hidden = true;
  openReceivableId = null;
}

function currentReceivable() {
  return state.receivables.find((r) => r.id === openReceivableId) || null;
}

function renderReceivableModal() {
  const r = currentReceivable();
  if (!r) return closeReceivableModal();

  const received = receivedOf(r);
  const remaining = remainingOf(r);
  const pct = r.amount > 0 ? Math.min((received / r.amount) * 100, 100) : 0;

  $('recModalTitle').textContent = r.person;
  $('recModalNote').textContent = r.note || '';
  $('recModalNote').hidden = !r.note;
  $('recOriginal').textContent = fmt(r.amount);
  $('recPaid').textContent = fmt(received);
  $('recRemaining').textContent = fmt(remaining);
  $('recProgress').style.width = pct + '%';
  $('recProgressText').textContent = isSettled(r)
    ? 'Fully received — nothing left to collect.'
    : `${pct.toFixed(1)}% received · ${fmt(remaining)} still owed`;

  $('paymentForm').hidden = isSettled(r);

  const box = $('paymentList');
  const payments = [...(r.payments || [])].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || Number(b.id) - Number(a.id));

  box.innerHTML = '';
  if (!payments.length) {
    box.innerHTML = '<p class="empty">Nothing received yet.</p>';
    return;
  }
  for (const pay of payments) {
    const item = document.createElement('div');
    item.className = 'entry';
    item.innerHTML = `
      <div class="entry-main">
        <div class="entry-top">
          <span class="entry-cat">Received</span>
          <span class="entry-date">${pay.date ? prettyDate(pay.date) : ''}</span>
        </div>
      </div>
      <span class="entry-amt good-text">${fmt(pay.amount)}</span>
      <button class="del-btn" title="Remove this payment">✕</button>`;
    item.querySelector('.del-btn').addEventListener('click', () => deletePayment(pay.id));
    box.appendChild(item);
  }
}

/* ---------------- receivable actions ---------------- */

function saveReceivable(receivable) {
  save();
  renderAll();
  push(() => cloudSaveReceivable(receivable));
}

function addReceivable(person, amount, date, note) {
  const receivable = {
    id: newId(),
    person: person.trim(),
    amount: Number(amount),
    note: note.trim(),
    date,
    createdAt: Date.now(),
    payments: []
  };
  state.receivables.push(receivable);
  saveReceivable(receivable);
}

function addPayment(amount, date) {
  const r = currentReceivable();
  if (!r) return;
  r.payments = [...(r.payments || []), { id: newId(), amount: Number(amount), date }];
  saveReceivable(r);
  renderReceivableModal();
}

function deletePayment(paymentId) {
  const r = currentReceivable();
  if (!r) return;
  r.payments = (r.payments || []).filter((p) => p.id !== paymentId);
  saveReceivable(r);
  renderReceivableModal();
}

function deleteReceivable(id) {
  state.receivables = state.receivables.filter((r) => r.id !== id);
  save();
  renderAll();
  push(() => cloudDeleteReceivable(id));
}

/* ---------------- render root ---------------- */

function renderAll() {
  document.querySelectorAll('[data-cur]').forEach((el) => { el.textContent = symbol(); });
  renderMonthly();
  renderTotal();
  renderReceivables();
}

/* ---------------- events ---------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
  });
});

$('prevMonth').addEventListener('click', () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1);
  renderMonthly();
});

$('nextMonth').addEventListener('click', () => {
  viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1);
  renderMonthly();
});

$('sortSelect').addEventListener('change', () => renderMonthly());
$('groupSelect').addEventListener('change', () => renderMonthly());

$('recFilter').addEventListener('change', () => renderReceivables());

$('receivableForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const amount = Number($('recAmount').value);
  if (!$('recPerson').value.trim()) return alert('Whose money is this?');
  if (!(amount > 0)) return alert('Please enter an amount greater than 0.');
  if (!$('recDate').value) return alert('Please pick the date you gave it.');

  addReceivable($('recPerson').value, amount, $('recDate').value, $('recNote').value);
  e.target.reset();
  $('recDate').value = dateKey(new Date());
  $('recPerson').focus();
});

$('paymentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const r = currentReceivable();
  if (!r) return;
  const amount = Number($('payAmount').value);
  if (!(amount > 0)) return alert('Please enter an amount greater than 0.');

  const remaining = remainingOf(r);
  if (amount - remaining > 0.005 &&
      !confirm(`That is more than the ${fmt(remaining)} still owed. Record it anyway?`)) return;

  addPayment(amount, $('payDate').value || dateKey(new Date()));
  $('payAmount').value = '';
});

$('settleBtn').addEventListener('click', () => {
  const r = currentReceivable();
  if (!r) return;
  const remaining = remainingOf(r);
  if (remaining <= 0) return;
  if (!confirm(`Record the remaining ${fmt(remaining)} as received?`)) return;
  addPayment(remaining, $('payDate').value || dateKey(new Date()));
});

$('deleteRecBtn').addEventListener('click', () => {
  const r = currentReceivable();
  if (!r) return;
  if (!confirm(`Delete the entry for ${r.person}? The payment history goes with it.`)) return;
  const id = r.id;
  closeReceivableModal();
  deleteReceivable(id);
});

$('closeRecModal').addEventListener('click', closeReceivableModal);
$('recModal').addEventListener('click', (e) => {
  if (e.target === $('recModal')) closeReceivableModal();
});

$('todayBtn').addEventListener('click', () => {
  viewDate = new Date();
  renderMonthly();
});

$('saveIncome').addEventListener('click', () => {
  const value = Number($('incomeInput').value);
  if (Number.isNaN(value) || value < 0) return alert('Please enter a valid income amount.');

  if ($('applyAllMonths').checked) {
    state.defaultIncome = value;
    // clear per-month overrides so the new default actually shows everywhere
    state.incomes = {};
    // untick it, so the next save only touches the month being viewed
    $('applyAllMonths').checked = false;
  } else {
    state.incomes[monthKey(viewDate)] = value;
  }
  saveSettings();
  renderAll();
});

$('incomeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('saveIncome').click();
});

$('expenseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const date = $('expDate').value;
  const amount = Number($('expAmount').value);
  if (!date) return alert('Please pick a date.');
  if (!(amount > 0)) return alert('Please enter an amount greater than 0.');

  addExpense(date, amount, $('expCategory').value, $('expNote').value);

  // stay on the day that was just used, so several entries can be added quickly
  modalDate = date;
  $('modalTitle').textContent = prettyDate(date);
  $('expAmount').value = '';
  $('expNote').value = '';
  $('expAmount').focus();
  renderModalList();
});

$('closeModal').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modal').hidden) closeModal();
  else if (!$('recModal').hidden) closeReceivableModal();
  else if (!$('profileModal').hidden) $('profileModal').hidden = true;
});

$('currencySelect').addEventListener('change', (e) => {
  state.currency = e.target.value;
  saveSettings();
  renderAll();
  if (modalDate) renderModalList();
});

$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `expenses-backup-${dateKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.expenses)) throw new Error('bad file');
      state = normalize(Object.assign(defaultState(), data));
      save();
      $('currencySelect').value = state.currency;
      renderAll();
      push(() => cloudReplaceAll(state));
      alert('Backup restored.');
    } catch {
      alert('That file could not be read as an expense backup.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('This deletes every income and expense you have saved, on this device and in the cloud. Continue?')) return;
  state = defaultState();
  save();
  $('currencySelect').value = state.currency;
  renderAll();
  push(() => cloudClearAll());
});

/* ---------------- cloud sync ---------------- */

function showBanner(message) {
  $('bannerText').textContent = message;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function setStatus(kind, label, detail) {
  const el = $('syncStatus');
  el.className = 'sync ' + kind;
  el.title = detail || label;
  $('syncText').textContent = label;
  $('syncDetail').textContent = detail || '';
}

initCloud({
  onData({ settings, expenses, receivables, failed = {} }) {
    const firstDelivery = !cloudReady;
    cloudReady = true;
    applyProfile(settings);

    // first run with data already in this browser: lift it up rather than
    // letting an empty cloud wipe it
    // a stream that errored reports empty; keep what is already on hand
    // rather than letting it blank out the local copy
    if (failed.expenses) expenses = state.expenses;
    if (failed.receivables) receivables = state.receivables;

    if (firstDelivery && !failed.expenses && !failed.receivables &&
        !expenses.length && !receivables.length &&
        (state.expenses.length || state.receivables.length) &&
        !localStorage.getItem(MIGRATED_KEY)) {
      localStorage.setItem(MIGRATED_KEY, '1');
      push(() => cloudMigrate(state));
      return;
    }
    localStorage.setItem(MIGRATED_KEY, '1');

    state = normalize({
      currency: settings.currency || state.currency,
      defaultIncome: failed.settings ? state.defaultIncome : (Number(settings.defaultIncome) || 0),
      incomes: failed.settings ? state.incomes : (settings.incomes || {}),
      expenses,
      receivables
    });
    if (openReceivableId) renderReceivableModal();
    save();
    $('currencySelect').value = state.currency;
    renderAll();
    if (modalDate) renderModalList();
  },

  onStatus({ state: kind, message, code, user }) {
    if (kind === 'signed-out') {
      showAuthScreen();
      return;
    }

    showApp(user);
    $('syncSection').hidden = !isOwner(user);

    if (kind === 'synced') {
      // a recovered connection has to clear any warning left on screen
      hideBanner();
      setStatus('ok', user && user.isAnonymous ? 'Synced (guest)' : 'Synced',
        user && user.isAnonymous
          ? 'Guest account — create an account to keep this data if you clear your browser.'
          : `Signed in as ${user.email || user.displayName}`);
    } else if (kind === 'offline') {
      hideBanner();
      setStatus('warn', 'Offline', 'Showing cached data. Changes will upload when you reconnect.');
    } else if (kind === 'error') {
      setStatus('bad', 'Sync error', message);
      // the setup-specific wording only helps whoever administers the project.
      // a rejected request is not a dropped connection — promising it will
      // upload later would be a lie, so say something true instead.
      const blocked = code === 'permission-denied' || String(code || '').startsWith('auth/');
      showBanner(isOwner(user)
        ? message
        : blocked
          ? 'Syncing is unavailable at the moment. Your entries are saved on this device.'
          : 'Could not reach the server. Your entries are saved on this device and will upload once you are back online.');
    } else {
      setStatus('', 'Connecting…');
    }
  }
});

/* ---------------- auth screen ---------------- */

function showAuthScreen() {
  cloudReady = false;
  document.body.classList.remove('booting');
  $('authScreen').hidden = false;
  $('appShell').hidden = true;
  hideBanner();

  // never leave one account's figures on screen for the next person
  state = defaultState();
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(MIGRATED_KEY);
  renderAll();
}

function showApp(user) {
  document.body.classList.remove('booting');
  $('authScreen').hidden = true;
  $('appShell').hidden = false;
  renderIdentity(user);
}

function authMessage(el, message, isError = true) {
  const target = $(el);
  target.textContent = message;
  target.hidden = !message;
  if (message && isError) target.classList.remove('ok');
}

function clearAuthMessages() {
  $('authError').hidden = true;
  $('authNotice').hidden = true;
}

async function runAuth(button, action) {
  clearAuthMessages();
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Please wait…';
  try {
    await action();
  } catch (err) {
    // closing the Google popup yourself is not an error worth shouting about
    if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
      authMessage('authError', authErrorMessage(err));
    }
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const login = tab.dataset.authTab === 'login';
    $('loginForm').hidden = !login;
    $('registerForm').hidden = login;
    clearAuthMessages();
  });
});

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  runAuth(btn, () => loginWithEmail($('loginEmail').value, $('loginPassword').value));
});

$('registerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('regPassword').value !== $('regConfirm').value) {
    return authMessage('authError', 'The two passwords do not match.');
  }
  const btn = e.target.querySelector('button[type="submit"]');
  runAuth(btn, () => registerWithEmail($('regEmail').value, $('regPassword').value, $('regName').value));
});

$('googleBtn').addEventListener('click', (e) => runAuth(e.currentTarget, signInWithGoogle));
$('guestBtn').addEventListener('click', (e) => runAuth(e.currentTarget, continueAsGuest));

$('forgotBtn').addEventListener('click', async (e) => {
  const email = $('loginEmail').value.trim();
  if (!email) return authMessage('authError', 'Enter your email above first, then tap this again.');
  await runAuth(e.currentTarget, async () => {
    await resetPassword(email);
    authMessage('authNotice', `Reset link sent to ${email}. Check your inbox.`, false);
    $('authNotice').classList.add('ok');
  });
});

/* ---------------- profile ---------------- */

function initials(user, name) {
  const source = (name || user?.displayName || user?.email || '?').trim();
  return source.charAt(0).toUpperCase() || '?';
}

function renderIdentity(user, profile = {}) {
  const name = profile.displayName || user?.displayName || '';
  const photo = profile.photo || user?.photoURL || '';

  $('avatarInitial').textContent = initials(user, name);
  $('avatarImg').hidden = !photo;
  $('avatarInitial').hidden = !!photo;
  if (photo) $('avatarImg').src = photo;

  $('profileInitial').textContent = initials(user, name);
  $('profilePhoto').hidden = !photo;
  $('profileInitial').hidden = !!photo;
  if (photo) $('profilePhoto').src = photo;
  $('removePhotoBtn').hidden = !profile.photo;

  $('profileName').textContent = name || (user?.isAnonymous ? 'Guest' : 'No name set');
  $('profileEmail').textContent = user?.isAnonymous ? 'Guest account — not saved anywhere else' : (user?.email || '');
  if (document.activeElement !== $('nameInput')) $('nameInput').value = name;

  const canChangePassword = hasPasswordProvider();
  $('passwordForm').hidden = !canChangePassword;
  $('googleNote').hidden = canChangePassword || !!user?.isAnonymous;
}

// last known profile, so optimistic edits survive a re-render
let localProfile = {};

function applyProfile(settings) {
  localProfile = {
    displayName: settings?.displayName ?? localProfile.displayName,
    photo: settings?.photo ?? localProfile.photo
  };
  renderIdentity(currentUser(), localProfile);
}

/** Paints a profile change straight away, without waiting on the network. */
function previewProfile(patch) {
  localProfile = { ...localProfile, ...patch };
  renderIdentity(currentUser(), localProfile);
}

$('profileBtn').addEventListener('click', () => {
  $('profileError').hidden = true;
  $('profileNotice').hidden = true;
  $('profileModal').hidden = false;
});

$('closeProfile').addEventListener('click', () => { $('profileModal').hidden = true; });
$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) $('profileModal').hidden = true;
});

$('nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    previewProfile({ displayName: $('nameInput').value.trim() });
    await saveProfile({ name: $('nameInput').value });
    $('profileError').hidden = true;
    authMessage('profileNotice', 'Name updated.', false);
    $('profileNotice').classList.add('ok');
  } catch (err) {
    authMessage('profileError', authErrorMessage(err));
  }
});

$('passwordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await changePassword($('currentPassword').value, $('newPassword').value);
    $('currentPassword').value = '';
    $('newPassword').value = '';
    $('profileError').hidden = true;
    authMessage('profileNotice', 'Password updated.', false);
    $('profileNotice').classList.add('ok');
  } catch (err) {
    $('profileNotice').hidden = true;
    authMessage('profileError', authErrorMessage(err));
  } finally {
    btn.disabled = false;
  }
});

$('photoBtn').addEventListener('click', () => $('photoFile').click());

$('photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, 256);
    previewProfile({ photo: dataUrl });          // show it now
    authMessage('profileNotice', 'Saving photo…', false);
    $('profileNotice').classList.add('ok');
    $('profileError').hidden = true;
    await saveProfile({ photo: dataUrl });       // then persist
    authMessage('profileNotice', 'Photo updated.', false);
    $('profileNotice').classList.add('ok');
  } catch (err) {
    $('profileNotice').hidden = true;
    authMessage('profileError', `Could not save that image: ${authErrorMessage(err)}`);
  }
});

$('removePhotoBtn').addEventListener('click', async () => {
  try {
    previewProfile({ photo: '' });
    await saveProfile({ photo: '' });
    authMessage('profileNotice', 'Photo removed.', false);
    $('profileNotice').classList.add('ok');
  } catch (err) {
    authMessage('profileError', authErrorMessage(err));
  }
});

/**
 * Squares off and shrinks the picture before upload. Firebase Storage needs a
 * paid plan on new projects, so the avatar rides along in the Firestore
 * document instead — which means it has to stay small.
 */
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('that file is not an image'));

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('the file could not be read'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('the image could not be decoded'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');

        // centre-crop to a square so faces do not end up stretched
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2,
          side, side, 0, 0, size, size);

        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

$('signOutBtn').addEventListener('click', async () => {
  if (!confirm('Sign out of this device?')) return;
  $('profileModal').hidden = true;
  try {
    await signOutUser();
  } catch (err) {
    showBanner(authErrorMessage(err));
  }
});

/* ---------------- boot ---------------- */

$('currencySelect').value = state.currency;
$('recDate').value = dateKey(new Date());
save();        // persist the normalised shape for anything upgraded by load()
renderAll();
