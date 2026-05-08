import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

let publicKeyPem: string;
let privateKeyPem: string;

async function loadSignatures() {
  vi.resetModules();
  return import('@/lib/upload-signature');
}

beforeAll(() => {
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKeyPem = keyPair.publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  privateKeyPem = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  process.env.UPLOAD_SIGNING_PUBLIC_KEY = publicKeyPem;
  process.env.UPLOAD_SIGNING_PRIVATE_KEY = privateKeyPem;
});

afterAll(() => {
  delete process.env.UPLOAD_SIGNING_PUBLIC_KEY;
  delete process.env.UPLOAD_SIGNING_PRIVATE_KEY;
});

describe('storage commands', () => {
  it('issues and verifies delete commands', async () => {
    const signatures = await loadSignatures();
    const issued = signatures.issueSignedStorageCommand({
      type: 'delete-character-image',
      userId: 'user-123',
      path: 'characters/2025/03/04/example.png',
    });
    const verified = signatures.verifySignedStorageCommand(issued.data, issued.signature);
    expect(verified.type).toBe('delete-character-image');
    expect(verified.userId).toBe('user-123');
    expect(verified.path).toBe('characters/2025/03/04/example.png');
    expect(() => signatures.assertStorageCommandFresh(verified)).not.toThrow();
  });

  it('supports multi-path delete-user-media commands', async () => {
    const signatures = await loadSignatures();
    const issued = signatures.issueSignedStorageCommand({
      type: 'delete-user-media',
      userId: 'user-555',
      paths: ['audio/one.wav', 'video/two.mp4', 'audio/one.wav'],
    });
    const verified = signatures.verifySignedStorageCommand(issued.data, issued.signature);
    expect(verified.type).toBe('delete-user-media');
    expect(verified.paths).toEqual(['audio/one.wav', 'video/two.mp4']);
  });

  it('rejects upload grants reused as storage commands', async () => {
    const signatures = await loadSignatures();
    const uploadGrant = signatures.issueSignedUploadGrant({
      userId: 'user-456',
      purpose: 'user-character-image',
    });
    expect(() => signatures.verifySignedStorageCommand(uploadGrant.data, uploadGrant.signature)).toThrow(/storage payload/i);
  });

  it('rejects storage command signatures reused for uploads', async () => {
    const signatures = await loadSignatures();
    const storageCommand = signatures.issueSignedStorageCommand({
      type: 'delete-character-image',
      userId: 'user-789',
      path: 'characters/2025/05/06/bad.png',
    });
    expect(() => signatures.verifySignedUploadGrant(storageCommand.data, storageCommand.signature)).toThrow(/purpose|upload payload/i);
  });
});

describe('daemon upload grants', () => {
  it('issues and verifies daemon upload grants', async () => {
    const signatures = await loadSignatures();
    const grant = signatures.issueSignedDaemonUploadGrant({
      projectId: 'project-abc',
      kind: 'image',
      maxBytes: 123456,
      mimeTypes: ['image/png'],
    });
    const payload = signatures.verifySignedDaemonUploadGrant(grant.data, grant.signature);
    expect(payload.projectId).toBe('project-abc');
    expect(payload.kind).toBe('image');
    expect(payload.maxBytes).toBe(123456);
    expect(payload.mimeTypes).toEqual(['image/png']);
    expect(() => signatures.assertDaemonUploadGrantFresh(payload)).not.toThrow();
  });

  it('expires daemon upload grants after ttl', async () => {
    const signatures = await loadSignatures();
    vi.useFakeTimers();
    try {
      const grant = signatures.issueSignedDaemonUploadGrant({
        projectId: 'project-expiring',
        kind: 'audio',
        ttlMs: 10,
      });
      vi.advanceTimersByTime(15);
      const payload = signatures.verifySignedDaemonUploadGrant(grant.data, grant.signature);
      expect(() => signatures.assertDaemonUploadGrantFresh(payload)).toThrow(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
