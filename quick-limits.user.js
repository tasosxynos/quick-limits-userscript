// ==UserScript==
// @name         QuickLimits — Claude & OpenCode Go usage
// @name:en      QuickLimits — Claude & OpenCode Go usage
// @namespace    axynos.local.limits
// @version      1.5.0
// @description  Κάτω αριστερά σε κάθε σελίδα: πόσο από τα όρια των συνδρομών σου (OpenCode Go + Claude) έχεις καταναλώσει — session / weekly / monthly. Συμπτυγμένο δείχνει και τις δύο συνδρομές, με το ποσοστό του session και αντίστροφη μέτρηση H:MM· αν κάποιο όριο εξαντληθεί, δείχνει ποιο ήταν και πότε ελευθερώνεται. Με το ⚙ ορίζεις το workspace id του OpenCode Go.
// @author       Anastasios Xynos (tasosxynos)
// @license      MIT
// @homepageURL  https://github.com/tasosxynos/quick-limits-userscript
// @supportURL   https://github.com/tasosxynos/quick-limits-userscript/issues
// @downloadURL  https://raw.githubusercontent.com/tasosxynos/quick-limits-userscript/main/quick-limits.user.js
// @updateURL    https://raw.githubusercontent.com/tasosxynos/quick-limits-userscript/main/quick-limits.user.js
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      claude.ai
// @connect      opencode.ai
// ==/UserScript==

