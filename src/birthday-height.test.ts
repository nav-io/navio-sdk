import { describe, expect, it, vi } from 'vitest';
import {
  BIRTHDAY_SAFETY_MARGIN_SECONDS,
  estimateHeightForTimestamp,
  findHeightForTimestamp,
} from './birthday-height';
import type { SyncProvider } from './sync-provider';
import { NavioClient } from './client';
import { generateBirthdayMnemonic, parseBirthdayMnemonic } from './crypto/birthday-mnemonic';

const MAINNET_GENESIS = 1782910800;

/** A provider serving headers that carry only the given timestamps. */
function providerWithTimes(times: number[]): SyncProvider {
  const header = (time: number) => {
    const bytes = Buffer.alloc(80);
    bytes.writeUInt32LE(time, 68);
    return bytes.toString('hex');
  };
  return {
    getChainTipHeight: vi.fn(async () => times.length - 1),
    getBlockHeaders: vi.fn(async (start: number, count: number) => {
      const slice = times.slice(start, start + count);
      return { count: slice.length, hex: slice.map(header).join(''), max: 2016 };
    }),
  } as unknown as SyncProvider;
}

/**
 * Block times from genesis at `spacing` seconds, each jittered by up to
 * ±`jitter` seconds (so timestamps go backwards now and then, as on the
 * real chain).
 */
function chainTimes(blocks: number, spacing: number, jitter = 0): number[] {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const times: number[] = [];
  for (let h = 0; h < blocks; h++) {
    const offset = h === 0 ? 0 : Math.round((random() * 2 - 1) * jitter);
    times.push(MAINNET_GENESIS + h * spacing + offset);
  }
  return times;
}

/** The first height mined at or after `time` (by its nominal schedule). */
const firstHeightAt = (time: number, spacing: number) =>
  Math.ceil((time - MAINNET_GENESIS) / spacing);

describe('findHeightForTimestamp', () => {
  it('starts within a day before the birthday on a chain slower than the 120 s target', async () => {
    // Mainnet runs at ~130 s per block: the old 120 s estimate started
    // past the birthday once the wallet was a couple of weeks younger than
    // the chain, and the restore missed the wallet's first outputs.
    const spacing = 130;
    const times = chainTimes(60_000, spacing, 600);
    const birthday = MAINNET_GENESIS + 60 * 86_400;
    const first = firstHeightAt(birthday, spacing);

    const height = await findHeightForTimestamp(providerWithTimes(times), 'mainnet', birthday);

    expect(height).toBeLessThanOrEqual(first);
    // A day of 60 s blocks, the 2 h future-time allowance, and the lag of
    // the median time
    expect(height).toBeGreaterThanOrEqual(first - 1440 - Math.ceil(7200 / spacing) - 20);
  });

  it('is not misled by block timestamps that go backwards', async () => {
    // Timestamps jitter by ±2 h, far more than the block interval.
    const spacing = 120;
    const times = chainTimes(20_000, spacing, 7200);
    const birthday = MAINNET_GENESIS + 15 * 86_400;
    const first = firstHeightAt(birthday, spacing);

    const height = await findHeightForTimestamp(providerWithTimes(times), 'mainnet', birthday);

    expect(height).toBeLessThanOrEqual(first);
    expect(height).toBeGreaterThanOrEqual(first - 1440 - 200);
  });

  it('clamps at 0 for a birthday near genesis', async () => {
    const times = chainTimes(5_000, 120);
    expect(
      await findHeightForTimestamp(providerWithTimes(times), 'mainnet', MAINNET_GENESIS + 3600)
    ).toBe(0);
    expect(
      await findHeightForTimestamp(providerWithTimes(times), 'mainnet', MAINNET_GENESIS - 86_400)
    ).toBe(0);
  });

  it('starts a day of blocks below the tip for a birthday after the last block', async () => {
    const times = chainTimes(5_000, 120);
    const birthday = times[times.length - 1] + 7 * 86_400;
    expect(await findHeightForTimestamp(providerWithTimes(times), 'mainnet', birthday)).toBe(
      4_999 - 1440
    );
  });

  it('reads O(log n) header windows', async () => {
    const provider = providerWithTimes(chainTimes(100_000, 120));
    await findHeightForTimestamp(provider, 'mainnet', MAINNET_GENESIS + 30 * 86_400);
    expect(vi.mocked(provider.getBlockHeaders).mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('falls back to an estimate that errs low when headers are unavailable', async () => {
    const provider = {
      getChainTipHeight: vi.fn(async () => 100_000),
      getBlockHeaders: vi.fn(async () => {
        throw new Error('unsupported');
      }),
    } as unknown as SyncProvider;
    const birthday = MAINNET_GENESIS + 60 * 86_400;

    const height = await findHeightForTimestamp(provider, 'mainnet', birthday);

    expect(height).toBe(estimateHeightForTimestamp('mainnet', birthday));
    // Below the true height at the observed ~130 s per block
    expect(height).toBeLessThan(firstHeightAt(birthday - BIRTHDAY_SAFETY_MARGIN_SECONDS, 130));
  });
});

describe('NavioClient restore from a birthday mnemonic', () => {
  it('starts scanning at the height found from the headers', async () => {
    const spacing = 130;
    const times = chainTimes(60_000, spacing, 600);
    const birthdayTime = MAINNET_GENESIS + 60 * 86_400;
    const mnemonic = generateBirthdayMnemonic(birthdayTime);
    // The phrase stores the week, not the exact time.
    const encoded = parseBirthdayMnemonic(mnemonic).birthday!;

    const provider = {
      ...providerWithTimes(times),
      type: 'custom' as const,
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const client = new NavioClient({
      network: 'mainnet',
      backend: 'electrum',
      electrum: { host: 'localhost', port: 50001 },
      walletDbPath: ':memory:',
      restoreFromMnemonic: mnemonic,
    });
    (client as any).syncProvider = provider;
    await client.initialize();

    const height = await client.getCreationHeight();
    expect(height).toBe(await findHeightForTimestamp(provider, 'mainnet', encoded));
    expect(height).toBeLessThanOrEqual(firstHeightAt(encoded, spacing));
    expect(height).toBeGreaterThan(0);
    await (client as any).walletDB.close();
  });
});

describe('estimateHeightForTimestamp', () => {
  it('assumes slow blocks so the estimate stays below the chain at up to 240 s per block', () => {
    for (const days of [2, 30, 365]) {
      const birthday = MAINNET_GENESIS + days * 86_400;
      const estimate = estimateHeightForTimestamp('mainnet', birthday);
      for (const spacing of [60, 120, 130, 240]) {
        expect(estimate).toBeLessThanOrEqual(firstHeightAt(birthday, spacing));
      }
    }
  });

  it('is 0 before genesis and on networks without a known genesis time', () => {
    expect(estimateHeightForTimestamp('mainnet', MAINNET_GENESIS - 10)).toBe(0);
    expect(estimateHeightForTimestamp('regtest', MAINNET_GENESIS + 365 * 86_400)).toBe(0);
  });
});
