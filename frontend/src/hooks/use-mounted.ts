'use client';

import { useEffect, useState } from 'react';

/** Returns true once the component has hydrated on the client. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
