/**
 * HoumaHype Control -> app (Firebase project houmahype-bb4f9) sync.
 * Lives in the HoumaHype Control sheet: Extensions > Apps Script.
 *
 * Menu "HoumaHype":
 *   Dry run (no writes)      counts what would change, writes nothing, needs no key
 *   Safe sync (players)      players only: names, teams, nicknames, new players. Runs every 5 minutes once the trigger is installed
 *   Sync now (everything)    players + staff roles and permissions + prices and rules
 *   Install 5-minute trigger runs Safe sync every 5 minutes
 *
 * Rules the script follows:
 *   - Starting Barhams are written ONCE, when a player document is first created. Never overwritten afterwards.
 *   - Barhams and Aura (the sheet's "Score") are never touched on an existing player.
 *   - Names, phones, school and other private details go to players_private (staff only), never to players (public).
 *   - Roles, permissions and prices are applied only by "Sync now (everything)", never by the 5-minute trigger.
 *
 * One-time setup: Project Settings > Script properties > add SA_KEY = the whole service account JSON key.
 */

var PROJECT_ID = 'houmahype-bb4f9';
var DOCS = 'projects/' + PROJECT_ID + '/databases/(default)/documents';
var API = 'https://firestore.googleapis.com/v1/' + DOCS;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('HoumaHype')
    .addItem('Dry run (no writes)', 'dryRun')
    .addItem('Safe sync (players)', 'safeSync')
    .addItem('Sync now (everything)', 'syncNow')
    .addSeparator()
    .addItem('Create Matches tab (pairings)', 'createMatchesTab')
      .addItem('Create activation codes', 'createActivationCodes')
    .addItem('Apply changed Starting Barhams', 'applyStartingBarhams')
    .addItem('Install 5-minute trigger', 'installTrigger')
    .addItem('Remove 5-minute trigger', 'removeTrigger')
    .addToUi();
}

/* ---------- entry points ---------- */

function dryRun() {
  var p = syncPlayers_(true);
  var s = readStaff_();
  var pr = readPrices_();
  var msg = 'DRY RUN (nothing written). Players: ' + p.create + ' to create, ' + p.update + ' to update, ' + p.same + ' unchanged, ' +
    p.startChanged + ' with a changed Starting Barhams (not applied). Staff rows: ' + s.length + ' (' + s.filter(function (x) { return x.active; }).length + ' active). Price items: ' +
    pr.items.length + ', rules: ' + pr.rules.length + '.';
  log_(msg);
  toast_(msg);
}

function safeSync() {
  var p = syncPlayers_(false);
  var ac = syncActivation_();
  var msg = 'Safe sync. Players: ' + p.create + ' created, ' + p.update + ' updated, ' + p.same + ' unchanged' +
    (p.startChanged ? ', ' + p.startChanged + ' changed Starting Barhams waiting for approval (not applied)' : '') + '.' + (ac.n ? ' Activation codes created: ' + ac.n + '.' : '');
  if (p.create || p.update || p.startChanged || ac.n) log_(msg);
  toast_(msg);
}

function syncNow() {
  var p = syncPlayers_(false);
  var st = syncStaff_();
  var pr = syncPrices_();
  var mt = syncMatches_();
  var ec = syncEvent_();
  var ac = syncActivation_();
  var msg = 'Sync now. Players: ' + p.create + ' created, ' + p.update + ' updated, ' + p.same + ' unchanged. Staff directory: ' + st.dir +
    ', logins linked: ' + st.linked + ', logins removed: ' + st.removed + (st.noAccount.length ? ', no account yet for: ' + st.noAccount.join(', ') : '') +
    '. Prices: ' + pr.items + ' items, ' + pr.rules + ' rules. ' + mt.text + ' ' + ec + ' Activation codes created: ' + ac.n + '.';
  log_(msg);
  toast_(msg);
}

