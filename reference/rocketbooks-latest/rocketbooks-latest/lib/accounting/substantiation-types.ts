/**
 * IRS substantiation document types + the exact fields each requires, sourced
 * from irs.gov (Pub 463 / §274(d) and Pub 526 / §170). PURE module (no db /
 * server-only) so detection, the client email, the reply extractor, and the UI
 * all share one definition.
 *
 * Each field is either AUTO (already known from the transaction — amount, date,
 * merchant — so we prefill it and never ask the client) or an ASK field. ASK
 * fields can be optional. The email only requests ASK fields.
 */

export type DocType = 'meal' | 'travel' | 'lodging' | 'gift' | 'vehicle' | 'charitable';

export interface DocField {
  key: string;
  label: string;
  /** Prefilled from the transaction — not asked of the client. */
  autoFrom?: 'amount' | 'date' | 'merchant';
  /** Asked, but not strictly required (labeled "(optional)"). */
  optional?: boolean;
}

export interface DocSpec {
  type: DocType;
  label: string;
  authority: string;
  fields: DocField[];
  /** Lowercase keywords matched against the category name to detect the type. */
  keywords: string[];
}

export const DOC_SPECS: DocSpec[] = [
  {
    type: 'charitable',
    label: 'Charitable contribution',
    authority: 'Pub 526; §170(f)(8)',
    fields: [
      { key: 'amount', label: 'Amount', autoFrom: 'amount' },
      { key: 'donee', label: 'Charity (donee) name', autoFrom: 'merchant' },
      { key: 'goods_services_received', label: 'Did you receive anything in return?' },
      { key: 'good_faith_estimate', label: 'Estimated value of what you received', optional: true },
    ],
    keywords: ['charit', 'donation', 'donate', 'contribution', 'foundation', 'nonprofit'],
  },
  {
    type: 'gift',
    label: 'Business gift',
    authority: 'Pub 463; §274(d)(3)',
    fields: [
      { key: 'amount', label: 'Amount', autoFrom: 'amount' },
      { key: 'date', label: 'Date', autoFrom: 'date' },
      { key: 'gift_description', label: 'Description of the gift' },
      { key: 'business_purpose', label: 'Business purpose' },
      { key: 'recipient', label: 'Recipient + their business relationship to you' },
    ],
    keywords: ['gift'],
  },
  {
    type: 'lodging',
    label: 'Lodging',
    authority: 'Pub 463; Reg. §1.274-5(c)(2)',
    fields: [
      { key: 'amount', label: 'Amount', autoFrom: 'amount' },
      { key: 'date', label: 'Date', autoFrom: 'date' },
      { key: 'establishment_name', label: 'Hotel', autoFrom: 'merchant' },
      { key: 'dates_of_stay', label: 'Dates of stay' },
      { key: 'city', label: 'City', optional: true },
      { key: 'business_purpose', label: 'Business purpose' },
    ],
    keywords: ['lodging', 'hotel', 'motel', ' inn', 'resort', 'airbnb', 'marriott', 'hilton', 'hyatt'],
  },
  {
    type: 'travel',
    label: 'Travel (away from home)',
    authority: 'Pub 463; §274(d)(1)',
    fields: [
      { key: 'amount', label: 'Amount', autoFrom: 'amount' },
      { key: 'date', label: 'Date', autoFrom: 'date' },
      { key: 'destination', label: 'Destination (city/area)' },
      { key: 'trip_dates', label: 'Departure & return dates + how many business days' },
      { key: 'business_purpose', label: 'Business purpose' },
      { key: 'other_expenses', label: 'Other trip expenses (lodging/meals/transport)', optional: true },
    ],
    keywords: ['travel', 'airfare', 'airline', 'flight', 'delta', 'united', 'southwest', 'american air', 'car rental', 'rental car', 'amtrak'],
  },
  {
    type: 'vehicle',
    label: 'Vehicle / mileage',
    authority: 'Pub 463; §274(d)(4), §280F',
    fields: [
      { key: 'date', label: 'Date', autoFrom: 'date' },
      { key: 'miles', label: 'Business miles for the trip' },
      { key: 'destination', label: 'Destination' },
      { key: 'business_purpose', label: 'Business purpose' },
    ],
    keywords: ['mileage', 'vehicle', 'auto', 'fuel', 'gas station', 'chevron', 'shell', 'exxon', 'gasoline'],
  },
  {
    type: 'meal',
    label: 'Business meal',
    authority: 'Pub 463 (Table 5-1); §274(d)(1), Reg. §1.274-5',
    fields: [
      { key: 'amount', label: 'Amount', autoFrom: 'amount' },
      { key: 'date', label: 'Date', autoFrom: 'date' },
      { key: 'establishment_name', label: 'Restaurant', autoFrom: 'merchant' },
      { key: 'establishment_address', label: 'Restaurant address', optional: true },
      { key: 'business_purpose', label: 'Business purpose / what was discussed' },
      { key: 'attendees', label: 'Who attended + their business relationship to you' },
    ],
    keywords: ['meal', 'restaurant', 'dining', 'cafe', 'coffee', 'starbucks', 'grubhub', 'doordash', 'uber eats', 'chipotle', 'entertainment'],
  },
];

const BY_TYPE: Record<DocType, DocSpec> = Object.fromEntries(DOC_SPECS.map((s) => [s.type, s])) as Record<DocType, DocSpec>;

export function specFor(type: DocType): DocSpec {
  return BY_TYPE[type];
}

/** Detect the substantiation doc type from a transaction's category name. */
export function detectDocType(text: string | null | undefined): DocType | null {
  const s = ` ${(text ?? '').toLowerCase()} `;
  for (const spec of DOC_SPECS) {
    if (spec.keywords.some((k) => s.includes(k))) return spec.type;
  }
  return null;
}

/** Fields we still need from the client (everything not auto-known). */
export function askFields(spec: DocSpec): DocField[] {
  return spec.fields.filter((f) => !f.autoFrom);
}

/** Comma-joined human list of what to ask for, marking optional fields. */
export function askText(spec: DocSpec): string {
  return askFields(spec)
    .map((f) => (f.optional ? `${f.label} (optional)` : f.label))
    .join(', ');
}

/** Prefill the auto-known fields from the transaction (amount/date/merchant). */
export function autoFieldValues(
  spec: DocSpec,
  txn: { amount?: number | null; date?: string | null; merchant?: string | null },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    if (f.autoFrom === 'amount' && txn.amount != null) out[f.key] = '$' + Math.abs(txn.amount).toFixed(2);
    else if (f.autoFrom === 'date' && txn.date) out[f.key] = txn.date;
    else if (f.autoFrom === 'merchant' && txn.merchant) out[f.key] = txn.merchant;
  }
  return out;
}
