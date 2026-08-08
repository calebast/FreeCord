import React from "react";

export interface VideoAttachmentProps {
  assetId: string;
  name: string;
  mimeType: string;
  posterAssetId?: string;
}

function mediaUrl(assetId: string): string | undefined {
  return /^[0-9a-f-]{36}$/iu.test(assetId) ? `freecord-media://asset/${assetId}` : undefined;
}

export function VideoAttachment({ assetId, name, mimeType, posterAssetId }: VideoAttachmentProps): React.JSX.Element {
  const source = mediaUrl(assetId);
  const poster = posterAssetId ? mediaUrl(posterAssetId) : undefined;

  if (!source) return <p className="attachment-error">This video attachment is invalid.</p>;

  return (
    <figure className="video-attachment">
      <video controls playsInline preload="metadata" poster={poster}>
        <source src={source} type={mimeType} />
        Your system cannot play this video format.
      </video>
      <figcaption>
        <span>{name}</span>
        <small>Server-readable video · not end-to-end encrypted</small>
      </figcaption>
    </figure>
  );
}
