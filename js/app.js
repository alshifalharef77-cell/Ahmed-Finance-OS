import { add, all, batchWrite, exportData, softDelete, stores as databaseStores, update, upsert } from './db.js';

const $ = selector => document.querySelector(selector);
const output = $('#terminalOutput');
const input = $('#commandInput');
const stores = ['expenses', 'income', 'fuel'];
const types = ['exp', 'inc', 'fuel'];
const storeFor = { exp: 'expenses', inc: 'income', fuel: 'fuel' };
const typeLabels = { exp: 'EXPENSE', inc: 'INCOME', fuel: 'FUEL' };
const baseWallets = [{ code: 'c', name: 'Cash' }, { code: 't', name: 'Telda' }, { code: 'n', name: 'NBK' }, { code: 'b', name: 'CIB' }, { code: 'i', name: 'InstaPay' }, { code: 'o', name: 'Other' }];
const themes = { green: '#00ff66', orange: '#ff9f1c' };
const defaults = { theme: 'green', semantic: 'off', highContrast: false, entryMode: 'guided', fuelPrice: 19, lastWallet: 'c', lastCategory: '', dashboard: { today: true, week: true, month: true, due: true }, dueSuggestions: true };

let preferences = structuredClone(defaults);
let transactions = [], wallets = [], categories = [], dues = [], favorites = [], listedTransactions = [];
let entryDraft = null, editDraft = null, dueDraft = null, dueEditDraft = null, pendingDueMatch = null, walletFlow = null;
const undoStack = [];
const history = []; let historyIndex = 0;
let cloudUnlocked = false, cloudPin = sessionStorage.getItem('finance-pin') || '';

const today = () => new Date().toISOString().slice(0, 10);
const money = value => `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Number(value) || 0)} EGP`;
const dateText = value => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
const pad = (value, length) => String(value ?? '').slice(0, length).padEnd(length, ' ');
const divider = (width = 88) => '-'.repeat(width);
const isoDays = value => Math.ceil((new Date(`${value}T12:00:00`) - new Date(`${today()}T12:00:00`)) / 86400000);
const validAmount = value => Number.isFinite(Number(value)) && Number(value) > 0;

function scrollToLatest() { requestAnimationFrame(() => { output.scrollTop = output.scrollHeight; }); }
function print(text = '', tone = '') { const block = document.createElement('pre'); block.className = `output-block ${tone}`; block.textContent = text; output.append(block); scrollToLatest(); }
function toneFor(type) { return preferences.semantic === 'full' || preferences.semantic === 'basic' ? ({ inc: 'income', exp: 'expense', fuel: preferences.semantic === 'full' ? 'fuel' : '' }[type] || '') : ''; }
function activeWallets() { return wallets.filter(wallet => !wallet.hidden); }
function activeCategories() { return categories.filter(category => !category.hidden); }
function walletByCode(code) { return activeWallets().find(wallet => wallet.code === String(code || '').toLowerCase()) || null; }
function walletByName(name) { return wallets.find(wallet => wallet.name === name) || null; }
function walletName(code) { if (!code) return 'Unassigned'; return walletByCode(code)?.name || wallets.find(wallet => wallet.code === code)?.name || 'Unassigned'; }
function anyWalletByCode(code) { return wallets.find(wallet => wallet.code === String(code || '').toLowerCase()) || null; }
function categoryExists(name) { return activeCategories().some(category => category.name.toLowerCase() === String(name).toLowerCase()); }

async function getSetting(key) { return (await all('settings')).find(item => item.key === key); }
async function savePreferences() { const item = await getSetting('app-preferences'); if (item) await update('settings', item.id, { value: preferences }); else await add('settings', { key: 'app-preferences', value: preferences }); }
async function loadPreferences() { const item = await getSetting('app-preferences'); preferences = { ...structuredClone(defaults), ...(item?.value || {}), dashboard: { ...defaults.dashboard, ...(item?.value?.dashboard || {}) } }; applyTheme(); }
function applyTheme() { const accent = themes[preferences.theme] || themes.green; document.documentElement.style.setProperty('--accent', accent); document.documentElement.style.setProperty('--line', preferences.theme === 'orange' ? '#553817' : '#263129'); document.documentElement.style.setProperty('--bg', preferences.highContrast ? '#000000' : '#0b0b0b'); }


async function seedCollections() {
  const existingWallets = await all('wallets');

  if (!existingWallets.length) {
    for (const wallet of baseWallets) {
      await upsert('wallets', {
        id: `wallet_${wallet.code}`,
        ...wallet,
        hidden: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deleted: false
      });
    }
  }

  const walletRecords = await all('wallets');

  for (const wallet of walletRecords) {
    if (!Object.prototype.hasOwnProperty.call(wallet, 'actualBalance')) {
      await update('wallets', wallet.id, {
        actualBalance: null
      });
    }
  }

  const existingCategories = await all('categories');
  const legacy = (await Promise.all(stores.map(all))).flat().map(row => row.category).filter(Boolean);
  for (const name of [...new Set(legacy)]) if (!existingCategories.some(item => item.name.toLowerCase() === name.toLowerCase())) await add('categories', { name });
}


async function loadData() {
  wallets = await all('wallets'); categories = await all('categories'); dues = await all('dues'); favorites = await all('favorites');
  const rows = await Promise.all(stores.map(all));
  transactions = rows.flatMap((items, index) => items.map(item => ({ ...item, type: types[index], walletCode: item.walletCode || walletByName(item.wallet)?.code || null })));
}
async function ensureCategory(name) { if (!name || categoryExists(name)) return; await add('categories', { name }); categories = await all('categories'); }

function inPeriod(date, period) {
  const point = new Date(`${date}T12:00:00`), now = new Date(`${today()}T12:00:00`);
  if (period === 'today') return date === today();
  if (period === 'week') { const start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); return point >= start && point <= now; }
  return point.getFullYear() === now.getFullYear() && point.getMonth() === now.getMonth();
}
function periodTotals(period) {
  const sum = type => transactions.filter(row => row.type === type && !row.transfer && inPeriod(row.date, period)).reduce((total, row) => total + Number(row.amount), 0);
  const income = sum('inc'), expenses = sum('exp'), fuel = sum('fuel'); return { income, expenses, fuel, balance: income - expenses - fuel };
}
function summary(name, period) { const values = periodTotals(period); return `${name}\n${divider()}\nIncome     : ${money(values.income)}\nExpenses   : ${money(values.expenses)}\nFuel       : ${money(values.fuel)}\nBalance    : ${money(values.balance)}`; }
function calculateWalletBalances() {
  const balances = new Map(
    wallets.map(wallet => [
      wallet.code,
      {
        wallet,
        calculated: 0
      }
    ])
  );

  for (const transaction of transactions) {
    const wallet = balances.get(transaction.walletCode);
    if (!wallet) continue;

    const amount = Number(transaction.amount) || 0;

    if (transaction.type === 'inc') {
      wallet.calculated += amount;
    } else if (transaction.type === 'exp' || transaction.type === 'fuel') {
      wallet.calculated -= amount;
    }
  }

  return balances;
}

