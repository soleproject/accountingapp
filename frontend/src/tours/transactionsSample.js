// Sample transactions for the Transactions tour. Rendered through the
// real table so every beat has a live target; nothing is saved.
// Categories are mapped onto the company's own chart of accounts.

const pick = (accts, patterns, type = "expense") => {
  const types = type === "income" ? ["income", "revenue"] : [type];
  const typed = accts.filter((x) => types.includes(x.type || "expense") && !/uncategorized/i.test(x.name || ""));
  for (const re of patterns) {
    const a = typed.find((x) => re.test(x.name || ""));
    if (a) return a;
  }
  return typed[0] || null;
};

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const ROWS = [
  { key: "supplies", merchant: "The Home Depot", description: "THE HOME DEPOT #6234 RENO NV", amount: -483.29, days: 2, cat: [/supplies|materials/i], ai: 0.96, reason: "Lumber, concrete and mulch — job materials.", receipt: true },
  { key: "phoenix1", merchant: "Phoenix Business", description: "Zelle payment to PHOENIX BUSINESS Conf# a81xk2", amount: -1200.0, days: 3, cat: [/contract|subcontract|labor/i, /professional|outside services/i], ai: 0.72, reason: "Recurring payee; looks like subcontractor labor.", contact: "Phoenix Business" },
  { key: "phoenix2", merchant: "Phoenix Business", description: "Zelle payment to PHOENIX BUSINESS Conf# b02mq9", amount: -950.0, days: 11, cat: null, contact: "Phoenix Business" },
  { key: "phoenix3", merchant: "Phoenix Business", description: "Zelle payment to PHOENIX BUSINESS Conf# c77zt1", amount: -1200.0, days: 25, cat: null, contact: "Phoenix Business" },
  { key: "deposit", merchant: "Acme Landscaping LLC", description: "DEPOSIT · ACME LANDSCAPING LLC INV 1042", amount: 4850.0, days: 1, cat: [/service/i, /sales|revenue|income/i], type: "income", ai: 0.91, reason: "Matches open invoice #1042 for $4,850.", contact: "Acme Landscaping LLC" },
  { key: "fuel", merchant: "Shell", description: "SHELL OIL 57444 RENO NV", amount: -86.4, days: 4, cat: [/fuel|gas\b|auto|vehicle|travel|transport/i], ai: 0.98, reason: "Fuel purchase at a gas station." },
  { key: "meal", merchant: "Panera Bread", description: "PANERA BREAD #2041", amount: -46.95, days: 5, cat: [/meals|entertainment/i], ai: 0.9, reason: "Restaurant — client lunch.", approved: true },
  { key: "software", merchant: "Adobe", description: "ADOBE *CREATIVE CLOUD RECURRING", amount: -59.99, days: 6, cat: [/software|subscription|dues/i, /office/i], ai: 0.99, reason: "Monthly software subscription.", approved: true },
  { key: "mystery", merchant: "", description: "POS PURCHASE 7731 ***4291", amount: -312.0, days: 7, cat: null },
  { key: "utility", merchant: "NV Energy", description: "NV ENERGY ONLINE PMT", amount: -214.6, days: 9, cat: [/utilit|electric|power/i], ai: 0.97, reason: "Electric utility bill — recurring.", approved: true },
  { key: "transfer", merchant: "", description: "ONLINE TRANSFER TO SAVINGS ...8812", amount: -2500.0, days: 10, cat: [/transfer|savings|clearing/i], type: "asset", ai: 0.88, reason: "Inter-account transfer." },
  { key: "bestbuy", merchant: "Best Buy", description: "BEST BUY #1123 RENO NV", amount: -899.0, days: 12, cat: [/equipment|tools|computer/i, /supplies/i], ai: 0.81, reason: "Laptop — could be equipment or supplies.", flagged: true },
];

