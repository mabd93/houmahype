'use strict';
const test = require('node:test'), assert = require('node:assert');
const { makeDb } = require('./fake');
const A = require('../accounts');
const core = require('../core');

function fakeAuth() { const users = new Map(); let n = 0; return { users, createUser: async ({ email, password }) => { const uid = 'u' + (++n); users.set(uid, { email, password }); return { uid }; }, deleteUser: async uid => { users.delete(uid); } }; }
function setup() {
  const db = makeDb();
  ['M001', 'M002', 'W001'].forEach(c => {
    db.put('players/' + c, { code: c, camp: c[0] === 'M' ? 'MaZoo' : 'WiSoo', teamName: c[0] === 'M' ? 'T1' : 'T9', aura: 0 });
    db.put('players_private/' + c, { name: 'Name ' + c, tshirt: 'XL', meal: 'C - Chicken' });
    db.put('players_secret/' + c, { salt: 'abc', hash: A.hashAct('abc', c, '123456'), fails: 0, lockUntil: 0 });
  });
  db.put('meta/event', { id: 'event4' });
  db.put('staff/full', { id: 'S01', scope: core.FULL, role: 'Owner' });
  return db;
}
const rejects = (p, code) => assert.rejects(p, e => e instanceof core.Fail && e.code === code);

test('activation: right code creates the account and links the wristband', async () => {
  const db = setup(), auth = fakeAuth();
  const r = await A.claimAccount(db, auth, { code: 'm001', activation: '123 456', password: 'longenough' });
  assert.match(r.memberId, /^[a-z0-9]{8}$/); assert.equal(auth.users.size, 1);
  const uid = [...auth.users.keys()][0];
  assert.equal(db.get('players_private/M001').uid, uid); assert.equal(db.get('players_private/M001').linked, true);
  assert.equal(db.get('players/M001').mid, r.memberId);
  assert.equal(db.get('members/' + uid).codes.event4, 'M001');
  assert.equal(db.get('players_private/M001').name, 'Name M001');   // merge kept the private details
  await rejects(A.claimAccount(db, auth, { code: 'M001', activation: '123456', password: 'longenough' }), 'already-exists');
});

test('wrong activation codes are counted and lock after 5 tries; short passwords and unknown codes are refused', async () => {
  const db = setup(), auth = fakeAuth(), now = 1000;
  for (let i = 0; i < 4; i++) await rejects(A.claimAccount(db, auth, { code: 'M002', activation: '000000', password: 'longenough' }, { now }), 'permission-denied');
  await rejects(A.claimAccount(db, auth, { code: 'M002', activation: '000000', password: 'longenough' }, { now }), 'permission-denied'); // 5th: locks
  await rejects(A.claimAccount(db, auth, { code: 'M002', activation: '123456', password: 'longenough' }, { now: now + 1000 }), 'resource-exhausted'); // even the right code is refused while locked
  const ok = await A.claimAccount(db, auth, { code: 'M002', activation: '123456', password: 'longenough' }, { now: now + 16 * 60 * 1000 });
  assert.ok(ok.memberId);
  await rejects(A.claimAccount(db, auth, { code: 'W001', activation: '123456', password: 'short' }), 'invalid-argument');
  await rejects(A.claimAccount(db, auth, { code: 'X999', activation: '123456', password: 'longenough' }), 'not-found');
  assert.equal(auth.users.size, 1);
});

test('later event: the same account links a new wristband; points add up after closeEvent', async () => {
  const db = setup(), auth = fakeAuth();
  await A.claimAccount(db, auth, { code: 'M001', activation: '123456', password: 'longenough' });
  const uid = [...auth.users.keys()][0];
  db.put('meta/leaderboard', { teams: [{ k: 'MaZoo|T1', p: 120 }, { k: 'WiSoo|T9', p: 150 }] });
  const r = await A.closeEvent(db, 'full', {});
  assert.equal(r.updated, 1);
  assert.equal(db.get('members/' + uid).events.event4.points, 120); assert.equal(db.get('members/' + uid).events.event4.rank, 2);
  await A.closeEvent(db, 'full', {});                                   // run twice: same result
  assert.equal(db.get('members/' + uid).lifetime, 120);
  // next event: new wristband W001 with its own activation code
  db.put('meta/event', { id: 'event5' });
  await rejects(A.linkBand(db, null, { code: 'W001', activation: '123456' }), 'unauthenticated');
  await A.linkBand(db, uid, { code: 'W001', activation: '123456' });
  assert.equal(db.get('members/' + uid).codes.event5, 'W001'); assert.equal(db.get('members/' + uid).codes.event4, 'M001');
  assert.equal(db.get('players_private/W001').uid, uid);
  db.put('meta/leaderboard', { teams: [{ k: 'MaZoo|T1', p: 10 }, { k: 'WiSoo|T9', p: 80 }] });
  await A.closeEvent(db, 'full', {});
  assert.equal(db.get('members/' + uid).lifetime, 200);                // 120 from event 4 + 80 from event 5
});

test('only Full staff can close an event', async () => {
  const db = setup(); db.put('staff/gl', { id: 'G1', scope: 'Own station only', role: 'Game Leader' });
  await rejects(A.closeEvent(db, 'gl', {}), 'permission-denied');
});
