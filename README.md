# HatiQu Backend

Express + Socket.IO + LiveKit + SQLite bawaan Node (`node:sqlite`, tanpa kompilasi native). Prioritas fitur:

| # | Fitur | Transport | Kode utama |
|---|-------|-----------|-----------|
| 1 | Q&A chat pasien ↔ nakes (TEMU B / Pesan Pasien) | Socket.IO + REST | `services/qna.js`, `routes/qna.js` |
| 2 | Video call / telepon pasien ↔ nakes | LiveKit + REST + Socket.IO (dering) | `services/calls.js`, `services/livekit.js` |
| 3 | Chat multidisiplin antar nakes (grup pasien, DM, konsultasi, handover) | Socket.IO + REST | `services/team.js`, `routes/team.js` |
| 4 | Resume medis (CPPT, obat, lab → draft → final → kirim) | REST | `services/summary.js`, `routes/summaries.js` |
| 5 | Monitoring (catatan gejala harian + triase zona) | REST + Socket.IO (alert) | `services/monitoring.js`, `services/triage.js` |

## Menjalankan

Butuh Node.js >= 22.13 (disarankan LTS terbaru).

```bash
npm install
cp .env.example .env     # isi JWT_SECRET dan LIVEKIT_*
npm run seed             # data demo (password semua akun: demo123)
npm run dev
```

Lalu buka **http://localhost:3000** — backend menyajikan frontend dari folder `public/` (satu origin, tanpa CORS).

| Halaman | Isi |
|---|---|
| `/` (`index.html`) | Login: tab **Pasien** (No. RM + kata sandi, atau *Buat akun baru*) dan tab **Tenaga Kesehatan** (email + kata sandi) |
| `/nakes.html` | Portal nakes (dashboard, pasien, CPPT, resep, lab, resume, komunikasi, monitoring, panggilan) |
| `/pasien.html` | Aplikasi pasien (catatan gejala, TEMU chat/video/telepon, hasil lab, resep, resume) |

Akun demo (password semua `demo123`): **nakes** `dr.rina@hfcare.demo`, `dr.lina@…`, `ns.dewi@…`, `ns.fajar@…`, `apt.dinda@…`, `putri.gizi@…` (domain `@hfcare.demo`); **pasien** RM `12-34-56` (Tn. Budi).
Coba *Buat akun baru*: RM `12-34-78` + lahir `2 Mar 1954`, atau RM `12-35-01` + lahir `20 Jan 1965`.
> Database lama (`data/hatiqu.db`) tetap kompatibel (skema tidak berubah). Untuk memakai tanggal lahir demo baru, hapus `data/hatiqu.db*` lalu `npm run seed`.

### Frontend terhubung ke backend
Pasien: Catatan Gejala → `POST /api/monitoring/:rm/logs` (zona dihitung server) · TEMU chat → `/api/qna` + Socket.IO · video/telepon → `/api/calls` (LiveKit) · Hasil Lab, Status Resep, Resume Medis, Info Pengguna → data server.
Nakes: semua halaman memakai REST + Socket.IO. Menu pasien yang belum punya backend (pendaftaran online, antrian, home care, jadwal K2/K3, kode akses TEMU, dll.) masih prototipe lokal; menu berisi contoh hanya tampil untuk RM 12-34-56.
Pesan masuk: **titik merah + angka di nama** pada daftar chat (pasien dan antar nakes; yang belum dibaca di urutan atas), badge angka di menu/tab, judul tab browser `(n)`, garis **“Pesan belum dibaca”** + label BARU saat chat dibuka, dan centang **✓ Terkirim / ✓✓ Dibaca** (Q&A pasien–nakes dan chat langsung antar nakes). Pesan baru yang masuk saat tab browser tidak aktif tetap berstatus belum dibaca sampai tab dibuka lagi.
Kamera/mikrofon butuh **HTTPS** (kecuali `localhost`). `livekit-client` dimuat dari jsDelivr (versi dipin di `public/js/common.js`, bisa diganti lewat `window.HATIQU_LIVEKIT_SRC`).

