/**
 * Joyce sync server.
 *
 * Joyce encrypts everything before upload, so this server only ever sees opaque
 * IDs, version numbers and ciphertext. Its jobs are to keep the authoritative
 * list of files (one row per file: opaque id → version, content id, encrypted
 * metadata), store encrypted contents, hand out changes since a sequence number,
 * reject stale writes (so two computers editing the same file is detected, not
 * silently lost), and nudge connected computers over a WebSocket when anything
 * changes.
 *
 *   Worker      Thin router: finds the vault a request is for.
 *   Vault (DO)  One per synced writing folder. Files, contents, devices, history.
 *   Registry    One instance. Which vaults exist, and one-time pairing codes.
 */

import { DurableObject } from "cloudflare:workers";

interface Env {
  VAULT: DurableObjectNamespace<Vault>;
  REGISTRY: DurableObjectNamespace<Registry>;
}

const MAX_CHUNK = 1024 * 1024; // Durable Object rows top out at 2 MB.
const PAIRING_TTL_MS = 15 * 60_000;
/** Consecutive saves of one file by one device within this window keep one history entry. */
const HISTORY_COALESCE_MS = 10 * 60_000;
/** Only update a device's "last seen" this often, to spare row writes. */
const LAST_SEEN_EVERY_MS = 10 * 60_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string) => json({ error }, status);

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

const ID = /^[0-9a-f]{64}$/; // content ids and file ids: hex HMACs from the client
const VAULT_ID = /^[0-9a-f]{32}$/;

/** Tokens look like `jv1.<vaultId>.<deviceId>.<secret>`. */
function parseToken(req: Request) {
  const m = req.headers.get("authorization")?.match(/^Bearer jv1\.([0-9a-f]{32})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{40,})$/);
  return m ? { vaultId: m[1], deviceId: m[2], secret: m[3] } : null;
}

const vaultStub = (env: Env, vaultId: string) => env.VAULT.get(env.VAULT.idFromName(vaultId));
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));

// --- Worker -----------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/v1/health") return json({ ok: true });

    // Creating a vault: allowed for the very first one (claiming this deployment),
    // afterwards only for someone who already has a device in an existing vault.
    if (path === "/v1/vaults" && req.method === "POST") {
      const token = parseToken(req);
      const authorized = token ? await vaultStub(env, token.vaultId).checkToken(token.deviceId, token.secret) : false;
      const body = (await req.json().catch(() => ({}))) as { deviceName?: string };
      const vaultId = randomHex(16);
      if (!(await registry(env).registerVault(vaultId, authorized))) {
        return fail(403, "This sync server already has a vault. Pair this computer from one that's already syncing.");
      }
      return json({ vaultId, ...(await vaultStub(env, vaultId).addDevice(vaultId, String(body.deviceName ?? "Computer"))) });
    }

    // Joining with a pairing code. No token yet: the code is the proof.
    if (path === "/v1/pairings/claim" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { lookup?: string; deviceName?: string };
      if (!body.lookup || !ID.test(body.lookup)) return fail(400, "Bad pairing code");
      const claimed = await registry(env).claimPairing(body.lookup);
      if ("error" in claimed) return fail(claimed.status, claimed.error);
      const device = await vaultStub(env, claimed.vaultId).addDevice(claimed.vaultId, String(body.deviceName ?? "Computer"));
      return json({ vaultId: claimed.vaultId, sealed: claimed.sealed, ...device });
    }

    // Everything else belongs to a vault and needs a device token.
    const token = parseToken(req);
    if (!token || !VAULT_ID.test(token.vaultId)) return fail(401, "Missing or malformed token");

    if (path === "/v1/pairings" && req.method === "POST") {
      if (!(await vaultStub(env, token.vaultId).checkToken(token.deviceId, token.secret))) return fail(401, "Unknown device");
      const body = (await req.json().catch(() => ({}))) as { lookup?: string; sealed?: string };
      if (!body.lookup || !ID.test(body.lookup) || typeof body.sealed !== "string" || body.sealed.length > 512) {
        return fail(400, "Bad pairing request");
      }
      return json(await registry(env).createPairing(body.lookup, token.vaultId, body.sealed));
    }

    return vaultStub(env, token.vaultId).fetch(req);
  },
} satisfies ExportedHandler<Env>;

