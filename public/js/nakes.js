/* HatiQu — Portal Tenaga Kesehatan (terhubung ke backend)
 * REST  : /api/patients, /cppt, /medications, /labs, /summaries, /team, /qna, /monitoring, /calls
 * Socket: qna:*, team:*, monitoring:*, notification, call:* (lihat README backend)
 */
'use strict';

var $ = function (s) { return document.querySelector(s); };
var esc = HQ.esc;
var q = function (id) { return document.getElementById(id); };
var val = function (id) { return q(id).value.trim(); };
var GET = function (p) { return HQ.api(p); };
var POST = function (p, b) { return HQ.api(p, { method: 'POST', body: b || {} }); };
var PATCH = function (p, b) { return HQ.api(p, { method: 'PATCH', body: b || {} }); };
var toast = function (t) { HQ.toast(t); };

var me = null, pts = [], cp = null, page = 'dash', tab = {}, notes = [], sock = null;
var LOG = [];                                   // log data masuk (realtime)
var live = { kind: null, roomId: null, qnaRm: null, msgs: [], dmUser: null }; // chat yang sedang dibuka
var rv = 0, topNext = true, TABS = {};

var NAV = [['dash', '🏠', 'Dashboard'], ['pasien', '👤', 'Data Pasien'], ['cppt', '📝', 'CPPT'], ['resep', '💊', 'Resep dan Obat'],
  ['lab', '🧪', 'Lab dan Penunjang'], ['rujuk', '📋', 'Resume dan Rujukan'], ['kom', '💬', 'Komunikasi Tim'], ['mon', '❤️', 'Monitoring'],
  ['jadwal', '📅', 'Jadwal Follow-up'], ['tim', '👥', 'Tim Multidisiplin'], ['integ', '🔗', 'Integrasi Data']];

var ROLE_DESC = {
  'Dokter spesialis': 'DPJP: terapi, penyesuaian obat, kontrol poli',
  'Dokter umum': 'Pemantauan rutin dan rujuk balik',
  'Perawat': 'Kunjungan, edukasi, pemantauan pasien',
  'Perawat case manager': 'Kontak utama, telepon tindak lanjut, memantau zona gejala',
  'Apoteker': 'Telaah resep dan kepatuhan obat',
  'Ahli gizi': 'Garam, cairan, dan pola makan',
  'Fisioterapis': 'Rehabilitasi dan latihan fisik',
  'Tenaga kesehatan lainnya': 'Pelayanan pendukung',
};

/* ---------- helper ---------- */
function prof() { return (me && me.profession) || ''; }
function isDok() { return /^Dokter/i.test(prof()); }
function isApt() { return prof() === 'Apoteker'; }
function isPer() { return /^Perawat/i.test(prof()); }
var ZN = { hijau: ['g', 'Hijau'], kuning: ['y', 'Kuning'], merah: ['r', 'Merah'] };
function zb(z) { var x = ZN[z]; return x ? '<span class="bd ' + x[0] + '">' + x[1] + '</span>' : '<span class="bd">' + esc(z || '—') + '</span>'; }
function num(x, d) { if (x == null || isNaN(x)) return '—'; var f = Math.pow(10, d == null ? 1 : d); return String(Math.round(x * f) / f).replace('.', ','); }
function logEv(kind, text) { LOG.unshift([kind, text, new Date().toLocaleTimeString('id-ID')]); if (LOG.length > 50) LOG.length = 50; if (page === 'integ') safeRender(); }
function isTyping() { var a = document.activeElement; return !!(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && $('#pg').contains(a)); }
function safeRender() { if (!isTyping()) render(); }
function patientOf(rm) { return pts.find(function (p) { return p.rm === rm; }); }
function noPatient() { return '<div class="card">Belum ada pasien terdaftar. Tambahkan pasien lewat menu Data Pasien.</div>'; }
function setLive(on) { var e = $('#lv'); e.textContent = on ? 'tersinkron' : 'terputus'; e.className = 'live' + (on ? '' : ' off'); }

function tabs(k, list) {
  TABS[k] = list;
  if (list.indexOf(tab[k]) < 0) tab[k] = list[0];
  return '<div class="tabs">' + list.map(function (t, i) {
    return '<button class="' + (tab[k] === t ? 'on' : '') + '" onclick="setTab(\'' + k + '\',' + i + ')">' + esc(t) + '</button>';
  }).join('') + '</div>';
}
function setTab(k, i) { tab[k] = TABS[k][i]; render(); }

