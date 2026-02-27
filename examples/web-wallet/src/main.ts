import { Buffer } from 'buffer';
(globalThis as any).Buffer = Buffer;

import blsctWasmUrl from 'navio-blsct/wasm/blsct.wasm?url';
import blsctJsUrl from 'navio-blsct/wasm/blsct.js?url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WalletEntry {
  id: string;
  name: string;
  encrypted: boolean;
  createdAt: number;
}

interface SavedConfig {
  host: string;
  port: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDB_PREFIX = 'navio-wallet-';
const STORAGE_KEY = 'navio-web-wallet';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $('status');
const walletListEl = $('wallet-list');
const setupEl = $('setup');
const walletEl = $('wallet');
const logEl = $('log');

function setStatus(msg: string, type: '' | 'ok' | 'error' = '') {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent = `[${ts}] ${msg}\n` + logEl.textContent;
}

function show(...els: HTMLElement[]) { els.forEach((e) => e.classList.remove('hidden')); }
function hide(...els: HTMLElement[]) { els.forEach((e) => e.classList.add('hidden')); }

// ---------------------------------------------------------------------------
// Wallet registry (localStorage)
// ---------------------------------------------------------------------------

function loadRegistry(): { wallets: WalletEntry[]; electrum: SavedConfig } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { wallets: [], electrum: { host: 'testnet.nav.io', port: 50005 } };
}

function saveRegistry(reg: { wallets: WalletEntry[]; electrum: SavedConfig }) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(reg));
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'wallet';
}

function addWalletToRegistry(entry: WalletEntry) {
  const reg = loadRegistry();
  reg.wallets = reg.wallets.filter((w) => w.id !== entry.id);
  reg.wallets.push(entry);
  saveRegistry(reg);
}

function removeWalletFromRegistry(id: string) {
  const reg = loadRegistry();
  reg.wallets = reg.wallets.filter((w) => w.id !== id);
  saveRegistry(reg);
}

function saveElectrumConfig(cfg: SavedConfig) {
  const reg = loadRegistry();
  reg.electrum = cfg;
  saveRegistry(reg);
}

