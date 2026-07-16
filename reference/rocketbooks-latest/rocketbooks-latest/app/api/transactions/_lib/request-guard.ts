export type MutationRequestRejection = { status: 403 | 415; error: string };

export function validateJsonSameOrigin(request: Request): MutationRequestRejection | null {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { status: 415, error: 'Content-Type must be application/json.' };
  }

  const origin = request.headers.get('origin');
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host'))?.split(',', 1)[0].trim();
  let originHost: string | null = null;
  try {
    originHost = origin ? new URL(origin).host : null;
  } catch {
    originHost = null;
  }
  if (!originHost || !host || originHost !== host) {
    return { status: 403, error: 'Cross-origin request rejected.' };
  }
  return null;
}
