'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

function userIsBusy(): boolean {
  if (document.visibilityState !== 'visible') return true;
  if (document.querySelector('dialog[open]') !== null) return true;
  return document.activeElement?.matches('input, textarea, select') ?? false;
}

export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (!userIsBusy()) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
