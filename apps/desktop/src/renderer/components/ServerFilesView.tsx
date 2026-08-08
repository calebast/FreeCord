import React from "react";
import { AttachmentCard } from "./AttachmentCard";

export interface SharedFileViewModel {
  mediaId: string;
  messageId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorDisplayName: string;
  contentType: string;
  byteSize: number;
  encrypted: boolean;
  position: number;
  sharedAt: string;
  name: string;
}

export function ServerFilesView({ files, loading, error, hasMore, onLoadMore, onViewInChannel }: {
  files: SharedFileViewModel[];
  loading: boolean;
  error?: string;
  hasMore: boolean;
  onLoadMore: () => void;
  onViewInChannel: (file: SharedFileViewModel) => void;
}): React.JSX.Element {
  return <section className="server-files-view" aria-label="Files shared in chat">
    <header><div><h2>Server Files</h2><p>Attachments shared in text channels you can read.</p></div><span>{files.length}</span></header>
    {error && <p className="server-files-error" role="alert">{error}</p>}
    {!loading && files.length === 0 && !error && <div className="server-files-empty"><div className="empty-icon">▤</div><h3>No shared files yet</h3><p>Videos and other server attachments will appear here after they are sent in chat.</p></div>}
    <div className="server-files-list">{files.map((file) => <article key={`${file.messageId}:${file.mediaId}`}>
      <AttachmentCard assetId={file.mediaId} name={file.name} mimeType={file.contentType} size={file.byteSize} compact />
      <div className="server-file-meta"><span>Shared by {file.authorDisplayName}</span><span>#{file.channelName} · {new Date(file.sharedAt).toLocaleString()}</span>{file.encrypted && <span>Encrypted object</span>}</div>
      <button type="button" className="secondary" onClick={() => onViewInChannel(file)}>View in channel</button>
    </article>)}</div>
    {hasMore && <button type="button" className="server-files-more" onClick={onLoadMore} disabled={loading}>{loading ? "Loading…" : "Load more"}</button>}
    {loading && files.length === 0 && <p className="server-files-loading">Loading shared files…</p>}
  </section>;
}