function getWalletBalanceInfo(wallet, balances = calculateWalletBalances()) {
  const data = balances.get(wallet.code);
  const calculated = Number(data?.calculated) || 0;

  const hasActualBalance =
    wallet.actualBalance !== null &&
    wallet.actualBalance !== undefined &&
    Number.isFinite(Number(wallet.actualBalance));

  if (!hasActualBalance) {
    return {
      wallet,
      calculated,
      actual: null,
      difference: null,
      status: 'NOT AUDITED'
    };
  }

  const actual = Number(wallet.actualBalance);
  const difference = actual - calculated;

  return {
    wallet,
    calculated,
    actual,
    difference,
    status: Math.abs(difference) < 0.005
      ? 'SYNCED'
      : 'NEEDS RECONCILIATION'
  };
}

function walletTable() {
  const balances = calculateWalletBalances();

  const rows = activeWallets().map(wallet => {
    const info = getWalletBalanceInfo(wallet, balances);

    const balance = info.actual !== null
      ? info.actual
      : info.calculated;

    const status = info.status === 'SYNCED'
      ? ' ✔'
      : info.status === 'NEEDS RECONCILIATION'
        ? ' ⚠'
        : '';

    return `${pad(wallet.name, 14)} ${money(balance)}${status}`;
  });

  return [
    'WALLET         BALANCE',
    '-'.repeat(31),
    ...(rows.length ? rows : ['No active wallets.'])
  ].join('\n');
}
function walletPosition() {
  const balances = calculateWalletBalances();
  const infos = activeWallets().map(wallet => getWalletBalanceInfo(wallet, balances));
  const verified = infos.filter(info => info.actual !== null).reduce((sum, info) => sum + info.actual, 0);
  const unverified = infos.filter(info => info.actual === null).reduce((sum, info) => sum + info.calculated, 0);
  const needs = infos.filter(info => info.status === 'NEEDS RECONCILIATION').length;
  return `MONEY POSITION\n${divider()}\nVerified actual : ${money(verified)}\nUnverified calc : ${money(unverified)}\nNeeds reconcile : ${needs}\n\n${infos.map(info => `${pad(info.wallet.name, 14)} Actual: ${pad(info.actual === null ? 'Not audited' : money(info.actual), 16)} Calc: ${pad(money(info.calculated), 16)} ${info.difference === null ? 'NOT AUDITED' : `${money(info.difference)} ${info.status}`}`).join('\n')}`;
}
function dueSummary() { const open = dues.filter(due => !due.paid).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 3); if (!open.length) return 'DUE\n' + divider() + '\nNo upcoming dues.'; return `DUE\n${divider()}\n${open.map(due => { const days = isoDays(due.dueDate); return `${pad(due.title, 22)} ${due.amount ? pad(money(due.amount), 14) : pad('-', 14)} ${days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'due today' : `${days} days remaining`}`; }).join('\n')}`; }
function transactionTable(rows, numbered = false) { if (!rows.length) return 'No transactions found.'; const header = `${numbered ? '#   ' : ''}DATE         TYPE      AMOUNT          WALLET         CATEGORY / ODOMETER       DESCRIPTION`; const lines = rows.map((row, index) => { const detail = row.type === 'fuel' ? `${row.odometer || '-'} km` : row.category; return `${numbered ? `${pad(index + 1, 3)} ` : ''}${pad(dateText(row.date), 12)} ${pad(typeLabels[row.type], 9)} ${pad(money(row.amount), 15)} ${pad(walletName(row.walletCode), 14)} ${pad(detail, 23)} ${String(row.description || '-').slice(0, 24)}`; }); return [header, divider(), ...lines].join('\n'); }

function showDashboard() {
  const parts = [`Welcome back, Ahmed.\n\nAhmed Finance OS — Alpha 3.0\n${new Intl.DateTimeFormat('en-GB', { dateStyle: 'full' }).format(new Date())}\nYour finance terminal is ready.`, '', walletPosition(), ''];
  if (preferences.dashboard.today) parts.push(summary('TODAY', 'today'), '');
  if (preferences.dashboard.week) parts.push(summary('WEEK', 'week'), '');
  if (preferences.dashboard.month) parts.push(summary('MONTH', 'month'), '');
  if (preferences.dashboard.due) parts.push(dueSummary(), '');
  parts.push(walletTable(), '', `Last wallet: ${walletName(preferences.lastWallet)}\nRECENT ACTIVITY\n${divider()}\n${transactionTable([...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5))}`, '', 'Type help to see commands.');
  print(parts.join('\n'), 'success');
}

function showHelp() {
  print(
    `AHMED FINANCE OS — ALPHA 3.0 COMMANDS
${divider()}

DASHBOARD
dash | home                         show dashboard
help                                show this help
clear                               clear terminal

TRANSACTIONS
exp | inc | fuel                    guided transaction entry
exp <amount> <category> [wallet] [note]
inc <amount> <category> [wallet] [note]
fuel <cost> <odometer> <full|partial> [wallet] [note]
list [all|exp|inc|fuel]             list transactions
filter <category> | search <text>   find transactions
edit <row> | delete <row>           edit or delete a listed transaction
repeat | undo                       repeat or undo recent actions

WALLETS — ALPHA 3.0
wallets                             open Wallet Manager
wallet list                         view Calculated / Actual / Difference
wallet balance <code> <amount>      reconcile one wallet
wallet audit                        audit all active wallets
wallet add <code> <name>            add wallet
wallet rename <code> <name>         rename wallet
wallet hide <code>                  hide wallet
wallet restore <code>               restore hidden wallet
move <amount> <from> <to>           transfer between wallets

FUEL CENTER
fuel page                           full fuel history and performance report
fuel stats                          fuel center shortcut
fuel <cost> <odometer> <full|partial> [wallet] [note]

OTHER
category                            manage categories
due add | due list | due done <row> manage dues
favorite | fav                      saved transaction templates
settings | theme                    preferences
report | backup                     reports and backup

Wallet codes:
${activeWallets()
  .map(wallet => `${wallet.code.toUpperCase()} ${wallet.name}`)
  .join(' | ')}`,
    'muted'
  );
}

