/**
 * Demo-org plumbing. A user who has no real organization assignments gets
 * routed into the shared demo org so the app has something to render. Demo
 * mode is read-only: every mutation in the app must call assertNotDemo to
 * keep one demo user's writes from being visible to every other demo user.
 *
 * The demo org is owned by a fixed system user. Both IDs are pinned to
 * deterministic UUIDs so we can detect demo state with a constant check.
 */

export const DEMO_ORG_ID = '00000000-0000-4000-8000-000000000000';
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_SYSTEM_EMAIL = 'demo-system@rocketsuite.local';

export function isDemoOrg(orgId: string | null | undefined): boolean {
  return orgId === DEMO_ORG_ID;
}

export class DemoModeError extends Error {
  readonly code = 'demo_mode';
  constructor(message?: string) {
    super(message ?? "This action isn't available in the demo. Create a workspace to use your own data.");
  }
}

/**
 * Throw if the given org is the demo. Call at the top of every server action
 * that performs a write. Keep the wording polite — the message surfaces to
 * the user via the action's thrown error.
 */
export function assertNotDemo(orgId: string | null | undefined, action?: string): void {
  if (isDemoOrg(orgId)) {
    throw new DemoModeError(
      action
        ? `Can't ${action} in the demo workspace. Create your own workspace from /businesses to enable this.`
        : undefined,
    );
  }
}
