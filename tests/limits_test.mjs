// Pure-logic tests for quick-limits.user.js (no DOM, no network).
import fs from 'node:fs';
import assert from 'node:assert/strict';

const SRC = new URL('../quick-limits.user.js', import.meta.url);   // το script που τρέχει ο TM
const src = fs.readFileSync(SRC, 'utf8');
const block = src.split('// #region pure')[1].split('// #endregion pure')[0];

const P = new Function(`${block}
return { WIN, validWs, parseClaudeUsage, parseClaudeOrgs, parseOpenCodeStatus, worstOf, fmtPct, fmtHM, colorOf, barCells, barText };`)();

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log('FAIL:', name, '\n   ', e.message); }
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ── Claude usage JSON (the shape claude.ai/api/organizations/<org>/usage returns)
const claudeJson = {
  five_hour: { utilization: 28, resets_at: new Date(Date.now() + 3600e3).toISOString() },
  seven_day: { utilization: 67, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  seven_day_sonnet: null, seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 28, resets_at: new Date(Date.now() + 3600e3).toISOString() },
    { kind: 'weekly_all', group: 'weekly', percent: 67, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() },
  ],
};

t('claude: basic windows', () => {
  const u = P.parseClaudeUsage(claudeJson);
  assert.equal(u.session.pct, 28);
  assert.equal(u.weekly.pct, 67);
  assert.equal(u.monthly, null, 'no monthly window on Pro/Max');
  near(u.session.resetsAt - Date.now(), 3600e3, 5000, 'session reset');
});

t('claude: limits[] fallback when five_hour/seven_day absent', () => {
  const u = P.parseClaudeUsage({ limits: claudeJson.limits });
  assert.equal(u.session.pct, 28);
  assert.equal(u.weekly.pct, 67);
});

t('claude: extra_usage enabled → monthly', () => {
  const u = P.parseClaudeUsage({ ...claudeJson, extra_usage: { is_enabled: true, monthly_limit: 200, used_credits: 16, utilization: 8 } });
  assert.equal(u.monthly.pct, 8);
});

t('claude: extra_usage computed when utilization missing', () => {
  const u = P.parseClaudeUsage({ extra_usage: { is_enabled: true, monthly_limit: 200, used_credits: 50, utilization: null } });
  assert.equal(u.monthly.pct, 25);
});

t('claude: garbage in → all-null windows', () => {
  assert.equal(P.parseClaudeUsage(null), null);
  const u = P.parseClaudeUsage({});
  assert.equal(u.session, null);
  assert.equal(u.weekly, null);
  assert.equal(u.monthly, null);
  assert.equal(P.parseClaudeUsage({ five_hour: { utilization: 'x' } }).session, null);
  assert.equal(P.parseClaudeUsage({ five_hour: { utilization: null } }).session, null, 'null utilization must not read as 0%');
  assert.equal(P.parseClaudeUsage({ five_hour: { utilization: null } }).weekly, null);
});

t('claude orgs: prefers one with chat capability', () => {
  assert.equal(P.parseClaudeOrgs([{ uuid: 'a', capabilities: ['api'] }, { uuid: 'b', capabilities: ['chat', 'api'] }]), 'b');
  assert.equal(P.parseClaudeOrgs([{ uuid: 'only' }]), 'only');
  assert.equal(P.parseClaudeOrgs(null), null);
});

// ── OpenCode Go: /console/api/go/status JSON (micro-cents; mirrors the console's own maths)
const ocStatus = {
  product: 'go', cancelAtPeriodEnd: false, useBalance: false,
  access: {
    startsAt: new Date(Date.now() - 86400e3).toISOString(),
    endsAt: new Date(Date.now() + 20 * 86400e3).toISOString(),
    meters: {
      fiveHour: { resetsAt: new Date(Date.now() + 3600e3).toISOString(), limitMicroCents: 1200000000, usedMicroCents: 1200000000 },
      week: { resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString(), limitMicroCents: 3000000000, usedMicroCents: 1200000000 },
      month: { resetsAt: new Date(Date.now() + 20 * 86400e3).toISOString(), limitMicroCents: 6000000000, usedMicroCents: 3600000000 },
    },
  },
};

