// Frontend mirror of backend/regions.py. Kept manually in sync — the
// registry is tiny and changes rarely, so a shared JSON manifest would
// be overkill. If you edit one, edit the other and run
// `pytest tests/test_region_defaults.py`.
//
// US is the fallback for every unknown/missing region so a legacy
// company doc that pre-dates the `region` field renders identically to
// how it always has.

export const REGIONS = {
  US: {
    code: "US",
    displayName: "United States",
    currency: "USD",
    currencySymbol: "$",
    locale: "en-US",
    dateFormat: "MM/DD/YYYY",
  },
  UK: {
    code: "UK",
    displayName: "United Kingdom",
    currency: "GBP",
    currencySymbol: "£",
    locale: "en-GB",
    dateFormat: "DD/MM/YYYY",
  },
};

// Resolve a region code → spec, US-safe fallback for anything we
// don't recognize (undefined, null, "", garbled input).
export const getRegion = (code) => {
  if (!code) return REGIONS.US;
  return REGIONS[String(code).toUpperCase()] || REGIONS.US;
};
