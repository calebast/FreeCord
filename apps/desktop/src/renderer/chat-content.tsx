import React from "react";

export interface ChatEmoteToken {
  id: string;
  name: string;
}

export interface MentionMember {
  id: string;
  username: string;
  displayName: string;
}

export interface AttachmentItem {
  assetId: string;
  name: string;
  mimeType: string;
  size?: number;
  posterAssetId?: string;
}

export type EmbeddedContent =
  | { type: "gif"; url: string; title?: string; id?: string }
  | { type: "image"; dataUrl: string }
  | ({ type: "attachment" } & AttachmentItem)
  | { type: "attachments"; text?: string; items: AttachmentItem[] };

const ASSET_ID = /^[0-9a-f-]{36}$/iu;

function parseAttachment(value: Record<string, unknown>): AttachmentItem | undefined {
  if (typeof value.assetId !== "string" || !ASSET_ID.test(value.assetId)
    || typeof value.name !== "string" || typeof value.mimeType !== "string") return undefined;
  return {
    assetId: value.assetId,
    name: value.name.slice(0, 255),
    mimeType: value.mimeType.slice(0, 160),
    ...(typeof value.size === "number" && Number.isFinite(value.size) ? { size: value.size } : {}),
    ...(typeof value.posterAssetId === "string" && ASSET_ID.test(value.posterAssetId) ? { posterAssetId: value.posterAssetId } : {}),
  };
}

export function parseEmbeddedContent(content: string | undefined): EmbeddedContent | undefined {
  if (!content || content.length > 800_000 || !content.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (value.type === "gif" && typeof value.url === "string" && /^https:\/\//u.test(value.url)) {
      return {
        type: "gif",
        url: value.url,
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        ...(typeof value.id === "string" ? { id: value.id } : {}),
      };
    }
    if (value.type === "image" && typeof value.dataUrl === "string"
      && /^data:image\/(?:jpeg|png|webp);base64,/u.test(value.dataUrl) && value.dataUrl.length < 700_000) {
      return { type: "image", dataUrl: value.dataUrl };
    }
    if (value.type === "attachment") {
      const attachment = parseAttachment(value);
      if (attachment) return { type: "attachment", ...attachment };
    }
    if (value.type === "attachments" && Array.isArray(value.items)) {
      const items = value.items
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .map(parseAttachment)
        .filter((item): item is AttachmentItem => Boolean(item))
        .slice(0, 10);
      if (items.length > 0) return {
        type: "attachments",
        items,
        ...(typeof value.text === "string" ? { text: value.text.slice(0, 20_000) } : {}),
      };
    }
  } catch {
    // Ordinary chat text is not JSON.
  }
  return undefined;
}

export function attachmentItems(content: string | undefined): AttachmentItem[] {
  const embedded = parseEmbeddedContent(content);
  if (embedded?.type === "attachment") return [embedded];
  return embedded?.type === "attachments" ? embedded.items : [];
}

export function containsMention(content: string, username: string): boolean {
  if (!username) return false;
  const canonical = username.toLocaleLowerCase();
  return [...content.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]{1,64})(?=$|[^A-Za-z0-9_.-])/gu)]
    .some((match) => match[2]?.toLocaleLowerCase() === canonical);
}

export interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

export function mentionQueryAtCursor(content: string, cursor: number): MentionQuery | undefined {
  const safeCursor = Math.max(0, Math.min(content.length, cursor));
  const prefix = content.slice(0, safeCursor);
  const match = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]*)$/u.exec(prefix);
  if (!match) return undefined;
  return { start: safeCursor - (match[2]?.length ?? 0) - 1, end: safeCursor, query: match[2] ?? "" };
}

export function completeMention(content: string, cursor: number, username: string): { content: string; cursor: number } {
  const query = mentionQueryAtCursor(content, cursor);
  if (!query) return { content, cursor };
  const insertion = `@${username} `;
  return {
    content: `${content.slice(0, query.start)}${insertion}${content.slice(query.end)}`,
    cursor: query.start + insertion.length,
  };
}

export function mentionSuggestions(content: string, cursor: number, members: MentionMember[]): MentionMember[] {
  const query = mentionQueryAtCursor(content, cursor);
  if (!query) return [];
  const needle = query.query.toLocaleLowerCase();
  return members
    .filter((member) => member.username.toLocaleLowerCase().startsWith(needle))
    .sort((left, right) => left.username.localeCompare(right.username))
    .slice(0, 8);
}

export function ChatRichText({
  content,
  emotes,
  members,
  currentUsername,
  renderEmote,
}: {
  content: string;
  emotes: ChatEmoteToken[];
  members: MentionMember[];
  currentUsername: string;
  renderEmote: (emote: ChatEmoteToken, key: string) => React.ReactNode;
}): React.JSX.Element {
  const emoteByName = new Map(emotes.map((emote) => [emote.name.toLocaleLowerCase(), emote]));
  const usernameByName = new Map(members.map((member) => [member.username.toLocaleLowerCase(), member.username]));
  const nodes: React.ReactNode[] = [];
  const pattern = /:([A-Za-z0-9_]{2,48}):|@([A-Za-z0-9_.-]{1,64})/gu;
  let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = index === 0 ? "" : content[index - 1] ?? "";
    const after = content[index + match[0].length] ?? "";
    let node: React.ReactNode;
    if (match[1]) {
      const emote = emoteByName.get(match[1].toLocaleLowerCase());
      if (!emote) continue;
      node = renderEmote(emote, `${emote.id}:${index}`);
    } else {
      const username = match[2] ? usernameByName.get(match[2].toLocaleLowerCase()) : undefined;
      if (!username || /[A-Za-z0-9_.-]/u.test(before) || /[A-Za-z0-9_.-]/u.test(after)) continue;
      const self = username.toLocaleLowerCase() === currentUsername.toLocaleLowerCase();
      node = <span className={`chat-mention ${self ? "mention-self" : ""}`} key={`mention:${username}:${index}`}>@{username}</span>;
    }
    if (index > cursor) nodes.push(content.slice(cursor, index));
    nodes.push(node);
    cursor = index + match[0].length;
  }
  if (cursor === 0) return <>{content}</>;
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return <>{nodes}</>;
}
