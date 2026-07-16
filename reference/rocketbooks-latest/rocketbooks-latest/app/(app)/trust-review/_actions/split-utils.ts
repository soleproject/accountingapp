/**
 * Split an integer amount (typically cents) into N near-equal buckets.
 * Earlier buckets get one extra cent until the remainder is absorbed —
 * matches the convention QuickBooks/Xero use for "split evenly". Returns
 * an array of length N whose sum equals totalCents exactly.
 */
export function splitAmountEvenly(totalCents: number, n: number): number[] {
	if (n <= 0) return [];
	const base = Math.floor(totalCents / n);
	const remainder = totalCents - base * n;
	return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}
