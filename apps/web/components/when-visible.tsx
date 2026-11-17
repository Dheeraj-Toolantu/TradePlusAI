"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mounts a panel only when it comes near the viewport (its code chunk and its data load only then)
 * and keeps it mounted afterwards. Use it for display-only, below-the-fold panels; never wrap a
 * panel that trades or monitors on its own.
 */
export function WhenVisible({ children, minHeight = 240, margin = "600px 0px" }: { children: ReactNode; minHeight?: number; margin?: string }) {
  const [shown, setShown] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (shown || !ref.current) return;
    if (typeof IntersectionObserver === "undefined") { setShown(true); return; }
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) setShown(true); }, { rootMargin: margin });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [margin, shown]);
  return shown ? <>{children}</> : <div ref={ref} className="algo-empty" style={{ minHeight }} aria-hidden="true" />;
}
