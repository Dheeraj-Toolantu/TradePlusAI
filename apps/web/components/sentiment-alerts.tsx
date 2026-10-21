"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { IndexSentiment } from "../lib/index-sentiment";
import type { TelegramLive } from "../lib/telegram-live";
import { DEFAULT_PREFS, diffScan, diffTelegram, emptyBaseline, type AlertPrefs, type AlertTone, type SentimentAlert } from "../lib/sentiment-alerts";

const STORAGE_KEY = "tradepulse.sentimentAlerts.v1";
const LOG_LIMIT = 60;
const TOAST_LIMIT = 4;
const TOAST_MS = 15_000;
const DESKTOP_LIMIT = 3;
const KIND_LABEL: Record<SentimentAlert["kind"], string> = { telegram: "Telegram", option: "Option call", news: "News", sentiment: "Sentiment" };
type Permission = NotificationPermission | "unsupported";
type Saved = { prefs?: Partial<AlertPrefs>; monitoring?: boolean; log?: SentimentAlert[] };

const read = (): Saved => { try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Saved; } catch { return {}; } };
const write = (value: Saved) => { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode: settings last for this visit */ } };
const permissionNow = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);

// One shared AudioContext, unlocked by the first click or key press (browsers block sound until
// then). Once running it keeps playing from a background tab.
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    const Context = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio ??= new Context();
    if (audio.state === "suspended") void audio.resume();
  } catch { /* no audio */ }
}
/** Rising chime for bullish, falling for bearish, a double ping for neutral. */
function chime(tone: AlertTone) {
  if (!audio || audio.state !== "running") return;
  const notes = tone === "up" ? [660, 880, 1175] : tone === "down" ? [880, 660, 494] : [784, 784];
  const start = audio.currentTime + 0.02;
  notes.forEach((frequency, index) => {
    const oscillator = audio!.createOscillator();
    const gain = audio!.createGain();
    const at = start + index * 0.16;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    oscillator.connect(gain).connect(audio!.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.32);
  });
}

// A tiny service worker shows the notifications: they reach you in other apps, stay in the
// system's notification centre, work on Android, and a click brings this page back to the front.
let worker: Promise<ServiceWorkerRegistration | null> | null = null;
function notificationWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  worker ??= navigator.serviceWorker.register("/sentiment-sw.js").then(() => navigator.serviceWorker.ready).catch(() => null);
  return worker;
}

function desktop(alert: SentimentAlert) {
  const options = { body: alert.body, tag: alert.id, silent: false, data: { url: window.location.href, link: alert.link ?? null } };
  const direct = () => {
    try {
      const notice = new Notification(alert.title, options);
      notice.onclick = () => { window.focus(); notice.close(); };
    } catch { /* no notification support in this context */ }
  };
  void notificationWorker().then((registration) => (registration ? registration.showNotification(alert.title, options) : direct())).catch(direct);
}

/**
 * Who delivers an alert when several tabs of the page are open: the tab you are looking at plays
 * the chime; when none is in front (another site, another app), only the leader tab chimes and
 * raises one system notification. Each tab still logs the alert and shows its toast.
 */
export type AlertDelivery = { leader: boolean; otherTabActive: () => boolean };

/**
 * Watches the Telegram feed and the full sentiment scan for new events: fresh Telegram posts, a
 * new option-call consensus, market-moving headlines and index sentiment shifts. Each event goes
 * to the on-page log and toasts, plays a chime, and (while the tab is in the background) raises a
 * browser notification and an unread count in the tab title. The first reading of each feed only
 * sets the baseline, so opening the page doesn't replay old posts.
 */
