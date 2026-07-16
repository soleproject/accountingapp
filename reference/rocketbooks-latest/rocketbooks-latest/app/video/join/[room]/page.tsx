import { videoProvider } from '@/lib/video';
import { GuestJoin } from '@/components/video/GuestJoin';

// Public guest-join landing for a video call invite link. Lives outside the
// (organizer)/(app) auth groups so people WITHOUT a RocketSuite account can
// reach it (mirrors the public /book/[slug] booking page). No app chrome.
export const dynamic = 'force-dynamic';

export default async function VideoJoinPage({ params }: { params: Promise<{ room: string }> }) {
  const { room } = await params;

  const configured = videoProvider.isConfigured();
  // Validate the room server-side so an expired/bad link shows a clean message
  // instead of failing after the guest types their name.
  let exists = false;
  if (configured) {
    try {
      exists = (await videoProvider.getRoom(room)) !== null;
    } catch {
      exists = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-12">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Join the video call</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          You don’t need an account — just enter a name and join.
        </p>
      </header>

      {!configured ? (
        <p className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          Video calling isn’t available right now. Please ask the host to try again.
        </p>
      ) : !exists ? (
        <p className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
          This call link is invalid or has expired. Ask the host for a new link.
        </p>
      ) : (
        <GuestJoin roomName={room} />
      )}
    </main>
  );
}
