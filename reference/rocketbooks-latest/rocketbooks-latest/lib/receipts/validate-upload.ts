import 'server-only';

const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALLOWED_EXT = /\.(pdf|jpg|jpeg|png)$/i;
const MAX_BYTES = 10 * 1024 * 1024;

export interface UploadValidationError {
  status: 400;
  message: string;
}

/**
 * Validates a receipt upload before sending it to Veryfi. Reject obvious junk
 * (empty, oversized, wrong type) here so we don't burn paid OCR credits and
 * don't echo upstream Veryfi error JSON back to the client.
 */
export function validateReceiptFile(file: unknown): { ok: true; file: File } | UploadValidationError {
  if (!(file instanceof File)) return { status: 400, message: 'No file uploaded' };
  if (file.size === 0) return { status: 400, message: 'Empty file' };
  if (file.size > MAX_BYTES) return { status: 400, message: 'File too large (max 10 MB)' };

  // Browsers send file.type for known types but it's empty for some scanners.
  // We accept either a known MIME type OR a known extension (or both).
  const hasGoodMime = file.type && ALLOWED_MIME.has(file.type);
  const hasGoodExt = ALLOWED_EXT.test(file.name);
  if (!hasGoodMime && !hasGoodExt) {
    return { status: 400, message: 'Unsupported file type. Upload a PDF, JPG, or PNG.' };
  }
  return { ok: true, file };
}
