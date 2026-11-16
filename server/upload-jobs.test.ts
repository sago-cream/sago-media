import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

const directory = mkdtempSync(join(tmpdir(), "sago-jobs-test-"));
const root = join(directory, "media");
const delayFile = join(directory, "delay");
const callsFile = join(directory, "calls");
const token = "test-owner-token-abcdefghijklmnopqrstuvwxyz-123456";
const otherToken = "test-other-token-abcdefghijklmnopqrstuvwxyz-123456";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
let process: ReturnType<typeof Bun.spawn>;
let database: Database;
let origin: string;
let port: number;

async function waitFor(check: () => Promise<boolean> | boolean, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error("Timed out waiting for test state");
}
async function start() {
  process = Bun.spawn([Bun.which("bun")!, "server/index.ts"], { env: {
    ...Bun.env, PORT: String(port), MEDIA_ROOT: root, MEDIA_UPLOAD_COMMAND: join(directory, "uploader"),
    MEDIA_BASE_URL: "https://media.example.test", MEDIA_PUBLIC_URL: origin,
    MEDIA_GITHUB_CLIENT_ID: "test", MEDIA_GITHUB_CLIENT_SECRET: "test", MEDIA_OWNER_GITHUB_ID: "1",
    MEDIA_UPLOAD_TIMEOUT_MS: "3000", MEDIA_DAILY_UPLOADS_PER_TOKEN: "20",
    MEDIA_DAILY_BYTES_PER_TOKEN: "1000000", MEDIA_MAX_REQUEST_BYTES: "1000000",
    TEST_DELAY_FILE: delayFile, TEST_CALLS_FILE: callsFile,
  }, stdout: "ignore", stderr: "inherit" });
  await waitFor(async () => { try { return (await fetch(origin + "/health")).ok; } catch { return false; } });
}
async function stop() { process.kill("SIGTERM"); await process.exited; }
function headers(body: string, id: string, credential = token) {
  return { Authorization: `Bearer ${credential}`, "Idempotency-Key": id, "X-Media-Filename": "test.png", "X-Media-SHA256": digest(body), "Content-Type": "application/octet-stream" };
}
async function create(body: string, id = randomUUID()) {
  return fetch(origin + "/v1/upload-jobs", { method: "POST", headers: headers(body, id), body });
}
async function status(id: string, credential = token) {
  return fetch(origin + "/v1/upload-jobs/" + id, { headers: { Authorization: `Bearer ${credential}` } });
}
async function terminal(id: string) {
  let result: any;
  await waitFor(async () => { result = await (await status(id)).json(); return ["ready", "failed"].includes(result.status); });
  return result;
}