### LiveKit
1. Buat project di LiveKit Cloud (atau self-host), isi `LIVEKIT_URL` (`wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
2. Di dashboard LiveKit, tambahkan webhook ke `https://<domain-anda>/api/livekit/webhook` (dipakai untuk menandai panggilan mulai/selesai).
3. Klien memakai `livekit-client` dengan `url` + `token` dari respons `/api/calls`.

## Autentikasi
Dua jalur login yang tidak bisa ditukar: `POST /api/auth/login {rm, password}` (pasien) atau `{email, password}` (nakes) → `{token, user, patientRm}`. `POST /api/auth/register {rm, birthDate:'YYYY-MM-DD', password(min 8)}` membuat akun pasien (RM + tanggal lahir harus cocok dengan data rumah sakit). Kirim `Authorization: Bearer <token>` di REST, dan `io(url, { auth: { token } })` di Socket.IO.
Pasien hanya bisa mengakses data RM miliknya; nakes bisa mengakses semua pasien (lihat "Hardening").

## REST API

**Umum** (pasien boleh membaca `GET …/medications` dan `GET …/labs` miliknya sendiri): `GET /api/auth/me`, `GET /api/auth/notifications`, `POST /api/auth/notifications/read`, `GET /api/staff`, `GET /api/patients?q=`, `GET|PATCH /api/patients/:rm`, `POST /api/patients` (dokter/perawat; opsional `account` untuk akun pasien).

**1. Q&A** — `GET /api/qna/conversations` (inbox nakes), `GET /api/qna/:rm/messages?before=&limit=`, `POST /api/qna/:rm/messages {body}`, `POST /api/qna/:rm/read`.

**2. Panggilan**
- `POST /api/calls {type:'video'|'audio', patientRm?}` → `{call, connection:{url, token, roomName}}`. Pasien: otomatis RM sendiri, berdering ke semua nakes. Nakes: wajib `patientRm`.
- `POST /api/calls/:id/accept` → `{call, connection}` · `/decline` · `/end` · `/token` (reconnect / nakes lain ikut bergabung)
- `GET /api/calls/patient/:rm` riwayat · `GET /api/calls/:id`
- Dering otomatis jadi `missed` setelah 60 detik. Panggilan `audio` hanya boleh publish mikrofon (dibatasi di token).

**3. Chat tim** (nakes saja) — `GET /api/team/rooms`, `GET /api/team/rooms/patient/:rm` (grup tim pasien, dibuat otomatis), `POST /api/team/rooms/direct {userId}`, `POST /api/team/rooms {name,userIds}`, `GET|POST /api/team/rooms/:id/messages`, `POST /api/team/rooms/:id/read`, `POST|DELETE /api/team/rooms/:id/members`.
Pesan punya `kind`: `text`, `konsultasi` (`meta:{to,urgency:'rutin'|'segera'}`), `handover` (`meta:{from,to,kondisi,tindakan,terapi,masalah,rencana}`) → dua jenis terakhir memicu notifikasi ke anggota.

**4. Resume medis**
- Data pendukung: `GET|POST /api/patients/:rm/cppt` (`{S,O,A,P}`), `GET|POST /api/patients/:rm/medications` (POST: dokter), `POST …/medications/:id/review {note}` (apoteker), `GET|POST /api/patients/:rm/labs`.
- `GET /api/patients/:rm/resume-preview` — gabungan otomatis (CPPT terbaru, obat, lab terbaru, monitoring 7 hari).
- `POST /api/patients/:rm/summaries` (dokter) → draft · `PATCH /api/summaries/:id` (hanya draft) · `POST /api/summaries/:id/finalize` (snapshot dibekukan, tidak bisa diedit) · `POST /api/summaries/:id/send {facility, note}` (tercatat sebagai handover di grup tim) · `GET /api/summaries/:id`. Pasien hanya melihat resume final/terkirim miliknya.

**5. Monitoring**
- `POST /api/monitoring/:rm/logs` — catatan harian; body: `{date?, weight, systolic, diastolic, pulse, glucose, cholesterol, uricAcid, symptoms[], durationDays, chestPain:{scale,radiates,relievedByRest}, restDyspnea, syncope, note}`. Selisih BB 3 hari dan zona (hijau/kuning/merah) **dihitung server** dengan aturan yang sama seperti `triage()` di POV Pasien. Respons berisi `zona`, `reasons`, `advice`.
- `GET /api/monitoring/:rm/logs?days=30` · `GET /api/monitoring/overview` (semua pasien, nakes) · `GET /api/monitoring/symptoms` (daftar gejala valid) · `POST /api/monitoring/:rm/followups {action}` (masuk CPPT).

## Socket.IO

Klien → server (semua mendukung ack `{ok, ...}` / `{ok:false, error}`):

| Event | Payload | Keterangan |
|---|---|---|
| `qna:join` | `{rm}` | nakes buka percakapan pasien; pasien otomatis join. Ack berisi 50 pesan terakhir |
| `qna:send` | `{rm?, body}` | `rm` diabaikan untuk pasien |
| `qna:typing` / `qna:read` | `{rm?, typing}` / `{rm?}` | |
| `team:join` / `team:send` / `team:typing` / `team:read` | `{roomId, …}` | `team:send` sama dengan body REST (`kind`, `body`, `meta`) |

Server → klien: `qna:message`, `qna:typing`, `qna:read`, `qna:new` (ke semua nakes, ada flag `urgent`), `team:message`, `team:typing`, `team:read`, `notification`,
`call:incoming`, `call:accepted`, `call:declined`, `call:taken` (hentikan dering di nakes lain), `call:started`, `call:ended`, `call:missed`, `monitoring:new`, `monitoring:alert` (zona kuning/merah).

Contoh klien:
```js
const socket = io(API_URL, { auth: { token } });
socket.emit('qna:send', { body: 'Sesak sejak semalam' }, (res) => console.log(res));
socket.on('call:incoming', ({ call }) => showRingingUI(call));   // lalu POST /api/calls/:id/accept
```
Alur panggilan: pemanggil `POST /api/calls` → langsung `Room.connect(url, token)`; penerima menerima `call:incoming` → `POST …/accept` → `Room.connect(url, token)`.

## Pemetaan dari prototype
- `postMessage({type:'gejala'})` → `POST /api/monitoring/:rm/logs`; `postMessage({type:'pesan'})` → `qna:send`; balasan nakes → event `qna:message` di sisi pasien.
- Tab *Grup pasien / Konsultasi / Handover / Chat* → `/api/team/*` (konsultasi & handover = `kind` pesan).
- *Riwayat komunikasi* (LOG) belum punya endpoint tersendiri; bisa dibentuk dari `team_messages` (kind ≠ text) + `calls`.
- TEMU A (kunjungan terjadwal K2/K3 + kode akses) belum dibuat — di luar 5 prioritas. Panggilan dasarnya sudah ada lewat `/api/calls`.

## Hardening sebelum produksi (data medis!)
- **Pembatasan care team**: saat ini semua nakes bisa membuka semua pasien. Tambahkan tabel `care_team(patient_id, user_id)` dan cek di `patientAccess` / `canAccessPatient`.
- HTTPS wajib; `JWT_SECRET` kuat; `CORS_ORIGINS` eksplisit. Pertimbangkan refresh token / logout-revoke.
- Enkripsi data at-rest (disk/DB), backup terenkripsi, retensi data, dan kepatuhan UU PDP / aturan rekam medis. `audit_log` sudah mencatat pembukaan data pasien dan aksi resume.
- Pindah ke PostgreSQL bila multi-instance (SQLite cocok untuk 1 server). Untuk multi-instance Socket.IO juga butuh adapter Redis.
- Unggahan lampiran (foto/PDF lab) belum ada.
