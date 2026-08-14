import { describe, it, expect } from 'vitest';
import * as bip39 from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import {
  BIRTHDAY_EPOCH,
  BIRTHDAY_WEEK,
  mnemonicWithBirthday,
  generateBirthdayMnemonic,
  parseBirthdayMnemonic,
  isBirthdayMnemonic,
} from './birthday-mnemonic';

const VECTOR_ENTROPY = Uint8Array.from({ length: 32 }, (_, i) => i);

describe('Navio birthday mnemonic', () => {
  it('matches the cross-implementation vector (navio-core, navio-electrum)', () => {
    const base = bip39.entropyToMnemonic(VECTOR_ENTROPY, englishWordlist);
    const m = mnemonicWithBirthday(base, 1783000000);
    expect(m).toBe(`${base} addict render`);
    const parsed = parseBirthdayMnemonic(m);
    expect(parsed.birthday).toBe(1782950400);
    expect(Array.from(parsed.entropy)).toEqual(Array.from(VECTOR_ENTROPY));
  });

  it('round-trips a generated mnemonic', () => {
    const now = Math.floor(Date.now() / 1000);
    const m = generateBirthdayMnemonic(now);
    expect(m.split(' ')).toHaveLength(26);
    const parsed = parseBirthdayMnemonic(m);
    expect(parsed.birthday).not.toBeNull();
    expect(parsed.birthday!).toBeLessThanOrEqual(now);
    expect(now - parsed.birthday!).toBeLessThan(BIRTHDAY_WEEK);
    expect((parsed.birthday! - BIRTHDAY_EPOCH) % BIRTHDAY_WEEK).toBe(0);
    expect(isBirthdayMnemonic(m)).toBe(true);
  });

  it('treats plain 24-word phrases as having no birthday', () => {
    const base = bip39.entropyToMnemonic(VECTOR_ENTROPY, englishWordlist);
    const parsed = parseBirthdayMnemonic(base);
    expect(parsed.birthday).toBeNull();
    expect(isBirthdayMnemonic(base)).toBe(false);
  });

  it('rejects tampered extra words', () => {
    const base = bip39.entropyToMnemonic(VECTOR_ENTROPY, englishWordlist);
    expect(() => parseBirthdayMnemonic(`${base} zoo render`)).toThrow();
    expect(() => parseBirthdayMnemonic(`${base} addict zoo`)).toThrow();
  });

  it('rejects birthday words bound to a different seed', () => {
    const base = bip39.entropyToMnemonic(VECTOR_ENTROPY, englishWordlist);
    const other = bip39.entropyToMnemonic(
      Uint8Array.from({ length: 32 }, (_, i) => i + 1),
      englishWordlist
    );
    const m2 = mnemonicWithBirthday(other, 1783000000).split(' ');
    const mixed = `${base} ${m2[24]} ${m2[25]}`;
    expect(() => parseBirthdayMnemonic(mixed)).toThrow();
  });

  it('rejects out-of-range times', () => {
    const base = bip39.entropyToMnemonic(VECTOR_ENTROPY, englishWordlist);
    expect(() => mnemonicWithBirthday(base, BIRTHDAY_EPOCH - 1)).toThrow();
    expect(() => mnemonicWithBirthday(base, BIRTHDAY_EPOCH + 2048 * BIRTHDAY_WEEK)).toThrow();
  });
});