beforeAll(async () => {
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  port = socket.port!; origin = `http://127.0.0.1:${port}`; socket.stop(true);
  writeFileSync(delayFile, "0");
  writeFileSync(callsFile, "");
  writeFileSync(join(directory, "uploader"), `#!/usr/bin/env bun
import {appendFileSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const data=readFileSync(process.argv[2]);
appendFileSync(process.env.TEST_CALLS_FILE,data.toString()+"\\n");
await Bun.sleep(Number(readFileSync(process.env.TEST_DELAY_FILE,"utf8")));
if(data.toString()==="fail"){console.error("Invalid test media");process.exit(1);}
const hash=createHash("sha256").update(data).digest("hex");
const prefix=hash.slice(0,2);
mkdirSync(process.env.MEDIA_ROOT+"/"+prefix,{recursive:true});
writeFileSync(process.env.MEDIA_ROOT+"/"+prefix+"/"+hash+".png",data);
console.log("![Media](https://media.example.test/"+prefix+"/"+hash+".png)");
`, { mode: 0o755 });
  await start();
  database = new Database(join(root, ".service/media.sqlite"));
  for (const [id, credential, github] of [["owner", token, "1"], ["other", otherToken, "2"]]) {
    database.query("INSERT INTO credentials(id,token_hash,github_id,github_login,device_name,device_key,scope,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, digest(credential), github, id, id, id, "upload:any", new Date().toISOString());
  }
});
afterAll(async () => { await stop(); database?.close(); rmSync(directory, { recursive: true, force: true }); });

test("acknowledges saved input promptly, completes only after storage, and deduplicates retries", async () => {
  writeFileSync(delayFile, "1500");
  const id = randomUUID(); const body = "success"; const before = Date.now();
  const accepted = await create(body, id);
  expect(accepted.status).toBe(202);
  expect(Date.now() - before).toBeLessThan(1000);
  expect((await accepted.json() as any).result).toBeUndefined();
  expect((await (await status(id)).json() as any).status).not.toBe("ready");
  expect((await create(body, id)).status).toBe(202);
  expect((await create("changed", id)).status).toBe(409);
  expect((await status(id, otherToken)).status).toBe(404);
  const result = await terminal(id);
  expect(result.status).toBe("ready");
  expect(readFileSync(join(root, new URL(result.result.url).pathname), "utf8")).toBe(body);
  expect(readFileSync(callsFile, "utf8").split("\n").filter(line => line === body)).toHaveLength(1);
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(1);
});

test("rejects checksum mismatches and releases the original day's quota", async () => {
  const id = randomUUID();
  const result = await fetch(origin + "/v1/upload-jobs", { method: "POST", headers: headers("different", id), body: "body" });
  expect(result.status).toBe(422);
  expect((await terminal(id)).status).toBe("failed");
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(1);
});

test("reports processing failures and deadlines without ever returning ready", async () => {
  writeFileSync(delayFile, "0");
  const bad = await (await create("fail")).json() as any;
  expect((await terminal(bad.id)).error).toContain("Invalid test media");
  writeFileSync(delayFile, "6000");
  const slow = await (await create("timeout")).json() as any;
  const result = await terminal(slow.id);
  expect(result.status).toBe("failed");
  expect(result.error).toContain("timed out");
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(1);
});

test("recovers accepted jobs after a server restart without a second upload or quota charge", async () => {
  writeFileSync(delayFile, "6000");
  const id = randomUUID();
  expect((await create("restart", id)).status).toBe(202);
  await waitFor(() => (database.query("SELECT status FROM upload_jobs WHERE id = ?").get(id) as any).status === "processing");
  await stop();
  writeFileSync(delayFile, "0");
  await start();
  expect((await terminal(id)).status).toBe("ready");
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(2);
  expect((await create("restart", id)).status).toBe(202);
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(2);
});

test("old clients receive a readable update instruction before processing any bytes", async () => {
  const result = await fetch(origin + "/v1/uploads", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "legacy" });
  expect(result.status).toBe(426);
  expect(result.headers.get("Content-Type")).toContain("text/plain");
  expect(await result.text()).toContain("https://github.com/sago-cream/sago-drop/releases/latest");
  expect(readFileSync(callsFile, "utf8")).not.toContain("legacy");
});

test("refunds a failed reservation against its original date", async () => {
  const id = randomUUID();
  database.transaction(() => {
    database.query("INSERT INTO usage(date,actor,bytes,uploads) VALUES ('2000-01-01','owner',4,1)").run();
    database.query("INSERT INTO upload_jobs(id,credential_id,filename,extension,bytes,sha256,quota_date,status,attempts,created_at,updated_at) VALUES (?,'owner','old.png','png',4,?,'2000-01-01','queued',3,?,?)").run(id, digest("date"), Date.now(), Date.now());
  })();
  expect((await terminal(id)).status).toBe("failed");
  expect(database.query("SELECT * FROM usage WHERE date = '2000-01-01'").get()).toBeNull();
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(2);
});

test("restarts an interrupted, unacknowledged transfer with the same ID", async () => {
  await stop();
  const id = randomUUID();
  const body = "partial";
  database.transaction(() => {
    const date = new Date().toISOString().slice(0, 10);
    database.query("UPDATE usage SET uploads = uploads + 1, bytes = bytes + ? WHERE date = ? AND actor = 'owner'").run(body.length, date);
    database.query("INSERT INTO upload_jobs(id,credential_id,filename,extension,bytes,sha256,quota_date,status,created_at,updated_at) VALUES (?,'owner','test.png','png',?,?,?,'receiving',?,?)").run(id, body.length, digest(body), date, Date.now(), Date.now());
  })();
  await start();
  expect((await status(id)).status).toBe(404);
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(2);
  expect((await create(body, id)).status).toBe(202);
  expect((await terminal(id)).status).toBe("ready");
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(3);
});

test("retries a disconnected transfer from the prepared file without a stale reservation", async () => {
  const id = randomUUID();
  const body = "x".repeat(100);
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(`POST /v1/upload-jobs HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nIdempotency-Key: ${id}\r\nX-Media-Filename: test.png\r\nX-Media-SHA256: ${digest(body)}\r\nContent-Length: 100\r\n\r\nxxx`);
  await waitFor(() => Boolean(database.query("SELECT id FROM upload_jobs WHERE id = ?").get(id)));
  socket.destroy();
  await waitFor(() => !database.query("SELECT id FROM upload_jobs WHERE id = ?").get(id));
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(3);
  expect((await create(body, id)).status).toBe(202);
  expect((await terminal(id)).status).toBe("ready");
  expect((database.query("SELECT uploads FROM usage WHERE actor = 'owner'").get() as any).uploads).toBe(4);
});
