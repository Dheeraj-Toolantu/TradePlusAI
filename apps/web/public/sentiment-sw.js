// TradePulse sentiment alerts: shows notifications for the Market Psychology page and brings the
// page back to the front when one is clicked. It caches nothing and handles no requests.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/operations";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const path = new URL(target, self.location.origin).pathname;
    const open = windows.find((client) => new URL(client.url).pathname === path) || windows[0];
    if (open) {
      await open.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
