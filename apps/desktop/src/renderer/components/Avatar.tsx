import React from "react";

export interface AvatarReference {
  assetId?: string;
  url?: string;
  version?: string;
}

export interface AvatarProps {
  name: string;
  avatar?: AvatarReference | null;
  size?: "small" | "medium";
  speaking?: boolean;
  offline?: boolean;
  className?: string;
}

function avatarSource(avatar: AvatarReference | null | undefined): string | undefined {
  if (avatar?.url?.startsWith("freecord-media://")) return avatar.url;
  if (!avatar?.assetId || !/^[0-9a-f-]{36}$/iu.test(avatar.assetId)) return undefined;
  const version = avatar.version ? `?v=${encodeURIComponent(avatar.version)}` : "";
  return `freecord-media://asset/${avatar.assetId}${version}`;
}

export function Avatar({ name, avatar, size = "medium", speaking = false, offline = false, className = "" }: AvatarProps): React.JSX.Element {
  const [failed, setFailed] = React.useState(false);
  const source = avatarSource(avatar);

  React.useEffect(() => setFailed(false), [source]);

  return (
    <span className={`user-avatar avatar-${size} ${speaking ? "speaking" : ""} ${offline ? "offline" : ""} ${className}`.trim()} aria-label={`${name}'s profile picture`}>
      {source && !failed
        ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <span aria-hidden="true">{name.trim().slice(0, 1).toUpperCase() || "?"}</span>}
    </span>
  );
}
