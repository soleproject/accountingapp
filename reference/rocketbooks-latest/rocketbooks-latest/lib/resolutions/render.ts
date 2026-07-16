import 'server-only';
import type { Signer, TrustHeader } from './types';

export interface RenderResolutionArgs {
	templateId: string;
	variables: Record<string, unknown>;
	trust: TrustHeader;
	signers: Signer[];
	draftedAt: string;
}

export async function renderResolutionPdf(_args: RenderResolutionArgs): Promise<Uint8Array> {
	throw new Error('Trust-document PDF rendering is temporarily disabled on Cloudflare staging.');
}
