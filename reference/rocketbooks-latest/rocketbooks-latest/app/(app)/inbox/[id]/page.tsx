import { MessageDetailView } from '../_components/MessageDetailView';

export const dynamic = 'force-dynamic';

interface Params {
	id: string;
}

export default async function InboxMessagePage({ params }: { params: Promise<Params> }) {
	const { id } = await params;
	return <MessageDetailView basePath="/inbox" messageId={id} />;
}
