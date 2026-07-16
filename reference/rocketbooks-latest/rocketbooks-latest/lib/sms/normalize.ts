// E.164 phone normalization shared across the SMS surfaces.
export const E164_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Loosely normalize what was typed (or pulled from a contact field)
 * into E.164. Accepts "(555) 123-4567", "555-123-4567", "5551234567",
 * "+1 555 123 4567" and defaults to US (+1) when no country code is
 * present. Anything ambiguous is returned as-is so E164_RE rejects it.
 */
export function normalizePhone(input: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');
	const digits = trimmed.replace(/\D/g, '');
	if (digits.length === 10) return '+1' + digits;
	if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
	return trimmed;
}
