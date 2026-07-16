import 'server-only';
import type { TemplateDefinition } from './types';

const TEMPLATES: readonly TemplateDefinition[] = [] as const;

export function getTemplate(_id: string): TemplateDefinition | null {
	return null;
}

export function listTemplates(): readonly TemplateDefinition[] {
	return TEMPLATES;
}
