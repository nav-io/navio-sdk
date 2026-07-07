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
  ssl: boolean;
}

type AssetKind = 'nav' | 'token' | 'nft';

interface AssetDescriptor {
  tokenId: string | null;
  kind: AssetKind;
  label: string;
  shortLabel: string;
  collectionTokenId: string | null;
  nftId: bigint | null;
}

interface AssetBalanceSummary extends AssetDescriptor {
  balance: bigint;
  outputCount: number;
}

type CollectionKind = Exclude<AssetKind, 'nav'>;
type CreateMintAction = 'create-token' | 'create-nft' | 'mint-token' | 'mint-nft';

interface KnownCollection {
  tokenId: string;
  kind: CollectionKind;
  label: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDB_PREFIX = 'navio-wallet-';
const STORAGE_KEY = 'navio-web-wallet';
const TOKEN_ID_HEX_LENGTH = 80;
const TOKEN_ID_SUBID_HEX_LENGTH = 16;
const TOKEN_ID_NO_SUBID_HEX = 'f'.repeat(TOKEN_ID_SUBID_HEX_LENGTH);
const NAV_ASSET_KEY = '__nav__';
const MAX_UINT64 = (1n << 64n) - 1n;

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

function assetKey(tokenId: string | null): string {
  return tokenId ?? NAV_ASSET_KEY;
}

function parseLittleEndianUint64Hex(hex: string): bigint {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.reduceRight((acc, byte) => (acc << 8n) + BigInt(byte), 0n);
}

function encodeUint64LEHex(value: bigint): string {
  if (value < 0n || value > MAX_UINT64) {
    throw new Error(`NFT id must be between 0 and ${MAX_UINT64.toString()}`);
  }

  let remaining = value;
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += Number(remaining & 0xffn).toString(16).padStart(2, '0');
    remaining >>= 8n;
  }
  return hex;
}

function normalizeTokenIdHex(tokenId: string): string {
  const normalized = tokenId.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) {
    throw new Error('Token ID must be hexadecimal');
  }
  if (normalized.length === 64) {
    return normalized + TOKEN_ID_NO_SUBID_HEX;
  }
  if (normalized.length !== TOKEN_ID_HEX_LENGTH) {
    throw new Error(`Token ID must be ${64} or ${TOKEN_ID_HEX_LENGTH} hex characters`);
  }
  return normalized;
}

function composeNftTokenId(collectionTokenId: string, nftId: bigint): string {
  const normalized = normalizeTokenIdHex(collectionTokenId);
  return normalized.slice(0, TOKEN_ID_HEX_LENGTH - TOKEN_ID_SUBID_HEX_LENGTH) + encodeUint64LEHex(nftId);
}

function describeAsset(tokenId: string | null): AssetDescriptor {
  if (!tokenId) {
    return {
      tokenId: null,
      kind: 'nav',
      label: 'NAV',
      shortLabel: 'NAV',
      collectionTokenId: null,
      nftId: null,
    };
  }

  let normalized: string;
  try {
    normalized = normalizeTokenIdHex(tokenId);
  } catch {
    return {
      tokenId,
      kind: 'token',
      label: `Invalid token ${tokenId.slice(0, 16)}…`,
      shortLabel: 'Invalid token',
      collectionTokenId: null,
      nftId: null,
    };
  }

  const subidHex = normalized.slice(TOKEN_ID_HEX_LENGTH - TOKEN_ID_SUBID_HEX_LENGTH);
  if (subidHex === TOKEN_ID_NO_SUBID_HEX) {
    return {
      tokenId: normalized,
      kind: 'token',
      label: `Token ${normalized.slice(0, 16)}…`,
      shortLabel: `Token ${normalized.slice(0, 8)}…`,
      collectionTokenId: normalized,
      nftId: null,
    };
  }

  const nftId = parseLittleEndianUint64Hex(subidHex);
  return {
    tokenId: normalized,
    kind: 'nft',
    label: `NFT #${nftId.toString()}`,
    shortLabel: `NFT #${nftId.toString()}`,
    collectionTokenId: normalized.slice(0, TOKEN_ID_HEX_LENGTH - TOKEN_ID_SUBID_HEX_LENGTH) + TOKEN_ID_NO_SUBID_HEX,
    nftId,
  };
}

function formatNavAmount(amount: bigint): string {
  return `${(Number(amount) / 1e8).toFixed(8)} NAV`;
}

function formatAssetAmount(amount: bigint, tokenId: string | null): string {
  const asset = describeAsset(tokenId);
  if (asset.kind === 'nav') {
    return formatNavAmount(amount);
  }
  if (asset.kind === 'nft') {
    return `${amount.toString()} NFT`;
  }
  return `${amount.toString()} units`;
}

