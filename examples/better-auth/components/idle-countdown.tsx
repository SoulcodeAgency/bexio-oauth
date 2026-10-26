"use client";
import { useEffect, useState } from "react";

/**
 * Seconds until the connection counts as idle for the refreshIdle cron
 * (last refresh + BEXIO_IDLE_FOR), so a tester knows when running it refreshes.
 */
export function IdleCountdown({ idleAt }: { idleAt: string }) {
  // Rendered on the client only: server and browser clocks would differ.
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    const tick = () =>
      setSeconds(
        Math.max(0, Math.ceil((Date.parse(idleAt) - Date.now()) / 1000)),
      );
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [idleAt]);
  if (seconds === null) return null;
  return (
    <span
      className="chip"
      data-testid="idle-countdown"
      data-idle={seconds === 0}
      title="When refreshIdle picks this connection up"
    >
      {seconds > 0 ? `idle in ${seconds}s` : "idle"}
    </span>
  );
}
