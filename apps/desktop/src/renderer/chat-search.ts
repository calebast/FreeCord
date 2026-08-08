import type { ChannelMetadata, ChatMessage, MessagesResponse } from "../shared/bridge";
import { decryptChatMessage, isChatKey } from "./chat-crypto";

export interface LocalSearchResult {
  channelId: string;
  channelName: string;
  message: ChatMessage;
  content: string;
  snippet: string;
}

export interface LocalSearchProgress {
  channelsComplete: number;
  channelCount: number;
  messagesScanned: number;
  resultsFound: number;
}

function snippetFor(content: string, query: string): string {
  const normalized = content.toLocaleLowerCase();
  const index = normalized.indexOf(query.toLocaleLowerCase());
  const start = Math.max(0, index - 70);
  const end = Math.min(content.length, index + query.length + 110);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).replace(/\s+/gu, " ")}${end < content.length ? "…" : ""}`;
}

export async function searchEncryptedMessages({
  channels,
  selectedChannelId,
  query,
  chatKey,
  signal,
  getMessages,
  onProgress,
}: {
  channels: ChannelMetadata[];
  selectedChannelId: string | null;
  query: string;
  chatKey: string;
  signal: AbortSignal;
  getMessages: (channelId: string, before?: string) => Promise<MessagesResponse | { ok: false; message: string }>;
  onProgress?: (progress: LocalSearchProgress) => void;
}): Promise<LocalSearchResult[]> {
  if (!isChatKey(chatKey)) throw new Error("Secure chat is not ready.");
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const readable = channels
    .filter((channel) => channel.type === "text" && channel.canRead !== false)
    .sort((left, right) => Number(right.id === selectedChannelId) - Number(left.id === selectedChannelId));
  const results: LocalSearchResult[] = [];
  let messagesScanned = 0;
  let channelsComplete = 0;

  for (const channel of readable) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
      const response = await getMessages(channel.id, cursor);
      if (!("messages" in response)) throw new Error(response.message);
      for (const message of response.messages) {
        if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
        messagesScanned += 1;
        if (message.deletedAt || !message.ciphertext || !message.nonce) continue;
        let content: string;
        try { content = await decryptChatMessage(chatKey, message.ciphertext, message.nonce); }
        catch { continue; }
        if (!content.toLocaleLowerCase().includes(needle)) continue;
        results.push({ channelId: channel.id, channelName: channel.name, message: { ...message, content }, content, snippet: snippetFor(content, query.trim()) });
      }
      onProgress?.({ channelsComplete, channelCount: readable.length, messagesScanned, resultsFound: results.length });
      cursor = response.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Message history returned a repeated cursor.");
        seenCursors.add(cursor);
      }
    } while (cursor);
    channelsComplete += 1;
    onProgress?.({ channelsComplete, channelCount: readable.length, messagesScanned, resultsFound: results.length });
  }
  return results.sort((left, right) => right.message.createdAt.localeCompare(left.message.createdAt));
}