function formatSignedAssetAmount(amount: bigint, tokenId: string | null): string {
  const sign = amount > 0n ? '+' : amount < 0n ? '-' : '±';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${formatAssetAmount(absolute, tokenId)}`;
}

function normalizeCollectionTokenId(tokenId: string): string {
  const normalized = normalizeTokenIdHex(tokenId);
  const asset = describeAsset(normalized);
  return asset.collectionTokenId ?? normalized;
}

function parseMetadataJson(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Metadata must be valid JSON');
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Metadata must be a JSON object');
  }

  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, value]) => {
      if (value === null || typeof value === 'object') {
        throw new Error(`Metadata value for "${key}" must be a string, number, or boolean`);
      }
      return [key, String(value)];
    }),
  );
}

function parsePositiveIntegerInput(raw: string, fieldName: string): bigint {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  const value = BigInt(trimmed);
  if (value <= 0n) {
    throw new Error(`${fieldName} must be greater than zero`);
  }
  return value;
}

function parseNonNegativeIntegerInput(raw: string, fieldName: string): bigint {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }

  return BigInt(trimmed);
}

function clearSelectedUtxoSelection() {
  selectedUtxoHashes.clear();
  document.querySelectorAll<HTMLInputElement>('.utxo-select-cb').forEach((cb) => { cb.checked = false; });
  updateSelectionUI();
}

// ---------------------------------------------------------------------------
// Wallet registry (localStorage)
// ---------------------------------------------------------------------------

function loadRegistry(): { wallets: WalletEntry[]; electrum: SavedConfig } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { wallets: [], electrum: { host: 'testnet.nav.io', port: 50005, ssl: window.location.protocol === 'https:' } };
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

// Selected UTXOs for manual input selection (outputHash strings)
let selectedUtxoHashes: Set<string> = new Set();
let knownCollections: Map<string, KnownCollection> = new Map();

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
  ($('electrum-ssl') as HTMLInputElement).checked = ec.ssl ?? (window.location.protocol === 'https:');

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
  ($('electrum-ssl') as HTMLInputElement).checked = ec.ssl ?? (window.location.protocol === 'https:');

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
  const ssl = ($('electrum-ssl') as HTMLInputElement).checked;
  saveElectrumConfig({ host, port, ssl });

  if (connectMode) {
    await connectToExisting(connectMode, host, port, ssl);
  } else {
    await createNewWallet(host, port, ssl);
  }
}

async function createNewWallet(host: string, port: number, ssl: boolean) {
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
    electrum: { host, port, ssl },
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

async function connectToExisting(entry: WalletEntry, host: string, port: number, ssl: boolean) {
  setStatus('Connecting...');

  const { NavioClient } = await import('navio-sdk');

  const config: any = {
    network: 'testnet',
    backend: 'electrum',
    electrum: { host, port, ssl },
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
  knownCollections.clear();

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

  ($('send-asset-kind') as HTMLSelectElement).value = 'nav';
  ($('send-token-id') as HTMLInputElement).value = '';
  ($('send-nft-id') as HTMLInputElement).value = '';
  ($('send-address') as HTMLInputElement).value = '';
  ($('send-amount') as HTMLInputElement).value = '';
  ($('send-memo') as HTMLInputElement).value = '';
  clearSelectedUtxoSelection();
  updateSendAssetFields();
  resetCreateMintForm();

  hide(walletListEl, setupEl);
  show(walletEl);
  updateInfo();
}

async function updateInfo() {
  if (!client) return;
  const bal = await client.getBalance();
  $('wallet-balance').textContent = formatNavAmount(BigInt(bal));
  $('wallet-height').textContent = String(client.getLastSyncedHeight());

  const pending = await client.getPendingSpentNav();
  const pendingEl = $('wallet-pending');
  if (pending > 0) {
    pendingEl.textContent = `(${pending.toFixed(8)} NAV unconfirmed spend)`;
    pendingEl.style.display = '';
  } else {
    pendingEl.style.display = 'none';
  }

  await refreshAssets();
}

function updateSendAssetFields() {
  const assetKind = ($('send-asset-kind') as HTMLSelectElement).value as AssetKind;
  const tokenField = $('send-token-field');
  const nftIdField = $('send-nft-id-field');
  const amountField = $('send-amount-field');
  const amountLabel = $('send-amount-label');
  const tokenLabel = document.querySelector('label[for="send-token-id"]') as HTMLLabelElement;
  const amountInput = $('send-amount') as HTMLInputElement;
  const tokenInput = $('send-token-id') as HTMLInputElement;
  const tokenHelp = $('send-token-help');

  if (assetKind === 'nav') {
    hide(tokenField);
    hide(nftIdField);
    show(amountField);
    amountLabel.textContent = 'Amount (NAV)';
    amountInput.step = '0.00000001';
    amountInput.min = '0';
    amountInput.placeholder = '0.00000000';
    tokenInput.placeholder = 'token id';
    tokenHelp.textContent = 'Choose an owned token/NFT or paste a token id.';
    return;
  }

  show(tokenField);

  if (assetKind === 'token') {
    hide(nftIdField);
    show(amountField);
    tokenLabel.textContent = 'Token ID';
    tokenInput.placeholder = '64 or 80 hex token id';
    amountLabel.textContent = 'Amount (raw token units)';
    amountInput.step = '1';
    amountInput.min = '1';
    amountInput.placeholder = '1';
    tokenHelp.textContent = 'Token amounts use raw on-chain integer units.';
    return;
  }

  show(nftIdField);
  hide(amountField);
  tokenLabel.textContent = 'Collection Token ID';
  tokenInput.placeholder = '64 or 80 hex collection token id';
  tokenHelp.textContent = 'Enter a collection token id and the NFT id to transfer. NFT transfers always send exactly 1 item.';
}

function populateTokenIdSuggestions(assets: AssetBalanceSummary[]) {
  const datalist = $('send-token-id-list');
  datalist.innerHTML = assets
    .map((asset) => `<option value="${esc(asset.tokenId!)}">${esc(asset.label)}</option>`)
    .join('');
}

function syncNftFieldsFromTokenInput() {
  const assetKind = ($('send-asset-kind') as HTMLSelectElement).value as AssetKind;
  if (assetKind !== 'nft') return;

  const tokenInput = $('send-token-id') as HTMLInputElement;
  const nftIdInput = $('send-nft-id') as HTMLInputElement;
  const raw = tokenInput.value.trim();

  if (raw.length !== TOKEN_ID_HEX_LENGTH) {
    return;
  }

  try {
    const asset = describeAsset(raw);
    if (asset.kind === 'nft' && asset.collectionTokenId && asset.nftId !== null) {
      tokenInput.value = asset.collectionTokenId;
      nftIdInput.value = asset.nftId.toString();
    }
  } catch {
    // Ignore invalid partial input while typing
  }
}

function useAssetForSend(tokenId: string, kind: AssetKind) {
  const asset = describeAsset(tokenId);
  ($('send-asset-kind') as HTMLSelectElement).value = kind;
  ($('send-token-id') as HTMLInputElement).value = kind === 'nft'
    ? (asset.collectionTokenId ?? tokenId)
    : tokenId;
  ($('send-nft-id') as HTMLInputElement).value = kind === 'nft' && asset.nftId !== null
    ? asset.nftId.toString()
    : '';
  if (kind === 'nft') {
    ($('send-amount') as HTMLInputElement).value = '';
  }
  clearSelectedUtxoSelection();
  updateSendAssetFields();
}

function rememberCollection(tokenId: string, kind: CollectionKind, label?: string) {
  try {
    const normalized = normalizeCollectionTokenId(tokenId);
    knownCollections.set(normalized, {
      tokenId: normalized,
      kind,
      label: label ?? `${kind === 'token' ? 'Token' : 'NFT'} Collection ${normalized.slice(0, 8)}…`,
    });
  } catch {
    // Ignore malformed collection ids from manual input.
  }
}

function populateCollectionSuggestions(assets: AssetBalanceSummary[]) {
  const datalist = $('create-mint-collection-id-list');
  const collections = new Map<string, KnownCollection>(knownCollections);

  for (const asset of assets) {
    if (!asset.collectionTokenId) {
      continue;
    }

    const kind: CollectionKind = asset.kind === 'nft' ? 'nft' : 'token';
    collections.set(asset.collectionTokenId, {
      tokenId: asset.collectionTokenId,
      kind,
      label: `${kind === 'token' ? 'Token' : 'NFT'} Collection ${asset.collectionTokenId.slice(0, 8)}…`,
    });
  }

  datalist.innerHTML = [...collections.values()]
    .sort((a, b) => a.tokenId.localeCompare(b.tokenId))
    .map((collection) => `<option value="${esc(collection.tokenId)}">${esc(collection.label)}</option>`)
    .join('');
}

function useCollectionForMint(tokenId: string, kind: CollectionKind) {
  const normalized = normalizeCollectionTokenId(tokenId);
  rememberCollection(normalized, kind);
  ($('create-mint-action') as HTMLSelectElement).value = kind === 'token' ? 'mint-token' : 'mint-nft';
  ($('create-mint-collection-id') as HTMLInputElement).value = normalized;
  if (kind === 'token') {
    ($('create-mint-nft-id') as HTMLInputElement).value = '';
  }
  updateCreateMintFields();
}

function updateCreateMintFields() {
  const action = ($('create-mint-action') as HTMLSelectElement).value as CreateMintAction;
  const collectionField = $('create-mint-collection-field');
  const destinationField = $('create-mint-destination-field');
  const totalSupplyField = $('create-mint-total-supply-field');
  const amountField = $('create-mint-amount-field');
  const nftIdField = $('create-mint-nft-id-field');
  const metadataField = $('create-mint-metadata-field');
  const collectionLabel = $('create-mint-collection-label');
  const collectionHelp = $('create-mint-collection-help');
  const metadataLabel = $('create-mint-metadata-label');
  const metadataHelp = $('create-mint-metadata-help');
  const totalSupplyLabel = $('create-mint-total-supply-label');
  const totalSupplyHelp = $('create-mint-total-supply-help');
  const totalSupplyInput = $('create-mint-total-supply') as HTMLInputElement;
  const metadataInput = $('create-mint-metadata') as HTMLTextAreaElement;
  const actionButton = $('btn-create-mint') as HTMLButtonElement;

  hide(collectionField, destinationField, totalSupplyField, amountField, nftIdField, metadataField);

  if (action === 'create-token') {
    show(totalSupplyField, metadataField);
    totalSupplyLabel.textContent = 'Total Supply';
    totalSupplyHelp.textContent = 'Maximum fungible supply recorded in the collection predicate.';
    totalSupplyInput.min = '1';
    totalSupplyInput.placeholder = '1000000';
    metadataLabel.textContent = 'Collection Metadata (JSON object)';
    metadataHelp.textContent = 'Metadata values are stored on-chain as strings.';
    metadataInput.placeholder = '{"name":"Token Collection","symbol":"TOK"}';
    actionButton.textContent = 'Create Token Collection';
    return;
  }

  if (action === 'create-nft') {
    show(totalSupplyField, metadataField);
    totalSupplyLabel.textContent = 'Max Supply (optional)';
    totalSupplyHelp.textContent = 'Optional NFT collection cap. Leave empty to store 0.';
    totalSupplyInput.min = '0';
    totalSupplyInput.placeholder = '0';
    metadataLabel.textContent = 'Collection Metadata (JSON object)';
    metadataHelp.textContent = 'Metadata values are stored on-chain as strings.';
    metadataInput.placeholder = '{"collection":"Artifacts","creator":"navio"}';
    actionButton.textContent = 'Create NFT Collection';
    return;
  }

  show(collectionField, destinationField);
  collectionLabel.textContent = 'Collection Token ID';
  collectionHelp.textContent = 'Choose a known collection id or paste one manually.';

  if (action === 'mint-token') {
    show(amountField);
    actionButton.textContent = 'Mint Tokens';
    return;
  }

  show(nftIdField, metadataField);
  metadataLabel.textContent = 'NFT Metadata (JSON object)';
  metadataHelp.textContent = 'Optional metadata describing the newly minted NFT.';
  metadataInput.placeholder = '{"name":"Artifact","rarity":"legendary"}';
  actionButton.textContent = 'Mint NFT';
}

function resetCreateMintForm() {
  ($('create-mint-action') as HTMLSelectElement).value = 'create-token';
  ($('create-mint-collection-id') as HTMLInputElement).value = '';
  ($('create-mint-address') as HTMLInputElement).value = '';
  ($('create-mint-total-supply') as HTMLInputElement).value = '';
  ($('create-mint-amount') as HTMLInputElement).value = '';
  ($('create-mint-nft-id') as HTMLInputElement).value = '';
  ($('create-mint-metadata') as HTMLTextAreaElement).value = '';
  ($('create-mint-status') as HTMLElement).textContent = '';
  ($('create-mint-status') as HTMLElement).className = 'send-status';
  updateCreateMintFields();
}

async function refreshAssets() {
  if (!client) return;
  const container = $('assets-container');

  try {
    const assets: AssetBalanceSummary[] = await client.getAssetBalances();
    populateTokenIdSuggestions(assets);
    populateCollectionSuggestions(assets);

    if (assets.length === 0) {
      container.innerHTML = '<div class="empty-state">No token or NFT balances yet</div>';
      return;
    }

    container.innerHTML = assets.map((asset) => `
      <div class="asset-item">
        <div class="asset-item-header">
          <div class="asset-title">
            <span class="asset-kind ${asset.kind}">${asset.kind}</span>
            <span class="asset-name">${esc(asset.label)}</span>
          </div>
          <div class="asset-balance">${esc(formatAssetAmount(BigInt(asset.balance), asset.tokenId))}</div>
        </div>
        <div class="asset-meta">
          <span>${asset.outputCount} output${asset.outputCount === 1 ? '' : 's'}</span>
          <span class="asset-token-id">${esc(asset.tokenId!)}</span>
        </div>
        <div class="asset-action">
          <button class="secondary btn-use-asset" data-kind="${asset.kind}" data-token-id="${esc(asset.tokenId!)}">Use In Send</button>
          ${asset.collectionTokenId
            ? `<button class="secondary btn-use-collection" data-kind="${asset.kind}" data-collection-token-id="${esc(asset.collectionTokenId)}">Use Collection</button>`
            : ''}
        </div>
      </div>
    `).join('');

    container.querySelectorAll<HTMLButtonElement>('.btn-use-asset').forEach((btn) => {
      btn.addEventListener('click', () => {
        useAssetForSend(btn.dataset.tokenId!, btn.dataset.kind as AssetKind);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.btn-use-collection').forEach((btn) => {
      btn.addEventListener('click', () => {
        useCollectionForMint(
          btn.dataset.collectionTokenId!,
          (btn.dataset.kind === 'nft' ? 'nft' : 'token') as CollectionKind,
        );
      });
    });
  } catch (e: any) {
    container.innerHTML = `<div class="empty-state" style="color:#fca5a5">${esc(e.message)}</div>`;
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

function updateSelectionUI() {
  const clearBtn = $('btn-clear-utxo-selection');
  if (selectedUtxoHashes.size > 0) {
    clearBtn.style.display = '';
    clearBtn.textContent = `Clear selection (${selectedUtxoHashes.size} UTXO${selectedUtxoHashes.size === 1 ? '' : 's'})`;
  } else {
    clearBtn.style.display = 'none';
  }
}

async function refreshUtxos() {
  if (!client) return;
  const container = $('utxo-container');
  const showSpent = ($('utxo-show-spent') as HTMLInputElement).checked;

  try {
    const allOutputs = await client.getAllOutputs();
    const outputs = showSpent
      ? allOutputs
      : allOutputs.filter((o: any) => !o.isSpent);

    if (outputs.length === 0) {
      container.innerHTML = '<div class="empty-state">No outputs found</div>';
      return;
    }

    outputs.sort((a: any, b: any) => b.blockHeight - a.blockHeight);

    const rows = outputs.map((o: any) => {
      const amountText = formatAssetAmount(BigInt(o.amount), o.tokenId ?? null);
      const hash = o.outputHash.slice(0, 12) + '…';
      const txHash = o.txHash ? o.txHash.slice(0, 12) + '…' : '-';
      const memo = o.memo ? esc(o.memo) : '';
      const cls = o.isSpent ? ' class="utxo-spent"' : '';
      const isConfirmed = o.blockHeight > 0;
      const asset = describeAsset(o.tokenId ?? null);
      const canSelect = !o.isSpent && isConfirmed;
      const checked = selectedUtxoHashes.has(o.outputHash) ? ' checked' : '';
      const checkbox = canSelect
        ? `<input type="checkbox" class="utxo-select-cb" data-hash="${esc(o.outputHash)}"${checked} />`
        : (o.isSpent ? '' : '<span title="Unconfirmed — cannot select">⏳</span>');
      return `<tr${cls}>
        <td style="text-align:center">${checkbox}</td>
        <td title="${esc(o.outputHash)}">${hash}</td>
        <td title="${esc(o.txHash || '')}">${txHash}</td>
        <td class="utxo-asset" title="${esc(o.tokenId || 'NAV')}">${esc(asset.shortLabel)}</td>
        <td class="utxo-height">${o.blockHeight}</td>
        <td class="utxo-amount">${esc(amountText)}</td>
        <td>${memo}</td>
        <td>${o.isSpent ? 'spent' : (isConfirmed ? 'unspent' : 'pending')}</td>
      </tr>`;
    }).join('');

    const unspentCount = outputs.filter((o: any) => !o.isSpent).length;
    const spentCount = outputs.filter((o: any) => o.isSpent).length;

    container.innerHTML = `
      <table class="utxo-table">
        <thead><tr>
          <th style="width:2rem"></th>
          <th>Output Hash</th>
          <th>Tx Hash</th>
          <th>Asset</th>
          <th>Height</th>
          <th style="text-align:right">Amount</th>
          <th>Memo</th>
          <th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="utxo-count">${unspentCount} unspent${showSpent ? `, ${spentCount} spent` : ''} — ${outputs.length} total</div>`;

    // Wire up checkbox events
    container.querySelectorAll<HTMLInputElement>('.utxo-select-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const hash = cb.dataset.hash!;
        if (cb.checked) {
          selectedUtxoHashes.add(hash);
        } else {
          selectedUtxoHashes.delete(hash);
        }
        updateSelectionUI();
      });
    });

    updateSelectionUI();
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
  assetDeltas: Map<string, { tokenId: string | null; amount: bigint; shortLabel: string }>;
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
        rec = {
          txHash: hash,
          blockHeight: height ?? 0,
          received: 0n,
          spent: 0n,
          memos: [],
          outputCount: 0,
          spentCount: 0,
          assetDeltas: new Map(),
        };
        txMap.set(hash, rec);
      }
      return rec;
    };

    for (const o of outputs) {
      const amt = BigInt(o.amount);
      const tokenId = o.tokenId ?? null;
      const asset = describeAsset(tokenId);
      const assetId = assetKey(tokenId);

      const recv = getOrCreate(o.txHash, o.blockHeight);
      recv.received += amt;
      recv.outputCount++;
      if (o.memo) recv.memos.push(o.memo);
      const recvAsset = recv.assetDeltas.get(assetId) ?? {
        tokenId,
        amount: 0n,
        shortLabel: asset.shortLabel,
      };
      recvAsset.amount += amt;
      recv.assetDeltas.set(assetId, recvAsset);

      if (o.isSpent && o.spentTxHash) {
        const sent = getOrCreate(o.spentTxHash, o.spentBlockHeight ?? 0);
        sent.spent += amt;
        sent.spentCount++;
        const sentAsset = sent.assetDeltas.get(assetId) ?? {
          tokenId,
          amount: 0n,
          shortLabel: asset.shortLabel,
        };
        sentAsset.amount -= amt;
        sent.assetDeltas.set(assetId, sentAsset);
      }
    }

    const txList = [...txMap.values()].sort((a, b) => b.blockHeight - a.blockHeight);

    const items = txList.map((tx) => {
      const assetEntries = [...tx.assetDeltas.values()].filter((asset) => asset.amount !== 0n);
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

      const amountClass = assetEntries.length === 1
        ? (assetEntries[0].amount > 0n ? 'positive' : assetEntries[0].amount < 0n ? 'negative' : 'neutral')
        : (net > 0n ? 'positive' : net < 0n ? 'negative' : 'neutral');
      const headlineAmount = assetEntries.length === 1
        ? formatSignedAssetAmount(assetEntries[0].amount, assetEntries[0].tokenId)
        : (assetEntries.length > 1 ? `${assetEntries.length} assets` : formatSignedAssetAmount(net, null));

      const memoHtml = tx.memos.length > 0
        ? `<div class="tx-memo">${tx.memos.map(m => esc(m)).join(', ')}</div>`
        : '';
      const assetHtml = assetEntries.length > 0
        ? `<div class="tx-assets">${assetEntries.map((asset) => `
            <div class="tx-asset-row">
              <span class="tx-asset-name" title="${esc(asset.tokenId || 'NAV')}">${esc(asset.shortLabel)}</span>
              <span class="tx-asset-amount ${asset.amount > 0n ? 'positive' : asset.amount < 0n ? 'negative' : 'neutral'}">${esc(formatSignedAssetAmount(asset.amount, asset.tokenId))}</span>
            </div>
          `).join('')}</div>`
        : '';

      const heightLabel = isUnconfirmed ? 'Unconfirmed' : `Height ${tx.blockHeight}`;
      const unconfBadge = isUnconfirmed ? '<span class="tx-badge unconfirmed">Pending</span>' : '';

      return `<div class="tx-item${isUnconfirmed ? ' tx-unconfirmed' : ''}">
        <div class="tx-item-header">
          <span class="tx-hash" title="${esc(tx.txHash)}">${tx.txHash.slice(0, 16)}…</span>
          <span class="tx-amount ${amountClass}">${esc(headlineAmount)}</span>
        </div>
        <div class="tx-meta">
          <span class="tx-badge ${type}">${label}</span>
          ${unconfBadge}
          <span>${heightLabel}</span>
          ${tx.outputCount > 0 ? `<span>${tx.outputCount} output${tx.outputCount > 1 ? 's' : ''}</span>` : ''}
        </div>
        ${assetHtml}
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

  const assetKindInput = $('send-asset-kind') as HTMLSelectElement;
  const tokenIdInput = $('send-token-id') as HTMLInputElement;
  const nftIdInput = $('send-nft-id') as HTMLInputElement;
  const addressInput = $('send-address') as HTMLInputElement;
  const amountInput = $('send-amount') as HTMLInputElement;
  const memoInput = $('send-memo') as HTMLInputElement;
  const sendStatusEl = $('send-status');
  const sendBtn = $('btn-send') as HTMLButtonElement;

  const assetKind = assetKindInput.value as AssetKind;
  const tokenId = tokenIdInput.value.trim().toLowerCase();
  const nftIdRaw = nftIdInput.value.trim();
  const address = addressInput.value.trim();
  const amountRaw = amountInput.value.trim();
  const memo = memoInput.value.trim();

  if (!address) {
    sendStatusEl.textContent = 'Enter a destination address';
    sendStatusEl.className = 'send-status error';
    return;
  }

  let amountSat = 0n;
  let nftId: bigint | null = null;
  if (assetKind === 'nav') {
    const amountNav = parseFloat(amountRaw);
    if (isNaN(amountNav) || amountNav <= 0) {
      sendStatusEl.textContent = 'Enter a valid NAV amount';
      sendStatusEl.className = 'send-status error';
      return;
    }
    amountSat = BigInt(Math.round(amountNav * 1e8));
  } else if (assetKind === 'token') {
    if (!/^\d+$/.test(amountRaw) || BigInt(amountRaw) <= 0n) {
      sendStatusEl.textContent = 'Enter a positive integer token amount';
      sendStatusEl.className = 'send-status error';
      return;
    }
    if (!tokenId) {
      sendStatusEl.textContent = 'Enter a token id';
      sendStatusEl.className = 'send-status error';
      return;
    }
    amountSat = BigInt(amountRaw);
  } else {
    if (!tokenId) {
      sendStatusEl.textContent = 'Enter a collection token id';
      sendStatusEl.className = 'send-status error';
      return;
    }
    if (!/^\d+$/.test(nftIdRaw)) {
      sendStatusEl.textContent = 'Enter an NFT id';
      sendStatusEl.className = 'send-status error';
      return;
    }
    nftId = BigInt(nftIdRaw);
  }

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
    const sendOpts: any = {
      address,
      memo: memo || undefined,
    };

    if (selectedUtxoHashes.size > 0) {
      sendOpts.selectedUtxos = [...selectedUtxoHashes];
      log(`Using ${selectedUtxoHashes.size} manually selected UTXO(s)`);
    }

    let result;
    if (assetKind === 'nav') {
      sendOpts.amount = amountSat;
      result = await client.sendTransaction(sendOpts);
    } else if (assetKind === 'token') {
      sendOpts.amount = amountSat;
      sendOpts.tokenId = tokenId;
      result = await client.sendToken(sendOpts);
    } else {
      sendOpts.collectionTokenId = tokenId;
      sendOpts.nftId = nftId;
      result = await client.sendNft(sendOpts);
    }

    const sentLabel = assetKind === 'nav'
      ? formatAssetAmount(amountSat, null)
      : assetKind === 'token'
        ? formatAssetAmount(amountSat, tokenId)
        : describeAsset(composeNftTokenId(tokenId, nftId!)).label;

    log(`Sent ${sentLabel} → ${address.slice(0, 20)}...`);
    log(`TxID: ${result.txId}`);
    log(`Fee: ${Number(result.fee) / 1e8} NAV  (${result.inputCount} in, ${result.outputCount} out)`);

    sendStatusEl.textContent = `Sent! TxID: ${result.txId.slice(0, 16)}...`;
    sendStatusEl.className = 'send-status ok';

    // Clear form and UTXO selection
    addressInput.value = '';
    amountInput.value = '';
    memoInput.value = '';
    if (assetKind !== 'nav') {
      tokenIdInput.value = '';
      nftIdInput.value = '';
      assetKindInput.value = 'nav';
      updateSendAssetFields();
    }
    clearSelectedUtxoSelection();

    // Refresh balance and UTXOs
    await updateInfo();
    await refreshUtxos();
    await refreshHistory();
  } catch (e: any) {
    console.error('Send failed:', e);
    log(`Send failed: ${e.message}`);
    sendStatusEl.textContent = e.message;
    sendStatusEl.className = 'send-status error';
  } finally {
    sendBtn.disabled = false;
  }
}

