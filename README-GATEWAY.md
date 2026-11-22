# Payment gateway Midtrans (Cloud Functions)
Butuh paket Firebase **Blaze** dan akun Midtrans (mulai dari Sandbox).
1. Tambahkan ke firebase.json:  "functions": { "source": "functions" }
2. `cd functions && npm install`
3. `firebase functions:secrets:set MIDTRANS_SERVER_KEY`  (Server Key dari Midtrans)
4. Parameter: MIDTRANS_CLIENT_KEY=Client Key Midtrans, MIDTRANS_ENV=sandbox (ganti `production` saat live), SITE_URL=alamat situs Anda
5. `firebase deploy --only functions,firestore:rules`
6. Midtrans Dashboard > Settings > Payment > Notification URL:
   https://asia-southeast2-serba-jasa.cloudfunctions.net/midtransWebhook
7. Uji di Sandbox sampai pesanan otomatis berstatus "Lunas", baru pindah ke production.
Koleksi `gwtrx` hanya bisa diakses server. Status `perlu-cek` = uang masuk tapi pesanan tidak bisa dilunasi otomatis (cek/refund manual).
