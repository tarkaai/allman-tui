import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLastMessage, loadMessages } from "../../src/lib/allman.ts";

const line = (urn: string, ts: number, body: string, extra = "") =>
  `{"urn":"${urn}","timestamp":${ts},"fromUrn":"urn:li:fsd_profile:ME","fromName":"Me","isFromMe":true,"body":"${body}","reactions":[],"attachments":[],"originToken":null${extra}}`;

describe("loadMessages", () => {
  let account: string;

  beforeEach(() => {
    account = mkdtempSync(join(tmpdir(), "allman-tui-msgs-"));
    mkdirSync(join(account, "2-CONV==", "messages"), { recursive: true });
    writeFileSync(
      join(account, "2-CONV==", "messages", "2026-10.jsonl"),
      [
        line("urn:li:messagingMessage:2-A", 1000, "first"),
        line("urn:li:messagingMessage:2-B", 2000, "second"),
        // B re-synced after its sender deleted it: the later line wins, then is dropped.
        line("urn:li:messagingMessage:2-B", 2000, "", ',"renderFormat":"RECALLED"'),
        line("urn:li:messagingMessage:2-C", 3000, "", ',"renderFormat":"RECALLED"'),
        line("urn:li:messagingMessage:2-D", 4000, "fourth", ',"renderFormat":"DEFAULT"'),
      ].join("\n"),
    );
  });

  afterEach(() => rmSync(account, { recursive: true, force: true }));

  it("drops recalled messages so they never render as empty rows", () => {
    expect(loadMessages(account, "2-CONV==").map((m) => m.urn)).toEqual([
      "urn:li:messagingMessage:2-A",
      "urn:li:messagingMessage:2-D",
    ]);
  });

  it("tails after dropping, so the preview is a message that still exists", () => {
    expect(loadMessages(account, "2-CONV==", 1).map((m) => m.body)).toEqual(["fourth"]);
    writeFileSync(
      join(account, "2-CONV==", "messages", "2026-11.jsonl"),
      `${line("urn:li:messagingMessage:2-E", 5000, "", ',"renderFormat":"RECALLED"')}\n`,
    );
    expect(loadLastMessage(account, "2-CONV==")?.urn).toBe("urn:li:messagingMessage:2-D");
  });
});