(function () {
  'use strict';

  // ─── ρυθμίσεις (πείραξέ τες ελεύθερα) ──────────────────────────────────────
  // OpenCode Go: το console είναι SPA στο /console — τα νούμερα έρχονται από το API
  // του (JSON, με τα cookies του browser). Χρειάζεται το workspace id σου: αυτό που
  // φαίνεται στο URL https://opencode.ai/console/<εδώ>/…  Το βάζεις από το ⚙ της
  // μπάρας (ή συμπληρώνεται μόνο του την πρώτη φορά που θα ανοίξεις το console).
  const OC_API = 'https://opencode.ai/console/api/go/status';
  const wsUrls = (w) => [OC_API, `${OC_API}?workspaceID=${w}`, `${OC_API}?workspaceId=${w}`];
  const CLAUDE_ORGS = 'https://claude.ai/api/organizations';
  const claudeUsageUrl = (org) => `https://claude.ai/api/organizations/${org}/usage`;

  const HOTKEY = { alt: true, code: 'KeyW' };         // Alt+W → άνοιξε/κλείσε
  const ALPHA = 0.55;                                 // διαφάνεια πλαισίου (0.2 = πολύ διάφανο, 1 = αδιαφανές)
  const TTL = { claude: 45000, opencode: 240000 };    // ελάχιστος χρόνος ανάμεσα σε δύο λήψεις, ανά πηγή
  const AUTO_MS = 60000;                              // ρυθμός αυτόματης ανανέωσης όσο φαίνεται η σελίδα

  if (document.getElementById('ax-quick-limits')) return;   // no double injection

  // #region pure
  // ─── ό,τι μπορεί να ελεγχθεί χωρίς DOM/δίκτυο ─────────────────────────────
  const WIN = ['session', 'weekly', 'monthly'];

  // workspace id του OpenCode Go, όπως το δέχεται και το API: org_… ή wrk_…
  const WS_RE = /^(org_|wrk_)[A-Za-z0-9]{6,}$/;
  const validWs = (s) => (typeof s === 'string' && WS_RE.test(s.trim()) ? s.trim() : null);

  // Claude: claude.ai/api/organizations/<org>/usage
  // { five_hour:{utilization,resets_at}, seven_day:{…}, extra_usage:{…},
  //   limits:[{kind:'session'|'weekly_all'|'weekly_scoped', percent, resets_at}] }
  function parseClaudeUsage(j) {
    if (!j || typeof j !== 'object') return null;
    const win = (o) => {
      if (!o || o.utilization == null || !Number.isFinite(Number(o.utilization))) return null;
      const t = o.resets_at ? Date.parse(o.resets_at) : NaN;
      const pct = Number(o.utilization);
      return { pct, resetsAt: Number.isFinite(t) ? t : null, depleted: pct >= 100 };
    };
    const fromLimits = (kind) => {
      const x = (Array.isArray(j.limits) ? j.limits : []).find((l) => l && l.kind === kind);
      if (!x || x.percent == null || !Number.isFinite(Number(x.percent))) return null;
      const t = x.resets_at ? Date.parse(x.resets_at) : NaN;
      const pct = Number(x.percent);
      return { pct, resetsAt: Number.isFinite(t) ? t : null, depleted: pct >= 100 };
    };
    let session = win(j.five_hour) || fromLimits('session');
    let weekly = win(j.seven_day) || fromLimits('weekly_all');
    // «monthly»: το Claude δεν έχει μηνιαίο όριο χρήσης στα Pro/Max — το βγάζουμε
    // μόνο αν το extra-usage είναι ενεργό, αλλιώς μένει «—».
    let monthly = null;
    const ex = j.extra_usage;
    if (ex && ex.is_enabled) {
      let pct = ex.utilization == null ? NaN : Number(ex.utilization);   // Number(null) === 0!
      if (!Number.isFinite(pct) && Number(ex.monthly_limit) > 0 && Number.isFinite(Number(ex.used_credits))) {
        pct = (Number(ex.used_credits) / Number(ex.monthly_limit)) * 100;
      }
      if (Number.isFinite(pct)) monthly = { pct, resetsAt: null, depleted: pct >= 100 };
    }
    return { session, weekly, monthly };
  }

  // ποιο org id θα χρησιμοποιήσουμε από το claude.ai/api/organizations
  function parseClaudeOrgs(j) {
    if (!Array.isArray(j)) return null;
    const withChat = j.find((o) => o && Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
    const pick = withChat || j.find((o) => o && o.uuid);
    return pick ? pick.uuid : null;
  }

  // OpenCode Go: https://opencode.ai/console/api/go/status (JSON, cookies του console)
  //   { product:'go'|'go-plus', cancelAtPeriodEnd,
  //     access:{ meters:{ fiveHour:{usedMicroCents,limitMicroCents,resetsAt},
  //                       week:{…}, month:{…} } } }
  // Το ποσοστό υπολογίζεται όπως το δείχνει το console: round(used/limit*100),
  // και 100% όταν used >= limit. Τα ποσά είναι micro-cents (μπορεί να έρθουν και ως string).
  const ocNum = (v) => {
    if (v == null) return NaN;
    if (typeof v === 'bigint') return Number(v);
    return Number(String(v).replace(/n$/, ''));
  };
  function ocMeter(x) {
    if (!x || typeof x !== 'object') return null;
    const used = ocNum(x.usedMicroCents), lim = ocNum(x.limitMicroCents);
    if (!Number.isFinite(used) || !Number.isFinite(lim) || lim <= 0) return null;
    const depleted = used >= lim;
    const t = x.resetsAt ? Date.parse(x.resetsAt) : NaN;
    return {
      pct: depleted ? 100 : Math.min(100, Math.round((used / lim) * 100)),
      resetsAt: Number.isFinite(t) ? t : null,
      depleted,
    };
  }
  function parseOpenCodeStatus(j) {
    const m = j && j.access && j.access.meters;
    if (!m || typeof m !== 'object') return null;
    const out = {
      session: ocMeter(m.fiveHour), weekly: ocMeter(m.week), monthly: ocMeter(m.month),
      product: typeof j.product === 'string' ? j.product : null,
    };
    if (!out.session && !out.weekly && !out.monthly) return null;
    return out;
  }

  // ποιο είναι «αυτό που μετράει»: το μεγαλύτερο ποσοστό από τις δύο στήλες
  function worstOf(d) {
    let best = null;
    for (const svc of ['go', 'claude']) {
      const src = d && d[svc];
      if (!src) continue;
      for (const w of WIN) {
        const x = src[w];
        if (!x || !Number.isFinite(x.pct)) continue;
        if (!best || x.pct > best.pct) best = { svc, win: w, pct: x.pct, resetsAt: x.resetsAt || null, depleted: x.depleted === true || x.pct >= 100 };
      }
    }
    return best;
  }

  const fmtPct = (p) => (p < 10 ? (Math.round(p * 10) / 10).toFixed(1) : String(Math.round(p))) + '%';
  // αντίστροφη μέτρηση σε H:MM — ώρες:λεπτά, με τις ώρες να ξεπερνούν άνετα το 24
  // (π.χ. 4d 15h → 111:00). Κάτω από ένα λεπτό δείχνει δευτερόλεπτα: 0:45.
  function fmtHM(ms) {
    if (!Number.isFinite(ms)) return '';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return '0:' + String(s).padStart(2, '0');
    return Math.floor(s / 3600) + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  }
  const colorOf = (p) => (p >= 100 ? '#ff6b6b' : p >= 80 ? '#ff9b6b' : p >= 50 ? '#ffd166' : '#6ee7a0');

  // συμπτυγμένη μπάρα: ΚΑΙ οι δύο συνδρομές — ποσοστό του session της καθεμιάς και
  // H:MM μέχρι το reset του. Όταν κάποιο όριο έχει εξαντληθεί, το κελί δείχνει ποιο
  // ήταν (100%s / 100%w / 100%m) και μετράει αντίστροφα μέχρι να ελευθερωθεί.
  function barCells(d, now) {
    return ['go', 'claude'].map((svc) => {
      const src = d && d[svc];
      const name = svc === 'go' ? (src && src.product === 'go-plus' ? 'Go+' : 'Go') : 'Claude';
      const wins = WIN.map((w) => ({ w, x: src && src[w] })).filter((o) => o.x && Number.isFinite(o.x.pct));
      if (!wins.length) return { svc, name, main: '—', left: '', color: '#9aa2af', dep: false };
      const color = colorOf(Math.max(...wins.map((o) => o.x.pct)));   // ό,τι πιο «καυτό» βάφει το κελί
      const dep = wins
        .filter((o) => o.x.depleted === true || o.x.pct >= 100)
        .sort((a, b) => (a.x.resetsAt || Infinity) - (b.x.resetsAt || Infinity));
      if (dep.length) {
        const o = dep[0];
        return { svc, name, main: '100%' + o.w[0], left: o.x.resetsAt ? fmtHM(o.x.resetsAt - now) : '—', color, dep: true };
      }
      const sess = src && src.session && Number.isFinite(src.session.pct) ? src.session : null;
      const main = fmtPct(sess ? sess.pct : Math.max(...wins.map((o) => o.x.pct)));
      return { svc, name, main, left: sess && sess.resetsAt ? fmtHM(sess.resetsAt - now) : '', color, dep: false };
    });
  }
  const barText = (cells) => {
    const shown = (cells || []).filter((c) => c.main !== '—');
    return shown.length ? shown.map((c) => c.name + ' ' + c.main + (c.left ? ' ⟳' + c.left : '')).join(' · ') : '—';
  };
  // #endregion pure

  // ─── αποθήκευση (θέση / ανοιχτό-κλειστό / org) ────────────────────────────
  function sget(k, d) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(k, d);
      const v = localStorage.getItem('lim.' + k);
      return v == null ? d : JSON.parse(v);
    } catch (e) { return d; }
  }
  function sset(k, v) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(k, v);
      else localStorage.setItem('lim.' + k, JSON.stringify(v));
    } catch (e) { /* ignore */ }
  }

  // ─── UI ───────────────────────────────────────────────────────────────────
  const host = document.createElement('div');
  host.id = 'ax-quick-limits';
  host.style.visibility = 'hidden';           // φαίνεται στο τέλος, αφού μπει στη θέση
  const sh = host.attachShadow({ mode: 'open' });
  const panelBg = (a) => `rgba(14,16,22,${a})`;
  sh.innerHTML = `
  <style>
    :host { all: initial; }
    .wrap, .wrap * { box-sizing: border-box; margin: 0; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    .wrap {
      position: fixed; left: 12px; bottom: 44px; z-index: 2147483647;   /* κάτω αριστερά — το QuickVAT μένει κάτω δεξιά */
      font-size: 12px; line-height: 1.4; color: #e6e9ee; text-align: left; direction: ltr;
    }
    .panel {
      width: 330px; background: ${panelBg(ALPHA)};
      -webkit-backdrop-filter: blur(9px) saturate(1.1); backdrop-filter: blur(9px) saturate(1.1);
      border: 1px solid rgba(255,255,255,.18); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35); overflow: hidden;
      transition: background .15s;
    }
    .wrap:hover .panel { background: ${panelBg(Math.min(1, ALPHA + 0.32))}; }
    header { display: flex; align-items: center; gap: 6px; padding: 5px 7px;
             background: rgba(255,255,255,.05); user-select: none; cursor: default; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex: 0 0 auto; }
    header .title { font-weight: 600; letter-spacing: .3px; }
    header .grow { flex: 1 1 auto; }
    header button { background: transparent; border: 0; color: #9aa2af; font-size: 13px; line-height: 1;
                    padding: 2px 6px; border-radius: 5px; cursor: pointer; }
    header button:hover { background: rgba(255,255,255,.14); color: #fff; }
    #ref.busy { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .wrap:not(.open) .title { display: none; }
    .pill { display: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .wrap:not(.open) .pill { display: inline; }
    .pill .t { color: #98a1ad; }
    .pill .dep { color: #ff9b9b; font-weight: 600; }
    .pill .muted { color: #9aa2af; }
    .body { display: none; padding: 6px 7px 7px; }
    .wrap.open .body { display: block; }
    .grid { display: grid; grid-template-columns: 58px 1fr 1fr; gap: 1px 6px; align-items: center; }
    .hd { font-size: 10px; font-weight: 600; color: #9aa2af; text-transform: uppercase;
          letter-spacing: .5px; padding-bottom: 2px; }
    .hd.go { color: #a3b8ff; } .hd.cl { color: #ffb8a3; }
    .lab { color: #9aa2af; font-size: 11px; }
    .cell { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cell .v { font-size: 13px; font-weight: 600; }
    .cell .r { font-size: 10px; color: #98a1ad; margin-left: 4px; }
    .cell.dep .r { color: #ff9b9b; font-weight: 600; }
    .note { margin-top: 5px; font-size: 10px; color: #8b93a1; min-height: 12px; }
    .note.bad { color: #ff9b9b; }
    .cfg { margin-top: 6px; padding-top: 5px; border-top: 1px solid rgba(255,255,255,.12); }
    .cfg[hidden] { display: none; }
    .cfgline { display: flex; align-items: center; gap: 5px; }
    .cfgline input { flex: 1 1 auto; min-width: 0; background: rgba(255,255,255,.08); color: inherit;
                     border: 1px solid rgba(255,255,255,.18); border-radius: 5px; padding: 2px 5px; font: inherit; }
    .cfgline input:focus { outline: 1px solid #7aa2ff; }
    .cfgline button { background: transparent; border: 0; color: #9aa2af; font-size: 13px; line-height: 1;
                      padding: 2px 6px; border-radius: 5px; cursor: pointer; }
    .cfgline button:hover { background: rgba(255,255,255,.14); color: #fff; }
    .cfghint { margin-top: 3px; font-size: 10px; color: #8b93a1; }
  </style>
  <div class="wrap">
    <div class="panel">
      <header id="hdr">
        <span class="dot" id="dot"></span>
        <span class="title">Limits</span>
        <span class="pill" id="pill">…</span>
        <span class="grow"></span>
        <button id="cfg" title="ρυθμίσεις (workspace id)">⚙</button>
        <button id="ref" title="ανανέωση">↻</button>
        <button id="fold" title="σύμπτυξη">–</button>
      </header>
      <div class="body">
        <div class="grid">
          <div class="hd"></div><div class="hd go" id="hGo">Go</div><div class="hd cl">Claude</div>
          <div class="lab">session</div><div class="cell" id="gSession"></div><div class="cell" id="cSession"></div>
          <div class="lab">weekly</div><div class="cell" id="gWeekly"></div><div class="cell" id="cWeekly"></div>
          <div class="lab">monthly</div><div class="cell" id="gMonthly"></div><div class="cell" id="cMonthly"></div>
        </div>
        <div class="note" id="note"></div>
        <div class="cfg" id="cfgRow" hidden>
          <div class="cfgline">
            <span class="lab">workspace id</span>
            <input id="wsIn" type="text" placeholder="wrk_… / org_…" spellcheck="false" autocomplete="off" />
            <button id="wsSave" title="αποθήκευση">✓</button>
          </div>
          <div class="cfghint">OpenCode Go: το id μέσα στο URL του console — opencode.ai/console/&lt;εδώ&gt;…</div>
        </div>
      </div>
    </div>
  </div>`;

  const $ = (id) => sh.getElementById(id);
  const wrap = sh.querySelector('.wrap');
  const CELLS = {
    go:     { session: $('gSession'), weekly: $('gWeekly'), monthly: $('gMonthly') },
    claude: { session: $('cSession'), weekly: $('cWeekly'), monthly: $('cMonthly') },
  };

  // ─── κατάσταση ────────────────────────────────────────────────────────────
  const data = {
    go:     { session: null, weekly: null, monthly: null, err: null, at: 0 },
    claude: { session: null, weekly: null, monthly: null, err: null, at: 0 },
  };
  let claudeOrg = sget('claudeOrg', null);
  let ws = validWs(sget('ws', '')) || '';
  // αν περάσεις από το console του opencode.ai, κράτα το workspace id μόνο του
  (function autoWs() {
    const m = /^https?:\/\/opencode\.ai\/console\/((?:org_|wrk_)[A-Za-z0-9]+)/.exec(location.href);
    if (m && !ws && validWs(m[1])) { ws = m[1]; sset('ws', ws); }
  })();

  // ─── δίκτυο (με τα cookies του browser — δουλεύει αν είσαι συνδεδεμένος) ──
  function xhrGet(url, cb, headers) {
    const h = Object.assign({ Accept: 'application/json, text/html;q=0.9, */*;q=0.8' }, headers || {});
    const done = (status, text) => cb(Number(status) || 0, String(text || ''));
    try {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET', url, timeout: 20000, headers: h,
          onload: (r) => done(r.status, r.responseText),
          onerror: () => done(0, ''),
          ontimeout: () => done(0, ''),
        });
        return;
      }
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
        GM.xmlHttpRequest({ method: 'GET', url, timeout: 20000, headers: h })
          .then((r) => done(r.status, r.responseText), () => done(0, ''));
        return;
      }
      fetch(url, { credentials: 'include', headers: h })
        .then((r) => r.text().then((t) => done(r.status, t)), () => done(0, ''));
    } catch (e) { done(0, ''); }
  }
  const jparse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };

  function fetchClaude(again) {
    const grab = (org) => xhrGet(claudeUsageUrl(org), (st, txt) => {
      const j = st === 200 ? jparse(txt) : null;
      const u = parseClaudeUsage(j);
      if (u) {
        Object.assign(data.claude, u, { err: null, at: Date.now() });
      } else {
        data.claude.err = st === 200 ? 'Claude: μη αναγνωρίσιμη απάντηση' : `Claude: HTTP ${st} (συνδεδεμένος στο claude.ai;)`;
        data.claude.at = Date.now();
      }
      render();
    });
    if (claudeOrg && !again) { grab(claudeOrg); return; }
    let orgsUrl = CLAUDE_ORGS;
    xhrGet(orgsUrl, (st, txt) => {
      const j = st === 200 ? jparse(txt) : null;
      const org = parseClaudeOrgs(j);
      if (!org) {
        data.claude.err = `Claude: δεν βρέθηκε org (HTTP ${st}) — συνδεδεμένος στο claude.ai;`;
        data.claude.at = Date.now();
        render();
        return;
      }
      claudeOrg = org;
      sset('claudeOrg', org);
      grab(org);
    });
  }

  function fetchOpenCode() {
    if (!ws) {   // χωρίς workspace id δεν υπάρχει τι να ρωτήσουμε
      data.go.err = 'OpenCode: όρισε το workspace id (⚙) — είναι μέσα στο URL του console';
      data.go.at = Date.now();
      render();
      return;
    }
    const urls = wsUrls(ws);
    let i = 0, last = null;
    const tryNext = () => {
      if (i >= urls.length) {
        const d = last ? `HTTP ${last.st}${last.msg ? ' — ' + last.msg : ''}` : 'καμία απάντηση';
        data.go.err = `OpenCode: ${d} (συνδεδεμένος στο opencode.ai;)`;
        data.go.at = Date.now();
        render();
        return;
      }
      const url = urls[i++];
      xhrGet(url, (st, txt) => {
        const j = st === 200 ? jparse(txt) : null;
        const u = parseOpenCodeStatus(j);
        if (u) {
          Object.assign(data.go, u, { err: null, at: Date.now() });
          render();
          return;
        }
        last = { st, msg: String(txt || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
        if (st === 401 || st === 403) i = urls.length;       // θέμα σύνδεσης, όχι URL — μη δοκιμάζεις άλλα
        tryNext();
      }, { 'x-org-id': ws });                                // το console API το απαιτεί (400 OrgRequired χωρίς αυτό)
    };
    tryNext();
  }

  function refresh(force) {
    const now = Date.now();
    if (force || now - data.claude.at > TTL.claude) { data.claude.at = now; fetchClaude(false); }
    if (force || now - data.go.at > TTL.opencode) { data.go.at = now; fetchOpenCode(); }
  }

  // ─── σχεδίαση ─────────────────────────────────────────────────────────────
  function cellHtml(x, now) {
    if (!x || !Number.isFinite(x.pct)) return { html: '<span class="v">—</span>', dep: false };
    const left = x.resetsAt ? fmtHM(x.resetsAt - now) : '';
    const dep = x.depleted === true || x.pct >= 100;
    const r = left ? `<span class="r">⟳${left}</span>` : '';
    return {
      html: `<span class="v" style="color:${colorOf(x.pct)}">${fmtPct(x.pct)}</span>${r}`,
      dep,
    };
  }

  function render() {
    const now = Date.now();
    for (const svc of ['go', 'claude']) {
      for (const w of WIN) {
        const c = CELLS[svc][w];
        const { html, dep } = cellHtml(data[svc][w], now);
        c.innerHTML = html;
        c.classList.toggle('dep', dep);
      }
    }
    const worst = worstOf(data);
    const cells = barCells(data, now);
    $('pill').innerHTML = cells
      .map((c) => (c.main === '—'
        ? `<span class="muted">${c.name} —</span>`
        : `<span style="color:${c.color};font-weight:600">${c.name}</span> ${c.main}`
          + (c.left ? ` <span class="${c.dep ? 'dep' : 't'}">⟳${c.left}</span>` : '')))
      .join(' <span class="muted">·</span> ');
    $('pill').title = barText(cells);
    $('hGo').textContent = data.go.product === 'go-plus' ? 'Go+' : 'Go';
    const goFull = data.go.product === 'go-plus' ? 'OpenCode Go Plus' : 'OpenCode Go';
    $('dot').style.background = worst ? colorOf(worst.pct) : '#6b7280';
    const errs = ['go', 'claude'].map((s) => data[s].err).filter(Boolean);
    const stamps = ['go', 'claude'].map((s) => data[s].at).filter(Boolean);
    const note = $('note');
    if (errs.length) {
      note.textContent = errs.join(' · ');
      note.classList.add('bad');
    } else if (stamps.length) {
      const t = new Date(Math.max(...stamps));
      note.textContent = 'ενημερώθηκε ' + t.toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit' });
      note.classList.remove('bad');
    }
    $('hdr').title = ['go', 'claude'].map((s) => {
      const parts = WIN.map((w) => {
        const x = data[s][w];
        return x && Number.isFinite(x.pct) ? `${w} ${fmtPct(x.pct)}${x.resetsAt ? ' (⟳' + fmtHM(x.resetsAt - now) + ')' : ''}` : null;
      }).filter(Boolean);
      return (s === 'go' ? goFull : 'Claude') + ': ' + (parts.length ? parts.join(', ') : (data[s].err || '—'));
    }).join('\n');
  }

  // ─── θέση / σύμπτυξη (ίδια λογική με το QuickVAT) ─────────────────────────
  let customPos = sget('x', null) != null && sget('y', null) != null;
  function place(x, y) {
    x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 40));
    y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 24));
    wrap.style.left = x + 'px';
    wrap.style.top = y + 'px';
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
    customPos = true;
  }
  function savePos() {
    sset('x', parseFloat(wrap.style.left) || 0);
    sset('y', parseFloat(wrap.style.top) || 0);
  }
  // προεπιλεγμένη θέση: κολλημένο κάτω αριστερά (το QuickVAT ζει κάτω δεξιά, οπότε
  // δεν επικαλύπτονται ό,τι κι αν είναι ανοιχτό) — η μπάρα πάει στην άκρη όταν
  // συμπτύσσεται· χειροκίνητη θέση μένει εκεί που την άφησες.
  function setOpen(open, save) {
    if (open !== wrap.classList.contains('open')) {
      wrap.classList.toggle('open', open);
      if (customPos) {
        const r = wrap.getBoundingClientRect();
        wrap.style.left = r.left + 'px';
        wrap.style.top = r.top + 'px';
        const n = wrap.getBoundingClientRect();
        if (n.bottom > window.innerHeight - 4) wrap.style.top = Math.max(0, window.innerHeight - n.height - 12) + 'px';
        if (n.right > window.innerWidth - 4) wrap.style.left = Math.max(0, window.innerWidth - n.width - 12) + 'px';
      }
      if (save !== false) sset('open', open);
    }
    $('fold').textContent = open ? '–' : '+';
    render();
  }

  let drag = null;
  $('hdr').addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    drag = { x: e.clientX, y: e.clientY, moved: false, rect: wrap.getBoundingClientRect() };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    place(drag.rect.left + dx, drag.rect.top + dy);
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) savePos();
    else setOpen(!wrap.classList.contains('open'));     // απλό κλικ στην μπάρα = άνοιξε/κλείσε
  });
  // διπλό κλικ στην μπάρα → πίσω στην προεπιλεγμένη θέση (κάτω αριστερά)
  $('hdr').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    customPos = false;
    sset('x', null);
    sset('y', null);
    wrap.style.left = '';
    wrap.style.top = '';
    wrap.style.right = '';
    wrap.style.bottom = '';
  });
  window.addEventListener('resize', () => {
    if (wrap.style.left) place(parseFloat(wrap.style.left), parseFloat(wrap.style.top));
  });

  $('fold').addEventListener('click', () => setOpen(!wrap.classList.contains('open')));

  // ⚙ → workspace id του OpenCode Go (δεν υπάρχει τίποτα «καμένο» μέσα στο script)
  function saveWs() {
    const v = validWs($('wsIn').value);
    if (!v) {
      data.go.err = 'OpenCode: μη έγκυρο workspace id — θέλει org_… ή wrk_… (χωρίς κενά/URL)';
      render();
      return;
    }
    ws = v;
    sset('ws', ws);
    $('cfgRow').hidden = true;
    refresh(true);
  }
  $('cfg').addEventListener('click', (e) => {
    e.stopPropagation();
    const row = $('cfgRow');
    row.hidden = !row.hidden;
    if (!row.hidden) { $('wsIn').value = ws || ''; $('wsIn').focus(); }
  });
  $('wsSave').addEventListener('click', (e) => { e.stopPropagation(); saveWs(); });
  $('wsIn').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); saveWs(); }
  });
  $('ref').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = $('ref');
    b.classList.add('busy');
    refresh(true);
    setTimeout(() => b.classList.remove('busy'), 1200);
  });

  // Alt+W → άνοιξε/κλείσε (η θέση μένει)
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === HOTKEY.code) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!wrap.classList.contains('open'));
      refresh(false);
    }
  }, true);

  // ─── τοποθέτηση & εκκίνηση ────────────────────────────────────────────────
  document.documentElement.appendChild(host);
  document.addEventListener('fullscreenchange', () => {
    host.style.display = document.fullscreenElement ? 'none' : '';
  });

  setOpen(sget('open', false) === true, false);        // θυμάται αν το άφησες ανοιχτό
  if (sget('x', null) != null && sget('y', null) != null) place(sget('x', 0), sget('y', 0));
  render();
  host.style.visibility = '';
  refresh(true);

  // ένα χρονόμετρο: ενημερώνει τις αντίστροφες μετρήσεις κάθε δευτερόλεπτο και
  // τραβάει νέα δεδομένα μία φορά το λεπτό (όσο η σελίδα είναι ορατή)
  let tickN = 0;
  setInterval(() => {
    if (document.hidden) return;
    tickN += 1;
    if (tickN % Math.max(1, Math.round(AUTO_MS / 1000)) === 0) refresh(false);
    render();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { refresh(false); render(); }
  });
})();
