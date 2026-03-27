'use client';

import { useEffect, useState } from 'react';

interface UserAvatarProps {
  avatarUrl?: string;
  alt: string;
  fallback: string;
  className: string;
  imageClassName: string;
}

export default function UserAvatar({ avatarUrl, alt, fallback, className, imageClassName }: UserAvatarProps) {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [avatarUrl]);

  return (
    <span className={className}>
      {avatarUrl && !hasError ? (
        <img src={avatarUrl} alt={alt} className={imageClassName} onError={() => setHasError(true)} />
      ) : (
        fallback
      )}
    </span>
  );
}
