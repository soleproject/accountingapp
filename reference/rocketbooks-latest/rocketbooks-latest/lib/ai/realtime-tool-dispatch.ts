import 'server-only';

// Keep the public tool registry tiny. The heavy executor implementation pulls in
// Drizzle tables, accounting mutations, onboarding, invoice posting, and other
// worker-bound modules; import it only when a tool is actually executed instead
// of pinning that dependency graph into every AI route that only needs the name
// guard.
export const REALTIME_TOOL_NAMES = [
  'lookup_contact',
  'create_contact',
  'list_revenue_accounts',
  'list_accounts',
  'save_invoice_draft',
  'post_invoice',
  'cancel_invoice_draft',
  'query_transactions',
  'query_invoices',
  'query_bills',
  'get_onboarding_status',
  'set_business_info',
  'advance_onboarding',
] as const;

export type RealtimeToolName = (typeof REALTIME_TOOL_NAMES)[number];

export function isRealtimeToolName(name: string): name is RealtimeToolName {
  return (REALTIME_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeRealtimeTool(
  orgId: string,
  name: string,
  args: Record<string, unknown>,
  turnId?: string,
): Promise<unknown> {
  const { executeRealtimeTool: executeRealtimeToolImpl } = await import('./realtime-tool-dispatch-impl');
  return executeRealtimeToolImpl(orgId, name, args, turnId);
}
