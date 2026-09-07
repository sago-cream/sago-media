import { join } from "node:path";

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const config = {
  port: positiveInteger("PORT", 3000),
  mediaRoot: process.env.MEDIA_ROOT ?? "/srv/sago-media",
  uploadCommand: process.env.MEDIA_UPLOAD_COMMAND ?? "/usr/local/bin/sago-media-upload",
  baseUrl: (process.env.MEDIA_BASE_URL ?? "").replace(/\/$/, ""),
  githubClientId: process.env.MEDIA_GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.MEDIA_GITHUB_CLIENT_SECRET ?? "",
  ownerGithubId: process.env.MEDIA_OWNER_GITHUB_ID ?? "",
  bootstrapAdminToken: process.env.MEDIA_ADMIN_TOKEN ?? "",
  accessNotificationUrl: process.env.MEDIA_ACCESS_NOTIFICATION_URL ?? "",
  accessNotificationSecret:
    process.env.MEDIA_ACCESS_NOTIFICATION_SECRET ?? "",
  dailyByteLimit: positiveInteger("MEDIA_DAILY_BYTES_PER_TOKEN", 500_000_000),
  dailyUploadLimit: positiveInteger("MEDIA_DAILY_UPLOADS_PER_TOKEN", 50),
  requestByteLimit: positiveInteger("MEDIA_MAX_REQUEST_BYTES", 95_000_000),
  concurrentUploadLimit: positiveInteger("MEDIA_MAX_CONCURRENT_UPLOADS", 2),
  uploadTimeoutMs: positiveInteger("MEDIA_UPLOAD_TIMEOUT_MS", 900_000),
} as const;

export const stateDirectory = process.env.MEDIA_STATE_DIR ?? join(config.mediaRoot, ".service");
export const publicUrl = (process.env.MEDIA_PUBLIC_URL ?? config.baseUrl).replace(/\/$/, "");
export const publicOrigin = (() => {
  try { return new URL(publicUrl).origin; } catch { return ""; }
})();
export const webRoot = process.env.MEDIA_WEB_ROOT ?? join(process.cwd(), "web/dist");