function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('safeSync').timeBased().everyMinutes(5).create();
  toast_('Safe sync will run every 5 minutes.');
}

function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'safeSync') ScriptApp.deleteTrigger(t);
  });
}

/* ---------- reading the sheet ---------- */

function sheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('Tab not found: ' + name);
  return s;
}

function readPlayers_() {
  var v = sheet_('Players').getRange('A2:M201').getValues();
  var out = [];
  v.forEach(function (r) {
    var code = String(r[0]).trim(), name = String(r[5]).trim();
    if (!code || !name) return; // empty slot: created later, when a player is added in Status
    out.push({
      code: code, camp: String(r[1]).trim(), teamName: String(r[2]).trim(), school: String(r[3]).trim(), color: String(r[4]).trim(),
      name: name, phone: String(r[6]).trim(), paid: r[7] === '' ? '' : String(r[7]), tshirt: String(r[8]).trim(), meal: String(r[9]).trim(),
      start: Number(r[10]) || 0, nick: String(r[11]).trim()
    });
  });
  return out;
}

function readStaff_() {
  var v = sheet_('Staff').getRange('A2:M51').getValues();
  var out = [];
  v.forEach(function (r) {
    var id = String(r[0]).trim();
    if (!id) return;
    out.push({
      id: id, name: String(r[1]).trim(), role: String(r[2]).trim(), mode: String(r[3]).trim(), fixed: r[4] === '' ? null : Number(r[4]),
      station: String(r[5]).trim(), email: String(r[6]).trim().toLowerCase(), active: r[7] === true, title: String(r[8]).trim(),
      team1: String(r[9]).trim(), team2: String(r[10]).trim(), scope: String(r[11]).trim(), canScratch: r[12] === true
    });
  });
  return out;
}

function readPrices_() {
  var s = sheet_('Prices');
  var items = [], rules = [];
  s.getRange('A2:G21').getValues().forEach(function (r) {
    if (!String(r[0]).trim()) return;
    items.push({
      item: String(r[0]).trim(), type: String(r[1]).trim(), amount: r[2] === '' ? null : Number(r[2]), station: String(r[3]).trim(),
      notes: String(r[4]).trim(), freeRedbull: String(r[5]).trim(), group: String(r[6]).trim()
    });
  });
  var last = s.getLastRow();
  if (last >= 24) {
    s.getRange(24, 1, last - 23, 2).getValues().forEach(function (r) {
      if (String(r[0]).trim() && String(r[1]).trim()) rules.push({ title: String(r[0]).trim(), text: String(r[1]).trim() });
    });
  }
  return { items: items, rules: rules };
}

/* ---------- activation codes (student accounts) ----------
 * Players tab column Q "Activation code": a 6-digit code for each player, created once (only when the cell is empty).
 * The app only receives a salted hash of it. The student types it ONCE together with a password of their own to create the lifetime account.
 * To give a player a new code (lost card): clear their cell in column Q, then run "Create activation codes". Only works before activation.
 */
function hex_(bytes) { return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }

function syncActivation_() {
  // Never two runs at once (the 5-minute trigger and a manual run could otherwise create two different codes).
  var props = PropertiesService.getScriptProperties();
  if (Date.now() - Number(props.getProperty('ACT_LOCK') || 0) < 90000) return { n: 0 };
  props.setProperty('ACT_LOCK', String(Date.now()));
  try { return syncActivationInner_(); } finally { props.deleteProperty('ACT_LOCK'); }
}

