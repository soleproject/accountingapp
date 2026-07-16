import { MessageDetailView } from '@/app/(app)/inbox/_components/MessageDetailView';

export const dynamic = 'force-dynamic';

interface Params {
	id: string;
}

export default async function OrganizerInboxMessagePage({ params }: { params: Promise<Params> }) {
	const { id } = await params;
	return <MessageDetailView basePath="/organizer/inbox" messageId={id} />;
}