export function useSentimentAlerts(scan: IndexSentiment | null, telegram: TelegramLive | null, delivery: AlertDelivery = { leader: true, otherTabActive: () => false }) {
  const [prefs, setPrefs] = useState<AlertPrefs>(DEFAULT_PREFS);
  const [monitoring, setMonitoring] = useState(true);
  const [log, setLog] = useState<SentimentAlert[]>([]);
  const [toasts, setToasts] = useState<SentimentAlert[]>([]);
  const [permission, setPermission] = useState<Permission>("default");
  const [loaded, setLoaded] = useState(false);
  const baseline = useRef(emptyBaseline());
  const state = useRef({ prefs, monitoring, permission, delivery });
  state.current = { prefs, monitoring, permission, delivery };
  const unread = useRef(0);
  const title = useRef<string | null>(null);

  useEffect(() => {
    const saved = read();
    if (saved.prefs) setPrefs({ ...DEFAULT_PREFS, ...saved.prefs });
    if (typeof saved.monitoring === "boolean") setMonitoring(saved.monitoring);
    if (Array.isArray(saved.log)) setLog(saved.log.slice(0, LOG_LIMIT));
    setPermission(permissionNow());
    if (permissionNow() === "granted") void notificationWorker();
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) write({ prefs, monitoring, log }); }, [loaded, prefs, monitoring, log]);

  useEffect(() => {
    const unlock = () => unlockAudio();
    const onVisibility = () => {
      if (document.hidden || title.current === null) return;
      document.title = title.current;
      title.current = null;
      unread.current = 0;
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", onVisibility);
      if (title.current !== null) document.title = title.current;
    };
  }, []);

  const emit = useCallback((alerts: SentimentAlert[], force = false) => {
    const { prefs: current, monitoring: on, permission: allowed, delivery: tabs } = state.current;
    if (!alerts.length || (!on && !force)) return;
    setLog((rows) => [...alerts, ...rows].slice(0, LOG_LIMIT));
    setToasts((rows) => [...alerts, ...rows].slice(0, TOAST_LIMIT));
    alerts.forEach((alert) => setTimeout(() => setToasts((rows) => rows.filter((row) => row.id !== alert.id)), TOAST_MS));
    const here = !document.hidden && document.hasFocus();
    // Exactly one tab delivers: this one if you are looking at it, else the leader if no tab is in front.
    const deliver = force || here || (tabs.leader && !tabs.otherTabActive());
    if (current.sound && deliver) chime(alerts[0].tone);
    if (current.desktop && allowed === "granted" && deliver && (!here || force)) alerts.slice(0, DESKTOP_LIMIT).forEach(desktop);
    if (document.hidden) {
      title.current ??= document.title;
      unread.current += alerts.length;
      document.title = `(${unread.current}) New alerts · ${title.current}`;
    }
  }, []);

  // Diff every reading, even with monitoring off, so switching it on doesn't flood old events.
  useEffect(() => { if (telegram) emit(diffTelegram(baseline.current, telegram, state.current.prefs)); }, [telegram, emit]);
  useEffect(() => { if (scan) emit(diffScan(baseline.current, scan, state.current.prefs)); }, [scan, emit]);

  const requestPermission = useCallback(async () => {
    unlockAudio();
    if (typeof Notification === "undefined") { setPermission("unsupported"); return; }
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === "granted") void notificationWorker();
    } catch { setPermission(permissionNow()); }
  }, []);
  const test = useCallback(() => {
    unlockAudio();
    // Give a freshly created AudioContext a moment to start before the chime.
    setTimeout(() => emit([{ id: `test-${Date.now()}`, kind: "sentiment", tone: "up", title: "Test alert: notifications are working", body: "You'll hear this chime and see a browser notification when a new event arrives while this tab is in the background.", at: new Date().toISOString() }], true), 60);
  }, [emit]);
  const dismiss = useCallback((id: string) => setToasts((rows) => rows.filter((row) => row.id !== id)), []);
  const clear = useCallback(() => setLog([]), []);

  return { prefs, setPrefs, monitoring, setMonitoring, log, toasts, permission, requestPermission, test, dismiss, clear };
}

type AlertsState = ReturnType<typeof useSentimentAlerts>;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Asia/Kolkata" });

export const AlertToasts = memo(function AlertToasts({ toasts, dismiss }: Pick<AlertsState, "toasts" | "dismiss">) {
  return (
    <div className="sal-toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((alert) => (
        <div key={alert.id} className={`sal-toast sal-${alert.tone}`} role="status">
          <div className="sal-toast-head"><span className="sal-kind">{KIND_LABEL[alert.kind]}</span><small>{time(alert.at)} IST</small><button type="button" onClick={() => dismiss(alert.id)} aria-label="Dismiss alert">×</button></div>
          <b>{alert.link ? <a href={alert.link} target="_blank" rel="noreferrer">{alert.title}</a> : alert.title}</b>
          <p>{alert.body}</p>
        </div>
      ))}
    </div>
  );
});

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="sal-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