function syncActivationInner_() {
  var s = sheet_('Players');
  s.getRange('Q1').setValue('Activation code').setFontWeight('bold');
  var codes = s.getRange('A2:A201').getValues(), names = s.getRange('F2:F201').getValues();
  var rng = s.getRange('Q2:Q201'); rng.setNumberFormat('@');
  var cur = rng.getValues(), writes = [], n = 0;
  for (var i = 0; i < codes.length; i++) {
    var code = String(codes[i][0]).trim();
    if (!code || !String(names[i][0]).trim() || String(cur[i][0]).trim()) continue;
    var act = String(Math.floor(100000 + Math.random() * 900000));
    var salt = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    var hash = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + code + ':' + act, Utilities.Charset.UTF_8));
    cur[i][0] = act; n++;
    writes.push({ update: { name: DOCS + '/players_secret/' + code, fields: fields_({ salt: salt, hash: hash, fails: 0, lockUntil: 0 }) }, updateMask: { fieldPaths: ['salt', 'hash', 'fails', 'lockUntil'] } });
  }
  if (n) {
    for (var j = 0; j < writes.length; j += 200) commit_(writes.slice(j, j + 200));
    rng.setValues(cur); // only after the database accepted the hashes
  }
  return { n: n };
}

function createActivationCodes() {
  var r = syncActivation_();
  toast_(r.n ? 'Created ' + r.n + ' activation codes (Players tab, column Q).' : 'Every player already has an activation code.');
}

/* ---------- event clock (for the student "My Games" tab) ----------
 * Reads the Rotation tab: B1 start time (e.g. 09:00), B2 play minutes, B3 switch minutes. The event date is set here (Cairo time, UTC+2 in December).
 */
var EVENT_ID = 'event4', EVENT_DATE = '2026-12-04', EVENT_OFFSET = '+02:00';

function syncEvent_() {
  var s = SpreadsheetApp.getActive().getSheetByName('Rotation');
  if (!s) return 'Event clock: Rotation tab missing.';
  var v = s.getRange('B1:B3').getDisplayValues();
  var t = String(v[0][0]).trim(), m = /^(\d{1,2}):(\d{2})/.exec(t);
  var play = Number(v[1][0]), chg = Number(v[2][0]);
  if (!m || !play || !chg) return 'Event clock: CHECK Rotation B1:B3 (start time, play minutes, switch minutes).';
  var hh = ('0' + m[1]).slice(-2);
  var start = EVENT_DATE + 'T' + hh + ':' + m[2] + ':00' + EVENT_OFFSET;
  commit_([{ update: { name: DOCS + '/meta/event', fields: fields_({ id: EVENT_ID, start: start, play: play, change: chg }) } }]);
  return 'Event clock: ' + start + ', ' + play + ' min play + ' + chg + ' min switch.';
}

/* ---------- round schedule (pairings) ----------
 * Tab "Matches": A Round, B Station, C MaZoo team name, D WiSoo team name, E Points (optional, fixed points for a game at that station).
 * Station must be written exactly like the Station column in the Staff tab. Team names must match the TeamName column of the Players tab.
 */
var CAMP_A = 'MaZoo', CAMP_B = 'WiSoo';

function slug_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

function createMatchesTab() {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName('Matches') || ss.insertSheet('Matches');
  s.getRange('A1:E1').setValues([['Round', 'Station', 'MaZoo team', 'WiSoo team', 'Points (optional)']]).setFontWeight('bold');
  s.setFrozenRows(1);
  toast_('Matches tab ready. One row per game: round number, station, the MaZoo team name and the WiSoo team name.');
}

function readMatches_() {
  var s = SpreadsheetApp.getActive().getSheetByName('Matches');
  if (!s || s.getLastRow() < 2) return null;
  var rows = [], fixed = {}, errors = [];
  s.getRange(2, 1, s.getLastRow() - 1, 5).getValues().forEach(function (r, i) {
    var round = Number(r[0]), station = String(r[1]).trim(), a = String(r[2]).trim(), b = String(r[3]).trim();
    if (r[0] === '' && !station && !a && !b) return;
    if (!round || !station || !a || !b) { errors.push('row ' + (i + 2)); return; }
    rows.push({ round: round, station: station, a: a, b: b });
    if (r[4] !== '' && Number(r[4]) > 0) fixed[slug_(station)] = Math.round(Number(r[4]));
  });
  return { rows: rows, fixed: fixed, errors: errors };
}