export function buildSampleTxns(accts = [], companyId = "sample") {
  const uncat = accts.find((a) => /uncategorized expense/i.test(a.name || "")) || null;
  return ROWS.map((r, i) => {
    const acct = r.cat ? pick(accts, r.cat, r.type || "expense") : uncat;
    return {
      id: `sample-${r.key}`,
      company_id: companyId,
      date: daysAgo(r.days),
      merchant: r.merchant,
      description: r.description,
      contact_name: r.contact || r.merchant || null,
      contact_id: r.contact ? `sample-contact-${r.contact.replace(/\W+/g, "-").toLowerCase()}` : null,
      amount: r.amount,
      category_account_id: acct?.id || null,
      category_account_name: acct?.name || null,
      category_account_code: acct?.code || null,
      ai_source: r.ai ? "ai" : null,
      ai_confidence: r.ai || null,
      ai_reasoning: r.reason || null,
      needs_review: !!r.flagged,
      human_reviewed: !!r.approved,
      posted: !!r.approved,
      matched_receipt_id: r.receipt ? "sample-receipt" : null,
      receipt_match_status: r.receipt ? "verified" : null,
      splits: [],
      source: "sample",
      _sampleOrder: i,
    };
  });
}

export const SAMPLE_INVOICES = [
  { id: "sample-inv-1042", number: "INV-1042", contact_id: "sample-contact-acme-landscaping-llc", contact_name: "Acme Landscaping LLC", issue_date: daysAgo(14), total: 4850.0, balance_due: 4850.0, status: "sent" },
  { id: "sample-inv-1039", number: "INV-1039", contact_id: "sample-contact-acme-landscaping-llc", contact_name: "Acme Landscaping LLC", issue_date: daysAgo(30), total: 1200.0, balance_due: 1200.0, status: "sent" },
  { id: "sample-inv-1041", number: "INV-1041", contact_id: "sample-contact-riverside-hoa", contact_name: "Riverside HOA", issue_date: daysAgo(18), total: 2300.0, balance_due: 2300.0, status: "sent" },
];

export const SAMPLE_BILLS = [
  { id: "sample-bill-7781", number: "7781", contact_id: "sample-contact-phoenix-business", contact_name: "Phoenix Business", issue_date: daysAgo(6), total: 1200.0, balance_due: 1200.0, status: "open" },
  { id: "sample-bill-7764", number: "7764", contact_id: "sample-contact-phoenix-business", contact_name: "Phoenix Business", issue_date: daysAgo(27), total: 950.0, balance_due: 950.0, status: "open" },
  { id: "sample-bill-2210", number: "2210", contact_id: "sample-contact-sierra-supply", contact_name: "Sierra Supply Co", issue_date: daysAgo(9), total: 640.0, balance_due: 640.0, status: "open" },
];

export function filterSample(rows, filter) {
  if (filter === "unapproved") return rows.filter((t) => !t.human_reviewed);
  if (filter === "reviewed") return rows.filter((t) => t.human_reviewed);
  if (filter === "review") return rows.filter((t) => t.needs_review);
  if (filter === "ai") return rows.filter((t) => t.ai_source && !t.human_reviewed);
  if (filter === "uncategorized") return rows.filter((t) => !t.category_account_id || /uncategorized/i.test(t.category_account_name || ""));
  if (filter === "receipt_verify") return rows.filter((t) => t.receipt_match_status === "suggested");
  return rows;
}

export function sampleProgress(rows) {
  const total = rows.length;
  const reviewed = rows.filter((t) => t.human_reviewed).length;
  const uncategorized = rows.filter((t) => !t.category_account_id || /uncategorized/i.test(t.category_account_name || "")).length;
  const ai_categorized = rows.filter((t) => t.ai_source && !t.human_reviewed).length;
  const flagged = rows.filter((t) => t.needs_review).length;
  return { total, reviewed, uncategorized, ai_categorized, flagged, pct_reviewed: total ? Math.round((1000 * reviewed) / total) / 10 : 0 };
}
