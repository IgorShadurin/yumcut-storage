import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

let tmpRoot: string;
let publicKeyPem: string;
let privateKeyPem: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-character-route-'));
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

async function makeRequest(kind: 'character-image' | 'image' | 'video', file: File) {
  vi.resetModules();
  const signatures = await import('@/lib/upload-signature');
  const route = await import('@/app/api/storage/characters/route');
  const grant = signatures.issueSignedDaemonUploadGrant({
    projectId: 'admin-character-catalog',
    kind,
    maxBytes: file.size,
    mimeTypes: [file.type],
  });
  const form = new FormData();
  form.set('data', grant.data);
  form.set('signature', grant.signature);
  form.set('file', file);
  const req = new NextRequest('http://localhost/api/storage/characters', { method: 'POST', body: form });
  return route.POST(req);
}

describe('POST /api/storage/characters', () => {
  it('accepts character image uploads into the characters namespace', async () => {
    const res = await makeRequest('character-image', new File([new Uint8Array([1, 2])], 'prepared.webp', { type: 'image/webp' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toMatch(/^characters\/\d{4}\/\d{2}\/\d{2}\/.+\.webp$/);
    expect(body.url).toBe(`http://localhost:3333/api/media/${body.path}`);
    await expect(fs.access(path.join(tmpRoot, body.path))).resolves.toBeUndefined();
  });

  it('accepts character preview videos into the characters namespace', async () => {
    const res = await makeRequest('video', new File([new Uint8Array([3, 4])], 'preview.mp4', { type: 'video/mp4' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toMatch(/^characters\/\d{4}\/\d{2}\/\d{2}\/.+\.mp4$/);
    expect(body.url).toBe(`http://localhost:3333/api/media/${body.path}`);
    await expect(fs.access(path.join(tmpRoot, body.path))).resolves.toBeUndefined();
  });

  it('stores character assets using an extension derived from the allowed mime type', async () => {
    const res = await makeRequest('video', new File([new Uint8Array([5, 6])], 'preview.html', { type: 'video/mp4' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toMatch(/^characters\/\d{4}\/\d{2}\/\d{2}\/.+\.mp4$/);
    expect(body.path).not.toMatch(/\.html$/);
  });

  it('rejects broad daemon image grants for the characters endpoint', async () => {
    const res = await makeRequest('image', new File([new Uint8Array([7, 8])], 'prepared.webp', { type: 'image/webp' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Unsupported daemon upload kind for characters' },
    });
  });

  it('rejects unsupported character asset mime types even when they are signed into the grant', async () => {
    const res = await makeRequest('video', new File([new Uint8Array([9, 10])], 'preview.html', { type: 'text/html' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'VALIDATION_ERROR', message: 'Mime type not allowed' },
    });
  });
});