export const AlertCenter = memo(function AlertCenter({ alerts }: { alerts: AlertsState }) {
  const { prefs, setPrefs, monitoring, setMonitoring, log, permission, requestPermission, test, clear } = alerts;
  const [open, setOpen] = useState(false);
  const set = <K extends keyof AlertPrefs>(key: K, value: AlertPrefs[K]) => setPrefs((current) => ({ ...current, [key]: value }));
  const permissionLabel = permission === "granted" ? "Browser notifications on" : permission === "denied" ? "Browser notifications blocked (allow them in site settings)" : permission === "unsupported" ? "Browser notifications not supported here" : "Enable browser notifications";

  return (
    <section className="isa-panel sal">
      <div className="ce-head">
        <h3>Live alerts <small>({log.length})</small></h3>
        <div className="sal-actions">
          <button type="button" className={monitoring ? "sal-on" : ""} onClick={() => { setMonitoring(!monitoring); }} aria-pressed={monitoring}>
            <i />{monitoring ? "Monitoring: on" : "Monitoring: off"}
          </button>
          <button type="button" onClick={() => void requestPermission()} disabled={permission === "granted" || permission === "denied" || permission === "unsupported"}>{permissionLabel}</button>
          <button type="button" onClick={test}>Test sound &amp; notification</button>
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide settings" : "Settings"}</button>
        </div>
      </div>
      <p className="isa-muted sal-help">
        {monitoring
          ? "Watching Telegram channels, fresh news on index constituents and NIFTY / BANK NIFTY / SENSEX sentiment, including while this tab is in the background. Keep the tab open; click anywhere on the page once so the browser allows sound."
          : "Monitoring is off: feeds still refresh while the tab is visible, but no alerts fire and nothing runs in the background."}
      </p>
      {open ? (
        <div className="sal-settings">
          <div>
            <small>Alert on</small>
            <Toggle label="New Telegram posts" checked={prefs.telegram} onChange={(value) => set("telegram", value)} />
            <Toggle label="…only index option calls" checked={prefs.telegramIndexOnly} onChange={(value) => set("telegramIndexOnly", value)} />
            <Toggle label="New Telegram option consensus" checked={prefs.options} onChange={(value) => set("options", value)} />
            <Toggle label="Market-moving news" checked={prefs.news} onChange={(value) => set("news", value)} />
            <Toggle label="…top outlets only" checked={prefs.premiumOnly} onChange={(value) => set("premiumOnly", value)} />
            <Toggle label="Index sentiment shifts" checked={prefs.sentiment} onChange={(value) => set("sentiment", value)} />
          </div>
          <div>
            <small>Thresholds</small>
            <label className="sal-num">Sentiment move (points)<input type="number" min={2} max={50} value={prefs.scoreStep} onChange={(event) => set("scoreStep", Math.max(2, Number(event.target.value) || DEFAULT_PREFS.scoreStep))} /></label>
            <label className="sal-num">Headline strength (|score| ≥)<input type="number" min={0} max={100} value={prefs.newsMinScore} onChange={(event) => set("newsMinScore", Math.max(0, Math.min(100, Number(event.target.value) || 0)))} /></label>
            <small>Delivery</small>
            <Toggle label="Play sound" checked={prefs.sound} onChange={(value) => set("sound", value)} />
            <Toggle label="Browser notifications when the tab is in the background" checked={prefs.desktop} onChange={(value) => set("desktop", value)} />
          </div>
        </div>
      ) : null}
      {log.length ? (
        <>
          <ul className="sal-log">
            {log.map((alert) => (
              <li key={alert.id} className={`sal-${alert.tone}`}>
                <small>{time(alert.at)}</small>
                <span className="sal-kind">{KIND_LABEL[alert.kind]}</span>
                <div><b>{alert.link ? <a href={alert.link} target="_blank" rel="noreferrer">{alert.title}</a> : alert.title}</b><p>{alert.body}</p></div>
              </li>
            ))}
          </ul>
          <button type="button" className="sal-clear" onClick={clear}>Clear log</button>
        </>
      ) : <p className="isa-muted">No new events since the page opened. New Telegram posts, headlines and sentiment shifts will appear here.</p>}
    </section>
  );
});