t('opencode: meters → percentages, resets and depletion', () => {
  const now = Date.now();
  const u = P.parseOpenCodeStatus(ocStatus);
  assert.equal(u.session.pct, 100);
  assert.equal(u.session.depleted, true);
  assert.equal(u.weekly.pct, 40);
  assert.equal(u.weekly.depleted, false);
  assert.equal(u.monthly.pct, 60);
  assert.equal(u.product, 'go');
  near(u.session.resetsAt - now, 3600e3, 5000, 'rolling reset');
  near(u.monthly.resetsAt - now, 20 * 86400e3, 5000, 'monthly reset');
});

t('opencode: micro-cents arriving as strings (BigInt serialization)', () => {
  const j = JSON.parse(JSON.stringify(ocStatus, (k, v) => (typeof v === 'number' && k.endsWith('MicroCents') ? String(v) : v)));
  const u = P.parseOpenCodeStatus(j);
  assert.equal(u.weekly.pct, 40);
  assert.equal(u.monthly.pct, 60);
});

t('opencode: rounds like the console (and past-limit → 100%)', () => {
  const mk = (used, limit) => ({ access: { meters: { fiveHour: { limitMicroCents: limit, usedMicroCents: used } } } });
  assert.equal(P.parseOpenCodeStatus(mk(1, 3)).session.pct, 33);
  assert.equal(P.parseOpenCodeStatus(mk(2, 3)).session.pct, 67);
  assert.equal(P.parseOpenCodeStatus(mk(5, 1000)).session.pct, 1);
  assert.equal(P.parseOpenCodeStatus(mk(6.5e9, 6e9)).session.pct, 100);
  assert.equal(P.parseOpenCodeStatus(mk(6.5e9, 6e9)).session.depleted, true);
  assert.equal(P.parseOpenCodeStatus(mk(111, 0)), null, 'zero limit → no usable data at all');
});

t('opencode: no subscription / logged out → null', () => {
  assert.equal(P.parseOpenCodeStatus(null), null);
  assert.equal(P.parseOpenCodeStatus({}), null);
  assert.equal(P.parseOpenCodeStatus({ access: null }), null);
  assert.equal(P.parseOpenCodeStatus({ access: { meters: {} } }), null);
  assert.equal(P.parseOpenCodeStatus(JSON.parse('{"_tag":"Unauthorized"}')), null);
});

t('opencode: go-plus product passes through', () => {
  const u = P.parseOpenCodeStatus({ ...ocStatus, product: 'go-plus' });
  assert.equal(u.product, 'go-plus');
});

// ── the one that matters + formatting
const mk = (d) => ({ go: { session: null, weekly: null, monthly: null, ...d[0] }, claude: { session: null, weekly: null, monthly: null, ...d[1] } });

t('worst: picks the highest percentage across both services', () => {
  const d = mk([{ session: { pct: 20 }, weekly: { pct: 40 }, monthly: { pct: 60 } }, { session: { pct: 28 }, weekly: { pct: 67 } }]);
  assert.deepEqual([P.worstOf(d).svc, P.worstOf(d).win, P.worstOf(d).pct], ['claude', 'weekly', 67]);
});

t('worst: null when nothing loaded', () => {
  assert.equal(P.worstOf(mk([{}, {}])), null);
});

// ── η συμπτυγμένη μπάρα: και οι δύο συνδρομές, session % + H:MM αντίστροφη μέτρηση
t('bar: both services, session % and H:MM countdown', () => {
  const now = Date.now();
  const d = mk([{ session: { pct: 12, resetsAt: now + 8100e3 } }, { session: { pct: 43, resetsAt: now + 6000e3 } }]);
  const cells = P.barCells(d, now);
  assert.equal(cells.length, 2);
  assert.deepEqual(cells.map((c) => c.name), ['Go', 'Claude']);
  assert.deepEqual(cells.map((c) => c.main), ['12%', '43%']);
  assert.deepEqual(cells.map((c) => c.dep), [false, false]);
  assert.equal(P.barText(cells), 'Go 12% ⟳2:15 · Claude 43% ⟳1:40');
});

