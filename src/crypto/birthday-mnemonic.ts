/**
 * Navio birthday mnemonic v1
 *
 * A standard BIP39 24-word mnemonic followed by two extra words (26 total)
 * encoding the wallet's creation time ("birthday"), so a restore knows where
 * to start scanning without the user remembering a date:
 *
 *   word 25 (birthday word): index w = weeks elapsed since the fixed epoch
 *       2026-01-01 00:00 UTC (1767225600). 11 bits cover ~39 years.
 *   word 26 (check word): the first 11 bits of
 *       HMAC-SHA256(key=entropy, msg="navio-birthday" || w as uint16 BE).
 *       Binds the birthday to this particular seed and catches typos in
 *       either extra word.
 *
 * Key derivation uses ONLY the first 24 words, so the derived wallet is
 * identical to a plain 24-word restore; the extra words are pure metadata.
 * Dropping them degrades gracefully to a legacy full-scan restore, and any
 * BIP39-compatible wallet can still import the base words.
 *
 * The same format is implemented in navio-core (mnemonic/mnemonic.h) and
 * navio-electrum (electrum/navio_blsct.py). Shared cross-implementation
 * test vector: entropy 000102...1f at t=1783000000 appends "addict render"
 * and decodes to birthday 1782950400.
 */

import * as bip39 from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';

/** 2026-01-01 00:00 UTC */
export const BIRTHDAY_EPOCH = 1767225600;
/** One week in seconds */
export const BIRTHDAY_WEEK = 7 * 24 * 3600;

export interface ParsedBirthdayMnemonic {
  /** The 24-word BIP39 base phrase used for key derivation */
  base: string;
  /** The 32-byte entropy of the base phrase */
  entropy: Uint8Array;
  /** Wallet birthday as a unix timestamp (week floor), or null for plain BIP39 */
  birthday: number | null;
}

function checkIndex(entropy: Uint8Array, week: number): number {
  const tag = new TextEncoder().encode('navio-birthday');
  const msg = new Uint8Array(tag.length + 2);
  msg.set(tag);
  msg[tag.length] = (week >> 8) & 0xff;
  msg[tag.length + 1] = week & 0xff;
  const mac = hmac(sha256, entropy, msg);
  return ((mac[0] << 8) | mac[1]) >> 5; // first 11 bits
}

/**
 * Append the two birthday words to a 24-word BIP39 mnemonic.
 * @param mnemonic24 - A valid 24-word BIP39 phrase
 * @param timestampSec - Wallet creation time (unix seconds, e.g. Date.now()/1000)
 */
export function mnemonicWithBirthday(mnemonic24: string, timestampSec: number): string {
  const base = mnemonic24.trim().split(/\s+/).join(' ');
  const entropy = bip39.mnemonicToEntropy(base, englishWordlist);
  if (entropy.length !== 32) {
    throw new Error('birthday mnemonics require a 24-word base phrase');
  }
  const week = Math.floor((timestampSec - BIRTHDAY_EPOCH) / BIRTHDAY_WEEK);
  if (week < 0 || week >= 2048) {
    throw new Error('birthday outside representable range');
  }
  return `${base} ${englishWordlist[week]} ${englishWordlist[checkIndex(entropy, week)]}`;
}

/** Generate a fresh 26-word birthday mnemonic for creation time `timestampSec`. */
export function generateBirthdayMnemonic(timestampSec: number): string {
  return mnemonicWithBirthday(bip39.generateMnemonic(englishWordlist, 256), timestampSec);
}

/**
 * Parse a plain BIP39 mnemonic or the 26-word Navio birthday variant.
 * Throws on any invalid phrase (bad word, checksum, or check word).
 */
export function parseBirthdayMnemonic(text: string): ParsedBirthdayMnemonic {
  const words = text.trim().split(/\s+/);
  if (words.length === 26) {
    const base = words.slice(0, 24).join(' ');
    const entropy = bip39.mnemonicToEntropy(base, englishWordlist);
    const week = englishWordlist.indexOf(words[24]);
    const check = englishWordlist.indexOf(words[25]);
    if (week < 0 || check < 0) {
      throw new Error('birthday words not in wordlist');
    }
    if (check !== checkIndex(entropy, week)) {
      throw new Error('invalid birthday check word');
    }
    return { base, entropy, birthday: BIRTHDAY_EPOCH + week * BIRTHDAY_WEEK };
  }
  const base = words.join(' ');
  return { base, entropy: bip39.mnemonicToEntropy(base, englishWordlist), birthday: null };
}

/** True if `text` is a valid 26-word birthday mnemonic. */
export function isBirthdayMnemonic(text: string): boolean {
  try {
    return parseBirthdayMnemonic(text).birthday !== null;
  } catch {
    return false;
  }
}
