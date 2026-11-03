"use client";

import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/execution", "Auto algo trading"],
  ["/operations", "Sentiment"],
  ["/validation", "Backtesting"],
  ["/technical-analysis", "Technical analysis"],
  ["/intelligence", "AI insights"],
];

/** The app's navigation (it replaced the old dashboard, which was the only hub). */
export function AppNav() {
  const path = usePathname() ?? "";
  return (
    <nav className="app-nav" aria-label="Main">
      <a className="app-nav-brand" href="/execution">TradePulse</a>
      {LINKS.map(([href, label]) => {
        const active = path === href || path.startsWith(`${href}/`);
        return <a key={href} href={href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</a>;
      })}
    </nav>
  );
}