t('bar: a hot weekly tints the cell, but the session % is what is shown', () => {
  const now = Date.now();
  const [go] = P.barCells(mk([{ session: { pct: 12, resetsAt: now + 3600e3 }, weekly: { pct: 95 } }, {}]), now);
  assert.equal(go.main, '12%');
  assert.equal(go.color, '#ff9b6b');
  assert.equal(go.dep, false);
});

t('bar: exhausted window → which one + timer (earliest reset wins)', () => {
  const now = Date.now();
  const d = mk([
    { session: { pct: 100, depleted: true, resetsAt: now + 45e3 }, weekly: { pct: 100, depleted: true, resetsAt: now + 200 * 3600e3 } },
    { session: { pct: 91, resetsAt: now + 600e3 } },
  ]);
  const [go, cl] = P.barCells(d, now);
  assert.equal(go.main, '100%s');
  assert.equal(go.left, '0:45');
  assert.equal(go.dep, true);
  assert.equal(cl.main, '91%');
  assert.equal(P.barText([go, cl]), 'Go 100%s ⟳0:45 · Claude 91% ⟳0:10');
});

t('bar: missing service degrades to a dash, the other one survives', () => {
  const now = Date.now();
  assert.equal(P.barText(P.barCells(mk([{ session: { pct: 30, resetsAt: now + 60e3 } }, {}]), now)), 'Go 30% ⟳0:01');
  assert.equal(P.barText(P.barCells(mk([{}, {}]), now)), '—');
});

t('bar: go-plus name; no session → falls back to the max window', () => {
  const now = Date.now();
  const [go] = P.barCells(mk([{ product: 'go-plus', weekly: { pct: 40, resetsAt: now + 7200e3 } }, {}]), now);
  assert.equal(go.name, 'Go+');
  assert.equal(go.main, '40%');
});

t('fmtHM: H:MM counters (hours pass 24, seconds under a minute)', () => {
  assert.equal(P.fmtHM(45e3), '0:45');
  assert.equal(P.fmtHM(90e3), '0:01');
  assert.equal(P.fmtHM(3600e3 + 14 * 60e3), '1:14');
  assert.equal(P.fmtHM(4 * 86400e3 + 15 * 3600e3), '111:00');
  assert.equal(P.fmtHM(-5000), '0:00');
  assert.equal(P.fmtHM(NaN), '');
});

t('workspace id: only org_…/wrk_… accepted', () => {
  assert.equal(P.validWs('wrk_01ABCdef123456'), 'wrk_01ABCdef123456');
  assert.equal(P.validWs('  org_ABC123  '), 'org_ABC123');
  assert.equal(P.validWs('wrk_'), null);
  assert.equal(P.validWs('wrk_01234'), null);                              // πολύ κοντό
  assert.equal(P.validWs('https://opencode.ai/console/wrk_ABC123'), null); // URL, όχι id
  assert.equal(P.validWs('<script>alert(1)</script>'), null);
  assert.equal(P.validWs('abc_0123456789'), null);                         // λάθος πρόθεμα
  assert.equal(P.validWs(null), null);
});

t('format helpers', () => {
  assert.equal(P.fmtPct(4.23), '4.2%');
  assert.equal(P.fmtPct(12.5), '13%');
  assert.equal(P.fmtPct(100), '100%');
});

t('colors: thresholds', () => {
  assert.equal(P.colorOf(10), '#6ee7a0');
  assert.equal(P.colorOf(50), '#ffd166');
  assert.equal(P.colorOf(80), '#ff9b6b');
  assert.equal(P.colorOf(100), '#ff6b6b');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
