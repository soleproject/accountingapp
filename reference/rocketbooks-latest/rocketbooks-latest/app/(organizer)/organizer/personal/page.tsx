import { redirect } from 'next/navigation';

// Personal is now its own top-level product (the (personal) route group),
// reachable from the workspace/product switcher. This legacy organizer route
// forwards there so any saved links keep working.
export default function OrganizerPersonalRedirect() {
  redirect('/personal');
}
