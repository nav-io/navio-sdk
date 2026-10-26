/**
 * Types for RFQ atomic-swap trading over Navio's encrypted p2p messaging bus.
 *
 * Light wallets participate through an ElectrumX server that bridges to the
 * daemon's p2pmsg RPCs. Transaction halves are always built and signed
 * locally — the server and daemon only wrap, encrypt and relay them; they
 * never see private keys. Amounts are integer base units (satoshis for NAV).
 */

/** Options for opening a request-for-quote (taker side). */
export interface RequestQuoteOptions {
  /** Token to receive (public token id hex), or null for NAV */
  buyTokenId: string | null;
  /** Token to pay with (public token id hex), or null for NAV */
  sellTokenId: string | null;
  /** Amount of the buy token wanted, in base units */
  amount: bigint;
  /** Unix time (seconds) when the quote-collection window closes */
  expiry: number;
}

/** Result of opening a request-for-quote. */
export interface RequestQuoteResult {
  /** Identifier of the open request; use it to list/accept/cancel quotes */
  uuid: string;
  /** Session pubkey makers encrypt their quotes to (held by the daemon) */
  replyKey: string;
}

/** A maker quote collected for an open request-for-quote. */
export interface QuoteSummary {
  /** Quote identifier, unique within the request */
  quoteId: string;
  /** Units of the buy token the maker delivers */
  fill: bigint;
  /** Units of the sell token the maker charges */
  sellCost: bigint;
  /** sellCost / fill — lower is better for the taker */
  price: number;
  /**
   * Unix time (seconds) the quote expires. acceptQuote refuses a quote past
   * it. This is daemon metadata only: the maker's signed half itself has no
   * expiry (see {@link CancelSwapHalfOptions}).
   */
  orderExpiry: number;
}

/** Options for accepting a collected quote (taker side). */
export interface AcceptQuoteOptions {
  /** The request uuid returned by requestQuote */
  uuid: string;
  /** The chosen quote id from listQuotes */
  quoteId: string;
  /** Token to receive — must match the original request */
  buyTokenId: string | null;
  /** Token to pay with — must match the original request */
  sellTokenId: string | null;
  /**
   * Slippage bound: reject unless the quote charges at most this much of the
   * sell token. Quotes arrive over an open network — these bounds are the
   * taker's only trust anchor, so both are required.
   */
  maxPay: bigint;
  /** Slippage bound: reject unless the quote delivers at least this much */
  minRecv: bigint;
  /** Optional list of outputHashes to use as inputs (manual coin selection) */
  selectedUtxos?: string[];
}

/** Result of accepting a quote. */
export interface AcceptQuoteResult {
  /** Transaction id of the broadcast atomic swap */
  txId: string;
  /** The quote that was accepted */
  quote: QuoteSummary;
  /** Fee funded by this wallet's half (takers pay 0; the maker over-funds) */
  fee: bigint;
}

/** Options for configuring a maker swap intent on the connected daemon. */
export interface SwapIntentOptions {
  /** Token this wallet pays out when a request matches, or null for NAV */
  tokenInId: string | null;
  /** Token this wallet wants to receive, or null for NAV */
  tokenOutId: string | null;
  /** Reject requests below this fill size */
  minSize: bigint;
  /** Cap fills at this size */
  maxSize: bigint;
  /**
   * Minimum price in sell-units per buy-unit, scaled by 1e8.
   * E.g. 10_000_000n quotes 0.1 tokenOut per tokenIn.
   */
  priceMin: bigint;
  /** Unix time (seconds) the intent expires */
  expiry: number;
}

/**
 * Terms a maker accepts when answering a quote request: a request is within
 * them when the taker buys `tokenInId` and sells `tokenOutId`, the fill lies
 * in `[minSize, maxSize]`, and `sellCost * 1e8 >= fill * priceMin` (the
 * daemon's own matching rule, computed exactly).
 */
export interface ReplyQuoteBounds {
  /** Token this wallet pays out (the taker's buy token), or null for NAV */
  tokenInId: string | null;
  /** Token this wallet receives (the taker's sell token), or null for NAV */
  tokenOutId: string | null;
  /** Smallest fill accepted, in base units of tokenIn */
  minSize: bigint;
  /** Largest fill accepted, in base units of tokenIn */
  maxSize: bigint;
  /** Minimum price in tokenOut units per tokenIn unit, scaled by 1e8 */
  priceMin: bigint;
}

/**
 * A swap intent this wallet configured with setSwapIntent, as stored locally.
 * replyQuote answers only requests within one of these.
 */
export interface LocalSwapIntent extends ReplyQuoteBounds {
  /** Local id (stable for the intent's lifetime); pass it to clearSwapIntent */
  localId: string;
  /** Id the daemon assigned (not unique across daemons or daemon restarts) */
  intentId: number;
  /** Unix time (seconds) the intent expires */
  expiry: number;
  /** Unix time (seconds) the intent was configured */
  createdAt: number;
}

/** A maker swap intent as reported by the daemon. */
export interface SwapIntent {
  id: number;
  tokenIn: string | null;
  tokenOut: string | null;
  minSize: bigint;
  maxSize: bigint;
  priceMin: bigint;
  expiry: number;
}

/**
 * An inbound RFQ request that matched an intent on the daemon and awaits a
 * reply. The daemon's intents are shared by every client of the server, so a
 * pending request is not proof that this wallet agreed to its terms;
 * replyQuote checks it against this wallet's own intents.
 */
