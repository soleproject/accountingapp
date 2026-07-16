import { InboxView } from '@/app/(app)/inbox/_components/InboxView';

export const dynamic = 'force-dynamic';

export default function OrganizerInboxPage() {
	return <InboxView basePath="/organizer/inbox" />;
}
