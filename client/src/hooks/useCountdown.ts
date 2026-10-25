import { useEffect, useState } from 'react';

// Milliseconds left until `expiresAt` by the server's clock. `clockOffsetMs` is server time minus
// browser time, so a wrong browser clock doesn't skew the countdown. The value is recomputed on
// every render from the current time instead of counting down, so a sleeping tab is right again
// as soon as it wakes. The server still decides whether a hold has expired.
export function useCountdown(expiresAt: string | null | undefined, clockOffsetMs: number) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return 0;
  return Math.max(0, new Date(expiresAt).getTime() - (Date.now() + clockOffsetMs));
}

export function formatCountdown(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