async function mergeCloudData(remote) {
  for (const store of databaseStores) {
    const local = await all(store, true);
    const localById = new Map(local.map(record => [record.id, record]));
    for (const record of remote.data?.[store] || []) {
      const current = localById.get(record.id);
      if (!current || new Date(record.updatedAt || 0) > new Date(current.updatedAt || 0)) await upsert(store, record);
    }
  }
}
async function sync(reason = 'change') {
  if (!cloudUnlocked) return;
  const status = $('#connectionStatus'); status.textContent = 'CLOUD / SYNCING';
  try {
    const response = await fetch('/api/finance', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-finance-pin': cloudPin, 'x-sync-reason': reason }, body: JSON.stringify(await exportData()) });
    if (!response.ok) throw new Error('sync failed');
    status.textContent = 'CLOUD / SYNCED';
  } catch { status.textContent = 'CLOUD / WAITING'; }
}
async function changed(reason) { await loadData(); void sync(reason); }
async function rememberUndo(action) { undoStack.push(action); if (undoStack.length > 50) undoStack.shift(); }

function showLock(message = '') { output.replaceChildren(); print(`AHMED FINANCE OS — ALPHA 0.2.7\n${divider()}\nCloud sync is locked.\nEnter your personal PIN to unlock your data.${message ? `\n\n${message}` : ''}`, 'warning'); input.type = 'password'; input.placeholder = 'enter PIN'; input.autocomplete = 'current-password'; input.focus(); }
async function unlock(pin) {
  const status = $('#connectionStatus'); status.textContent = 'CLOUD / CHECKING';
  try {
    const response = await fetch('/api/finance', { headers: { 'x-finance-pin': pin } });
    const payload = await response.json();
    if (!response.ok) { showLock(payload.error || 'PIN was not accepted.'); return; }
    cloudPin = pin; cloudUnlocked = true; sessionStorage.setItem('finance-pin', pin);
    await mergeCloudData(payload); await loadData(); await sync('unlock');
    input.type = 'text'; input.autocomplete = 'off'; input.placeholder = 'type help to see commands'; status.textContent = 'CLOUD / SYNCED'; output.replaceChildren(); showDashboard();
  } catch { showLock('Unable to reach the cloud. Check the deployed Vercel site.'); }
}

function parseQuick(type, parts) {
  const amount = Number(parts[0]); if (!validAmount(amount)) return { error: 'Error: amount must be a positive number.' };
  if (type === 'fuel') { const odometer = Number(parts[1]), fillType = String(parts[2] || '').toLowerCase(); if (!Number.isFinite(odometer) || odometer < 0) return { error: 'Error: odometer must be a non-negative number.' }; if (!['full', 'partial'].includes(fillType)) return { error: 'Error: fill type must be full or partial.' }; const selected = walletByCode(parts[3]) ? parts[3] : preferences.lastWallet; const noteStart = walletByCode(parts[3]) ? 4 : 3; return { amount, odometer, fillType, walletCode: selected, description: parts.slice(noteStart).join(' '), liters: amount / Number(preferences.fuelPrice), fuelPrice: Number(preferences.fuelPrice) }; }
  const category = parts[1]; if (!category) return { error: 'Error: category is required.' }; const selected = walletByCode(parts[2]) ? parts[2] : preferences.lastWallet; const noteStart = walletByCode(parts[2]) ? 3 : 2; return { amount, category, walletCode: selected, description: parts.slice(noteStart).join(' ') };
}
async function saveTransaction(type, values) {
  const record = { ...values, type, date: values.date || today() };
  ['id', 'createdAt', 'updatedAt', 'deleted', 'wallet'].forEach(key => delete record[key]);
  const saved = await add(storeFor[type], record); preferences.lastWallet = record.walletCode; if (record.category) { preferences.lastCategory = record.category; await ensureCategory(record.category); } await savePreferences(); await changed('transaction'); await rememberUndo({ kind: 'add', store: storeFor[type], record: saved }); print(`Saved ${typeLabels[type].toLowerCase()}: ${money(record.amount)} | ${walletName(record.walletCode)}`, toneFor(type) || 'success');
  if (type === 'exp') await suggestDue(record);
  showDashboard();
}
async function suggestDue(record) { if (!preferences.dueSuggestions) return; const match = dues.find(due => !due.paid && Number(due.amount) === Number(record.amount) && due.title.toLowerCase().includes(String(record.category || record.description).toLowerCase())); if (match) { pendingDueMatch = { due: match, transaction: record }; print(`Possible Due match: ${match.title} — ${money(match.amount)} — ${dateText(match.dueDate)}\nMark this Due as paid? [Y/n]`, 'warning'); input.placeholder = 'Y marks it paid · n keeps it open'; } }

function entryFields(type) { if (type === 'fuel') return [['Cost', 'Example: 500'], ['Odometer', 'Example: 45200'], ['Fill type', 'full or partial'], ['Wallet code', `Enter = ${preferences.lastWallet.toUpperCase()} ${walletName(preferences.lastWallet)}`], ['Note', 'Optional — Enter to skip']]; return [['Amount', 'Example: 120'], ['Category', `Enter = ${preferences.lastCategory || 'required'}`], ['Wallet code', `Enter = ${preferences.lastWallet.toUpperCase()} ${walletName(preferences.lastWallet)}`], ['Note', 'Optional — Enter to skip']]; }
function promptEntry() { const [label, hint] = entryFields(entryDraft.type)[entryDraft.step]; print(`${label}: ${hint}`, 'muted'); input.placeholder = `${hint} · type cancel to stop`; }
async function startTransaction(type, parts) { if (parts.length || preferences.entryMode === 'quick') { const parsed = parseQuick(type, parts); if (parsed.error) { print(`${parsed.error}\nType ${type} with no values for guided entry.`, 'error'); return; } await saveTransaction(type, parsed); return; } entryDraft = { type, step: 0, values: {} }; print(`ADDING ${typeLabels[type]}\nType cancel to abandon.`, 'warning'); promptEntry(); }
async function continueEntry(raw) { const answer = raw.trim(), draft = entryDraft; if (answer.toLowerCase() === 'cancel') { entryDraft = null; print('Entry cancelled. No data was changed.', 'warning'); return; } const fields = entryFields(draft.type); const blankDefault = draft.type === 'fuel' && draft.step === 3 ? preferences.lastWallet : draft.type !== 'fuel' && draft.step === 1 ? preferences.lastCategory : draft.type !== 'fuel' && draft.step === 2 ? preferences.lastWallet : '';
  const value = answer || blankDefault;
  if (draft.step === 0 && !validAmount(value)) { print('Error: amount must be positive.', 'error'); promptEntry(); return; }
  if (draft.type === 'fuel' && draft.step === 1 && (!Number.isFinite(Number(value)) || Number(value) < 0)) { print('Error: enter a valid odometer.', 'error'); promptEntry(); return; }
  if (draft.type === 'fuel' && draft.step === 2 && !['full', 'partial'].includes(value.toLowerCase())) { print('Error: choose full or partial.', 'error'); promptEntry(); return; }
  if (draft.type !== 'fuel' && draft.step === 1 && !value) { print('Error: category is required.', 'error'); promptEntry(); return; }
  const walletStep = draft.type === 'fuel' ? 3 : 2; if (draft.step === walletStep && !walletByCode(value)) { print(`Error: use one of: ${activeWallets().map(item => item.code.toUpperCase()).join(', ')}.`, 'error'); promptEntry(); return; }
  const keys = draft.type === 'fuel' ? ['amount', 'odometer', 'fillType', 'walletCode', 'description'] : ['amount', 'category', 'walletCode', 'description']; draft.values[keys[draft.step]] = draft.step === 0 || (draft.type === 'fuel' && draft.step === 1) ? Number(value) : value;
  draft.step += 1; if (draft.step < fields.length) { promptEntry(); return; } entryDraft = null; if (draft.type === 'fuel') { draft.values.liters = draft.values.amount / Number(preferences.fuelPrice); draft.values.fuelPrice = Number(preferences.fuelPrice); } await saveTransaction(draft.type, draft.values); input.placeholder = 'type help to see commands'; }

function findRow(row) { const index = Number(row) - 1; return Number.isInteger(index) && index >= 0 ? listedTransactions[index] || null : null; }
function editFields(record) { const base = [['Amount', record.amount], ['Date', record.date]]; if (record.type === 'fuel') return [...base, ['Odometer', record.odometer], ['Fill type', record.fillType], ['Wallet code', record.walletCode], ['Note', record.description || '-']]; return [...base, ['Category', record.category], ['Wallet code', record.walletCode], ['Note', record.description || '-']]; }
function promptEdit() { const [label, value] = editFields(editDraft.values)[editDraft.step]; print(`${label} [${value}]:`, 'muted'); input.placeholder = `Enter keeps: ${value} · cancel stops`; }
async function startEdit(row) { const record = findRow(row); if (!record) { print('Error: run list first, then use its row number.', 'error'); return; } editDraft = { row, record, values: { ...record }, step: 0 }; print(`EDITING ROW ${row}\nPress Enter to keep a value.`, 'warning'); promptEdit(); }
async function continueEdit(raw) { const answer = raw.trim(); if (answer.toLowerCase() === 'cancel') { editDraft = null; print('Edit cancelled.', 'warning'); return; } const draft = editDraft, fields = editFields(draft.values), [label] = fields[draft.step]; if (answer) { if (label === 'Amount' && !validAmount(answer)) { print('Error: amount must be positive.', 'error'); promptEdit(); return; } if (label === 'Date' && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) { print('Error: use YYYY-MM-DD.', 'error'); promptEdit(); return; } if (label === 'Odometer' && (!Number.isFinite(Number(answer)) || Number(answer) < 0)) { print('Error: valid odometer required.', 'error'); promptEdit(); return; } if (label === 'Fill type' && !['full', 'partial'].includes(answer.toLowerCase())) { print('Error: full or partial.', 'error'); promptEdit(); return; } if (label === 'Wallet code' && !walletByCode(answer)) { print('Error: invalid wallet code.', 'error'); promptEdit(); return; } const key = ({ Amount: 'amount', Date: 'date', Category: 'category', 'Wallet code': 'walletCode', Note: 'description', Odometer: 'odometer', 'Fill type': 'fillType' })[label]; draft.values[key] = ['amount', 'odometer'].includes(key) ? Number(answer) : key === 'walletCode' ? answer.toLowerCase() : key === 'description' && answer === '-' ? '' : answer; }
  draft.step += 1; if (draft.step < fields.length) { promptEdit(); return; } if (draft.values.type === 'fuel') draft.values.liters = draft.values.amount / Number(draft.values.fuelPrice || preferences.fuelPrice); await update(storeFor[draft.record.type], draft.record.id, draft.values); await rememberUndo({ kind: 'update', store: storeFor[draft.record.type], id: draft.record.id, before: draft.record }); editDraft = null; await changed('edit'); print(`Updated row ${draft.row}.`, 'success'); showDashboard(); }
async function deleteTransaction(row) { const record = findRow(row); if (!record) { print('Error: run list first, then use its row number.', 'error'); return; } await softDelete(storeFor[record.type], record.id); await rememberUndo({ kind: 'restore', store: storeFor[record.type], id: record.id }); await changed('delete'); listedTransactions = []; print(`Deleted row ${row}. Use undo to restore it.`, 'warning'); showDashboard(); }

function listTransactions(parts) { const filter = (parts[0] || 'all').toLowerCase(); let rows = [...transactions], label = filter.toUpperCase(); if (filter === 'cat' || filter === 'category') { const category = parts.slice(1).join(' ').toLowerCase(); if (!category) { print('Usage: list cat <category>', 'error'); return; } rows = rows.filter(row => String(row.category).toLowerCase() === category); label = `CATEGORY / ${category.toUpperCase()}`; } else if (['all', 'exp', 'inc', 'fuel'].includes(filter)) rows = rows.filter(row => filter === 'all' || row.type === filter); else { print('Error: list accepts all, exp, inc, fuel, or cat <category>.', 'error'); return; } rows.sort((a, b) => new Date(b.date) - new Date(a.date)); listedTransactions = rows; print(`TRANSACTIONS / ${label}\n${divider()}\n${transactionTable(rows, true)}\n\nUse edit <row> or delete <row>.`, 'muted'); }
function searchTransactions(text) { const query = text.toLowerCase(); const rows = transactions.filter(row => [row.category, row.description, walletName(row.walletCode)].join(' ').toLowerCase().includes(query)); listedTransactions = rows; print(`SEARCH / ${text}\n${divider()}\n${transactionTable(rows, true)}`, 'muted'); }

async function manageCategory(parts) { const action = (parts.shift() || 'list').toLowerCase(); if (action === 'list') { print(`CATEGORIES\n${divider()}\n${categories.map(item => `${pad(item.name, 24)} ${item.hidden ? 'HIDDEN' : 'ACTIVE'}`).join('\n') || 'No categories.'}`, 'muted'); return; } if (action === 'add') { const name = parts.join(' '); if (!name || categoryExists(name)) { print('Error: provide a new category name.', 'error'); return; } await add('categories', { name }); await changed('category'); print(`Category added: ${name}`, 'success'); return; } const target = categories.find(item => item.name.toLowerCase() === String(parts[0] || '').toLowerCase()); if (!target) { print('Error: category not found.', 'error'); return; } if (action === 'rename') { const name = parts.slice(1).join(' '); if (!name || categoryExists(name)) { print('Usage: category rename <old> <new unique name>', 'error'); return; } for (const row of transactions.filter(item => String(item.category).toLowerCase() === target.name.toLowerCase())) await update(storeFor[row.type], row.id, { category: name }); await update('categories', target.id, { name }); } else if (action === 'hide') await update('categories', target.id, { hidden: true }); else { print('Use: category [list|add|rename|hide]', 'error'); return; } await changed('category'); print('Category updated.', 'success'); }
function walletList() { const balances = calculateWalletBalances(); return activeWallets().map(wallet => { const info = getWalletBalanceInfo(wallet, balances); return `${pad(wallet.code.toUpperCase(), 4)} ${pad(wallet.name, 16)} Calculated: ${pad(money(info.calculated), 15)} Actual: ${pad(info.actual === null ? '-' : money(info.actual), 15)} ${info.status}`; }).join('\n') || 'No active wallets.'; }
function showWalletManager() { print(`WALLET MANAGER\n${divider()}\n${walletPosition()}\n\n1. View wallets\n2. Edit wallet balance\n3. Wallet audit\n4. Transfer\n5. Add wallet\n6. Rename wallet\n7. Hide wallet\n8. Restore wallet\n0. Back`, 'muted'); walletFlow = { kind: 'manager' }; input.placeholder = 'Choose 0-8'; }
async function applyReconciliation(wallet, actual) { const info = getWalletBalanceInfo(wallet); const difference = actual - info.calculated; const writes = [{ store: 'wallets', type: 'put', record: { ...wallet, actualBalance: actual } }], adjustment = { amount: Math.abs(difference), category: 'Balance Adjustment', walletCode: wallet.code, description: 'Manual Wallet Reconciliation', date: today(), reconciliation: true }, store = difference > 0 ? 'income' : 'expenses'; if (Math.abs(difference) >= 0.005) writes.push({ store, type: 'add', record: adjustment }); await batchWrite(writes); await changed('wallet-reconciliation'); await rememberUndo({ kind: 'reconciliation', walletId: wallet.id, previousActual: wallet.actualBalance, store, adjustmentId: adjustment.id }); print(`Wallet reconciled: ${wallet.name}\nActual: ${money(actual)}\nDifference applied: ${money(difference)}`, 'success'); showDashboard(); }
async function continueWalletFlow(raw) { const answer = raw.trim(); if (answer.toLowerCase() === 'cancel' || answer === '0') { walletFlow = null; input.placeholder = 'type help to see commands'; print('Wallet action cancelled.', 'warning'); return; } const flow = walletFlow; if (flow.kind === 'confirm-balance') { walletFlow = null; if (!['y', 'yes', '1'].includes(answer.toLowerCase())) return print('Balance was not changed.', 'warning'); return applyReconciliation(flow.wallet, flow.actual); } if (flow.kind === 'audit') { const wallet = flow.wallets[flow.index]; if (!Number.isFinite(Number(answer)) || Number(answer) < 0) return print('Enter a valid actual balance, or cancel.', 'error'); flow.entries.push({ wallet, actual: Number(answer) }); flow.index += 1; if (flow.index < flow.wallets.length) { const next = flow.wallets[flow.index]; print(`${next.name} calculated: ${money(getWalletBalanceInfo(next).calculated)}\nEnter actual balance:`, 'muted'); return; } walletFlow = { kind: 'confirm-audit', entries: flow.entries }; print(`AUDIT SUMMARY\n${divider()}\n${flow.entries.map(entry => `${entry.wallet.name}: ${money(entry.actual - getWalletBalanceInfo(entry.wallet).calculated)}`).join('\n')}\nApply all? [Y/n]`, 'warning'); return; } if (flow.kind === 'confirm-audit') { walletFlow = null; if (!['y', 'yes', '1'].includes(answer.toLowerCase())) return print('Audit was not applied.', 'warning'); for (const entry of flow.entries) await applyReconciliation(entry.wallet, entry.actual); return; } if (flow.kind === 'manager') { walletFlow = null; if (answer === '1') return manageWallet(['list']); if (answer === '2') return print('Use: wallet balance <code> <amount>', 'muted'); if (answer === '3') return manageWallet(['audit']); if (answer === '4') return print('Use: move <amount> <from> <to>', 'muted'); if (answer === '5') return print('Use: wallet add <code> <name>', 'muted'); if (answer === '6') return print('Use: wallet rename <code> <name>', 'muted'); if (answer === '7') return print('Use: wallet hide <code>', 'muted'); if (answer === '8') return print('Use: wallet restore <code>', 'muted'); return; } }
async function manageWallet(parts) { const action = (parts.shift() || 'list').toLowerCase(); if (action === 'list') return print(`WALLETS\n${divider()}\n${walletList()}`, 'muted'); if (action === 'balance') { const wallet = walletByCode(parts[0]), actual = Number(parts[1]); if (!wallet || !Number.isFinite(actual) || actual < 0) return print('Usage: wallet balance <code> <actual amount>', 'error'); const info = getWalletBalanceInfo(wallet); walletFlow = { kind: 'confirm-balance', wallet, actual }; return print(`${wallet.name}\nCalculated: ${money(info.calculated)}\nActual: ${money(actual)}\nDifference: ${money(actual - info.calculated)}\nApply reconciliation? [Y/n]`, 'warning'); } if (action === 'audit') { const active = activeWallets(); if (!active.length) return print('No active wallets.', 'warning'); walletFlow = { kind: 'audit', wallets: active, index: 0, entries: [] }; const first = active[0]; return print(`WALLET AUDIT\n${divider()}\n${first.name} calculated: ${money(getWalletBalanceInfo(first).calculated)}\nEnter actual balance:`, 'muted'); } if (action === 'add') { const [code, ...names] = parts, name = names.join(' '); if (!/^[a-z0-9]$/i.test(code || '') || !name || anyWalletByCode(code)) return print('Usage: wallet add <one-letter-code> <name>', 'error'); await add('wallets', { code: code.toLowerCase(), name, actualBalance: null, hidden: false }); await changed('wallet'); return print(`Wallet added: ${name}`, 'success'); } const target = anyWalletByCode(parts[0]); if (!target) return print('Error: wallet code not found.', 'error'); if (action === 'rename') { const name = parts.slice(1).join(' '); if (!name) return print('Usage: wallet rename <code> <new name>', 'error'); await update('wallets', target.id, { name }); } else if (action === 'hide') { if (activeWallets().length < 2) return print('Cannot hide the last active wallet.', 'error'); await update('wallets', target.id, { hidden: true }); } else if (action === 'restore') await update('wallets', target.id, { hidden: false }); else return print('Use: wallet [list|balance|audit|add|rename|hide|restore]', 'error'); await changed('wallet'); print('Wallet updated.', 'success'); }

function fuelStats() { const rows = [...transactions].filter(row => row.type === 'fuel').sort((a, b) => a.date.localeCompare(b.date)); if (!rows.length) { print('No fuel records yet.', 'muted'); return; } const fullRows = rows.filter(row => row.fillType === 'full'); const last = rows.at(-1), previousFull = fullRows.slice(0, -1).at(-1); const distance = previousFull && last.fillType === 'full' ? Number(last.odometer) - Number(previousFull.odometer) : null; const kmPerLiter = distance && last.liters ? distance / Number(last.liters) : null; const lPer100 = kmPerLiter ? 100 / kmPerLiter : null; print(`FUEL STATS\n${divider()}\nLast fill       : ${dateText(last.date)}\nCost            : ${money(last.amount)}\nLiters          : ${Number(last.liters || 0).toFixed(2)} L\nOdometer        : ${last.odometer} km\nFuel price      : ${money(last.fuelPrice || preferences.fuelPrice)} / L\n${distance !== null ? `Distance        : ${distance} km\nEfficiency      : ${kmPerLiter.toFixed(2)} km/L\nConsumption     : ${lPer100.toFixed(2)} L/100km\nCost per km     : ${money(last.amount / distance)} / km` : 'Fill the tank fully twice to calculate consumption.'}\n\nMonthly fuel    : ${money(periodTotals('month').fuel)}`, 'fuel'); }

function fuelReport(rows, label) { const spend = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0), liters = rows.reduce((sum, row) => sum + Number(row.liters || 0), 0), ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date)); let distance = 0, used = 0, cost = 0; for (let i = 1; i < ordered.length; i += 1) { const delta = Number(ordered[i].odometer) - Number(ordered[i - 1].odometer); if (delta > 0) { distance += delta; used += Number(ordered[i].liters || 0); cost += Number(ordered[i].amount || 0); } } return `${label}\nSpend: ${money(spend)} | Liters: ${liters.toFixed(2)} L | Fills: ${rows.length}\nAverage price: ${liters ? money(spend / liters) : '-'} / L\n${used ? `Estimated: ${(distance / used).toFixed(2)} km/L | ${(used / distance * 100).toFixed(2)} L/100km | ${money(cost / distance)} /km` : 'Performance: insufficient odometer intervals.'}`; }
function fuelPage() { const rows = transactions.filter(row => row.type === 'fuel').sort((a, b) => new Date(b.date) - new Date(a.date)); if (!rows.length) return print('FUEL CENTER\nNo fuel records yet.', 'muted'); const list = rows.map((row, i) => `${pad(i + 1, 3)} ${pad(row.date, 11)} ${pad(money(row.amount), 14)} ${pad(`${Number(row.liters || 0).toFixed(2)} L`, 10)} ${pad(`${row.odometer} km`, 12)} ${pad(String(row.fillType || '-').toUpperCase(), 8)} ${pad(walletName(row.walletCode), 12)} ${row.description || '-'}`).join('\n'); print(`FUEL CENTER\n${divider()}\n${fuelReport(rows.filter(row => inPeriod(row.date, 'today')), 'TODAY')}\n\n${fuelReport(rows.filter(row => inPeriod(row.date, 'week')), 'WEEK')}\n\n${fuelReport(rows, 'LIFETIME')}\n\nALL FUEL RECORDS\n${divider()}\n#   DATE        COST           LITERS     ODOMETER     TYPE     WALLET       NOTE\n${list}`, 'fuel'); }
function nextDueDate(date, repeat) { const result = new Date(`${date}T12:00:00`); if (repeat === 'weekly') result.setDate(result.getDate() + 7); else if (repeat === 'monthly') result.setMonth(result.getMonth() + 1); else if (repeat === 'yearly') result.setFullYear(result.getFullYear() + 1); return result.toISOString().slice(0, 10); }
function dueTable(rows) { return rows.length ? ['#   TITLE                    AMOUNT          DATE          STATUS', divider(), ...rows.map((due, index) => { const days = isoDays(due.dueDate), status = due.paid ? 'PAID' : days < 0 ? 'OVERDUE' : days === 0 ? 'TODAY' : `${days} days`; return `${pad(index + 1, 3)} ${pad(due.title, 24)} ${pad(due.amount ? money(due.amount) : '-', 15)} ${pad(due.dueDate, 13)} ${status}`; })].join('\n') : 'No dues found.'; }
function promptDue() { const fields = [['Title', 'Example: Internet'], ['Amount', 'Optional — Enter to skip'], ['Due date', 'YYYY-MM-DD'], ['Repeat', 'none, weekly, monthly, yearly'], ['Wallet code', `Optional — Enter = ${preferences.lastWallet.toUpperCase()}`], ['Note', 'Optional']]; const [label, hint] = fields[dueDraft.step]; print(`${label}: ${hint}`, 'muted'); input.placeholder = `${hint} · cancel stops`; }
async function startDue() { dueDraft = { step: 0, values: {} }; print('ADDING DUE\nType cancel to abandon.', 'warning'); promptDue(); }
async function continueDue(raw) { const answer = raw.trim(), draft = dueDraft; if (answer.toLowerCase() === 'cancel') { dueDraft = null; print('Due cancelled.', 'warning'); return; } const fields = ['title', 'amount', 'dueDate', 'repeat', 'walletCode', 'description']; let value = answer; if (draft.step === 1 && !value) value = 0; if (draft.step === 3 && !value) value = 'none'; if (draft.step === 4 && !value) value = preferences.lastWallet; if (draft.step === 0 && !value) { print('Error: title is required.', 'error'); promptDue(); return; } if (draft.step === 1 && value && !Number.isFinite(Number(value))) { print('Error: amount must be numeric.', 'error'); promptDue(); return; } if (draft.step === 2 && !/^\d{4}-\d{2}-\d{2}$/.test(value)) { print('Error: use YYYY-MM-DD.', 'error'); promptDue(); return; } if (draft.step === 3 && !['none', 'weekly', 'monthly', 'yearly'].includes(value.toLowerCase())) { print('Error: choose none, weekly, monthly, or yearly.', 'error'); promptDue(); return; } if (draft.step === 4 && !walletByCode(value)) { print('Error: wallet code not found.', 'error'); promptDue(); return; } draft.values[fields[draft.step]] = draft.step === 1 ? Number(value) : draft.step === 3 ? value.toLowerCase() : draft.step === 4 ? value.toLowerCase() : value; draft.step += 1; if (draft.step < fields.length) { promptDue(); return; } dueDraft = null; await add('dues', { ...draft.values, paid: false }); await changed('due'); print('Due added.', 'success'); showDashboard(); }
function promptDueEdit() { const fields = [['Title', dueEditDraft.values.title], ['Amount', dueEditDraft.values.amount || '-'], ['Due date', dueEditDraft.values.dueDate], ['Repeat', dueEditDraft.values.repeat], ['Wallet code', dueEditDraft.values.walletCode], ['Note', dueEditDraft.values.description || '-']]; const [label, value] = fields[dueEditDraft.step]; print(`${label} [${value}]:`, 'muted'); input.placeholder = `Enter keeps: ${value} · cancel stops`; }
async function continueDueEdit(raw) { const answer = raw.trim(); if (answer.toLowerCase() === 'cancel') { dueEditDraft = null; print('Due edit cancelled.', 'warning'); return; } const draft = dueEditDraft; const keys = ['title', 'amount', 'dueDate', 'repeat', 'walletCode', 'description']; const key = keys[draft.step]; if (answer) { if (key === 'amount' && !Number.isFinite(Number(answer))) { print('Error: amount must be numeric.', 'error'); promptDueEdit(); return; } if (key === 'dueDate' && !/^\d{4}-\d{2}-\d{2}$/.test(answer)) { print('Error: use YYYY-MM-DD.', 'error'); promptDueEdit(); return; } if (key === 'repeat' && !['none', 'weekly', 'monthly', 'yearly'].includes(answer.toLowerCase())) { print('Error: choose none, weekly, monthly, or yearly.', 'error'); promptDueEdit(); return; } if (key === 'walletCode' && !walletByCode(answer)) { print('Error: invalid wallet code.', 'error'); promptDueEdit(); return; } draft.values[key] = key === 'amount' ? Number(answer) : key === 'repeat' || key === 'walletCode' ? answer.toLowerCase() : key === 'description' && answer === '-' ? '' : answer; } draft.step += 1; if (draft.step < keys.length) { promptDueEdit(); return; } await update('dues', draft.record.id, draft.values); dueEditDraft = null; await changed('due-edit'); print('Due updated.', 'success'); showDashboard(); }
async function manageDue(parts) { const action = (parts.shift() || 'list').toLowerCase(); if (action === 'add') { await startDue(); return; } if (action === 'list') { const rows = [...dues].sort((a, b) => a.dueDate.localeCompare(b.dueDate)); print(`DUES\n${dueTable(rows)}`, 'muted'); return; } const index = Number(parts[0]) - 1; const rows = [...dues].sort((a, b) => a.dueDate.localeCompare(b.dueDate)); const due = rows[index]; if (!due) { print('Error: run due list first.', 'error'); return; } if (action === 'edit') { dueEditDraft = { record: due, values: { ...due }, step: 0 }; print(`EDITING DUE ${index + 1}`, 'warning'); promptDueEdit(); return; } if (action === 'done') { if (due.repeat && due.repeat !== 'none') await update('dues', due.id, { dueDate: nextDueDate(due.dueDate, due.repeat), paid: false }); else await update('dues', due.id, { paid: true, paidAt: new Date().toISOString() }); await changed('due-status'); if (due.amount > 0) await saveTransaction('exp', { amount: due.amount, category: due.title, walletCode: due.walletCode || preferences.lastWallet, description: `Due payment${due.description ? ` — ${due.description}` : ''}` }); print(`Due marked paid${due.amount ? ' and Expense created.' : '.'}`, 'success'); return; } if (action === 'snooze') { const days = Number(parts[1]); if (!Number.isInteger(days) || days < 1) { print('Usage: due snooze <row> <days>', 'error'); return; } const date = new Date(`${due.dueDate}T12:00:00`); date.setDate(date.getDate() + days); await update('dues', due.id, { dueDate: date.toISOString().slice(0, 10) }); } else if (action === 'delete') await softDelete('dues', due.id); else { print('Use: due [add|list|edit|done|snooze|delete]', 'error'); return; } await changed('due'); print('Due updated.', 'success'); }