function syncMatches_() {
  var m = readMatches_();
  if (!m) return { count: 0, text: 'Matches tab: empty or missing (use "Create Matches tab").' };
  // Check the names against the Players tab so a typo cannot silently break scoring.
  var size = {};
  readPlayers_().forEach(function (p) { var k = p.camp + '|' + p.teamName; size[k] = (size[k] || 0) + 1; });
  var problems = m.errors.map(function (e) { return 'incomplete ' + e; });
  var writes = [], seen = {};
  m.rows.forEach(function (r) {
    var a = CAMP_A + '|' + r.a, b = CAMP_B + '|' + r.b;
    if (!size[a]) problems.push('no players for ' + a);
    if (!size[b]) problems.push('no players for ' + b);
    var id = r.round + '_' + slug_(r.station);
    if (seen[id]) problems.push('duplicate ' + r.station + ' in round ' + r.round);
    seen[id] = true;
    writes.push({ update: { name: DOCS + '/schedule/' + id, fields: fields_({ round: r.round, station: r.station, teamA: a, teamB: b, teams: [a, b], nameA: r.a, nameB: r.b }) } });
  });
  if (Object.keys(m.fixed).length) writes.push({ update: { name: DOCS + '/meta/gamepoints', fields: fields_({ fixed: m.fixed, max: 1000 }) } });
  for (var i = 0; i < writes.length; i += 400) commit_(writes.slice(i, i + 400));
  var rounds = {}; m.rows.forEach(function (r) { rounds[r.round] = (rounds[r.round] || 0) + 1; });
  return { count: m.rows.length, text: 'Matches: ' + m.rows.length + ' games in ' + Object.keys(rounds).length + ' rounds' +
    (problems.length ? '. CHECK: ' + problems.slice(0, 8).join('; ') + (problems.length > 8 ? '; ...' : '') : '') + '.' };
}

/* ---------- players ---------- */

function hash_(o) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(o));
  return d.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 12);
}

function syncPlayers_(dry) {
  var props = PropertiesService.getScriptProperties();
  var state = JSON.parse(props.getProperty('PLAYER_STATE') || '{}'); // code -> {h: hash, s: starting Barhams applied}
  var players = readPlayers_();
  var res = { create: 0, update: 0, same: 0, startChanged: 0 };
  var existing = null, writes = [], touched = [];

  players.forEach(function (p) {
    var pub = { code: p.code, camp: p.camp, team: p.camp, teamName: p.teamName, color: p.color };
    if (p.nick) pub.nick = p.nick;
    var priv = { code: p.code, name: p.name, phone: p.phone, school: p.school, paid: p.paid, tshirt: p.tshirt, meal: p.meal };
    var h = hash_([pub, priv]);
    var st = state[p.code];

    if (st && st.h === h) {
      res.same++;
      if (st.s !== p.start) res.startChanged++;
      return;
    }
    if (st && st.s !== p.start) res.startChanged++;

    var isNew = !st;
    if (isNew && !dry) {
      if (existing === null) existing = listExisting_();
      isNew = !existing[p.code];
    } else if (isNew && dry) {
      isNew = true; // dry run cannot see the database; assumes missing
    }

    if (isNew) {
      res.create++;
      if (!dry) {
        var full = Object.assign({}, pub);
        if (!full.nick) full.nick = 'Player ' + p.code;
        full.barhams = p.start;
        full.aura = 0;
        full.tx = p.start > 0 ? [{ t: 'Starting Barhams', d: p.start, ts: Date.now() }] : [];
        writes.push({ update: { name: DOCS + '/players/' + p.code, fields: fields_(full) }, currentDocument: { exists: false } });
      }
    } else {
      res.update++;
      if (!dry) {
        writes.push({ update: { name: DOCS + '/players/' + p.code, fields: fields_(pub) }, updateMask: { fieldPaths: Object.keys(pub) }, currentDocument: { exists: true } });
      }
    }
    if (!dry) {
      writes.push({ update: { name: DOCS + '/players_private/' + p.code, fields: fields_(priv) }, updateMask: { fieldPaths: Object.keys(priv) } });
      touched.push({ code: p.code, h: h, s: st ? st.s : p.start });
    }
  });

  if (!dry && writes.length) {
    // 2 writes per player, chunks of 200 writes stay well under the 500 limit
    for (var i = 0; i < writes.length; i += 200) commit_(writes.slice(i, i + 200));
    touched.forEach(function (t) { state[t.code] = { h: t.h, s: t.s }; });
    props.setProperty('PLAYER_STATE', JSON.stringify(state));
  }
  return res;
}