async function runCreateMintAction() {
  if (!client) return;

  const actionInput = $('create-mint-action') as HTMLSelectElement;
  const collectionInput = $('create-mint-collection-id') as HTMLInputElement;
  const addressInput = $('create-mint-address') as HTMLInputElement;
  const totalSupplyInput = $('create-mint-total-supply') as HTMLInputElement;
  const amountInput = $('create-mint-amount') as HTMLInputElement;
  const nftIdInput = $('create-mint-nft-id') as HTMLInputElement;
  const metadataInput = $('create-mint-metadata') as HTMLTextAreaElement;
  const statusEl = $('create-mint-status');
  const actionButton = $('btn-create-mint') as HTMLButtonElement;

  const action = actionInput.value as CreateMintAction;
  const collectionTokenIdRaw = collectionInput.value.trim().toLowerCase();
  const address = addressInput.value.trim();
  const metadataRaw = metadataInput.value;

  const km = client.getKeyManager();
  if (km.isEncrypted() && !km.isUnlocked()) {
    const pw = prompt('Enter password to unlock wallet for collection creation or minting:');
    if (!pw) return;
    const ok = await km.unlock(pw);
    if (!ok) {
      statusEl.textContent = 'Wrong password';
      statusEl.className = 'send-status error';
      return;
    }
  }

  actionButton.disabled = true;
  statusEl.textContent = 'Building transaction...';
  statusEl.className = 'send-status';

  try {
    const sharedOpts: Record<string, unknown> = {};
    if (selectedUtxoHashes.size > 0) {
      sharedOpts.selectedUtxos = [...selectedUtxoHashes];
      log(`Using ${selectedUtxoHashes.size} manually selected UTXO(s) for fees`);
    }

    let result: any;
    let successLabel = '';

    if (action === 'create-token') {
      const totalSupply = parsePositiveIntegerInput(totalSupplyInput.value, 'Total supply');
      const metadata = parseMetadataJson(metadataRaw);
      result = await client.createTokenCollection({
        totalSupply,
        metadata,
        ...sharedOpts,
      });

      rememberCollection(result.collectionTokenId, 'token');
      actionInput.value = 'mint-token';
      collectionInput.value = result.collectionTokenId;
      totalSupplyInput.value = '';
      metadataInput.value = '';
      addressInput.value = '';
      amountInput.value = '';
      nftIdInput.value = '';
      updateCreateMintFields();
      successLabel = `Created token collection ${result.collectionTokenId}`;
      log(successLabel);
      log(`Token public key: ${result.tokenPublicKey}`);
    } else if (action === 'create-nft') {
      const metadata = parseMetadataJson(metadataRaw);
      const totalSupply = totalSupplyInput.value.trim() === ''
        ? 0n
        : parseNonNegativeIntegerInput(totalSupplyInput.value, 'Max supply');
      result = await client.createNftCollection({
        metadata,
        totalSupply,
        ...sharedOpts,
      });

      rememberCollection(result.collectionTokenId, 'nft');
      actionInput.value = 'mint-nft';
      collectionInput.value = result.collectionTokenId;
      totalSupplyInput.value = '';
      metadataInput.value = '';
      addressInput.value = '';
      amountInput.value = '';
      nftIdInput.value = '';
      updateCreateMintFields();
      successLabel = `Created NFT collection ${result.collectionTokenId}`;
      log(successLabel);
      log(`Token public key: ${result.tokenPublicKey}`);
    } else if (action === 'mint-token') {
      if (!address) {
        throw new Error('Enter a destination address');
      }
      if (!collectionTokenIdRaw) {
        throw new Error('Enter a collection token id');
      }

      const collectionTokenId = normalizeCollectionTokenId(collectionTokenIdRaw);
      const amount = parsePositiveIntegerInput(amountInput.value, 'Amount');
      result = await client.mintToken({
        address,
        collectionTokenId,
        amount,
        ...sharedOpts,
      });

      rememberCollection(collectionTokenId, 'token');
      addressInput.value = '';
      amountInput.value = '';
      metadataInput.value = '';
      successLabel = `Minted ${amount.toString()} token units from ${collectionTokenId} → ${address.slice(0, 20)}...`;
      log(successLabel);
    } else {
      if (!address) {
        throw new Error('Enter a destination address');
      }
      if (!collectionTokenIdRaw) {
        throw new Error('Enter a collection token id');
      }

      const collectionTokenId = normalizeCollectionTokenId(collectionTokenIdRaw);
      const nftId = parseNonNegativeIntegerInput(nftIdInput.value, 'NFT ID');
      const metadata = parseMetadataJson(metadataRaw);
      result = await client.mintNft({
        address,
        collectionTokenId,
        nftId,
        metadata,
        ...sharedOpts,
      });

      rememberCollection(collectionTokenId, 'nft');
      addressInput.value = '';
      nftIdInput.value = '';
      metadataInput.value = '';
      successLabel = `Minted NFT #${nftId.toString()} from ${collectionTokenId} → ${address.slice(0, 20)}...`;
      log(successLabel);
      log(`Minted token id: ${result.tokenId}`);
    }

    log(`TxID: ${result.txId}`);
    log(`Fee: ${Number(result.fee) / 1e8} NAV  (${result.inputCount} in, ${result.outputCount} out)`);

    statusEl.textContent = `${successLabel} (${result.txId.slice(0, 16)}...)`;
    statusEl.className = 'send-status ok';

    clearSelectedUtxoSelection();
    await updateInfo();
    await refreshUtxos();
    await refreshHistory();
  } catch (e: any) {
    console.error('Create/mint failed:', e);
    log(`Create/mint failed: ${e.message}`);
    statusEl.textContent = e.message;
    statusEl.className = 'send-status error';
  } finally {
    actionButton.disabled = false;
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
  knownCollections.clear();
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
$('btn-create-mint').addEventListener('click', runCreateMintAction);
$('btn-refresh-assets').addEventListener('click', refreshAssets);
$('btn-refresh-utxos').addEventListener('click', refreshUtxos);
$('utxo-show-spent').addEventListener('change', refreshUtxos);
$('send-asset-kind').addEventListener('change', () => {
  if (($('send-asset-kind') as HTMLSelectElement).value !== 'nft') {
    ($('send-nft-id') as HTMLInputElement).value = '';
  }
  updateSendAssetFields();
  clearSelectedUtxoSelection();
});
$('send-token-id').addEventListener('input', () => {
  syncNftFieldsFromTokenInput();
  clearSelectedUtxoSelection();
});
$('create-mint-action').addEventListener('change', () => {
  updateCreateMintFields();
});
$('btn-clear-utxo-selection').addEventListener('click', () => {
  clearSelectedUtxoSelection();
});
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
