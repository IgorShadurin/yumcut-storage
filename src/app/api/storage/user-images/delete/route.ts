import { NextRequest } from 'next/server';
import { z } from 'zod';
import { forbidden, error, ok } from '@/lib/http';
import { verifySignedStorageCommand, assertStorageCommandFresh } from '@/lib/upload-signature';
import { removeCharacterImage } from '@/server/storage';
import { applyStorageCors, resolveStorageCorsOrigin, storageCorsPreflight } from '@/lib/storage-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  data: z.string().min(1),
  signature: z.string().min(1),
});

export async function OPTIONS(req: NextRequest) {
  return storageCorsPreflight(req);
}

export async function POST(req: NextRequest) {
  const origin = resolveStorageCorsOrigin(req);
  if (!origin) {
    return forbidden('Origin not allowed');
  }
  try {
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return applyStorageCors(error('VALIDATION_ERROR', 'Invalid storage command payload', 400), origin);
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return applyStorageCors(error('VALIDATION_ERROR', 'Invalid storage command payload', 400, parsed.error.flatten()), origin);
    }
    const { data, signature } = parsed.data;
    let payload;
    try {
      payload = verifySignedStorageCommand(data, signature);
      assertStorageCommandFresh(payload);
    } catch (err: unknown) {
      const message = err instanceof Error && err.message ? err.message : 'Invalid storage command';
      return applyStorageCors(forbidden(message), origin);
    }
    if (payload.type !== 'delete-character-image') {
      return applyStorageCors(error('VALIDATION_ERROR', 'Unsupported storage command', 400), origin);
    }
    if (!payload.path || !payload.path.toLowerCase().startsWith('characters/')) {
      return applyStorageCors(error('VALIDATION_ERROR', 'Unsupported storage command path', 400), origin);
    }
    await removeCharacterImage(payload.path);
    return applyStorageCors(ok({ ok: true }), origin);
  } catch (err: unknown) {
    const errMessage =
      err instanceof Error && err.message
        ? `Failed to delete character image from storage: ${err.message}`
        : 'Failed to delete character image from storage';
    return applyStorageCors(error('INTERNAL_ERROR', errMessage, 500, { raw: String(err) }), origin);
  }
}
