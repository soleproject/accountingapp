/** Shared currency/number formatting for the Personal product. */

export function fmtCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

/** Compact signed display: spending (positive amount) shows red, income green. */
export function fmtSignedAmount(n: number): string {
  const abs = Math.abs(n);
  const base = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(abs);
  return n > 0 ? `-${base}` : base;
}
