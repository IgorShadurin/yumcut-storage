import { NextRequest } from 'next/server';
import { withApiError, forbidden, error, ok } from '@/lib/http';
import { persistCharacterAsset } from '@/server/storage';
import { verifySignedDaemonUploadGrant, assertDaemonUploadGrantFresh } from '@/lib/upload-signature';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHARACTER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const CHARACTER_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

const CHARACTER_UPLOAD_RULES = {
  'character-image': {
    maxBytes: CHARACTER_IMAGE_MAX_BYTES,
    extensionsByMime: {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
    },
  },
  video: {
    maxBytes: CHARACTER_VIDEO_MAX_BYTES,
    extensionsByMime: {
      'video/mp4': '.mp4',
      'video/quicktime': '.mov',
      'video/webm': '.webm',
      'video/x-m4v': '.m4v',
    },
  },
} as const;

type CharacterUploadKind = keyof typeof CHARACTER_UPLOAD_RULES;

function isCharacterUploadKind(kind: string): kind is CharacterUploadKind {
  return kind === 'character-image' || kind === 'video';
}

function resolveSafeExtension(kind: CharacterUploadKind, mime: string) {
  const extensionsByMime = CHARACTER_UPLOAD_RULES[kind].extensionsByMime as Record<string, string>;
  return extensionsByMime[mime] ?? null;
}

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

  if (!isCharacterUploadKind(payload.kind)) {
    return error('VALIDATION_ERROR', 'Unsupported daemon upload kind for characters', 400);
  }

  const mime = file.type || '';
  const safeExtension = resolveSafeExtension(payload.kind, mime);
  if (!safeExtension || !payload.mimeTypes.includes(mime)) {
    return error('VALIDATION_ERROR', 'Mime type not allowed', 400);
  }
  const maxBytes = Math.min(payload.maxBytes, CHARACTER_UPLOAD_RULES[payload.kind].maxBytes);
  if (file.size > maxBytes) {
    return error('VALIDATION_ERROR', 'Payload too large', 400);
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    return error('VALIDATION_ERROR', 'Payload too large', 400);
  }

  const stored = await persistCharacterAsset(buffer, `asset${safeExtension}`);
  return ok({ path: stored.relativePath, url: stored.url, projectId: payload.projectId });
}, 'Failed to persist character asset');
