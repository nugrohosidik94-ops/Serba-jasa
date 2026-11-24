const C = "serba-jasa-v9";
const A = ["./", "index.html", "manifest.webmanifest", "ikon-ungu-192.png", "ikon-ungu-512.png", "logo.png"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(A)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== C).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(res => {
      // Simpan hanya respons sukses (bukan 404/500 atau respons parsial)
      if (res.ok && res.status === 200) {
        const cp = res.clone();
        caches.open(C).then(c => c.put(r, cp));
      }
      return res;
    }).catch(() => caches.match(r).then(m => {
      if (m) return m;
      // Cadangan index.html hanya untuk pembukaan halaman, bukan gambar/skrip
      return r.mode === "navigate" ? caches.match("index.html") : Response.error();
    }))
  );
});
