import 'server-only';
import type { z } from 'zod';
import type { ReactElement } from 'react';
import type { DocumentProps } from '@react-pdf/renderer';

/**
 * Signer captured on a generated resolution. Stored on
 * `document_records.signers` (jsonb array). The typed-name + IP +
 * timestamp triple is the Phase 1 substitute for real e-signature
 * — sufficient to demonstrate intent for most state e-signature acts
 * (UETA / federal E-SIGN) when paired with the audit trail in
 * document_audit_events. Phase 3 swaps this for DocuSign / Dropbox
 * Sign / etc.
 */
export interface Signer {
	/** UUID assigned at draft time. Becomes the signer ref in audit
	 *  events ("signer_X signed", "signer_X declined"). */
	id: string;
	/** Display label on the signature block ("Trustee", "Grantor",
	 *  "Beneficiary"). */
	role: string;
	/** Pulled from the trust metadata / contacts at draft time;
	 *  pre-fills the signing form. */
	expectedName: string | null;
	/** Captured at sign time. Null while pending. */
	signedName: string | null;
	signedAt: string | null;
	signedIp: string | null;
}

/**
 * A renderable resolution template. Each template module exports one
 * `TemplateDefinition` registered in `registry.ts`. The variable
 * schema (`zod`) is the contract — draft-time validation, runtime
 * serialization, and the eventual template-editor UI all use it.
 */
export interface TemplateDefinition<TVars extends Record<string, unknown> = Record<string, unknown>> {
	/** Stable id, used as `document_records.template_id`. */
	id: string;
	/** Bump on backward-incompatible field changes. Stored on the
	 *  record so a re-render with newer code knows whether it can
	 *  reuse the existing variables. */
	version: string;
	/** Human-facing name; what users see in pickers. */
	label: string;
	/** One-line description for the picker tooltip. */
	description: string;
	/** Category drives grouping on `/trust-documents`. */
	category: TemplateCategory;
	/** Schema for the variables this template needs. Parsed at draft
	 *  time so we fail fast on bad inputs. */
	variablesSchema: z.ZodType<TVars>;
	/** The required signers' roles at draft time. The system creates
	 *  a Signer entry for each, pre-populated with the best guess
	 *  for expectedName (e.g., trustee contacts of the org). */
	requiredSignerRoles: SignerRoleSeed[];
	/** Resolves to whether the active trust has enough metadata to
	 *  render this template. When false, the UI lazy-prompts before
	 *  drafting. */
	requiresState?: boolean;
	/** Render the PDF body. Receives parsed + validated variables.
	 *  Must return a @react-pdf/renderer Document element so the
	 *  shared renderToBuffer pipeline can serialize it. */
	renderPdf: (args: RenderArgs<TVars>) => ReactElement<DocumentProps>;
	/** Optional declarative form description. When set, the new /
	 *  edit pages render a generic form derived from this list
	 *  instead of a hand-written one. Field order in the array is
	 *  the visual order in the rendered form. Leave undefined for
	 *  templates whose forms are too custom for the generator
	 *  (tables, picker integrations, server-driven UX). */
	formFields?: readonly TemplateField[];
	/** Optional note shown above the generated form (e.g., "this
	 *  template is normally auto-paired with X"). */
	formIntro?: string;
}

/**
 * Single-field descriptor consumed by GenericTemplateForm. Maps a
 * top-level variables key to a rendered input. The form layer never
 * second-guesses the zod schema for validation — submit still goes
 * through draftResolution which re-parses against the same schema.
 * This metadata is for layout + widget choice only.
 */
export interface TemplateField {
	/** Variable name on the template's variablesSchema. */
	name: string;
	/** UPPERCASE label shown above the input. */
	label: string;
	/** Input widget kind. */
	widget: TemplateFieldWidget;
	/** Optional placeholder / helper text inside the input. */
	placeholder?: string;
	/** Defaults to true unless explicitly set false. The asterisk
	 *  next to the label and the required attribute on the input both
	 *  flip on this. */
	required?: boolean;
	/** Grid column span on the md+ breakpoint. Default 1 (half row);
	 *  set 2 for full-width. */
	span?: 1 | 2;
	/** For textarea — number of visible rows. Default 3. */
	rows?: number;
	/** For select widget — the option list. */
	options?: ReadonlyArray<{ value: string; label: string }>;
	/** For 'dollars' widget — the underlying field stores cents and
	 *  the form converts ($ ↔ cents) automatically. */
	cents?: boolean;
	/** For 'dollars' widget — allow negatives. Default false (min=0
	 *  on the input). Set true for fields like gain/loss where the
	 *  sign carries meaning. */
	signed?: boolean;
	/** When set, the field shows / hides based on another field's
	 *  value. Two forms:
	 *    - `{ field, in }` — visible when value is in the list
	 *    - `{ field, gt }` — visible when numeric value > threshold
	 *      (useful for "only show lender when financed > $0"). */
	visibleWhen?:
		| { field: string; in: readonly string[] }
		| { field: string; gt: number };
}

export type TemplateFieldWidget =
	| 'text'
	| 'textarea'
	| 'date'
	| 'integer'
	| 'dollars'
	| 'select';

export type TemplateCategory =
	| 'foundational'        // trust instrument, EIN — mostly upload-only
	| 'corpus'              // bill of sale, schedule A, declaration of extraordinary dividend
	| 'operating'           // distributions, asset acquisitions, advances, etc.
	| 'annual'              // beneficiary accounting, K-1 packet
	| 'governance';         // trustee acceptance/resignation, co-trustee actions

/**
 * Seed used at draft time to materialize Signers on the record. The
 * `resolveExpectedName` callback runs with the trust + variables
 * available so it can return e.g., the trustee contact's name from
 * the contacts table for role='trustee'.
 */
export interface SignerRoleSeed {
	role: string;
	/** Templates that need multiple of the same role (e.g., co-trustees)
	 *  set min/max. Default 1/1. */
	min?: number;
	max?: number;
}

/** Everything a template's renderPdf receives. Kept separate from the
 *  variables themselves so we can layer in trust metadata + signers
 *  without polluting the per-template schemas. */
export interface RenderArgs<TVars> {
	variables: TVars;
	trust: TrustHeader;
	signers: Signer[];
	/** ISO date — when the document was drafted. */
	draftedAt: string;
}

/**
 * Trust-level header data passed to every template so signature
 * blocks, governing-law clauses, and headers can render. Populated
 * from `trust_metadata` + the organization row at draft time.
 */
export interface TrustHeader {
	organizationId: string;
	trustName: string | null;
	effectiveDate: string | null;
	governingState: string | null;
	situsState: string | null;
	ein: string | null;
	grantorName: string | null;
	defaultSigningAuthority: 'sole' | 'majority' | 'unanimous' | null;
}