export interface PendingQuoteRequest {
  /** The request uuid; pass to replyQuote */
  uuid: string;
  /** Token the taker wants (this wallet delivers), null for NAV */
  buyTokenId: string | null;
  /** Token the taker pays (this wallet receives), null for NAV */
  sellTokenId: string | null;
  /** Units of the buy token to deliver */
  fill: bigint;
  /** Units of the sell token to charge */
  sellCost: bigint;
  /** Taker session pubkey the quote must be encrypted to */
  replyKey: string;
}

/** Options for answering a pending quote request (maker side). */
export interface ReplyQuoteOptions {
  /** The pending request to answer, from getPendingQuoteRequests */
  request: PendingQuoteRequest;
  /**
   * Unix time (seconds) the quote expires (default: 10 minutes from now).
   * Daemon metadata only: the signed half stays valid until its inputs are
   * spent, whatever this says. See {@link CancelSwapHalfOptions}.
   */
  orderExpiry?: number;
  /** Optional list of outputHashes to use as inputs (manual coin selection) */
  selectedUtxos?: string[];
  /**
   * Answer within these terms instead of this wallet's stored swap intents.
   * For apps that manage intents themselves (e.g. set on another wallet or
   * directly on the daemon). Without it, the request must fall within an
   * unexpired intent set with this wallet's setSwapIntent.
   */
  bounds?: ReplyQuoteBounds;
}

/** Result of replying to a quote request or broadcasting a standing order. */
export interface MakerQuoteResult {
  /** Identifier of the sent quote / standing order */
  quoteId: string;
  /** Fee over-funded by the maker half (covers the taker's fee-free half) */
  fee: bigint;
  /** The signed maker half (hex). Spends this wallet's coins if accepted. */
  halfTxHex: string;
  /** outputHashes of this wallet's coins the half spends */
  inputs: string[];
  /**
   * Standing orders only: local id of the tracked order (see
   * `listStandingOrders` / `forgetStandingOrder`).
   */
  localId?: string;
}

/**
 * A standing order this wallet published, tracked locally so the coins it
 * commits are not offered again while it is live. The network's order cache
 * refuses a second order spending an input of a stored order ("order
 * rejected (expired, duplicate, or input conflict)"), and evicts an order
 * only when it expires or one of its inputs is spent on chain.
 */
export interface StandingOrderRecord {
  /** Local id (stable across the order's lifetime). */
  localId: string;
  /** Daemon quote id; null while the broadcast outcome is unknown. */
  quoteId: string | null;
  /**
   * `live`: the daemon accepted the order. `unconfirmed`: the broadcast call
   * timed out — the daemon may still have published it (proof-of-work grind),
   * so its inputs stay reserved until expiry unless forgotten explicitly.
   */
  status: 'live' | 'unconfirmed';
  offerTokenId: string | null;
  offerAmount: bigint;
  wantTokenId: string | null;
  wantAmount: bigint;
  /**
   * Unix time (seconds) the order expires: when peers drop it from their
   * order cache. The signed half itself does not expire; anyone holding it
   * can still complete the swap until one of its inputs is spent.
   */
  expiry: number;
  /** outputHashes of the coins the order's half spends */
  inputs: string[];
  halfTxHex: string;
  fee: bigint;
  /** Unix time (seconds) the order was built */
  createdAt: number;
}

/** Options for publishing a standing swap order (maker side). */
export interface BroadcastOrderOptions {
  /** Token this wallet offers, or null for NAV */
  offerTokenId: string | null;
  /** Amount of the offer token delivered to the taker */
  offerAmount: bigint;
  /** Token this wallet wants, or null for NAV */
  wantTokenId: string | null;
  /** Amount of the want token charged to the taker */
  wantAmount: bigint;
  /**
   * Unix time (seconds) peers drop the order from their cache (network caps
   * at 14 days). The signed half does not expire with it.
   */
  expiry: number;
  /** Optional list of outputHashes to use as inputs (manual coin selection) */
  selectedUtxos?: string[];
  /**
   * Skip coins committed to this wallet's other live standing orders when
   * selecting inputs (default true). The order cache rejects an order that
   * spends an input of a stored order, so without this a second order built
   * from the same coins fails with "order rejected (... input conflict)".
   */
  reserveInputs?: boolean;
}

/**
 * Which signed swap half to cancel: a tracked standing order (by local id or
 * quote id), or the inputs of any half this wallet signed (e.g. the `inputs`
 * replyQuote returned).
 *
 * A signed half carries no expiry the chain enforces: `orderExpiry` and a
 * standing order's `expiry` only tell daemons when to stop relaying it. Anyone
 * who saw the half (the taker, the server, every peer that cached a standing
 * order) can still complete the swap until one of its inputs is spent.
 * cancelSwapHalf spends them back to this wallet.
 */
export type CancelSwapHalfOptions =
  | { orderId: string; inputs?: never }
  | { inputs: string[]; orderId?: never };

/** Result of cancelling a signed swap half. */
export interface CancelSwapHalfResult {
  /** Transaction id of the self-spend that invalidates the half */
  txId: string;
  /** Fee the self-spend paid, in NAV satoshis */
  fee: bigint;
  /** outputHashes of the half's inputs that the self-spend spent */
  spentInputs: string[];
}
