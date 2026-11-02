// Hybrid data layer: direct filesystem reads of the allman store for fast
// browsing, plus subprocess shell-outs to the standalone `allman` binary for
// writes and live streaming. The binary is the canonical writer (rate
// limiting, pre-send sync, git commits) — we never write to the store
// ourselves, and we never reach into the CLI's source tree.
//
// All subprocess launches go through `./cli.ts` so every call inherits the
// same `--store $HOME/.allman` prefix. Do not call `child_process.spawn`
// on the binary directly from this file.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { resolveBin, resolveStore, spawnAllman } from "./cli.ts";
import type { Account, Auth, Conversation, ListenEvent, Message, SearchResult } from "./types.ts";

/** Legacy re-exports so existing callers keep working after the split. */
export const getStorePath = resolveStore;
export const getAllmanBin = resolveBin;

// ---------------------------------------------------------------------------
// Account discovery
// ---------------------------------------------------------------------------

export function findAccounts(storePath = getStorePath()): Account[] {
  if (!existsSync(storePath)) return [];
  const entries = readdirSync(storePath, { withFileTypes: true });
  const accounts: Account[] = [];

  // Build a map from profileId-dir → slug by walking symlinks at the top level.
  // The store layout is `{accountSlug} -> {profileId}` so each real account
  // directory may have one or more symlinks pointing at it.
  const slugByProfileId = new Map<string, string>();
  for (const e of entries) {
    const full = join(storePath, e.name);
    try {
      if (!lstatSync(full).isSymbolicLink()) continue;
      const target = readlinkSync(full);
      const resolved = resolve(storePath, target);
      const profileId = resolved.split("/").pop() || resolved;
      if (!slugByProfileId.has(profileId)) slugByProfileId.set(profileId, e.name);
    } catch {
      // ignore broken links
    }
  }

  for (const entry of entries) {
    const full = join(storePath, entry.name);
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const authPath = join(full, "AUTH.json");
    if (!existsSync(authPath)) continue;

    let auth: Auth;
    try {
      auth = JSON.parse(readFileSync(authPath, "utf8"));
    } catch {
      continue;
    }

    accounts.push({
      slug: slugByProfileId.get(entry.name) ?? auth.slug ?? entry.name,
      profileId: entry.name,
      dir: full,
      auth,
    });
  }

  return accounts;
}

/** Re-read AUTH.json for an account to pick up `lastSyncAt` updates from CLI runs. */
export function readAccountAuth(accountDir: string): Auth | null {
  const authPath = join(accountDir, "AUTH.json");
  if (!existsSync(authPath)) return null;
  try {
    return JSON.parse(readFileSync(authPath, "utf8")) as Auth;
  } catch {
    return null;
  }
}

export function resolveSlugToConvId(accountDir: string, slug: string): string | null {
  // Slugs are stored as symlinks at the top of the account dir → convId.
  const linkPath = join(accountDir, slug);
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return null;
    const real = realpathSync(linkPath);
    return real.split("/").pop() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function loadConversations(accountDir: string): Conversation[] {
  if (!existsSync(accountDir)) return [];
  const entries = readdirSync(accountDir, { withFileTypes: true });
  const convs: Conversation[] = [];

  for (const entry of entries) {
    // Conversation dirs are real (not symlinks) and start with "2-".
    if (!entry.name.startsWith("2-")) continue;
    const full = join(accountDir, entry.name);
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const recordPath = join(full, "RECORD.json");
    if (!existsSync(recordPath)) continue;
    try {
      const rec = JSON.parse(readFileSync(recordPath, "utf8")) as Conversation;
      convs.push(rec);
    } catch {
      // skip malformed records
    }
  }

  // Most recent activity first.
  convs.sort((a, b) => {
    const at = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bt = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    return bt - at;
  });

  return convs;
}

/** `urn:li:fs_event:(conv,2-MSG)` / `urn:li:messagingMessage:2-MSG` → `2-MSG`. */
function bareMessageId(urn: string): string {
  const comma = urn.lastIndexOf(",");
  if (comma >= 0) return urn.slice(comma + 1).replace(/\)$/, "");
  const colon = urn.lastIndexOf(":");
  return colon >= 0 ? urn.slice(colon + 1) : urn;
}

