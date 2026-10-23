/**
 * EIP-2333 master key derivation and the BIP39 seed navio-core feeds it.
 *
 * navio-core (KeyMan::SetupMnemonicFromEntropy) turns a mnemonic into the
 * wallet's master key with BLS12_381_KeyGen::derive_master_SK, applied to
 * the 32-byte mnemonic entropy, or with a passphrase to the 64-byte BIP39
 * seed of the 24-word sentence. navio-electrum (navio_blsct.py) does the
 * same.
 */

import { extract, expand } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';

/** Order r of the BLS12-381 G1 subgroup */
const BLS12_381_R = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;

/** `ceil((3 * ceil(log2(r))) / 16)` */
const L = 48;

/**
 * EIP-2333 `derive_master_SK`: `HKDF_mod_r(IKM = seed)`.
 *
 * Matches navio-core's BLS12_381_KeyGen::derive_master_SK: the salt starts
 * as "BLS-SIG-KEYGEN-SALT-" and is re-hashed with SHA-256 on every attempt,
 * the HKDF input is `seed || I2OSP(0, 1)`, the info is `I2OSP(L, 2)`, and the
 * 48-byte output is read big-endian and reduced mod r until non-zero.
 *
 * @param seed - At least 32 bytes
 * @returns The 32-byte big-endian secret key
 */
export function deriveMasterSK(seed: Uint8Array): Uint8Array {
  if (seed.length < 32) {
    throw new Error('Seed must be an 256-bit octet string or larger');
  }
  const ikm = new Uint8Array(seed.length + 1);
  ikm.set(seed);
  const info = new Uint8Array([0, L]);
  let salt: Uint8Array = new TextEncoder().encode('BLS-SIG-KEYGEN-SALT-');
  for (;;) {
    salt = sha256(salt);
    const okm = expand(sha256, extract(sha256, ikm, salt), info, L);
    let sk = 0n;
    for (const byte of okm) {
      sk = (sk << 8n) | BigInt(byte);
    }
    sk %= BLS12_381_R;
    if (sk !== 0n) {
      const out = new Uint8Array(32);
      for (let i = 31; i >= 0; i--) {
        out[i] = Number(sk & 0xffn);
        sk >>= 8n;
      }
      return out;
    }
  }
}

/**
 * The 64-byte BIP39 seed: PBKDF2-HMAC-SHA512 over the sentence with salt
 * "mnemonic" + passphrase, 2048 rounds.
 *
 * Like navio-core's mnemonic::MnemonicToSeed this collapses whitespace but
 * applies no NFKD normalization, so a non-ASCII passphrase derives from its
 * exact UTF-8 bytes. For an ASCII passphrase the result is standard BIP39.
 *
 * @param sentence - Mnemonic words
 * @param passphrase - BIP39 passphrase
 */
export function bip39SeedRaw(sentence: string, passphrase: string): Uint8Array {
  const words = sentence.trim().split(/\s+/).join(' ');
  const encoder = new TextEncoder();
  return pbkdf2(sha512, encoder.encode(words), encoder.encode('mnemonic' + passphrase), {
    c: 2048,
    dkLen: 64,
  });
}

/** True if `passphrase` is pure ASCII (navio-core's IsAsciiPassphrase). */
export function isAsciiPassphrase(passphrase: string): boolean {
  return /^[\x00-\x7f]*$/.test(passphrase);
}
