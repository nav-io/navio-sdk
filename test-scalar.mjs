import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Scalar } from 'navio-blsct';

const mnemonic = 'cotton whisper mystery garlic stool aunt lend section supreme pony curious twin drift actress soon immune gym shiver eagle satisfy radio turkey embark father';

// Step 1: Convert mnemonic to entropy
const entropy = bip39.mnemonicToEntropy(mnemonic, wordlist);
const entropyHex = Buffer.from(entropy).toString('hex').padStart(64, '0');
console.log('Original entropy hex:', entropyHex);

// Step 2: Create Scalar from entropy
const scalar = Scalar.deserialize(entropyHex);
console.log('Scalar created');

// Step 3: Serialize the scalar back to hex
const serializedHex = scalar.serialize();
console.log('Serialized scalar hex:', serializedHex);
console.log('Serialized length:', serializedHex.length);

// Step 4: Pad and convert back to mnemonic
const paddedHex = serializedHex.padStart(64, '0');
console.log('Padded hex:', paddedHex);

const seedBytes = Buffer.from(paddedHex, 'hex');
console.log('Seed bytes length:', seedBytes.length);

const recoveredMnemonic = bip39.entropyToMnemonic(seedBytes, wordlist);
console.log('Recovered mnemonic:', recoveredMnemonic);
console.log('Match:', recoveredMnemonic === mnemonic);

// Check if they're different
if (recoveredMnemonic !== mnemonic) {
  console.log('\n=== MISMATCH DETECTED ===');
  console.log('Original:', mnemonic);
  console.log('Recovered:', recoveredMnemonic);
  console.log('\nOriginal entropy:', entropyHex);
  console.log('After Scalar:', paddedHex);
}
