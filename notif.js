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
  let TKD = false, MAPP = null, MINTA = false, SYNCD = false;
  window.NTD = false;
  window.SJ_PUSH_OK = false;

  // Penyimpanan kecil per akun (di perangkat ini)
  function pref(k) {
    try { return localStorage.getItem("sj_" + k + ":" + (U ? U.uid : "")); } catch (e) { return null; }
  }
  function setPref(k, v) {
    try { localStorage.setItem("sj_" + k + ":" + (U ? U.uid : ""), v); } catch (e) {}
  }

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
    window.SJ_PUSH_OK = true;
  }

  window.aktifkanNotif = async function () {
    try {
      const p = await Notification.requestPermission();
      if (p !== "granted") { render(); return false; }
      setPref("notif_off", "0");
      await simpanToken();
      toast("Notifikasi aktif ✓");
      SYNCD = false;
      render();
      return true;
    } catch (e) {
      toastL("⚠️ Notifikasi gagal diaktifkan: " + (e.message || e.code || e));
      return false;
    }
  };

  // Buang token usang di browser, lalu daftarkan token baru
  window.segarkanToken = async function () {
    try {
      try { await msg().deleteToken(); } catch (e) { console.warn(e); }
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        if (r.scope.includes("fcm-scope")) await r.unregister();
      }
      await simpanToken();
      toast("Token diperbarui ✓");
      return true;
    } catch (e) {
      toastL("⚠️ Gagal memperbarui token: " + (e.message || e.code || e));
      return false;
    }
  };

  // Hidupkan/matikan notifikasi push. Mengembalikan true jika berhasil.
  window.ubahNotif = async function (hidup) {
    if (!canRecv) { toast("Perangkat ini belum mendukung notifikasi"); return false; }
    if (hidup) {
      if (Notification.permission === "denied") {
        toastL("Notifikasi diblokir di HP. Buka Pengaturan HP → Aplikasi → Chrome atau Serba Jasa → Notifikasi, lalu aktifkan.");
        return false;
      }
      setPref("notif_off", "0");
      return await window.aktifkanNotif();
    }
    setPref("notif_off", "1");
    window.SJ_PUSH_OK = false;
    try { await msg().deleteToken(); } catch (e) { console.warn(e); }
    toast("Notifikasi dimatikan");
    render();
    return true;
  };

  // ---- Sambungkan saklar "Notifikasi Perangkat" (kunci sj_nd) di Pengaturan ----
  const pgTogAsli = window.pgTog;

  // Baca keadaan saklar dari penyimpanan perangkat (tanpa mengubah index.html)
  function ndOn() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf("sj_nd") === 0) return localStorage.getItem(k) === "1";
      }
    } catch (e) {}
    return false;
  }
  // Samakan tampilan saklar dengan keadaan sebenarnya
  function setToggle(hidup) {
    if (typeof pgTogAsli === "function" && ndOn() !== hidup) pgTogAsli.call(window, "sj_nd", 0);
  }
  if (typeof pgTogAsli === "function") {
    window.pgTog = function (k) {
      if (k !== "sj_nd") return pgTogAsli.apply(this, arguments);
      if (ndOn()) {                       // pengguna mematikan
        window.ubahNotif(false);
        return pgTogAsli.apply(this, arguments);
      }
      window.ubahNotif(true).then(ok => { if (ok) setToggle(true); else render(); });  // menghidupkan
    };
  }

  // Izin hanya ditanyakan SEKALI per akun, pada ketukan pertama setelah masuk.
  // Selanjutnya pengguna mengaturnya lewat Pengaturan → Notifikasi.
  function mintaIzin() {
    if (MINTA || !canRecv || !U || !UD || window.SJ_ADMIN || UD.role === "admin") return;
    if (Notification.permission !== "default" || pref("notif_tanya") === "1") return;
    MINTA = true;
    setPref("notif_tanya", "1");
    window.aktifkanNotif();
  }
  document.addEventListener("click", mintaIzin, true);

  if (canRecv) {
    try {
      msg().onMessage(m => {
        const n = m.notification || {};
        const d = m.data || {};
        const judul = n.title || d.title || "Notifikasi";
        const isi = n.body || d.body || "";
        toastL("🔔 " + judul + (isi ? ": " + isi : ""));
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

  // Setiap aplikasi dibuka: simpan token (kecuali dimatikan di pengaturan)
  // dan samakan saklar di Pengaturan dengan keadaan sebenarnya.
  const _r = window.render;
  window.render = function () {
    _r();
    try {
      if (canRecv && U && UD && !TKD && Notification.permission === "granted" && pref("notif_off") !== "1") {
        TKD = true;
        simpanToken().catch(e => console.warn(e));
      }
      if (canRecv && U && UD && !SYNCD) {
        SYNCD = true;
        setToggle(Notification.permission === "granted" && pref("notif_off") !== "1");
      }
    } catch (e) {}
  };
  auth.onAuthStateChanged(() => { TKD = false; MINTA = false; SYNCD = false; });
  try { render(); } catch (e) {}
})();
(function () {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  const Asli = window.Notification;
  function Pengganti(judul, opsi) {
    // Jika push sudah aktif, lewati notifikasi lokal bawaan agar tidak muncul dobel.
    // Tombol "Kirim Notifikasi Uji" di Pengaturan tetap diizinkan.
    const isi = String((opsi && opsi.body) || "");
    const uji = /aktif ✓|are on ✓/.test(isi);
    if (window.SJ_PUSH_OK && judul === "SERBA JASA" && !uji) return;
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
(function () {
  const WORKER = "https://serba-jasa-push.nugrohosidik94.workers.dev";
  window.NTT = false;

  async function panggil(delay) {
    try {
      const idt = await U.getIdToken();
      const r = await fetch(WORKER + "/test", {
        method: "POST",
        headers: { Authorization: "Bearer " + idt, "Content-Type": "application/json" },
        body: JSON.stringify({ delay: delay })
      });
      return await r.json();
    } catch (e) { return { error: String(e) }; }
  }

  // Deteksi token usang dari balasan Worker/FCM
  const usang = j => /UNREGISTERED|NOT_FOUND|404/.test(JSON.stringify(j));

  window.ujiPushSekarang = async function () {
    toast("Mengirim tes...");
    let j = await panggil(0);
    if (usang(j)) {
      toast("Token usang, memperbarui...");
      if (await window.segarkanToken()) j = await panggil(0);
    }
    toastL("Hasil tes: " + JSON.stringify(j).slice(0, 300));
  };
  window.ujiPushTunda = async function () {
    let j = await panggil(15);
    if (usang(j)) {
      toast("Token usang, memperbarui...");
      if (await window.segarkanToken()) j = await panggil(15);
    }
    toastL(j.ok
      ? "Tes dijadwalkan. KUNCI LAYAR sekarang, notifikasi muncul dalam 15 detik."
      : "Gagal: " + JSON.stringify(j).slice(0, 250));
  };

  // Kartu tes hanya tampil jika alamat memakai ?uji=1
  const KT = `<div class="card" style="border-left:5px solid var(--acc)"><div class="in"><b>Notifikasi aktif</b><div class="mute" style="margin:4px 0 8px">Tes dulu agar yakin bisa muncul saat layar terkunci.</div><div class="row" style="justify-content:flex-start;gap:8px;flex-wrap:wrap"><button class="btn s y" onclick="ujiPushTunda()">Tes 15 detik (kunci layar)</button><button class="btn s o" onclick="ujiPushSekarang()">Tes sekarang</button><button class="btn s o" onclick="NTT=true;render()">Tutup</button></div></div></div>`;
  const _v = window.view;
  window.view = function () {
    const h = _v();
    if (typeof h !== "string" || !U || !UD || window.SJ_ADMIN || window.NTT ||
        !("Notification" in window) || Notification.permission !== "granted" ||
        !/[?&]uji=1/.test(location.search)) return h;
    if (S.det || S.form || S.room || S.omap || S.loc || S.rev || S.lap || S.bayar || S.ep ||
        S.pw || S.dp || S.isiv || S.trk || S.lb || S.lapa) return h;
    return KT + h;
  };
  try { render(); } catch (e) {}
})();
