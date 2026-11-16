import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { authenticate } from "./auth";
import { config, stateDirectory } from "./config";
import { database } from "./database";
import { json, response } from "./shared";
import { releaseQuota, reserveQuota } from "./uploads";

type Job = {
  id: string; credential_id: string; filename: string; extension: string;
  bytes: number; sha256: string; quota_date: string;
  status: "receiving" | "queued" | "processing" | "ready" | "failed";
  attempts: number; result: string | null; error: string | null;
  created_at: number; updated_at: number;
};
type Result = { url: string; markdown: string; previewUrl: string | null };
const root = join(stateDirectory, "upload-jobs");
const extensions = new Set(["gif", "jpeg", "jpg", "mp4", "png", "webp"]);
const children = new Set<ReturnType<typeof Bun.spawn>>();
const running = new Set<Promise<void>>();
let timer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let lastCleanup = 0;
const row = (id: string) => database.query("SELECT * FROM upload_jobs WHERE id = ?").get(id) as Job | null;
const inputPath = (job: Job) => join(root, job.id, `input.${job.extension}`);
const sync = (path: string) => { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const describe = (job: Job) => ({ id: job.id, status: job.status, result: job.result ? JSON.parse(job.result) : undefined, error: job.error ?? undefined });

export function upgradeRequired() {
  return response("Update Sago Drop to continue uploading public links. Choose Check for Updates or Update Available in the Sago Drop menu. If those actions are missing, download the latest app from https://github.com/sago-cream/sago-drop/releases/latest or run: brew upgrade --cask sago-cream/tap/sago-drop\n", 426, { "Upgrade": "SagoDrop/0.11.0" });
}

function owns(job: Job, credentialId: string) {
  return database.query("SELECT 1 FROM credentials owner JOIN credentials current ON owner.github_id = current.github_id WHERE owner.id = ? AND current.id = ?").get(job.credential_id, credentialId) !== null;
}

export function getUploadJob(request: Request, id: string) {
  const actor = authenticate(request);
  if (!actor) return response("Sign in before uploading.\n", 401);
  const job = row(id);
  if (!job || !owns(job, actor.id)) return response("Upload not found.\n", 404);
  if (job.status === "ready" && job.result) {
    const result = JSON.parse(job.result) as Result;
    if (!existsSync(join(config.mediaRoot, new URL(result.url).pathname))) {
      return json({ id: job.id, status: "failed", error: "This file is no longer stored. Please share it again." });
    }
  }
  return json(describe(job));
}

function forgetIncomplete(job: Job) {
  database.transaction(() => {
    releaseQuota(job.credential_id, job.bytes, job.quota_date);
    database.query("DELETE FROM upload_jobs WHERE id = ?").run(job.id);
  })();
  rmSync(join(root, job.id), { recursive: true, force: true });
}

function fail(job: Job, error: string) {
  database.transaction(() => {
    const changed = database.query("UPDATE upload_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status NOT IN ('ready', 'failed')").run(error, Date.now(), job.id);
    if (changed.changes) releaseQuota(job.credential_id, job.bytes, job.quota_date);
  })();
  rmSync(join(root, job.id), { force: true, recursive: true });
}

export async function createUploadJob(request: Request) {
  const actor = authenticate(request);
  if (!actor) return response("Sign in before uploading.\n", 401);
  const id = request.headers.get("idempotency-key") ?? "";
  const filename = basename(request.headers.get("x-media-filename") ?? "");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const bytes = Number(request.headers.get("content-length"));
  const sha256 = request.headers.get("x-media-sha256") ?? "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha256)) return response("An upload ID and SHA-256 checksum are required.\n", 400);
  if (!extensions.has(extension) || filename.length > 240) return response("Invalid filename.\n", 400);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return response("Content-Length is required.\n", 411);
  if (bytes > config.requestByteLimit) return response("Upload exceeds the request size limit.\n", 413);
  const existing = row(id);
  if (existing) {
    if (!owns(existing, actor.id) || existing.sha256 !== sha256 || existing.bytes !== bytes || existing.filename !== filename) return response("Upload ID already belongs to another file.\n", 409);
    return json(describe(existing), 202);
  }
  const pending = database.query("SELECT COUNT(*) AS count FROM upload_jobs WHERE status IN ('receiving','queued','processing')").get() as { count: number };
  if (pending.count >= config.concurrentUploadLimit * 4) return response("Uploads are busy. Try again shortly.\n", 429, { "Retry-After": "5" });
  const quotaDate = new Date().toISOString().slice(0, 10);
  const accepted = database.transaction(() => {
    if (!reserveQuota(actor.id, bytes, quotaDate)) return false;
    database.query("INSERT INTO upload_jobs(id,credential_id,filename,extension,bytes,sha256,quota_date,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'receiving',?,?)").run(id, actor.id, filename, extension, bytes, sha256, quotaDate, Date.now(), Date.now());
    return true;
  })();
  if (!accepted) return response("Daily upload quota exceeded.\n", 429, { "Retry-After": "86400" });
  const job = row(id)!;
  const receivedAt = Date.now();
  let interrupted = false;
  try {
    mkdirSync(join(root, id), { recursive: true, mode: 0o700 });
    const writer = Bun.file(inputPath(job)).writer();
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Upload body is required.");
    const hasher = new Bun.CryptoHasher("sha256");
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read().catch(error => { interrupted = true; throw error; });
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > bytes) throw new Error("Upload exceeds its declared size.");
        hasher.update(chunk.value);
        writer.write(chunk.value);
        await writer.flush();
      }
    } finally { await writer.end(); reader.releaseLock(); }
    if (received !== bytes || hasher.digest("hex") !== sha256) throw new Error("Upload checksum or size did not match.");
    sync(inputPath(job)); sync(join(root, id)); sync(root);
    database.query("UPDATE upload_jobs SET status = 'queued', updated_at = ? WHERE id = ?").run(Date.now(), id);
    console.info(JSON.stringify({ event: "upload_received", id, bytes, transferMs: Date.now() - receivedAt }));
    return json(describe(row(id)!), 202);
  } catch (error) {
    if (interrupted || request.signal.aborted) {
      forgetIncomplete(job);
      return response("Upload interrupted. Retry with the same upload ID.\n", 503);
    }
    fail(job, error instanceof Error ? error.message : "Upload interrupted. Please share the file again.");
    return response("Upload was not saved. Please share the file again.\n", 422);
  }
}

