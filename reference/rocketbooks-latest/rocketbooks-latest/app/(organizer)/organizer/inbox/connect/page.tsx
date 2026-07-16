import { ConnectView } from '@/app/(app)/inbox/_components/ConnectView';

export const dynamic = 'force-dynamic';

export default function OrganizerConnectAccountPage() {
	return <ConnectView basePath="/organizer/inbox" />;
}
