// Best-effort mapping from Plaid institution name → domain for Clearbit
// logo lookups. Kept small and heuristic-only: any hit gets a nice logo;
// anything unmapped falls back to a colored letter avatar in the UI.
const KNOWN = {
  "chase": "chase.com",
  "chase business": "chase.com",
  "jpmorgan chase": "chase.com",
  "bank of america": "bankofamerica.com",
  "bofa": "bankofamerica.com",
  "wells fargo": "wellsfargo.com",
  "citi": "citi.com",
  "citibank": "citi.com",
  "american express": "americanexpress.com",
  "amex": "americanexpress.com",
  "capital one": "capitalone.com",
  "us bank": "usbank.com",
  "u.s. bank": "usbank.com",
  "pnc": "pnc.com",
  "pnc bank": "pnc.com",
  "td bank": "td.com",
  "discover": "discover.com",
  "hsbc": "hsbc.com",
  "ally": "ally.com",
  "ally bank": "ally.com",
  "charles schwab": "schwab.com",
  "schwab": "schwab.com",
  "fidelity": "fidelity.com",
  "vanguard": "vanguard.com",
  "usaa": "usaa.com",
  "navy federal": "navyfederal.org",
  "sofi": "sofi.com",
  "mercury": "mercury.com",
  "brex": "brex.com",
  "ramp": "ramp.com",
  "silicon valley bank": "svb.com",
  "svb": "svb.com",
  "first republic": "firstrepublic.com",
  "regions": "regions.com",
  "regions bank": "regions.com",
  "truist": "truist.com",
  "bmo": "bmo.com",
  "bmo harris": "bmo.com",
  "fifth third": "53.com",
  "keybank": "key.com",
  "citizens bank": "citizensbank.com",
  "santander": "santanderbank.com",
  "plaid sandbox": "plaid.com",
};

export function institutionLogoUrl(institutionName) {
  if (!institutionName) return null;
  const key = String(institutionName).trim().toLowerCase();
  const domain = KNOWN[key];
  if (!domain) return null;
  return `https://logo.clearbit.com/${domain}`;
}
