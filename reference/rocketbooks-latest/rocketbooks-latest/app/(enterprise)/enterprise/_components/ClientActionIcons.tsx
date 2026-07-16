import Link from 'next/link';
import { openClientBooksAction } from '../_actions/openBooks';
import {
  deactivateEnterpriseClientAction,
  reactivateEnterpriseClientAction,
} from '../_actions/clients';
import { resendClientInviteAction } from '../_actions/resendInvite';

interface Props {
  userId: string;
  /** The specific company to open (Client Businesses rows pass it). When set, the
   *  open-books / onboarding buttons open THIS company instead of the owner's
   *  primary — so an owner with several businesses opens the right one. */
  orgId?: string;
  /** Used in titles + aria-labels: "Impersonate {label}". Falls back to email. */
  userLabel: string;
  isActive: boolean;
  /** Disable Impersonate for super admins, matching the detail-page guard. */
  isSuper: boolean;
  /** Client has never signed in, so they still need a way in — show the
   *  invite CTA. Covers email invites (invited_at set), branded generateLink
   *  invites (no invited_at), and password-created clients who never used it.
   *  Shown alongside "Complete Onboarding", not in place of it. */
  invitePending?: boolean;
  /** Whether this client was ever emailed an invite. Only controls the CTA
   *  label: "Resend Invite" if they were, "Send Invite" if not. */
  everInvited?: boolean;
  /**
   * When true, render a "Complete Onboarding" CTA to the left of the
   * impersonate icon. Clicking it impersonates the target user and lands
   * the admin on /ai-chat where the welcome card auto-shows for unfinished
   * orgs. Hidden for super admins (impersonation blocked) and for clients
   * whose org has already completed onboarding.
   */
  onboardingIncomplete?: boolean;
  /** Override the edit-pencil target + label. Defaults to the owner-user edit
   *  (`/enterprise/clients/{userId}/edit`). The Client Businesses table passes a
   *  business-edit href so the pencil edits the company, not the owner. */
  editHref?: string;
  editLabel?: string;
}

/**
 * Compact icon-only row of the three client-detail actions (Impersonate,
 * Edit, Disable/Enable), with an optional "Complete Onboarding" CTA in
 * front when the client still has an unfinished business onboarding.
 * Used on both the Clients list and the Enterprise Dashboard's Client
 * Businesses table so the affordances are consistent and the underlying
 * server actions stay in one place.
 */
export function ClientActionIcons({ userId, orgId, userLabel, isActive, isSuper, onboardingIncomplete, invitePending, everInvited, editHref, editLabel }: Props) {
  const baseIconBtn =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border text-sm transition-colors';

  // A never-signed-in client can show BOTH: "Send/Resend Invite" (let them in
  // themselves) and "Complete Onboarding" (firm impersonates and does it for
  // them). They're complementary, not mutually exclusive.
  const inviteLabel = everInvited ? 'Resend Invite' : 'Send Invite';
  return (
    <div className="flex items-center justify-end gap-1.5">
      {invitePending && (
        <form action={resendClientInviteAction} className="inline">
          <input type="hidden" name="userId" value={userId} />
          <button
            type="submit"
            title={`${inviteLabel === 'Send Invite' ? 'Send an invite to' : 'Resend invite to'} ${userLabel}`}
            aria-label={`${inviteLabel} for ${userLabel}`}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-blue-600 px-2.5 text-xs font-medium text-white shadow-sm hover:bg-blue-700"
          >
            {inviteLabel}
          </button>
        </form>
      )}
      {onboardingIncomplete && !isSuper && (
        <form action={openClientBooksAction} className="inline">
          <input type="hidden" name="targetUserId" value={userId} />
          {orgId && <input type="hidden" name="orgId" value={orgId} />}
          <input type="hidden" name="next" value="/ai-chat?onboarding=start" />
          <button
            type="submit"
            title={`Walk ${userLabel} through onboarding`}
            aria-label={`Complete onboarding for ${userLabel}`}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-violet-600 px-2.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700"
          >
            Complete Onboarding
          </button>
        </form>
      )}
      {isSuper ? (
        <button
          type="button"
          disabled
          title="Can't impersonate a super admin"
          aria-label="Impersonate (disabled)"
          className={`${baseIconBtn} border-blue-300 bg-blue-100 text-blue-400 opacity-60 dark:border-blue-900 dark:bg-blue-950/40`}
        >
          <ImpersonateIcon />
        </button>
      ) : (
        <form action={openClientBooksAction} className="inline">
          <input type="hidden" name="targetUserId" value={userId} />
          {orgId && <input type="hidden" name="orgId" value={orgId} />}
          <button
            type="submit"
            title={`Open ${userLabel}'s books`}
            aria-label={`Open ${userLabel}'s books`}
            className={`${baseIconBtn} border-blue-600 bg-blue-600 text-white hover:bg-blue-700`}
          >
            <ImpersonateIcon />
          </button>
        </form>
      )}

      <Link
        href={editHref ?? `/enterprise/clients/${userId}/edit`}
        title={`Edit ${editLabel ?? userLabel}`}
        aria-label={`Edit ${editLabel ?? userLabel}`}
        className={`${baseIconBtn} border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900`}
      >
        <EditIcon />
      </Link>

      <form action={isActive ? deactivateEnterpriseClientAction : reactivateEnterpriseClientAction} className="inline">
        <input type="hidden" name="userId" value={userId} />
        <button
          type="submit"
          title={isActive ? `Disable ${userLabel}` : `Enable ${userLabel}`}
          aria-label={isActive ? `Disable ${userLabel}` : `Enable ${userLabel}`}
          className={`${baseIconBtn} ${
            isActive
              ? 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/40'
              : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950/40'
          }`}
        >
          <DisableIcon />
        </button>
      </form>
    </div>
  );
}

function ImpersonateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function DisableIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}
