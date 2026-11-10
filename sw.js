// Service worker: toont pushmeldingen en opent de juiste pagina bij een tik.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => {
  e.waitUntil((async () => {
    let items = [];
    try { const r = await fetch("/api/notifications/pending", { credentials: "same-origin" }); if (r.ok) items = await r.json(); } catch (err) {}
    if (!items.length) items = [{ title: "Ghotra", body: "Er is iets gewijzigd. Open de app.", url: "/" }];
    await Promise.all(items.slice(-3).map(n => self.registration.showNotification(n.title, { body: n.body, data: { url: n.url || "/" }, icon: "/icon.svg", badge: "/icon.svg", tag: "ghotra-" + (n.id || Date.now()), renotify: true })));
  })());
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).pathname === new URL(url, self.location.origin).pathname && "focus" in c) { c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