function storedResult(stdout: string): Result {
  const markdown = stdout.trim();
  const urls = [...markdown.matchAll(/https:\/\/[^)<>\s]+/g)].map(match => match[0]);
  const url = urls.at(-1);
  if (!url) throw new Error("Processing returned no public URL.");
  const parsed = new URL(url);
  if (parsed.origin !== new URL(config.baseUrl).origin || !/^\/[a-f0-9]{2}\/[a-f0-9]{64}\.(gif|jpg|mp4|png|webp)$/.test(parsed.pathname)) throw new Error("Processing returned an invalid media URL.");
  const path = join(config.mediaRoot, parsed.pathname);
  if (!existsSync(path)) throw new Error("Processed media is not available.");
  sync(path); sync(join(path, ".."));
  return { url, markdown, previewUrl: urls.length > 1 ? urls[0] : null };
}

async function processJob(job: Job) {
  const startedAt = Date.now();
  console.info(JSON.stringify({ event: "upload_processing", id: job.id, queuedMs: startedAt - job.updated_at, attempt: job.attempts + 1 }));
  try {
    if (job.attempts >= 3) throw new Error("Processing was interrupted repeatedly. Please share the file again.");
    const child = Bun.spawn({ cmd: [config.uploadCommand, inputPath(job)], detached: true, env: process.env, stdout: "pipe", stderr: "pipe" });
    children.add(child);
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; kill(child); }, config.uploadTimeoutMs);
    let code: number;
    try { code = await child.exited; } finally { clearTimeout(deadline); children.delete(child); }
    const [output, detail] = await Promise.all([stdout, stderr]);
    if (stopping) {
      database.query("UPDATE upload_jobs SET status = 'queued', updated_at = ? WHERE id = ?").run(Date.now(), job.id);
      return;
    }
    if (timedOut) throw new Error("Upload processing timed out. Please share the file again.");
    if (code !== 0) throw new Error(detail.trim().slice(0, 2000) || "Media processing failed.");
    const result = storedResult(output);
    database.query("UPDATE upload_jobs SET status = 'ready', result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), job.id);
    rmSync(join(root, job.id), { force: true, recursive: true });
    console.info(JSON.stringify({ event: "upload_ready", id: job.id, processingMs: Date.now() - startedAt }));
  } catch (error) {
    fail(job, error instanceof Error ? error.message : "Media processing failed.");
    console.warn(JSON.stringify({ event: "upload_failed", id: job.id, processingMs: Date.now() - startedAt }));
  }
}

function kill(child: ReturnType<typeof Bun.spawn>) {
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}

function drain() {
  if (stopping) return;
  while (running.size < config.concurrentUploadLimit) {
    const job = database.transaction(() => {
      const next = database.query("SELECT * FROM upload_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as Job | null;
      if (next) database.query("UPDATE upload_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(Date.now(), next.id);
      return next;
    })();
    if (!job) break;
    const work = processJob(job).finally(() => { running.delete(work); drain(); });
    running.add(work);
  }
}

export function startUploadWorker() {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const job of database.query("SELECT * FROM upload_jobs WHERE status = 'receiving'").all() as Job[]) {
    forgetIncomplete(job);
  }
  database.query("UPDATE upload_jobs SET status = 'queued' WHERE status = 'processing'").run();
  cleanup();
  timer = setInterval(() => { drain(); if (Date.now() - lastCleanup > 60 * 60 * 1000) cleanup(); }, 250);
  timer.unref();
  drain();
}

function cleanup() {
  lastCleanup = Date.now();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  database.query("DELETE FROM upload_jobs WHERE status IN ('ready','failed') AND updated_at < ?").run(cutoff);
  for (const name of readdirSync(root)) {
    const job = row(name);
    if (/^[a-f0-9-]{36}$/.test(name) && (!job || job.status === "ready" || job.status === "failed")) rmSync(join(root, name), { recursive: true, force: true });
  }
}

export async function stopUploadWorker() {
  stopping = true;
  clearInterval(timer);
  for (const child of children) kill(child);
  await Promise.allSettled(running);
}
