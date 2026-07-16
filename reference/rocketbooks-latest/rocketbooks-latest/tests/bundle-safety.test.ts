import assert from 'node:assert/strict';

const routeModules = [
  '../app/api/qbo/sync/route.ts',
  '../app/api/qbo/promote/route.ts',
  '../app/api/pdf/generate/route.ts',
  '../app/api/pdf/status/[jobId]/route.ts',
];

const clientBoundaryModules = [
  '../app/(app)/inbox/_components/MessageDetailView.tsx',
  '../app/(super-admin)/super-admin/communications/_components/EmailComposeForm.tsx',
  '../components/video/GuestJoin.tsx',
  '../components/video/VideoRoomLauncher.tsx',
];

const forbidden = [
  '@react-pdf/renderer',
  'pdf-lib',
  'jspdf',
  'pdfjs-dist',
  '@/lib/qbo/client',
  '@/lib/qbo/promote/promoter',
  '@/lib/signatures/render-pdf',
  '@/lib/storage/signatures',
];

async function readSource(modulePath: string) {
  return import('node:fs/promises').then((fs) => fs.readFile(new URL(modulePath, import.meta.url), 'utf8'));
}

async function main() {
  for (const modulePath of routeModules) {
    const source = await readSource(modulePath);
    for (const token of forbidden) {
      assert(!source.includes(`from '${token}'`), `${modulePath} statically imports heavy module ${token}`);
      assert(!source.includes(`from "${token}"`), `${modulePath} statically imports heavy module ${token}`);
    }
  }

  const [messageDetail, emailCompose, guestJoin, videoLauncher] = await Promise.all(
    clientBoundaryModules.map(readSource),
  );
  assert(!messageDetail.includes("from './ReplyComposer'"), 'MessageDetailView must not statically import the Tiptap reply editor');
  assert(emailCompose.includes("dynamic("), 'EmailComposeForm should dynamically load the Tiptap body editor');
  assert(!emailCompose.includes("from './EmailBodyEditor'"), 'EmailComposeForm must not statically import the Tiptap body editor');
  assert(guestJoin.includes('ssr: false'), 'GuestJoin should skip SSR for the Daily video frame');
  assert(videoLauncher.includes('ssr: false'), 'VideoRoomLauncher should skip SSR for the Daily video frame');

  console.log(
    `bundle-safety: ${routeModules.length} route shims avoid ${forbidden.length} heavy imports; ${clientBoundaryModules.length} heavy client boundaries are dynamic`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
