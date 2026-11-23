/* HatiQu — modul bersama (dipakai index.html, nakes.html, pasien.html)
 * - sesi (token JWT di localStorage)
 * - pembungkus REST  : HQ.api('/path', {method, body})
 * - Socket.IO        : HQ.connect() -> socket, HQ.emit(event, payload) (ack + timeout)
 * - panggilan video/telepon (LiveKit) : HQ.Calls.init(socket, me) / HQ.Calls.start({...})
 */
(function () {
  'use strict';
  var BASE = String(window.HATIQU_API_URL || '').replace(/\/$/, ''); // kosong = origin yang sama
  var KEY = 'hatiqu.session';
  var HQ = (window.HQ = { BASE: BASE });

  /* ---------- util ---------- */
  HQ.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  HQ.rmN = function (s) {
    var d = String(s == null ? '' : s).replace(/\D/g, '');
    return d.length === 6 ? d.slice(0, 2) + '-' + d.slice(2, 4) + '-' + d.slice(4) : String(s == null ? '' : s).trim();
  };
  HQ.fmtDT = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  HQ.fmtD = function (iso) {
    if (!iso) return '—';
    var d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00') : new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  HQ.todayISO = function () { return new Date().toLocaleDateString('en-CA'); };

  /* ---------- sesi ---------- */
  HQ.session = {
    get: function () { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } },
    set: function (s) { localStorage.setItem(KEY, JSON.stringify(s)); },
    clear: function () { try { localStorage.removeItem(KEY); } catch (e) { /* abaikan */ } },
  };
  HQ.logout = function () {
    HQ.session.clear();
    try { if (HQ.socket) HQ.socket.disconnect(); } catch (e) { /* abaikan */ }
    location.href = '/';
  };
  HQ.home = function (role) { return role === 'nakes' ? '/nakes.html' : '/pasien.html'; };

  /* ---------- REST ---------- */
  HQ.api = function (path, opt) {
    opt = opt || {};
    var s = HQ.session.get();
    var headers = { 'Content-Type': 'application/json' };
    if (s && s.token && !opt.anon) headers.Authorization = 'Bearer ' + s.token;
    return fetch(BASE + '/api' + path, {
      method: opt.method || 'GET',
      headers: headers,
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          if (res.status === 401 && s && !opt.anon) HQ.logout(); // token kedaluwarsa / dicabut
          var msg = (data && data.error) || 'Kesalahan ' + res.status;
          if (data && data.details && data.details[0] && data.details[0].message) msg += ': ' + data.details[0].message;
          var e = new Error(msg);
          e.status = res.status;
          e.data = data;
          throw e;
        }
        return data;
      });
    });
  };

  /** Pastikan sudah login dengan peran yang benar; kalau tidak, arahkan ke halaman yang sesuai. */
  HQ.requireRole = function (role) {
    var s = HQ.session.get();
    if (!s || !s.token) { location.replace('/'); return new Promise(function () {}); }
    return HQ.api('/auth/me').then(function (me) {
      if (me.user.role !== role) { location.replace(HQ.home(me.user.role)); return new Promise(function () {}); }
      HQ.session.set({ token: s.token, user: me.user, patientRm: me.patientRm });
      return me;
    });
  };

  /* ---------- toast ---------- */
  HQ.toast = function (t) {
    var e = document.getElementById('hq-toast');
    if (!e) {
      e = document.createElement('div');
      e.id = 'hq-toast';
      e.setAttribute('role', 'status');
      e.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(5.5rem + env(safe-area-inset-bottom,0px));background:#12263f;color:#fff;padding:.6rem 1rem;border-radius:10px;z-index:100000;display:none;max-width:90vw;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)';
      document.body.appendChild(e);
    }
    e.textContent = t;
    e.style.display = 'block';
    clearTimeout(e._t);
    e._t = setTimeout(function () { e.style.display = 'none'; }, 3200);
  };

  /* ---------- Socket.IO ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Gagal memuat ' + src)); };
      document.head.appendChild(s);
    });
  }
  HQ.loadScript = loadScript;

  HQ.connect = function () {
    var s = HQ.session.get();
    return loadScript(BASE + '/socket.io/socket.io.js').then(function () {
      var opts = { auth: { token: s && s.token }, reconnectionDelayMax: 5000 };
      var sock = BASE ? window.io(BASE, opts) : window.io(opts);
      HQ.socket = sock;
      sock.on('connect_error', function (err) {
        if (err && err.message === 'unauthorized') HQ.logout();
      });
      return sock;
    });
  };

  /** emit dengan ack + timeout: resolve({ok:true,...}) atau reject(Error). */
  HQ.emit = function (event, payload) {
    return new Promise(function (resolve, reject) {
      if (!HQ.socket) return reject(new Error('Belum terhubung ke server'));
      HQ.socket.timeout(10000).emit(event, payload || {}, function (err, res) {
        if (err) return reject(new Error('Server tidak merespons'));
        if (res && res.ok) resolve(res);
        else reject(new Error((res && res.error) || 'Gagal'));
      });
    });
  };

  /* =====================================================================
   * Panggilan video / telepon (LiveKit)
   * Alur: pemanggil POST /api/calls -> langsung join room; penerima menerima
   * 'call:incoming' -> POST /api/calls/:id/accept -> join room.
   * ===================================================================== */
  var LK_SRC = window.HATIQU_LIVEKIT_SRC || 'https://cdn.jsdelivr.net/npm/livekit-client@2.5.0/dist/livekit-client.umd.js';
  var Calls = (HQ.Calls = {});
  var sock = null;
  var cur = null;  // { call, room, ui, onEnd, joinedAt, timer }
  var ringUI = null; // { call, el }

  function css() {
    if (document.getElementById('hq-call-css')) return;
    var st = document.createElement('style');
    st.id = 'hq-call-css';
    st.textContent =
      '#hq-call,#hq-ring{position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;background:#0b1620;color:#fff;font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '#hq-ring{background:rgba(8,16,24,.92);align-items:center;justify-content:center;text-align:center;gap:.4rem;padding:1.5rem}' +
      '#hq-ring .av,#hq-call .av{font-size:64px;line-height:1.2}' +
      '#hq-call .stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#0e1a22}' +
      '#hq-call video.remote{width:100%;height:100%;object-fit:contain;background:#000}' +
      '#hq-call video.local{position:absolute;right:12px;bottom:12px;width:110px;max-width:28%;border-radius:10px;border:2px solid rgba(255,255,255,.5);background:#000;transform:scaleX(-1)}' +
      '#hq-call .ov{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.3rem;pointer-events:none;text-align:center;padding:1rem}' +
      '#hq-call .bar{display:flex;gap:.6rem;justify-content:center;padding:.9rem .6rem calc(.9rem + env(safe-area-inset-bottom,0px));background:#0b1620}' +
      '.hq-b{border:0;border-radius:99px;padding:.7rem 1.1rem;font:inherit;font-weight:600;cursor:pointer;background:#27404f;color:#fff}' +
      '.hq-b.off{background:#fff;color:#0b1620}.hq-b.red{background:#d33a2f}.hq-b.grn{background:#1f9d62}' +
      '#hq-call .top{padding:.7rem 1rem;padding-top:calc(.7rem + env(safe-area-inset-top,0px));background:#0b1620;display:flex;justify-content:space-between;gap:.5rem}';
    document.head.appendChild(st);
  }

  function liveKit() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    return loadScript(LK_SRC).then(function () {
      if (!window.LivekitClient) throw new Error('livekit-client tidak termuat');
      return window.LivekitClient;
    });
  }

  function who(call, from) {
    return (from && from.name) || call.initiatorName || call.patientName || 'Pemanggil';
  }
  function typeLabel(t) { return t === 'video' ? 'Video call' : 'Telepon'; }

  function stopRing() { if (ringUI) { ringUI.el.remove(); ringUI = null; } }

  function showRing(payload) {
    css();
    stopRing();
    var call = payload.call;
    var el = document.createElement('div');
    el.id = 'hq-ring';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', 'Panggilan masuk');
    el.innerHTML =
      '<div class="av">' + (call.type === 'video' ? '📹' : '📞') + '</div>' +
      '<div style="font-size:13px;opacity:.8">' + typeLabel(call.type) + ' masuk</div>' +
      '<div style="font-size:22px;font-weight:700">' + HQ.esc(who(call, payload.from)) + '</div>' +
      (call.patientRm && payload.from && payload.from.role === 'pasien' ? '<div style="opacity:.8">No. RM ' + HQ.esc(call.patientRm) + '</div>' : '') +
      '<div style="display:flex;gap:1rem;margin-top:1.2rem"><button class="hq-b red" data-a="no">Tolak</button><button class="hq-b grn" data-a="ok">Terima</button></div>';
    document.body.appendChild(el);
    ringUI = { call: call, el: el };
    el.querySelector('[data-a="no"]').onclick = function () {
      stopRing();
      HQ.api('/calls/' + call.id + '/decline', { method: 'POST' }).catch(function () {});
    };
    el.querySelector('[data-a="ok"]').onclick = function () {
      stopRing();
      HQ.api('/calls/' + call.id + '/accept', { method: 'POST' })
        .then(function (r) { return join(r.connection, r.call, {}); })
        .catch(function (e) { HQ.toast(e.message || 'Gagal menjawab panggilan'); });
    };
  }

  function buildUI(call, title) {
    css();
    var el = document.createElement('div');
    el.id = 'hq-call';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', typeLabel(call.type));
    el.innerHTML =
      '<div class="top"><b>' + HQ.esc(title) + '</b><span class="st">Menghubungkan…</span></div>' +
      '<div class="stage"><video class="remote" autoplay playsinline style="display:none"></video>' +
      '<div class="ov"><div class="av">' + (call.type === 'video' ? '🧑‍⚕️' : '📞') + '</div><div class="msg">Menunggu dijawab…</div></div>' +
      (call.type === 'video' ? '<video class="local" autoplay playsinline muted style="display:none"></video>' : '') +
      '<div class="audio"></div></div>' +
      '<div class="bar"><button class="hq-b" data-a="mic">🎤 Mikrofon aktif</button>' +
      (call.type === 'video' ? '<button class="hq-b" data-a="cam">📷 Kamera aktif</button>' : '') +
      '<button class="hq-b red" data-a="end">Akhiri</button></div>';
    document.body.appendChild(el);
    return el;
  }

  function setStatus(txt, msg) {
    if (!cur) return;
    var s = cur.ui.querySelector('.st'); if (s) s.textContent = txt;
    var m = cur.ui.querySelector('.msg'); if (m && msg !== undefined) m.textContent = msg;
  }

  function startTimer() {
    if (!cur || cur.timer) return;
    cur.joinedAt = Date.now();
    var ov = cur.ui.querySelector('.ov');
    if (cur.call.type === 'video') ov.style.display = 'none';
    cur.timer = setInterval(function () {
      if (!cur) return;
      var sec = Math.floor((Date.now() - cur.joinedAt) / 1000);
      var t = Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
      setStatus('Terhubung · ' + t, 'Terhubung · ' + t);
    }, 1000);
  }

  function cleanup(finalCall) {
    if (!cur) return;
    var c = cur;
    cur = null;
    clearInterval(c.timer);
    try { c.room && c.room.disconnect(); } catch (e) { /* abaikan */ }
    c.ui.remove();
    if (c.onEnd) { try { c.onEnd(finalCall || c.call, !!c.joinedAt); } catch (e) { console.error(e); } }
  }

  function join(connection, call, opts) {
    opts = opts || {};
    if (cur) return Promise.reject(new Error('Masih ada panggilan yang berjalan'));
    var title = opts.title || (call.type === 'video' ? 'Video call' : 'Telepon');
    var ui = buildUI(call, title);
    cur = { call: call, ui: ui, room: null, onEnd: opts.onEnd, joinedAt: 0, timer: null };

    var micOn = true, camOn = true;
    ui.querySelector('[data-a="end"]').onclick = function () {
      var id = call.id;
      HQ.api('/calls/' + id + '/end', { method: 'POST' }).catch(function () {});
      cleanup(Object.assign({}, call, { status: cur && cur.joinedAt ? 'ended' : 'cancelled' }));
    };
    var micBtn = ui.querySelector('[data-a="mic"]');
    micBtn.onclick = function () {
      if (!cur || !cur.room) return;
      micOn = !micOn;
      cur.room.localParticipant.setMicrophoneEnabled(micOn).catch(function () {});
      micBtn.textContent = '🎤 Mikrofon ' + (micOn ? 'aktif' : 'mati');
      micBtn.classList.toggle('off', !micOn);
    };
    var camBtn = ui.querySelector('[data-a="cam"]');
    if (camBtn) camBtn.onclick = function () {
      if (!cur || !cur.room) return;
      camOn = !camOn;
      cur.room.localParticipant.setCameraEnabled(camOn).catch(function () {});
      camBtn.textContent = '📷 Kamera ' + (camOn ? 'aktif' : 'mati');
      camBtn.classList.toggle('off', !camOn);
    };

    return liveKit().then(function (LK) {
      var room = new LK.Room({ adaptiveStream: true, dynacast: true });
      if (!cur) { return; } // dibatalkan selagi memuat
      cur.room = room;
      var remoteV = ui.querySelector('video.remote');
      var localV = ui.querySelector('video.local');
      var audioBox = ui.querySelector('.audio');

      room.on(LK.RoomEvent.TrackSubscribed, function (track) {
        if (track.kind === 'video') { track.attach(remoteV); remoteV.style.display = 'block'; }
        else { var a = track.attach(); audioBox.appendChild(a); }
        startTimer();
      });
      room.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
        track.detach().forEach(function (e) { if (e.tagName === 'AUDIO') e.remove(); });
        if (track.kind === 'video') remoteV.style.display = 'none';
      });
      room.on(LK.RoomEvent.LocalTrackPublished, function (pub) {
        if (localV && pub.source === LK.Track.Source.Camera && pub.track) { pub.track.attach(localV); localV.style.display = 'block'; }
      });
      room.on(LK.RoomEvent.ParticipantConnected, function () { startTimer(); });
      room.on(LK.RoomEvent.ParticipantDisconnected, function () {
        if (cur && room.remoteParticipants && room.remoteParticipants.size === 0) setStatus('Lawan bicara keluar', 'Lawan bicara meninggalkan panggilan');
      });
      room.on(LK.RoomEvent.AudioPlaybackStatusChanged, function () {
        if (!room.canPlaybackAudio) { var b = ui.querySelector('.msg'); if (b) b.textContent = 'Ketuk layar untuk mengaktifkan suara'; ui.addEventListener('click', function () { room.startAudio(); }, { once: true }); }
      });
      room.on(LK.RoomEvent.Disconnected, function () { if (cur && cur.room === room) cleanup(Object.assign({}, call, { status: cur.joinedAt ? 'ended' : call.status })); });

      return room.connect(connection.url, connection.token).then(function () {
        setStatus(opts.waiting ? 'Memanggil…' : 'Menghubungkan…', opts.waiting ? 'Menunggu dijawab…' : 'Menghubungkan…');
        if (room.remoteParticipants && room.remoteParticipants.size > 0) startTimer();
        return room.localParticipant.setMicrophoneEnabled(true).catch(function () { HQ.toast('Mikrofon tidak bisa diakses. Periksa izin browser.'); });
      }).then(function () {
        if (call.type === 'video') return room.localParticipant.setCameraEnabled(true).catch(function () { HQ.toast('Kamera tidak bisa diakses. Periksa izin browser.'); });
      });
    }).catch(function (e) {
      HQ.toast(e.message || 'Gagal memulai panggilan');
      HQ.api('/calls/' + call.id + '/end', { method: 'POST' }).catch(function () {});
      cleanup(Object.assign({}, call, { status: 'cancelled' }));
    });
  }

  /** Mulai panggilan. onEnd(call, answered:boolean) dipanggil saat selesai / ditolak / tak terjawab. */
  Calls.start = function (o) {
    if (cur || ringUI) { HQ.toast('Masih ada panggilan yang berjalan'); return Promise.resolve(); }
    var body = { type: o.type || 'video' };
    if (o.patientRm) body.patientRm = o.patientRm;
    return HQ.api('/calls', { method: 'POST', body: body }).then(function (r) {
      return join(r.connection, r.call, { waiting: true, title: o.title, onEnd: o.onEnd });
    }).catch(function (e) {
      HQ.toast(e.status === 503 ? 'Layanan panggilan (LiveKit) belum dikonfigurasi di server' : (e.message || 'Gagal memulai panggilan'));
      if (o.onEnd) o.onEnd({ status: 'cancelled' }, false);
    });
  };
  Calls.active = function () { return !!cur; };

  Calls.init = function (socket) {
    sock = socket;
    sock.on('call:incoming', function (p) {
      if (cur || ringUI) return; // sedang sibuk
      showRing(p);
    });
    sock.on('call:accepted', function (p) {
      if (cur && cur.call.id === p.call.id) { cur.call = p.call; setStatus('Terhubung', 'Panggilan dijawab. Menghubungkan…'); }
    });
    sock.on('call:declined', function (p) {
      if (cur && cur.call.id === p.call.id) { HQ.toast('Panggilan ditolak'); cleanup(p.call); }
    });
    sock.on('call:missed', function (p) {
      if (ringUI && ringUI.call.id === p.call.id) stopRing();
      if (cur && cur.call.id === p.call.id) { HQ.toast('Panggilan tidak dijawab'); cleanup(p.call); }
    });
    sock.on('call:taken', function (p) {
      // nakes lain sudah menjawab / pemanggil membatalkan: hentikan dering di sini
      if (ringUI && ringUI.call.id === p.call.id) stopRing();
    });
    sock.on('call:ended', function (p) {
      if (ringUI && ringUI.call.id === p.call.id) stopRing();
      if (cur && cur.call.id === p.call.id) cleanup(p.call);
    });
  };
})();
