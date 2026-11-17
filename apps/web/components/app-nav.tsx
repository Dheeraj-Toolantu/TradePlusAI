"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS: Array<[string, string]> = [
  ["/execution", "Auto algo trading"],
  ["/operations", "Sentiment"], ["/oi", "OI analysis"],
  ["/validation", "Backtesting"],
  ["/technical-analysis", "Technical analysis"],
  ["/intelligence", "AI insights"],
];

/**
 * The app's navigation (it replaced the old dashboard, which was the only hub).
 *
 * Client-side links: a click swaps only the page (the shell, fonts and shared framework chunks stay
 * loaded) and downloads just that page's own JS and CSS. prefetch={false}: no page is fetched until
 * it is opened, so opening one page never loads the others in the background.
 */
export function AppNav() {
  const path = usePathname() ?? "";
  return (
    <nav className="app-nav" aria-label="Main">
      <Link className="app-nav-brand" href="/execution" prefetch={false}>TradePulse</Link>
      {LINKS.map(([href, label]) => {
        const active = path === href || path.startsWith(`${href}/`);
        return <Link key={href} href={href} prefetch={false} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>{label}</Link>;
      })}
    </nav>
  );
}
