# Changelog

All notable changes to navio-sdk are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

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
