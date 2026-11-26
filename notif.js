(function () {
  const WORKER = "https://serba-jasa-push.nugrohosidik94.workers.dev";
  const VAPID = "BNzq57ovmTgIuLmBtPOclXcc22aNHQS6BvSU-NlO1_vaf2bENqL2KSf0nvvhPqLoJO209DGjXgwqxwRs7DBMQYw";
  const MCFG = {
    apiKey: "AIzaSyAcp03rTmdn-lcvqtd6OG0lD2mI1C6BlHA",
    authDomain: "serba-jasa.firebaseapp.com",
    projectId: "serba-jasa",
    messagingSenderId: "949487663228",
    appId: "1:949487663228:web:7f33f574afca4a576b71f9"
  };
  const canRecv = "Notification" in window && "serviceWorker" in navigator &&
    typeof firebase !== "undefined" && !!firebase.messaging && firebase.messaging.isSupported();
  let TKD = false, MAPP = null;
  window.NTD = false;

  function msg() {
    if (!MAPP) {
      MAPP = firebase.apps.find(a => a.name === "msg") || firebase.initializeApp(MCFG, "msg");
    }
    return firebase.messaging(MAPP);
  }

  async function kirimNotif(toUid, type, detail) {
    try {
      if (!U || !toUid) return;
      const idt = await U.getIdToken();
      await fetch(WORKER + "/send", {
        method: "POST",
        headers: { Authorization: "Bearer " + idt, "Content-Type": "application/json" },
        body: JSON.stringify({ toUid, type, detail: String(detail || "").slice(0, 100) })
      });
    } catch (e) { console.warn(e); }
  }
  window.kirimNotif = kirimNotif;

  async function simpanToken() {
    const reg = await navigator.serviceWorker.register("firebase-messaging-sw.js", { scope: "fcm-scope/" });
    const t = await msg().getToken({ vapidKey: VAPID, serviceWorkerRegistration: reg });
    if (!t) throw new Error("Token notifikasi kosong");
    const idt = await U.getIdToken();
    const r = await fetch(WORKER + "/register", {
      method: "POST",
      headers: { Authorization: "Bearer " + idt, "Content-Type": "application/json" },
      body: JSON.stringify({ token: t })
    });
    if (!r.ok) throw new Error("Gagal menyimpan token (" + r.status + ")");
  }

  window.aktifkanNotif = async function () {
    try {
      const p = await Notification.requestPermission();
      if (p !== "granted") { toast("Izin notifikasi tidak diberikan"); render(); return; }
      await simpanToken();
      toast("Notifikasi aktif ✓");
      render();
    } catch (e) {
      toastL("⚠️ Notifikasi gagal diaktifkan: " + (e.message || e.code || e));
    }
  };

  if (canRecv) {
    try {
      msg().onMessage(m => {
        const n = m.notification || {};
        toastL("🔔 " + (n.title || "Notifikasi") + (n.body ? ": " + n.body : ""));
      });
    } catch (e) {}
  }

  function wrap(n, mk) {
    const o = window[n];
    if (typeof o === "function") window[n] = mk(o);
  }
  wrap("kirimPesanan", o => async function () {
    const j = jb(S.form);
    await o.apply(this, arguments);
    if (j && !S.form) kirimNotif(j.uid, "pesanan_baru", j.n);
  });
  wrap("ubahO", o => async function (id, st) {
    const x = ordO(id);
    await o.apply(this, arguments);
    if (!x || !U || x.pen !== U.uid || (st !== "diterima" && st !== "ditolak")) return;
    try {
      const s = await db.doc("pesanan/" + id).get();
      if (s.exists && s.data().st === st)
        kirimNotif(x.cus, st === "diterima" ? "pesanan_diterima" : "pesanan_ditolak", x.jn);
    } catch (e) {}
  });
  wrap("kirimSelesai", o => async function () {
    const id = FSP && FSP.id, x = id ? ordO(id) : null;
    await o.apply(this, arguments);
    if (x && FSP === null) kirimNotif(x.cus, "pesanan_selesai", x.jn);
  });
  wrap("kirimC", o => async function () {
    const r = roomOf(S.room), t = (CT || "").trim(), had = !!CHF;
    await o.apply(this, arguments);
    if (r && (t || had) && !CT && !CHF)
      kirimNotif(r.cus === U.uid ? r.pen : r.cus, "chat", t || "Mengirim foto");
  });
  wrap("bayarSaldo", o => async function (id) {
    const x = OM.find(v => String(v.id) === String(id));
    await o.apply(this, arguments);
    if (!x) return;
    try {
      const s = await db.doc("pesanan/" + id).get();
      if (s.exists && s.data().pay === "lunas")
        kirimNotif(x.pen, "pembayaran", "Pembayaran " + x.jn + " sudah masuk (ditahan admin)");
    } catch (e) {}
  });

  const BN = `<div class="card" style="border-left:5px solid var(--acc)"><div class="in"><b>🔔 Aktifkan notifikasi</b><div class="mute" style="margin:4px 0 8px">Dapatkan kabar pesanan, pembayaran, dan chat walaupun aplikasi ditutup.</div><div class="row" style="justify-content:flex-start;gap:8px"><button class="btn s y" onclick="aktifkanNotif()">Aktifkan</button><button class="btn s o" onclick="NTD=true;render()">Nanti</button></div></div></div>`;
  const _v = window.view;
  window.view = function () {
    const h = _v();
    if (!canRecv || typeof h !== "string" || !U || !UD || window.SJ_ADMIN || UD.role === "admin" ||
        window.NTD || Notification.permission !== "default") return h;
    if (S.det || S.form || S.room || S.omap || S.loc || S.rev || S.lap || S.bayar || S.ep || S.pw ||
        S.dp || S.isiv || S.trk || S.lb || S.lapa) return h;
    return BN + h;
  };

  const _r = window.render;
  window.render = function () {
    _r();
    try {
      if (canRecv && U && UD && !TKD && Notification.permission === "granted") {
        TKD = true;
        simpanToken().catch(e => console.warn(e));
      }
    } catch (e) {}
  };
  auth.onAuthStateChanged(() => { TKD = false; });
  try { render(); } catch (e) {}
})();
(function () {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  const Asli = window.Notification;
  function Pengganti(judul, opsi) {
    navigator.serviceWorker.getRegistration()
      .then(r => r || navigator.serviceWorker.ready)
      .then(r => r.showNotification(judul, opsi))
      .catch(e => console.warn(e));
  }
  Pengganti.requestPermission = function () {
    return Asli.requestPermission.apply(Asli, arguments);
  };
  Object.defineProperty(Pengganti, "permission", {
    get: function () { return Asli.permission; }
  });
  window.Notification = Pengganti;
})();
