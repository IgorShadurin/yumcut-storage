import { NextRequest } from 'next/server';
import { ok, error, forbidden } from '@/lib/http';
import { verifySignedUploadGrant, assertUploadGrantFresh } from '@/lib/upload-signature';
import { persistCharacterImage } from '@/server/storage';
import { applyStorageCors, resolveStorageCorsOrigin, storageCorsPreflight } from '@/lib/storage-cors';

const MAX_DIMENSION = 2000;
const SAFE_IMAGE_EXTENSIONS_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS(req: NextRequest) {
  return storageCorsPreflight(req);
}

export async function POST(req: NextRequest) {
  const origin = resolveStorageCorsOrigin(req);
  if (!origin) {
    return forbidden('Origin not allowed');
  }
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return applyStorageCors(error('VALIDATION_ERROR', 'File is required', 400), origin);
    }
    const data = formData.get('data');
    const signature = formData.get('signature');
    if (typeof data !== 'string' || typeof signature !== 'string') {
      return applyStorageCors(forbidden('Missing upload authorization'), origin);
    }
    let payload;
    try {
      payload = verifySignedUploadGrant(data, signature);
      assertUploadGrantFresh(payload);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : 'Invalid upload authorization';
      return applyStorageCors(forbidden(message), origin);
    }
    if (payload.purpose !== 'user-character-image') {
      return applyStorageCors(forbidden('Upload authorization purpose mismatch'), origin);
    }

    const mime = file.type || '';
    const safeExtension = SAFE_IMAGE_EXTENSIONS_BY_MIME[mime];
    if (!safeExtension || !payload.mimeTypes.includes(mime)) {
      return applyStorageCors(error('VALIDATION_ERROR', 'Only allowed mime types can be uploaded', 400), origin);
    }
    if (file.size > payload.maxBytes) {
      return applyStorageCors(error('VALIDATION_ERROR', `File must be ${Math.floor(payload.maxBytes / 1024 / 1024)}MB or smaller`, 400), origin);
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    if (buffer.byteLength > payload.maxBytes) {
      return applyStorageCors(error('VALIDATION_ERROR', `File must be ${Math.floor(payload.maxBytes / 1024 / 1024)}MB or smaller`, 400), origin);
    }
    const { imageSize } = await import('image-size');
    const dimensions = imageSize(Buffer.from(buffer));
    const width = dimensions?.width ?? 0;
    const height = dimensions?.height ?? 0;
    if (!width || !height) {
      return applyStorageCors(error('VALIDATION_ERROR', 'Unable to read image dimensions', 400), origin);
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return applyStorageCors(error('VALIDATION_ERROR', 'Image must be at most 2000x2000 pixels', 400), origin);
    }

    const stored = await persistCharacterImage(buffer, `image${safeExtension}`);
    return applyStorageCors(ok({
      data,
      signature,
      userId: payload.userId,
      path: stored.relativePath,
      url: stored.url,
    }), origin);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : 'Failed to store user character image';
    return applyStorageCors(error('INTERNAL_ERROR', message, 500, { raw: String(err) }), origin);
  }
}