export function loadLastMessage(accountDir: string, convId: string): Message | null {
  const msgs = loadMessages(accountDir, convId, 1);
  return msgs.length ? (msgs[msgs.length - 1] ?? null) : null;
}

export function loadMessages(accountDir: string, convId: string, tailN?: number): Message[] {
  const msgDir = join(accountDir, convId, "messages");
  if (!existsSync(msgDir)) return [];
  const files = readdirSync(msgDir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .sort(); // chronological by YYYY-MM

  const parsed: Message[] = [];
  for (const f of files) {
    const lines = readFileSync(join(msgDir, f), "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(trimmed) as Message);
      } catch {
        // skip
      }
    }
  }
  parsed.sort((a, b) => a.timestamp - b.timestamp);
  // The sync rewrites a deleted message as RECALLED with an empty body; the
  // last line for an id wins, and a recalled one is dropped rather than shown
  // as a blank row.
  const byId = new Map<string, Message>();
  for (const m of parsed) byId.set(bareMessageId(m.urn), m);
  const out = [...byId.values()].filter((m) => m.renderFormat !== "RECALLED");
  if (tailN && out.length > tailN) return out.slice(out.length - tailN);
  return out;
}

// ---------------------------------------------------------------------------
// CLI shell-outs
// ---------------------------------------------------------------------------

type RunOptions = {
  account?: string;
  timeoutMs?: number;
};

