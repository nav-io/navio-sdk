/**
 * Navio Web Wallet Example
 *
 * This demonstrates basic usage of navio-sdk in a web browser.
 *
 * Note: For web usage, navio-blsct requires WebAssembly support.
 * The library initialization may take a moment on first load.
 */

// Polyfill Buffer for browser environment
import { Buffer } from 'buffer';
(window as any).Buffer = Buffer;

// WASM asset URL (bundled by Vite) - used for locateFile
import blsctWasmUrl from 'navio-blsct/wasm/blsct.wasm?url';

// Type definitions for the UI elements
interface WalletState {
  initialized: boolean;
  syncing: boolean;
  seed: string | null;
  mnemonic: string | null;
}

const state: WalletState = {
  initialized: false,
  syncing: false,
  seed: null,
  mnemonic: null,
};

// UI Elements
const elements = {
  // Setup
  setupSection: document.getElementById('setup-section')!,
  network: document.getElementById('network') as HTMLSelectElement,
  electrumHost: document.getElementById('electrum-host') as HTMLInputElement,
  electrumPort: document.getElementById('electrum-port') as HTMLInputElement,
  walletPassword: document.getElementById('wallet-password') as HTMLInputElement,
  walletPasswordConfirm: document.getElementById('wallet-password-confirm') as HTMLInputElement,
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
  lockBtn: document.getElementById('lock-btn')!,
  disconnectBtn: document.getElementById('disconnect-btn')!,

  // Unlock Dialog
  unlockSection: document.getElementById('unlock-section')!,
  unlockPassword: document.getElementById('unlock-password') as HTMLInputElement,
  unlockError: document.getElementById('unlock-error')!,
  confirmUnlockBtn: document.getElementById('confirm-unlock-btn')!,
  cancelUnlockBtn: document.getElementById('cancel-unlock-btn')!,

  // Change Password Dialog
  changePasswordSection: document.getElementById('change-password-section')!,
  oldPassword: document.getElementById('old-password') as HTMLInputElement,
  newPassword: document.getElementById('new-password') as HTMLInputElement,
  newPasswordConfirm: document.getElementById('new-password-confirm') as HTMLInputElement,
  changePasswordError: document.getElementById('change-password-error')!,
  confirmChangePasswordBtn: document.getElementById('confirm-change-password-btn')!,
  cancelChangePasswordBtn: document.getElementById('cancel-change-password-btn')!,

  // UTXOs
  utxosSection: document.getElementById('utxos-section')!,
  utxosList: document.getElementById('utxos-list')!,

  // Log
  log: document.getElementById('log')!,
};

