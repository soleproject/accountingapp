import { NextResponse } from 'next/server';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace';

export const runtime = 'nodejs';

export async function GET() {
  const workspaces = await listAccessibleWorkspaces();
  return NextResponse.json({ workspaces });
}
