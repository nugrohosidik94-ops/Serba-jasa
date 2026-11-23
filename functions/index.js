// Payment gateway Midtrans Snap untuk Serba Jasa. Kunci rahasia hanya ada di server (Secret Manager).
const {onCall, onRequest, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret, defineString} = require("firebase-functions/params");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const crypto = require("crypto");
admin.initializeApp();
const db = admin.firestore();

const KEY = defineSecret("MIDTRANS_SERVER_KEY");
const ENV = defineString("MIDTRANS_ENV", {default: "sandbox"});
const CLIENT = defineString("MIDTRANS_CLIENT_KEY", {default: ""});
const PAYMENTS = defineString("PAY_METHODS", {default: ""});
const SITE = defineString("SITE_URL", {default: "https://serba-jasa.web.app"});
const MODE = defineString("AUTO_RELEASE", {default: "selesai"});
const REGION = "asia-southeast2";
const prod = () => ENV.value() === "production";
const SNAP = () => (prod() ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");
const API = () => (prod() ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const auth = () => "Basic " + Buffer.from(KEY.value() + ":").toString("base64");

async function hitung(o) {
  const cfg = (await db.doc("config/bayar").get()).data() || {};
  const persen = cfg.persen ?? 10, PU = cfg.pu ?? 5, PD = cfg.pd ?? 2;
  const done = await db.collection("pesanan").where("pen", "==", o.pen).where("st", "==", "selesai").get();
  const n = done.size, cut = n >= 30 ? 2 : n >= 10 ? 1 : 0, base = Math.max(0, persen - cut);
  const ul = done.docs.some((d) => { const x = d.data(); return x.cus === o.cus && String(x.id) !== String(o.id) && x.at < o.at; });
  const gross = Math.round(o.h * (ul ? Math.min(base, PU) : base) / 100);
  const pot = ul ? Math.min(Math.round(o.h * PD / 100), gross) : 0;
  return {gross, pot, kom: gross - pot, net: o.h - gross, bayar: o.h - pot};
}

exports.buatTransaksi = onCall({region: REGION, secrets: [KEY]}, async (req) => {
  try { return await buat(req); } catch (e) {
    if (e instanceof HttpsError) throw e;
    console.error("buatTransaksi", e); throw new HttpsError("internal", "Server pembayaran error: " + (e.message || e));
  }
});

async function buat(req) {
  if (!KEY.value()) throw new HttpsError("failed-precondition", "Server Key Midtrans belum diatur.");
  if (!CLIENT.value()) throw new HttpsError("failed-precondition", "Client Key Midtrans belum diatur.");
  if (!req.auth) throw new HttpsError("unauthenticated", "Masuk dulu.");
  const oid = String(req.data?.oid || "");
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(oid)) throw new HttpsError("invalid-argument", "ID pesanan tidak valid.");
  const ps = await db.doc("pesanan/" + oid).get();
  if (!ps.exists) throw new HttpsError("not-found", "Pesanan tidak ditemukan.");
  const o = ps.data();
  if (o.cus !== req.auth.uid) throw new HttpsError("permission-denied", "Bukan pesanan Anda.");
  if (o.st !== "diterima" || !["belum", "ditolak"].includes(o.pay || "belum"))
    throw new HttpsError("failed-precondition", "Pesanan ini tidak bisa dibayar sekarang.");
  const u = (await db.doc("users/" + req.auth.uid).get()).data() || {};
  if (u.blok) throw new HttpsError("permission-denied", "Akun diblokir.");

  const r = await hitung(o);
  const orderId = `SJ-${oid}-${Date.now()}`;
  const res = await fetch(SNAP() + "/snap/v1/transactions", {
    method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/json", Authorization: auth()},
    body: JSON.stringify({
      transaction_details: {order_id: orderId, gross_amount: r.bayar},
      item_details: [{id: oid, price: r.bayar, quantity: 1, name: String(o.jn || "Jasa").slice(0, 50)}],
      customer_details: {first_name: String(o.cn || "Pelanggan").slice(0, 40), phone: o.hp || undefined},
      expiry: {unit: "hours", duration: 24},
      ...(PAYMENTS.value().trim() ? {enabled_payments: PAYMENTS.value().split(",").map((x) => x.trim()).filter(Boolean)} : {}),
      callbacks: {finish: SITE.value()},
    }),
  });
  const j = await res.json();
  if (!res.ok || !j.redirect_url) { console.error("Midtrans", res.status, j); throw new HttpsError("internal", "Gateway pembayaran gagal."); }
  await db.doc("gwtrx/" + orderId).set({oid, uid: req.auth.uid, amt: r.bayar, st: "menunggu", at: Date.now()});
  return {token: j.token, url: j.redirect_url, clientKey: CLIENT.value(), snapJs: SNAP() + "/snap/snap.js"};
}

exports.midtransWebhook = onRequest({region: REGION, secrets: [KEY]}, async (req, res) => {
  try {
    const b = req.body || {};
    const sig = crypto.createHash("sha512").update(String(b.order_id) + String(b.status_code) + String(b.gross_amount) + KEY.value()).digest("hex");
    if (sig !== b.signature_key) return res.status(403).send("signature salah");

    const sr = await fetch(API() + "/v2/" + encodeURIComponent(b.order_id) + "/status", {headers: {Accept: "application/json", Authorization: auth()}});
    const s = await sr.json();
    const tref = db.doc("gwtrx/" + b.order_id), tg = await tref.get();
    if (!tg.exists) return res.send("ok");
    const g = tg.data();
    const paid = s.transaction_status === "settlement" || (s.transaction_status === "capture" && s.fraud_status === "accept");
    if (!paid) {
      if (["expire", "cancel", "deny", "failure"].includes(s.transaction_status) && g.st === "menunggu") await tref.update({st: s.transaction_status});
      return res.send("ok");
    }
    if (g.st === "lunas") return res.send("ok");
    if (Math.round(Number(s.gross_amount)) !== g.amt) { await tref.update({st: "perlu-cek", cat: "nominal berbeda"}); return res.send("ok"); }

    const pref = db.doc("pesanan/" + g.oid), p0 = await pref.get();
    const r = p0.exists ? await hitung(p0.data()) : null;
    await db.runTransaction(async (t) => {
      const [a, p] = await Promise.all([t.get(tref), t.get(pref)]);
      if (a.data().st === "lunas") return;
      const po = p.exists ? p.data() : null;
      const ok = po && po.st === "diterima" && ["belum", "ditolak"].includes(po.pay || "belum") && r && r.bayar === g.amt;
      if (ok) {
        t.update(pref, {pay: "lunas", kom: r.kom, net: r.net, pot: r.pot, tp: Date.now(), via: "gateway"});
        t.update(tref, {st: "lunas", tp: Date.now()});
      } else {
        t.update(tref, {st: "perlu-cek", cat: "dibayar tapi pesanan tidak bisa dilunasi otomatis (refund manual?)"});
      }
    });
    res.send("ok");
  } catch (e) { console.error(e); res.status(500).send("error"); }
});

async function lepas(oid) {
  const pref = db.doc("pesanan/" + oid), p0 = await pref.get();
  if (!p0.exists) return "tidak-ada";
  const o = p0.data();
  if (o.st !== "selesai" || (o.pay || "belum") !== "lunas" || !["belum", "diminta", undefined].includes(o.cair)) return "skip";
  const ids = [String(oid), Number(oid)].filter((x) => x === String(oid) || Number.isFinite(x));
  const lap = await db.collection("laporan").where("oid", "in", ids).get();
  if (lap.docs.some((d) => d.data().st !== "selesai")) return "ada-laporan";
  if (MODE.value() === "konfirmasi" && !((o.kc || 0) > 0 || Date.now() > (o.ts || 0) + 172800000)) return "menunggu-konfirmasi";
  const r = await hitung(o), g = r.gross, kom = Math.max(0, g - (o.pot || 0)), net = o.h - g, mid = "s_" + oid, now = Date.now();
  await db.runTransaction(async (t) => {
    const rf = db.doc("dompet/" + o.pen), [ps, ds] = await Promise.all([t.get(pref), t.get(rf)]);
    if (["saldo", "dicairkan"].includes(ps.data().cair)) return;
    t.update(pref, {cair: "saldo", tc: now, kom, net, auto: true});
    t.set(db.doc("mutasi/" + mid), {uid: o.pen, j: "pendapatan", d: net, k: "Pendapatan: " + o.jn, ref: String(oid), at: now});
    if (ds.exists) t.update(rf, {s: ds.data().s + net, lm: mid, at: now}); else t.set(rf, {s: net, lm: mid, at: now});
  });
  return "ok";
}

exports.lepasOtomatis = onSchedule({region: "asia-southeast1", schedule: "every 5 minutes", timeZone: "Asia/Jakarta"}, async () => {
  const q = await db.collection("pesanan").where("st", "==", "selesai").where("pay", "==", "lunas").get();
  for (const d of q.docs) {
    const c = d.data().cair;
    if (!c || c === "belum" || c === "diminta") { try { await lepas(d.id); } catch (e) { console.error("lepas", d.id, e); } }
  }
});
