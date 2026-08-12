/* =========================================================
   Expense Calculator — all state lives in localStorage.
   ========================================================= */

const STORAGE_KEY = 'expense-calculator-v1';

const CURRENCY_SYMBOLS = {
  PKR: '₨', INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SAR: '﷼'
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const defaultState = () => ({
  currency: 'PKR',
  defaultIncome: 0,
  incomes: {},   // "YYYY-MM" -> number
  expenses: []   // { id, date: "YYYY-MM-DD", amount, category, note }
});

let state = load();
let viewDate = new Date();           // which month the Monthly tab is showing
let modalDate = null;                // "YYYY-MM-DD" currently open in the modal

/* ---------------- storage ---------------- */

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  } catch {
    return defaultState();
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

function sum(list) {
  return list.reduce((total, e) => total + (Number(e.amount) || 0), 0);
}

/* ---------------- monthly tab ---------------- */

function renderMonthly() {
  const key = monthKey(viewDate);
  const income = incomeFor(key);
  const monthExpenses = expensesFor(key);
  const spent = sum(monthExpenses);
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

  // daily average uses days elapsed for the current month, full length otherwise
  const now = new Date();
  const isCurrentMonth = monthKey(now) === key;
  const daysInMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 0).getDate();
  const daysCounted = isCurrentMonth ? now.getDate() : daysInMonth;
  $('mAvg').textContent = fmt(spent / daysCounted);

  const pct = income > 0 ? (spent / income) * 100 : (spent > 0 ? 100 : 0);
  const fill = $('progressFill');
  fill.style.width = Math.min(pct, 100) + '%';
  fill.classList.toggle('over', pct > 100);
  $('progressText').textContent = income > 0
    ? `${pct.toFixed(1)}% of budget used · ${remaining >= 0 ? fmt(remaining) + ' left' : fmt(Math.abs(remaining)) + ' over budget'}`
    : 'Set a monthly income to track your budget';

  renderCalendar(key);
  renderMonthList(monthExpenses);
  renderBars($('categoryBreakdown'), groupBy(monthExpenses, 'category'), 'No expenses this month yet.');
}

function renderCalendar(key) {
  const cal = $('calendar');
  cal.innerHTML = '';

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = dateKey(new Date());

  // per-day totals for this month
  const totals = {};
  for (const e of expensesFor(key)) {
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

function renderMonthList(list) {
  const box = $('monthList');
  const sorted = [...list].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  $('listCount').textContent = `${sorted.length} ${sorted.length === 1 ? 'entry' : 'entries'}`;

  if (!sorted.length) {
    box.innerHTML = '<p class="empty">No expenses recorded for this month. Click a date on the calendar to add one.</p>';
    return;
  }

  box.innerHTML = '';
  for (const e of sorted) box.appendChild(entryRow(e, true));
}

function entryRow(e, showDate) {
  const row = document.createElement('div');
  row.className = 'entry';
  row.innerHTML = `
    <div class="entry-main">
      <div class="entry-top">
        <span class="entry-cat">${escapeHtml(e.category || 'Other')}</span>
        ${showDate ? `<span class="entry-date">${prettyDate(e.date)}</span>` : ''}
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
  const totalSpent = sum(state.expenses);

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

  // spending by month
  const byMonth = {};
  for (const k of sortedKeys) byMonth[monthTitle(k)] = sum(expensesFor(k));
  renderBars($('monthlyChart'), byMonth, 'Nothing recorded yet.', false);

  renderBars($('totalCategory'), groupBy(state.expenses, 'category'), 'Nothing recorded yet.');

  // summary table
  const body = $('summaryBody');
  body.innerHTML = '';
  if (!sortedKeys.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">No data yet — add an income and some expenses to get started.</td></tr>';
    return;
  }

  for (const k of [...sortedKeys].reverse()) {
    const income = incomeFor(k);
    const list = expensesFor(k);
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

  const max = Math.max(...pairs.map(([, v]) => v));
  container.innerHTML = '';
  for (const [label, value] of pairs) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(value / max) * 100}%"></span></span>
      <span class="bar-val">${fmt(value)}</span>`;
    container.appendChild(row);
  }
}

/* ---------------- expense actions ---------------- */

function addExpense(date, amount, category, note) {
  state.expenses.push({
    id: Date.now() + Math.floor(Math.random() * 1000),
    date,
    amount: Number(amount),
    category,
    note: note.trim()
  });
  save();
  renderAll();
}

function deleteExpense(id) {
  state.expenses = state.expenses.filter((e) => e.id !== id);
  save();
  renderAll();
  if (modalDate) renderModalList();
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
    .sort((a, b) => b.id - a.id);

  $('dayTotal').textContent = fmt(sum(list));
  const box = $('dayList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="empty">Nothing logged for this day yet.</p>';
    return;
  }
  for (const e of list) box.appendChild(entryRow(e, false));
}

/* ---------------- render root ---------------- */

function renderAll() {
  document.querySelectorAll('[data-cur]').forEach((el) => { el.textContent = symbol(); });
  renderMonthly();
  renderTotal();
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
  save();
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
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

$('currencySelect').addEventListener('change', (e) => {
  state.currency = e.target.value;
  save();
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
      state = Object.assign(defaultState(), data);
      save();
      $('currencySelect').value = state.currency;
      renderAll();
      alert('Backup restored.');
    } catch {
      alert('That file could not be read as an expense backup.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('This deletes every income and expense you have saved. Continue?')) return;
  state = defaultState();
  save();
  $('currencySelect').value = state.currency;
  renderAll();
});

/* ---------------- boot ---------------- */

$('currencySelect').value = state.currency;
renderAll();
