/**
 * Type definitions for Navio SDK
 */

// NavioClientConfig is now defined in client.ts
// This file can be used for other shared types

/**
 * Network type for Navio
 */
export type NavioNetwork = 'mainnet' | 'testnet' | 'regtest';

/**
 * Generic hex string type
 */
export type HexString = string;

/**
 * Transaction hash (64-character hex string)
 */
export type TxHash = HexString;

/**
 * Block hash (64-character hex string)
 */
export type BlockHash = HexString;

/**
 * Output hash (64-character hex string, Navio-specific)
 */
export type OutputHash = HexString;
