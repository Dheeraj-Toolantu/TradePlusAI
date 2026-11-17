import type { Metadata } from "next";
import { OiDashboard } from "../../components/oi/oi-dashboard";
import "./oi.css";

export const metadata: Metadata = { title: "OI analysis · TradePulse" };

export default function OiPage() {
  return (
    <main className="exec-page oi-main">
      <OiDashboard />
    </main>
  );
}
