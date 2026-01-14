/**
 * Navio Web Wallet Example
 *
 * This demonstrates basic usage of navio-sdk in a web browser.
 *
 * Note: For web usage, navio-blsct requires WebAssembly support.
 * The library initialization may take a moment on first load.
 */

// Type definitions for the UI elements
interface WalletState {
  initialized: boolean;
  syncing: boolean;
  seed: string | null;
}

const state: WalletState = {
  initialized: false,
  syncing: false,
  seed: null,
};

// UI Elements
const elements = {
  // Setup
  setupSection: document.getElementById('setup-section')!,
  network: document.getElementById('network') as HTMLSelectElement,
  electrumHost: document.getElementById('electrum-host') as HTMLInputElement,
  electrumPort: document.getElementById('electrum-port') as HTMLInputElement,
  createWalletBtn: document.getElementById('create-wallet-btn')!,
  restoreWalletBtn: document.getElementById('restore-wallet-btn')!,

  // Restore
  restoreSection: document.getElementById('restore-section')!,
  seedInput: document.getElementById('seed-input') as HTMLTextAreaElement,
  restoreHeight: document.getElementById('restore-height') as HTMLInputElement,
  confirmRestoreBtn: document.getElementById('confirm-restore-btn')!,
  cancelRestoreBtn: document.getElementById('cancel-restore-btn')!,

  // Wallet
  walletSection: document.getElementById('wallet-section')!,
  walletStatus: document.getElementById('wallet-status')!,
  walletNetwork: document.getElementById('wallet-network')!,
  walletHeight: document.getElementById('wallet-height')!,
  walletBalance: document.getElementById('wallet-balance')!,
  receiveAddress: document.getElementById('receive-address')!,
  walletSeed: document.getElementById('wallet-seed')!,
  syncBtn: document.getElementById('sync-btn')!,
  stopSyncBtn: document.getElementById('stop-sync-btn')!,
  disconnectBtn: document.getElementById('disconnect-btn')!,

  // UTXOs
  utxosSection: document.getElementById('utxos-section')!,
  utxosList: document.getElementById('utxos-list')!,

  // Log
  log: document.getElementById('log')!,
};

// Logging helper
function log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString();
  entry.innerHTML = `<span class="time">${time}</span>${message}`;
  elements.log.insertBefore(entry, elements.log.firstChild);

  // Keep only last 50 entries
  while (elements.log.children.length > 50) {
    elements.log.removeChild(elements.log.lastChild!);
  }
}

// Dynamic import for navio-sdk (ESM)
let NavioClient: any = null;
let client: any = null;

async function loadSDK() {
  try {
    log('Loading navio-sdk...');
    const sdk = await import('navio-sdk');
    NavioClient = sdk.NavioClient;
    log('SDK loaded successfully', 'success');
    return true;
  } catch (error) {
    log(`Failed to load SDK: ${error}`, 'error');
    console.error('SDK load error:', error);
    return false;
  }
}

function getConfig() {
  return {
    network: elements.network.value as 'mainnet' | 'testnet',
    electrumHost: elements.electrumHost.value,
    electrumPort: parseInt(elements.electrumPort.value, 10),
  };
}

async function createWallet() {
  log('Creating new wallet...');

  const config = getConfig();

  try {
    client = new NavioClient({
      network: config.network,
      backend: 'electrum',
      electrum: {
        host: config.electrumHost,
        port: config.electrumPort,
        ssl: false,
      },
      dbPath: ':memory:', // In-memory for web demo
      createWalletIfNotExists: true,
    });

    await client.initialize();
    log('Wallet created', 'success');

    // Get the seed
    const keyManager = client.getKeyManager();
    const seedKey = keyManager.getMasterSeedKey();
    state.seed = seedKey ? seedKey.serialize() : null;

    showWalletUI();
  } catch (error) {
    log(`Failed to create wallet: ${error}`, 'error');
    console.error(error);
  }
}

async function restoreWallet() {
  const seed = elements.seedInput.value.trim();
  if (!seed) {
    log('Please enter a seed', 'warning');
    return;
  }

  const restoreHeight = elements.restoreHeight.value
    ? parseInt(elements.restoreHeight.value, 10)
    : undefined;

  log(`Restoring wallet from seed (height: ${restoreHeight || 'genesis'})...`);

  const config = getConfig();

  try {
    client = new NavioClient({
      network: config.network,
      backend: 'electrum',
      electrum: {
        host: config.electrumHost,
        port: config.electrumPort,
        ssl: false,
      },
      dbPath: ':memory:',
      seed: seed,
      restoreFromHeight: restoreHeight,
    });

    await client.initialize();
    log('Wallet restored', 'success');

    state.seed = seed;
    showWalletUI();
    hideRestoreUI();
  } catch (error) {
    log(`Failed to restore wallet: ${error}`, 'error');
    console.error(error);
  }
}

function showRestoreUI() {
  elements.restoreSection.classList.remove('hidden');
}

function hideRestoreUI() {
  elements.restoreSection.classList.add('hidden');
  elements.seedInput.value = '';
  elements.restoreHeight.value = '';
}

