import { NextRequest } from 'next/server';
import { withApiError, forbidden, error, ok } from '@/lib/http';
import { persistCharacterImage } from '@/server/storage';
import { verifySignedDaemonUploadGrant, assertDaemonUploadGrantFresh } from '@/lib/upload-signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withApiError(async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return error('VALIDATION_ERROR', 'Missing file', 400);
  }
  const data = formData.get('data');
  const signature = formData.get('signature');
  if (typeof data !== 'string' || typeof signature !== 'string') {
    return forbidden('Missing upload authorization');
  }

  let payload;
  try {
    payload = verifySignedDaemonUploadGrant(data, signature);
    assertDaemonUploadGrantFresh(payload);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : 'Invalid upload authorization';
    return forbidden(message);
  }

  if (!['image', 'character-image'].includes(payload.kind)) {
    return error('VALIDATION_ERROR', 'Unsupported daemon upload kind for characters', 400);
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || '';
  if (!payload.mimeTypes.includes(mime)) {
    return error('VALIDATION_ERROR', 'Mime type not allowed', 400);
  }
  if (buffer.byteLength > payload.maxBytes) {
    return error('VALIDATION_ERROR', 'Payload too large', 400);
  }

  const stored = await persistCharacterImage(buffer, file.name);
  return ok({ path: stored.relativePath, url: stored.url, projectId: payload.projectId });
}, 'Failed to persist character image');