// Logging helper
function log(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
  console.log('[log]', message, type);
  if (!elements.log) {
    console.error('Log element not found!');
    return;
  }
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
let blsctLib: any = null; // Reference to navio-blsct for address encoding

// WASM JS URL for script tag loading
import blsctJsUrl from 'navio-blsct/wasm/blsct.js?url';

/**
 * Load the BlsctModule factory via script tag
 * This is more reliable than dynamic import for CommonJS WASM modules
 */
async function loadBlsctFactory(): Promise<any> {
  return new Promise((resolve, reject) => {
    // Check if already loaded
    if (typeof (window as any).BlsctModule === 'function') {
      resolve((window as any).BlsctModule);
      return;
    }

    const script = document.createElement('script');
    script.src = blsctJsUrl;
    script.onload = () => {
      if (typeof (window as any).BlsctModule === 'function') {
        resolve((window as any).BlsctModule);
      } else {
        reject(new Error('BlsctModule not found after script load'));
      }
    };
    script.onerror = () => reject(new Error('Failed to load WASM script'));
    document.head.appendChild(script);
  });
}

async function loadSDK() {
  try {
    log('Loading navio-sdk...');
    
    // Step 1: Load the BlsctModule factory via script tag
    // This is more reliable than dynamic import for CommonJS WASM modules
    log('Loading WASM factory via script tag...');
    await loadBlsctFactory();
    console.log('BlsctModule factory set globally');
    
    // Step 2: Load navio-blsct - it will use the global BlsctModule factory
    log('Loading navio-blsct...');
    const blsct: any = await import('navio-blsct');
    console.log('navio-blsct imported');
    
    // Load the module through the library's loader
    log('Initializing WASM module...');
    const wasmModule = await blsct.loadBlsctModule({
      locateFile: (path: string) => {
        if (path.endsWith('.wasm')) {
          console.log('locateFile:', path, '->', blsctWasmUrl);
          return blsctWasmUrl;
        }
        return path;
      },
    });
    console.log('blsct.isModuleLoaded:', blsct.isModuleLoaded?.());
    
    // Ensure cryptoGetRandomValues is set on the module
    // This is required for MCL's web crypto API (MCL_USE_WEB_CRYPTO_API)
    if (!wasmModule.cryptoGetRandomValues && typeof crypto !== 'undefined' && crypto.getRandomValues) {
      console.log('Adding cryptoGetRandomValues to WASM module');
      wasmModule.cryptoGetRandomValues = (bufPtr: number, byteSize: number) => {
        const buffer = wasmModule.HEAPU8.subarray(bufPtr, bufPtr + byteSize);
        crypto.getRandomValues(buffer);
      };
    }
    log('WASM module loaded', 'success');
    
    // Step 3: Verify with their Scalar class
    log('Testing navio-blsct Scalar class...');
    try {
      const testScalar = new blsct.Scalar();
      console.log('Scalar created:', testScalar);
      console.log('Scalar serialize:', testScalar.serialize());
      log('Scalar class works', 'success');
    } catch (e) {
      console.error('Scalar creation failed:', e);
      console.error('Error type:', typeof e);
      if (typeof e === 'number') {
        console.log('This is a WASM exception pointer:', e);
        // This error indicates the MCL/BLS library inside the WASM module
        // didn't initialize correctly. This is a bug in the navio-blsct WASM build.
        log('WASM crypto initialization failed. The navio-blsct WASM module needs to be rebuilt.', 'error');
        throw new Error('WASM crypto library initialization failed (exception pointer: ' + e + '). ' +
          'This is a bug in the navio-blsct package - the MCL/BLS library is not properly initialized. ' +
          'Please rebuild navio-blsct or use a published version.');
      }
      throw new Error(`Scalar test failed: ${e}`);
    }
    
    // Store blsct reference for address encoding
    blsctLib = blsct;
    
    // Step 4: Load the SDK
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

let isCreatingWallet = false;
let walletPassword: string | null = null;

async function createWallet() {
  // Prevent multiple simultaneous wallet creations
  if (isCreatingWallet) {
    log('Wallet creation already in progress...', 'warning');
    return;
  }

  // Validate password if provided
  const password = elements.walletPassword?.value || '';
  const passwordConfirm = elements.walletPasswordConfirm?.value || '';

  if (password && password !== passwordConfirm) {
    log('Passwords do not match', 'error');
    return;
  }

  isCreatingWallet = true;

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
      walletDbPath: ':memory:', // In-memory for web demo
      createWalletIfNotExists: true,
    });

    await client.initialize();
    log('Wallet created', 'success');

    // Get the seed and mnemonic
    const keyManager = client.getKeyManager();
    state.seed = keyManager.getMasterSeedHex();
    state.mnemonic = keyManager.getMnemonic();

    // Set password if provided
    if (password) {
      log('Encrypting wallet with password...', 'info');
      await keyManager.setPassword(password);
      walletPassword = password;
      log('Wallet encrypted', 'success');
    }

    showWalletUI();
  } catch (error: any) {
    console.error('Wallet creation error:', error);
    console.error('Stack trace:', error?.stack);
    log(`Failed to create wallet: ${error}`, 'error');
  } finally {
    isCreatingWallet = false;
  }
}

