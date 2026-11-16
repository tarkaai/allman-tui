import { execSync } from "node:child_process";
import { watch } from "node:fs";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "./components/Composer.tsx";
import { Help } from "./components/Help.tsx";
import { NewConversation } from "./components/NewConversation.tsx";
import { ReactionPicker } from "./components/ReactionPicker.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar, type SyncActivity } from "./components/StatusBar.tsx";
import { TemplateManager } from "./components/TemplateManager.tsx";
import { TemplatePicker } from "./components/TemplatePicker.tsx";
import { Thread } from "./components/Thread.tsx";
import {
  enrichConnections,
  formatConnectionSummary,
  type ListenHandle,
  loadConnection,
  loadConversations,
  loadLastMessage,
  loadMessages,
  pullConnections,
  reactToMessage,
  readAccountAuth,
  resolveSlugToConvId,
  type SyncEvent,
  sendConnectionRequest,
  sendMessage,
  startListen,
  syncConversation,
  syncInbox,
} from "./lib/allman.ts";
import { loadTemplates, saveTemplates, type Template } from "./lib/templates.ts";
import type { Account, Conversation, ListenEvent, Message, SearchResult } from "./lib/types.ts";

export type Mode =
  | "browse"
  | "compose"
  | "search"
  | "new"
  | "command"
  | "help"
  | "templatePick"
  | "templateManage"
  | "messageSelect"
  | "reactionPick";

function openUrl(url: string): void {
  try {
    // macOS
    execSync(`open ${JSON.stringify(url)}`, { stdio: "ignore" });
  } catch {
    // Fallback: try xdg-open (Linux)
    try {
      execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: "ignore" });
    } catch {
      /* silently fail */
    }
  }
}

type Props = { account: Account };

