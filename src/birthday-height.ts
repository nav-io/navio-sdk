/**
 * Wallet birthday -> scan start height.
 *
 * A 26-word Navio birthday mnemonic carries the wallet's creation time. The
 * restore scans from the first block that could hold the wallet's outputs,
 * found by binary search over the chain's block headers, minus a day's worth
 * of blocks as a safety margin. Without headers it falls back to an estimate
 * from the genesis time that errs low.
 */

import type { SyncProvider } from './sync-provider';

/** Network names the estimate knows a genesis time for. */
type BirthdayNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

/** Genesis block timestamps (navio-core chainparams). */
const NETWORK_GENESIS_TIME: Partial<Record<BirthdayNetwork, number>> = {
  mainnet: 1782910800,
  testnet: 1777481682,
};

/** Seconds subtracted from the birthday before searching: one day. */
export const BIRTHDAY_SAFETY_MARGIN_SECONDS = 24 * 3600;

/**
 * Block time used to turn the safety margin into blocks. Half the 120 s PoS
 * target, so the margin covers at least a day even when blocks come fast.
 */
const FAST_BLOCK_SECONDS = 60;

/**
 * Block time assumed by the fallback estimate. Twice the 120 s PoS target
 * (mainnet runs at about 130 s), so the estimate lands below the true
 * height unless blocks averaged faster than 240 s, and a too-low start only
 * costs scan time.
 */
const SLOW_BLOCK_SECONDS = 240;

/**
 * Blocks in the median-time-past window (navio-core's
 * CBlockIndex::nMedianTimeSpan). Consensus requires each block's time to be
 * above the median of the previous 11, so the median is non-decreasing in
 * height while single timestamps are not.
 */
const MEDIAN_TIME_SPAN = 11;

/**
 * How far ahead of real time a block's timestamp may be (navio-core
 * MAX_FUTURE_BLOCK_TIME). The search target is moved back by this much.
 */
const MAX_FUTURE_BLOCK_TIME = 2 * 3600;

/**
 * Conservative scan height for a wallet birthday when no block headers are
 * available: assumes slow blocks so it errs low, after subtracting the one-day
 * margin. 0 for unknown networks or birthdays before genesis.
 */
export function estimateHeightForTimestamp(network: string, timestamp: number): number {
  const genesis = NETWORK_GENESIS_TIME[network as BirthdayNetwork];
  if (!genesis) return 0;
  const elapsed = timestamp - BIRTHDAY_SAFETY_MARGIN_SECONDS - genesis;
  if (elapsed <= 0) return 0;
  return Math.floor(elapsed / SLOW_BLOCK_SECONDS);
}

/** Header timestamps (unix seconds) of heights `start`..`start + count - 1`. */
async function headerTimes(
  provider: SyncProvider,
  start: number,
  count: number
): Promise<number[]> {
  const result = await provider.getBlockHeaders(start, count);
  const times: number[] = [];
  for (let i = 0; i < result.count && (i + 1) * 160 <= result.hex.length; i++) {
    times.push(Buffer.from(result.hex.substring(i * 160, (i + 1) * 160), 'hex').readUInt32LE(68));
  }
  if (times.length !== count) {
    throw new Error(`Expected ${count} headers from height ${start}, got ${times.length}`);
  }
  return times;
}

/** Median of the timestamps of the (up to) 11 blocks ending at `height`. */
async function medianTimePast(provider: SyncProvider, height: number): Promise<number> {
  const start = Math.max(0, height - MEDIAN_TIME_SPAN + 1);
  const times = await headerTimes(provider, start, height - start + 1);
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * The height to start scanning a wallet restored with a birthday.
 *
 * Binary-searches the provider's headers for the first height whose
 * median-time-past is at or after the birthday minus the 2-hour future-time
 * allowance, then moves a day's worth of fast blocks further back and clamps
 * at 0. The median is monotonic in height, so the search is exact despite
 * out-of-order block timestamps; it lags real time by a few blocks, which the
 * margin covers.
 *
 * Falls back to {@link estimateHeightForTimestamp} when the provider cannot
 * serve headers.
 *
 * @param provider - A connected sync provider
 * @param network - Network name, for the fallback estimate
 * @param birthday - Wallet creation time (unix seconds)
 */
export async function findHeightForTimestamp(
  provider: SyncProvider,
  network: string,
  birthday: number
): Promise<number> {
  const marginBlocks = Math.ceil(BIRTHDAY_SAFETY_MARGIN_SECONDS / FAST_BLOCK_SECONDS);
  const target = birthday - MAX_FUTURE_BLOCK_TIME;
  try {
    const tip = await provider.getChainTipHeight();
    if (tip < 0) return 0;
    if ((await medianTimePast(provider, tip)) < target) {
      // Born after every block's median time: start near the tip.
      return Math.max(0, tip - marginBlocks);
    }
    // Invariant: the answer is in [lo, hi]; MTP(hi) >= target.
    let lo = 0;
    let hi = tip;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await medianTimePast(provider, mid)) >= target) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return Math.max(0, lo - marginBlocks);
  } catch {
    const estimate = estimateHeightForTimestamp(network, birthday);
    try {
      return Math.min(estimate, Math.max(0, await provider.getChainTipHeight()));
    } catch {
      return estimate;
    }
  }
}