async function restoreWallet() {
  const input = elements.seedInput.value.trim();
  if (!input) {
    log('Please enter a seed or mnemonic', 'warning');
    return;
  }

  const restoreHeight = elements.restoreHeight.value
    ? parseInt(elements.restoreHeight.value, 10)
    : undefined;

  // Detect if input is mnemonic (contains spaces) or hex seed
  const isMnemonic = input.includes(' ');
  
  log(`Restoring wallet from ${isMnemonic ? 'mnemonic' : 'seed'} (height: ${restoreHeight || 'genesis'})...`);

  const config = getConfig();

  try {
    const clientConfig: any = {
      network: config.network,
      backend: 'electrum',
      electrum: {
        host: config.electrumHost,
        port: config.electrumPort,
        ssl: false,
      },
      walletDbPath: ':memory:',
      restoreFromHeight: restoreHeight,
    };

    if (isMnemonic) {
      clientConfig.restoreFromMnemonic = input;
    } else {
      clientConfig.restoreFromSeed = input;
    }

    client = new NavioClient(clientConfig);

    await client.initialize();
    log('Wallet restored', 'success');

    // Get the mnemonic from the restored wallet
    const keyManager = client.getKeyManager();
    state.seed = keyManager.getMasterSeedHex();
    state.mnemonic = keyManager.getMnemonic();

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
  updateLockButton();
}

// ============================================================================
// Lock/Unlock Functions
// ============================================================================

function updateLockButton() {
  if (!client) return;

  const keyManager = client.getKeyManager();
  const isEncrypted = keyManager.isEncrypted();

  if (isEncrypted) {
    elements.lockBtn.classList.remove('hidden');
    if (keyManager.isUnlocked()) {
      elements.lockBtn.textContent = 'Lock Wallet';
    } else {
      elements.lockBtn.textContent = 'Unlock Wallet';
    }
  } else {
    elements.lockBtn.classList.add('hidden');
  }
}

function showUnlockDialog() {
  elements.unlockSection.classList.remove('hidden');
  elements.unlockPassword.value = '';
  elements.unlockError.classList.add('hidden');
  elements.unlockPassword.focus();
}

function hideUnlockDialog() {
  elements.unlockSection.classList.add('hidden');
  elements.unlockPassword.value = '';
}

async function handleUnlock() {
  if (!client) return;

  const password = elements.unlockPassword.value;
  if (!password) {
    elements.unlockError.textContent = 'Please enter your password';
    elements.unlockError.classList.remove('hidden');
    return;
  }

  try {
    const keyManager = client.getKeyManager();
    const success = await keyManager.unlock(password);

    if (success) {
      walletPassword = password;
      log('Wallet unlocked', 'success');
      hideUnlockDialog();
      updateLockButton();
    } else {
      elements.unlockError.textContent = 'Incorrect password';
      elements.unlockError.classList.remove('hidden');
    }
  } catch (error) {
    elements.unlockError.textContent = `Unlock failed: ${error}`;
    elements.unlockError.classList.remove('hidden');
  }
}

function handleLock() {
  if (!client) return;

  const keyManager = client.getKeyManager();

  if (keyManager.isUnlocked()) {
    keyManager.lock();
    walletPassword = null;
    log('Wallet locked', 'info');
    updateLockButton();
  } else {
    showUnlockDialog();
  }
}

function showChangePasswordDialog() {
  elements.changePasswordSection.classList.remove('hidden');
  elements.oldPassword.value = '';
  elements.newPassword.value = '';
  elements.newPasswordConfirm.value = '';
  elements.changePasswordError.classList.add('hidden');
  elements.oldPassword.focus();
}

function hideChangePasswordDialog() {
  elements.changePasswordSection.classList.add('hidden');
  elements.oldPassword.value = '';
  elements.newPassword.value = '';
  elements.newPasswordConfirm.value = '';
}

async function handleChangePassword() {
  if (!client) return;

  const oldPassword = elements.oldPassword.value;
  const newPassword = elements.newPassword.value;
  const newPasswordConfirm = elements.newPasswordConfirm.value;

  if (!oldPassword) {
    elements.changePasswordError.textContent = 'Please enter your current password';
    elements.changePasswordError.classList.remove('hidden');
    return;
  }

  if (!newPassword) {
    elements.changePasswordError.textContent = 'Please enter a new password';
    elements.changePasswordError.classList.remove('hidden');
    return;
  }

  if (newPassword !== newPasswordConfirm) {
    elements.changePasswordError.textContent = 'New passwords do not match';
    elements.changePasswordError.classList.remove('hidden');
    return;
  }

  try {
    const keyManager = client.getKeyManager();
    const success = await keyManager.changePassword(oldPassword, newPassword);

    if (success) {
      walletPassword = newPassword;
      log('Password changed successfully', 'success');
      hideChangePasswordDialog();
    } else {
      elements.changePasswordError.textContent = 'Current password is incorrect';
      elements.changePasswordError.classList.remove('hidden');
    }
  } catch (error) {
    elements.changePasswordError.textContent = `Failed to change password: ${error}`;
    elements.changePasswordError.classList.remove('hidden');
  }
}

async function updateWalletInfo() {
  if (!client) return;

  try {
    const config = getConfig();

    elements.walletNetwork.textContent = config.network;
    elements.walletStatus.textContent = client.isConnected() ? 'Connected' : 'Disconnected';
    elements.walletHeight.textContent = client.getLastSyncedHeight().toString();

    // Balance - convert from satoshis (bigint) to NAV with 8 decimal places
    const balanceSats = client.getBalanceNav();
    const balanceNav = Number(balanceSats) / 1e8;
    elements.walletBalance.textContent = `${balanceNav.toFixed(8)} NAV`;

    // Mnemonic/Seed
    if (state.mnemonic) {
      elements.walletSeed.textContent = state.mnemonic;
    } else if (state.seed) {
      elements.walletSeed.textContent = state.seed;
    }

    // Receive address (bech32m encoded)
    const keyManager = client.getKeyManager();
    if (keyManager) {
      try {
        // Get bech32m encoded address using the KeyManager method
        const network = config.network as 'mainnet' | 'testnet';
        const address = keyManager.getSubAddressBech32m({ account: 0, address: 0 }, network);
        elements.receiveAddress.textContent = address;
      } catch (addrError) {
        console.error('Error encoding address:', addrError);
        elements.receiveAddress.textContent = 'Error encoding address';
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
  state.mnemonic = null;

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

// Lock/Unlock event listeners
elements.lockBtn?.addEventListener('click', handleLock);
elements.confirmUnlockBtn?.addEventListener('click', handleUnlock);
elements.cancelUnlockBtn?.addEventListener('click', hideUnlockDialog);
elements.confirmChangePasswordBtn?.addEventListener('click', handleChangePassword);
elements.cancelChangePasswordBtn?.addEventListener('click', hideChangePasswordDialog);

// Allow Enter key to submit unlock password
elements.unlockPassword?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    handleUnlock();
  }
});

// Initialize
async function init() {
  console.log('init() called');
  log('Initializing web wallet...');
  const loaded = await loadSDK();
  console.log('loadSDK result:', loaded);
  if (loaded) {
    log('Ready. Create a new wallet or restore from seed.', 'success');
  }
}

console.log('main.ts module executing...');
init();