function showWalletUI() {
  elements.setupSection.classList.add('hidden');
  elements.walletSection.classList.remove('hidden');
  elements.utxosSection.classList.remove('hidden');

  state.initialized = true;
  updateWalletInfo();
}

async function updateWalletInfo() {
  if (!client) return;

  try {
    const config = getConfig();

    elements.walletNetwork.textContent = config.network;
    elements.walletStatus.textContent = client.isConnected() ? 'Connected' : 'Disconnected';
    elements.walletHeight.textContent = client.getLastSyncedHeight().toString();

    // Balance
    const balanceNav = client.getBalanceNav();
    elements.walletBalance.textContent = `${balanceNav.toFixed(8)} NAV`;

    // Seed
    if (state.seed) {
      elements.walletSeed.textContent = state.seed;
    }

    // Receive address (using double public key as placeholder)
    const keyManager = client.getKeyManager();
    if (keyManager) {
      const dpk = keyManager.getDoublePublicKey();
      if (dpk) {
        elements.receiveAddress.textContent = dpk.getAddress(config.network);
      }
    }

    // Update UTXOs
    await updateUTXOs();
  } catch (error) {
    console.error('Error updating wallet info:', error);
  }
}

async function updateUTXOs() {
  if (!client) return;

  try {
    const utxos = await client.getUnspentOutputs();

    if (utxos.length === 0) {
      elements.utxosList.innerHTML = '<p class="empty">No unspent outputs</p>';
      return;
    }

    elements.utxosList.innerHTML = utxos
      .map(
        (utxo: any) => `
      <div class="utxo-item">
        <div class="hash">${utxo.outputHash}</div>
        <div class="amount">${(Number(utxo.amount) / 1e8).toFixed(8)} NAV</div>
      </div>
    `
      )
      .join('');
  } catch (error) {
    console.error('Error fetching UTXOs:', error);
  }
}

async function startSync() {
  if (!client || state.syncing) return;

  log('Starting background sync...');
  state.syncing = true;

  elements.syncBtn.setAttribute('disabled', 'true');
  elements.stopSyncBtn.removeAttribute('disabled');

  try {
    await client.startBackgroundSync({
      pollInterval: 10000, // 10 seconds
      onProgress: (
        currentHeight: number,
        chainTip: number,
        blocksProcessed: number,
        _txKeysProcessed: number
      ) => {
        elements.walletHeight.textContent = currentHeight.toString();
        const percent = chainTip > 0 ? ((currentHeight / chainTip) * 100).toFixed(1) : 0;
        log(`Syncing: ${currentHeight}/${chainTip} (${percent}%) - ${blocksProcessed} blocks`);
      },
      onNewBlock: (height: number, hash: string) => {
        log(`New block ${height}: ${hash.substring(0, 16)}...`, 'success');
        updateWalletInfo();
      },
      onBalanceChange: (newBalance: bigint, oldBalance: bigint) => {
        const diff = Number(newBalance - oldBalance) / 1e8;
        log(
          `Balance change: ${diff > 0 ? '+' : ''}${diff.toFixed(8)} NAV`,
          diff > 0 ? 'success' : 'warning'
        );
        updateWalletInfo();
      },
      onError: (error: Error) => {
        log(`Sync error: ${error.message}`, 'error');
      },
    });
  } catch (error) {
    log(`Failed to start sync: ${error}`, 'error');
    state.syncing = false;
    elements.syncBtn.removeAttribute('disabled');
    elements.stopSyncBtn.setAttribute('disabled', 'true');
  }
}

async function stopSync() {
  if (!client || !state.syncing) return;

  log('Stopping sync...');
  await client.stopBackgroundSync();
  state.syncing = false;

  elements.syncBtn.removeAttribute('disabled');
  elements.stopSyncBtn.setAttribute('disabled', 'true');

  log('Sync stopped', 'success');
}

async function disconnect() {
  if (!client) return;

  log('Disconnecting...');

  if (state.syncing) {
    await stopSync();
  }

  await client.disconnect();
  client = null;
  state.initialized = false;
  state.seed = null;

  elements.setupSection.classList.remove('hidden');
  elements.walletSection.classList.add('hidden');
  elements.utxosSection.classList.add('hidden');

  log('Disconnected', 'success');
}

// Event listeners
elements.createWalletBtn.addEventListener('click', createWallet);
elements.restoreWalletBtn.addEventListener('click', showRestoreUI);
elements.confirmRestoreBtn.addEventListener('click', restoreWallet);
elements.cancelRestoreBtn.addEventListener('click', hideRestoreUI);
elements.syncBtn.addEventListener('click', startSync);
elements.stopSyncBtn.addEventListener('click', stopSync);
elements.disconnectBtn.addEventListener('click', disconnect);

// Initialize
async function init() {
  log('Initializing web wallet...');
  const loaded = await loadSDK();
  if (loaded) {
    log('Ready. Create a new wallet or restore from seed.', 'success');
  }
}

init();
