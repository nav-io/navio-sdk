import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const mnemonic = 'cotton whisper mystery garlic stool aunt lend section supreme pony curious twin drift actress soon immune gym shiver eagle satisfy radio turkey embark father';

const entropy = bip39.mnemonicToEntropy(mnemonic, wordlist);
console.log('entropy type:', typeof entropy, entropy.constructor.name);
console.log('entropy length:', entropy.length);

const entropyHex = Buffer.from(entropy).toString('hex');
console.log('entropy hex:', entropyHex);
console.log('entropy hex length:', entropyHex.length);
console.log('entropy hex padded:', entropyHex.padStart(64, '0'));

// Now convert back to mnemonic
const recoveredMnemonic = bip39.entropyToMnemonic(entropy, wordlist);
console.log('recovered mnemonic:', recoveredMnemonic);
console.log('match:', recoveredMnemonic === mnemonic);