export function App({ account }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cols, setCols] = useState(stdout.columns || 120);
  const [rows, setRows] = useState(stdout.rows || 36);

  useEffect(() => {
    const onResize = () => {
      setCols(stdout.columns || 120);
      setRows(stdout.rows || 36);
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadConversations(account.dir)
  );
  const [lastMessages, setLastMessages] = useState<Map<string, Message | null>>(() => {
    const m = new Map<string, Message | null>();
    for (const c of loadConversations(account.dir)) {
      m.set(c.convId, loadLastMessage(account.dir, c.convId));
    }
    return m;
  });

  const [cursorIdx, setCursorIdx] = useState(0);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(
    conversations[0]?.convId ?? null
  );
  const [messages, setMessages] = useState<Message[]>(() =>
    conversations[0] ? loadMessages(account.dir, conversations[0].convId) : []
  );
  const [scrollOffset, setScrollOffset] = useState(0);

  const [mode, setMode] = useState<Mode>("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [composeText, setComposeText] = useState("");
  const [commandText, setCommandText] = useState("");
  const [sending, setSending] = useState(false);
  // Index into `messages` for the react flow's message cursor. Null outside
  // the messageSelect/reactionPick modes.
  const [messageCursorIdx, setMessageCursorIdx] = useState<number | null>(null);
  const [reacting, setReacting] = useState(false);
  // Live sync activity. Multi-account aware: keyed by account slug so future
  // multi-account UIs can show one in the foreground while others run in the
  // background. The current single-account TUI just reads activityByAccount[account.slug].
  const [activityByAccount, setActivityByAccount] = useState<Record<string, SyncActivity | null>>(
    {}
  );
  const syncActivity = activityByAccount[account.slug] ?? null;
  const setSyncActivity = useCallback((slug: string, next: SyncActivity | null) => {
    setActivityByAccount((prev) => {
      if (next === null && !(slug in prev)) return prev;
      return { ...prev, [slug]: next };
    });
  }, []);

  // Backfill bookkeeping — which conversations have already been auto-backfilled
  // this session, and which is currently in flight (so we don't double-trigger).
  const backfilledRef = useRef<Set<string>>(new Set());
  const backfillingRef = useRef<Set<string>>(new Set());

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Quick-reply templates. Stored in ~/.config/allman-tui/templates.json —
  // TUI-local, not in the allman store, because templates are UX metadata
  // rather than LinkedIn state.
  const [templates, setTemplates] = useState<Template[]>(() => loadTemplates());
  const updateTemplates = useCallback((next: Template[]) => {
    setTemplates(next);
    try {
      saveTemplates(next);
    } catch (e) {
      setToast(`failed to save templates: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  // Track listen freshness so the status bar can show a meaningful "live" dot.
  // `lastBeatAt` ticks on every heartbeat, message, or read receipt — anything
  // that proves the SSE channel is still flowing.
  const [listenStatus, setListenStatus] = useState<
    "starting" | "connected" | "disconnected" | "error" | "off"
  >("off");
  const [lastBeatAt, setLastBeatAt] = useState<number | null>(null);
  const listenRef = useRef<ListenHandle | null>(null);

  // lastSyncAt is mirrored from AUTH.json — bump it whenever a sync run completes
  // so the freshness indicator updates without a full reload.
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(account.auth.lastSyncAt ?? null);
  const refreshAccountAuth = useCallback(() => {
    const auth = readAccountAuth(account.dir);
    if (auth?.lastSyncAt) setLastSyncAt(auth.lastSyncAt);
  }, [account.dir]);

  // Tick every second so sub-minute relative times ("5s", "30s") progress
  // smoothly in the status bar. Ink re-renders are cheap and only the
  // StatusBar depends on this, so the cost is negligible.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const showToast = useCallback((msg: string, ms = 3500) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // ----- Filtering -----
  const filtered = useMemo<Conversation[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((c) => {
      const hay = `${c.name || ""}|${c.slug || ""}|${c.headline || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [conversations, searchQuery]);

  // Keep cursor in bounds.
  useEffect(() => {
    if (cursorIdx > filtered.length - 1) setCursorIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursorIdx]);

  // When the cursor in the sidebar changes (in browse), load the corresponding
  // conversation. We update selectedConvId on Enter, but we also auto-preview.
  const previewConv = filtered[cursorIdx] ?? null;
  useEffect(() => {
    if (!previewConv) return;
    if (previewConv.convId === selectedConvId) return;
    setSelectedConvId(previewConv.convId);
    setMessages(loadMessages(account.dir, previewConv.convId));
    setScrollOffset(0);
  }, [previewConv, selectedConvId, account.dir]);

  // ----- Reload from disk -----
  const reload = useCallback(() => {
    const next = loadConversations(account.dir);
    setConversations(next);
    const lm = new Map<string, Message | null>();
    for (const c of next) lm.set(c.convId, loadLastMessage(account.dir, c.convId));
    setLastMessages(lm);
    if (selectedConvId) {
      setMessages(loadMessages(account.dir, selectedConvId));
      // Keep cursor tracking the selected conversation after re-sort.
      // Without this, sending a message (which bumps lastActivityAt → index 0)
      // leaves cursorIdx at the old position, and the auto-preview effect
      // overwrites selectedConvId with whatever now sits at that index.
      const idx = next.findIndex((c) => c.convId === selectedConvId);
      if (idx >= 0) setCursorIdx(idx);
    }
  }, [account.dir, selectedConvId]);

  // The listen subprocess is started exactly once per account. We funnel its
  // events through stable refs so the effect doesn't have to depend on the
  // (re-created on every render) reload/showToast callbacks.
  const reloadRef = useRef(reload);
  const showToastRef = useRef(showToast);
  const refreshAuthRef = useRef(refreshAccountAuth);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  useEffect(() => {
    showToastRef.current = showToast;
  }, [showToast]);
  useEffect(() => {
    refreshAuthRef.current = refreshAccountAuth;
  }, [refreshAccountAuth]);

  // ----- Filesystem watch -----
  // Catches out-of-band writes to the store — e.g. the user runs `allman sync`
  // or `allman send` from another terminal while the TUI is open. Listen events
  // and our own sync handlers already cover the in-process paths; this just
  // closes the gap for external CLI invocations. Debounce coalesces bursts
  // (e.g. a sync writing many messages in quick succession) into a single
  // reload, and overlaps harmlessly with the explicit reload calls elsewhere.
  useEffect(() => {
    let debounceT: ReturnType<typeof setTimeout> | null = null;
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(account.dir, { recursive: true }, () => {
        if (debounceT) clearTimeout(debounceT);
        debounceT = setTimeout(() => {
          debounceT = null;
          reloadRef.current();
          refreshAuthRef.current();
        }, 250);
      });
      watcher.on("error", () => {
        // swallow — fs.watch can be flaky on some platforms; the listen
        // subprocess + manual `R` are the safety net.
      });
    } catch {
      // ignore — recursive watch may not be supported (linux without inotify, etc.)
    }
    return () => {
      if (debounceT) clearTimeout(debounceT);
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    };
  }, [account.dir]);

  // ----- Listen subprocess -----
  // Opt-out via ALLMAN_TUI_LISTEN=0 (or =false). Enabled by default so the TUI
  // behaves like a real messenger inbox out of the box.
  useEffect(() => {
    const flag = (process.env.ALLMAN_TUI_LISTEN || "").toLowerCase();
    if (flag === "0" || flag === "false" || flag === "off") {
      setListenStatus("off");
      return;
    }
    listenRef.current = startListen(
      (ev: ListenEvent) => {
        // Anything coming through proves the channel is alive — heartbeats
        // arrive every ~30s so this doubles as a freshness signal.
        setLastBeatAt(Date.now());
        if (
          ev.event === "message.received" ||
          ev.event === "message.sent" ||
          ev.event === "read_receipt" ||
          ev.event === "reaction"
        ) {
          // small delay so the JSONL flush completes
          setTimeout(() => reloadRef.current(), 350);
          if (ev.event === "message.received" && ev.from?.name) {
            showToastRef.current(`new message from ${ev.from.name}`);
          }
        }
      },
      (status, info) => {
        setListenStatus(status);
        if (status === "connected") setLastBeatAt(Date.now());
        if (status === "error" && info) showToastRef.current(`listen error: ${info}`);
      },
      { account: account.slug }
    );
    return () => {
      listenRef.current?.stop();
      listenRef.current = null;
    };
  }, [account.slug]);

  // ----- Sync -----
  // Streaming sync — subscribes to NDJSON progress events from `allman sync --json`
  // and threads them through into the status bar so the user sees live counts.
  const doSyncInbox = useCallback(
    async (
      opts: { from?: string; to?: string; limit?: number; quiet?: boolean; resync?: boolean } = {}
    ) => {
      if (syncActivity) return;
      const slug = account.slug;
      const startActivity: SyncActivity = {
        scope: "inbox",
        label: "inbox",
        messagesFetched: 0,
        conversationsSeen: 0,
      };
      setSyncActivity(slug, startActivity);
      if (!opts.quiet) showToast("syncing inbox…", 60_000);

      // Per-conversation message tallies, so the running total reflects the
      // sum across all conversations seen this run rather than the latest
      // page count alone.
      const perConv = new Map<string, number>();
      try {
        await syncInbox({
          account: slug,
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
          resync: opts.resync,
          onEvent: (ev: SyncEvent) => {
            if (ev.event === "sync.conversation") {
              setSyncActivity(slug, {
                scope: "inbox",
                label: ev.slug ?? ev.name ?? "inbox",
                messagesFetched: Array.from(perConv.values()).reduce((a, b) => a + b, 0),
                conversationsSeen: ev.conversationsSeen,
              });
            } else if (ev.event === "sync.conversation.progress") {
              perConv.set(ev.convId, ev.messagesFetched);
              const total = Array.from(perConv.values()).reduce((a, b) => a + b, 0);
              setSyncActivity(slug, {
                scope: "inbox",
                label: ev.slug ?? "inbox",
                messagesFetched: total,
                conversationsSeen: perConv.size,
              });
              // Pull the new messages onto the screen as we go.
              reloadRef.current();
            } else if (ev.event === "sync.complete") {
              if (!opts.quiet) {
                showToast(`synced ${ev.conversationsSynced ?? 0}c · ${ev.messagesSynced} new msgs`);
              }
            }
          },
        });
        reloadRef.current();
        refreshAccountAuth();
      } catch (e) {
        showToast(`sync failed: ${e instanceof Error ? e.message : e}`, 6000);
      } finally {
        setSyncActivity(slug, null);
      }
    },
    [account.slug, refreshAccountAuth, setSyncActivity, showToast, syncActivity]
  );

  const doSyncOne = useCallback(
    async (target: string, opts: { quiet?: boolean; limit?: number } = {}) => {
      const slug = account.slug;
      // Don't start a backfill on top of an existing one for the same conv —
      // but allow it concurrent with an inbox sync.
      const key = `${slug}:${target}`;
      if (backfillingRef.current.has(key)) return;
      backfillingRef.current.add(key);

      const start: SyncActivity = {
        scope: "conversation",
        label: target,
        messagesFetched: 0,
      };
      setSyncActivity(slug, start);
      if (!opts.quiet) showToast(`backfilling ${target}…`, 60_000);

      try {
        await syncConversation(target, {
          account: slug,
          limit: opts.limit,
          onEvent: (ev: SyncEvent) => {
            if (ev.event === "sync.conversation.progress") {
              setSyncActivity(slug, {
                scope: "conversation",
                label: ev.slug ?? target,
                messagesFetched: ev.messagesFetched,
              });
              reloadRef.current();
            } else if (ev.event === "sync.complete") {
              if (!opts.quiet) {
                showToast(`backfill complete: ${ev.messagesSynced} msgs`);
              }
            }
          },
        });
        reloadRef.current();
        refreshAccountAuth();
        backfilledRef.current.add(key);
      } catch (e) {
        if (!opts.quiet) {
          showToast(`backfill failed: ${e instanceof Error ? e.message : e}`, 6000);
        }
      } finally {
        backfillingRef.current.delete(key);
        setSyncActivity(slug, null);
      }
    },
    [account.slug, refreshAccountAuth, setSyncActivity, showToast]
  );

  // ----- Auto-sync on every launch -----
  // Pull inbox updates from LinkedIn once on mount so the user never has to
  // hit `r` manually just to catch up after reopening. The TUI is a pure
  // viewer — it does not extend the sync window or otherwise second-guess
  // the CLI. Fresh accounts (no lastSyncAt) get a one-month backfill so the
  // inbox isn't empty; everything else rides on the CLI's incremental logic.
  const doSyncInboxRef = useRef(doSyncInbox);
  useEffect(() => {
    doSyncInboxRef.current = doSyncInbox;
  }, [doSyncInbox]);
  const autoSyncedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run-once-on-mount
  useEffect(() => {
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    const freshAccount = !lastSyncAt;
    if (freshAccount) {
      showToastRef.current("first run — pulling the last month from LinkedIn…", 60_000);
      void doSyncInboxRef.current({ from: "1mo", quiet: true });
    } else {
      // On launch, always widen to a 1-day window so we pull anything listen
      // might have missed during recent disconnects (lastSyncAt can otherwise
      // be seconds-fresh and exclude real backlog).
      void doSyncInboxRef.current({ from: "1d", quiet: true });
    }
  }, []);

  // ----- Auto-backfill on conversation open -----
  // The first time the user opens a conversation that hasn't been fully
  // backfilled, kick off a single-conversation sync to walk it back to the
  // first message. Backfilling is rate-limited inside the CLI; concurrent
  // backfills queue at the download limiter.
  useEffect(() => {
    const conv = conversations.find((c) => c.convId === selectedConvId);
    if (!conv) return;
    if (conv.convId.startsWith("pending:")) return; // placeholder, not in store yet
    if (conv.syncState?.fullyBackfilled) return;
    const target = conv.convId;
    const key = `${account.slug}:${target}`;
    if (backfilledRef.current.has(key)) return;
    if (backfillingRef.current.has(key)) return;
    void doSyncOne(target, { quiet: true });
  }, [selectedConvId, conversations, account.slug, doSyncOne]);

  // ----- Send -----
  const doSend = useCallback(
    async (body: string) => {
      const conv = conversations.find((c) => c.convId === selectedConvId);
      if (!conv) {
        showToast("no conversation selected");
        return;
      }
      // The thread itself, not the contact's slug: a slug is an alias the CLI
      // resolves on its own, and a wrong one lands in another conversation.
      // Only a not-yet-stored thread (no URN) is addressed by slug.
      const target = conv.backendUrn || conv.slug || conv.convId;
      setSending(true);
      try {
        await sendMessage(target, body, { account: account.slug });
        setComposeText("");
        setMode("browse");
        showToast("message sent");
        // give the CLI a moment to flush + commit, then reload
        setTimeout(reload, 500);
      } catch (e) {
        showToast(`send failed: ${e instanceof Error ? e.message : e}`, 6000);
      } finally {
        setSending(false);
      }
    },
    [conversations, selectedConvId, account.slug, reload, showToast]
  );

  // ----- React -----
  const doReact = useCallback(
    async (emoji: string, unreact: boolean) => {
      const conv = conversations.find((c) => c.convId === selectedConvId);
      if (!conv) {
        showToast("no conversation selected");
        return;
      }
      if (messageCursorIdx === null) {
        showToast("no message selected");
        return;
      }
      const msg = messages[messageCursorIdx];
      if (!msg) {
        showToast("no message selected");
        return;
      }
      // The thread itself, not the contact's slug: a slug is an alias the CLI
      // resolves on its own, and a wrong one lands in another conversation.
      // Only a not-yet-stored thread (no URN) is addressed by slug.
      const target = conv.backendUrn || conv.slug || conv.convId;
      setReacting(true);
      try {
        await reactToMessage(target, emoji, {
          account: account.slug,
          message: msg.urn,
          unreact,
        });
        showToast(unreact ? `removed ${emoji}` : `reacted ${emoji}`);
        // Let the CLI finish its git commit, then reload so the updated
        // reactions surface without waiting for the next listen heartbeat.
        setTimeout(reload, 400);
      } catch (e) {
        showToast(`react failed: ${e instanceof Error ? e.message : e}`, 6000);
      } finally {
        setReacting(false);
        setMode("browse");
        setMessageCursorIdx(null);
      }
    },
    [conversations, selectedConvId, messages, messageCursorIdx, account.slug, reload, showToast]
  );

  // Reset the message cursor whenever the conversation changes so we don't
  // carry an index into a mismatched message list. Biome's exhaustive-deps
  // rule flags `selectedConvId` as "unused" inside the effect body, but we
  // genuinely want the effect to re-fire on every change — the identifier IS
  // the trigger.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useEffect(() => {
    setMessageCursorIdx(null);
  }, [selectedConvId]);

  // ----- New conversation pick -----
  const onPickNew = useCallback(
    (r: SearchResult) => {
      // If there's already a thread, jump to it. Otherwise, set up a stub
      // selection (no convId in store yet) and let the user compose; the
      // first send will create the thread on LinkedIn.
      if (r.convId) {
        const idx = conversations.findIndex((c) => c.convId === r.convId);
        if (idx >= 0) {
          setCursorIdx(idx);
          setSelectedConvId(r.convId);
          setMessages(loadMessages(account.dir, r.convId));
          setScrollOffset(0);
          setMode("browse");
          showToast(`opened ${r.name}`);
          return;
        }
        // The convId might exist on disk but not be in the in-memory list yet.
        const fromDisk = loadMessages(account.dir, r.convId);
        if (fromDisk.length > 0) {
          setSelectedConvId(r.convId);
          setMessages(fromDisk);
          setMode("browse");
          showToast(`opened ${r.name}`);
          return;
        }
      }
      // Try resolving via slug symlink as a last resort.
      if (r.slug) {
        const cid = resolveSlugToConvId(account.dir, r.slug);
        if (cid) {
          setSelectedConvId(cid);
          setMessages(loadMessages(account.dir, cid));
          setMode("browse");
          showToast(`opened ${r.name}`);
          return;
        }
      }
      // Brand new conversation: synthesize a placeholder and let the user
      // compose. The first send will go via slug.
      if (r.slug) {
        const placeholder: Conversation = {
          convId: `pending:${r.slug}`,
          profileId: r.profileId,
          slug: r.slug,
          convUrn: "",
          backendUrn: "",
          profileUrn: "",
          firstName: r.name.split(" ")[0] ?? r.name,
          lastName: r.name.split(" ").slice(1).join(" ") || null,
          name: r.name,
          headline: "(new conversation — type a message and hit Enter)",
          unreadCount: 0,
          lastActivityAt: new Date().toISOString(),
          lastReadAt: null,
          read: true,
        };
        setConversations((prev) => [placeholder, ...prev]);
        setSelectedConvId(placeholder.convId);
        setMessages([]);
        setCursorIdx(0);
        setMode("compose");
        showToast(`drafting to ${r.name}`);
      } else {
        showToast("can't open: no slug available");
      }
    },
    [conversations, account.dir, showToast]
  );

  // ----- Keybindings -----
  useInput(
    (input, key) => {
      // Mode-specific overrides come first.
      if (mode === "search") {
        if (key.escape) {
          setMode("browse");
          setSearchQuery("");
          return;
        }
        if (key.return) {
          setMode("browse");
          return;
        }
        return; // TextInput handles characters
      }
      if (mode === "compose") {
        if (key.escape) {
          setMode("browse");
          return;
        }
        return; // TextInput handles characters; submit fires onSubmit
      }
      if (mode === "command") {
        if (key.escape) {
          setMode("browse");
          setCommandText("");
          return;
        }
        return;
      }
      if (mode === "new") {
        if (key.escape) {
          setMode("browse");
          return;
        }
        return;
      }
      if (mode === "help") {
        if (key.escape || input === "?" || input === "q") {
          setMode("browse");
          return;
        }
        return;
      }
      if (mode === "templatePick" || mode === "templateManage") {
        // Both overlays own their own keybindings via the embedded useInput.
        // We only need to make sure App-level keys don't fire underneath.
        return;
      }
      if (mode === "reactionPick") {
        // ReactionPicker owns its own keybindings.
        return;
      }
      if (mode === "messageSelect") {
        if (key.escape) {
          setMode("browse");
          setMessageCursorIdx(null);
          return;
        }
        if (key.return) {
          if (messageCursorIdx !== null && messages[messageCursorIdx]) {
            setMode("reactionPick");
          }
          return;
        }
        // j = newer (increment), k = older (decrement). Messages are sorted
        // oldest-first so the newest sits at the last index.
        if (key.downArrow || input === "j") {
          setMessageCursorIdx((c) =>
            c === null ? messages.length - 1 : Math.min(messages.length - 1, c + 1)
          );
          return;
        }
        if (key.upArrow || input === "k") {
          setMessageCursorIdx((c) => (c === null ? messages.length - 1 : Math.max(0, c - 1)));
          return;
        }
        if (input === "g") {
          setMessageCursorIdx(0);
          return;
        }
        if (input === "G") {
          setMessageCursorIdx(messages.length - 1);
          return;
        }
        return;
      }

      // browse mode
      if (input === "q") {
        listenRef.current?.stop();
        exit();
        return;
      }
      if (input === "?") {
        setMode("help");
        return;
      }
      if (input === "/") {
        setMode("search");
        return;
      }
      if (input === "n") {
        setMode("new");
        return;
      }
      if (input === "i") {
        if (selectedConvId) setMode("compose");
        return;
      }
      if (input === "x") {
        // Start a reaction flow: select a message, then pick an emoji.
        if (!selectedConvId) {
          showToast("select a conversation first");
          return;
        }
        if (messages.length === 0) {
          showToast("no messages to react to");
          return;
        }
        setMessageCursorIdx(messages.length - 1);
        setMode("messageSelect");
        return;
      }
      if (input === "t") {
        // Quick-reply picker. Requires a selected conversation so the
        // rendered preview can substitute {firstName} etc.
        if (!selectedConvId) {
          showToast("select a conversation first");
          return;
        }
        setMode("templatePick");
        return;
      }
      if (input === "T") {
        setMode("templateManage");
        return;
      }
      if (input === ":") {
        setMode("command");
        return;
      }
      if (input === "r") {
        // Manual sync. Force a 1-day window instead of inheriting the CLI's
        // lastSyncAt default — avoids missing messages sent during brief
        // listen-subprocess disconnects where lastSyncAt has advanced past
        // the message we actually care about.
        void doSyncInbox({ from: "1d" });
        return;
      }
      if (input === "R") {
        // Full re-sync over a generous 7-day window. Bypasses knownNewestAt
        // dedup so all fetched messages are upserted — heals stale reactions,
        // parser fixes, and anything listen missed during recent outages.
        void doSyncInbox({ from: "7d", resync: true });
        return;
      }
      if (input === "o") {
        // Open the contact's LinkedIn profile in the browser.
        if (conv?.slug) {
          openUrl(`https://www.linkedin.com/in/${conv.slug}/`);
          showToast(`opened ${conv.slug}'s profile`);
        } else {
          showToast("no profile slug available");
        }
        return;
      }
      if (input === "O") {
        // Open the LinkedIn messenger thread in the browser.
        if (selectedConvId) {
          openUrl(`https://www.linkedin.com/messaging/thread/${selectedConvId}/`);
          showToast("opened thread in LinkedIn");
        } else {
          showToast("no conversation selected");
        }
        return;
      }
      if (input === "g") {
        setCursorIdx(0);
        return;
      }
      if (input === "G") {
        setCursorIdx(Math.max(0, filtered.length - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setCursorIdx((c) => Math.min(filtered.length - 1, c + 1));
        return;
      }
      if (key.upArrow || input === "k") {
        setCursorIdx((c) => Math.max(0, c - 1));
        return;
      }
      if (key.pageDown) {
        setScrollOffset((s) => Math.max(0, s - 10));
        return;
      }
      if (key.pageUp) {
        setScrollOffset((s) => s + 10);
        return;
      }
      if (key.return) {
        // open the conversation under the cursor (already auto-previewed,
        // but Enter forces selection + scroll reset).
        const c = filtered[cursorIdx];
        if (c) {
          setSelectedConvId(c.convId);
          setMessages(loadMessages(account.dir, c.convId));
          setScrollOffset(0);
        }
        return;
      }
    },
    {
      isActive:
        mode !== "new" &&
        mode !== "templatePick" &&
        mode !== "templateManage" &&
        mode !== "reactionPick",
    }
  );

  // ----- Command palette runner -----
  const runCommand = useCallback(
    (raw: string) => {
      const cmd = raw.trim().replace(/^:/, "");
      setCommandText("");
      setMode("browse");
      if (!cmd) return;
      if (cmd === "quit" || cmd === "q") {
        listenRef.current?.stop();
        exit();
        return;
      }
      if (cmd === "reload" || cmd === "r") {
        reload();
        showToast("reloaded from store");
        return;
      }
      if (cmd === "sync") {
        void doSyncInbox();
        return;
      }
      if (cmd.startsWith("sync ")) {
        const rest = cmd.slice(5).trim();
        // Forms supported:
        //   sync <slug>            → backfill that conversation
        //   sync inbox 1mo         → inbox sync with --from 1mo
        //   sync inbox 1mo 100     → inbox sync with --from 1mo --limit 100
        if (rest.startsWith("inbox")) {
          const parts = rest.split(/\s+/).slice(1);
          const from = parts[0];
          const limit = parts[1] ? parseInt(parts[1], 10) : undefined;
          void doSyncInbox({ from, limit });
        } else {
          void doSyncOne(rest);
        }
        return;
      }
      if (cmd === "backfill") {
        if (selectedConvId) {
          const conv = conversations.find((c) => c.convId === selectedConvId);
          const target = selectedConvId.startsWith("pending:")
            ? (conv?.slug ?? selectedConvId)
            : selectedConvId;
          void doSyncOne(target);
        } else {
          showToast("no conversation selected");
        }
        return;
      }
      if (cmd === "help" || cmd === "?") {
        setMode("help");
        return;
      }
      if (cmd === "templates" || cmd === "t") {
        setMode("templateManage");
        return;
      }
      // ----- Network commands -----
      // These shell out to the binary, which owns rate limits, volume quotas
      // and duplicate guards. Never re-implement those here.
      if (cmd === "connections" || cmd.startsWith("connections ")) {
        const rest = cmd.slice("connections".length).trim();
        const salesnav = /\bsalesnav\b/.test(rest);
        const limit = /(\d+)/.exec(rest)?.[1];
        showToast("pulling connections…");
        void pullConnections({ limit: limit ? parseInt(limit, 10) : undefined, salesnav })
          .then(() => {
            reload();
            showToast("connections updated");
          })
          .catch((e: unknown) => showToast(`connections failed: ${String(e)}`));
        return;
      }
      if (cmd === "enrich" || cmd.startsWith("enrich ")) {
        const parts = cmd.split(/\s+/).slice(1);
        const deep = parts.includes("deep");
        const rest = parts.filter((p) => p !== "deep");
        const numeric = rest.find((p) => /^\d+$/.test(p));
        const target = rest.find((p) => !/^\d+$/.test(p));
        showToast(target ? `enriching ${target}…` : "enriching connections…");
        void enrichConnections({
          target,
          deep,
          limit: numeric ? parseInt(numeric, 10) : undefined,
        })
          .then(() => {
            reload();
            showToast("enrichment complete");
          })
          .catch((e: unknown) => showToast(`enrich failed: ${String(e)}`));
        return;
      }
      if (cmd.startsWith("connect ")) {
        // :connect <slug> [note...]  — note is everything after the slug.
        const rest = cmd.slice("connect ".length).trim();
        const [target, ...noteWords] = rest.split(/\s+/);
        if (!target) {
          showToast("usage: :connect <slug> [note]");
          return;
        }
        const note = noteWords.join(" ").trim() || undefined;
        if (note && note.length > 300) {
          showToast(`note is ${note.length} chars — LinkedIn caps notes at 300`);
          return;
        }
        showToast(`sending request to ${target}…`);
        void sendConnectionRequest(target, { note })
          .then(() => showToast(`connection request sent to ${target}`))
          .catch((e: unknown) => showToast(`connect failed: ${String(e)}`));
        return;
      }
      showToast(`unknown command: :${cmd}`);
    },
    [reload, showToast, doSyncInbox, doSyncOne, exit, selectedConvId, conversations]
  );

  // ----- Layout -----
  const sidebarWidth = Math.max(28, Math.min(42, Math.floor(cols * 0.32)));
  const threadWidth = cols - sidebarWidth - 1; // 1 col divider
  const statusHeight = 1;
  const pickerHeight = Math.min(10, Math.max(5, Math.floor(rows * 0.3)));
  const composerHeight = mode === "reactionPick" ? pickerHeight : 1;
  const dividerHeight = 1;
  const bodyHeight = Math.max(8, rows - statusHeight - composerHeight - dividerHeight - 1);

  const conv = conversations.find((c) => c.convId === selectedConvId) ?? null;

  // Enrichment summary for the open thread, read straight from the
  // connections store. Cheap (one file read) and re-evaluated when the
  // selection changes or a `:enrich` run triggers a reload.
  const profileSummary = useMemo(() => {
    const key = conv?.slug ?? conv?.profileId;
    if (!key) return null;
    return formatConnectionSummary(loadConnection(account.dir, key));
  }, [conv?.slug, conv?.profileId, account.dir]);

  // Modal: full-screen overlay for new conversation and help.
  if (mode === "help") {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <Help width={cols} height={rows - statusHeight} />
        <StatusBar
          mode={mode}
          accountSlug={account.slug}
          totalConvs={conversations.length}
          unreadConvs={conversations.filter((c) => c.unreadCount > 0).length}
          listenStatus={listenStatus}
          lastBeatAt={lastBeatAt}
          lastSyncAt={lastSyncAt}
          syncActivity={syncActivity}
          toast={toast}
          width={cols}
        />
      </Box>
    );
  }

  if (mode === "new") {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <NewConversation
          width={cols}
          height={rows - statusHeight}
          onCancel={() => setMode("browse")}
          onPick={onPickNew}
        />
        <StatusBar
          mode={mode}
          accountSlug={account.slug}
          totalConvs={conversations.length}
          unreadConvs={conversations.filter((c) => c.unreadCount > 0).length}
          listenStatus={listenStatus}
          lastBeatAt={lastBeatAt}
          lastSyncAt={lastSyncAt}
          syncActivity={syncActivity}
          toast={toast}
          width={cols}
        />
      </Box>
    );
  }

  if (mode === "templatePick") {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <TemplatePicker
          templates={templates}
          conv={conv}
          width={cols}
          height={rows - statusHeight}
          onCancel={() => setMode("browse")}
          onManage={() => setMode("templateManage")}
          onPick={(renderedBody) => {
            setComposeText(renderedBody);
            setMode("compose");
          }}
        />
        <StatusBar
          mode={mode}
          accountSlug={account.slug}
          totalConvs={conversations.length}
          unreadConvs={conversations.filter((c) => c.unreadCount > 0).length}
          listenStatus={listenStatus}
          lastBeatAt={lastBeatAt}
          lastSyncAt={lastSyncAt}
          syncActivity={syncActivity}
          toast={toast}
          width={cols}
        />
      </Box>
    );
  }

  // reactionPick is rendered inline in the main layout (below).

  if (mode === "templateManage") {
    return (
      <Box flexDirection="column" width={cols} height={rows}>
        <TemplateManager
          templates={templates}
          width={cols}
          height={rows - statusHeight}
          onClose={() => setMode("browse")}
          onChange={updateTemplates}
        />
        <StatusBar
          mode={mode}
          accountSlug={account.slug}
          totalConvs={conversations.length}
          unreadConvs={conversations.filter((c) => c.unreadCount > 0).length}
          listenStatus={listenStatus}
          lastBeatAt={lastBeatAt}
          lastSyncAt={lastSyncAt}
          syncActivity={syncActivity}
          toast={toast}
          width={cols}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {/* main split */}
      <Box width={cols} height={bodyHeight}>
        <Sidebar
          conversations={conversations}
          filtered={filtered}
          selectedConvId={selectedConvId}
          cursorIdx={cursorIdx}
          searchActive={mode === "search"}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          width={sidebarWidth}
          height={bodyHeight}
          lastMessages={lastMessages}
        />
        <Box width={1} height={bodyHeight} flexDirection="column">
          <Text dimColor>{"│\n".repeat(bodyHeight).trimEnd()}</Text>
        </Box>
        <Thread
          conversation={conv}
          profileSummary={profileSummary}
          messages={messages}
          width={threadWidth}
          height={bodyHeight}
          scrollOffset={scrollOffset}
          selectedMessageUrn={
            (mode === "messageSelect" || mode === "reactionPick") && messageCursorIdx !== null
              ? (messages[messageCursorIdx]?.urn ?? null)
              : null
          }
        />
      </Box>

      {/* divider */}
      <Box width={cols} height={1}>
        <Text dimColor>{"─".repeat(cols)}</Text>
      </Box>

      {/* composer or command palette */}
      <Box width={cols} height={composerHeight}>
        {mode === "command" ? (
          <Box width={cols} paddingX={1}>
            <Text color="cyanBright">: </Text>
            <Box flexGrow={1}>
              <TextInput
                value={commandText}
                onChange={setCommandText}
                onSubmit={runCommand}
                focus
                placeholder="sync · sync <slug> · reload · help · quit"
              />
            </Box>
          </Box>
        ) : mode === "reactionPick" ? (
          (() => {
            const targetMsg = messageCursorIdx !== null ? messages[messageCursorIdx] : null;
            if (!targetMsg) return null;
            return (
              <ReactionPicker
                message={targetMsg}
                width={cols}
                height={composerHeight}
                onCancel={() => setMode("messageSelect")}
                onPick={(emoji, unreact) => {
                  if (!reacting) void doReact(emoji, unreact);
                }}
              />
            );
          })()
        ) : mode === "messageSelect" ? (
          <Box width={cols} paddingX={1}>
            <Text color="yellowBright">react</Text>
            <Text dimColor> · j/k or ↑/↓ pick message · ↵ open picker · Esc cancel</Text>
          </Box>
        ) : (
          <Composer
            recipientName={conv?.firstName || conv?.name || null}
            text={composeText}
            onChange={setComposeText}
            onSubmit={(v) => {
              if (v.trim()) void doSend(v.trim());
            }}
            active={mode === "compose"}
            sending={sending}
            width={cols}
          />
        )}
      </Box>

      {/* status */}
      <StatusBar
        mode={mode}
        accountSlug={account.slug}
        totalConvs={conversations.length}
        unreadConvs={conversations.filter((c) => c.unreadCount > 0).length}
        listenStatus={listenStatus}
        lastBeatAt={lastBeatAt}
        lastSyncAt={lastSyncAt}
        syncActivity={syncActivity}
        toast={toast}
        width={cols}
      />
    </Box>
  );
}