function pbar(labelFn) {
  return '<div class="pb"><b>Pasien:</b><select onchange="cp=this.value;render()" aria-label="Pilih pasien">' +
    pts.map(function (p) {
      var l = labelFn ? labelFn(p) : p.name + ' — ' + p.rm;
      return '<option value="' + esc(p.rm) + '"' + (p.rm === cp ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('') + '</select></div>';
}

/** Jalankan aksi async; tampilkan pesan error sebagai toast. */
function act(fn, ok) {
  return Promise.resolve().then(fn).then(function (r) { if (ok) toast(ok); return r; }).catch(function (e) { toast(e.message || 'Terjadi kesalahan'); });
}

/* ---------- boot ---------- */
(function boot() {
  HQ.requireRole('nakes').then(function (m) {
    me = m.user;
    $('#hi').textContent = 'Selamat Datang, ' + me.name.split(',')[0];
    $('#fas').textContent = [prof(), me.facility].filter(Boolean).join(' · ');
    $('#nav').innerHTML = NAV.map(function (n) {
      return '<button data-p="' + n[0] + '" onclick="go(\'' + n[0] + '\')"><span>' + n[1] + '</span>' + n[2] + '</button>';
    }).join('');
    return Promise.all([GET('/patients'), GET('/auth/notifications')]);
  }).then(function (r) {
    pts = r[0]; notes = r[1];
    cp = pts.length ? pts[0].rm : null;
    $('#boot').style.display = 'none';
    $('#app').style.display = 'grid';
    go('dash');
    return startSocket();
  }).catch(function (e) { $('#boot').textContent = 'Gagal memuat portal: ' + e.message; });
})();

function startSocket() {
  return HQ.connect().then(function (s) {
    sock = s;
    HQ.Calls.init(sock);
    sock.on('connect', function () { setLive(true); if (live.kind === 'qna' && live.qnaRm) sock.emit('qna:join', { rm: live.qnaRm }); });
    sock.on('disconnect', function () { setLive(false); });
    if (sock.connected) setLive(true);

    sock.on('notification', function (n) {
      notes.unshift({ id: 'n' + Date.now(), icon: n.icon, text: n.text, patientId: n.patientId, createdAt: n.createdAt, read: false });
      drawNt(); toast((n.icon || '🔔') + ' ' + n.text); logEv('Notifikasi', n.text);
    });
    sock.on('qna:new', function (d) {
      logEv('Pesan TEMU B', d.patientName + ' (' + d.rm + '): ' + d.preview);
      if (page === 'dash' || (page === 'kom' && tab.kom === K_QNA && live.qnaRm !== d.rm)) safeRender();
    });
    sock.on('qna:message', function (m) {
      if (page === 'kom' && tab.kom === K_QNA && live.qnaRm === m.rm) {
        addMsg(m);
        if (m.from === 'pasien') POST('/qna/' + encodeURIComponent(m.rm) + '/read').catch(function () {});
      }
    });
    sock.on('team:message', function (m) {
      var open = page === 'kom' && (tab.kom === K_CHAT || tab.kom === K_GRP) && live.kind === 'team' && live.roomId === m.roomId;
      if (open) { addMsg(m); if (m.senderId !== me.id) POST('/team/rooms/' + m.roomId + '/read').catch(function () {}); }
      else if (m.senderId !== me.id && m.kind === 'text') {
        toast('💬 ' + m.senderName + ': ' + (m.body.length > 60 ? m.body.slice(0, 57) + '…' : m.body));
        logEv('Chat tim', m.senderName + ': ' + m.body);
      }
    });
    sock.on('monitoring:new', function (d) {
      var p = patientOf(d.rm); if (p) p.zona = d.zona;
      logEv('Catatan gejala', d.patientName + ' (' + d.rm + '): zona ' + d.zona + ', BB ' + num(d.log && d.log.weight) + ' kg');
      if (['dash', 'mon', 'jadwal', 'pasien'].indexOf(page) >= 0) safeRender();
    });
    sock.on('monitoring:alert', function (d) { logEv(d.zona === 'merah' ? '🔴 Alert merah' : '🟡 Alert kuning', d.patientName + ' (' + d.rm + ')'); });
    ['call:incoming', 'call:accepted', 'call:declined', 'call:missed', 'call:ended'].forEach(function (ev) {
      sock.on(ev, function (p) { logEv('Panggilan', ev.replace('call:', '') + ' — ' + ((p.call && (p.call.patientName || '')) || '')); if (page === 'jadwal' || (page === 'kom' && tab.kom === K_LOG)) safeRender(); });
    });
  }).catch(function () { setLive(false); toast('Koneksi realtime gagal. Data tetap bisa dimuat manual.'); });
}

/* ---------- notifikasi ---------- */
function toggleNt() {
  var n = $('#nt'), open = n.style.display === 'block';
  if (open) { n.style.display = 'none'; notes.forEach(function (x) { x.read = true; }); drawNt(); return; }
  n.style.display = 'block'; drawNt();
  if (notes.some(function (x) { return !x.read; })) POST('/auth/notifications/read').catch(function () {});
}
function drawNt() {
  var un = notes.filter(function (n) { return !n.read; }).length;
  $('#nc').textContent = un || '';
  $('#nt').innerHTML = '<h3>Notifikasi</h3>' + (notes.slice(0, 30).map(function (n) {
    return '<div style="padding:.4rem 0;border-bottom:1px solid var(--bd)' + (n.read ? '' : ';font-weight:600') + '">' + esc(n.icon || '🔔') + ' ' + esc(n.text) +
      '<br><small style="color:var(--mu);font-weight:400">' + HQ.fmtDT(n.createdAt) + '</small></div>';
  }).join('') || 'Tidak ada notifikasi.');
}

/* ---------- router ---------- */
function go(p) {
  page = p; topNext = true; $('#sb').classList.remove('open');
  document.querySelectorAll('nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.p === p); });
  if (p !== 'kom') live.kind = null;
  render();
}
function render() {
  var v = ++rv, pg = $('#pg');
  var fn = { dash: dash, pasien: pasien, cppt: cppt, resep: resep, lab: lab, rujuk: rujuk, kom: kom, mon: mon, jadwal: jadwal, tim: tim, integ: integ }[page];
  return Promise.resolve().then(fn).then(function (out) {
    if (v !== rv) return;
    var html = typeof out === 'string' ? out : out.html;
    pg.innerHTML = html; drawNt();
    if (topNext) { pg.scrollTop = 0; topNext = false; }
    if (out && out.after) out.after();
  }).catch(function (e) {
    if (v !== rv) return;
    pg.innerHTML = '<div class="card"><b>Gagal memuat halaman.</b><p class="err">' + esc(e.message) + '</p><button class="btn s" onclick="render()">Coba lagi</button></div>';
  });
}
function loadPts() { return GET('/patients').then(function (r) { pts = r; if (cp && !patientOf(cp)) cp = pts.length ? pts[0].rm : null; }); }
function callRm(rm, type) { var p = patientOf(rm); HQ.Calls.start({ type: type, patientRm: rm, title: (type === 'video' ? 'Video call' : 'Telepon') + ' — ' + (p ? p.name : rm), onEnd: function () { if (page === 'jadwal' || page === 'kom') safeRender(); } }); }
function callPt(type) { callRm(cp, type); }

/* ================= 1. Dashboard ================= */
function dash() {
  return Promise.all([GET('/monitoring/overview'), GET('/qna/conversations')]).then(function (r) {
    var ov = r[0], conv = r[1];
    var unread = conv.reduce(function (a, c) { return a + c.unread; }, 0);
    var cnt = function (z) { return ov.filter(function (x) { return x.zona === z; }).length; };
    var missing = ov.filter(function (x) { return x.missingLog; }).length;
    var sc = function (a, b) { return '<div class="card stat"><b>' + a + '</b><span>' + b + '</span></div>'; };
    var msgs = conv.filter(function (c) { return c.lastMessage; }).slice(0, 5).map(function (c) {
      return '<div style="padding:.35rem 0;border-bottom:1px solid var(--bd)"><b>' + esc(c.patientName) + '</b>' + (c.unread ? '<span class="badge-n">' + c.unread + '</span>' : '') +
        '<br><small>' + esc(c.lastMessage.length > 70 ? c.lastMessage.slice(0, 67) + '…' : c.lastMessage) + '</small> ' +
        '<button class="btn o s" onclick="cp=\'' + esc(c.rm) + '\';tab.kom=K_QNA;go(\'kom\')">Buka</button></div>';
    }).join('') || '<small>Belum ada pesan dari pasien.</small>';
    var todo = ov.filter(function (x) { return x.zona !== 'hijau' || x.missingLog; }).slice(0, 6).map(function (x) {
      var why = x.zona !== 'hijau' ? 'Zona ' + x.zona : (x.daysSinceLastLog == null ? 'Belum pernah mengisi catatan' : 'Belum mengisi catatan hari ini');
      return '<div style="padding:.35rem 0;border-bottom:1px solid var(--bd)">' + zb(x.zona) + ' <b>' + esc(x.name) + '</b> — ' + esc(why) + '</div>';
    }).join('') || '<small>Semua pasien stabil dan sudah mencatat.</small>';
    return '<h2>Dashboard — ' + esc(prof()) + '</h2>' +
      '<div class="card"><label for="sq" style="margin:0 0 .3rem">Cari pasien (nama atau No. RM)</label><div class="row"><input id="sq" placeholder="contoh: 12-34-56" onkeydown="if(event.key===\'Enter\')cari()"><button class="btn" onclick="cari()">Cari</button></div><div id="sr" class="err"></div></div>' +
      '<div class="grid">' + sc(ov.length, 'Pasien dipantau') + sc(cnt('merah'), 'Zona merah') + sc(cnt('kuning'), 'Zona kuning') + sc(unread, 'Pesan pasien belum dibaca') +
      sc(missing, 'Belum mengisi catatan hari ini') + sc(notes.filter(function (n) { return !n.read; }).length, 'Notifikasi belum dibaca') + '</div>' +
      '<div class="two" style="margin-top:.9rem"><div class="card"><h3>Pesan pasien terbaru</h3>' + msgs + '</div><div class="card"><h3>Perlu tindak lanjut</h3>' + todo + '</div></div>' +
      '<div class="card"><h3>Semua pasien</h3><div class="tbl"><table><tr><th>Pasien</th><th>No. RM</th><th>Zona</th><th>Catatan terakhir</th><th>Diagnosis</th><th></th></tr>' +
      ov.map(function (x) {
        return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.rm) + '</td><td>' + zb(x.zona) + '</td><td>' + (x.lastLog ? HQ.fmtD(x.lastLog.date) : '—') + '</td><td>' + esc(x.diagnosis || '—') +
          '</td><td><button class="btn s" onclick="cp=\'' + esc(x.rm) + '\';go(\'pasien\')">Buka</button></td></tr>';
      }).join('') + '</table></div></div>';
  });
}
function cari() {
  var v = val('sq').toLowerCase(); if (!v) return;
  var rm = HQ.rmN(v);
  var p = pts.find(function (p) { return p.rm === rm || p.name.toLowerCase().indexOf(v) >= 0 || p.rm.indexOf(v) >= 0; });
  if (!p) { q('sr').textContent = 'Pasien tidak ditemukan. Cek nama atau nomor RM.'; return; }
  cp = p.rm; go('pasien');
}

/* ================= 2. Data pasien ================= */
function pasien() {
  if (!cp) return noPatient() + addPatientForm();
  var T = ['Identitas', 'Alergi dan Obat', 'Keluarga', 'Resume medis'];
  return Promise.all([GET('/patients/' + encodeURIComponent(cp)), GET('/patients/' + encodeURIComponent(cp) + '/medications'), GET('/patients/' + encodeURIComponent(cp) + '/summaries')]).then(function (r) {
    var p = r[0], meds = r[1], sums = r[2];
    var t = tabs('pas', T), body = '';
    if (tab.pas === 'Identitas') {
      body = '<table><tr><th>Nama</th><td>' + esc(p.name) + '</td></tr><tr><th>Usia / JK</th><td>' + (p.age != null ? p.age + ' tahun' : '—') + ' / ' + esc(p.sex || '—') + '</td></tr>' +
        '<tr><th>No. RM</th><td>' + esc(p.rm) + '</td></tr><tr><th>Tanggal lahir</th><td>' + HQ.fmtD(p.birthDate) + '</td></tr><tr><th>Diagnosis</th><td>' + esc(p.diagnosis || '—') + '</td></tr>' +
        '<tr><th>Berat badan kering</th><td>' + (p.dryWeight ? num(p.dryWeight) + ' kg (acuan pemantauan)' : '—') + '</td></tr><tr><th>Zona saat ini</th><td>' + zb(p.zona) + '</td></tr>' +
        '<tr><th>Akun aplikasi pasien</th><td>' + (p.hasAccount ? 'Aktif (login dengan No. RM)' : 'Belum dibuat') + '</td></tr></table>';
    } else if (tab.pas === 'Alergi dan Obat') {
      body = '<p><b>Alergi:</b> belum tercatat di sistem.</p><p><b>Obat saat ini:</b> ' + (meds.map(function (m) { return esc(m.name + ' ' + m.dose); }).join(', ') || 'belum ada data') + '.</p>';
    } else if (tab.pas === 'Keluarga') {
      body = '<p>Pendamping: ' + (p.companionName ? esc(p.companionName) + (p.companionPhone ? ', ' + esc(p.companionPhone) : '') : 'belum tercatat') + '.</p>';
    } else {
      body = sums.length ? '<table><tr><th>Judul</th><th>Jenis</th><th>Status</th><th>Tanggal</th></tr>' + sums.map(function (s) {
        return '<tr><td>' + esc(s.title) + '</td><td>' + esc(s.type) + '</td><td>' + sumBadge(s) + '</td><td>' + HQ.fmtD(s.createdAt) + '</td></tr>';
      }).join('') + '</table><button class="btn o s" style="margin-top:.6rem" onclick="go(\'rujuk\')">Kelola resume</button>' : '<p>Belum ada resume medis.</p>';
    }
    var actions = '<div class="row" style="flex-wrap:wrap;margin-bottom:.9rem">' + (p.hasAccount
      ? '<button class="btn s" onclick="callPt(\'video\')">📹 Video call</button><button class="btn o s" onclick="callPt(\'audio\')">📞 Telepon</button>'
      : '<span class="chip">Pasien belum punya akun aplikasi: panggilan tidak tersedia</span>') +
      '<button class="btn o s" onclick="tab.kom=K_QNA;go(\'kom\')">💬 Pesan pasien</button></div>';
    return '<h2>Data Pasien dan Rekam Medis</h2>' + pbar() + actions + '<div class="card">' + t + body + '</div>' + addPatientForm();
  });
}
function addPatientForm() {
  if (!(isDok() || isPer())) return '';
  return '<details class="card"><summary>➕ Daftarkan pasien baru</summary><form onsubmit="return savePatient(event)"><div class="grid">' +
    '<div><label for="np_rm">No. RM</label><input id="np_rm" required placeholder="12-34-99" inputmode="numeric"></div>' +
    '<div><label for="np_nm">Nama</label><input id="np_nm" required></div>' +
    '<div><label for="np_tl">Tanggal lahir</label><input id="np_tl" type="date"></div>' +
    '<div><label for="np_jk">Jenis kelamin</label><select id="np_jk"><option value="">—</option><option>Laki-laki</option><option>Perempuan</option></select></div>' +
    '<div><label for="np_dx">Diagnosis</label><input id="np_dx"></div>' +
    '<div><label for="np_bb">Berat badan kering (kg)</label><input id="np_bb" type="number" step="0.1" min="1"></div>' +
    '<div><label for="np_pn">Nama pendamping</label><input id="np_pn"></div>' +
    '<div><label for="np_pt">Telepon pendamping</label><input id="np_pt"></div>' +
    '<div><label for="np_pw">Kata sandi awal akun pasien (opsional, min. 8)</label><input id="np_pw" type="password" autocomplete="new-password" minlength="8"></div></div>' +
    '<p class="tag">Pasien masuk dengan No. RM. Tanpa kata sandi awal, pasien bisa membuat akun sendiri lewat tombol “Buat akun baru” (verifikasi No. RM + tanggal lahir).</p>' +
    '<button class="btn" style="margin-top:.6rem">Simpan pasien</button></form></details>';
}
function savePatient(e) {
  e.preventDefault();
  var b = { rm: val('np_rm'), name: val('np_nm') };
  if (val('np_tl')) { b.birthDate = val('np_tl'); b.age = Math.max(0, Math.floor((Date.now() - new Date(b.birthDate)) / 31557600000)); }
  if (val('np_jk')) b.sex = val('np_jk');
  if (val('np_dx')) b.diagnosis = val('np_dx');
  if (val('np_bb')) b.dryWeight = parseFloat(val('np_bb'));
  if (val('np_pn')) b.companionName = val('np_pn');
  if (val('np_pt')) b.companionPhone = val('np_pt');
  if (val('np_pw')) b.account = { password: q('np_pw').value };
  return act(function () {
    return POST('/patients', b).then(function (p) { return loadPts().then(function () { cp = p.rm; tab.pas = 'Identitas'; render(); }); });
  }, 'Pasien terdaftar').then(function () { return false; });
}

/* ================= 3. CPPT ================= */
function cppt() {
  if (!cp) return noPatient();
  return GET('/patients/' + encodeURIComponent(cp) + '/cppt').then(function (list) {
    return '<h2>CPPT — Catatan Perkembangan Pasien Terintegrasi</h2>' + pbar() + '<div class="two"><form class="card" onsubmit="return saveC(event)"><h3>Catatan baru (SOAP)</h3>' +
      [['S', 'Subjective — keluhan pasien'], ['O', 'Objective — pemeriksaan, tanda vital, penunjang'], ['A', 'Assessment — penilaian masalah'], ['P', 'Planning — terapi, edukasi, tindak lanjut']].map(function (x) {
        return '<label for="c' + x[0] + '">' + x[0] + ' · ' + x[1] + '</label><textarea id="c' + x[0] + '" required></textarea>';
      }).join('') +
      '<p style="color:var(--mu);font-size:.82rem">Dicatat sebagai ' + esc(me.name) + ' (' + esc(prof()) + '), ' + esc(me.facility || '') + '</p><button class="btn">Simpan catatan</button></form>' +
      '<div><h3>Timeline CPPT</h3>' + (list.map(function (c) {
        return '<div class="card tl"><b>' + esc(c.author) + '</b> <span class="bd">' + esc(c.profession || '') + '</span><br><small>' + esc(c.facility || '') + ' · ' + HQ.fmtDT(c.createdAt) +
          '</small><p><b>S:</b> ' + esc(c.S) + '<br><b>O:</b> ' + esc(c.O) + '<br><b>A:</b> ' + esc(c.A) + '<br><b>P:</b> ' + esc(c.P) + '</p></div>';
      }).join('') || '<p>Belum ada catatan. Isi formulir untuk mulai.</p>') + '</div></div>';
  });
}
function saveC(e) {
  e.preventDefault();
  return act(function () {
    return POST('/patients/' + encodeURIComponent(cp) + '/cppt', { S: val('cS'), O: val('cO'), A: val('cA'), P: val('cP') }).then(render);
  }, 'Catatan CPPT tersimpan').then(function () { return false; });
}

/* ================= 4. Resep dan obat ================= */
function resep() {
  if (!cp) return noPatient();
  return GET('/patients/' + encodeURIComponent(cp) + '/medications').then(function (meds) {
    var rows = meds.map(function (m) {
      var done = m.status === 'selesai_ditelaah';
      return '<tr><td>' + esc(m.name) + '</td><td>' + esc(m.dose) + '</td><td>' + esc(m.route) + '</td><td>' + HQ.fmtD(m.createdAt) + '</td><td><span class="bd ' + (done ? 'g' : 'y') + '">' + (done ? 'Selesai ditelaah' : 'Menunggu telaah') +
        '</span></td><td>' + esc(m.pharmacyNote || '—') + '</td><td>' + (isApt() && !done ? '<button class="btn s" onclick="telaah(' + m.id + ')">Telaah</button>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="7">Belum ada obat.</td></tr>';
    return '<h2>Resep dan Pengelolaan Obat</h2>' + pbar() + '<div class="card tbl"><table><tr><th>Obat</th><th>Dosis</th><th>Rute</th><th>Tanggal</th><th>Status</th><th>Catatan farmasi</th><th></th></tr>' + rows + '</table></div>' +
      (isDok() ? '<form class="card" onsubmit="return addMed(event)"><h3>Buat resep baru</h3><div class="grid"><div><label for="mo">Nama obat</label><input id="mo" required></div><div><label for="md">Dosis dan frekuensi</label><input id="md" required placeholder="mis. 5 mg 1x1"></div><div><label for="mr">Rute</label><select id="mr"><option>Oral</option><option>IV</option><option>SC</option></select></div></div><button class="btn" style="margin-top:.7rem">Simpan resep</button></form>'
        : '<div class="card ro">' + (isApt() ? 'Apoteker dapat menelaah resep dan memberi catatan farmasi.' : 'Pembuatan resep hanya untuk dokter. Anda dapat melihat daftar obat.') + '</div>');
  });
}
function addMed(e) {
  e.preventDefault();
  return act(function () {
    return POST('/patients/' + encodeURIComponent(cp) + '/medications', { name: val('mo'), dose: val('md'), route: q('mr').value }).then(render);
  }, 'Resep disimpan, menunggu telaah apoteker').then(function () { return false; });
}
function telaah(id) {
  var c = prompt('Catatan farmasi (mis. interaksi, pemantauan):', 'Dosis sesuai. Pantau kalium dan kreatinin.');
  if (c === null || !c.trim()) return;
  act(function () { return POST('/patients/' + encodeURIComponent(cp) + '/medications/' + id + '/review', { note: c.trim() }).then(render); }, 'Telaah resep selesai');
}

/* ================= 5. Lab ================= */
function parseNum(v) { var n = parseFloat(String(v).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n; }
function lab() {
  if (!cp) return noPatient();
  return GET('/patients/' + encodeURIComponent(cp) + '/labs').then(function (labs) {
    var T = ['Semua', 'Laboratorium', 'Radiologi', 'EKG', 'Jantung lain'], t = tabs('lab', T);
    var cat = function (n) { return /ekg/i.test(n) ? 'EKG' : /toraks|rontgen|radiolog|ct scan|mri|usg/i.test(n) ? 'Radiologi' : /eko|echo|holter|treadmill/i.test(n) ? 'Jantung lain' : 'Laboratorium'; };
    var shown = labs.filter(function (r) { return tab.lab === 'Semua' || cat(r.name) === tab.lab; });
    var bnp = labs.filter(function (r) { return /nt-?probnp/i.test(r.name); }).slice().reverse().map(function (r) { return { v: parseNum(r.value), l: HQ.fmtD(r.testedAt) }; }).filter(function (x) { return x.v != null; }).slice(-6);
    var chart = '';
    if (bnp.length >= 2) {
      var mx = Math.max.apply(null, bnp.map(function (x) { return x.v; })), w = 60;
      chart = '<div class="card"><h3>Tren NT-proBNP (pg/mL)</h3><svg viewBox="0 0 ' + (bnp.length * w + 20) + ' 130" style="width:100%;max-width:460px" role="img" aria-label="Grafik NT-proBNP">' + bnp.map(function (x, i) {
        var h = x.v / mx * 85;
        return '<rect x="' + (15 + i * w) + '" y="' + (105 - h) + '" width="40" height="' + h + '" rx="4" fill="var(--ac)"/><text x="' + (35 + i * w) + '" y="' + (98 - h) + '" text-anchor="middle" font-size="10" fill="var(--tx)">' + x.v + '</text><text x="' + (35 + i * w) + '" y="122" text-anchor="middle" font-size="9" fill="var(--mu)">' + esc(x.l) + '</text>';
      }).join('') + '</svg></div>';
    }
    return '<h2>Lab dan Pemeriksaan Penunjang</h2>' + pbar() + t + '<div class="card tbl"><table><tr><th>Tanggal</th><th>Pemeriksaan</th><th>Hasil</th><th>Nilai rujukan</th><th>Status</th></tr>' +
      (shown.map(function (r) { return '<tr><td>' + HQ.fmtD(r.testedAt) + '</td><td>' + esc(r.name) + '</td><td>' + esc(r.value) + '</td><td>' + esc(r.range || '—') + '</td><td>' + (r.flag ? '<span class="bd ' + (/^normal$/i.test(r.flag) ? 'g' : 'y') + '">' + esc(r.flag) + '</span>' : '—') + '</td></tr>'; }).join('') || '<tr><td colspan="5">Belum ada hasil pemeriksaan.</td></tr>') +
      '</table></div>' + chart +
      '<form class="card" onsubmit="return addLab(event)"><h3>Tambah hasil pemeriksaan</h3><div class="grid"><div><label for="lt">Tanggal</label><input id="lt" type="date" required value="' + HQ.todayISO() + '"></div>' +
      '<div><label for="ln">Pemeriksaan</label><input id="ln" required placeholder="mis. Kalium"></div><div><label for="lv2">Hasil</label><input id="lv2" required placeholder="mis. 4,2 mmol/L"></div>' +
      '<div><label for="lr">Nilai rujukan</label><input id="lr" placeholder="mis. 3,5–5,0"></div><div><label for="lf">Status</label><select id="lf"><option>Normal</option><option>Tinggi</option><option>Rendah</option><option>Abnormal</option></select></div></div>' +
      '<button class="btn" style="margin-top:.7rem">Simpan hasil</button></form>';
  });
}
function addLab(e) {
  e.preventDefault();
  var b = { testedAt: val('lt'), name: val('ln'), value: val('lv2'), flag: q('lf').value }; if (val('lr')) b.range = val('lr');
  return act(function () { return POST('/patients/' + encodeURIComponent(cp) + '/labs', b).then(render); }, 'Hasil tersimpan').then(function () { return false; });
}

/* ================= 6. Resume medis dan rujukan ================= */
var SUMF = [['ringkasanRiwayat', 'Ringkasan riwayat perawatan'], ['kondisiSaatPulang', 'Kondisi saat pulang'], ['diagnosisAkhir', 'Diagnosis akhir'],
  ['terapiLanjutan', 'Terapi lanjutan'], ['rekomendasi', 'Rekomendasi'], ['instruksiPemantauan', 'Instruksi pemantauan'], ['jadwalKontrol', 'Jadwal kontrol']];
var STX = { draft: ['y', 'Draft'], final: ['g', 'Final'], sent: ['', 'Terkirim'] };
function sumBadge(s) { var x = STX[s.status] || ['', s.status]; return '<span class="bd ' + x[0] + '">' + x[1] + '</span>' + (s.sentTo ? ' <small>→ ' + esc(s.sentTo) + '</small>' : ''); }
function sumFields(c, pre) {
  return SUMF.map(function (f) { return '<label for="' + pre + f[0] + '">' + f[1] + '</label><textarea id="' + pre + f[0] + '">' + esc((c && c[f[0]]) || '') + '</textarea>'; }).join('');
}
function readSumFields(pre) { var c = {}; SUMF.forEach(function (f) { var v = val(pre + f[0]); if (v) c[f[0]] = v; }); return c; }

function rujuk() {
  if (!cp) return noPatient();
  var base = '/patients/' + encodeURIComponent(cp);
  return GET(base + '/summaries').then(function (list) {
    var want = tab.sumId && list.some(function (s) { return s.id === tab.sumId; }) ? GET('/summaries/' + tab.sumId) : Promise.resolve(null);
    return want.then(function (d) {
      var rows = list.map(function (s) {
        return '<tr' + (d && d.id === s.id ? ' class="sel"' : '') + '><td>' + esc(s.title) + '</td><td>' + esc(s.type) + '</td><td>' + sumBadge(s) + '</td><td>' + esc(s.authorName) + '</td><td>' + HQ.fmtD(s.createdAt) + '</td><td><button class="btn s" onclick="openSum(' + s.id + ')">Lihat</button></td></tr>';
      }).join('') || '<tr><td colspan="6">Belum ada resume untuk pasien ini.</td></tr>';
      var create = isDok() ? '<details class="card"><summary>➕ Buat resume baru</summary><form onsubmit="return newSum(event)"><div class="grid"><div><label for="rs_ty">Jenis</label><select id="rs_ty"><option value="pulang">Resume pulang</option><option value="rujukan">Rujukan</option><option value="kontrol">Kontrol</option></select></div><div><label for="rs_ti">Judul (opsional)</label><input id="rs_ti" maxlength="200"></div></div>' +
        sumFields(null, 'rs_') + '<p class="tag">Ringkasan otomatis (CPPT terbaru, obat, lab terbaru, monitoring 7 hari) ditambahkan oleh server.</p><button class="btn" style="margin-top:.6rem">Simpan sebagai draft</button></form></details>'
        : '<div class="card ro">Resume dibuat oleh dokter. Anda dapat melihat dan mengirim resume yang sudah final.</div>';
      return '<h2>Resume Medis dan Rujukan</h2>' + pbar() + '<div class="card tbl"><table><tr><th>Judul</th><th>Jenis</th><th>Status</th><th>Penulis</th><th>Dibuat</th><th></th></tr>' + rows + '</table></div>' + create + (d ? sumDetail(d) : '');
    });
  });
}
function sumDetail(d) {
  var c = d.content || {}, s = d.snapshot || {};
  var fields = SUMF.filter(function (f) { return c[f[0]]; }).map(function (f) { return '<p><b>' + f[1] + ':</b><br>' + esc(c[f[0]]).replace(/\n/g, '<br>') + '</p>'; }).join('') || '<p><small>Isi resume belum diisi.</small></p>';
  var snap = '';
  if (s.patient) {
    snap = '<details><summary>Ringkasan otomatis dari data pasien (' + HQ.fmtDT(s.generatedAt) + ')</summary>' +
      '<p><b>Pasien:</b> ' + esc(s.patient.name) + ', ' + esc(s.patient.age != null ? s.patient.age + ' th' : '') + ' ' + esc(s.patient.sex || '') + ' — ' + esc(s.patient.diagnosis || '') + '</p>' +
      '<p><b>Obat:</b> ' + (s.medications || []).map(function (m) { return esc(m.name + ' ' + m.dose); }).join('; ') + '</p>' +
      '<p><b>Lab terbaru:</b> ' + (s.latestLabs || []).map(function (l) { return esc(l.name + ' ' + l.value + (l.flag ? ' (' + l.flag + ')' : '')); }).join('; ') + '</p>' +
      '<p><b>Monitoring 7 hari:</b> ' + ((s.monitoring7d || []).map(function (m) { return HQ.fmtD(m.date) + ' BB ' + num(m.weight) + ' kg ' + (m.zona || ''); }).join('; ') || '—') + '</p>' +
      '<p><b>CPPT terbaru:</b> ' + (s.recentCppt || []).length + ' catatan</p></details>';
  }
  var act1 = '';
  if (d.status === 'draft' && isDok()) {
    act1 = '<details><summary>✏️ Ubah isi draft</summary><form onsubmit="return editSum(event,' + d.id + ')"><label for="ed_ti">Judul</label><input id="ed_ti" value="' + esc(d.title) + '">' + sumFields(c, 'ed_') +
      '<label class="row" style="align-items:center;margin-top:.6rem"><input type="checkbox" id="ed_rf" style="width:auto"> Perbarui ringkasan otomatis dari data terbaru</label><button class="btn" style="margin-top:.6rem">Simpan perubahan</button></form></details>' +
      '<button class="btn" style="margin-top:.6rem" onclick="finSum(' + d.id + ')">Finalisasi resume</button> <small>Setelah final, isi dibekukan dan tidak bisa diubah.</small>';
  } else if (d.status === 'draft') {
    act1 = '<p class="tag">Draft: menunggu dokter memfinalisasi.</p>';
  } else {
    act1 = (d.status === 'sent' ? '<p><span class="bd g">Terkirim</span> ke <b>' + esc(d.sentTo) + '</b> pada ' + HQ.fmtDT(d.sentAt) + '. Kirim lagi ke fasilitas lain:</p>' : '<p>Kirim resume ke fasilitas penerima (tercatat sebagai handover di grup tim pasien):</p>') +
      '<form onsubmit="return sendSum(event,' + d.id + ')" class="row" style="flex-wrap:wrap"><input id="sd_fa" required placeholder="Fasilitas tujuan, mis. Puskesmas Wilayah" style="flex:2;min-width:200px"><input id="sd_nt" placeholder="Catatan (opsional)" style="flex:2;min-width:160px"><button class="btn">Kirim</button></form>';
  }
  return '<div class="card"><h3>' + esc(d.title) + ' ' + sumBadge(d) + '</h3><small style="color:var(--mu)">' + esc(d.authorName) + ' · ' + HQ.fmtDT(d.createdAt) + (d.finalizedAt ? ' · final ' + HQ.fmtDT(d.finalizedAt) : '') + '</small>' + fields + snap + '<div style="margin-top:.8rem">' + act1 + '</div></div>';
}
function openSum(id) { tab.sumId = id; render(); }
function newSum(e) {
  e.preventDefault();
  var b = { type: q('rs_ty').value, content: readSumFields('rs_') }; if (val('rs_ti')) b.title = val('rs_ti');
  return act(function () { return POST('/patients/' + encodeURIComponent(cp) + '/summaries', b).then(function (s) { tab.sumId = s.id; return render(); }); }, 'Draft resume tersimpan').then(function () { return false; });
}
function editSum(e, id) {
  e.preventDefault();
  return act(function () { return PATCH('/summaries/' + id, { title: val('ed_ti') || undefined, content: readSumFields('ed_'), refreshSnapshot: q('ed_rf').checked }).then(render); }, 'Draft diperbarui').then(function () { return false; });
}
function finSum(id) {
  if (!confirm('Finalisasi resume ini? Setelah final, isi dibekukan dan tidak bisa diubah (revisi = buat resume baru).')) return;
  act(function () { return POST('/summaries/' + id + '/finalize').then(render); }, 'Resume difinalisasi');
}
function sendSum(e, id) {
  e.preventDefault();
  var b = { facility: val('sd_fa') }; if (val('sd_nt')) b.note = val('sd_nt');
  return act(function () { return POST('/summaries/' + id + '/send', b).then(render); }, 'Resume terkirim dan tercatat sebagai handover').then(function () { return false; });
}

/* ================= 7. Komunikasi tim ================= */
var K_CHAT = 'Chat', K_QNA = 'Pesan Pasien (TEMU B)', K_GRP = 'Grup pasien', K_KON = 'Konsultasi', K_HO = 'Handover', K_LOG = 'Riwayat';

function msgHtml(m) {
  var qna = !!m.from;
  var mine = qna ? (m.from === 'nakes' && m.senderId === me.id) : m.senderId === me.id;
  var who = qna ? (m.from === 'pasien' ? 'Pasien' : m.senderName) : m.senderName;
  var kind = '';
  if (!qna && m.kind === 'konsultasi') kind = '<span class="k">KONSULTASI' + (m.meta && m.meta.urgency === 'segera' ? ' · SEGERA' : '') + (m.meta && m.meta.to ? ' → ' + esc(m.meta.to) : '') + '</span>';
  if (!qna && m.kind === 'handover') kind = '<span class="k">HANDOVER</span>';
  return '<div class="m ' + (mine ? 'me' : '') + (m.urgent || (m.meta && m.meta.urgency === 'segera') ? ' urg' : '') + '" style="white-space:pre-wrap"><small>' + esc(who) + ' · ' + HQ.fmtDT(m.createdAt) + (m.urgent ? ' · MENDESAK' : '') + '</small>' + kind + esc(m.body) + '</div>';
}
function drawMsgs(force) {
  var m = q('ms'); if (!m) return;
  var near = m.scrollHeight - m.scrollTop - m.clientHeight < 90;
  m.innerHTML = live.msgs.map(msgHtml).join('') || '<small>Belum ada pesan.</small>';
  if (near || force) m.scrollTop = m.scrollHeight;
}
function addMsg(m) { if (live.msgs.some(function (x) { return x.id === m.id; })) return; live.msgs.push(m); drawMsgs(); }
function chatBox(title, sub) {
  return '<div class="card"><h3>' + title + '</h3>' + (sub || '') + '<div class="msgs" id="ms"></div><div class="row"><input id="ci" placeholder="Tulis pesan" maxlength="2000" onkeydown="if(event.key===\'Enter\')sendChat()"><button class="btn" onclick="sendChat()">Kirim</button></div></div>';
}
function sendChat() {
  var i = q('ci'), t = i.value.trim(); if (!t) return;
  i.value = '';
  var req = live.kind === 'qna' ? POST('/qna/' + encodeURIComponent(live.qnaRm) + '/messages', { body: t }) : POST('/team/rooms/' + live.roomId + '/messages', { kind: 'text', body: t });
  req.then(addMsg).catch(function (e) { toast(e.message); i.value = t; });
}
function chatAfter() { drawMsgs(true); var i = q('ci'); if (i && window.innerWidth > 820) i.focus(); }

function kom() {
  if (!cp && tab.kom !== K_CHAT) return noPatient();
  var T = tabs('kom', [K_CHAT, K_QNA, K_GRP, K_KON, K_HO, K_LOG]);
  var h = '<h2>Komunikasi Tim Kesehatan</h2>' + T;
  var t = tab.kom;
  if (t !== K_CHAT && t !== K_GRP && t !== K_QNA) live.kind = null;

  if (t === K_CHAT) return chatTab(h);
  if (t === K_QNA) return qnaTab(h);
  if (t === K_GRP) {
    return GET('/team/rooms/patient/' + encodeURIComponent(cp)).then(function (room) {
      return GET('/team/rooms/' + room.id + '/messages').then(function (msgs) {
        live.kind = 'team'; live.roomId = room.id; live.msgs = msgs; POST('/team/rooms/' + room.id + '/read').catch(function () {});
        var p = patientOf(cp);
        return { html: h + pbar() + chatBox('Diskusi tim perawatan — ' + esc(p ? p.name : cp) + ' (' + esc(cp) + ')',
          '<p style="color:var(--mu);font-size:.85rem">Anggota: ' + room.members.map(function (x) { return esc(x.name.split(',')[0]); }).join(', ') + '</p>') +
          '<p style="color:var(--mu);font-size:.8rem">Informasi klinis penting harus dicatat juga di CPPT.</p>', after: chatAfter };
      });
    });
  }
  if (t === K_KON) {
    return Promise.resolve(h + pbar() + '<form class="card" onsubmit="return sendK(event)"><h3>Minta konsultasi</h3><div class="grid"><div><label for="kp">Ditujukan kepada</label><select id="kp">' +
      ['Dokter spesialis jantung', 'Apoteker (telaah resep)', 'Ahli gizi', 'Fisioterapis', 'Perawat case manager'].map(function (x) { return '<option>' + x + '</option>'; }).join('') +
      '</select></div><div><label for="ku">Urgensi</label><select id="ku"><option value="rutin">Rutin</option><option value="segera">Segera</option></select></div></div>' +
      '<label for="kq">Pertanyaan atau kondisi pasien</label><textarea id="kq" required maxlength="4000"></textarea><button class="btn" style="margin-top:.7rem">Kirim konsultasi</button></form>');
  }
  if (t === K_HO) {
    return Promise.resolve(h + pbar() + '<form class="card" onsubmit="return sendH(event)"><h3>Handover / serah terima</h3><div class="grid"><div><label for="hf">Dari</label><input id="hf" required value="' + esc(me.facility || '') + '"></div><div><label for="ht">Ke unit / fasilitas</label><input id="ht" required value="Puskesmas Wilayah"></div></div>' +
      ['Kondisi terkini', 'Hasil pemeriksaan dan tindakan', 'Terapi yang sedang diberikan', 'Masalah yang perlu ditindaklanjuti', 'Rencana pelayanan selanjutnya'].map(function (x, i) { return '<label for="h' + i + '">' + x + '</label><textarea id="h' + i + '" required></textarea>'; }).join('') +
      '<button class="btn" style="margin-top:.7rem">Kirim handover</button></form>');
  }
  return logTab(h);
}

function chatTab(h) {
  return GET('/staff').then(function (staff) {
    staff = staff.filter(function (s) { return s.id !== me.id; });
    var list = '<div class="ct"><input placeholder="Cari nama, profesi, unit" aria-label="Cari nakes" oninput="var v=this.value.toLowerCase();document.querySelectorAll(\'.ct button\').forEach(function(b){b.style.display=b.dataset.s.indexOf(v)>=0?\'\':\'none\'})">' +
      staff.map(function (s) {
        return '<button data-s="' + esc((s.name + ' ' + (s.profession || '') + ' ' + (s.facility || '')).toLowerCase()) + '" class="' + (s.id === live.dmUser ? 'on' : '') + '" onclick="live.dmUser=' + s.id + ';render()"><b>' + esc(s.name) + '</b><br><small>' + esc(s.profession || '') + '</small></button>';
      }).join('') + '</div>';
    var chosen = staff.find(function (s) { return s.id === live.dmUser; });
    if (!chosen) return h + '<div class="card chat">' + list + '<div><p>Pilih tenaga kesehatan di daftar untuk memulai chat.</p></div></div>';
    return POST('/team/rooms/direct', { userId: chosen.id }).then(function (room) {
      return GET('/team/rooms/' + room.id + '/messages').then(function (msgs) {
        live.kind = 'team'; live.roomId = room.id; live.msgs = msgs; POST('/team/rooms/' + room.id + '/read').catch(function () {});
        return { html: h + '<div class="card chat">' + list + '<div><b>' + esc(chosen.name) + '</b> <small style="color:var(--mu)">' + esc(chosen.profession || '') + '</small><div class="msgs" id="ms"></div><div class="row"><input id="ci" placeholder="Tulis pesan" maxlength="2000" onkeydown="if(event.key===\'Enter\')sendChat()"><button class="btn" onclick="sendChat()">Kirim</button></div></div></div>', after: chatAfter };
      });
    });
  });
}

function qnaTab(h) {
  return GET('/qna/conversations').then(function (conv) {
    var unread = {}; conv.forEach(function (c) { unread[c.rm] = c.unread; });
    if (live.kind === 'qna' && live.qnaRm && live.qnaRm !== cp && sock) sock.emit('qna:leave', { rm: live.qnaRm });
    return HQ.emit('qna:join', { rm: cp }).then(function (r) { return r.messages; }).catch(function () { return GET('/qna/' + encodeURIComponent(cp) + '/messages'); }).then(function (msgs) {
      live.kind = 'qna'; live.qnaRm = cp; live.msgs = msgs;
      POST('/qna/' + encodeURIComponent(cp) + '/read').catch(function () {});
      var p = patientOf(cp) || { name: cp, hasAccount: false };
      var calls = p.hasAccount ? '<div class="row" style="margin:.2rem 0 .6rem"><button class="btn s" onclick="callPt(\'video\')">📹 Video call</button><button class="btn o s" onclick="callPt(\'audio\')">📞 Telepon</button></div>' : '';
      return { html: h + pbar(function (x) { return x.name + ' — ' + x.rm + (unread[x.rm] ? ' (' + unread[x.rm] + ' baru)' : ''); }) +
        chatBox('TEMU B — ' + esc(p.name) + ' (' + esc(cp) + ') <span class="live ' + (sock && sock.connected ? '' : 'off') + '">' + (sock && sock.connected ? 'tersinkron' : 'terputus') + '</span>', calls) +
        '<p style="color:var(--mu);font-size:.8rem">Pesan pasien berisi kata kunci darurat (nyeri dada, pingsan, sesak saat istirahat) ditandai MENDESAK.</p>', after: chatAfter };
    });
  });
}

function sendK(e) {
  e.preventDefault();
  return act(function () {
    return GET('/team/rooms/patient/' + encodeURIComponent(cp)).then(function (room) {
      return POST('/team/rooms/' + room.id + '/messages', { kind: 'konsultasi', body: val('kq'), meta: { to: q('kp').value, urgency: q('ku').value } });
    }).then(function () { tab.kom = K_LOG; render(); });
  }, 'Konsultasi terkirim').then(function () { return false; });
}
function sendH(e) {
  e.preventDefault();
  var meta = { from: val('hf'), to: val('ht'), kondisi: val('h0'), tindakan: val('h1'), terapi: val('h2'), masalah: val('h3'), rencana: val('h4') };
  return act(function () {
    return GET('/team/rooms/patient/' + encodeURIComponent(cp)).then(function (room) {
      return POST('/team/rooms/' + room.id + '/messages', { kind: 'handover', meta: meta });
    }).then(function () { tab.kom = K_LOG; render(); });
  }, 'Handover terkirim dan tercatat. Salin ringkasan ke CPPT.').then(function () { return false; });
}

var CALLST = { ended: ['g', 'Selesai'], missed: ['y', 'Tak terjawab'], declined: ['r', 'Ditolak'], cancelled: ['', 'Dibatalkan'], ringing: ['y', 'Berdering'], active: ['g', 'Berlangsung'] };
function logTab(h) {
  return Promise.all([GET('/team/rooms/patient/' + encodeURIComponent(cp)), GET('/calls/patient/' + encodeURIComponent(cp))]).then(function (r) {
    return GET('/team/rooms/' + r[0].id + '/messages?limit=100').then(function (msgs) {
      var rows = [];
      msgs.filter(function (m) { return m.kind !== 'text'; }).forEach(function (m) {
        var isK = m.kind === 'konsultasi';
        rows.push({ t: m.createdAt, kind: isK ? 'Konsultasi' : 'Handover', text: isK ? m.senderName + ' → ' + ((m.meta && m.meta.to) || '') + ' (' + ((m.meta && m.meta.urgency) || 'rutin') + '): ' + m.body : m.body.split('\n')[0], st: isK ? '<span class="bd y">Menunggu jawaban</span>' : '<span class="bd">Terkirim</span>' });
      });
      r[1].forEach(function (c) {
        var s = CALLST[c.status] || ['', c.status];
        rows.push({ t: c.createdAt, kind: c.type === 'video' ? 'Video call' : 'Telepon', text: 'Dimulai oleh ' + c.initiatorName + (c.durationSec != null ? ', durasi ' + Math.floor(c.durationSec / 60) + ' mnt ' + (c.durationSec % 60) + ' dtk' : ''), st: '<span class="bd ' + s[0] + '">' + s[1] + '</span>' });
      });
      rows.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
      return h + pbar() + '<div class="card tbl"><h3>Riwayat komunikasi dan koordinasi</h3><table><tr><th>Jenis</th><th>Isi</th><th>Waktu</th><th>Status</th></tr>' +
        (rows.map(function (x) { return '<tr><td>' + x.kind + '</td><td style="white-space:pre-wrap">' + esc(x.text) + '</td><td>' + HQ.fmtDT(x.t) + '</td><td>' + x.st + '</td></tr>'; }).join('') || '<tr><td colspan="4">Belum ada konsultasi, handover, atau panggilan untuk pasien ini.</td></tr>') + '</table></div>';
    });
  });
}

/* ================= 8. Monitoring ================= */
function wtChart(logs, dry) {
  var pts2 = logs.filter(function (l) { return l.weight != null; }).slice().reverse();
  if (pts2.length < 2) return '';
  var ws = pts2.map(function (l) { return l.weight; }); if (dry) ws.push(dry);
  var lo = Math.min.apply(null, ws) - 0.5, hi = Math.max.apply(null, ws) + 0.5, W = 320, H = 90;
  var X = function (i) { return 10 + i * (W - 20) / (pts2.length - 1); }, Y = function (v) { return H - 10 - (v - lo) / (hi - lo) * (H - 20); };
  return '<div class="card"><h3>Tren berat badan (kg)</h3><svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;max-width:480px" role="img" aria-label="Grafik berat badan">' +
    (dry ? '<line x1="10" x2="' + (W - 10) + '" y1="' + Y(dry) + '" y2="' + Y(dry) + '" stroke="var(--g)" stroke-dasharray="4 3"/><text x="' + (W - 10) + '" y="' + (Y(dry) - 3) + '" text-anchor="end" font-size="9" fill="var(--g)">BB kering ' + num(dry) + '</text>' : '') +
    '<polyline fill="none" stroke="var(--ac)" stroke-width="2" points="' + pts2.map(function (l, i) { return X(i) + ',' + Y(l.weight); }).join(' ') + '"/>' +
    pts2.map(function (l, i) { return '<circle cx="' + X(i) + '" cy="' + Y(l.weight) + '" r="3" fill="' + (l.zona === 'merah' ? 'var(--r)' : l.zona === 'kuning' ? 'var(--y)' : 'var(--ac)') + '"/>'; }).join('') + '</svg></div>';
}
function mon() {
  if (!cp) return noPatient();
  return GET('/monitoring/' + encodeURIComponent(cp) + '/logs?days=30').then(function (logs) {
    var p = patientOf(cp) || {};
    var rows = logs.map(function (l) {
      var sy = (l.symptoms || []).slice();
      if (l.restDyspnea) sy.push('Sesak saat istirahat'); if (l.syncope) sy.push('Pingsan'); if (l.chestPain) sy.push('Nyeri dada skala ' + l.chestPain.scale);
      var vit = [];
      if (l.systolic != null) vit.push('TD ' + l.systolic + '/' + (l.diastolic != null ? l.diastolic : '-')); if (l.pulse != null) vit.push('nadi ' + l.pulse);
      if (l.glucose != null) vit.push('GDS ' + l.glucose); if (l.cholesterol != null) vit.push('kol ' + l.cholesterol); if (l.uricAcid != null) vit.push('AU ' + num(l.uricAcid));
      return '<tr><td>' + HQ.fmtD(l.date) + '</td><td>' + num(l.weight) + '</td><td>' + (l.weightDelta == null ? '—' : (l.weightDelta > 0 ? '+' : '') + num(l.weightDelta)) + '</td><td>' + esc(vit.join(', ') || '—') + '</td><td>' + esc(sy.join(', ') || 'Tidak ada') +
        (l.note ? '<br><small>' + esc(l.note) + '</small>' : '') + '</td><td>' + zb(l.zona) + (l.reasons && l.reasons.length ? '<br><small>' + esc(l.reasons.join('; ')) + '</small>' : '') + '</td></tr>';
    }).join('') || '<tr><td colspan="6">Belum ada catatan gejala dalam 30 hari terakhir.</td></tr>';
    return '<h2>Monitoring Kondisi Pasien</h2>' + pbar() + '<div class="card"><p>Data dari Catatan Gejala Harian pasien (30 hari terakhir). Zona saat ini: ' + zb(p.zona) + '</p><div class="tbl"><table><tr><th>Tanggal</th><th>BB (kg)</th><th>Δ BB 3 hr</th><th>Tanda vital / cek mandiri</th><th>Gejala</th><th>Zona</th></tr>' + rows + '</table></div></div>' + wtChart(logs, p.dryWeight) +
      '<div class="grid"><div class="card" style="background:var(--gb)"><b>Hijau</b><br>Relatif stabil, lanjutkan pemantauan.</div><div class="card" style="background:var(--yb)"><b>Kuning</b><br>BB naik ≥ 2 kg dalam 3 hari, sesak atau edema bertambah, nilai di luar batas. Perlu tindak lanjut nakes.</div><div class="card" style="background:var(--rb)"><b>Merah</b><br>Sesak saat istirahat, nyeri dada berat, pingsan. Penanganan darurat.</div></div>' +
      '<form class="card" onsubmit="return tl(event)"><h3>Catat tindak lanjut</h3><label for="tn">Tindak lanjut yang dilakukan</label><textarea id="tn" required></textarea><button class="btn" style="margin-top:.7rem">Simpan tindak lanjut</button><small style="display:block;margin-top:.4rem;color:var(--mu)">Tersimpan sebagai catatan CPPT.</small></form>';
  });
}
function tl(e) {
  e.preventDefault();
  return act(function () { return POST('/monitoring/' + encodeURIComponent(cp) + '/followups', { action: val('tn') }).then(function () { q('tn').value = ''; }); }, 'Tindak lanjut tersimpan ke CPPT').then(function () { return false; });
}

/* ================= 9. Jadwal follow-up ================= */
function jadwal() {
  var calls = cp ? GET('/calls/patient/' + encodeURIComponent(cp)) : Promise.resolve([]);
  return Promise.all([GET('/monitoring/overview'), calls]).then(function (r) {
    var ov = r[0], cl = r[1];
    var todo = ov.filter(function (x) { return x.zona !== 'hijau' || x.missingLog; }).map(function (x) {
      var p = patientOf(x.rm) || {};
      var why = x.zona === 'merah' ? 'Zona merah: hubungi segera' : x.zona === 'kuning' ? 'Zona kuning: hubungi hari ini' : (x.daysSinceLastLog == null ? 'Belum pernah mengisi catatan gejala' : 'Belum mengisi catatan ' + x.daysSinceLastLog + ' hari');
      var rs = x.lastLog && x.lastLog.reasons && x.lastLog.reasons.length && x.zona !== 'hijau' ? '<br><small>' + esc(x.lastLog.reasons.join('; ')) + '</small>' : '';
      return '<div style="padding:.5rem 0;border-bottom:1px solid var(--bd)">📞 <b>' + esc(x.name) + ' (' + esc(x.rm) + ')</b> — ' + esc(why) + rs + '<div class="row" style="margin-top:.3rem">' +
        (p.hasAccount ? '<button class="btn s" onclick="callRm(\'' + esc(x.rm) + '\',\'audio\')">📞 Telepon</button><button class="btn o s" onclick="callRm(\'' + esc(x.rm) + '\',\'video\')">📹 Video</button>' : '<small>(belum punya akun aplikasi)</small>') +
        '<button class="btn o s" onclick="cp=\'' + esc(x.rm) + '\';tab.kom=K_QNA;go(\'kom\')">💬 Pesan</button></div></div>';
    }).join('') || '<small>Tidak ada pasien yang perlu dihubungi saat ini.</small>';
    var steps = [['Sebelum pulang', 'Edukasi teach-back, resume dikirim ke puskesmas'], ['Hari ke-2', 'Telepon perawat penghubung'], ['Hari ke-7 (Kunjungan 1)', 'Kunjungan tatap muka di puskesmas, pasien menerima akses TEMU'],
      ['Kunjungan 2 dan 3', 'Konsultasi daring (video, telepon, atau chat)'], ['Hari ke-14', 'Kontrol poli jantung, rujuk balik bila stabil'], ['Setiap hari', 'Catatan gejala: hijau lanjut, kuning hubungi perawat, merah ke IGD']];
    return '<h2>Jadwal dan Follow-up (Heart Failure Transitional Care Pathway)</h2>' +
      '<div class="card"><h3>Daftar pasien yang perlu dihubungi</h3>' + todo + '</div>' +
      '<div class="card"><h3>Alur tindak lanjut</h3>' + steps.map(function (s) { return '<div class="tl"><b>' + s[0] + '</b> — ' + s[1] + '</div>'; }).join('') +
      '<small style="color:var(--mu)">Penjadwalan kunjungan K2/K3 belum disimpan di server (backend belum memiliki modul jadwal).</small></div>' +
      (cp ? pbar() + '<div class="card tbl"><h3>Riwayat panggilan pasien terpilih</h3><table><tr><th>Jenis</th><th>Dimulai oleh</th><th>Waktu</th><th>Durasi</th><th>Status</th></tr>' +
        (cl.map(function (c) { var s = CALLST[c.status] || ['', c.status]; return '<tr><td>' + (c.type === 'video' ? 'Video' : 'Telepon') + '</td><td>' + esc(c.initiatorName) + '</td><td>' + HQ.fmtDT(c.createdAt) + '</td><td>' + (c.durationSec != null ? Math.floor(c.durationSec / 60) + ':' + ('0' + c.durationSec % 60).slice(-2) : '—') + '</td><td><span class="bd ' + s[0] + '">' + s[1] + '</span></td></tr>'; }).join('') || '<tr><td colspan="5">Belum ada panggilan.</td></tr>') + '</table></div>' : '');
  });
}

/* ================= 10. Tim multidisiplin ================= */
function tim() {
  var room = cp ? GET('/team/rooms/patient/' + encodeURIComponent(cp)) : Promise.resolve(null);
  return Promise.all([GET('/staff'), room]).then(function (r) {
    var inRoom = r[1] ? r[1].members.map(function (m) { return m.id; }) : [];
    var p = patientOf(cp);
    return '<h2>Tim Multidisiplin' + (p ? ' — ' + esc(p.name) : '') + '</h2>' + (cp ? pbar() : '') + '<div class="card tbl"><table><tr><th>Nama</th><th>Profesi</th><th>Unit / fasilitas</th><th>Peran</th><th>Grup pasien</th></tr>' +
      r[0].map(function (x) { return '<tr><td>' + esc(x.name) + (x.id === me.id ? ' <span class="bd">Anda</span>' : '') + '</td><td>' + esc(x.profession || '') + '</td><td>' + esc(x.facility || '') + '</td><td>' + esc(ROLE_DESC[x.profession] || '—') + '</td><td>' + (inRoom.indexOf(x.id) >= 0 ? '<span class="bd g">Anggota</span>' : '—') + '</td></tr>'; }).join('') +
      '</table></div><div class="card ro">Hak akses: dokter membuat resep dan resume, apoteker menelaah resep, semua profesi mengisi CPPT sesuai kewenangan.</div>';
  });
}

/* ================= 11. Integrasi data ================= */
function integ() {
  return fetch(HQ.BASE + '/health').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (h) {
    var chip = function (ok, t) { return '<span class="live ' + (ok ? '' : 'off') + '">' + t + '</span> '; };
    var map = [['Catatan Gejala Harian (pasien)', 'POST /api/monitoring/:rm/logs', 'Monitoring, zona, notifikasi (monitoring:new / alert)'], ['TEMU B (pasien)', 'REST /api/qna + socket qna:*', 'Pesan Pasien (TEMU B)'],
      ['Video call / telepon', 'POST /api/calls + LiveKit', 'Panggilan masuk/keluar di semua halaman'], ['Chat, grup, konsultasi, handover', 'REST /api/team + socket team:*', 'Komunikasi Tim'],
      ['CPPT, obat, lab', 'REST /api/patients/:rm/…', 'Halaman CPPT, Resep, Lab'], ['Resume medis', 'REST /api/summaries', 'Resume dan Rujukan; pasien melihat yang final']];
    return '<h2>Integrasi Data Pasien</h2><div class="card"><p>' + chip(h && h.ok, 'API ' + (h && h.ok ? 'aktif' : 'tidak terjangkau')) + chip(sock && sock.connected, 'Realtime ' + (sock && sock.connected ? 'terhubung' : 'terputus')) +
      chip(h && h.livekit, 'LiveKit ' + (h && h.livekit ? 'dikonfigurasi' : 'belum dikonfigurasi')) + '</p><p>Masuk sebagai <b>' + esc(me.name) + '</b> (' + esc(me.email || '') + ', ' + esc(prof()) + ').</p>' +
      '<p>Alur data: <b>Catatan Gejala Harian</b> dan <b>TEMU B</b> (pasien) → <b>Monitoring</b>, notifikasi, dan <b>Pesan Pasien</b> (nakes). Balasan nakes langsung tampil di TEMU B pasien.</p></div>' +
      '<div class="two"><div class="card"><h3>Peta integrasi</h3><div class="tbl"><table><tr><th>Fitur</th><th>Kontrak</th></tr>' + map.map(function (m) { return '<tr><td>' + m[0] + '<br><small>' + m[2] + '</small></td><td><code>' + m[1] + '</code></td></tr>'; }).join('') + '</table></div></div>' +
      '<div class="card"><h3>Log data masuk (realtime)</h3>' + (LOG.map(function (l) { return '<div style="padding:.3rem 0;border-bottom:1px solid var(--bd)"><b>' + esc(l[0]) + '</b> · ' + esc(l[1]) + '<br><small style="color:var(--mu)">' + l[2] + '</small></div>'; }).join('') || 'Belum ada data masuk. Isi catatan gejala atau kirim pesan dari akun pasien.') + '</div></div>';
  });
}
