// Sandbox fixture that the ChatReview page swaps IN while the tour is
// running. This lets tour beats safely "click" real UI (open Show-all,
// pop the ⋯ row menu, toggle Split mode, etc.) on fake data without
// ever mutating the user's real books.
//
// Shape rules (from ChatReview.jsx NoCategoryCard + SamplesList):
//   Card: { card_key, direction, prompt, contact_name, count,
//           total_dollars, samples[], txn_ids[] }
//   Sample: { id, date, amount, desc }
//
// Any field beyond those is ignored by the render path today, but the
// booking / peel / update-contact endpoints echo `card_key`/`txn_ids`
// back — using synthetic ids means any accidental mutation would
// harmlessly 404 on the backend (defensive guard).

const TOUR_CARD_1 = {
  card_key: "tour:card:1",
  direction: "out",
  prompt: "Tell me about payments to ACME Consulting LLC",
  contact_name: "ACME Consulting LLC",
  contact_id: "tour-contact-1",
  count: 15,
  total_dollars: -6000,
  txn_ids: [
    "tour-t-1-1","tour-t-1-2","tour-t-1-3","tour-t-1-4","tour-t-1-5",
    "tour-t-1-6","tour-t-1-7","tour-t-1-8","tour-t-1-9","tour-t-1-10",
    "tour-t-1-11","tour-t-1-12","tour-t-1-13","tour-t-1-14","tour-t-1-15",
  ],
  samples: [
    { id: "tour-t-1-1",  date: "2026-04-15", amount: -400, desc: "ACME contractor invoice #15" },
    { id: "tour-t-1-2",  date: "2026-04-01", amount: -400, desc: "ACME contractor invoice #14" },
    { id: "tour-t-1-3",  date: "2026-03-15", amount: -400, desc: "ACME contractor invoice #13" },
    { id: "tour-t-1-4",  date: "2026-03-01", amount: -400, desc: "ACME contractor invoice #12" },
    { id: "tour-t-1-5",  date: "2026-02-15", amount: -400, desc: "ACME contractor invoice #11" },
    { id: "tour-t-1-6",  date: "2026-02-01", amount: -400, desc: "ACME laptop purchase (team #3)" },
    { id: "tour-t-1-7",  date: "2026-01-15", amount: -400, desc: "ACME laptop purchase (team #2)" },
    { id: "tour-t-1-8",  date: "2026-01-01", amount: -400, desc: "ACME laptop purchase (team #1)" },
    { id: "tour-t-1-9",  date: "2025-12-15", amount: -400, desc: "ACME contractor invoice #08" },
    { id: "tour-t-1-10", date: "2025-12-01", amount: -400, desc: "ACME contractor invoice #07" },
    { id: "tour-t-1-11", date: "2025-11-15", amount: -400, desc: "ACME contractor invoice #06" },
    { id: "tour-t-1-12", date: "2025-11-01", amount: -400, desc: "ACME contractor invoice #05" },
    { id: "tour-t-1-13", date: "2025-10-15", amount: -400, desc: "ACME contractor invoice #04" },
    { id: "tour-t-1-14", date: "2025-10-01", amount: -400, desc: "ACME contractor invoice #03" },
    { id: "tour-t-1-15", date: "2025-09-15", amount: -400, desc: "ACME contractor invoice #02" },
  ],
};

const TOUR_CARD_2 = {
  card_key: "tour:card:2",
  direction: "in",
  prompt: "Tell me about these Wells Fargo deposits",
  contact_name: "Wells Fargo",
  contact_id: "tour-contact-2",
  count: 5,
  total_dollars: 4250,
  txn_ids: [
    "tour-t-2-1", "tour-t-2-2", "tour-t-2-3", "tour-t-2-4", "tour-t-2-5",
  ],
  samples: [
    { id: "tour-t-2-1", date: "2026-04-20", amount: 1000, desc: "Client deposit — Acme LLC" },
    { id: "tour-t-2-2", date: "2026-04-14", amount: 1000, desc: "Client deposit — BTC Corp" },
    { id: "tour-t-2-3", date: "2026-04-07", amount: 750, desc: "Client deposit — Riverstone Group" },
    { id: "tour-t-2-4", date: "2026-04-01", amount: 500, desc: "Owner contribution (equity)" },
    { id: "tour-t-2-5", date: "2026-03-28", amount: 1000, desc: "Client deposit — Northwind" },
  ],
};

export const TOUR_FIXTURE_QUEUE = {
  no_category: [TOUR_CARD_1, TOUR_CARD_2],
  transactions: [],
  checks: [],
};
