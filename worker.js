// Worker pembayaran Serba Jasa (Cloudflare, tanpa paket Blaze). Satu berkas: helper Firestore REST + logika Midtrans.
// Helper untuk Worker pembayaran Serba Jasa: Firestore lewat REST (tanpa Firebase Admin SDK, jadi tidak butuh Blaze)
// dan verifikasi Firebase ID token. Hanya memakai WebCrypto bawaan Workers.

class HttpErr extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const te = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uText = (s) => b64u(te.encode(s));
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha512hex(text) {
  const d = await crypto.subtle.digest("SHA-512", te.encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- Token akses Google dari service account ----------
let tokenCache = {tok: "", exp: 0};

async function signJwt(sa, scope, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64uText(JSON.stringify({alg: "RS256", typ: "JWT"}));
  const claim = b64uText(JSON.stringify({
    iss: sa.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600,
  }));
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, te.encode(head + "." + claim));
  return head + "." + claim + "." + b64u(sig);
}

async function accessToken(env) {
  if (tokenCache.tok && Date.now() < tokenCache.exp - 60000) return tokenCache.tok;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const jwt = await signJwt(sa, "https://www.googleapis.com/auth/datastore");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {"Content-Type": "application/x-www-form-urlencoded"},
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt,
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Gagal mengambil token Google: " + (j.error_description || r.status));
  tokenCache = {tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000};
  return tokenCache.tok;
}

// ---------- Konversi nilai Firestore <-> JS ----------
function enc(v) {
  if (v === null || v === undefined) return {nullValue: null};
  if (typeof v === "boolean") return {booleanValue: v};
  if (typeof v === "number") return Number.isInteger(v) ? {integerValue: String(v)} : {doubleValue: v};
  if (typeof v === "string") return {stringValue: v};
  if (Array.isArray(v)) return {arrayValue: {values: v.map(enc)}};
  return {mapValue: {fields: encFields(v)}};
}
function encFields(o) {
  const f = {};
  for (const [k, x] of Object.entries(o)) if (x !== undefined) f[k] = enc(x);
  return f;
}
function dec(v) {
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
  if ("mapValue" in v) return decFields(v.mapValue.fields || {});
  return null;
}
function decFields(f) {
  const o = {};
  for (const [k, x] of Object.entries(f || {})) o[k] = dec(x);
  return o;
}

// ---------- Firestore REST ----------
const root = (env) => `projects/${env.FIREBASE_PROJECT}/databases/(default)/documents`;
const base = (env) => `https://firestore.googleapis.com/v1/${root(env)}`;
const idOf = (name) => name.split("/").pop();

async function api(env, path, body) {
  const r = await fetch(base(env) + path, {
    method: "POST",
    headers: {Authorization: "Bearer " + (await accessToken(env)), "Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch (_) { j = {raw: txt}; }
  if (!r.ok) { const e = new Error("Firestore " + r.status + ": " + txt.slice(0, 300)); e.status = r.status; throw e; }
  return j;
}

const mapDoc = (d) => ({id: idOf(d.name), data: decFields(d.fields), updateTime: Date.parse(d.updateTime)});

async function getDoc(env, path) {
  const j = await api(env, ":batchGet", {documents: [`${root(env)}/${path}`]});
  const f = j[0] && j[0].found;
  return f ? mapDoc(f) : null;
}

// filters: [[field, "EQUAL" | "IN", nilai], ...]
async function query(env, collection, filters) {
  const ff = filters.map(([field, op, value]) => ({fieldFilter: {field: {fieldPath: field}, op, value: enc(value)}}));
  const where = ff.length === 1 ? ff[0] : {compositeFilter: {op: "AND", filters: ff}};
  const j = await api(env, ":runQuery", {structuredQuery: {from: [{collectionId: collection}], where}});
  return j.filter((x) => x.document).map((x) => mapDoc(x.document));
}

function writeUpdate(env, path, data, del = [], mustExist = false) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  return {
    update: {name: `${root(env)}/${path}`, fields: encFields(data)},
    updateMask: {fieldPaths: [...keys, ...del]},
    ...(mustExist ? {currentDocument: {exists: true}} : {}),
  };
}
const writeSet = (env, path, data) => ({update: {name: `${root(env)}/${path}`, fields: encFields(data)}});

// Tulis langsung tanpa transaksi
const setDoc = (env, path, data) => api(env, ":commit", {writes: [writeSet(env, path, data)]});
const updateDoc = (env, path, data, del = []) => api(env, ":commit", {writes: [writeUpdate(env, path, data, del, true)]});

// Transaksi: fn(t) membaca lewat await t.get(path), menulis lewat t.update / t.set. Dicoba ulang jika bentrok.
async function runTx(env, fn) {
  for (let i = 0; i < 5; i++) {
    const {transaction} = await api(env, ":beginTransaction", {options: {readWrite: {}}});
    const writes = [];
    const t = {
      async get(path) {
        const j = await api(env, ":batchGet", {documents: [`${root(env)}/${path}`], transaction});
        const f = j[0] && j[0].found;
        return f ? mapDoc(f) : null;
      },
      update: (path, data, del = []) => writes.push(writeUpdate(env, path, data, del, true)),
      set: (path, data) => writes.push(writeSet(env, path, data)),
    };
    try {
      await fn(t);
      await api(env, ":commit", {writes, transaction});
      return;
    } catch (e) {
      if ((e.status === 409 || e.status === 400 && /aborted|contention/i.test(e.message)) && i < 4) continue;
      throw e;
    }
  }
}

// ---------- Verifikasi Firebase ID token ----------
let jwks = {keys: [], exp: 0};

async function verifyIdToken(env, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpErr(401, "Masuk dulu.");
  let head, claim;
  try {
    head = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    claim = JSON.parse(new TextDecoder().decode(unb64u(parts[1])));
  } catch (_) { throw new HttpErr(401, "Token tidak valid."); }
  if (head.alg !== "RS256") throw new HttpErr(401, "Token tidak valid.");
  if (Date.now() > jwks.exp || !jwks.keys.some((k) => k.kid === head.kid)) {
    const r = await fetch("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com");
    const j = await r.json();
    jwks = {keys: j.keys || [], exp: Date.now() + 3600000};
  }
  const jwk = jwks.keys.find((k) => k.kid === head.kid);
  if (!jwk) throw new HttpErr(401, "Token tidak valid.");
  const key = await crypto.subtle.importKey("jwk", jwk, {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"}, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64u(parts[2]), te.encode(parts[0] + "." + parts[1]));
  const now = Math.floor(Date.now() / 1000);
  if (!ok || claim.aud !== env.FIREBASE_PROJECT || claim.iss !== "https://securetoken.google.com/" + env.FIREBASE_PROJECT
    || !claim.sub || claim.exp < now || claim.iat > now + 300) throw new HttpErr(401, "Sesi tidak valid, masuk ulang.");
  return claim.sub;
}

// ================= Logika pembayaran =================
// Payment gateway Midtrans Snap untuk Serba Jasa, versi Cloudflare Worker (tanpa paket Blaze).
// Port dari functions/index.js. Rahasia (Server Key, service account) hanya ada di secret Worker.

const prod = (env) => env.MIDTRANS_ENV === "production";
const SNAP = (env) => (prod(env) ? "https://app.midtrans.com" : "https://app.sandbox.midtrans.com");
const API = (env) => (prod(env) ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com");
const basic = (env) => "Basic " + btoa(env.MIDTRANS_SERVER_KEY + ":");

// ---------- CORS ----------
function corsHeaders(env, req) {
  const allow = (env.ALLOW_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": allow.includes(o) ? o : allow[0] || "",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
const reply = (body, status, headers = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {status, headers: {"Content-Type": typeof body === "string" ? "text/plain" : "application/json", ...headers}});

// ---------- Hitung biaya (sama dengan hitung() di functions) ----------
async function hitung(env, o) {
  const cfg = ((await getDoc(env, "config/bayar")) || {}).data || {};
  const persen = cfg.persen ?? 10, PU = cfg.pu ?? 5, PD = cfg.pd ?? 2;
  const done = await query(env, "pesanan", [["pen", "EQUAL", o.pen], ["st", "EQUAL", "selesai"]]);
  const n = done.length, cut = n >= 30 ? 2 : n >= 10 ? 1 : 0, base = Math.max(0, persen - cut);
  const prevs = done.filter((d) => d.data.cus === o.cus && String(d.data.id) !== String(o.id) && d.data.at < o.at);
  const ul = prevs.length > 0;
  // Diskon pesan-ulang hanya jika ada pesanan selesai sebelumnya yang belum dipakai (penanda /pakai/{id}).
  let prev = null;
  if (ul) {
    const used = await Promise.all(prevs.map((d) => getDoc(env, "pakai/" + d.id)));
    const free = prevs.find((d, i) => !used[i]);
    prev = free ? free.id : null;
  }
  const gross = Math.round(o.h * (ul ? Math.min(base, PU) : base) / 100);
  const pot = prev ? Math.min(Math.round(o.h * PD / 100), gross) : 0;
  return {gross, pot, kom: gross - pot, net: o.h - gross, bayar: o.h - pot, prev};
}

// ---------- POST /buat-transaksi ----------
async function buat(env, req) {
  if (!env.MIDTRANS_SERVER_KEY) throw new HttpErr(412, "Server Key Midtrans belum diatur.");
  if (!env.MIDTRANS_CLIENT_KEY) throw new HttpErr(412, "Client Key Midtrans belum diatur.");
  const m = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
  const uid = await verifyIdToken(env, m && m[1]);
  const body = await req.json().catch(() => ({}));
  const oid = String(body.oid || "");
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(oid)) throw new HttpErr(400, "ID pesanan tidak valid.");
  const ps = await getDoc(env, "pesanan/" + oid);
  if (!ps) throw new HttpErr(404, "Pesanan tidak ditemukan.");
  const o = ps.data;
  if (o.cus !== uid) throw new HttpErr(403, "Bukan pesanan Anda.");
  if (o.st !== "diterima" || !["belum", "ditolak"].includes(o.pay || "belum"))
    throw new HttpErr(409, "Pesanan ini tidak bisa dibayar sekarang.");
  const u = ((await getDoc(env, "users/" + uid)) || {}).data || {};
  if (u.blok) throw new HttpErr(403, "Akun diblokir.");

  const r = await hitung(env, o);
  if (!Number.isInteger(r.bayar) || r.bayar < 1) throw new HttpErr(409, "Nominal pesanan tidak valid.");
  const out = (token, url) => ({token, url, clientKey: env.MIDTRANS_CLIENT_KEY, snapJs: SNAP(env) + "/snap/snap.js"});

  // Pakai ulang transaksi yang masih menunggu supaya pelanggan tidak punya dua tagihan aktif untuk satu pesanan.
  const lama = await query(env, "gwtrx", [["oid", "EQUAL", oid], ["st", "EQUAL", "menunggu"]]);
  const pakai = lama.find((x) => x.data.uid === uid && x.data.amt === r.bayar && x.data.tok && Date.now() - x.data.at < 23 * 3600000);
  if (pakai) return out(pakai.data.tok, pakai.data.url);

  const orderId = `SJ-${oid}-${Date.now()}`;
  const pm = (env.PAY_METHODS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const res = await fetch(SNAP(env) + "/snap/v1/transactions", {
    method: "POST",
    headers: {"Content-Type": "application/json", Accept: "application/json", Authorization: basic(env)},
    body: JSON.stringify({
      transaction_details: {order_id: orderId, gross_amount: r.bayar},
      item_details: [{id: oid, price: r.bayar, quantity: 1, name: String(o.jn || "Jasa").slice(0, 50)}],
      customer_details: {first_name: String(o.cn || "Pelanggan").slice(0, 40), phone: o.hp || undefined},
      expiry: {unit: "hours", duration: 24},
      ...(pm.length ? {enabled_payments: pm} : {}),
      callbacks: {finish: env.SITE_URL || undefined},
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.redirect_url) { console.error("Midtrans", res.status, JSON.stringify(j)); throw new HttpErr(502, "Gateway pembayaran gagal."); }
  await setDoc(env, "gwtrx/" + orderId, {oid, uid, amt: r.bayar, st: "menunggu", at: Date.now(), tok: j.token, url: j.redirect_url});
  return out(j.token, j.redirect_url);
}

// ---------- POST /webhook (notifikasi Midtrans) ----------
async function webhook(env, req) {
  const b = await req.json().catch(() => ({}));
  // Sejak 28 Okt 2026 Midtrans menandatangani notifikasi dengan Signature Secret Key (terpisah dari Server Key).
  const sigKey = env.MIDTRANS_SIGNATURE_KEY || env.MIDTRANS_SERVER_KEY;
  const sig = await sha512hex(String(b.order_id) + String(b.status_code) + String(b.gross_amount) + sigKey);
  if (sig !== b.signature_key) return reply("signature salah", 403);

  const sr = await fetch(API(env) + "/v2/" + encodeURIComponent(b.order_id) + "/status", {headers: {Accept: "application/json", Authorization: basic(env)}});
  const s = await sr.json();
  const tg = await getDoc(env, "gwtrx/" + b.order_id);
  if (!tg) return reply("ok", 200);
  const g = tg.data, tpath = "gwtrx/" + b.order_id;
  const paid = s.transaction_status === "settlement" || (s.transaction_status === "capture" && s.fraud_status === "accept");

  if (!paid) {
    if (["expire", "cancel", "deny", "failure"].includes(s.transaction_status) && g.st === "menunggu") await updateDoc(env, tpath, {st: s.transaction_status});
    if (["refund", "partial_refund", "chargeback", "partial_chargeback"].includes(s.transaction_status) && g.st === "lunas") {
      // Refund di dashboard Midtrans -> pesanan ikut ditandai refund jika dana belum masuk saldo penyedia.
      const full = s.transaction_status === "refund", ppath = "pesanan/" + g.oid;
      await runTx(env, async (t) => {
        const [a, p] = [await t.get(tpath), await t.get(ppath)];
        if (!a || a.data.st !== "lunas") return;
        const po = p ? p.data : null;
        const belumCair = !!po && !["saldo", "dicairkan"].includes(po.cair);
        if (full && belumCair && po.via === "gateway" && po.pay === "lunas") {
          t.update(ppath, {pay: "refund", trf: Date.now(), ...(po.st === "diterima" ? {st: "dibatalkan"} : {})});
          t.update(tpath, {st: "refund", tr: Date.now()});
        } else {
          t.update(tpath, {st: "perlu-cek", cat: "Midtrans melaporkan " + s.transaction_status + (belumCair ? "" : " (dana sudah masuk saldo penyedia)")});
        }
      });
    }
    return reply("ok", 200);
  }
  if (g.st === "lunas") return reply("ok", 200);
  if (Math.round(Number(s.gross_amount)) !== g.amt) { await updateDoc(env, tpath, {st: "perlu-cek", cat: "nominal berbeda"}); return reply("ok", 200); }

  const ppath = "pesanan/" + g.oid, p0 = await getDoc(env, ppath);
  const r = p0 ? await hitung(env, p0.data) : null;
  await runTx(env, async (t) => {
    const pkpath = r && r.prev ? "pakai/" + r.prev : null;
    const a = await t.get(tpath), p = await t.get(ppath), pk = pkpath ? await t.get(pkpath) : null;
    if (!a || a.data.st === "lunas") return;
    const po = p ? p.data : null;
    const ok = po && po.st === "diterima" && ["belum", "ditolak"].includes(po.pay || "belum") && r && r.bayar === g.amt && !pk;
    if (ok) {
      t.update(ppath, {pay: "lunas", kom: r.kom, net: r.net, pot: r.pot, tp: Date.now(), via: "gateway", lp: true, ...(r.prev ? {prev: r.prev} : {})});
      if (pkpath) t.set(pkpath, {uid: po.cus, oid: g.oid, at: Date.now()});
      t.update(tpath, {st: "lunas", tp: Date.now()});
    } else {
      t.update(tpath, {st: "perlu-cek", cat: "dibayar tapi pesanan tidak bisa dilunasi otomatis (refund manual?)"});
    }
  });
  return reply("ok", 200);
}

// ---------- Pelepasan dana ke dompet penyedia ----------
async function lepas(env, oid) {
  const ppath = "pesanan/" + oid, p0 = await getDoc(env, ppath);
  if (!p0) return "tidak-ada";
  const o = p0.data;
  if (o.st !== "selesai" || (o.pay || "belum") !== "lunas" || !["belum", "diminta", undefined].includes(o.cair)) return "skip";
  const mode = env.AUTO_RELEASE || "konfirmasi";
  if (mode === "konfirmasi" && !((o.kc || 0) > 0 || Date.now() > p0.updateTime + 172800000)) return "menunggu-konfirmasi";
  const ids = [String(oid), Number(oid)].filter((x) => x === String(oid) || Number.isFinite(x));
  const lap = await query(env, "laporan", [["oid", "IN", ids]]);
  if (lap.some((d) => d.data.st !== "selesai")) return "ada-laporan";
  const r = await hitung(env, o), g = r.gross, kom = Math.max(0, g - (o.pot || 0)), net = o.h - g, mid = "s_" + oid, now = Date.now();
  await runTx(env, async (t) => {
    const rf = "dompet/" + o.pen, ps = await t.get(ppath), ds = await t.get(rf);
    const pd = ps && ps.data;
    if (!pd || ["saldo", "dicairkan"].includes(pd.cair) || pd.pay !== "lunas" || pd.st !== "selesai") return;
    t.update(ppath, {cair: "saldo", tc: now, kom, net, auto: true}, ["lp"]);
    t.set("mutasi/" + mid, {uid: o.pen, j: "pendapatan", d: net, k: "Pendapatan: " + o.jn, ref: String(oid), at: now});
    if (ds) t.update(rf, {s: ds.data.s + net, lm: mid, at: now}); else t.set(rf, {s: net, lm: mid, at: now});
  });
  return "ok";
}

async function proses(env, d) {
  try {
    const h = await lepas(env, d.id);
    if (h === "ok" || h === "skip" || h === "tidak-ada") await updateDoc(env, "pesanan/" + d.id, {}, ["lp"]);
  } catch (e) { console.error("lepas", d.id, e); }
}

// Tiap 5 menit: hanya pesanan bertanda lp == true (menunggu dilepas ke dompet penyedia).
async function lepasOtomatis(env) {
  const q = await query(env, "pesanan", [["st", "EQUAL", "selesai"], ["lp", "EQUAL", true]]);
  for (const d of q) await proses(env, d);
}

// Harian 03:00 WIB: pesanan lunas yang belum bertanda lp (mis. dibayar lewat dompet) diberi lp = true lalu diproses.
async function sapuHarian(env) {
  const q = await query(env, "pesanan", [["st", "EQUAL", "selesai"], ["pay", "EQUAL", "lunas"]]);
  for (const d of q) {
    if (d.data.cair && d.data.cair !== "diminta") continue;
    try { if (d.data.lp !== true) await updateDoc(env, "pesanan/" + d.id, {lp: true}); } catch (e) { console.error("sapu", d.id, e); continue; }
    await proses(env, d);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), cors = corsHeaders(env, req);
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: cors});
    try {
      if (req.method === "POST" && url.pathname === "/buat-transaksi") return reply(await buat(env, req), 200, cors);
      if (req.method === "POST" && url.pathname === "/webhook") return await webhook(env, req);
      if (req.method === "GET" && url.pathname === "/") return reply("Serba Jasa pay: aktif", 200);
      return reply({error: "Tidak ditemukan"}, 404, cors);
    } catch (e) {
      if (e instanceof HttpErr) return reply({error: e.message}, e.status, cors);
      console.error(url.pathname, e);
      return reply(url.pathname === "/webhook" ? "error" : {error: "Server pembayaran error."}, 500, cors);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(event.cron === "0 20 * * *" ? sapuHarian(env) : lepasOtomatis(env));
  },
};
