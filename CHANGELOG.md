# Changelog

All notable changes to navio-sdk are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.1.36] - 2026-09-17

### Fixed

- **`backend: 'p2p'` now syncs and transacts against a Navio full node** with
  no Electrum server. The P2P path was unusable end to end:
  - `NetworkMagic` / `DefaultPorts` were stale (navio-core
    `kernel/chainparams.cpp`: mainnet `bd5fc300` / 48470, testnet `2467d2c1` /
    33670, regtest `fdbf9ffb` / 18444); `P2PSyncProvider` also defaulted to
    port 33570. The P2P network now follows the client's `network` unless
    `p2p.network` is set, and the default network is mainnet.
  - `broadcastTransaction` never sent anything. It now pushes an unsolicited
    `tx` message and confirms the node holds the transaction in its mempool
    (via the output-hash lookup below); a rejected transaction throws.
  - `getRawTransaction` waited for *any* `tx` message. Responses are now
    matched by txid/wtxid (and `notfound` is honoured); confirmed
    transactions the node no longer serves over `getdata` are re-read from the
    block they were scanned in (`txLocationCacheSize`, default 100000 txids).
  - `getTransactionKeys` threw; it now returns the parsed keys of a
    mempool / recent-block transaction.
  - `getTransactionOutput` fell back to navio-core's `getoutputdata` message,
    which cannot work on the wire: its name is 13 characters, one more than
    the 12-byte command field, so nodes receive `getoutputdat` and drop it as
    unknown. The node's output-hash lookup for `getdata(MSG_WITNESS_TX,
    outputHash)` is used instead (mempool / most recent block); scanned
    outputs are served from the local cache as before.
  - Transaction ids were the hash of the full serialization; they are now the
    witness-stripped hash (`CTransaction::ComputeHash`).
  - BLSCT output keys were only read when the range proof had commitments;
    navio-core serializes the keys and view tag whenever the BLSCT flag is
    set, so such outputs desynchronized the parser.
  - Header sync mislabelled heights on later batches, could not detect
    reorgs, and `getChainTipHeight` served a cached tip for 5 s so a sync
    started right after a new block stopped one block short. Headers are now
    chained by previous-hash with fork-point truncation, every
    `getChainTipHeight()` re-checks the node (one `getheaders` round-trip,
    empty reply when unchanged), and block `inv` announcements trigger a
    refresh. `subscribeBlockHeaders` is implemented on top of that, so
    `startBackgroundSync` reacts to new blocks immediately.
  - Request/response matching keyed by command name: concurrent requests of
    the same type collided and the connect timeout could fire after a
    successful handshake. `P2PClient` now matches replies by content (block
    hash, txid, inventory hash), advertises no services (`NODE_NONE`, so the
    node does not choose it as a headers-sync peer), sends nothing between
    `version` and `verack` (the node disconnects peers that send
    `sendaddrv2`/`wtxidrelay` after `verack`), and rejects all pending
    requests on close so `TransactionKeysSync` reconnects.
  - Blocks for a scan batch are downloaded concurrently (`maxConcurrentBlockRequests`,
    default 8) and `BlockTransactionKeys` now carries `timestamp` / `isPoS`
    from the P2P provider too.
- `NavioClient.initialize()` with `createWalletIfNotExists` and an explicit
  `creationHeight` never connected to the backend (every other path does), so
  `isConnected()` was false and the first `sync()` did nothing on P2P.
- `KeyManager.getSubAddressBech32m` accepts `'regtest'` and `'signet'`.

### Added

- `src/p2p-block-parser.ts` (exported): `parseBlock` / `parseTransaction` /
  `computeTxid` for Navio's block and BLSCT transaction wire format (PoS
  proof skipping, output hashes, key extraction, witness stripping).
- `scripts/test-p2p-regtest.ts` (`npm run test:p2p:regtest`): spawns a
  `naviod -chain=blsctregtest` node and runs the full P2P flow — header sync,
  receiving a payment, spending it back over P2P, `getRawTransaction`, and
  background polling picking up a new block. Requires a navio-core build
  (`NAVIOD=/path/to/naviod`).
- Unit tests for the parser and codec helpers (`src/p2p-block-parser.test.ts`).

## [0.1.35] - 2026-09-10

### Added

- **Standing-order tracking** (maker side). `broadcastOrder` records every
  order it publishes (`listStandingOrders`, `forgetStandingOrder`) and keeps
  the coins committed to live orders out of the next order's coin selection
  (`reserveInputs`, default true). The network's order cache refuses an order
  spending an input of a stored order — `order rejected (expired, duplicate,
  or input conflict)` — and evicts an order only on expiry or when an input
  is spent on chain, so re-publishing from the same coins could never work.
  A broadcast that times out keeps its reservation (the daemon may still have
  published the order after its proof-of-work grind) and says so in the
  error; other failures release it. Records are pruned when they expire or an
  input is spent. `MakerQuoteResult` now carries the `inputs` spent and, for
  standing orders, the `localId`. New `IWalletDB` methods
  `saveStandingOrder` / `getStandingOrders` / `deleteStandingOrder`
  (SQLite table `standing_orders`; IndexedDB store `standingOrders`, DB
  version 3).

## [0.1.34] - 2026-09-10

### Fixed

- **`Request timeout for method: blockchain.rfq.request_quote`** on testnet.
  Every p2pmsg message carries mandatory anti-spam proof-of-work that the
  daemon grinds before the RPC returns; a request-for-quote takes 10-30+ s on
  testnet and the time is probabilistic, so it regularly exceeded the electrum
  client's fixed 30 s request timeout. Calls that make the daemon broadcast —
  `requestQuote`, `acceptQuote`, maker `sendQuote`, `broadcastOrder` — now use
  a separate `p2pmsgTimeout` (default 180 s, configurable in the `electrum`
  options). Server operators: ElectrumX aborts any request over its own
  `REQUEST_TIMEOUT` (default 30 s, "server busy - request timed out"), so the
  bridge server needs `REQUEST_TIMEOUT=180` (or higher) as well.
- `requestQuote`, `setSwapIntent` and `broadcastOrder` validate `expiry` as a
  unix time in seconds and reject durations, millisecond timestamps and past
  times with an actionable message instead of a silent daemon-side expiry.

### Changed

- Depends on `@nav-io/navio-blsct` ^1.2.0 (supranational/blst backend,
  built from navio-core master).

## [0.1.33] - 2026-09-09

### Fixed

- **`mintToken` rejected with `failed-rangeproof-check` after the BLSCT proof
  transcript v2 activation** (testnet 70600, mainnet 42500). A fungible mint
  output carries a range proof, but it was always built under the v1
  transcript while the change output (and therefore the transaction marker)
  switched to v2. Mint outputs now follow the same transcript decision as
  every other output. Requires `@nav-io/navio-blsct` >= 1.1.20
  (`UnsignedOutput.mintToken(..., transcriptV2)`), backed by navio-core's new
  `build_unsigned_mint_token_output_with_transcript`. `createTokenCollection`
  with `initialMint` is covered by the same change.
- The proof transcript decision now also considers the connected backend's
  chain tip (refreshed before every spend), so a wallet that lags behind the
  activation height — or has not synced in this session — no longer emits
  v1 outputs the node rejects.
- **`Cannot derive spending key: output … does not map to a known sub-address
  in this wallet`** when spending:
  - Sub-addresses generated past the default pools (fresh receive addresses
    handed out with `generateNewSubAddress`/`getNewDestination`) were never
    persisted, so after a reload outputs received on them were in the
    database but unspendable. Sub-address mappings are now saved by
    `saveWallet` and the new `IWalletDB.saveSubAddresses`, and the spend path
    recovers unknown sub-addresses by deriving candidates around the account
    counters (`KeyManager.findSubAddressIdByHashId`), persisting what it finds.
  - Restoring a wallet with a different seed into an existing database kept
    the previous wallet's outputs and sync progress; those outputs were then
    selected as inputs and the spend failed. Restore/create now drop outputs,
    created collections and sync data that belong to a different spending key
    (restoring the same seed keeps everything).
  - Automatic coin selection skips outputs the wallet's keys cannot sign for
    (with a warning) instead of failing the whole spend, and reports a clear
    error naming the cause when no spendable output is left. Stored key hex
    is validated (96 hex chars) before it reaches the native point decoder,
    which does not fail cleanly on malformed input.

## [0.1.29] - 2026-08-14

### Added

- **Navio birthday mnemonic (26 words)**: a standard BIP39 24-word phrase plus
  two extra words encoding the wallet creation time (weeks since 2026-01-01 UTC
  plus an HMAC-SHA256 check word bound to the seed). Restores from a birthday
  mnemonic start scanning at the encoded week instead of from genesis.
  New `crypto` exports: `mnemonicWithBirthday`, `generateBirthdayMnemonic`,
  `parseBirthdayMnemonic`, `isBirthdayMnemonic`. `KeyManager` accepts 26-word
  phrases everywhere a mnemonic is accepted (keys derive from the 24-word base),
  and `NavioClient.restoreFromMnemonic` derives `restoreFromHeight`
  automatically. Format aligned with navio-core and navio-electrum via a shared
  cross-implementation test vector.

## [0.1.28] - 2026-07-27

### Added
- `mintNfts()`: mint several NFTs from a collection in a SINGLE transaction
  (one broadcast, one fee, one block). Per-NFT metadata and optional per-NFT
  destination addresses; returns the full NFT token ids in input order.
- `getAssetBalances` NFT entries now carry `nftMetadata` — the metadata the
  specific NFT was minted with (from the collection's on-chain minted list) —
  alongside the collection `metadata`/`totalSupply`.

### Fixed
- Token-registry lookup failures were cached for the client's lifetime, so a
  single transient server error left assets without metadata for the rest of
  a long-lived session ("received NFT has no metadata"). Misses now expire
  after 5 minutes, and NFT-collection entries refresh on the same interval so
  newly minted NFTs pick up their metadata; fungible collection info stays
  cached forever (it is immutable).

## [0.1.27] - 2026-07-22

### Fixed
- NAV balance no longer reads 0 while the wallet's own change is unconfirmed.
  Mempool processing stored the change output's token id as
  `TokenId.serialize()`'s NAV spelling (zero hash + `ffff…` no-subid marker),
  which the databases' NAV balance filters (null / bare zero hash) did not
  match — so after any send or mint the entire balance disappeared until the
  next block. Token ids are now normalized to `null` for NAV at the single
  write choke point, and both database filters additionally accept the legacy
  spelling so existing wallet databases heal without a resync.

## [0.1.26] - 2026-07-22

### Fixed
- Minting an NFT no longer kills the process. Mint outputs carry their amount
  as a transparent value and an *empty* range proof, and
  `RangeProof.recoverAmounts` on an empty proof terminates the process with an
  uncatchable native exception. The mempool-processing path that runs right
  after every own broadcast called it unconditionally, so any app died the
  moment it minted an NFT (the mint transaction itself was already broadcast
  and confirmed — only the local process crashed). All three amount-recovery
  sites now detect the empty proof and use the transparent value instead.
- Investigation of the same incident (testnet block 48020, the network's
  first NFT mint — made with this SDK's README example) uncovered the
  companion server-side bug: the ElectrumX indexer over-read empty range
  proofs by 304 bytes, corrupting the served keys, output hashes, and raw
  transaction for mint-carrying blocks. Fixed in nav-io/electrumx
  (`rfq-swap-bridge` branch); affected servers need a reindex of blocks
  containing mint outputs. The 0.1.25 malformed-key guard keeps wallets
  syncing past still-corrupted servers in the meantime.

## [0.1.25] - 2026-07-22

### Fixed
- Sync no longer aborts permanently on outputs whose BLSCT keys are not
  valid curve points. Anyone can broadcast such an output (testnet block
  48020 contains one); the server serves its keys verbatim, and
  `PublicKey.deserialize` threw, killing every sync attempt at that block —
  wallets stalled and re-scanned from their creation height in a loop
  (reported as "stuck at 48019, rolls back to 46700"). An output with
  invalid keys is spendable by no wallet, so it is now skipped and the rest
  of the block processes normally.

## [0.1.24] - 2026-07-22

### Added
- `publicTokenId` on `CreateCollectionResult`, `MintAssetResult`, and
  `CreatedCollectionInfo`: the public on-chain token id (hash of the token
  public key, computed locally) — the id explorers, `gettoken`, and the
  balance methods report. Collections from `listCreatedCollections` can now
  be joined directly against `getAssetBalances`/`getTokenBalances` rows.
  `collectionTokenId` (the creation id, needed for minting on any backend)
  is unchanged.
- `getAssetBalances` (and therefore `getTokenBalances`/`getNftBalances`)
  entries now carry the collection `metadata` and `totalSupply` when
  resolvable — from the wallet's own creation records, or from the server's
  token registry, cached for the client's lifetime (collection info is
  immutable). One call returns balances and display metadata. Pass
  `{ includeMetadata: false }` to skip.

## [0.1.23] - 2026-07-21

### Added
- `listCreatedCollections()`: list the token/NFT collections this wallet
  created. Creations are recorded in the wallet database at broadcast time;
  for restored wallets the method additionally discovers collections from
  chain in two ways — every distinct held token is looked up via
  `blockchain.token.get_token`, and the wallet's own transactions are scanned
  for create-token predicates (the create transaction spends the wallet's NAV,
  so its hash is known after a sync — this recovers collections that were
  created but never minted or held). A collection is reported when its
  on-chain token public key re-derives from the wallet's seed (the same
  ownership proof minting uses). Returned `collectionTokenId` is the creation
  id, directly usable with `mintToken`/`mintNft`.
  `{ discoverFromChain: false }` skips the chain passes.
- Wallet database: new `created_collections` table (SQLite) / store
  (IndexedDB, schema v2 — upgrades automatically).

## [0.1.22] - 2026-07-21

### Added
- `createTokenCollection` accepts `initialMint: { address, amount }` to mint the
  first supply of the new token in the **same transaction** as the collection
  creation (consensus executes output predicates in order, so the collection is
  registered before the mint is validated). Result gains `mintedAmount`.
  Without this, a mint can only be broadcast after the collection transaction
  has confirmed — two separate transactions cannot land in the same block
  because mempool validation cannot see an unconfirmed collection.
- This `CHANGELOG.md`; the GitHub release body now carries the version's
  changelog section.

## [0.1.21] - 2026-07-21

### Added
- `mintToken`/`mintNft` accept the *public* on-chain token id (the hash shown
  by explorers and `gettoken`) as `collectionTokenId`: when the connected
  Electrum server bridges `blockchain.token.get_token`, the SDK resolves it
  back to the creation id (`Hash(metadata‖totalSupply)`), re-derives the mint
  key, and verifies ownership. Minting into a collection created by a different
  wallet, or into the wrong collection type (fungible vs NFT), now fails with a
  clear error *before* broadcasting.
- `blockchain.token.get_token` bridge method on `ElectrumClient` (`getToken`).
- Network `failed-to-execute-predicate` rejections from mints now carry an
  explanation of the likely causes.

### Fixed
- Spends from a wallet database that was synced against a different network
  (e.g. testnet database used with a mainnet backend) were broadcast and
  rejected with an opaque `bad-txns-inputs-missingorspent`. Every spend now
  verifies the stored last-synced block hash against the connected backend and
  fails fast with a re-sync/wrong-network message.
- Destination addresses are validated against the client network's BLSCT
  address prefix (`nav`/`tnv`/`rnv`), so cross-network addresses error
  immediately instead of producing an invalid transaction.

### CI
- Allow install scripts for `navio-blsct`, `better-sqlite3`, and `esbuild`
  under npm's install-script policy (`package.json#allowScripts`); without it
  the native BLSCT module is never built and the publish pipeline fails.

## [0.1.20] - 2026-07-08

### Fixed
- Token/NFT mint output amounts are recovered reliably during sync: NFT mint
  outputs store their amount as a transparent value (now read), and a `0` from
  the serialized fast-path parser is treated as inconclusive and confirmed via
  the binding's full-transaction parser.

## [0.1.19] - 2026-07-07

### Added
- RFQ / atomic-swap trading for light wallets (taker and maker) over the
  ElectrumX p2pmsg bridge: `requestQuote`, `listQuotes`, `acceptQuote`,
  `broadcastSwapIntent`, `replyQuote`, and friends.
