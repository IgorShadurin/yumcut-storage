import { NextRequest } from 'next/server';
import { withApiError, forbidden, error, ok } from '@/lib/http';
import { persistDaemonUpload } from '@/server/storage';
import { verifySignedDaemonUploadGrant, assertDaemonUploadGrantFresh } from '@/lib/upload-signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { projectId: string };

type StorageAssetResponse =
  | { kind: 'audio'; path: string; url: string }
  | { kind: 'image'; path: string; url: string }
  | { kind: 'video'; path: string; url: string; isFinal: boolean };

async function readFileBuffer(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

export const POST = withApiError(async function POST(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { projectId } = await params;
  const formData = await req.formData();
  const typeValue = formData.get('type');
  const fileValue = formData.get('file');
  const isFinalRaw = formData.get('isFinal');
  const data = formData.get('data');
  const signature = formData.get('signature');

  if (typeof typeValue !== 'string') {
    return error('VALIDATION_ERROR', 'Missing type', 400);
  }
  const kind = typeValue as 'audio' | 'image' | 'video';
  if (!['audio', 'image', 'video'].includes(kind)) {
    return error('VALIDATION_ERROR', 'Unsupported asset type', 400);
  }
  if (!(fileValue instanceof File)) {
    return error('VALIDATION_ERROR', 'Missing file', 400);
  }
  if (typeof data !== 'string' || typeof signature !== 'string') {
    return forbidden('Missing daemon upload authorization');
  }

  let payload;
  try {
    payload = verifySignedDaemonUploadGrant(data, signature);
    assertDaemonUploadGrantFresh(payload);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : 'Invalid daemon upload authorization';
    return forbidden(message);
  }
  if (payload.projectId !== projectId) {
    return forbidden('Project mismatch in upload grant');
  }
  if (payload.kind !== kind) {
    return forbidden('Upload grant kind does not match payload');
  }

  const bytes = await readFileBuffer(fileValue);
  if (bytes.byteLength > payload.maxBytes) {
    return error('VALIDATION_ERROR', 'Payload too large for grant', 400);
  }
  const mime = fileValue.type || '';
  if (!payload.mimeTypes.includes(mime)) {
    return error('VALIDATION_ERROR', 'Mime type not allowed', 400);
  }

  const stored = await persistDaemonUpload(kind, bytes, fileValue.name);
  const isFinal = kind === 'video' ? isFinalRaw === 'true' || isFinalRaw === '1' : false;

  const response: StorageAssetResponse =
    kind === 'video'
      ? { kind, path: stored.relativePath, url: stored.publicUrl, isFinal }
      : { kind, path: stored.relativePath, url: stored.publicUrl };

  return ok(response);
}, 'Failed to store media in storage service');
