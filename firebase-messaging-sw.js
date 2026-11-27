self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

const APP = new URL("./", self.location.href).href;
const ICON = new URL("ikon-ungu-192.png", self.location.href).href;

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || APP;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if (c.url.indexOf(APP) === 0 && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyAcp03rTmdn-lcvqtd6OG0lD2mI1C6BlHA",
  authDomain: "serba-jasa.firebaseapp.com",
  projectId: "serba-jasa",
  messagingSenderId: "949487663228",
  appId: "1:949487663228:web:7f33f574afca4a576b71f9"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(function (payload) {
  const d = payload.data || {};
  const n = payload.notification || {};
  return self.registration.showNotification(d.title || n.title || "Serba Jasa", {
    body: d.body || n.body || "",
    icon: ICON,
    badge: ICON,
    tag: d.tag || "serba-jasa",
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || APP }
  });
});
