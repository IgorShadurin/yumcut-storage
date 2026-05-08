import { z } from 'zod';

const EnvSchema = z.object({
  MEDIA_ROOT: z.string().optional(),
  STORAGE_PUBLIC_URL: z.string().url().optional(),
  STORAGE_ALLOWED_ORIGINS: z.string().optional(),
  MEDIA_CORS_ALLOWLIST: z.string().optional(),
  MEDIA_REQUIRE_SIGNED_DOWNLOAD: z.string().optional(),
  UPLOAD_SIGNING_PUBLIC_KEY: z.string().min(1).optional(),
  UPLOAD_SIGNING_PRIVATE_KEY: z.string().optional(),
  DAEMON_API_PASSWORD: z.string().optional(),
  PORT: z.string().optional(),
});

export type StorageConfig = z.infer<typeof EnvSchema>;

export const config: StorageConfig = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Config validation failed:', parsed.error.flatten().fieldErrors);
    return process.env as unknown as StorageConfig;
  }
  return parsed.data;
})();