function runAllman(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawnAllman(args, { account: opts.account });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const t = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          rejectP(new Error(`allman timed out: ${args.join(" ")}`));
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (t) clearTimeout(t);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      if (code !== 0) {
        rejectP(new Error(`allman exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolveP(stdout);
    });
  });
}

/**
 * Spawn allman in --json mode and stream NDJSON events to a callback.
 *
 * `allman sync --json` emits one JSON object per line on stdout. Each line is
 * forwarded to `onEvent` so callers can display progress as it arrives. The
 * returned promise resolves with the final summary event when the process
 * exits, or rejects on non-zero exit.
 */
function streamAllman(
  args: string[],
  opts: RunOptions & { onEvent?: (event: SyncEvent) => void } = {}
): Promise<SyncEvent | null> {
  return new Promise((resolveP, rejectP) => {
    const child = spawnAllman(args, { account: opts.account });

    let stdoutBuf = "";
    let stderr = "";
    let last: SyncEvent | null = null;
    const t = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          rejectP(new Error(`allman timed out: ${args.join(" ")}`));
        }, opts.timeoutMs)
      : null;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      while (true) {
        const nl = stdoutBuf.indexOf("\n");
        if (nl === -1) break;
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as SyncEvent;
          last = ev;
          opts.onEvent?.(ev);
        } catch {
          // ignore non-JSON noise (rare — listen/sync should always emit JSON in --json mode)
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (t) clearTimeout(t);
      rejectP(err);
    });
    child.on("close", (code) => {
      if (t) clearTimeout(t);
      if (code !== 0) {
        rejectP(new Error(`allman exited ${code}: ${stderr.trim() || "(no stderr)"}`));
        return;
      }
      resolveP(last);
    });
  });
}

function parseJsonOutput<T>(raw: string): T {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty allman output");
  return JSON.parse(trimmed) as T;
}

// ---------------------------------------------------------------------------
// Sync streaming events
// ---------------------------------------------------------------------------

/** Union of NDJSON events emitted by `allman sync --json`. */
export type SyncEvent =
  | {
      event: "sync.start";
      scope: "inbox" | "conversation";
      account: string;
      from: number;
      to: number;
      convId?: string;
      slug?: string | null;
      limit?: number | null;
    }
  | {
      event: "sync.conversation";
      account: string;
      convId: string;
      slug: string | null;
      name: string;
      conversationsSeen: number;
    }
  | {
      event: "sync.conversation.progress";
      convId: string;
      slug: string | null;
      messagesFetched: number;
      oldestMessageAt: number | null;
      newestMessageAt: number | null;
    }
  | {
      event: "sync.complete";
      scope: "inbox" | "conversation";
      account: string;
      conversationsSynced?: number;
      messagesSynced: number;
      convId?: string;
      slug?: string | null;
    };

export async function searchProfiles(
  query: string,
  opts: RunOptions & { limit?: number } = {}
): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const args = ["search", query, "--json"];
  if (opts.limit) args.push("--limit", String(opts.limit));
  const out = await runAllman(args, { ...opts, timeoutMs: 15_000 });
  return parseJsonOutput<SearchResult[]>(out);
}

export async function sendMessage(
  to: string,
  text: string,
  opts: RunOptions = {}
): Promise<unknown> {
  const out = await runAllman(["send", to, text, "--json"], { ...opts, timeoutMs: 30_000 });
  try {
    return parseJsonOutput<unknown>(out);
  } catch {
    return { ok: true, raw: out };
  }
}

export type ReactOptions = RunOptions & {
  /** Specific message URN to react to. Defaults to most recent in the conversation. */
  message?: string;
  /** Remove the reaction instead of adding. */
  unreact?: boolean;
};

/**
 * Add or remove an emoji reaction on a message via `allman react`.
 * `target` can be a slug, conversation URN, or LinkedIn URL.
 */
export async function reactToMessage(
  target: string,
  emoji: string,
  opts: ReactOptions = {}
): Promise<unknown> {
  const args = ["react", target, emoji, "--json"];
  if (opts.message) args.push("--message", opts.message);
  if (opts.unreact) args.push("--unreact");
  const out = await runAllman(args, { ...opts, timeoutMs: 15_000 });
  try {
    return parseJsonOutput<unknown>(out);
  } catch {
    return { ok: true, raw: out };
  }
}

export type SyncInboxOptions = RunOptions & {
  /** Older boundary — duration ("1mo") or ISO date. */
  from?: string;
  /** Newer boundary — duration or ISO date. Defaults to now. */
  to?: string;
  /** Max conversations to walk. */
  limit?: number;
  /** Stream NDJSON progress events as the sync runs. */
  onEvent?: (event: SyncEvent) => void;
  /** Full re-sync: upsert all fetched messages (fixes stale reactions, parser changes). */
  resync?: boolean;
};

export async function syncInbox(opts: SyncInboxOptions = {}): Promise<SyncEvent | null> {
  const args = ["sync", "--json"];
  if (opts.from) args.push("--from", opts.from);
  if (opts.to) args.push("--to", opts.to);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.resync) args.push("--resync");
  return streamAllman(args, { ...opts, timeoutMs: 600_000 });
}

export type SyncConversationOptions = RunOptions & {
  /** Older boundary. Defaults to "all of time" so backfill walks the whole history. */
  from?: string;
  /** Newer boundary. Defaults to now. */
  to?: string;
  /** Max messages to fetch in this run. */
  limit?: number;
  onEvent?: (event: SyncEvent) => void;
};

export async function syncConversation(
  convOrSlug: string,
  opts: SyncConversationOptions = {}
): Promise<SyncEvent | null> {
  const args = ["sync", convOrSlug, "--json"];
  if (opts.from) args.push("--from", opts.from);
  if (opts.to) args.push("--to", opts.to);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  return streamAllman(args, { ...opts, timeoutMs: 600_000 });
}

/** Legacy alias kept for callers that just want a fire-and-forget full sync. */
export async function syncAll(opts: RunOptions & { since?: string } = {}): Promise<void> {
  await syncInbox({ ...opts, from: opts.since });
}

// ---------------------------------------------------------------------------
// Live event stream via `allman listen`
// ---------------------------------------------------------------------------

export type ListenHandle = {
  stop: () => void;
};

export function startListen(
  onEvent: (e: ListenEvent) => void,
  onStatus: (s: "starting" | "connected" | "disconnected" | "error", info?: string) => void,
  opts: RunOptions = {}
): ListenHandle {
  onStatus("starting");
  const child = spawnAllman(["listen"], { account: opts.account });

  let stopped = false;
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as ListenEvent;
        if (ev.event === "connected") onStatus("connected");
        onEvent(ev);
      } catch {
        // ignore non-JSON noise
      }
    }
  });
  child.stderr?.on("data", () => {
    // listen logs to stderr; intentionally swallowed.
  });
  child.on("close", () => {
    if (!stopped) onStatus("disconnected");
  });
  child.on("error", (err) => {
    onStatus("error", err.message);
  });

  return {
    stop: () => {
      stopped = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Network: connections, enrichment, and connection requests
// ---------------------------------------------------------------------------

/**
 * A stored connection record, as written by `allman connections` / `enrich`.
 * Read straight off disk — enrichment fields are absent until enriched.
 */
export type StoredConnection = {
  flagshipId: string;
  publicIdentifier: string | null;
  firstName?: string | null;
  lastName?: string | null;
  headline?: string | null;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  about?: string | null;
  enrichedAt?: string | null;
  enrichDepth?: "core" | "deep" | null;
  /** "connections" from a real sweep; "enrich" for ad-hoc lookups. */
  source?: "connections" | "enrich";
};

/**
 * Read one connection record by slug or flagship id. Pure filesystem read —
 * the slug symlink resolves to the same file, so either key works.
 * Returns null when the person isn't in the store.
 */
export function loadConnection(accountDir: string, slugOrId: string): StoredConnection | null {
  const dir = join(accountDir, "connections");
  for (const name of [`${slugOrId}.json`, slugOrId]) {
    const path = join(dir, name);
    try {
      if (!existsSync(path)) continue;
      return JSON.parse(readFileSync(path, "utf8")) as StoredConnection;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/** A one-line "Title at Company — Location" summary, or null if unenriched. */
export function formatConnectionSummary(c: StoredConnection | null): string | null {
  if (!c) return null;
  const role = [c.title, c.company].filter(Boolean).join(" at ");
  const parts = [role || c.headline, c.location].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : null;
}

export type ConnectionsOptions = RunOptions & {
  limit?: number;
  /** Opt into the Sales Navigator backend (capped at 2500 results). */
  salesnav?: boolean;
};

/** Pull the 1st-degree connection list via `allman connections`. */
export async function pullConnections(opts: ConnectionsOptions = {}): Promise<string> {
  const args = ["connections"];
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.salesnav) args.push("--salesnav");
  return runAllman(args, { ...opts, timeoutMs: 600_000 });
}

export type EnrichOptions = RunOptions & {
  /** A slug/URL/URN to enrich one person; omit to enrich stored connections. */
  target?: string;
  limit?: number;
  deep?: boolean;
  force?: boolean;
};

/** Fill in profile fields via `allman enrich`. */
export async function enrichConnections(opts: EnrichOptions = {}): Promise<string> {
  const args = ["enrich"];
  if (opts.target) args.push(opts.target);
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.deep) args.push("--deep");
  if (opts.force) args.push("--force");
  return runAllman(args, { ...opts, timeoutMs: 600_000 });
}

export type ConnectOptions = RunOptions & {
  /** Personalized note, max 300 chars (LinkedIn's cap). */
  note?: string;
  /** Preview without sending. */
  dryRun?: boolean;
};

/**
 * Send a connection request via `allman connect`.
 *
 * Outbound and irreversible, so this is a thin pass-through: the binary owns
 * the duplicate guards, the 300-char cap, and the daily invitation quota. The
 * TUI must not try to re-implement or bypass any of them.
 */
export async function sendConnectionRequest(
  target: string,
  opts: ConnectOptions = {}
): Promise<unknown> {
  const args = ["connect", target];
  if (opts.note) args.push("--note", opts.note);
  if (opts.dryRun) args.push("--dry-run");
  args.push("--json");
  const out = await runAllman(args, { ...opts, timeoutMs: 120_000 });
  try {
    return parseJsonOutput<unknown>(out);
  } catch {
    return { ok: true, raw: out };
  }
}