function listExisting_() {
  var out = {}, token = '';
  do {
    var url = API + '/players?pageSize=300&mask.fieldPaths=code' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    var r = fetch_(url, 'get');
    (r.documents || []).forEach(function (d) { out[d.name.split('/').pop()] = true; });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

/* ---------- apply changed Starting Barhams (before any bracelet is used) ---------- */

function applyStartingBarhams() {
  var props = PropertiesService.getScriptProperties();
  var held = Number(props.getProperty('SB_LOCK') || 0);
  if (held && Date.now() - held < 90000) throw new Error('Another run is in progress. Try again in a minute.');
  props.setProperty('SB_LOCK', String(Date.now()));
  try {
    var state = JSON.parse(props.getProperty('PLAYER_STATE') || '{}');
    var changed = [], skipped = [], writes = [];
    readPlayers_().forEach(function (p) {
      var st = state[p.code];
      if (!st || st.s === p.start) return;
      var d = fetch_(API + '/players/' + p.code, 'get');
      var tx = (d.fields && d.fields.tx && d.fields.tx.arrayValue && d.fields.tx.arrayValue.values) || [];
      var onlyStart = tx.length === 0 || (tx.length === 1 && tx[0].mapValue && tx[0].mapValue.fields.t.stringValue === 'Starting Barhams');
      if (!onlyStart) { skipped.push(p.code); return; } // player already has activity: never touch the balance
      var upd = { barhams: p.start, tx: p.start > 0 ? [{ t: 'Starting Barhams', d: p.start, ts: Date.now() }] : [] };
      writes.push({ update: { name: DOCS + '/players/' + p.code, fields: fields_(upd) }, updateMask: { fieldPaths: ['barhams', 'tx'] }, currentDocument: { updateTime: d.updateTime } });
      changed.push({ code: p.code, from: st.s, to: p.start });
    });
    for (var i = 0; i < writes.length; i += 100) commit_(writes.slice(i, i + 100));
    var fresh = JSON.parse(props.getProperty('PLAYER_STATE') || '{}');
    changed.forEach(function (c) { if (fresh[c.code]) fresh[c.code].s = c.to; });
    props.setProperty('PLAYER_STATE', JSON.stringify(fresh));
    log_('Applied changed Starting Barhams to ' + changed.length + ' players: ' + changed.map(function (c) { return c.code + ' ' + c.from + '>' + c.to; }).join(', ') + (skipped.length ? '. Skipped (already has activity): ' + skipped.join(', ') : '') + '.');
  } finally { props.deleteProperty('SB_LOCK'); }
}

/* ---------- staff ---------- */

function syncStaff_() {
  var staff = readStaff_();
  var writes = [], res = { dir: 0, linked: 0, removed: 0, noAccount: [] };

  staff.forEach(function (s) {
    var row = { id: s.id, name: s.name, role: s.role, mode: s.mode, fixed: s.fixed, station: s.station, active: s.active, title: s.title,
      team1: s.team1, team2: s.team2, scope: s.scope, canScratch: s.canScratch };
    writes.push({ update: { name: DOCS + '/staffDirectory/' + s.id, fields: fields_(row) } });
    res.dir++;
  });

  var emails = staff.filter(function (s) { return s.email; }).map(function (s) { return s.email; });
  var uidByEmail = {};
  if (emails.length) {
    var look = fetch_('https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT_ID + '/accounts:lookup', 'post', { email: emails });
    (look.users || []).forEach(function (u) { uidByEmail[String(u.email).toLowerCase()] = u.localId; });
  }
  staff.forEach(function (s) {
    if (!s.email) return;
    var uid = uidByEmail[s.email];
    if (!uid) { if (s.active) res.noAccount.push(s.id); return; }
    var name = DOCS + '/staff/' + uid;
    if (s.active) {
      writes.push({ update: { name: name, fields: fields_({ ok: true, id: s.id, name: s.name, role: s.role, mode: s.mode, fixed: s.fixed, station: s.station, scope: s.scope, canScratch: s.canScratch }) } });
      res.linked++;
    } else {
      writes.push({ delete: name });
      res.removed++;
    }
  });
  for (var i = 0; i < writes.length; i += 200) commit_(writes.slice(i, i + 200));
  return res;
}

/* ---------- prices and rules ---------- */

function syncPrices_() {
  var p = readPrices_();
  var now = new Date().toISOString();
  commit_([
    { update: { name: DOCS + '/meta/prices', fields: fields_({ updated: now, items: p.items }) } },
    { update: { name: DOCS + '/meta/rules', fields: fields_({ updated: now, rules: p.rules }) } }
  ]);
  return { items: p.items.length, rules: p.rules.length };
}

/* ---------- Firestore REST helpers ---------- */

function fields_(o) {
  var f = {};
  Object.keys(o).forEach(function (k) { f[k] = value_(o[k]); });
  return f;
}

function value_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return v % 1 === 0 ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(value_) } };
  if (typeof v === 'object') return { mapValue: { fields: fields_(v) } };
  return { stringValue: String(v) };
}