async function manageFavorite(parts) { const action = (parts.shift() || 'list').toLowerCase(); if (action === 'list') { print(`FAVORITES\n${divider()}\n${favorites.map(item => `${pad(item.name, 18)} ${item.command}`).join('\n') || 'No favorites yet.'}`, 'muted'); return; } if (action === 'add') { const [name, ...command] = parts; if (!name || !command.length) { print('Usage: fav add <name> <command>', 'error'); return; } await add('favorites', { name: name.toLowerCase(), command: command.join(' ') }); await changed('favorite'); print(`Favorite saved: ${name}`, 'success'); return; } if (action === 'run') { const favorite = favorites.find(item => item.name === String(parts[0] || '').toLowerCase()); if (!favorite) { print('Error: favorite not found.', 'error'); return; } await execute(favorite.command, false); return; } if (action === 'delete') { const favorite = favorites.find(item => item.name === String(parts[0] || '').toLowerCase()); if (!favorite) { print('Error: favorite not found.', 'error'); return; } await softDelete('favorites', favorite.id); await changed('favorite'); print('Favorite removed.', 'success'); return; } print('Use: fav [list|add|run|delete]', 'error'); }

async function moveMoney(parts) { const amount = Number(parts[0]), from = walletByCode(parts[1]), to = walletByCode(parts[2]); if (!validAmount(amount) || !from || !to || from.code === to.code) { print('Usage: move <amount> <from wallet> <to wallet>', 'error'); return; } await add('expenses', { type: 'move', amount, category: 'Transfer', walletCode: from.code, description: `Transfer to ${to.name}`, date: today(), transfer: true }); await add('income', { type: 'move', amount, category: 'Transfer', walletCode: to.code, description: `Transfer from ${from.name}`, date: today(), transfer: true }); await changed('move'); print(`Moved ${money(amount)} from ${from.name} to ${to.name}.`, 'success'); showDashboard(); }
async function undo() { const item = undoStack.pop(); if (!item) return print('Nothing to undo in this session.', 'warning'); if (item.kind === 'add') await softDelete(item.store, item.record.id); else if (item.kind === 'restore') await update(item.store, item.id, { deleted: false }); else if (item.kind === 'update') await update(item.store, item.id, item.before); else if (item.kind === 'reconciliation') { if (item.adjustmentId) await softDelete(item.store, item.adjustmentId); await update('wallets', item.walletId, { actualBalance: item.previousActual }); } await changed('undo'); print('Last change undone.', 'success'); showDashboard(); }

