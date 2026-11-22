/* ==========================================================================
   Sweet Budget — mobile companion for the "Home Sweet Budget" spreadsheet
   Vanilla JS, no build step. Talks to the Google Apps Script API (Code.gs).
   ========================================================================== */
'use strict';
(() => {
  const VERSION = '1.0.0';
  const API_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/exec$/;
  const DEMO = /[?&#]demo\b/.test(location.search + location.hash) || document.documentElement.dataset.demo === '1';
  const NS = DEMO ? 'hsbdemo.' : 'hsb.';

  /* ------------------------------------------------------------------ utils */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const HOUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-house"/></svg>';
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const mem = {};
  const safeStore = area => ({
    get(k, d) { try { const v = window[area].getItem(NS + k); return v == null ? d : JSON.parse(v); } catch (e) { return k in mem ? mem[k] : d; } },
    set(k, v) { try { window[area].setItem(NS + k, JSON.stringify(v)); } catch (e) { mem[k] = v; } },
    del(k) { try { window[area].removeItem(NS + k); } catch (e) { delete mem[k]; } },
  });
  const store = safeStore('localStorage');
  const sess = safeStore('sessionStorage');

  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const dayNum = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const todayIso = () => iso(today());

  const nfIDR = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const nfAUD = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfCompact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
  const nfPct = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
  const CUR_SYM = { IDR: 'Rp', AUD: 'A$' };
  function money(v, cur, o = {}) {
    const a = Math.abs(v);
    const body = o.compact ? nfCompact.format(a) : cur === 'IDR' ? nfIDR.format(Math.round(a)) : nfAUD.format(a);
    const s = CUR_SYM[cur] + ' ' + body;
    if (v < 0 && Math.round(a * 100) !== 0) return '−' + s;
    return o.sign && v > 0 ? '+' + s : s;
  }
  const fDayLong = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
  const fDayLongY = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fShort = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short' });
  const fShortY = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const fMonth = new Intl.DateTimeFormat('id-ID', { month: 'long', year: 'numeric' });
  const fMon = new Intl.DateTimeFormat('id-ID', { month: 'short' });
  const fDow = new Intl.DateTimeFormat('id-ID', { weekday: 'short' });

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /* ------------------------------------------------------------------ state */
  const DEFAULT_PREFS = { cur: 'IDR', lockMin: 5, lastAcc: {}, pinLen: 0 };
  const S = {
    cfg: store.get('cfg', null),
    meta: null, txs: [], cacheAt: 0,
    outbox: store.get('outbox', []),
    prefs: Object.assign({}, DEFAULT_PREFS, store.get('prefs', {})),
    pin: null, locked: true,
    view: 'home',
    period: { kind: 'month' },
    hist: { q: '', type: 'all', cat: '', from: '', to: '', limit: 60 },
    trend: 'daily',
    sync: 'idle', lastSync: 0, lastActive: Date.now(),
    installEvt: null, pairing: null, heroShown: null,
  };
  const cached = store.get('cache', null);
  if (cached && S.cfg) { S.meta = cached.meta; S.txs = cached.transactions || []; S.cacheAt = cached.at || 0; }
  const savePrefs = () => store.set('prefs', S.prefs);
  const saveOutbox = () => store.set('outbox', S.outbox);

  const TYPE = {
    expense: { label: 'Pengeluaran', sign: -1, color: 'var(--out)' },
    income: { label: 'Pemasukan', sign: 1, color: 'var(--in)' },
    savings: { label: 'Tabungan', sign: -1, color: 'var(--save)' },
    transfer_in: { label: 'Transfer masuk', sign: 1, color: 'var(--move)' },
    transfer_out: { label: 'Transfer keluar', sign: -1, color: 'var(--move)' },
    adjustment: { label: 'Koreksi saldo', sign: 1, color: 'var(--move)' },
    other: { label: 'Lainnya', sign: 0, color: 'var(--move)' },
    unknown: { label: 'Kategori tidak dikenal', sign: 0, color: 'var(--danger)' },
  };
  const TYPE_ICON = { expense: '🧾', income: '💰', savings: '🐷', transfer_in: '📥', transfer_out: '📤', adjustment: '🔧', other: '•', unknown: '❔' };
  // categorical slots, fixed order (validated palette); spending categories get them in Setup order
  const SLOTS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const OTHER_GREY = '#b4bacd';

  const cats = () => (S.meta ? S.meta.categories : []);
  const catByName = name => cats().find(c => c.name === name);
  const accs = () => (S.meta ? S.meta.accounts : []);
  const accByName = name => accs().find(a => a.name === name);
  function catColor(name) {
    const exp = cats().filter(c => c.type === 'expense');
    const i = exp.findIndex(c => c.name === name);
    if (i < 0 || i >= SLOTS.length || /^(others?|lainnya)$/i.test(name)) return OTHER_GREY;
    return SLOTS[i];
  }

  /* ------------------------------------------------------------ data helpers */
  function pendingTxs() {
    const out = [];
    S.outbox.forEach(op => {
      const base = { pending: true, opId: op.opId, failed: op.status === 'error', error: op.error };
      if (op.action === 'add') {
        const t = op.payload.tx; const c = catByName(t.category);
        out.push(Object.assign({}, base, t, { cur: t.currency, type: c ? c.type : 'unknown', row: Infinity }));
      } else if (op.action === 'transfer') {
        const t = op.payload.transfer;
        out.push(Object.assign({}, base, { date: t.date, description: t.description || 'Transfer ke ' + t.to, category: 'Transfer Out', amount: t.amountOut, cur: t.currencyOut, currency: t.currencyOut, account: t.from, type: 'transfer_out', row: Infinity }));
        out.push(Object.assign({}, base, { date: t.date, description: t.description || 'Transfer dari ' + t.from, category: 'Transfer In', amount: t.amountIn, cur: t.currencyIn, currency: t.currencyIn, account: t.to, type: 'transfer_in', row: Infinity, second: true }));
      }
    });
    return out;
  }
  const allTx = () => S.txs.concat(pendingTxs());
  const byRecent = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.row - a.row) || (a.second ? 1 : 0) - (b.second ? 1 : 0);
  function conv(t, cur) {
    if (t.cur === cur) return t.amount;
    const r = S.meta.rate || 1;
    return t.cur === 'AUD' ? t.amount * r : t.amount / r;
  }
  const inRange = (t, r) => t.date && t.date >= r.from && t.date <= r.to;
  function totals(list, cur) {
    const o = { income: 0, expense: 0, savings: 0, count: 0 };
    list.forEach(t => {
      if (t.type === 'income') o.income += conv(t, cur);
      else if (t.type === 'expense') o.expense += conv(t, cur);
      else if (t.type === 'savings') o.savings += conv(t, cur);
      if (t.type === 'income' || t.type === 'expense') o.count++;
    });
    return o;
  }
  function balances() {
    const start = S.meta.startDate; const rate = S.meta.rate || 1;
    return accs().map(a => {
      let bal = a.start || 0;
      allTx().forEach(t => {
        if (t.account !== a.name || t.failed) return;
        if (start && (!t.date || t.date < start)) return;
        const sg = { income: 1, transfer_in: 1, adjustment: 1, expense: -1, savings: -1, transfer_out: -1 }[t.type] || 0;
        if (!sg) return;
        const v = t.cur === a.currency ? t.amount : t.cur === 'AUD' ? t.amount * rate : t.amount / rate;
        bal += sg * v;
      });
      return Object.assign({}, a, { balance: bal });
    });
  }

  /* ---------------------------------------------------------------- periods */
  function periodRange(p) {
    const t = today();
    if (p.kind === 'today') return { from: iso(t), to: iso(t) };
    if (p.kind === 'week') { const mon = addDays(t, -((t.getDay() + 6) % 7)); return { from: iso(mon), to: iso(addDays(mon, 6)) }; }
    if (p.kind === 'month') return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(new Date(t.getFullYear(), t.getMonth() + 1, 0)) };
    return { from: p.from, to: p.to };
  }
  function elapsedEnd(r) { const t = todayIso(); return r.to < t ? r.to : r.from > t ? r.to : t; }
  function elapsedDays(r) { return dayNum(elapsedEnd(r)) - dayNum(r.from) + 1; }
  function prevRange(p, r) {
    const end = elapsedEnd(r);
    if (p.kind === 'today') { const y = iso(addDays(parseIso(r.from), -1)); return { from: y, to: y, label: 'kemarin' }; }
    if (p.kind === 'week') return { from: iso(addDays(parseIso(r.from), -7)), to: iso(addDays(parseIso(end), -7)), label: 'minggu lalu' };
    if (p.kind === 'month') {
      const f = parseIso(r.from); const e = parseIso(end);
      const pf = new Date(f.getFullYear(), f.getMonth() - 1, 1);
      const last = new Date(f.getFullYear(), f.getMonth(), 0).getDate();
      return { from: iso(pf), to: iso(new Date(pf.getFullYear(), pf.getMonth(), Math.min(e.getDate(), last))), label: 'bulan lalu' };
    }
    const len = dayNum(r.to) - dayNum(r.from) + 1;
    return { from: iso(addDays(parseIso(r.from), -len)), to: iso(addDays(parseIso(r.from), -1)), label: len + ' hari sebelumnya' };
  }
  function periodLabel(p, r) {
    if (p.kind === 'today') return fDayLong.format(parseIso(r.from));
    if (p.kind === 'week') return fShort.format(parseIso(r.from)) + ' – ' + fShort.format(parseIso(r.to));
    if (p.kind === 'month') return fMonth.format(parseIso(r.from));
    return r.from === r.to ? fShortY.format(parseIso(r.from)) : fShort.format(parseIso(r.from)) + ' – ' + fShortY.format(parseIso(r.to));
  }
  function dayLabel(s) {
    const t = todayIso();
    if (s === t) return 'Hari ini';
    if (s === iso(addDays(today(), -1))) return 'Kemarin';
    const d = parseIso(s);
    return d.getFullYear() === today().getFullYear() ? fDayLong.format(d) : fDayLongY.format(d);
  }

  /* --------------------------------------------------------------------- api */
  class NetError extends Error {}
  async function api(action, payload = {}) {
    if (DEMO) return Demo.handle(action, payload, S.pin);
    const body = JSON.stringify(Object.assign({ action, key: S.cfg.key, pin: S.pin }, payload));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let res;
    try {
      res = await fetch(S.cfg.api, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal, cache: 'no-store' });
    } catch (e) {
      throw new NetError(e.name === 'AbortError' ? 'Server terlalu lama merespons.' : 'Tidak ada koneksi internet.');
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new NetError('Server error (' + res.status + ').');
    try { return await res.json(); } catch (e) { throw new NetError('Balasan server tidak terbaca. Cek ulang deploy Apps Script.'); }
  }
  const AUTH_CODES = ['BAD_PIN', 'LOCKED', 'BAD_KEY', 'NOT_CONFIGURED'];
  function handleAuthError(res) {
    if (res.code === 'BAD_KEY' || res.code === 'NOT_CONFIGURED') { unpair(res.message); return; }
    lock(res.message);
  }
  function applyData(res) {
    S.meta = res.meta; S.txs = res.transactions || []; S.lastSync = Date.now(); S.cacheAt = Date.now();
    store.set('cache', { meta: S.meta, transactions: S.txs, at: S.cacheAt });
  }
  function setSync(state) {
    S.sync = state;
    const dot = $('.sync-dot');
    if (dot) { dot.className = 'sync-dot ' + (state === 'idle' ? '' : state); dot.title = SYNC_TEXT[state]; }
  }
  const SYNC_TEXT = { idle: 'Tersambung', busy: 'Menyinkronkan…', off: 'Offline', err: 'Ada masalah' };

  async function sync(opts = {}) {
    if (!S.pin || S.locked) return;
    setSync('busy');
    try {
      const res = await api('sync');
      if (res.ok) { applyData(res); setSync('idle'); renderMain(); }
      else if (AUTH_CODES.includes(res.code)) handleAuthError(res);
      else { setSync('err'); toast('err', res.message); }
    } catch (e) {
      setSync('off');
      if (!opts.silent) toast('warn', e.message + ' Menampilkan data terakhir.');
    }
    flushOutbox();
  }

  let flushing = false;
  async function flushOutbox() {
    if (flushing || S.locked || !S.outbox.some(o => o.status !== 'error')) return;
    flushing = true;
    try {
      for (const op of S.outbox.slice()) {
        if (op.status === 'error') continue;
        setSync('busy');
        let res;
        try { res = await api(op.action, Object.assign({ opId: op.opId }, op.payload)); }
        catch (e) {
          setSync('off');
          if (!op.warned) { op.warned = true; saveOutbox(); toast('warn', 'Belum terkirim: ' + e.message + ' Akan dikirim otomatis.'); }
          break;
        }
        if (res.ok) {
          S.outbox = S.outbox.filter(o => o.opId !== op.opId); saveOutbox();
          applyData(res);
          toast('ok', SAVED_TEXT[op.kind] || 'Tersimpan ke spreadsheet');
        } else if (AUTH_CODES.includes(res.code)) { handleAuthError(res); break; }
        else { op.status = 'error'; op.error = res.message; saveOutbox(); toast('err', 'Gagal menyimpan: ' + res.message); }
      }
    } finally {
      flushing = false;
      if (S.sync === 'busy') setSync('idle');
      if (!S.locked) renderMain();
    }
  }
  const SAVED_TEXT = { expense: 'Pengeluaran tersimpan', income: 'Pemasukan tersimpan', savings: 'Tabungan tersimpan', transfer: 'Transfer tersimpan' };

  /* ------------------------------------------------------- PIN & local check */
  async function pinVerifier(pin, saltHex) {
    if (!crypto.subtle) return null;
    const salt = saltHex ? Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
    const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, keyMat, 256);
    const hex = b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
    return { salt: hex(salt), hash: hex(bits) };
  }
  async function verifyLocal(pin) {
    const v = store.get('pinv', null);
    if (!v) return false;
    const r = await pinVerifier(pin, v.salt);
    return !!r && r.hash === v.hash;
  }
  function lock(msg) {
    S.pin = null; S.locked = true; sess.del('pin');
    closeAllSheets();
    renderGate({ mode: 'lock', msg });
  }
  let wantAdd = /[?&]add=1\b/.test(location.search);
  function unlockWith(pin, offline) {
    S.pin = pin; S.locked = false; S.lastActive = Date.now();
    sess.set('pin', { pin, at: Date.now() });
    renderApp();
    if (wantAdd) { wantAdd = false; setTimeout(() => openForm(), 300); }
    if (offline) toast('warn', 'Offline. Menampilkan data terakhir; transaksi baru akan dikirim nanti.');
  }
  function unpair(msg, wipeAll) {
    ['cfg', 'cache', 'pinv'].concat(wipeAll ? ['outbox'] : []).forEach(k => store.del(k));
    sess.del('pin');
    Object.assign(S, { cfg: null, meta: null, txs: [], pin: null, locked: true });
    if (wipeAll) S.outbox = [];
    closeAllSheets();
    renderGate({ mode: 'welcome', msg });
  }

  /* ------------------------------------------------------------------ pairing */
  function b64urlDecode(code) {
    let b = code.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const bin = atob(b);
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
  }
  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str); let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function parsePairCode(text) {
    const m = String(text || '').match(/pair=([A-Za-z0-9_-]{20,})/);
    const code = m ? m[1] : String(text || '').trim();
    const o = JSON.parse(b64urlDecode(code));
    if (!API_RE.test(o.u) || !/^[a-f0-9]{32,128}$/i.test(o.k)) throw new Error('bad');
    return { api: o.u, key: o.k, name: o.n || 'Home Sweet Budget' };
  }
  function pairLink() {
    const code = b64urlEncode(JSON.stringify({ v: 1, u: S.cfg.api, k: S.cfg.key, n: S.cfg.name }));
    return location.origin + location.pathname + '#pair=' + code;
  }

  /* -------------------------------------------------------------- gate views */
  const app = $('#app');
  let pinBuf = '';
  function renderGate(o) {
    document.body.classList.remove('has-nav');
    pinBuf = '';
    if (o.mode === 'welcome') {
      app.innerHTML = `
        <div class="gate">
          <div class="gate-mark">${HOUSE}</div>
          <h1>Sweet Budget</h1>
          <p class="lead">Catat pemasukan dan pengeluaran langsung ke spreadsheet Home Sweet Budget-mu.</p>
          ${o.msg ? `<div class="pin-msg">${esc(o.msg)}</div>` : ''}
          <div class="card-plain">
            <b>Hubungkan HP ini</b>
            <ol class="steps">
              <li>Di laptop, buka spreadsheet → menu <b>📱 Aplikasi HP</b> → <b>Hubungkan HP</b>.</li>
              <li>Scan QR yang muncul dengan kamera HP.</li>
            </ol>
            <p class="small muted" style="margin:12px 0 6px">Sudah menyalin link pairing? Tempel di sini:</p>
            <textarea class="input" id="pairText" rows="3" placeholder="Tempel link pairing" autocomplete="off" spellcheck="false"></textarea>
            <div class="err-text" id="pairErr"></div>
            <div class="two" style="margin-top:10px">
              <button class="btn" id="pastePair">Tempel</button>
              <button class="btn primary" id="usePair">Hubungkan</button>
            </div>
          </div>
          <p class="hint">Mau lihat dulu? <a href="?demo" style="color:var(--blue);font-weight:700">Coba mode demo</a></p>
        </div>`;
      const use = text => {
        try { startPairing(parsePairCode(text)); }
        catch (e) { $('#pairErr').textContent = 'Link pairing tidak valid. Salin ulang dari spreadsheet.'; }
      };
      $('#usePair').onclick = () => use($('#pairText').value);
      $('#pastePair').onclick = async () => {
        try { const t = await navigator.clipboard.readText(); $('#pairText').value = t; use(t); }
        catch (e) { $('#pairText').focus(); $('#pairErr').textContent = 'Tekan lama kotak di atas lalu pilih Tempel.'; }
      };
      return;
    }
    const pairing = o.mode === 'pair';
    const title = pairing ? 'Hubungkan HP' : 'Masukkan PIN';
    const lead = pairing ? `Spreadsheet: <b>${esc(S.pairing.name)}</b><br>Masukkan PIN yang kamu buat di spreadsheet.` : esc((S.cfg && S.cfg.name) || 'Home Sweet Budget');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
    app.innerHTML = `
      <div class="gate">
        <div class="gate-mark">${HOUSE}</div>
        <h1>${title}</h1>
        <p class="lead">${lead}</p>
        <div class="pin-dots" id="dots" aria-hidden="true"></div>
        <div class="pin-msg" id="pinMsg" role="alert">${esc(o.msg || '')}</div>
        ${DEMO ? '<p class="hint" style="margin-top:0">Mode demo: PIN 123456</p>' : ''}
        <div class="keypad" id="keypad">
          ${keys.map(k => k === 'del' ? `<button class="ghost" data-k="del" aria-label="Hapus">${svg('back')}</button>`
            : k === 'ok' ? `<button class="ghost" data-k="ok">OK</button>` : `<button data-k="${k}">${k}</button>`).join('')}
        </div>
        <p class="hint">${pairing ? '<a href="./" style="color:var(--ink-3)">Batal</a>' : 'Lupa PIN? Buat PIN baru di spreadsheet: menu 📱 Aplikasi HP → Hubungkan HP.'}</p>
      </div>`;
    drawDots();
    $('#keypad').onclick = e => { const b = e.target.closest('button'); if (b) pinKey(b.dataset.k, pairing); };
  }
  function drawDots() {
    const d = $('#dots'); if (!d) return;
    const n = Math.max(S.prefs.pinLen || 4, pinBuf.length, 4);
    d.innerHTML = Array.from({ length: Math.min(n, 8) }, (_, i) => `<i class="${i < pinBuf.length ? 'on' : ''}"></i>`).join('');
  }
  let pinBusy = false;
  function pinKey(k, pairing) {
    if (pinBusy) return;
    const msg = $('#pinMsg');
    if (k === 'del') pinBuf = pinBuf.slice(0, -1);
    else if (k === 'ok') { if (pinBuf.length >= 4) submitPin(pairing); else if (msg) msg.textContent = 'PIN minimal 4 angka.'; return; }
    else if (pinBuf.length < 8) pinBuf += k;
    if (msg && k !== 'ok') msg.textContent = '';
    drawDots();
    if (!pairing && S.prefs.pinLen && pinBuf.length === S.prefs.pinLen) submitPin(false);
  }
  async function submitPin(pairing) {
    const pin = pinBuf; pinBusy = true;
    const msg = $('#pinMsg'); msg.innerHTML = '<span class="muted">Memeriksa…</span>';
    if (pairing) S.cfg = S.pairing;
    S.pin = pin;
    try {
      const res = await api('sync');
      if (res.ok) {
        if (pairing) { store.set('cfg', S.cfg); S.pairing = null; try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } }
        applyData(res);
        S.prefs.pinLen = pin.length; savePrefs(); pinFails = 0;
        pinVerifier(pin).then(v => v && store.set('pinv', v));
        pinBusy = false;
        unlockWith(pin);
        flushOutbox();
        if (pairing) setTimeout(() => openInstall(true), 450);
        return;
      }
      if (pairing && (res.code === 'BAD_KEY' || res.code === 'NOT_CONFIGURED')) { S.cfg = null; failPin(res.message); return; }
      if (pairing) S.cfg = null;
      if (res.code === 'BAD_KEY' || res.code === 'NOT_CONFIGURED') { pinBusy = false; unpair(res.message); return; }
      failPin(res.message || 'PIN salah.');
    } catch (e) {
      if (pairing) { S.cfg = null; failPin(e.message); return; }
      if (await verifyLocal(pin)) { pinBusy = false; unlockWith(pin, true); return; }
      failPin(e.message);
    }
  }
  let pinFails = 0;
  function failPin(text) {
    pinBusy = false; pinBuf = ''; S.pin = null;
    if (++pinFails >= 2 && S.prefs.pinLen) { S.prefs.pinLen = 0; savePrefs(); }
    const msg = $('#pinMsg'); if (msg) msg.textContent = text;
    const d = $('#dots'); if (d) { d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); }
    navigator.vibrate && navigator.vibrate([30, 40, 30]);
    drawDots();
  }
  function startPairing(p) {
    S.pairing = p;
    renderGate({ mode: 'pair' });
  }

  /* -------------------------------------------------------------- app shell */
  function renderApp() {
    if (!S.cfg) return renderGate({ mode: 'welcome' });
    if (S.locked) return renderGate({ mode: 'lock' });
    document.body.classList.add('has-nav');
    app.innerHTML = `<header class="topbar" id="topbar"></header><main class="view" id="view"></main>${navHtml()}`;
    $('.nav').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.go === 'add') return openForm();
      go(b.dataset.go);
    };
    renderMain();
  }
  function navHtml() {
    const item = (id, ic, label) => `<button data-go="${id}" ${S.view === id ? 'aria-current="page"' : ''}>${svg(ic)}<span>${label}</span></button>`;
    return `<nav class="nav" aria-label="Navigasi utama">
      ${item('home', 'home', 'Beranda')}${item('charts', 'chart', 'Grafik')}
      <div class="fab-wrap"><button class="fab" data-go="add" aria-label="Tambah transaksi">${svg('plus')}</button></div>
      ${item('history', 'list', 'Riwayat')}${item('settings', 'gear', 'Atur')}</nav>`;
  }
  function go(view) {
    if (view === S.view) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    S.view = view;
    $$('.nav button[data-go]').forEach(b => b.toggleAttribute('aria-current', b.dataset.go === view));
    $$('.nav button[aria-current]').forEach(b => b.setAttribute('aria-current', 'page'));
    window.scrollTo(0, 0);
    renderMain(true);
  }
  function renderMain(anim) {
    const view = $('#view'); if (!view || S.locked) return;
    renderTopbar();
    if (anim) { view.style.animation = 'none'; void view.offsetWidth; view.style.animation = ''; }
    if (!S.meta) { view.innerHTML = skeleton(); return; }
    ({ home: viewHome, charts: viewCharts, history: viewHistory, settings: viewSettings })[S.view](view);
  }
  function renderTopbar() {
    const tb = $('#topbar'); if (!tb) return;
    const withPeriod = S.view === 'home' || S.view === 'charts';
    const withCur = withPeriod;
    const p = S.period;
    const chip = (k, label) => `<button class="chip" data-p="${k}" aria-pressed="${p.kind === k}">${label}</button>`;
    let customLabel = 'Pilih tanggal';
    if (p.kind === 'custom') customLabel = periodLabel(p, periodRange(p));
    const title = { history: 'Riwayat', settings: 'Pengaturan' }[S.view];
    tb.innerHTML = `
      <div class="topbar-row">
        <div class="brand"><span class="brand-mark">${HOUSE}</span>${title || 'Sweet Budget'}<span class="sync-dot ${S.sync === 'idle' ? '' : S.sync}" title="${SYNC_TEXT[S.sync]}"></span></div>
        <div class="spacer"></div>
        ${withCur ? `<div class="cur-toggle" role="group" aria-label="Tampilkan dalam">
          <button data-cur="IDR" aria-pressed="${S.prefs.cur === 'IDR'}">Rp</button><button data-cur="AUD" aria-pressed="${S.prefs.cur === 'AUD'}">A$</button></div>`
          : `<button class="icon-btn" id="refreshBtn" aria-label="Muat ulang data">${svg('refresh')}</button>`}
      </div>
      ${withPeriod ? `<div class="chips" role="group" aria-label="Periode">
        ${chip('today', 'Hari ini')}${chip('week', 'Minggu ini')}${chip('month', 'Bulan ini')}${chip('custom', esc(customLabel))}</div>` : ''}`;
    tb.onclick = e => {
      const c = e.target.closest('[data-cur]');
      if (c) { S.prefs.cur = c.dataset.cur; savePrefs(); renderMain(); return; }
      const pb = e.target.closest('[data-p]');
      if (pb) { if (pb.dataset.p === 'custom') openCustomPeriod(); else { S.period = { kind: pb.dataset.p }; renderMain(); } return; }
      if (e.target.closest('#refreshBtn')) sync();
    };
  }
  function skeleton() {
    return `<div class="skel" style="height:196px;border-radius:28px;margin-top:6px"></div>
      <div class="tiles"><div class="skel" style="height:96px"></div><div class="skel" style="height:96px"></div></div>
      <div class="skel" style="height:60px;margin-top:26px"></div><div class="skel" style="height:60px;margin-top:8px"></div>`;
  }

  /* ---------------------------------------------------------------- home */
  function viewHome(view) {
    const cur = S.prefs.cur; const r = periodRange(S.period);
    const list = allTx().filter(t => inRange(t, r) && !t.failed);
    const tot = totals(list, cur);
    const net = tot.income - tot.expense;
    const warn = (S.meta.warnings || []).length ? `<div class="offline-banner">⚠ ${esc(S.meta.warnings.join(' '))}</div>` : '';
    view.innerHTML = `
      ${warn}
      <section class="hero" aria-label="Ringkasan periode">
        <div class="aurora"></div>
        <div class="hero-glass">
          <div class="hero-label"><span>Saldo bersih</span><span>${esc(periodLabel(S.period, r))}</span></div>
          <div class="hero-amount num" id="heroAmt">${heroHtml(net, cur)}</div>
          <div class="hero-stats">
            <div class="hero-stat"><div class="k"><span class="dot" style="background:var(--in)"></span>Pemasukan</div><div class="v num">${money(tot.income, cur)}</div></div>
            <div class="hero-stat"><div class="k"><span class="dot" style="background:var(--out)"></span>Pengeluaran</div><div class="v num">${money(tot.expense, cur)}</div></div>
          </div>
          ${tot.savings ? `<div class="hero-foot"><span>Ditabung ${money(tot.savings, cur)}</span><span>Sisa ${money(net - tot.savings, cur)}</span></div>` : ''}
        </div>
      </section>
      ${insightsHtml(list, tot, r, cur)}
      ${balancesHtml(cur)}
      <div class="section-title"><h2>Transaksi terbaru</h2><button class="link" data-go="history">Lihat semua</button></div>
      ${recentHtml()}`;
    animateHero(net, cur);
    view.onclick = e => {
      const g = e.target.closest('[data-go]'); if (g) return go(g.dataset.go);
      const tx = e.target.closest('[data-tx]'); if (tx) return openDetail(tx.dataset.tx);
      if (e.target.closest('[data-add]')) openForm();
    };
  }
  function heroHtml(v, cur) {
    const s = money(v, cur); const i = s.indexOf(CUR_SYM[cur]);
    return esc(s.slice(0, i)) + `<span class="cur">${CUR_SYM[cur]}</span>` + esc(s.slice(i + CUR_SYM[cur].length + 1));
  }
  function animateHero(target, cur) {
    const el = $('#heroAmt'); const key = cur + '|' + S.period.kind;
    const prev = S.heroShown && S.heroShown.key === key ? S.heroShown.v : null;
    S.heroShown = { key, v: target };
    if (prev === null || prev === target || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now(), dur = 650;
    const step = now => {
      const k = Math.min((now - t0) / dur, 1); const e = 1 - Math.pow(1 - k, 3);
      if (!el.isConnected) return;
      el.innerHTML = heroHtml(prev + (target - prev) * e, cur);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function insightsHtml(list, tot, r, cur) {
    const exp = list.filter(t => t.type === 'expense');
    if (!list.length) {
      return `<div class="box" style="margin-top:12px">${emptyHtml('Belum ada transaksi di periode ini', 'Ketuk + untuk mencatat pemasukan atau pengeluaran pertamamu.', true)}</div>`;
    }
    const byCat = groupSum(exp, t => t.category, cur);
    const top = byCat[0];
    const days = elapsedDays(r);
    const avg = tot.expense / Math.max(days, 1);
    const pr = prevRange(S.period, r);
    const prevExp = totals(allTx().filter(t => inRange(t, pr) && !t.failed), cur).expense;
    let compare;
    if (!prevExp && !tot.expense) compare = 'Belum ada pengeluaran di periode ini dan ' + pr.label + '.';
    else if (!prevExp) compare = 'Belum ada pengeluaran ' + pr.label + ' untuk dibandingkan.';
    else {
      const ch = (tot.expense - prevExp) / prevExp * 100;
      const dir = Math.abs(ch) < 1 ? 'same' : ch < 0 ? 'down' : 'up';
      compare = dir === 'same' ? `Pengeluaranmu sama dengan ${pr.label} (${money(prevExp, cur)}).`
        : `<span class="trend ${dir}">${dir === 'down' ? '↓' : '↑'} ${nfPct.format(Math.abs(ch))}%</span> ${dir === 'down' ? 'lebih hemat' : 'lebih boros'} dari ${pr.label} pada rentang hari yang sama (${money(prevExp, cur)}).`;
    }
    const biggest = exp.slice().sort((a, b) => conv(b, cur) - conv(a, cur))[0];
    let budget = '';
    if (S.period.kind === 'month') {
      const b = cats().filter(c => c.type === 'expense' && c.budget > 0).reduce((s, c) => s + c.budget, 0);
      if (b > 0) {
        const bCur = cur === 'AUD' ? b : b * S.meta.rate;
        const used = tot.expense / bCur * 100;
        budget = `<div class="tile wide"><div class="badge-ico">🎯</div><div><div class="k">Anggaran bulan ini</div>
          <div class="s" style="padding:2px 0 0;font-size:14px"><b class="num">${nfPct.format(used)}%</b> terpakai: ${money(tot.expense, cur)} dari ${money(bCur, cur)}</div></div></div>`;
      }
    }
    return `<div class="tiles">
      <div class="tile"><div class="k">Kategori terbesar</div>
        ${top ? `<div class="v">${esc((catByName(top.key) || {}).icon || '')} ${esc(top.key)}</div><div class="s num">${money(top.sum, cur)}, ${nfPct.format(top.sum / tot.expense * 100)}% dari pengeluaran</div>`
          : '<div class="v">—</div><div class="s">Belum ada pengeluaran</div>'}</div>
      <div class="tile"><div class="k">Rata-rata harian</div><div class="v num">${money(avg, cur)}</div><div class="s">Pengeluaran per hari, dari ${days} hari</div></div>
      <div class="tile wide"><div class="badge-ico">📊</div><div><div class="k">Dibanding ${esc(pr.label)}</div><div class="s" style="padding:2px 0 0;font-size:14px">${compare}</div></div></div>
      ${budget}
      <div class="tile"><div class="k">Pengeluaran terbesar</div>
        ${biggest ? `<div class="v num">${money(conv(biggest, cur), cur)}</div><div class="s">${esc(biggest.description || biggest.category)}, ${esc(fShort.format(parseIso(biggest.date)))}</div>` : '<div class="v">—</div><div class="s">Belum ada pengeluaran</div>'}</div>
      <div class="tile"><div class="k">Jumlah transaksi</div><div class="v num">${tot.count}</div><div class="s">${exp.length} pengeluaran, ${tot.count - exp.length} pemasukan</div></div>
    </div>`;
  }
  function groupSum(list, keyFn, cur) {
    const m = new Map();
    list.forEach(t => { const k = keyFn(t) || 'Tanpa kategori'; m.set(k, (m.get(k) || 0) + conv(t, cur)); });
    return Array.from(m, ([key, sum]) => ({ key, sum })).sort((a, b) => b.sum - a.sum);
  }
  function balancesHtml(cur) {
    if (!accs().length) return '';
    const list = balances();
    const total = list.reduce((s, a) => s + (a.currency === cur ? a.balance : a.currency === 'AUD' ? a.balance * S.meta.rate : a.balance / S.meta.rate), 0);
    const since = S.meta.startDate ? 'Dihitung sejak ' + fShortY.format(parseIso(S.meta.startDate)) : 'Dihitung dari semua transaksi';
    return `<div class="section-title"><h2>Saldo rekening</h2><span class="small muted num">Total ${money(total, cur)}</span></div>
      <div class="box">${list.map(a => `
        <div class="row"><div class="ico">${esc(a.icon || '🏦')}</div>
          <div class="main"><div class="t">${esc(a.name)}</div><div class="st">${a.currency}</div></div>
          <div class="amt num">${money(a.balance, a.currency)}</div></div>`).join('')}
      </div><p class="small muted" style="margin:8px 4px 0">${since}. Saldo awal diatur di tab Setup.</p>`;
  }
  function recentHtml() {
    const list = allTx().sort(byRecent).slice(0, 5);
    if (!list.length) return `<div class="box">${emptyHtml('Belum ada transaksi', 'Transaksi yang kamu catat akan muncul di sini.', false)}</div>`;
    return `<div class="box">${list.map(txRow).join('')}</div>`;
  }
  function emptyHtml(title, text, cta) {
    return `<div class="empty">
      <svg viewBox="0 0 120 96" aria-hidden="true"><defs><linearGradient id="eg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#4f6bff"/><stop offset="1" stop-color="#9f5cf6"/></linearGradient></defs>
        <ellipse cx="60" cy="86" rx="40" ry="6" fill="#eef0f8"/><path d="M26 44 60 16l34 28v38H26z" fill="#f5f6fb" stroke="#e7e9f2" stroke-width="2"/>
        <path d="M20 46 60 13l40 33" fill="none" stroke="url(#eg)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="51" y="58" width="18" height="24" rx="3" fill="#fff" stroke="#e7e9f2" stroke-width="2"/><circle cx="88" cy="28" r="9" fill="#22d3c5" opacity=".25"/><circle cx="88" cy="28" r="4" fill="#22d3c5"/></svg>
      <h3>${esc(title)}</h3><p>${esc(text)}</p>${cta ? `<button class="btn primary" data-add>${svg('plus', '')}Tambah transaksi</button>` : ''}</div>`;
  }

  /* ------------------------------------------------------------- tx rows */
  function txKey(t) { return t.pending ? 'op:' + t.opId + (t.second ? ':2' : '') : 'row:' + t.row; }
  function signOf(t) {
    if (t.type === 'adjustment') return t.amount >= 0 ? 1 : -1;
    if (t.type === 'savings') return t.amount < 0 ? 1 : -1;
    return (TYPE[t.type] || TYPE.other).sign;
  }
  function txRow(t) {
    const c = catByName(t.category);
    const ico = (c && c.icon) || TYPE_ICON[t.type] || '•';
    const title = t.description || t.category || 'Tanpa kategori';
    const sub = t.description ? t.category : (TYPE[t.type] || TYPE.other).label;
    const sg = signOf(t);
    const amt = money(sg === 0 ? t.amount : sg * Math.abs(t.amount), t.cur, { sign: sg > 0 });
    const pill = t.failed ? '<span class="pill fail">Gagal</span>' : t.pending ? '<span class="pill wait">Menunggu</span>' : '';
    return `<button class="row" data-tx="${esc(txKey(t))}">
      <div class="ico">${esc(ico)}<span class="tag" style="background:${(TYPE[t.type] || TYPE.other).color}"></span></div>
      <div class="main"><div class="t">${esc(title)}${pill}</div><div class="st">${esc(sub)}</div></div>
      <div class="amt num ${sg > 0 ? 'in' : ''}">${amt}<span class="sub">${esc(t.account || '')}</span></div></button>`;
  }
  const findTx = key => allTx().find(t => txKey(t) === key);

  /* -------------------------------------------------------------- charts */
  function viewCharts(view) {
    const cur = S.prefs.cur; const r = periodRange(S.period);
    const list = allTx().filter(t => inRange(t, r) && !t.failed);
    const exp = list.filter(t => t.type === 'expense');
    const total = exp.reduce((s, t) => s + conv(t, cur), 0);
    const groups = groupSum(exp, t => t.category, cur);
    const max = groups.length ? groups[0].sum : 0;
    const catCard = !groups.length ? emptyHtml('Belum ada pengeluaran', 'Grafik per kategori muncul setelah ada pengeluaran di periode ini.', false) : `
      <div class="stackbar" role="img" aria-label="Porsi pengeluaran per kategori">${groups.map(g => `<span style="flex:${g.sum};background:${catColor(g.key)}" title="${esc(g.key)}"></span>`).join('')}</div>
      ${groups.map(g => `<div class="catrow">
        <div class="e">${esc((catByName(g.key) || {}).icon || '•')}</div>
        <div class="n"><span class="dot" style="background:${catColor(g.key)}"></span><b>${esc(g.key)}</b> <span class="pct">${nfPct.format(g.sum / total * 100)}%</span></div>
        <div class="a num">${money(g.sum, cur)}</div>
        <div class="bar"><i style="width:${(g.sum / max * 100).toFixed(1)}%;background:${catColor(g.key)}"></i></div></div>`).join('')}`;
    view.innerHTML = `
      <section class="card"><div class="card-head"><div><h3>Pengeluaran per kategori</h3><div class="sub">${esc(periodLabel(S.period, r))}, total <span class="num">${money(total, cur)}</span></div></div></div>${catCard}</section>
      <section class="card"><div class="card-head"><div><h3>Tren pengeluaran</h3><div class="sub" id="trendSub"></div></div>
        <div class="mini-seg" role="group" aria-label="Skala tren"><button data-trend="daily" aria-pressed="${S.trend === 'daily'}">Harian</button><button data-trend="monthly" aria-pressed="${S.trend === 'monthly'}">Bulanan</button></div></div>
        <div class="chart" id="trendChart"></div></section>
      <section class="card"><div class="card-head"><div><h3>Pemasukan vs pengeluaran</h3><div class="sub">6 bulan terakhir</div></div></div>
        <div class="chart" id="ioChart"></div>
        <div class="legend"><span><i class="dot" style="background:var(--in)"></i>Pemasukan</span><span><i class="dot" style="background:var(--out)"></i>Pengeluaran</span></div></section>`;
    view.querySelector('.mini-seg').onclick = e => { const b = e.target.closest('[data-trend]'); if (b) { S.trend = b.dataset.trend; renderMain(); } };
    drawTrend(r, cur); drawIO(r, cur);
  }
  function monthsBack(endIso, n) {
    const e = parseIso(endIso); const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const f = new Date(e.getFullYear(), e.getMonth() - i, 1);
      out.push({ from: iso(f), to: iso(new Date(f.getFullYear(), f.getMonth() + 1, 0)), label: fMon.format(f) });
    }
    return out;
  }
  function drawTrend(r, cur) {
    const all = allTx().filter(t => !t.failed && t.type === 'expense');
    let labels = [], vals = [], tips = [], sub;
    if (S.trend === 'monthly') {
      const ms = monthsBack(r.to < todayIso() ? r.to : todayIso(), 6);
      ms.forEach(m => { labels.push(m.label); tips.push(fMonth.format(parseIso(m.from))); vals.push(all.filter(t => inRange(t, m)).reduce((s, t) => s + conv(t, cur), 0)); });
      sub = '6 bulan terakhir';
    } else {
      let from = r.from, to = r.to;
      if (S.period.kind === 'today') { from = iso(addDays(parseIso(r.to), -6)); sub = '7 hari terakhir'; }
      else sub = periodLabel(S.period, r);
      const n = dayNum(to) - dayNum(from) + 1;
      if (n > 62) { S.trend = 'monthly'; renderMain(); return; }
      const sums = {}; all.forEach(t => { if (t.date >= from && t.date <= to) sums[t.date] = (sums[t.date] || 0) + conv(t, cur); });
      for (let i = 0; i < n; i++) {
        const d = addDays(parseIso(from), i); const k = iso(d);
        labels.push(n <= 7 ? fDow.format(d) : String(d.getDate())); tips.push(fDayLong.format(d)); vals.push(sums[k] || 0);
      }
    }
    $('#trendSub').textContent = sub;
    barChart($('#trendChart'), { labels, tips, cur, series: [{ name: 'Pengeluaran', color: '#4f6bff', values: vals }] });
  }
  function drawIO(r, cur) {
    const ms = monthsBack(r.to < todayIso() ? r.to : todayIso(), 6);
    const all = allTx().filter(t => !t.failed);
    const inc = [], out = [];
    ms.forEach(m => { const tt = totals(all.filter(t => inRange(t, m)), cur); inc.push(tt.income); out.push(tt.expense); });
    barChart($('#ioChart'), { labels: ms.map(m => m.label), tips: ms.map(m => fMonth.format(parseIso(m.from))), cur,
      series: [{ name: 'Pemasukan', color: '#1baf7a', values: inc }, { name: 'Pengeluaran', color: '#eb6834', values: out }] });
  }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))); const f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function barChart(el, o) {
    const W = Math.max(el.clientWidth || 300, 240), H = 176, pl = 44, pr = 4, pt = 10, pb = 22;
    const n = o.labels.length, ns = o.series.length;
    const rawMax = Math.max(0, ...o.series.flatMap(s => s.values));
    if (rawMax <= 0) { el.innerHTML = '<p class="small muted" style="text-align:center;padding:48px 0">Belum ada data di rentang ini.</p>'; return; }
    const max = niceMax(rawMax);
    const pw = W - pl - pr, ph = H - pt - pb, gw = pw / n;
    const inner = Math.min(gw * 0.72, ns === 1 ? 26 : 36);
    const bw = Math.max((inner - (ns - 1) * 2) / ns, 2);
    const y = v => pt + ph - (v / max) * ph;
    const rad = Math.min(4, bw / 2);
    const barPath = (x, v) => {
      const h = (v / max) * ph; if (h <= 0.5) return '';
      const r2 = Math.min(rad, h); const yt = pt + ph - h, yb = pt + ph;
      return `M${x},${yb}V${yt + r2}Q${x},${yt} ${x + r2},${yt}H${x + bw - r2}Q${x + bw},${yt} ${x + bw},${yt + r2}V${yb}Z`;
    };
    const every = Math.ceil(n / Math.max(Math.floor(pw / 30), 1));
    let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(o.series.map(x => x.name).join(' dan '))}">`;
    [0, 0.5, 1].forEach(k => {
      const v = max * k, yy = y(v).toFixed(1);
      s += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}"/><text class="axis" x="${pl - 6}" y="${(+yy + 3.5).toFixed(1)}" text-anchor="end">${v === 0 ? '0' : nfCompact.format(v)}</text>`;
    });
    for (let i = 0; i < n; i++) {
      const gx = pl + i * gw + (gw - inner) / 2;
      s += `<g data-i="${i}">`;
      o.series.forEach((se, j) => { const d = barPath(gx + j * (bw + 2), se.values[i]); if (d) s += `<path d="${d}" fill="${se.color}"/>`; });
      s += `</g>`;
      if (i % every === 0 || i === n - 1 && n <= 12) s += `<text class="axis" x="${(pl + i * gw + gw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(o.labels[i])}</text>`;
      s += `<rect class="hit" data-hit="${i}" x="${(pl + i * gw).toFixed(1)}" y="${pt}" width="${gw.toFixed(1)}" height="${ph + pb}"/>`;
    }
    s += '</svg>';
    el.innerHTML = s;
    const tip = document.createElement('div'); tip.className = 'tip hidden'; el.appendChild(tip);
    const show = i => {
      $$('g[data-i]', el).forEach(g => g.classList.toggle('bar-active', +g.dataset.i !== i));
      tip.innerHTML = `<b>${esc(o.tips[i])}</b>` + o.series.map(se => `<div class="r"><i class="dot" style="background:${se.color}"></i>${esc(se.name)}: <b class="num">${money(se.values[i], o.cur)}</b></div>`).join('');
      tip.classList.remove('hidden');
      const cx = (pl + i * gw + gw / 2) / W * el.clientWidth;
      const top = Math.min(...o.series.map(se => y(se.values[i]))) / H * el.clientHeight;
      const half = tip.offsetWidth / 2 + 2;
      tip.style.left = Math.min(Math.max(cx, half), el.clientWidth - half) + 'px';
      tip.style.top = Math.max(top, 40) + 'px';
    };
    const hide = () => { tip.classList.add('hidden'); $$('g[data-i]', el).forEach(g => g.classList.remove('bar-active')); };
    el.onpointermove = el.onpointerdown = e => { const h = e.target.closest('[data-hit]'); if (h) show(+h.dataset.hit); };
    el.onpointerleave = hide;
    el.hideTip = hide;
  }

  document.addEventListener('pointerdown', e => {
    $$('.chart').forEach(c => { if (c.hideTip && !c.contains(e.target)) c.hideTip(); });
  }, { passive: true });

  /* ------------------------------------------------------------- history */
  const TYPE_FILTERS = [['all', 'Semua'], ['expense', 'Keluar'], ['income', 'Masuk'], ['savings', 'Nabung'], ['transfer', 'Transfer']];
  function viewHistory(view) {
    const h = S.hist;
    const nf = (h.cat ? 1 : 0) + (h.from || h.to ? 1 : 0);
    view.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        <label class="search" style="flex:1">${svg('search')}<span class="sr">Cari</span><input id="hq" type="search" placeholder="Cari catatan, kategori, rekening" value="${esc(h.q)}" autocomplete="off"></label>
        <button class="icon-btn filter-btn" id="hf" aria-label="Filter" style="width:46px;height:46px;border-radius:14px">${svg('filter')}${nf ? `<span class="count">${nf}</span>` : ''}</button>
      </div>
      <div class="chips" role="group" aria-label="Jenis">${TYPE_FILTERS.map(([k, l]) => `<button class="chip soft" data-ht="${k}" aria-pressed="${h.type === k}">${l}</button>`).join('')}</div>
      <div class="active-filters">${h.cat ? `<button data-clear="cat">${esc(h.cat)} ✕</button>` : ''}${h.from || h.to ? `<button data-clear="date">${esc(rangeText(h.from, h.to))} ✕</button>` : ''}</div>
      <div id="hlist"></div>`;
    $('#hq').oninput = e => { h.q = e.target.value; h.limit = 60; renderHistoryList(); };
    view.onclick = e => {
      const t = e.target.closest('[data-ht]'); if (t) { h.type = t.dataset.ht; h.limit = 60; return renderMain(); }
      const c = e.target.closest('[data-clear]'); if (c) { if (c.dataset.clear === 'cat') h.cat = ''; else { h.from = ''; h.to = ''; } return renderMain(); }
      if (e.target.closest('#hf')) return openHistFilter();
      const tx = e.target.closest('[data-tx]'); if (tx) return openDetail(tx.dataset.tx);
      if (e.target.closest('#more')) { h.limit += 60; renderHistoryList(); }
      if (e.target.closest('[data-add]')) openForm();
    };
    renderHistoryList();
  }
  function rangeText(a, b) {
    if (a && b) return fShort.format(parseIso(a)) + ' – ' + fShortY.format(parseIso(b));
    return a ? 'Sejak ' + fShortY.format(parseIso(a)) : 'Sampai ' + fShortY.format(parseIso(b));
  }
  function renderHistoryList() {
    const h = S.hist; const q = h.q.trim().toLowerCase();
    const list = allTx().filter(t => {
      if (h.type === 'transfer' ? !/^transfer/.test(t.type) : h.type !== 'all' && t.type !== h.type) return false;
      if (h.cat && t.category !== h.cat) return false;
      if (h.from && (!t.date || t.date < h.from)) return false;
      if (h.to && (!t.date || t.date > h.to)) return false;
      if (q && ![t.description, t.category, t.account].some(x => String(x || '').toLowerCase().includes(q))) return false;
      return true;
    }).sort(byRecent);
    const el = $('#hlist'); if (!el) return;
    if (!list.length) {
      const filtered = q || h.cat || h.from || h.to || h.type !== 'all';
      el.innerHTML = `<div class="box" style="margin-top:14px">${filtered ? emptyHtml('Tidak ada yang cocok', 'Coba kata kunci lain atau hapus filter.', false) : emptyHtml('Belum ada transaksi', 'Ketuk + untuk mencatat transaksi pertamamu.', true)}</div>`;
      return;
    }
    const shown = list.slice(0, h.limit);
    let html = '', day = null, buf = [];
    const flush = () => {
      if (!buf.length) return;
      const net = buf.reduce((s, t) => s + (t.type === 'income' ? conv(t, S.prefs.cur) : t.type === 'expense' ? -conv(t, S.prefs.cur) : 0), 0);
      html += `<div class="day-head"><span>${day ? esc(dayLabel(day)) : 'Tanpa tanggal'}</span><span class="num">${net ? money(net, S.prefs.cur, { sign: true }) : ''}</span></div><div class="box">${buf.map(txRow).join('')}</div>`;
      buf = [];
    };
    shown.forEach(t => { if (t.date !== day) { flush(); day = t.date; } buf.push(t); });
    flush();
    if (list.length > shown.length) html += `<button class="btn block" id="more" style="margin-top:14px">Tampilkan lagi (${list.length - shown.length})</button>`;
    el.innerHTML = html;
  }
  function openHistFilter() {
    const h = S.hist;
    const opts = cats().map(c => `<option ${c.name === h.cat ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const sh = openSheet('Filter riwayat', `
      <div class="field-label">Kategori</div>
      <select class="input" id="fc"><option value="">Semua kategori</option>${opts}</select>
      <div class="field-label">Rentang tanggal</div>
      <div class="two"><input class="input" type="date" id="ff" value="${esc(h.from)}" aria-label="Dari"><input class="input" type="date" id="ft" value="${esc(h.to)}" aria-label="Sampai"></div>
      <div class="err-text" id="ferr"></div>`,
      `<div class="two"><button class="btn" id="freset">Reset</button><button class="btn primary" id="fapply">Terapkan</button></div>`);
    $('#freset', sh).onclick = () => { Object.assign(h, { cat: '', from: '', to: '' }); closeSheet(); renderMain(); };
    $('#fapply', sh).onclick = () => {
      const f = $('#ff', sh).value, t = $('#ft', sh).value;
      if (f && t && f > t) { $('#ferr', sh).textContent = 'Tanggal awal harus sebelum tanggal akhir.'; return; }
      Object.assign(h, { cat: $('#fc', sh).value, from: f, to: t, limit: 60 }); closeSheet(); renderMain();
    };
  }

  /* ------------------------------------------------------------ settings */
  function viewSettings(view) {
    const m = S.meta; const pending = S.outbox.length;
    view.innerHTML = `
      <div class="section-title" style="margin-top:12px"><h2>Spreadsheet</h2></div>
      <div class="box">
        <div class="set-row"><div><div class="l">${esc(m.spreadsheet ? m.spreadsheet.name : (S.cfg.name || 'Home Sweet Budget'))}</div><div class="d">${S.lastSync ? 'Disinkronkan ' + timeAgo(S.lastSync) : S.cacheAt ? 'Data terakhir ' + timeAgo(S.cacheAt) : ''}</div></div>
          ${m.spreadsheet && m.spreadsheet.url ? `<a class="btn" style="height:40px;font-size:14px" href="${esc(m.spreadsheet.url)}" target="_blank" rel="noopener">Buka</a>` : ''}</div>
        <button class="set-row" id="sRefresh"><div><div class="l">Muat ulang data</div><div class="d">Ambil data terbaru dari spreadsheet</div></div>${svg('refresh', '')}</button>
        <div class="set-row"><div><div class="l">Kurs</div><div class="d">1 AUD = Rp ${nfIDR.format(m.rate)}${m.rateDate ? ', dicek ' + fShortY.format(parseIso(m.rateDate)) : ''}. Ubah di tab Setup.</div></div></div>
        <div class="set-row"><div><div class="l">Antrean kirim</div><div class="d">${pending ? pending + ' transaksi belum terkirim' : 'Semua transaksi sudah terkirim'}</div></div>${pending ? '<button class="btn" id="sFlush" style="height:40px;font-size:14px">Kirim</button>' : ''}</div>
      </div>
      <div class="section-title"><h2>Tampilan & keamanan</h2></div>
      <div class="box">
        <div class="set-row"><div><div class="l">Tampilkan angka dalam</div><div class="d">Untuk ringkasan dan grafik</div></div>
          <div class="cur-toggle"><button data-scur="IDR" aria-pressed="${S.prefs.cur === 'IDR'}">Rp</button><button data-scur="AUD" aria-pressed="${S.prefs.cur === 'AUD'}">A$</button></div></div>
        <div class="set-row"><div><div class="l">Kunci otomatis</div><div class="d">Minta PIN setelah aplikasi ditinggal</div></div>
          <select class="input" id="sLock" style="width:auto;height:40px">${[1, 5, 15, 30].map(v => `<option value="${v}" ${S.prefs.lockMin === v ? 'selected' : ''}>${v} menit</option>`).join('')}</select></div>
        <button class="set-row" id="sInstall"><div><div class="l">Pasang di layar utama</div><div class="d">${isStandalone() ? 'Sudah terpasang' : 'Buka seperti aplikasi biasa'}</div></div>${svg('share', '')}</button>
        <button class="set-row" id="sLockNow"><div><div class="l">Kunci sekarang</div></div></button>
        <button class="set-row danger" id="sUnpair"><div><div class="l">Putuskan HP ini</div><div class="d">Hapus kunci dan data tersimpan di HP ini</div></div></button>
      </div>
      ${(m.warnings || []).length ? `<div class="offline-banner">⚠ ${esc(m.warnings.join(' '))}</div>` : ''}
      <p class="small muted" style="text-align:center;margin-top:22px">Sweet Budget ${VERSION}${DEMO ? ' (demo)' : ''}${m.freeRows != null ? `<br>${m.freeRows} baris kosong tersisa di tabel Transactions` : ''}</p>`;
    view.onclick = async e => {
      const c = e.target.closest('[data-scur]'); if (c) { S.prefs.cur = c.dataset.scur; savePrefs(); return renderMain(); }
      if (e.target.closest('#sRefresh')) return sync();
      if (e.target.closest('#sFlush')) { S.outbox.forEach(o => { o.status = 'pending'; }); saveOutbox(); return flushOutbox(); }
      if (e.target.closest('#sInstall')) return openInstall(false);
      if (e.target.closest('#sLockNow')) return lock();
      if (e.target.closest('#sUnpair')) {
        const warnQ = S.outbox.length ? ` ${S.outbox.length} transaksi yang belum terkirim juga ikut terhapus.` : '';
        if (await confirmDialog('Putuskan HP ini?', 'Kunci akses dan data yang tersimpan di HP ini akan dihapus. Data di spreadsheet tidak berubah.' + warnQ + ' Untuk menghubungkan lagi, scan QR dari spreadsheet.', 'Putuskan', true)) unpair('', true);
      }
    };
    $('#sLock').onchange = e => { S.prefs.lockMin = +e.target.value; savePrefs(); };
  }
  function timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'baru saja';
    if (s < 3600) return Math.round(s / 60) + ' menit lalu';
    if (s < 86400) return Math.round(s / 3600) + ' jam lalu';
    return Math.round(s / 86400) + ' hari lalu';
  }

  /* --------------------------------------------------- sheets & dialogs */
  const sheets = [];
  function openSheet(title, body, foot) {
    const scrim = document.createElement('div'); scrim.className = 'scrim';
    const sh = document.createElement('section'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-label', title);
    sh.innerHTML = `<div class="grip"></div><div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Tutup">${svg('x')}</button></div>
      <div class="sheet-body">${body}</div>${foot ? `<div class="sheet-foot">${foot}</div>` : ''}`;
    document.body.append(scrim, sh);
    sheets.push({ sh, scrim });
    scrim.onclick = () => closeSheet();
    sh.querySelector('[data-close]').onclick = () => closeSheet();
    requestAnimationFrame(() => { scrim.classList.add('show'); sh.classList.add('show'); });
    if (!DEMO) { try { history.pushState({ sheet: sheets.length }, ''); } catch (e) { /* no history */ } }
    return sh;
  }
  function closeSheet(fromPop) {
    if (!sheets.length) return;
    if (!DEMO && !fromPop && history.state && history.state.sheet) { history.back(); return; }
    const { sh, scrim } = sheets.pop();
    sh.classList.remove('show'); scrim.classList.remove('show');
    setTimeout(() => { sh.remove(); scrim.remove(); }, 320);
  }
  function closeAllSheets() {
    while (sheets.length) { const { sh, scrim } = sheets.pop(); sh.remove(); scrim.remove(); }
    $$('.dialog, .scrim').forEach(x => x.remove());
  }
  window.addEventListener('popstate', () => { if (sheets.length) closeSheet(true); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheets.length) closeSheet();
    const kp = $('#keypad');
    if (kp && !e.target.closest('input, textarea')) {
      const k = /^\d$/.test(e.key) ? e.key : e.key === 'Backspace' ? 'del' : e.key === 'Enter' ? 'ok' : null;
      if (k) { e.preventDefault(); pinKey(k, !!S.pairing); }
    }
  });

  function confirmDialog(title, text, okLabel, danger) {
    return new Promise(resolve => {
      const scrim = document.createElement('div'); scrim.className = 'scrim top';
      const d = document.createElement('div'); d.className = 'dialog'; d.setAttribute('role', 'alertdialog'); d.setAttribute('aria-modal', 'true');
      d.innerHTML = `<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions"><button class="btn" data-a="0">Batal</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="1">${esc(okLabel)}</button></div>`;
      document.body.append(scrim, d);
      requestAnimationFrame(() => { scrim.classList.add('show'); d.classList.add('show'); });
      const done = v => { d.classList.remove('show'); scrim.classList.remove('show'); setTimeout(() => { d.remove(); scrim.remove(); }, 220); resolve(v); };
      d.onclick = e => { const b = e.target.closest('[data-a]'); if (b) done(b.dataset.a === '1'); };
      scrim.onclick = () => done(false);
      d.querySelector('[data-a="1"]').focus();
    });
  }
  function toast(kind, text, o = {}) {
    const host = $('#toasts');
    const el = document.createElement('div'); el.className = 'toast ' + kind;
    el.innerHTML = `<span class="ti">${{ ok: '✓', err: '!', warn: '!', info: 'i' }[kind]}</span><span>${esc(text)}</span>${o.action ? `<button>${esc(o.action.label)}</button>` : ''}`;
    if (o.action) el.querySelector('button').onclick = () => { o.action.fn(); el.remove(); };
    host.appendChild(el);
    while (host.children.length > 3) host.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, o.ms || (kind === 'err' ? 5000 : 2800));
  }

  function openCustomPeriod() {
    const r = periodRange(S.period.kind === 'custom' ? S.period : { kind: 'month' });
    const sh = openSheet('Pilih rentang tanggal', `
      <div class="two"><div><div class="field-label">Dari</div><input class="input" type="date" id="pf" value="${r.from}"></div>
      <div><div class="field-label">Sampai</div><input class="input" type="date" id="pt" value="${r.to}"></div></div>
      <div class="err-text" id="perr"></div>`, `<button class="btn primary block" id="papply">Terapkan</button>`);
    $('#papply', sh).onclick = () => {
      const f = $('#pf', sh).value, t = $('#pt', sh).value;
      if (!f || !t) { $('#perr', sh).textContent = 'Isi kedua tanggal.'; return; }
      if (f > t) { $('#perr', sh).textContent = 'Tanggal awal harus sebelum tanggal akhir.'; return; }
      S.period = { kind: 'custom', from: f, to: t }; closeSheet(); renderMain();
    };
  }

  function openInstall(afterPair) {
    let body;
    if (isStandalone()) body = '<p>Aplikasi sudah terpasang di layar utama. 🎉</p>';
    else if (isIOS) {
      body = `<p>Di iPhone, pasang dari Safari:</p>
        <ol class="steps"><li>Ketuk <b>Salin link</b> di bawah (dibutuhkan sekali).</li>
          <li>Ketuk tombol <b>Bagikan</b> ${svg('share', '')} di Safari, lalu <b>Tambahkan ke Layar Utama</b>.</li>
          <li>Buka <b>Sweet Budget</b> dari layar utama. Kalau diminta, ketuk <b>Tempel</b> lalu masukkan PIN.</li></ol>
        <p class="small muted">Aplikasi di layar utama iPhone punya penyimpanan sendiri, jadi link pairing perlu ditempel sekali di sana. Jangan bagikan link ini.</p>`;
    } else if (S.installEvt) body = '<p>Pasang Sweet Budget supaya bisa dibuka langsung dari layar utama, layar penuh seperti aplikasi biasa.</p>';
    else body = `<ol class="steps"><li>Di Chrome, ketuk menu <b>⋮</b> di kanan atas.</li><li>Pilih <b>Instal aplikasi</b> atau <b>Tambahkan ke layar utama</b>.</li></ol>`;
    const foot = isStandalone() ? '' : isIOS ? '<button class="btn primary block" id="copyPair">Salin link</button>'
      : S.installEvt ? '<button class="btn primary block" id="doInstall">Pasang aplikasi</button>' : '';
    const sh = openSheet(afterPair ? 'Terhubung! Pasang di layar utama' : 'Pasang di layar utama', body, foot);
    const cp = $('#copyPair', sh);
    if (cp) cp.onclick = async () => {
      try { await navigator.clipboard.writeText(pairLink()); cp.textContent = 'Tersalin ✓'; }
      catch (e) { toast('err', 'Tidak bisa menyalin otomatis.'); }
    };
    const ins = $('#doInstall', sh);
    if (ins) ins.onclick = async () => { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; closeSheet(); };
  }

  /* ---------------------------------------------------------- tx detail */
  function openDetail(key) {
    const t = findTx(key); if (!t) return;
    const c = catByName(t.category); const sg = signOf(t);
    const other = t.cur === 'AUD' ? 'IDR' : 'AUD';
    const kv = (k, v) => v ? `<div class="kv"><span>${k}</span><span>${v}</span></div>` : '';
    const body = `
      <div class="detail-amt"><div class="ico" style="margin:0 auto 8px;width:52px;height:52px;font-size:24px">${esc((c && c.icon) || TYPE_ICON[t.type])}</div>
        <div class="v num">${money(sg === 0 ? t.amount : sg * Math.abs(t.amount), t.cur, { sign: sg > 0 })}</div>
        <div class="small muted num">≈ ${money(Math.abs(conv(t, other)), other)}</div></div>
      ${t.failed ? `<div class="offline-banner" style="background:var(--danger-bg);color:var(--danger)">Gagal disimpan: ${esc(t.error || '')}</div>` : t.pending ? '<div class="offline-banner">Menunggu dikirim ke spreadsheet.</div>' : ''}
      ${kv('Tanggal', t.date ? esc(dayLabel(t.date)) : 'Tanpa tanggal')}
      ${kv('Kategori', esc(t.category || '—'))}
      ${kv('Jenis', esc((TYPE[t.type] || TYPE.other).label))}
      ${kv('Rekening', esc(t.account || '—'))}
      ${kv('Catatan', esc(t.description))}
      ${!t.pending ? kv('Baris di sheet', 'Transactions, baris ' + t.row) : ''}`;
    let foot;
    if (t.pending) foot = `<div class="two"><button class="btn" id="dDel" style="color:var(--danger)">${svg('del', '')}Batalkan</button>${t.failed ? '<button class="btn primary" id="dRetry">Kirim ulang</button>' : '<button class="btn" data-close2>Tutup</button>'}</div>`;
    else foot = `<div class="two"><button class="btn" id="dDel" style="color:var(--danger)">${svg('del', '')}Hapus</button><button class="btn primary" id="dEdit">${svg('edit', '')}Ubah</button></div>`;
    const sh = openSheet('Detail transaksi', body, foot);
    sh.querySelectorAll('.btn svg').forEach(s => { s.style.width = '18px'; s.style.height = '18px'; });
    const close2 = $('[data-close2]', sh); if (close2) close2.onclick = () => closeSheet();
    const retry = $('#dRetry', sh);
    if (retry) retry.onclick = () => { const op = S.outbox.find(o => o.opId === t.opId); if (op) { op.status = 'pending'; saveOutbox(); } closeSheet(); flushOutbox(); };
    const edit = $('#dEdit', sh);
    if (edit) edit.onclick = () => { closeSheet(); setTimeout(() => openForm(t), 340); };
    $('#dDel', sh).onclick = async () => {
      if (t.pending) {
        if (!await confirmDialog('Batalkan transaksi ini?', 'Transaksi ini belum terkirim dan akan dihapus dari antrean di HP.', 'Batalkan', true)) return;
        S.outbox = S.outbox.filter(o => o.opId !== t.opId); saveOutbox(); closeSheet(); renderMain(); toast('ok', 'Dibatalkan'); return;
      }
      if (!await confirmDialog('Hapus transaksi ini?', `Baris ${t.row} di tab Transactions akan dihapus dari spreadsheet. Tindakan ini tidak bisa dibatalkan.`, 'Hapus', true)) return;
      const btn = $('#dDel', sh); btn.disabled = true; btn.innerHTML = '<span class="spin" style="border-color:rgba(208,59,59,.3);border-top-color:var(--danger)"></span>';
      const res = await mutate('delete', { row: t.row, original: originalOf(t) });
      if (res) { closeSheet(); toast('ok', 'Transaksi dihapus'); }
      else { btn.disabled = false; btn.innerHTML = 'Hapus'; }
    };
  }
  const originalOf = t => ({ date: t.date, category: t.category, amount: t.amount, currency: t.currency, account: t.account, description: t.description });
  async function mutate(action, payload) {
    setSync('busy');
    try {
      const res = await api(action, payload);
      if (res.ok) { applyData(res); setSync('idle'); renderMain(); return res; }
      setSync('idle');
      if (AUTH_CODES.includes(res.code)) { handleAuthError(res); return null; }
      toast('err', res.message);
      if (res.code === 'STALE') sync({ silent: true });
      return null;
    } catch (e) {
      setSync('off'); toast('err', e.message + ' Ubah dan hapus butuh internet.'); return null;
    }
  }

  /* ------------------------------------------------------ add / edit form */
  const KINDS_ADD = [['expense', 'Keluar'], ['income', 'Masuk'], ['savings', 'Nabung'], ['transfer', 'Transfer']];
  const KINDS_EDIT = [['expense', 'Keluar'], ['income', 'Masuk'], ['savings', 'Nabung'], ['other', 'Lainnya']];
  const kindOfType = t => (['expense', 'income', 'savings'].includes(t) ? t : 'other');
  const catsOfKind = k => cats().filter(c => (k === 'other' ? !['expense', 'income', 'savings'].includes(c.type) : c.type === k));
  let F = null;

  function openForm(edit) {
    if (!S.meta) { toast('warn', 'Data belum dimuat. Coba lagi sebentar.'); return; }
    const kind = edit ? kindOfType(edit.type) : 'expense';
    const acc = edit ? edit.account : defaultAccount(kind);
    const a = accByName(acc);
    F = {
      edit: edit || null, kind,
      amount: edit ? fmtAmountStr(Math.abs(edit.amount), edit.cur) : '',
      cur: edit ? edit.cur : a ? a.currency : S.prefs.cur, curManual: !!edit,
      account: acc, category: edit ? edit.category : '', date: edit ? edit.date || todayIso() : todayIso(), note: edit ? edit.description || '' : '',
      withdraw: !!(edit && edit.type === 'savings' && edit.amount < 0),
      from: S.prefs.lastAcc.tfrom || (accs().find(x => x.currency === 'AUD') || accs()[0] || {}).name || '',
      to: S.prefs.lastAcc.tto || (accs().find(x => x.currency === 'IDR') || accs()[1] || {}).name || '',
      out: '', in: '', inManual: false,
    };
    if (F.from === F.to) F.to = (accs().find(x => x.name !== F.from) || {}).name || '';
    const sh = openSheet(edit ? 'Ubah transaksi' : 'Tambah transaksi', '<div id="formBody"></div>',
      `<div class="err-text" id="formErr" style="margin:0 0 8px"></div><button class="btn primary block" id="formSave"></button>`);
    sh.id = 'formSheet';
    renderForm();
    $('#formSave', sh).onclick = submitForm;
    const inp = $('#amt', sh); if (inp) inp.focus({ preventScroll: true });
  }
  // last account used for this kind on this phone, else the one used most in recent rows of that kind
  function defaultAccount(kind) {
    const last = S.prefs.lastAcc[kind];
    if (last && accByName(last)) return last;
    const count = {};
    S.txs.filter(t => t.type === kind && accByName(t.account)).slice(-40).forEach(t => { count[t.account] = (count[t.account] || 0) + 1; });
    const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    return best || (accs()[0] || {}).name || '';
  }
  function fmtAmountStr(v, cur) {
    if (!v) return '';
    return cur === 'IDR' ? nfIDR.format(Math.round(v)) : nfAUD.format(v).replace(/,00$/, '');
  }
  function parseAmount(s, cur) {
    if (!s) return 0;
    if (cur === 'IDR') return Number(String(s).replace(/\D/g, '')) || 0;
    return Number(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  }
  // live thousand separators while typing; "," or "." at the end starts decimals for AUD
  function bindAmount(inp, getCur, onChange) {
    inp.addEventListener('input', () => {
      const cur = getCur(); let v = inp.value; const caret = inp.selectionStart || v.length;
      if (cur === 'AUD' && /[.,]$/.test(v) && !/,/.test(v.slice(0, -1))) v = v.slice(0, -1) + ',';
      const before = v.slice(0, caret).replace(cur === 'IDR' ? /\D/g : /[^\d,]/g, '').length;
      let out;
      if (cur === 'IDR') { const d = v.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 13); out = d ? nfIDR.format(Number(d)) : ''; }
      else {
        const i = v.indexOf(',');
        const intD = (i >= 0 ? v.slice(0, i) : v).replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 10);
        const decD = i >= 0 ? v.slice(i + 1).replace(/\D/g, '').slice(0, 2) : null;
        out = (intD ? nfIDR.format(Number(intD)) : decD !== null ? '0' : '') + (decD !== null ? ',' + decD : '');
      }
      inp.value = out;
      let n = 0, pos = out.length;
      for (let k = 0; k < out.length; k++) { if (/[\d,]/.test(out[k])) n++; if (n >= before) { pos = k + 1; break; } }
      if (before === 0) pos = 0;
      try { inp.setSelectionRange(pos, pos); } catch (e) { /* type=text only */ }
      onChange(out);
    });
  }
  function renderForm() {
    const body = $('#formBody'); if (!body) return;
    const kinds = F.edit ? KINDS_EDIT : KINDS_ADD;
    const seg = `<div class="seg" role="group" aria-label="Jenis transaksi">${kinds.map(([k, l]) => `<button data-kind="${k}" aria-pressed="${F.kind === k}">${l}</button>`).join('')}</div>`;
    const accChips = (sel, attr) => accs().map(a => `<button class="acc-chip" data-${attr}="${esc(a.name)}" aria-pressed="${a.name === sel}">${esc(a.icon || '🏦')} ${esc(a.name)} <span class="c">${a.currency}</span></button>`).join('');
    const dateChips = () => {
      const t = todayIso(), y = iso(addDays(today(), -1));
      const other = F.date !== t && F.date !== y;
      return `<div class="scroller"><button class="chip" data-date="${t}" aria-pressed="${F.date === t}">Hari ini</button>
        <button class="chip" data-date="${y}" aria-pressed="${F.date === y}">Kemarin</button>
        <label class="chip date-chip" aria-pressed="${other}">${other ? esc(fShortY.format(parseIso(F.date))) : 'Pilih tanggal'}<input type="date" id="dateIn" value="${F.date}" max="2100-12-31" aria-label="Pilih tanggal"></label></div>`;
    };
    let html = seg;
    if (F.kind === 'transfer') {
      const fa = accByName(F.from), ta = accByName(F.to);
      const same = fa && ta && fa.currency === ta.currency;
      html += `
        <div class="field-label">Dari rekening</div><div class="scroller">${accChips(F.from, 'from')}</div>
        <div class="transfer-arrow">${svg('down', '')}</div>
        <div class="field-label" style="margin-top:4px">Ke rekening</div><div class="scroller">${accChips(F.to, 'to')}</div>
        <div class="field-label">Nominal</div>
        ${same || !fa || !ta ? `<div class="mini-amount"><span>${fa ? CUR_SYM[fa.currency] : ''}</span><input id="tOut" inputmode="${fa && fa.currency === 'AUD' ? 'decimal' : 'numeric'}" placeholder="0" value="${esc(F.out)}" autocomplete="off"></div>`
          : `<div class="two"><div><div class="small muted" style="margin:0 2px 6px">Dikirim</div><div class="mini-amount"><span>${CUR_SYM[fa.currency]}</span><input id="tOut" inputmode="${fa.currency === 'AUD' ? 'decimal' : 'numeric'}" placeholder="0" value="${esc(F.out)}" autocomplete="off"></div></div>
             <div><div class="small muted" style="margin:0 2px 6px">Diterima</div><div class="mini-amount"><span>${CUR_SYM[ta.currency]}</span><input id="tIn" inputmode="${ta.currency === 'AUD' ? 'decimal' : 'numeric'}" placeholder="0" value="${esc(F.in)}" autocomplete="off"></div></div></div>
             <p class="small muted" style="margin:8px 2px 0">Diterima dihitung dengan kurs Setup (1 AUD = Rp ${nfIDR.format(S.meta.rate)}). Ganti dengan angka yang benar-benar masuk.</p>`}
        <div class="field-label">Tanggal</div>${dateChips()}
        <div class="field-label">Catatan <span class="muted">opsional</span></div>
        <input class="input" id="noteIn" maxlength="200" placeholder="Contoh: kirim uang ke rumah" value="${esc(F.note)}" autocomplete="off">`;
    } else {
      const list = catsOfKind(F.kind);
      html += `
        <div class="amount-field"><button class="cur-btn" id="curBtn" aria-label="Ganti mata uang">${CUR_SYM[F.cur]}</button>
          <input id="amt" inputmode="${F.cur === 'AUD' ? 'decimal' : 'numeric'}" placeholder="0" value="${esc(F.amount)}" autocomplete="off" aria-label="Nominal"></div>
        <div class="amount-hint num" id="amtHint"></div>
        ${accs().length ? `<div class="field-label">Rekening</div><div class="scroller">${accChips(F.account, 'acc')}</div>` : ''}
        <div class="field-label">Kategori</div>
        ${list.length ? `<div class="cat-grid">${list.map(c => `<button class="cat" data-cat="${esc(c.name)}" aria-pressed="${c.name === F.category}"><span class="e">${esc(c.icon || '•')}</span>${esc(c.name)}</button>`).join('')}</div>`
          : '<p class="small muted">Belum ada kategori jenis ini di tab Setup.</p>'}
        ${F.kind === 'savings' ? `<label class="switch">Ambil dari tabungan (uang kembali ke rekening)<input type="checkbox" id="wd" ${F.withdraw ? 'checked' : ''}></label>` : ''}
        <div class="field-label">Tanggal</div>${dateChips()}
        <div class="field-label">Catatan <span class="muted">opsional</span></div>
        <input class="input" id="noteIn" maxlength="200" placeholder="Contoh: makan siang di kampus" value="${esc(F.note)}" autocomplete="off">`;
    }
    body.innerHTML = html;
    // keep the selected account chip visible in its horizontal row
    $$('.scroller', body).forEach(sc => {
      const on = sc.querySelector('.acc-chip[aria-pressed="true"]');
      if (on && on.offsetLeft + on.offsetWidth > sc.clientWidth) sc.scrollLeft = on.offsetLeft - 18;
    });
    const save = $('#formSave');
    if (save) save.textContent = F.edit ? 'Simpan perubahan' : { expense: 'Simpan pengeluaran', income: 'Simpan pemasukan', savings: 'Simpan tabungan', transfer: 'Simpan transfer' }[F.kind];
    $('#formErr').textContent = '';
    // events
    body.onclick = e => {
      const k = e.target.closest('[data-kind]');
      if (k && k.dataset.kind !== F.kind) {
        F.kind = k.dataset.kind;
        if (!catsOfKind(F.kind).some(c => c.name === F.category)) F.category = '';
        if (!F.edit && F.kind !== 'transfer') {
          const prevCur = F.cur;
          F.account = defaultAccount(F.kind);
          if (!F.curManual) { F.cur = (accByName(F.account) || {}).currency || F.cur; if (F.cur !== prevCur) F.amount = fmtAmountStr(parseAmount(F.amount, prevCur), F.cur); }
        }
        renderForm(); const a = $('#amt'); if (a && !a.value) a.focus({ preventScroll: true });
        return;
      }
      const ac = e.target.closest('[data-acc]');
      if (ac) {
        F.account = ac.dataset.acc;
        if (!F.curManual) { const cur = accByName(F.account).currency; if (cur !== F.cur) { F.amount = fmtAmountStr(parseAmount(F.amount, F.cur), cur); F.cur = cur; } }
        renderForm(); return;
      }
      const fr = e.target.closest('[data-from]'); if (fr) { F.from = fr.dataset.from; if (F.from === F.to) F.to = (accs().find(x => x.name !== F.from) || {}).name; F.inManual = false; recalcIn(); renderForm(); return; }
      const to = e.target.closest('[data-to]'); if (to) { F.to = to.dataset.to; if (F.from === F.to) F.from = (accs().find(x => x.name !== F.to) || {}).name; F.inManual = false; recalcIn(); renderForm(); return; }
      const c = e.target.closest('[data-cat]'); if (c) { F.category = c.dataset.cat; $$('[data-cat]', body).forEach(b => b.setAttribute('aria-pressed', b === c)); $('#formErr').textContent = ''; return; }
      const d = e.target.closest('[data-date]'); if (d) { F.date = d.dataset.date; renderForm(); return; }
      if (e.target.closest('#curBtn')) {
        const cur = F.cur === 'IDR' ? 'AUD' : 'IDR';
        F.amount = fmtAmountStr(parseAmount(F.amount, F.cur), cur); F.cur = cur; F.curManual = true;
        renderForm(); const a = $('#amt'); if (a) a.focus({ preventScroll: true });
      }
    };
    const amt = $('#amt');
    if (amt) { bindAmount(amt, () => F.cur, v => { F.amount = v; updateHint(); amt.classList.remove('shake'); }); updateHint(); }
    const tOut = $('#tOut');
    if (tOut) bindAmount(tOut, () => (accByName(F.from) || {}).currency || 'AUD', v => { F.out = v; recalcIn(true); });
    const tIn = $('#tIn');
    if (tIn) bindAmount(tIn, () => (accByName(F.to) || {}).currency || 'IDR', v => { F.in = v; F.inManual = true; });
    const dIn = $('#dateIn'); if (dIn) dIn.onchange = () => { if (dIn.value) { F.date = dIn.value; renderForm(); } };
    const note = $('#noteIn'); if (note) note.oninput = () => { F.note = note.value; };
    const wd = $('#wd'); if (wd) wd.onchange = () => { F.withdraw = wd.checked; };
  }
  function updateHint() {
    const h = $('#amtHint'); if (!h) return;
    const v = parseAmount(F.amount, F.cur); const other = F.cur === 'AUD' ? 'IDR' : 'AUD';
    h.textContent = v ? '≈ ' + money(conv({ amount: v, cur: F.cur }, other), other) : '';
    const a = $('#amt'); if (a) a.style.fontSize = F.amount.length > 13 ? '28px' : F.amount.length > 10 ? '34px' : '';
  }
  function recalcIn(live) {
    const fa = accByName(F.from), ta = accByName(F.to);
    if (!fa || !ta || F.inManual) return;
    const v = parseAmount(F.out, fa.currency);
    F.in = fa.currency === ta.currency ? F.out : fmtAmountStr(conv({ amount: v, cur: fa.currency }, ta.currency), ta.currency);
    if (live) { const tIn = $('#tIn'); if (tIn) tIn.value = F.in; }
  }
  async function submitForm() {
    const err = $('#formErr');
    const fail = (msg, el) => { err.textContent = msg; if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); } navigator.vibrate && navigator.vibrate(40); };
    if (!F.date) return fail('Pilih tanggal.');
    if (F.kind === 'transfer') {
      const fa = accByName(F.from), ta = accByName(F.to);
      if (!fa || !ta || fa === ta) return fail('Pilih rekening asal dan tujuan yang berbeda.');
      const out = parseAmount(F.out, fa.currency);
      const inn = fa.currency === ta.currency ? out : parseAmount(F.in, ta.currency);
      if (!(out > 0)) return fail('Isi nominal yang dikirim.', $('#tOut'));
      if (!(inn > 0)) return fail('Isi nominal yang diterima.', $('#tIn'));
      queueOp('transfer', 'transfer', { transfer: { date: F.date, from: fa.name, to: ta.name, amountOut: out, amountIn: inn, currencyOut: fa.currency, currencyIn: ta.currency, description: F.note.trim() } });
      S.prefs.lastAcc.tfrom = fa.name; S.prefs.lastAcc.tto = ta.name; savePrefs();
      return;
    }
    const v = parseAmount(F.amount, F.cur);
    if (!(v > 0)) return fail(F.amount ? 'Nominal harus lebih dari 0.' : 'Isi nominal dulu.', $('#amt'));
    if (accs().length && !accByName(F.account)) return fail('Pilih rekening.');
    if (!F.category) return fail('Pilih kategori.', $('.cat-grid'));
    const tx = { date: F.date, category: F.category, amount: F.kind === 'savings' && F.withdraw ? -v : v, currency: F.cur, account: F.account, description: F.note.trim() };
    if (F.edit) {
      const btn = $('#formSave'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
      const res = await mutate('update', { row: F.edit.row, original: originalOf(F.edit), tx });
      if (res) { closeSheet(); toast('ok', 'Perubahan tersimpan'); }
      else { btn.disabled = false; btn.textContent = 'Simpan perubahan'; }
      return;
    }
    S.prefs.lastAcc[F.kind] = F.account; savePrefs();
    queueOp('add', F.kind, { tx });
  }
  function queueOp(action, kind, payload) {
    S.outbox.push({ opId: uuid(), action, kind, payload, createdAt: Date.now(), status: 'pending' });
    saveOutbox();
    navigator.vibrate && navigator.vibrate(12);
    closeSheet();
    renderMain();
    flushOutbox();
  }

  /* ---------------------------------------------------------- lifecycle */
  function markActive() { S.lastActive = Date.now(); if (S.pin) sess.set('pin', { pin: S.pin, at: S.lastActive }); }
  document.addEventListener('pointerdown', () => { if (Date.now() - S.lastActive > 15000) markActive(); }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { markActive(); return; }
    if (S.locked || !S.cfg) return;
    if (Date.now() - S.lastActive > S.prefs.lockMin * 60000) { lock(); return; }
    markActive();
    if (Date.now() - S.lastSync > 60000) sync({ silent: true }); else flushOutbox();
  });
  window.addEventListener('online', () => { if (!S.locked) { setSync('idle'); flushOutbox(); } });
  window.addEventListener('offline', () => setSync('off'));
  setInterval(() => { if (!S.locked && S.outbox.some(o => o.status !== 'error') && navigator.onLine) flushOutbox(); }, 30000);
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; });

  if ('serviceWorker' in navigator && location.protocol === 'https:' && !DEMO) {
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('info', 'Versi baru tersedia.', { ms: 10000, action: { label: 'Muat ulang', fn: () => location.reload() } });
          }
        });
      });
    }).catch(() => { /* offline support unavailable */ });
  }

  /* --------------------------------------------------------------- boot */
  function boot() {
    const m = location.hash.match(/pair=([A-Za-z0-9_-]{20,})/);
    if (m && !DEMO) {
      try {
        const p = parsePairCode(m[1]);
        if (S.cfg && S.cfg.key === p.key && S.cfg.api === p.api) history.replaceState(null, '', location.pathname + location.search);
        else return startPairing(p);
      } catch (e) {
        history.replaceState(null, '', location.pathname + location.search);
        return renderGate({ mode: 'welcome', msg: 'Link pairing tidak valid. Buat QR baru dari spreadsheet.' });
      }
    }
    if (DEMO && !S.cfg) { S.cfg = { api: 'demo', key: 'demo', name: 'Home Sweet Budget (demo)' }; store.set('cfg', S.cfg); }
    const sp = sess.get('pin', null);
    if (S.cfg && sp && Date.now() - sp.at < S.prefs.lockMin * 60000) {
      S.pin = sp.pin; S.locked = false; S.lastActive = sp.at;
      renderApp();
      if (wantAdd) { wantAdd = false; setTimeout(() => openForm(), 300); }
      sync({ silent: true });
      return;
    }
    renderApp();
  }

  /* ---------------------------------------------------------------- demo */
  const Demo = (() => {
    const PIN = '123456';
    const meta = {
      app: 'Home Sweet Budget', version: VERSION, spreadsheet: { name: 'Home Sweet Budget (demo)', url: '' }, timezone: 'Australia/Brisbane',
      rate: 12532, rateFound: true, rateDate: '2026-10-17', startDate: null, warnings: [], freeRows: null,
      categories: [
        ['🎓', 'Scholarship Allowance', 'income'], ['💼', 'Part-time Wages', 'income'], ['✨', 'Other Income', 'income'],
        ['🏠', 'Rent & Housing', 'expense'], ['🛒', 'Groceries', 'expense'], ['🍜', 'Eating Out', 'expense'], ['🚌', 'Transport', 'expense'],
        ['💡', 'Bills & Phone', 'expense'], ['📚', 'Study', 'expense'], ['🎉', 'Personal & Fun', 'expense'], ['💞', 'Family Support', 'expense'],
        ['📦', 'Others', 'expense'], ['🏡', 'Dream Fund', 'savings'], ['🥇', 'Gold Savings', 'savings'],
        ['📥', 'Transfer In', 'transfer_in'], ['📤', 'Transfer Out', 'transfer_out'], ['🔧', 'Balance Fix', 'adjustment'],
      ].map(([icon, name, type]) => ({ icon, name, type, rawType: type, budget: type === 'expense' ? { 'Rent & Housing': 1000, Groceries: 400, 'Eating Out': 150, Transport: 80 }[name] || null : null })),
      accounts: [['🏦', 'Bank Mandiri', 'IDR', 5000000], ['🏦', 'BCA', 'IDR', 12000000], ['🏦', 'BRI', 'IDR', 750000], ['🏦', 'CommBank', 'AUD', 1800], ['💳', 'Revolut', 'AUD', 1200]]
        .map(([icon, name, currency, start]) => ({ icon, name, currency, start })),
    };
    let rows = null;
    function seed() {
      let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      const pick = a => a[Math.floor(rnd() * a.length)];
      const t = today(); const start = new Date(t.getFullYear(), t.getMonth() - 3, 1);
      meta.startDate = iso(start);
      const out = [];
      const add = (d, category, amount, currency, account, description = '') => out.push({ date: iso(d), category, amount, currency, account, description });
      for (let d = new Date(start); d <= t; d = addDays(d, 1)) {
        const dow = d.getDay(), dom = d.getDate();
        if (dom === 1) { add(d, 'Scholarship Allowance', 2500, 'AUD', 'CommBank', 'Living allowance'); add(d, 'Bills & Phone', 45, 'AUD', 'CommBank', 'Paket HP'); }
        if (dom === 3) { add(d, 'Transfer Out', 500, 'AUD', 'CommBank', 'Kirim ke BCA'); add(d, 'Transfer In', 6150000, 'IDR', 'BCA', 'Dari CommBank'); }
        if (dom === 5) { add(d, 'Family Support', 2000000, 'IDR', 'BCA', 'Kiriman untuk ibu'); add(d, 'Dream Fund', 3000000, 'IDR', 'BCA', 'Nabung rumah'); }
        if (dow === 1) add(d, 'Rent & Housing', 235, 'AUD', 'CommBank', 'Sewa kamar mingguan');
        if (dow === 5) add(d, 'Part-time Wages', Math.round(260 + rnd() * 160), 'AUD', 'CommBank', 'Gaji shift');
        if (dow === 2 || dow === 6) add(d, 'Groceries', Math.round(35 + rnd() * 55) + 0.5, 'AUD', 'CommBank', pick(['Woolworths', 'Coles', 'Aldi', 'Asian grocer']));
        if (rnd() < 0.45) add(d, 'Eating Out', Math.round(9 + rnd() * 16), 'AUD', pick(['CommBank', 'Revolut']), pick(['Makan siang kampus', 'Kopi', 'Bakso', 'Sushi train', 'Kebab']));
        if (dow >= 1 && dow <= 5 && rnd() < 0.7) add(d, 'Transport', 3.4, 'AUD', 'CommBank', 'Go card');
        if (rnd() < 0.06) add(d, 'Study', Math.round(20 + rnd() * 60), 'AUD', 'CommBank', pick(['Buku', 'Print tugas', 'Alat tulis']));
        if (rnd() < 0.08) add(d, 'Personal & Fun', Math.round(15 + rnd() * 50), 'AUD', 'Revolut', pick(['Bioskop', 'Kaos', 'Potong rambut']));
        if (rnd() < 0.05) add(d, 'Others', 150000, 'IDR', 'Bank Mandiri', 'Pulsa keluarga');
      }
      return out;
    }
    function payload() {
      const accCur = {}; meta.accounts.forEach(a => { accCur[a.name] = a.currency; });
      const type = {}; meta.categories.forEach(c => { type[c.name] = c.type; });
      return { ok: true, meta, serverTime: new Date().toISOString(),
        transactions: rows.map((r, i) => Object.assign({ row: 6 + i, cur: r.currency || accCur[r.account] || 'AUD', type: type[r.category] || 'unknown' }, r)) };
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const fp = t => [t.date, t.category, Number(t.amount).toFixed(2), t.currency, t.account, (t.description || '').trim()].join('|');
    async function handle(action, p, pin) {
      await wait(350 + Math.random() * 300);
      if (!rows) rows = seed();
      if (pin !== PIN) return { ok: false, code: 'BAD_PIN', message: 'PIN salah. Di mode demo PIN-nya 123456.' };
      const err = m => ({ ok: false, code: 'BAD_INPUT', message: m });
      const check = t => (!catByName(t.category) ? 'Kategori tidak ada.' : !(Math.abs(t.amount) > 0) ? 'Nominal wajib diisi.' : null);
      if (action === 'sync') return payload();
      if (action === 'add') { const e = check(p.tx); if (e) return err(e); rows.push(Object.assign({}, p.tx)); return Object.assign(payload(), { rows: [5 + rows.length] }); }
      if (action === 'transfer') {
        const t = p.transfer;
        rows.push({ date: t.date, category: 'Transfer Out', amount: t.amountOut, currency: t.currencyOut, account: t.from, description: t.description || 'Transfer ke ' + t.to });
        rows.push({ date: t.date, category: 'Transfer In', amount: t.amountIn, currency: t.currencyIn, account: t.to, description: t.description || 'Transfer dari ' + t.from });
        return payload();
      }
      const i = p.row - 6;
      if (!rows[i] || fp(rows[i]) !== fp(p.original)) return { ok: false, code: 'STALE', message: 'Data berubah. Silakan ulangi.' };
      if (action === 'update') { const e = check(p.tx); if (e) return err(e); rows[i] = Object.assign({}, p.tx); return payload(); }
      if (action === 'delete') { rows.splice(i, 1); return payload(); }
      return err('Aksi tidak dikenal.');
    }
    return { handle };
  })();

  boot();
})();
