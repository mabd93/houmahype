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
  var msg = 'Safe sync. Players: ' + p.create + ' created, ' + p.update + ' updated, ' + p.same + ' unchanged' +
    (p.startChanged ? ', ' + p.startChanged + ' changed Starting Barhams waiting for approval (not applied)' : '') + '.';
  if (p.create || p.update || p.startChanged) log_(msg);
  toast_(msg);
}

function syncNow() {
  var p = syncPlayers_(false);
  var st = syncStaff_();
  var pr = syncPrices_();
  var msg = 'Sync now. Players: ' + p.create + ' created, ' + p.update + ' updated, ' + p.same + ' unchanged. Staff directory: ' + st.dir +
    ', logins linked: ' + st.linked + ', logins removed: ' + st.removed + (st.noAccount.length ? ', no account yet for: ' + st.noAccount.join(', ') : '') +
    '. Prices: ' + pr.items + ' items, ' + pr.rules + ' rules.';
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
      writes.push({ update: { name: DOCS + '/players_private/' + p.code, fields: fields_(priv) } });
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