// --- Registry -----------------------------------------------------------------

export class Registry extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS vaults (id TEXT PRIMARY KEY, created INTEGER);
      CREATE TABLE IF NOT EXISTS pairings (lookup TEXT PRIMARY KEY, vault TEXT, sealed TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS misses (at INTEGER);
    `);
  }

  registerVault(id: string, authorized: boolean): boolean {
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM vaults").one().n;
    if (count > 0 && !authorized) return false;
    this.sql.exec("INSERT INTO vaults VALUES (?, ?)", id, Date.now());
    return true;
  }

  createPairing(lookup: string, vault: string, sealed: string) {
    const now = Date.now();
    this.sql.exec("DELETE FROM pairings WHERE expires < ?", now);
    const expires = now + PAIRING_TTL_MS;
    this.sql.exec("INSERT OR REPLACE INTO pairings VALUES (?, ?, ?, ?)", lookup, vault, sealed, expires);
    return { expires };
  }

  /** One use only. Wrong guesses are counted, and too many lock claiming briefly. */
  claimPairing(lookup: string): { vaultId: string; sealed: string } | { error: string; status: number } {
    const now = Date.now();
    this.sql.exec("DELETE FROM misses WHERE at < ?", now - 10 * 60_000);
    const misses = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM misses").one().n;
    if (misses >= 30) return { error: "Too many attempts. Try again in a few minutes.", status: 429 };

    const row = this.sql
      .exec<{ vault: string; sealed: string; expires: number }>("SELECT vault, sealed, expires FROM pairings WHERE lookup = ?", lookup)
      .toArray()[0];
    if (!row || row.expires < now) {
      this.sql.exec("INSERT INTO misses VALUES (?)", now);
      return { error: "That code isn't valid, or it has expired.", status: 404 };
    }
    this.sql.exec("DELETE FROM pairings WHERE lookup = ?", lookup);
    return { vaultId: row.vault, sealed: row.sealed };
  }
}

// --- Vault --------------------------------------------------------------------

interface EntryRow {
  id: string;
  version: number;
  blob: string | null;
  meta: string;
  seq: number;
  device: string;
  at: number;
  [key: string]: SqlStorageValue;
}

interface Change {
  id: string;
  /** Version the client last saw; 0 for a file it thinks is new. */
  base: number;
  /** Content id, or null to delete. */
  blob: string | null;
  /** Encrypted metadata (path, size…), opaque here. */
  meta: string;
}

export class Vault extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private verified = new Map<string, string>(); // deviceId → token hash, cached
  private lastSeenWrite = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v INTEGER);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created INTEGER, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, version INTEGER, blob TEXT, meta TEXT, seq INTEGER, device TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS entries_seq ON entries(seq);
      CREATE TABLE IF NOT EXISTS history (id TEXT, version INTEGER, blob TEXT, meta TEXT, device TEXT, at INTEGER, PRIMARY KEY (id, version));
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, chunks INTEGER, size INTEGER);
      CREATE TABLE IF NOT EXISTS chunks (blob TEXT, idx INTEGER, data BLOB, PRIMARY KEY (blob, idx));
    `);
    // Answered without waking the object, so idle connections cost nothing.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get seq() {
    return this.sql.exec<{ v: number }>("SELECT v FROM state WHERE k = 'seq'").toArray()[0]?.v ?? 0;
  }

  async addDevice(vaultId: string, name: string) {
    const deviceId = randomHex(8);
    const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const now = Date.now();
    this.sql.exec("INSERT INTO devices VALUES (?, ?, ?, ?, ?)", deviceId, name.slice(0, 80), await sha256(secret), now, now);
    return { deviceId, token: `jv1.${vaultId}.${deviceId}.${secret}` };
  }

  async checkToken(deviceId: string, secret: string): Promise<boolean> {
    const hash = await sha256(secret);
    const cached = this.verified.get(deviceId);
    if (cached) return cached === hash;
    const row = this.sql.exec<{ token_hash: string }>("SELECT token_hash FROM devices WHERE id = ?", deviceId).toArray()[0];
    if (!row) return false;
    this.verified.set(deviceId, row.token_hash);
    return row.token_hash === hash;
  }

  private touch(deviceId: string) {
    const now = Date.now();
    if (now - (this.lastSeenWrite.get(deviceId) ?? 0) < LAST_SEEN_EVERY_MS) return;
    this.lastSeenWrite.set(deviceId, now);
    this.sql.exec("UPDATE devices SET last_seen = ? WHERE id = ?", now, deviceId);
  }

  async fetch(req: Request): Promise<Response> {
    const token = parseToken(req);
    if (!token || !(await this.checkToken(token.deviceId, token.secret))) return fail(401, "Unknown device");
    const device = token.deviceId;
    this.touch(device);

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", ...]
    const route = `${req.method} /${parts.slice(1, 2).join("/")}`;

    switch (route) {
      case "GET /ws": {
        if (req.headers.get("upgrade") !== "websocket") return fail(426, "Expected a WebSocket");
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [device]);
        pair[1].send(JSON.stringify({ seq: this.seq }));
        return new Response(null, { status: 101, webSocket: pair[0] });
      }

      case "GET /changes": {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 500) || 500, 1000);
        const rows = this.sql
          .exec<EntryRow>("SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", since, limit + 1)
          .toArray();
        const more = rows.length > limit;
        const entries = rows.slice(0, limit).map(({ id, version, blob, meta, seq }) => ({ id, version, blob, meta, seq }));
        return json({ seq: this.seq, entries, more });
      }

      case "POST /missing": {
        const { ids } = (await req.json()) as { ids?: string[] };
        if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((i) => ID.test(i))) return fail(400, "Bad ids");
        const missing = ids.filter((id) => !this.blobComplete(id));
        return json({ missing });
      }

      case "PUT /blobs": {
        // PUT /v1/blobs/<id>/<chunk>?of=<total>&size=<bytes>
        const [id, idxRaw] = parts.slice(2);
        const idx = Number(idxRaw);
        const total = Number(url.searchParams.get("of"));
        const size = Number(url.searchParams.get("size"));
        if (!ID.test(id ?? "") || !Number.isInteger(idx) || !Number.isInteger(total) || idx < 0 || idx >= total || total > 4096) {
          return fail(400, "Bad chunk");
        }
        const data = await req.arrayBuffer();
        if (data.byteLength > MAX_CHUNK) return fail(413, "Chunk too large");
        this.sql.exec("INSERT OR REPLACE INTO chunks VALUES (?, ?, ?)", id, idx, data);
        this.sql.exec("INSERT OR IGNORE INTO blobs VALUES (?, ?, ?)", id, total, size || 0);
        return json({ ok: true });
      }

      case "GET /blobs": {
        const [id, idxRaw] = parts.slice(2);
        const blob = this.sql.exec<{ chunks: number }>("SELECT chunks FROM blobs WHERE id = ?", id ?? "").toArray()[0];
        const row = this.sql
          .exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE blob = ? AND idx = ?", id ?? "", Number(idxRaw) || 0)
          .toArray()[0];
        if (!blob || !row) return fail(404, "No such content");
        return new Response(row.data, { headers: { "x-chunks": String(blob.chunks), "content-type": "application/octet-stream" } });
      }

      case "POST /commit": {
        const { changes } = (await req.json()) as { changes?: Change[] };
        if (!Array.isArray(changes) || changes.length > 500) return fail(400, "Bad changes");
        const results = changes.map((c) => this.commit(c, device));
        if (results.some((r) => "version" in r)) this.notify(device);
        return json({ seq: this.seq, results });
      }

      case "GET /devices": {
        const devices = this.sql
          .exec<{ id: string; name: string; created: number; last_seen: number }>("SELECT id, name, created, last_seen FROM devices ORDER BY created")
          .toArray()
          .map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.last_seen, current: d.id === device }));
        return json({ devices });
      }

      case "DELETE /devices": {
        const target = parts[2] ?? "";
        this.sql.exec("DELETE FROM devices WHERE id = ?", target);
        this.verified.delete(target);
        for (const ws of this.ctx.getWebSockets(target)) ws.close(4001, "Device removed");
        return json({ ok: true });
      }

      default:
        return fail(404, "Not found");
    }
  }

  private blobComplete(id: string) {
    const row = this.sql
      .exec<{ chunks: number; have: number }>(
        "SELECT b.chunks AS chunks, (SELECT COUNT(*) FROM chunks c WHERE c.blob = b.id) AS have FROM blobs b WHERE b.id = ?",
        id,
      )
      .toArray()[0];
    return !!row && row.have === row.chunks;
  }

  /** Applies one change if it's based on the current version; otherwise reports the conflict. */
  private commit(c: Change, device: string) {
    if (!ID.test(c.id ?? "") || typeof c.meta !== "string" || c.meta.length > 8192) return { error: "Bad change" };
    if (c.blob !== null && (!ID.test(c.blob) || !this.blobComplete(c.blob))) return { error: "Content not uploaded" };

    const current = this.sql.exec<EntryRow>("SELECT * FROM entries WHERE id = ?", c.id).toArray()[0];
    const version = current?.version ?? 0;
    if (c.base !== version) {
      return { conflict: { version, blob: current?.blob ?? null, meta: current?.meta ?? null } };
    }
    // Deleting something that's already gone (or never existed) changes nothing.
    if (c.blob === null && (!current || current.blob === null)) return { version };

    const now = Date.now();
    const seq = this.seq + 1;
    this.sql.exec("INSERT OR REPLACE INTO state VALUES ('seq', ?)", seq);
    this.sql.exec("INSERT OR REPLACE INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)", c.id, version + 1, c.blob, c.meta, seq, device, now);

    // History: a burst of saves to one file from one device keeps a single entry,
    // so typing all afternoon doesn't store hundreds of near-identical versions.
    const last = this.sql
      .exec<{ version: number; blob: string | null; device: string; at: number }>(
        "SELECT version, blob, device, at FROM history WHERE id = ? ORDER BY version DESC LIMIT 1",
        c.id,
      )
      .toArray()[0];
    if (last && last.device === device && now - last.at < HISTORY_COALESCE_MS && last.blob !== null && c.blob !== null) {
      this.sql.exec("DELETE FROM history WHERE id = ? AND version = ?", c.id, last.version);
      this.collect(last.blob);
    }
    this.sql.exec("INSERT INTO history VALUES (?, ?, ?, ?, ?, ?)", c.id, version + 1, c.blob, c.meta, device, now);
    return { version: version + 1 };
  }

  /** Deletes stored content nothing refers to any more. */
  private collect(blob: string) {
    const used = this.sql
      .exec<{ n: number }>(
        "SELECT (SELECT COUNT(*) FROM entries WHERE blob = ?) + (SELECT COUNT(*) FROM history WHERE blob = ?) AS n",
        blob,
        blob,
      )
      .one().n;
    if (used > 0) return;
    this.sql.exec("DELETE FROM chunks WHERE blob = ?", blob);
    this.sql.exec("DELETE FROM blobs WHERE id = ?", blob);
  }

  /** Tells every other connected computer there's something new. */
  private notify(except: string) {
    const msg = JSON.stringify({ seq: this.seq });
    for (const ws of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(ws).includes(except)) continue;
      try {
        ws.send(msg);
      } catch {
        // A dead socket; it'll be cleaned up when it closes.
      }
    }
  }

  async webSocketMessage() {
    // Clients only send pings, which are answered automatically.
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {
      // Already closed.
    }
  }
}
