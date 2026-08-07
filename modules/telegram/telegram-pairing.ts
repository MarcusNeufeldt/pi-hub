/**
 * Telegram pairing-code generation + hashing (design doc §9.2).
 *
 * Uses Node's built-in `scrypt` (no bcrypt native dep, per AGENTS.local.md
 * §12). Only the HASH is stored; the 6-digit plaintext is returned once to the
 * Web UI and never persisted or queryable again. Pairing codes are
 * single-use and expire (default 10 min).
 */

import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { TelegramRole } from "./types";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes (§9.2)
export const PAIRING_CODE_LENGTH = 6;

/** Generates a cryptographically-random 6-digit numeric pairing code. */
export function generatePairingCode(): string {
  // 6 digits from a CSPRNG; bias-corrected via rejection sampling.
  const max = 1_000_000;
  const limit = Math.floor(0x1000000 / max) * max;
  let n: number;
  do {
    n = randomBytes(3).readUIntBE(0, 3); // 0..16777215
  } while (n >= limit);
  return (n % max).toString().padStart(PAIRING_CODE_LENGTH, "0");
}

/**
 * Hashes a pairing code for storage. Format: `scrypt$<saltHex>$<hashHex>`.
 * The salt makes the hash unique even if two codes collide.
 */
export function hashPairingCode(code: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time comparison of a plaintext code against a stored hash. */
export function verifyPairingCode(code: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    const actual = scryptSync(code, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Hashes a code for lookup (when the caller already has the hash to compare). */
export function lookupHash(code: string): string {
  // Deterministic hash for DB index lookup is NOT how scrypt works (random
  // salt). The store keys pairing codes by a unique hash column, so we instead
  // store the *scrypt hash* as the unique key and verify by iteration. To keep
  // a UNIQUE index usable, callers pass hashPairingCode() output as the key.
  return hashPairingCode(code);
}

export interface GeneratedPairingCode {
  /** One-time plaintext shown to the user in the Web UI. */
  plaintext: string;
  /** Scrypt hash stored in the DB (single-use, expires). */
  codeHash: string;
  role: TelegramRole;
  expiresAt: number;
}
