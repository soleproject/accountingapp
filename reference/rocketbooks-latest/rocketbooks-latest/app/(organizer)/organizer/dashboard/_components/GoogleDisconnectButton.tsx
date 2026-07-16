'use client';

interface Props {
  accountEmail: string;
}

/**
 * Inline "disconnect" affordance next to the "Google · <email>" label.
 * Posts to /api/oauth/google/disconnect, which revokes at Google
 * (best-effort) and deletes the oauth_connections row. Endpoint
 * redirects back to /organizer/dashboard?google=disconnected on
 * success, so we just submit the form and let Next handle the
 * navigation.
 *
 * Browser confirm is intentional — disconnecting clears stored
 * tokens; reconnecting requires another consent-screen round-trip.
 */
export function GoogleDisconnectButton({ accountEmail }: Props) {
  return (
    <form
      action="/api/oauth/google/disconnect"
      method="post"
      className="inline"
      onSubmit={(e) => {
        if (!window.confirm(`Disconnect Google Calendar (${accountEmail})?\n\nYour Organizer calendar will stop syncing. You can reconnect at any time.`)) {
          e.preventDefault();
        }
      }}
    >
      <button
        type="submit"
        className="text-[10px] text-zinc-500 underline-offset-2 hover:text-rose-600 hover:underline dark:text-zinc-500 dark:hover:text-rose-400"
        title="Disconnect this Google account"
      >
        disconnect
      </button>
    </form>
  );
}
