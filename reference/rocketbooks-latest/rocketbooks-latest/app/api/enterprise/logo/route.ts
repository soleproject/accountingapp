import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/svg+xml'];
const MAX_BYTES = 1 * 1024 * 1024;

// Logo variant slots → organizations column (mirrors /api/org/logo).
const SLOT_COLUMN = {
  light: 'logoUrl',
  dark: 'logoUrlDark',
  icon: 'logoIconUrl',
  iconDark: 'logoIconDarkUrl',
} as const;
type Slot = keyof typeof SLOT_COLUMN;

function slotColumn(req: NextRequest): (typeof SLOT_COLUMN)[Slot] {
  const s = new URL(req.url).searchParams.get('slot') as Slot | null;
  return s && s in SLOT_COLUMN ? SLOT_COLUMN[s] : SLOT_COLUMN.light;
}

async function resolveEnterpriseId(req: NextRequest): Promise<string | null> {
  const url = new URL(req.url);
  const requested = url.searchParams.get('enterpriseId');
  const accessible = await listAccessibleEnterprises();
  if (requested) {
    return accessible.find((e) => e.id === requested)?.id ?? null;
  }
  return accessible[0]?.id ?? null;
}

export async function POST(req: NextRequest) {
  await requireSession();
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) {
    return NextResponse.json({ error: 'No accessible enterprise' }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: 'Unsupported file type. Use PNG, JPG, WEBP, or SVG.' },
      { status: 415 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File is too large. Max ${MAX_BYTES / 1024 / 1024}MB.` },
      { status: 413 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${buffer.toString('base64')}`;

  await db
    .update(organizations)
    .set({ [slotColumn(req)]: dataUrl })
    .where(eq(organizations.id, enterpriseId));

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  await requireSession();
  const enterpriseId = await resolveEnterpriseId(req);
  if (!enterpriseId) {
    return NextResponse.json({ error: 'No accessible enterprise' }, { status: 403 });
  }
  await db
    .update(organizations)
    .set({ [slotColumn(req)]: null })
    .where(eq(organizations.id, enterpriseId));
  return NextResponse.json({ ok: true });
}
