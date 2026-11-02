// Mirrors the allman store's RECORD.json + JSONL message shapes.
// Kept loose where allman stores `null` or omits fields on older records.

export type Conversation = {
  convId: string;
  profileId: string;
  slug: string | null;
  convUrn: string;
  backendUrn: string;
  profileUrn: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  headline: string | null;
  isPremium?: boolean;
  isVerified?: boolean;
  unreadCount: number;
  lastActivityAt: string;
  lastReadAt: string | null;
  read: boolean;
  syncState?: {
    oldestMessageAt: number;
    newestMessageAt: number;
    lastSyncAt: string;
    totalSynced: number;
    fullyBackfilled: boolean;
  };
};

export type Reaction = {
  emoji: string;
  count: number;
  hasUserReacted: boolean;
};

export type AttachmentType =
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "file"
  | "gif"
  | "link_preview"
  | "post_share"
  | "forwarded"
  | "replied"
  | "unavailable"
  | "away_message"
  | "other";

export type Attachment = {
  type?: AttachmentType | string;
  url?: string;
  name?: string;
  size?: number;
  mimeType?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  title?: string;
  description?: string;
  /** Commentary on a shared post, body of a forwarded msg, snippet of a reply target. */
  originalText?: string;
  /** Author of the shared/forwarded/replied source. */
  authorName?: string;
  raw?: unknown;
  [k: string]: unknown;
};

export type Message = {
  urn: string;
  timestamp: number;
  fromUrn: string;
  fromName: string;
  isFromMe: boolean;
  body: string;
  reactions: Reaction[];
  attachments: Attachment[];
  originToken: string | null;
  /** LinkedIn's render hint (DEFAULT, SYSTEM, RECALLED…); absent on older records. */
  renderFormat?: string | null;
};

export type Auth = {
  profileId: string;
  slug: string | null;
  name: string | null;
  headline?: string | null;
  status: string;
  cookiesValid?: boolean;
  lastSyncAt?: string | null;
};

export type Account = {
  slug: string;
  profileId: string;
  dir: string;
  auth: Auth;
};

export type SearchResult = {
  name: string;
  slug: string | null;
  profileId: string;
  convId: string | null;
  confidence: number;
};

export type ListenEvent = {
  event: string;
  account?: string;
  timestamp?: number;
  conversation?: {
    urn?: string;
    convId?: string;
    name?: string;
    slug?: string | null;
  };
  from?: {
    urn?: string;
    name?: string;
  };
  message?: {
    urn?: string;
    body?: string;
    isFromMe?: boolean;
  };
};
