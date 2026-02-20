#!/usr/bin/env tsx
/**
 * Test script for sending a transaction.
 * Loads wallet from mnemonic, syncs, and sends coins to itself.
 */

import { NavioClient } from '../src/client';
import * as path from 'path';
import * as fs from 'fs';
import { Address, AddressEncoding, DoublePublicKey } from 'navio-blsct';

const MNEMONIC = 'smile normal shock slice door nephew vehicle comic matrix crouch goose cabbage area regular discover column expand argue human veteran cover quantum begin victory';

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Send Transaction Test');
  console.log('═══════════════════════════════════════════════════════════\n');

  const dbPath = path.join(__dirname, '../test-send-wallet.db');

  // Clean up old DB
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
  }

  const client = new NavioClient({
    walletDbPath: dbPath,
    electrum: { host: 'testnet.nav.io', port: 50005, ssl: false },
    createWalletIfNotExists: true,
    network: 'testnet',
    restoreFromMnemonic: MNEMONIC,
    restoreFromHeight: 115000,
  });

  console.log('Initializing client...');
  await client.initialize();
  console.log('✓ Initialized\n');

  const km = client.getKeyManager();
  const subAddr = km.getSubAddress({ account: 0, address: 0 });
  const dpk = DoublePublicKey.deserialize(subAddr.serialize());
  const address = Address.encode(dpk, AddressEncoding.Bech32M);
  console.log('Address:', address);
  console.log('Mnemonic:', km.getMnemonic());

  // Sync until caught up
  console.log('\nSyncing...');
  let synced = false;
  await client.startBackgroundSync({
    pollInterval: 3000,
    onProgress: (cur, tip) => {
      const pct = ((cur / tip) * 100).toFixed(1);
      process.stdout.write(`\rSync: ${cur}/${tip} (${pct}%)`);
      if (cur >= tip) synced = true;
    },
    onBalanceChange: (nb, ob) => {
      const diff = Number(nb - ob) / 1e8;
      console.log(`\n  Balance change: ${diff > 0 ? '+' : ''}${diff.toFixed(8)} NAV`);
    },
    onError: (e) => console.error('\n  Sync error:', e.message),
  });

  // Wait for sync
  while (!synced) await new Promise(r => setTimeout(r, 1000));
  // Give it a moment after reaching tip
  await new Promise(r => setTimeout(r, 2000));
  client.stopBackgroundSync();
  console.log('\n✓ Sync complete\n');

  const balance = await client.getBalance();
  const utxos = await client.getUnspentOutputs();
  console.log(`Balance: ${(Number(balance) / 1e8).toFixed(8)} NAV`);
  console.log(`UTXOs: ${utxos.length}`);
  for (const u of utxos.slice(0, 5)) {
    console.log(`  ${u.outputHash.substring(0, 16)}... idx=${u.outputIndex} amount=${Number(u.amount) / 1e8} NAV`);
  }

  if (balance <= 0n) {
    console.log('\nNo balance to send. Exiting.');
    await client.disconnect();
    process.exit(0);
  }

  // Send 0.1 NAV to ourselves — step by step for debugging
  const sendAmount = 10_000_000n; // 0.1 NAV
  console.log(`\nSending ${Number(sendAmount) / 1e8} NAV to self (${address.substring(0, 30)}...)`);

  try {
    console.log('\n--- Step 1: Decode address ---');
    const { Address: Addr, AddressEncoding: AE, SubAddr: SA, TokenId: TI,
            CTxId: CId, OutPoint: OP, TxIn: TIn, TxOut: TOut, TxOutputType: TOT,
            Scalar: Sc, PublicKey: PK, PrivSpendingKey: PSK,
            buildCTx: bCTx, createTxInVec, addToTxInVec,
            createTxOutVec, addToTxOutVec, deleteTxInVec, deleteTxOutVec, freeObj: fo,
            SubAddrId: SAId } = await import('navio-blsct');
    const decoded = Addr.decode(address);
    const destSubAddr = SA.fromDoublePublicKey(decoded);
    console.log('  ✓ Address decoded');

    console.log('\n--- Step 2: Select UTXOs ---');
    const utxo = utxos[0];
    console.log(`  UTXO: ${utxo.outputHash.substring(0, 20)}... amount=${Number(utxo.amount)/1e8}`);

    console.log('\n--- Step 3: Build TxIn ---');
    const tokenId = TI.default();
    const blindingPubKey = PK.deserialize(utxo.blindingKey);
    console.log('  blindingKey deserialized');
    const viewKey = km.getPrivateViewKey();
    console.log('  viewKey obtained');
    const masterSpendKey = km.getSpendingKey();
    console.log('  masterSpendKey obtained');
    const spendingPubKey = PK.deserialize(utxo.spendingKey);
    console.log('  spendingPubKey deserialized');
    const hashId = km.calculateHashId(blindingPubKey, spendingPubKey);
    const subAddrId = { account: 0, address: 0 };
    km.getSubAddressId(hashId, subAddrId);
    console.log(`  subAddrId: account=${subAddrId.account}, address=${subAddrId.address}`);
    const privSpendingKey = new PSK(
      blindingPubKey, viewKey, masterSpendKey,
      subAddrId.account, subAddrId.address,
    );
    console.log('  privSpendingKey created');
    const ctxId = CId.deserialize(utxo.outputHash);
    const outPoint = OP.generate(ctxId, 0);
    console.log('  outPoint created');
    const txIn = TIn.generate(Number(utxo.amount), 0, privSpendingKey, tokenId, outPoint);
    console.log(`  ✓ TxIn created, amount=${txIn.getAmount()}`);

    console.log('\n--- Step 4: Build TxOuts ---');
    const fee = 3n * 200_000n; // 1 input + 2 outputs
    const realSendAmount = sendAmount;
    const changeAmount = BigInt(utxo.amount) - realSendAmount - fee;
    console.log(`  send=${Number(realSendAmount)/1e8}, change=${Number(changeAmount)/1e8}, fee=${Number(fee)/1e8}`);

    const destTxOut = TOut.generate(
      destSubAddr, Number(realSendAmount), '', tokenId,
      TOT.Normal, 0, false, Sc.random(),
    );
    console.log(`  ✓ dest TxOut created, amount=${destTxOut.getAmount()}`);

    const changeSubAddrIdObj = SAId.generate(-1, 0);
    const changeSubAddr = SA.generate(viewKey, PK.fromScalar(masterSpendKey), changeSubAddrIdObj);
    const changeTxOut = TOut.generate(
      changeSubAddr, Number(changeAmount), '', tokenId,
      TOT.Normal, 0, false, Sc.random(),
    );
    console.log(`  ✓ change TxOut created, amount=${changeTxOut.getAmount()}`);

    console.log('\n--- Step 5: Build CTx ---');
    const txInVec = createTxInVec();
    addToTxInVec(txInVec, txIn.value());
    const txOutVec = createTxOutVec();
    addToTxOutVec(txOutVec, destTxOut.value());
    addToTxOutVec(txOutVec, changeTxOut.value());
    console.log('  vectors built');

    const rv = bCTx(txInVec, txOutVec);
    deleteTxInVec(txInVec);
    deleteTxOutVec(txOutVec);
    console.log(`  buildCTx result=${rv.result}`);

    if (rv.result !== 0) {
      fo(rv);
      throw new Error(`buildCTx failed with code ${rv.result}`);
    }

    const ctxPtr = rv.ctx;
    fo(rv);
    console.log('  ✓ CTx built');

    console.log('\n--- Step 6: Serialize CTx ---');
    const nativeBinding = require(
      require('path').join(
        require.resolve('navio-blsct'),
        '../../build/Release/blsct.node',
      ),
    );
    console.log('  native binding loaded');
    const rawTx = nativeBinding.serialize_ctx(ctxPtr);
    console.log(`  ✓ Serialized, length=${rawTx.length}`);
    console.log(`  First 100: ${rawTx.substring(0, 100)}`);

    console.log('\n--- Step 7: Broadcast ---');
    const txIdResult = await client.broadcastRawTransaction(rawTx);
    console.log(`  ✓ Broadcast result: ${txIdResult}`);

    console.log('\n✓ Transaction sent!');
  } catch (e: any) {
    console.error('\n✗ Send failed:', e.message);
    console.error('  Stack:', e.stack);
  }

  await client.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