function showSettings() { print(`SETTINGS\n${divider()}\nTheme                 : ${preferences.theme}\nSemantic colors       : ${preferences.semantic}\nIncome/expense color  : ${preferences.semantic === 'basic' ? 'on' : 'off'}\nHigh contrast         : ${preferences.highContrast ? 'on' : 'off'}\nEntry mode            : ${preferences.entryMode}\nFuel price            : ${money(preferences.fuelPrice)} / L\nLast wallet           : ${walletName(preferences.lastWallet)}\nDashboard             : Today ${preferences.dashboard.today ? 'on' : 'off'} | Week ${preferences.dashboard.week ? 'on' : 'off'} | Month ${preferences.dashboard.month ? 'on' : 'off'} | Due ${preferences.dashboard.due ? 'on' : 'off'}\nDue suggestion        : ${preferences.dueSuggestions ? 'on' : 'off'}\nGoogle Sheets         : automatic backup when configured\n\nUse:\ntheme green|orange\nsettings entry guided|quick\nsettings fuelprice <EGP>\nsettings semantic off|full\nsettings transactioncolors on|off\nsettings contrast on|off\nsettings dashboard <today|week|month|due> <on|off>\nsettings duesuggest on|off`, 'muted'); }
async function changeSettings(parts) { if (!parts.length) { showSettings(); return; } const [key, ...values] = parts, value = values[0]?.toLowerCase(); if (key === 'entry' && ['guided', 'quick'].includes(value)) preferences.entryMode = value; else if (key === 'fuelprice' && validAmount(value)) preferences.fuelPrice = Number(value); else if (key === 'semantic' && ['off', 'full'].includes(value)) preferences.semantic = value; else if (key === 'transactioncolors' && ['on', 'off'].includes(value)) preferences.semantic = value === 'on' ? 'basic' : 'off'; else if (key === 'contrast' && ['on', 'off'].includes(value)) preferences.highContrast = value === 'on'; else if (key === 'dashboard' && preferences.dashboard[values[0]] !== undefined && ['on', 'off'].includes(values[1])) preferences.dashboard[values[0]] = values[1] === 'on'; else if (key === 'duesuggest' && ['on', 'off'].includes(value)) preferences.dueSuggestions = value === 'on'; else { print('Error: invalid settings command. Type settings for help.', 'error'); return; } applyTheme(); await savePreferences(); print('Settings saved.', 'success'); }
async function setTheme(value) { if (!themes[value]) { print('Theme must be green or orange.', 'error'); return; } preferences.theme = value; applyTheme(); await savePreferences(); print(`Theme changed to ${value}.`, 'success'); }
async function downloadBackup() { const data = await exportData(); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `ahmed-finance-alpha-3-0-${today()}.json`; link.click(); URL.revokeObjectURL(url); print('Backup downloaded.', 'success'); }
function report() { const monthRows = transactions.filter(row => inPeriod(row.date, 'month') && row.type === 'exp'); const groups = Object.entries(monthRows.reduce((map, row) => ({ ...map, [row.category]: (map[row.category] || 0) + Number(row.amount) }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5); print(`MONTHLY REPORT\n${divider()}\nTop spending categories\n${groups.map(([name, amount]) => `${pad(name, 24)} ${money(amount)}`).join('\n') || 'No expenses this month.'}\n\nFuel total: ${money(periodTotals('month').fuel)}`, 'muted'); }

async function handleDueMatch(raw) { const answer = raw.trim().toLowerCase(); if (['y', 'yes', ''].includes(answer)) { const due = pendingDueMatch.due; if (due.repeat && due.repeat !== 'none') await update('dues', due.id, { dueDate: nextDueDate(due.dueDate, due.repeat), paid: false }); else await update('dues', due.id, { paid: true, paidAt: new Date().toISOString() }); await changed('due-match'); print(`Marked Due as paid: ${due.title}`, 'success'); } else print('Expense kept as a normal transaction; Due remains open.', 'muted'); pendingDueMatch = null; input.placeholder = 'type help to see commands'; }
async function cleanupAuditAdjustments() {
  const auditRecords = transactions.filter(row =>
    row.type === 'inc' &&
    row.reconciliation === true &&
    row.category === 'Balance Adjustment' &&
    row.description === 'Manual Wallet Reconciliation'
  );

  if (!auditRecords.length) {
    print('No Balance Adjustment income records found.', 'warning');
    return;
  }

  for (const record of auditRecords) {
    await softDelete('income', record.id);
  }

  listedTransactions = [];
  await changed('cleanup-audits');

  print(
    `CLEANUP COMPLETE\n${divider()}\nDeleted ${auditRecords.length} incorrect Balance Adjustment income records.\n\nReal income and transfers were not changed.`,
    'success'
  );

  showDashboard();
}

async function execute(raw, echo = true) {
  // Handle pending due confirmation first
  if (pendingDueMatch) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await handleDueMatch(raw);
    return;
  }

  // Handle transaction edit flow
  if (editDraft) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await continueEdit(raw);
    return;
  }

  // Handle transaction entry flow
  if (entryDraft) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await continueEntry(raw);
    return;
  }

  // Handle due entry flow
  if (dueDraft) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await continueDue(raw);
    return;
  }

  // Handle due edit flow
  if (dueEditDraft) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await continueDueEdit(raw);
    return;
  }

  // Handle wallet manager flow
  if (walletFlow) {
    if (echo) print(`ahmed@finance:~$ ${raw}`, 'command');
    await continueWalletFlow(raw);
    return;
  }

  const command = raw.trim();

  if (!command) return;

  if (echo) {
    print(`ahmed@finance:~$ ${command}`, 'command');
  }

  const [rawAction, ...parts] = command.split(/\s+/);

  const aliases = {
    expense: 'exp',
    income: 'inc',
    dashboard: 'dash',
    filter: 'filter',
    fav: 'favorite',
    categories: 'category',
    wallets: 'wallet'
  };

  const action =
    aliases[rawAction.toLowerCase()] ||
    rawAction.toLowerCase();

  // =========================
  // FUEL
  // =========================

  if (
    action === 'fuel' &&
    ['stats', 'page'].includes(String(parts[0] || '').toLowerCase())
  ) {
    fuelPage();
  }

  // =========================
  // TRANSACTIONS
  // =========================

  else if (['exp', 'inc', 'fuel'].includes(action)) {
    await startTransaction(action, parts);
  }

  // =========================
  // DASHBOARD
  // =========================

  else if (action === 'dash' || action === 'home') {
    showDashboard();
  }

  // =========================
  // LIST
  // =========================

  else if (action === 'list') {
    listTransactions(parts);
  }

  // =========================
  // FILTER
  // =========================

  else if (action === 'filter') {
    listTransactions(['cat', ...parts]);
  }

  // =========================
  // SEARCH
  // =========================

  else if (action === 'search') {
    searchTransactions(parts.join(' '));
  }

  // =========================
  // EDIT
  // =========================

  else if (action === 'edit') {
    const row = parts[0];

    if (!row) {
      print(
        'Usage: edit <row>\nExample: edit 1',
        'error'
      );
      return;
    }

    await startEdit(row);
  }

  // =========================
  // DELETE
  // =========================

  else if (action === 'delete') {
    const row = parts[0];

    if (!row) {
      print(
        'Usage: delete <row>\nExample: delete 1',
        'error'
      );
      return;
    }

    // Make sure row number is valid
    const rowNumber = Number(row);

    if (
      !Number.isInteger(rowNumber) ||
      rowNumber < 1
    ) {
      print(
        'Error: row number must be a positive integer.\nExample: delete 1',
        'error'
      );
      return;
    }

    // Make sure a list/search result exists
    if (!listedTransactions.length) {
      print(
        'Error: run list first, then use its row number.\nExample:\nlist inc\ndelete 1',
        'error'
      );
      return;
    }

    // Make sure requested row exists
    if (!listedTransactions[rowNumber - 1]) {
      print(
        `Error: row ${rowNumber} does not exist in the current list.`,
        'error'
      );
      return;
    }

    await deleteTransaction(rowNumber);
  }

  // =========================
  // CATEGORY
  // =========================

  else if (action === 'category') {
    await manageCategory(parts);
  }

  // =========================
  // WALLET
  // =========================

  else if (action === 'wallet') {
    await manageWallet(parts);
  }

  // =========================
  // DUE
  // =========================

  else if (action === 'due') {
    await manageDue(parts);
  }

  // =========================
  // FAVORITE
  // =========================

  else if (action === 'favorite') {
    await manageFavorite(parts);
  }

  // =========================
  // MOVE
  // =========================

  else if (action === 'move') {
    await moveMoney(parts);
  }

  // =========================
  // REPEAT
  // =========================

  else if (action === 'repeat') {
    const last = [...transactions]
      .sort(
        (a, b) =>
          new Date(b.createdAt) -
          new Date(a.createdAt)
      )[0];

    if (!last) {
      print(
        'No transaction to repeat.',
        'warning'
      );
    } else {
      await saveTransaction(last.type, {
        ...last,
        id: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        date: today()
      });
    }
  }

  // =========================
  // UNDO
  // =========================

  else if (action === 'undo') {
    await undo();
  }

  // =========================
  // SETTINGS
  // =========================

  else if (action === 'settings') {
    await changeSettings(parts);
  }

  // =========================
  // THEME
  // =========================

  else if (action === 'theme') {
    await setTheme(parts[0]);
  }

  // =========================
  // REPORT
  // =========================

  else if (action === 'report') {
    report();
  }

  // =========================
  // BACKUP
  // =========================

  else if (action === 'backup') {
    await downloadBackup();
  }

  // =========================
  // HELP
  // =========================

  else if (action === 'help') {
    showHelp();
  }

  // =========================
  // CLEAR
  // =========================

  else if (action === 'clear') {
    output.replaceChildren();

    // Clear current transaction list too
    listedTransactions = [];
  }

  // =========================
  // UNKNOWN COMMAND
  // =========================

  else {
    print(
      `Error: command not found: ${action}\nType help to see available commands.`,
      'error'
    );
  }

  scrollToLatest();
}