function commit_(writes) {
  fetch_(API + ':commit', 'post', { writes: writes });
}

function fetch_(url, method, body) {
  var opt = { method: method, headers: { Authorization: 'Bearer ' + token_() }, muteHttpExceptions: true, contentType: 'application/json' };
  if (body) opt.payload = JSON.stringify(body);
  var r = UrlFetchApp.fetch(url, opt);
  var code = r.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Firebase error ' + code + ': ' + r.getContentText().slice(0, 400));
  return JSON.parse(r.getContentText() || '{}');
}

function token_() {
  var cache = CacheService.getScriptCache();
  var t = cache.get('FB_TOKEN');
  if (t) return t;
  var raw = PropertiesService.getScriptProperties().getProperty('SA_KEY');
  if (!raw) throw new Error('SA_KEY is missing. Add the service account key under Project Settings > Script properties.');
  var key = JSON.parse(raw);
  var now = Math.floor(Date.now() / 1000);
  var head = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=+$/, '');
  var claim = Utilities.base64EncodeWebSafe(JSON.stringify({
    iss: key.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  })).replace(/=+$/, '');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(head + '.' + claim, key.private_key)).replace(/=+$/, '');
  var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }
  });
  if (r.getResponseCode() !== 200) throw new Error('Could not get a Firebase token: ' + r.getContentText().slice(0, 300));
  t = JSON.parse(r.getContentText()).access_token;
  cache.put('FB_TOKEN', t, 3000);
  return t;
}

/* ---------- logging ---------- */

function log_(msg) {
  sheet_('Sync Log').appendRow([Utilities.formatDate(new Date(), 'Asia/Dubai', 'yyyy-MM-dd HH:mm'), 'Players, Staff, Prices', msg, 'Script']);
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg.slice(0, 250), 'HoumaHype', 10); } catch (e) { /* trigger runs have no UI */ }
}
