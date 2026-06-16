/**
 * shared/num.js — rounding helpers.
 * Pure, no side effects. Importable by both server and client.
 */

/** Round to 1 decimal place. */
export function r1(n) {
  return Math.round(n * 10) / 10;
}

/** Round to 2 decimal places. */
export function r2(n) {
  return Math.round(n * 100) / 100;
}
