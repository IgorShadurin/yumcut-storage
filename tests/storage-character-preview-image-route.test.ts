import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { NextRequest } from 'next/server';

let tmpRoot: string;
let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-character-preview-'));
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKeyPem = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  privateKeyPem = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  process.env.MEDIA_ROOT = tmpRoot;
  process.env.STORAGE_PUBLIC_URL = 'http://localhost:3333';
  process.env.UPLOAD_SIGNING_PUBLIC_KEY = publicKeyPem;
  process.env.UPLOAD_SIGNING_PRIVATE_KEY = privateKeyPem;
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  delete process.env.MEDIA_ROOT;
  delete process.env.STORAGE_PUBLIC_URL;
  delete process.env.UPLOAD_SIGNING_PUBLIC_KEY;
  delete process.env.UPLOAD_SIGNING_PRIVATE_KEY;
});

async function writeSourceImage(relativePath: string, width: number, height: number) {
  const absolutePath = path.join(tmpRoot, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const bytes = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#c8d4f0',
    },
  }).webp().toBuffer();
  await fs.writeFile(absolutePath, bytes);
}

async function makeRequest(sourcePath: string, height: number, userId = 'admin-character-catalog') {
  vi.resetModules();
  const signatures = await import('@/lib/upload-signature');
  const route = await import('@/app/api/storage/characters/preview-image/route');
  const command = signatures.issueSignedStorageCommand({
    type: 'resize-character-image',
    userId,
    path: sourcePath,
    height,
  });
  const req = new NextRequest('http://localhost/api/storage/characters/preview-image', {
    method: 'POST',
    body: JSON.stringify({ data: command.data, signature: command.signature }),
  });
  return route.POST(req);
}

describe('POST /api/storage/characters/preview-image', () => {
  it('converts character images to the allowed preview height', async () => {
    await writeSourceImage('characters/2026/05/14/source.webp', 1008, 1792);

    const res = await makeRequest('characters/2026/05/14/source.webp', 896);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toMatch(/^characters\/variants\/catalog-preview\/h896\/[a-f0-9]+\.webp$/);
    expect(body.url).toBe(`http://localhost:3333/api/media/${body.path}`);
    expect(body.height).toBe(896);
    expect(body.width).toBe(504);
    await expect(fs.access(path.join(tmpRoot, body.path))).resolves.toBeUndefined();
  });

  it('does not upscale smaller source images', async () => {
    await writeSourceImage('characters/2026/05/14/small.webp', 225, 400);

    const res = await makeRequest('characters/2026/05/14/small.webp', 896);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.height).toBe(400);
    expect(body.width).toBe(225);
  });

  it('rejects unsupported heights', async () => {
    await writeSourceImage('characters/2026/05/14/bad-height.webp', 1008, 1792);

    const res = await makeRequest('characters/2026/05/14/bad-height.webp', 512);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Unsupported preview image height' },
    });
  });

  it('rejects non-character source paths', async () => {
    const res = await makeRequest('image/2026/05/14/source.webp', 896);

    expect(res.status).toBe(403);
  });
});
