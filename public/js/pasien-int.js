/* HatiQu — aplikasi pasien: lapisan integrasi backend.
 * Dimuat SETELAH skrip inline di pasien.html, sehingga menimpa menu-menu yang datanya kini berasal dari server:
 *   Catatan Gejala Harian (S.gejala), Hasil Lab (S.lab), Status Resep (S.resep), Resume Medis (S.resume),
 *   Info Pengguna (S.profil), dan ruang chat/video/telepon TEMU (HQ.room).
 */
(function () {
  'use strict';
  var enc = encodeURIComponent;
  var DEMO_RM = '12-34-56';
  var GET = function (p) { return HQ.api(p); };
  var POST = function (p, b) { return HQ.api(p, { method: 'POST', body: b || {} }); };
  var QNA = { add: null };
  var LOGS = {};

  /* ---------- menu berisi contoh (khusus pasien demo) ---------- */
  var DEMO_ONLY = ['rad', 'pa', 'alat', 'skdp', 'riwayat', 'biaya', 'radiot', 'jdwrad', 'alur'];
  window.HQ_gated = function (id) {
    if (PT.rm === DEMO_RM) return false;
    if (DEMO_ONLY.indexOf(id) >= 0) return true;
    if ((id === 'antrian' || id === 'bpjs') && st.tiket && st.tiket.kode === 'BK-231126-0142') return true;
    return false;
  };
  window.HQ_gate = function (p, name) {
    var tiket = name === 'Antrian Rawat Jalan' || name === 'Check IN BPJS';
    p.innerHTML = '<h2>' + esc(name) + '</h2><p class="sub">' + (tiket ? 'Belum ada tiket antrian. Daftar dulu lewat menu Pendaftaran Online.' : 'Belum ada data untuk akun Anda di menu ini. Hasilnya akan muncul di sini bila sudah tersedia.') + '</p>';
  };

  /* ---------- Info pengguna ---------- */
  S.profil = function (p) {
    p.innerHTML = '<h2>Info Pengguna</h2><p class="sub">Identitas pasien dari rekam medis.</p>' + rows([
      ['👤', 'Nama', esc(PT.nama)], ['🗂️', 'No. rekam medis', esc(PT.rm)],
      ['🎂', 'Tanggal lahir', PT.lahir ? HQ.fmtD(PT.lahir) + (PT.age != null ? ' (' + PT.age + ' tahun)' : '') : '—'],
      ['🚻', 'Jenis kelamin', esc(PT.sex || '—')], ['🩺', 'Diagnosis', esc(PT.dx || '—')],
      ['💧', 'Berat badan kering', PT.dry ? cm(PT.dry) + ' kg (acuan pemantauan)' : '—'],
      ['👵', 'Pendamping', PT.companion ? esc(PT.companion) + (PT.companionPhone ? ', ' + esc(PT.companionPhone) : '') : 'Belum tercatat']]);
  };

  /* ---------- Hasil laboratorium ---------- */
  S.lab = function (p) {
    p.innerHTML = '<h2>Hasil Laboratorium</h2><p class="sub">Memuat…</p>';
    GET('/patients/' + enc(PT.rm) + '/labs').then(function (labs) {
      var t = [['Tanggal', 'Pemeriksaan', 'Hasil', 'Rujukan', 'Status']].concat(labs.map(function (r) {
        return [HQ.fmtD(r.testedAt), esc(r.name), esc(r.value), esc(r.range || '—'), esc(r.flag || '—')];
      }));
      p.innerHTML = '<h2>Hasil Laboratorium</h2><p class="sub">Hasil pemeriksaan yang sudah diinput tenaga kesehatan.</p>' + (labs.length ? tbl(t) : '<div class="empty">Belum ada hasil pemeriksaan.</div>');
    }).catch(function (e) { p.innerHTML = '<h2>Hasil Laboratorium</h2><p class="err">' + esc(e.message) + '</p>'; });
  };

  /* ---------- Status resep ---------- */
  S.resep = function (p) {
    p.innerHTML = '<h2>Status Resep</h2><p class="sub">Memuat…</p>';
    GET('/patients/' + enc(PT.rm) + '/medications').then(function (meds) {
      var t = [['Tanggal', 'Obat', 'Dosis', 'Rute', 'Status']].concat(meds.map(function (m) {
        return [HQ.fmtD(m.createdAt), esc(m.name), esc(m.dose), esc(m.route), m.status === 'selesai_ditelaah' ? 'Sudah ditelaah apoteker' : 'Menunggu telaah'];
      }));
      p.innerHTML = '<h2>Status Resep</h2><p class="sub">Daftar obat dari dokter. Ikuti resep dokter dan jangan mengubah dosis sendiri.</p>' + (meds.length ? tbl(t) : '<div class="empty">Belum ada resep.</div>');
    }).catch(function (e) { p.innerHTML = '<h2>Status Resep</h2><p class="err">' + esc(e.message) + '</p>'; });
  };

  /* ---------- Resume medis (hanya yang final / terkirim) ---------- */
  var RF = [['ringkasanRiwayat', 'Ringkasan perawatan'], ['diagnosisAkhir', 'Diagnosis'], ['kondisiSaatPulang', 'Kondisi saat pulang'], ['terapiLanjutan', 'Terapi lanjutan'],
    ['rekomendasi', 'Rekomendasi'], ['instruksiPemantauan', 'Instruksi pemantauan'], ['jadwalKontrol', 'Jadwal kontrol']];
  S.resume = function (p) {
    function list() {
      p.innerHTML = '<h2>Resume Medis</h2><p class="sub">Memuat…</p>';
      GET('/patients/' + enc(PT.rm) + '/summaries').then(function (l) {
        p.innerHTML = '<h2>Resume Medis</h2><p class="sub">Resume yang sudah difinalisasi dokter.</p>' + (l.length ? l.map(function (s) {
          return '<button class="btn alt" data-i="' + s.id + '" style="text-align:left;margin-top:6px"><b>' + esc(s.title) + '</b><br><small>' + HQ.fmtD(s.finalizedAt || s.createdAt) + ' · ' + esc(s.authorName) + '</small></button>';
        }).join('') : '<div class="empty">Belum ada resume medis yang dirilis dokter.</div>');
        p.querySelectorAll('[data-i]').forEach(function (b) { b.onclick = function () { det(b.dataset.i); }; });
      }).catch(function (e) { p.innerHTML = '<h2>Resume Medis</h2><p class="err">' + esc(e.message) + '</p>'; });
    }
    function det(id) {
      GET('/summaries/' + id).then(function (d) {
        var c = d.content || {}, sn = d.snapshot || {};
        p.innerHTML = '<button class="lk" id="bl" style="color:var(--pri)">‹ Resume</button><h2>' + esc(d.title) + '</h2><p class="sub">' + esc(d.authorName) + ' · ' + HQ.fmtD(d.finalizedAt || d.createdAt) + '</p>' +
          rows(RF.filter(function (f) { return c[f[0]]; }).map(function (f) { return ['📄', f[1], esc(c[f[0]]).replace(/\n/g, '<br>')]; })) +
          (sn.medications && sn.medications.length ? '<b>Obat</b>' + rows(sn.medications.map(function (m) { return ['💊', esc(m.name), esc(m.dose)]; })) : '') +
          '<button class="btn alt" onclick="window.print()">🖨️ Cetak / simpan PDF</button>';
        document.getElementById('bl').onclick = list;
      }).catch(function (e) { HQ.toast(e.message); });
    }
    list();
  };

  /* ---------- Catatan gejala harian (kalender + triase oleh server) ---------- */
  function isoOf(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function dOf(k) { var a = k.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function zc(z) { return z === 'merah' ? 'bad' : z === 'kuning' ? 'warn' : 'ok'; }
  function loadLogs() {
    return GET('/monitoring/' + enc(PT.rm) + '/logs?days=365').then(function (l) { LOGS = {}; l.forEach(function (x) { LOGS[x.date] = x; }); if (l[0]) setGj(l[0]); return l; });
  }
  function setGj(l) {
    var g = (l.symptoms || []).slice();
    if (l.restDyspnea) g.push('Sesak saat istirahat'); if (l.syncope) g.push('Pingsan atau hampir pingsan'); if (l.chestPain) g.push('Nyeri dada');
    st.gj = { tgl: HQ.fmtD(l.date), bb: cm(l.weight), d: cm(l.weightDelta), g: g, kl: l.note || '', z: 'Zona ' + l.zona, why: l.reasons || [] };
  }

  S.gejala = function (p) {
    var today = new Date(), todayK = isoOf(today);
    var Y = st.cy || today.getFullYear(), M = st.cm == null ? today.getMonth() : st.cm, K = st.ck || todayK;
    function draw() {
      var f = new Date(Y, M, 1), off = (f.getDay() + 6) % 7, n = new Date(Y, M + 1, 0).getDate(), c = '', i;
      for (i = 0; i < off; i++) c += '<span></span>';
      for (i = 1; i <= n; i++) {
        var dt = new Date(Y, M, i), k = isoOf(dt), e = LOGS[k];
        c += '<button class="day" data-k="' + k + '"' + (k > todayK ? ' disabled' : '') + (k === K ? ' style="outline:2px solid var(--pri)"' : '') + '>' + i + (e ? '<i style="background:var(--' + zc(e.zona) + ')"></i>' : '') + '</button>';
      }
      p.innerHTML = '<h2>Catatan Gejala Harian</h2><p class="sub">Kalender catatan kesehatan. Ketuk tanggal untuk melihat atau mengisi. Hasil dinilai otomatis oleh sistem dan dilihat perawat.</p>' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><button class="chip" id="pv" aria-label="Bulan sebelumnya">‹</button><b>' + MN[M] + ' ' + Y + '</b><button class="chip" id="nx" aria-label="Bulan berikutnya"' + (Y === today.getFullYear() && M === today.getMonth() ? ' disabled' : '') + '>›</button></div>' +
        '<div class="cal">' + ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].map(function (x) { return '<small>' + x + '</small>'; }).join('') + c + '</div>' +
        '<p class="sub">Titik: hijau aman, kuning perlu perhatian, merah darurat.</p><div id="dp"></div>';
      document.getElementById('pv').onclick = function () { M--; if (M < 0) { M = 11; Y--; } st.cy = Y; st.cm = M; draw(); };
      document.getElementById('nx').onclick = function () { M++; if (M > 11) { M = 0; Y++; } st.cy = Y; st.cm = M; draw(); };
      p.querySelectorAll('.day').forEach(function (b) { b.onclick = function () { K = b.dataset.k; st.ck = K; draw(); }; });
      dp();
    }
    function dp() {
      var e = LOGS[K], el = document.getElementById('dp'), h = '<h2 style="margin-top:6px">' + HQ.fmtD(K) + '</h2>';
      if (!e) { el.innerHTML = h + '<p class="sub">Belum ada catatan pada tanggal ini.</p><button class="btn" id="ed">Isi catatan</button>'; document.getElementById('ed').onclick = form; return; }
      var r = [], v = [], l = [];
      if (has(e.weight)) v.push('BB ' + cm(e.weight) + ' kg'); if (has(e.weightDelta)) v.push((e.weightDelta > 0 ? '+' : '') + cm(e.weightDelta) + ' kg/3 hari');
      if (has(e.systolic)) v.push('TD ' + e.systolic + '/' + (has(e.diastolic) ? e.diastolic : '-')); if (has(e.pulse)) v.push('nadi ' + e.pulse);
      if (has(e.glucose)) l.push('gula darah ' + e.glucose); if (has(e.cholesterol)) l.push('kolesterol ' + e.cholesterol); if (has(e.uricAcid)) l.push('asam urat ' + e.uricAcid);
      if (v.length) r.push(['⚖️', 'Pengukuran', esc(v.join(', '))]); if (l.length) r.push(['🧪', 'Hasil cek mandiri (mg/dL)', esc(l.join(', '))]);
      var sy = (e.symptoms || []).slice(); if (e.restDyspnea) sy.push('Sesak saat istirahat'); if (e.syncope) sy.push('Pingsan atau hampir pingsan');
      if (e.chestPain) sy.push('Nyeri dada skala ' + e.chestPain.scale);
      r.push(['🗒️', 'Keluhan', esc(e.note || '-') + (sy.length ? '. Gejala: ' + esc(sy.join(', ')) + (e.durationDays ? ', ' + e.durationDays + ' hari' : '') : '')]);
      h += rows(r) + '<div class="zone z-' + zc(e.zona) + '">Zona ' + e.zona + '<br><span style="font-weight:400">' + (e.reasons.length ? 'Karena: ' + esc(e.reasons.join('; ')) + '. ' : '') + esc(e.advice || '') + '</span></div>';
      if (e.zona === 'kuning') h += '<p class="sub" style="margin-top:10px">Disarankan pemeriksaan medis. Pilih salah satu:</p><button class="btn" id="a1">🏥 Periksa langsung (Pendaftaran Online)</button><button class="btn alt" id="a2">💬 Konsultasi daring (TEMU)</button>';
      if (e.zona === 'merah') h += '<div style="border:2px solid var(--bad);border-radius:12px;padding:12px;margin-top:10px"><b>🚑 Segera ke IGD</b><br>IGD buka 24 jam. Hubungi 119 atau minta keluarga mengantar. Jangan menyetir sendiri dan jangan menunggu jadwal kontrol. Bawa daftar obat dan resume pulang.</div><button class="btn" id="a3" style="background:var(--bad)">📞 Simulasi: hubungi 119</button><div id="a4"></div>';
      h += '<button class="btn alt" id="ed">Ubah catatan</button><p class="fine">Hasil kategori adalah alat bantu, bukan diagnosis. Bila ragu, periksa ke tenaga kesehatan.</p>';
      el.innerHTML = h; document.getElementById('ed').onclick = form;
      var b = document.getElementById('a1'); if (b) b.onclick = function () { W = { s: 1 }; open('daftar'); };
      b = document.getElementById('a2'); if (b) b.onclick = function () { st.tab = 'B'; open('temu'); };
      b = document.getElementById('a3'); if (b) b.onclick = function () { document.getElementById('a4').innerHTML = '<p><span class="chip ok">Simulasi</span> Menghubungi 119. Tetap tenang, duduk setengah tegak, dan tunggu bantuan.</p>'; };
    }
    function form() {
      var e = LOGS[K] || { symptoms: [] }, el = document.getElementById('dp'), vv = function (x) { return has(x) ? x : ''; };
      var I = function (id, lb, val, s2) { return '<label class="f" style="flex:1">' + lb + '<input id="' + id + '" type="number" step="' + (s2 || 'any') + '" value="' + vv(val) + '"></label>'; };
      var cpn = e.chestPain;
      el.innerHTML = '<h2 style="margin-top:6px">Catatan ' + HQ.fmtD(K) + '</h2><div style="display:flex;gap:8px">' + I('bb', 'Berat badan (kg)', e.weight, '0.1') + '</div>' +
        '<div style="display:flex;gap:8px">' + I('s', 'TD atas (mmHg)', e.systolic) + I('di', 'TD bawah', e.diastolic) + I('nd', 'Nadi (/menit)', e.pulse) + '</div>' +
        '<div style="display:flex;gap:8px">' + I('gds', 'Gula darah (mg/dL)', e.glucose) + I('kol', 'Kolesterol (mg/dL)', e.cholesterol) + I('au', 'Asam urat (mg/dL)', e.uricAcid, '0.1') + '</div>' +
        '<b style="display:block;margin-top:12px">Gejala</b>' + GJ.map(function (g) { return '<label class="ck"><input type="checkbox" data-g="' + g[0] + '"' + (e.symptoms.indexOf(g[0]) > -1 ? ' checked' : '') + '>' + g[0] + '</label>'; }).join('') +
        '<label class="ck"><input type="checkbox" id="ist"' + (e.restDyspnea ? ' checked' : '') + '>Sesak saat istirahat</label><label class="ck"><input type="checkbox" id="pgs"' + (e.syncope ? ' checked' : '') + '>Pingsan atau hampir pingsan</label>' +
        '<label class="ck"><input type="checkbox" id="ny"' + (cpn ? ' checked' : '') + '>Nyeri dada</label>' +
        '<div id="nyb" style="display:' + (cpn ? 'block' : 'none') + ';padding-left:8px"><label class="f">Skala nyeri (0–10)<select id="sk">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (x) { return '<option' + (cpn && cpn.scale === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Menjalar ke<select id="mj">' + ['Tidak menjalar', 'Lengan kiri', 'Lengan kanan', 'Rahang', 'Punggung'].map(function (x) { return '<option' + (cpn && cpn.radiates === x ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' +
        '<label class="f">Saat istirahat<select id="hl"><option>Hilang</option><option' + (cpn && cpn.relievedByRest === false ? ' selected' : '') + '>Tidak hilang</option></select></label></div>' +
        I('lama', 'Sudah berapa hari keluhan berlangsung?', e.durationDays) +
        '<label class="f">Keluhan (tulis dengan kata sendiri)<textarea id="kl" rows="2" maxlength="1000" placeholder="Contoh: pusing, mual, sulit tidur">' + esc(e.note || '') + '</textarea></label>' +
        '<div id="er" class="err"></div><button class="btn" id="sv">Simpan dan cek kondisi saya</button><button class="btn alt" id="cn">Batal</button>';
      document.getElementById('ny').onchange = function () { document.getElementById('nyb').style.display = this.checked ? 'block' : 'none'; };
      document.getElementById('cn').onclick = dp;
      document.getElementById('sv').onclick = function () {
        var n = function (i) { var x = parseFloat(document.getElementById(i).value); return isNaN(x) ? undefined : x; };
        var b = { date: K, weight: n('bb'), systolic: n('s'), diastolic: n('di'), pulse: n('nd'), glucose: n('gds'), cholesterol: n('kol'), uricAcid: n('au'), symptoms: [],
          restDyspnea: document.getElementById('ist').checked, syncope: document.getElementById('pgs').checked };
        var lama = parseInt(document.getElementById('lama').value, 10); if (!isNaN(lama)) b.durationDays = lama;
        var note = document.getElementById('kl').value.trim(); if (note) b.note = note;
        p.querySelectorAll('[data-g]').forEach(function (c) { if (c.checked) b.symptoms.push(c.dataset.g); });
        if (document.getElementById('ny').checked) b.chestPain = { scale: +document.getElementById('sk').value, radiates: document.getElementById('mj').value, relievedByRest: document.getElementById('hl').value === 'Hilang' };
        if (b.weight === undefined && b.systolic === undefined && b.glucose === undefined && b.cholesterol === undefined && b.uricAcid === undefined && !b.symptoms.length && !b.restDyspnea && !b.syncope && !b.chestPain && !note)
          return (document.getElementById('er').textContent = 'Isi minimal satu data atau keluhan.');
        var btn = this; btn.disabled = true; document.getElementById('er').textContent = '';
        POST('/monitoring/' + enc(PT.rm) + '/logs', b).then(function (log) {
          LOGS[log.date] = log;
          var latest = Object.keys(LOGS).sort().pop(); if (latest === log.date) setGj(log);
          draw();
        }).catch(function (er) { btn.disabled = false; document.getElementById('er').textContent = er.message; });
      };
    }
    draw();
    loadLogs().then(function () { if (document.getElementById('dp')) draw(); }).catch(function () {});
  };

  /* ---------- TEMU: chat (TEMU B / Q&A) + video + telepon sungguhan ---------- */
  HQ.room = function (p, a, m, back, T, mkSum) {
    var nm = a ? a.n.split(' (')[0] : 'Perawat penghubung';
    function fin() {
      QNA.add = null;
      if (a) { a.done = true; a.sum = mkSum(a); if (a.tp === 'B') T.bl.unshift(a); back('Konsultasi selesai. Ringkasannya tersimpan dan bisa dilihat di Riwayat Layanan. Konsultasi tidak dapat diulang.'); } else back('');
    }
    if (m === 'chat') {
      var msgs = [];
      p.innerHTML = '<h2>Chat dengan tim perawatan</h2><p class="sub">Pesan masuk ke perawat jaga dan dijawab pada jam kerja 07.00–16.00. Bila sesak berat saat istirahat atau nyeri dada, segera ke IGD atau hubungi 119.</p><div id="qm"></div>' +
        '<textarea id="qms" rows="2" maxlength="2000" placeholder="Tulis pesan"></textarea><button class="btn" id="qsd">Kirim</button><button class="btn alt" id="qfn">' + (a ? 'Selesai konsultasi' : 'Kembali') + '</button>';
      var box = document.getElementById('qm');
      var drawM = function () {
        box.innerHTML = msgs.length ? msgs.map(function (x) {
          var me = x.from === 'pasien';
          return '<div class="bub ' + (me ? 'me' : 'nu') + '">' + (me ? '' : '<small style="display:block;opacity:.75">' + esc(x.senderName) + '</small>') + esc(x.body) + '<small style="display:block;opacity:.7;font-size:11px">' + HQ.fmtDT(x.createdAt) + '</small></div>';
        }).join('') : '<div class="empty">Belum ada pesan.</div>';
        window.scrollTo(0, document.body.scrollHeight);
      };
      QNA.add = function (x) {
        if (!document.getElementById('qm')) { QNA.add = null; return false; }
        if (msgs.some(function (y) { return y.id === x.id; })) return true;
        msgs.push(x); drawM();
        if (x.from === 'nakes') POST('/qna/' + enc(PT.rm) + '/read').catch(function () {});
        return true;
      };
      GET('/qna/' + enc(PT.rm) + '/messages').then(function (l) { msgs = l; drawM(); POST('/qna/' + enc(PT.rm) + '/read').catch(function () {}); }).catch(function (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; });
      document.getElementById('qsd').onclick = function () {
        var t = document.getElementById('qms'), v2 = t.value.trim(); if (!v2) return; t.value = '';
        POST('/qna/' + enc(PT.rm) + '/messages', { body: v2 }).then(function (x) { QNA.add && QNA.add(x); }).catch(function (e) { HQ.toast(e.message); t.value = v2; });
      };
      document.getElementById('qfn').onclick = fin;
      return;
    }
    p.innerHTML = '<h2>' + (m === 'video' ? 'Video call' : 'Telepon') + '</h2><p class="sub">Menghubungkan ke perawat jaga…</p>';
    HQ.Calls.start({
      type: m === 'video' ? 'video' : 'audio', title: m === 'video' ? 'Video call dengan perawat' : 'Telepon dengan perawat',
      onEnd: function (call, answered) {
        if (answered) fin();
        else back(call && call.status === 'declined' ? 'Panggilan ditolak. Coba lagi atau gunakan chat.' : 'Panggilan tidak terhubung. Coba lagi nanti atau gunakan chat.');
      },
    });
  };

  /* ---------- boot ---------- */
  var rmS = HQ.session.get();
  HQ.requireRole('pasien').then(function (me) {
    return GET('/patients/' + enc(me.patientRm));
  }).then(function (d) {
    PT = { rm: d.rm, nama: d.name, lahir: d.birthDate, age: d.age, sex: d.sex, dx: d.diagnosis, dry: d.dryWeight, companion: d.companionName, companionPhone: d.companionPhone };
    st.user = PT;
    home();
    loadLogs().catch(function () {});
    return HQ.connect().then(function (sock) {
      HQ.Calls.init(sock);
      sock.on('qna:message', function (x) {
        if (x.from !== 'nakes') { if (QNA.add) QNA.add(x); return; }
        if (!(QNA.add && QNA.add(x) !== false)) HQ.toast('💬 Balasan dari ' + x.senderName + ': ' + (x.body.length > 50 ? x.body.slice(0, 47) + '…' : x.body));
      });
      sock.on('notification', function (n) { if (/Balasan dari/.test(n.text) === false) HQ.toast((n.icon || '🔔') + ' ' + n.text); });
    }).catch(function () { HQ.toast('Koneksi realtime gagal. Pesan baru akan tampil setelah halaman dimuat ulang.'); });
  }).catch(function (e) {
    document.getElementById('view').innerHTML = '<div class="sheet"><h2>Gagal memuat</h2><p class="err">' + esc(e.message) + '</p><button class="btn" onclick="location.reload()">Coba lagi</button></div>';
  });
})();