function deleteWalletIDB(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(IDB_PREFIX + id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// WASM bootstrap
// ---------------------------------------------------------------------------

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load script: ${url}`));
    document.head.appendChild(s);
  });
}

async function initBlsct() {
  await loadScript(blsctJsUrl);
  const wasmBinary = await fetch(blsctWasmUrl).then((r) => {
    if (!r.ok) throw new Error(`WASM fetch failed: ${r.status}`);
    return r.arrayBuffer();
  });
  const { loadBlsctModule } = await import('navio-blsct');
  await loadBlsctModule({ wasmBinary });
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let client: any = null;
let syncing = false;
let activeWalletId = '';
let mnemonicVisible = false;

// Tracks whether the setup form is in "connect to existing" mode
let connectMode: WalletEntry | null = null;

// ---------------------------------------------------------------------------
// Wallet list screen
// ---------------------------------------------------------------------------

function renderWalletList() {
  const reg = loadRegistry();
  const container = $('wallets-container');

  if (reg.wallets.length === 0) {
    container.innerHTML = '<div class="empty-state">No wallets yet</div>';
    return;
  }

  container.innerHTML = reg.wallets
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(
      (w) => `
      <div class="wallet-item" data-id="${w.id}">
        <div class="wallet-item-info">
          <div class="wallet-item-name">${esc(w.name)}</div>
          <div class="wallet-item-meta">
            Created ${new Date(w.createdAt).toLocaleDateString()}
            ${w.encrypted ? ' <span class="badge badge-encrypted">Encrypted</span>' : ''}
          </div>
        </div>
        <div class="wallet-item-actions">
          <button class="btn-open-wallet" data-id="${w.id}">Open</button>
          <button class="delete-link btn-del-wallet" data-id="${w.id}">Delete</button>
        </div>
      </div>`,
    )
    .join('');

  container.querySelectorAll('.btn-open-wallet').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConnectForm((btn as HTMLElement).dataset.id!);
    });
  });
  container.querySelectorAll('.wallet-item').forEach((el) => {
    el.addEventListener('click', () => showConnectForm((el as HTMLElement).dataset.id!));
  });
  container.querySelectorAll('.btn-del-wallet').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteWallet((btn as HTMLElement).dataset.id!);
    });
  });
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Setup form modes
// ---------------------------------------------------------------------------

function showCreateForm() {
  connectMode = null;
  const reg = loadRegistry();
  const nextNum = reg.wallets.length + 1;

  ($('setup-title') as HTMLElement).textContent = 'Create New Wallet';
  ($('wallet-name') as HTMLInputElement).value = `Wallet ${nextNum}`;
  ($('wallet-password') as HTMLInputElement).value = '';
  ($('mnemonic') as HTMLTextAreaElement).value = '';
  ($('restore-height') as HTMLInputElement).value = '0';
  ($('btn-create') as HTMLButtonElement).textContent = 'Create Wallet';

  show($('field-wallet-name'), $('field-password'), $('field-mnemonic'), $('field-restore-height'));
  hide($('field-unlock'));
  show($('btn-back'));

  const ec = reg.electrum;
  ($('electrum-host') as HTMLInputElement).value = ec.host;
  ($('electrum-port') as HTMLInputElement).value = String(ec.port);

  hide(walletListEl, walletEl);
  show(setupEl);
}

function showConnectForm(walletId: string) {
  const reg = loadRegistry();
  const entry = reg.wallets.find((w) => w.id === walletId);
  if (!entry) return;

  connectMode = entry;
  ($('setup-title') as HTMLElement).textContent = `Connect — ${entry.name}`;
  ($('btn-create') as HTMLButtonElement).textContent = 'Connect';
  ($('unlock-password') as HTMLInputElement).value = '';

  hide($('field-wallet-name'), $('field-password'), $('field-mnemonic'), $('field-restore-height'));
  if (entry.encrypted) {
    show($('field-unlock'));
  } else {
    hide($('field-unlock'));
  }
  show($('btn-back'));

  const ec = reg.electrum;
  ($('electrum-host') as HTMLInputElement).value = ec.host;
  ($('electrum-port') as HTMLInputElement).value = String(ec.port);

  hide(walletListEl, walletEl);
  show(setupEl);
}

function showWalletListScreen() {
  hide(setupEl, walletEl);
  renderWalletList();
  const reg = loadRegistry();
  if (reg.wallets.length > 0) {
    show(walletListEl);
    setStatus('Select a wallet or create a new one', 'ok');
  } else {
    showCreateForm();
    hide($('btn-back'));
    setStatus('Create your first wallet', 'ok');
  }
}

// ---------------------------------------------------------------------------
// Create / Connect
// ---------------------------------------------------------------------------

async function createOrConnect() {
  const host = ($('electrum-host') as HTMLInputElement).value || 'testnet.nav.io';
  const port = parseInt(($('electrum-port') as HTMLInputElement).value, 10) || 50005;
  saveElectrumConfig({ host, port });

  if (connectMode) {
    await connectToExisting(connectMode, host, port);
  } else {
    await createNewWallet(host, port);
  }
}

async function createNewWallet(host: string, port: number) {
  const name = ($('wallet-name') as HTMLInputElement).value.trim() || 'My Wallet';
  const password = ($('wallet-password') as HTMLInputElement).value;
  const mnemonic = ($('mnemonic') as HTMLTextAreaElement).value.trim();
  const restoreHeight = parseInt(($('restore-height') as HTMLInputElement).value, 10) || 0;

  let id = slugify(name);
  const reg = loadRegistry();
  if (reg.wallets.some((w) => w.id === id)) {
    id = id + '-' + Date.now().toString(36);
  }

  setStatus('Creating wallet...');

  const { NavioClient } = await import('navio-sdk');

  if (mnemonic) {
    try { await deleteWalletIDB(id); } catch { /* ok */ }
  }

  const config: any = {
    network: 'testnet',
    backend: 'electrum',
    electrum: { host, port, ssl: false },
    walletDbPath: id,
    databaseAdapter: 'indexeddb',
  };

  if (mnemonic) {
    config.restoreFromMnemonic = mnemonic;
    config.restoreFromHeight = restoreHeight;
  } else {
    config.createWalletIfNotExists = true;
  }

  client = new NavioClient(config);
  await client.initialize();

  const km = client.getKeyManager();
  const encrypted = !!password;

  if (password) {
    await km.setPassword(password);
    const walletDB = client.getWalletDB();
    const params = km.getEncryptionParams();
    if (params) {
      await walletDB.saveEncryptionMetadata(params.salt, params.verificationHash);
    }
  }

  activeWalletId = id;
  addWalletToRegistry({ id, name, encrypted, createdAt: Date.now() });

  showWalletView(name, encrypted);
  setStatus('Wallet created', 'ok');
}

async function connectToExisting(entry: WalletEntry, host: string, port: number) {
  setStatus('Connecting...');

  const { NavioClient } = await import('navio-sdk');

  const config: any = {
    network: 'testnet',
    backend: 'electrum',
    electrum: { host, port, ssl: false },
    walletDbPath: entry.id,
    databaseAdapter: 'indexeddb',
    createWalletIfNotExists: false,
  };

  client = new NavioClient(config);
  await client.initialize();

  const km = client.getKeyManager();

  if (entry.encrypted) {
    const password = ($('unlock-password') as HTMLInputElement).value;
    if (!password) {
      setStatus('Password required for encrypted wallet', 'error');
      return;
    }
    const ok = await km.unlock(password);
    if (!ok) {
      setStatus('Wrong password', 'error');
      return;
    }
  }

  activeWalletId = entry.id;
  showWalletView(entry.name, entry.encrypted);
  setStatus('Connected', 'ok');
}

// ---------------------------------------------------------------------------
// Wallet view
// ---------------------------------------------------------------------------

function showWalletView(name: string, encrypted: boolean) {
  const km = client.getKeyManager();

  ($('wallet-title') as HTMLElement).textContent = name;

  mnemonicVisible = false;
  $('wallet-mnemonic').textContent = '****';
  ($('btn-toggle-mnemonic') as HTMLButtonElement).textContent = 'Show';

  $('wallet-address').textContent = km.getSubAddressBech32m(
    { account: 0, address: 0 },
    'testnet',
  );

  if (encrypted) {
    $('wallet-encryption').textContent = km.isUnlocked() ? 'Encrypted (unlocked)' : 'Encrypted (locked)';
    show($('btn-lock'));
  } else {
    $('wallet-encryption').textContent = 'None';
    hide($('btn-lock'));
  }

  hide(walletListEl, setupEl);
  show(walletEl);
  updateInfo();
}

async function updateInfo() {
  if (!client) return;
  const bal = await client.getBalanceNav();
  $('wallet-balance').textContent = `${bal.toFixed(8)} NAV`;
  $('wallet-height').textContent = String(client.getLastSyncedHeight());

  const pending = await client.getPendingSpentNav();
  const pendingEl = $('wallet-pending');
  if (pending > 0) {
    pendingEl.textContent = `(${pending.toFixed(8)} NAV unconfirmed spend)`;
    pendingEl.style.display = '';
  } else {
    pendingEl.style.display = 'none';
  }
}

function toggleMnemonic() {
  if (!client) return;
  const km = client.getKeyManager();

  if (mnemonicVisible) {
    mnemonicVisible = false;
    $('wallet-mnemonic').textContent = '****';
    ($('btn-toggle-mnemonic') as HTMLButtonElement).textContent = 'Show';
    return;
  }

  if (km.isEncrypted() && !km.isUnlocked()) {
    const pw = prompt('Enter password to reveal mnemonic:');
    if (!pw) return;
    km.unlock(pw).then((ok: boolean) => {
      if (!ok) { alert('Wrong password'); return; }
      $('wallet-encryption').textContent = 'Encrypted (unlocked)';
      revealMnemonic(km);
    });
    return;
  }

  revealMnemonic(km);
}

function revealMnemonic(km: any) {
  try {
    $('wallet-mnemonic').textContent = km.getMnemonic();
    mnemonicVisible = true;
    ($('btn-toggle-mnemonic') as HTMLButtonElement).textContent = 'Hide';
  } catch {
    $('wallet-mnemonic').textContent = '(not available)';
  }
}

function lockWallet() {
  if (!client) return;
  const km = client.getKeyManager();
  if (km.isEncrypted()) {
    km.lock();
    $('wallet-encryption').textContent = 'Encrypted (locked)';
    mnemonicVisible = false;
    $('wallet-mnemonic').textContent = '****';
    ($('btn-toggle-mnemonic') as HTMLButtonElement).textContent = 'Show';
    log('Wallet locked');
  }
}

// ---------------------------------------------------------------------------
// UTXOs
// ---------------------------------------------------------------------------

async function refreshUtxos() {
  if (!client) return;
  const container = $('utxo-container');
  const showSpent = ($('utxo-show-spent') as HTMLInputElement).checked;

  try {
    const outputs = showSpent
      ? await client.getAllOutputs()
      : await client.getUnspentOutputs();

    if (outputs.length === 0) {
      container.innerHTML = '<div class="empty-state">No outputs found</div>';
      return;
    }

    outputs.sort((a: any, b: any) => b.blockHeight - a.blockHeight);

    const rows = outputs.map((o: any) => {
      const amountNav = (Number(o.amount) / 1e8).toFixed(8);
      const hash = o.outputHash.slice(0, 12) + '…';
      const txHash = o.txHash ? o.txHash.slice(0, 12) + '…' : '-';
      const memo = o.memo ? esc(o.memo) : '';
      const cls = o.isSpent ? ' class="utxo-spent"' : '';
      return `<tr${cls}>
        <td title="${esc(o.outputHash)}">${hash}</td>
        <td title="${esc(o.txHash || '')}">${txHash}</td>
        <td class="utxo-height">${o.blockHeight}</td>
        <td class="utxo-amount">${amountNav}</td>
        <td>${memo}</td>
        <td>${o.isSpent ? 'spent' : 'unspent'}</td>
      </tr>`;
    }).join('');

    const unspentCount = outputs.filter((o: any) => !o.isSpent).length;
    const spentCount = outputs.filter((o: any) => o.isSpent).length;

    container.innerHTML = `
      <table class="utxo-table">
        <thead><tr>
          <th>Output Hash</th>
          <th>Tx Hash</th>
          <th>Height</th>
          <th style="text-align:right">Amount</th>
          <th>Memo</th>
          <th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="utxo-count">${unspentCount} unspent${showSpent ? `, ${spentCount} spent` : ''} — ${outputs.length} total</div>`;
  } catch (e: any) {
    container.innerHTML = `<div class="empty-state" style="color:#fca5a5">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Transaction history
// ---------------------------------------------------------------------------

interface TxRecord {
  txHash: string;
  blockHeight: number;
  received: bigint;
  spent: bigint;
  memos: string[];
  outputCount: number;
  spentCount: number;
}

async function refreshHistory() {
  if (!client) return;
  const container = $('history-container');

  try {
    const outputs: any[] = await client.getAllOutputs();

    if (outputs.length === 0) {
      container.innerHTML = '<div class="empty-state">No transactions yet</div>';
      return;
    }

    const txMap = new Map<string, TxRecord>();

    const getOrCreate = (hash: string, height: number): TxRecord => {
      let rec = txMap.get(hash);
      if (!rec) {
        rec = { txHash: hash, blockHeight: height, received: 0n, spent: 0n, memos: [], outputCount: 0, spentCount: 0 };
        txMap.set(hash, rec);
      }
      return rec;
    };

    for (const o of outputs) {
      const amt = BigInt(o.amount);

      const recv = getOrCreate(o.txHash, o.blockHeight);
      recv.received += amt;
      recv.outputCount++;
      if (o.memo) recv.memos.push(o.memo);

      if (o.isSpent && o.spentTxHash) {
        const sent = getOrCreate(o.spentTxHash, o.spentBlockHeight);
        sent.spent += amt;
        sent.spentCount++;
      }
    }

    const txList = [...txMap.values()].sort((a, b) => b.blockHeight - a.blockHeight);

    const items = txList.map((tx) => {
      const net = tx.received - tx.spent;
      const hasRecv = tx.received > 0n;
      const hasSent = tx.spent > 0n;
      const isUnconfirmed = tx.blockHeight === 0;

      let type: 'recv' | 'sent' | 'self';
      let label: string;
      if (hasRecv && hasSent) {
        type = 'self';
        label = 'Self';
      } else if (hasSent) {
        type = 'sent';
        label = 'Sent';
      } else {
        type = 'recv';
        label = 'Received';
      }

      const sign = net > 0n ? '+' : net < 0n ? '' : '±';
      const amountClass = net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral';
      const navStr = (Number(net) / 1e8).toFixed(8);

      const memoHtml = tx.memos.length > 0
        ? `<div class="tx-memo">${tx.memos.map(m => esc(m)).join(', ')}</div>`
        : '';

      const heightLabel = isUnconfirmed ? 'Unconfirmed' : `Height ${tx.blockHeight}`;
      const unconfBadge = isUnconfirmed ? '<span class="tx-badge unconfirmed">Pending</span>' : '';

      return `<div class="tx-item${isUnconfirmed ? ' tx-unconfirmed' : ''}">
        <div class="tx-item-header">
          <span class="tx-hash" title="${esc(tx.txHash)}">${tx.txHash.slice(0, 16)}…</span>
          <span class="tx-amount ${amountClass}">${sign}${navStr} NAV</span>
        </div>
        <div class="tx-meta">
          <span class="tx-badge ${type}">${label}</span>
          ${unconfBadge}
          <span>${heightLabel}</span>
          ${tx.outputCount > 0 ? `<span>${tx.outputCount} output${tx.outputCount > 1 ? 's' : ''}</span>` : ''}
        </div>
        ${memoHtml}
      </div>`;
    }).join('');

    container.innerHTML = items + `<div class="utxo-count">${txList.length} transaction${txList.length > 1 ? 's' : ''}</div>`;
  } catch (e: any) {
    container.innerHTML = `<div class="empty-state" style="color:#fca5a5">${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function startSync() {
  if (!client || syncing) return;
  syncing = true;
  ($('btn-sync') as HTMLButtonElement).disabled = true;
  ($('btn-stop') as HTMLButtonElement).disabled = false;
  log('Sync started');

  try {
    await client.startBackgroundSync({
      pollInterval: 10_000,
      onProgress: (h: number, tip: number, blocks: number) => {
        if (blocks === 0) {
          log(`Up to date at height ${h}`);
        } else {
          const pct = tip > 0 ? ((h / tip) * 100).toFixed(1) : '0';
          log(`Syncing ${h}/${tip} (${pct}%) — ${blocks} blocks`);
        }
        $('wallet-height').textContent = String(h);
      },
      onBalanceChange: () => updateInfo(),
      onError: (e: Error) => log(`Error: ${e.message}`),
    });
    updateInfo();
  } catch (e: any) {
    log(`Sync error: ${e.message}`);
    console.error('Sync error:', e);
  }
}

async function stopSync() {
  if (!client || !syncing) return;
  await client.stopBackgroundSync();
  syncing = false;
  ($('btn-sync') as HTMLButtonElement).disabled = false;
  ($('btn-stop') as HTMLButtonElement).disabled = true;
  log('Sync stopped');
}

// ---------------------------------------------------------------------------
// Send Transaction
// ---------------------------------------------------------------------------

async function sendTransaction() {
  if (!client) return;

  const addressInput = $('send-address') as HTMLInputElement;
  const amountInput = $('send-amount') as HTMLInputElement;
  const memoInput = $('send-memo') as HTMLInputElement;
  const sendStatusEl = $('send-status');
  const sendBtn = $('btn-send') as HTMLButtonElement;

  const address = addressInput.value.trim();
  const amountNav = parseFloat(amountInput.value);
  const memo = memoInput.value.trim();

  if (!address) {
    sendStatusEl.textContent = 'Enter a destination address';
    sendStatusEl.className = 'send-status error';
    return;
  }
  if (isNaN(amountNav) || amountNav <= 0) {
    sendStatusEl.textContent = 'Enter a valid amount';
    sendStatusEl.className = 'send-status error';
    return;
  }

  const amountSat = BigInt(Math.round(amountNav * 1e8));

  const km = client.getKeyManager();
  if (km.isEncrypted() && !km.isUnlocked()) {
    const pw = prompt('Enter password to unlock wallet for sending:');
    if (!pw) return;
    const ok = await km.unlock(pw);
    if (!ok) {
      sendStatusEl.textContent = 'Wrong password';
      sendStatusEl.className = 'send-status error';
      return;
    }
  }

  sendBtn.disabled = true;
  sendStatusEl.textContent = 'Building transaction...';
  sendStatusEl.className = 'send-status';

  try {
    const result = await client.sendTransaction({
      address,
      amount: amountSat,
      memo: memo || undefined,
    });

    log(`Sent ${amountNav} NAV → ${address.slice(0, 20)}...`);
    log(`TxID: ${result.txId}`);
    log(`Fee: ${Number(result.fee) / 1e8} NAV  (${result.inputCount} in, ${result.outputCount} out)`);

    sendStatusEl.textContent = `Sent! TxID: ${result.txId.slice(0, 16)}...`;
    sendStatusEl.className = 'send-status ok';

    // Clear form
    addressInput.value = '';
    amountInput.value = '';
    memoInput.value = '';

    // Refresh balance
    await updateInfo();
  } catch (e: any) {
    console.error('Send failed:', e);
    log(`Send failed: ${e.message}`);
    sendStatusEl.textContent = e.message;
    sendStatusEl.className = 'send-status error';
  } finally {
    sendBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Disconnect / Delete
// ---------------------------------------------------------------------------

async function disconnectWallet() {
  if (syncing) await stopSync();
  if (client) {
    try { await client.disconnect(); } catch { /* ok */ }
    client = null;
  }
  activeWalletId = '';
  showWalletListScreen();
}

async function deleteWallet(id?: string) {
  const targetId = id || activeWalletId;
  if (!targetId) return;

  const reg = loadRegistry();
  const entry = reg.wallets.find((w) => w.id === targetId);
  const name = entry?.name || targetId;

  if (!confirm(`Delete "${name}"?\n\nThis will erase all local data for this wallet.\nMake sure you have your mnemonic backed up!`)) {
    return;
  }

  if (targetId === activeWalletId && client) {
    try { await client.disconnect(); } catch { /* ok */ }
    client = null;
    activeWalletId = '';
  }

  await deleteWalletIDB(targetId);
  removeWalletFromRegistry(targetId);
  showWalletListScreen();
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

$('btn-new-wallet').addEventListener('click', showCreateForm);
$('btn-create').addEventListener('click', async () => {
  try {
    ($('btn-create') as HTMLButtonElement).disabled = true;
    await createOrConnect();
  } catch (e: any) {
    console.error(e);
    setStatus(`Error: ${e.message}`, 'error');
  } finally {
    ($('btn-create') as HTMLButtonElement).disabled = false;
  }
});
$('btn-back').addEventListener('click', showWalletListScreen);
$('btn-sync').addEventListener('click', startSync);
$('btn-stop').addEventListener('click', stopSync);
$('btn-lock').addEventListener('click', lockWallet);
$('btn-toggle-mnemonic').addEventListener('click', toggleMnemonic);
$('btn-disconnect').addEventListener('click', disconnectWallet);
$('btn-delete').addEventListener('click', () => deleteWallet());
$('btn-send').addEventListener('click', sendTransaction);
$('btn-refresh-utxos').addEventListener('click', refreshUtxos);
$('utxo-show-spent').addEventListener('change', refreshUtxos);
$('btn-refresh-history').addEventListener('click', refreshHistory);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  try {
    setStatus('Loading WASM...');
    await initBlsct();
    showWalletListScreen();
  } catch (e: any) {
    console.error(e);
    setStatus(`Failed to load SDK: ${e.message}`, 'error');
  }
})();
