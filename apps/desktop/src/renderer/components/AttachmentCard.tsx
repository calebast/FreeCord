import React from "react";
import { VideoAttachment } from "./VideoAttachment";

export interface AttachmentCardProps {
  assetId: string;
  name: string;
  mimeType: string;
  size?: number;
  posterAssetId?: string;
  compact?: boolean;
}

function mediaUrl(assetId: string): string | undefined {
  return /^[0-9a-f-]{36}$/iu.test(assetId) ? `freecord-media://asset/${assetId}` : undefined;
}

function formatBytes(size: number | undefined): string {
  if (!size || size < 0) return "Unknown size";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentCard(props: AttachmentCardProps): React.JSX.Element {
  const source = mediaUrl(props.assetId);
  if (!source) return <p className="attachment-error">This attachment reference is invalid.</p>;
  if (props.mimeType.startsWith("video/")) return <VideoAttachment {...props} />;
  if (props.mimeType.startsWith("image/")) {
    return <figure className={`attachment-card image-card ${props.compact ? "compact" : ""}`}><img src={source} alt={props.name} loading="lazy" decoding="async" /><figcaption><strong>{props.name}</strong><small>{formatBytes(props.size)} · server-readable image</small></figcaption></figure>;
  }
  if (props.mimeType.startsWith("audio/")) {
    return <figure className={`attachment-card audio-card ${props.compact ? "compact" : ""}`}><figcaption><strong>{props.name}</strong><small>{formatBytes(props.size)} · server-readable audio</small></figcaption><audio controls preload="metadata" src={source} /></figure>;
  }
  return <div className={`attachment-card file-card ${props.compact ? "compact" : ""}`}><span className="attachment-file-icon" aria-hidden="true">⇩</span><div><strong>{props.name}</strong><small>{props.mimeType || "File"} · {formatBytes(props.size)}</small></div><a href={source} download={props.name}>Download</a></div>;
}
