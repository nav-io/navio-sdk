# Changelog

All notable changes to navio-sdk are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