$('#commandForm').addEventListener('submit', async event => { event.preventDefault(); const value = input.value; input.value = ''; if (!cloudUnlocked && location.protocol !== 'file:') { await unlock(value); return; } if (value.trim()) { history.push(value); historyIndex = history.length; } try { await execute(value); } catch (error) { print(`Error: ${error.message || 'operation failed.'}`, 'error'); } input.focus(); scrollToLatest(); });
input.addEventListener('keydown', event => { if (event.key === 'ArrowUp' && history.length) { event.preventDefault(); historyIndex = Math.max(0, historyIndex - 1); input.value = history[historyIndex]; } if (event.key === 'ArrowDown' && history.length) { event.preventDefault(); historyIndex = Math.min(history.length, historyIndex + 1); input.value = historyIndex === history.length ? '' : history[historyIndex]; } });
document.addEventListener('click', event => { if (!event.target.closest('.terminal-output')) input.focus(); });
$('#commandForm').addEventListener('submit', async event => { const value = input.value.trim(); if (!walletFlow && value.toLowerCase() !== 'wallets') return; event.preventDefault(); event.stopImmediatePropagation(); input.value = ''; if (value.toLowerCase() === 'wallets') { showWalletManager(); input.focus(); return; } if (value) { history.push(value); historyIndex = history.length; } try { await continueWalletFlow(value); } catch (error) { print(`Error: ${error.message || 'operation failed.'}`, 'error'); } input.focus(); }, true);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
Promise.resolve().then(loadPreferences).then(seedCollections).then(loadData).then(async () => {
  if (location.protocol === 'file:') { $('#connectionStatus').textContent = 'LOCAL / READY'; showDashboard(); return; }
  if (cloudPin) await unlock(cloudPin); else showLock();
}).catch(() => print('Error: unable to open local database.', 'error'));
