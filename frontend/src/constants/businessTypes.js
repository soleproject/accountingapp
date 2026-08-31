// Canonical list of business-entity types. Used by every form that collects
// `business_type` (new-client modal, onboarding step, company settings, my-
// businesses, etc.) and by the AI intent parser when a user types/speaks
// their entity type in free-form ("we're a Sub-S", "single-member LLC",
// "sole prop"). Keep this file the single source of truth — the AI
// snap-to-canonical logic in `backend/ai_service.py` mirrors it.
export const BUSINESS_TYPES = [
  "Sole Proprietor",
  "LLC – Solo Proprietor",
  "LLC – Partnership",
  'LLC – "S" Elected',
  'LLC – "C" Elected',
  '"S" Corporation',
  '"C" Corporation',
  "Limited Partnership",
];
