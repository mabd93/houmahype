'use strict';
/*
 * Lifetime player accounts.
 *
 *   players_secret/{code}   server only: { salt, hash, fails, lockUntil, uid, claimedAt }   (activation code of this event's wristband)
 *   players_private/{code}  staff + the owner (uid): name, phone, T-shirt, meal ...  (+ uid, linked:true once activated)
 *   players/{code}          public: + mid (member ID), so "wristband code + password" can sign in
 *   members/{uid}           owner + staff: { memberId, codes:{eventId:code}, events:{eventId:{points,rank,...}}, createdAt }
 *
 * The student activates ONCE with the activation code printed for them and chooses a password. In later events the same account
 * links the new wristband code with a new activation code, so the points add up over time.
 */
const crypto = require('crypto');
const { Fail, staffOf, isFull } = require('./core');

const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000, MIN_PASSWORD = 8;
const EMAIL_DOMAIN = 'members.houmahype.com';
const hashAct = (salt, code, act) => crypto.createHash('sha256').update(salt + ':' + code + ':' + act).digest('hex');
const sameHash = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const digits = s => String(s || '').replace(/\D/g, '');
const cleanCode = s => String(s || '').trim().toUpperCase();
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newMemberId(rand) { let s = ''; for (let i = 0; i < 8; i++) s += ID_CHARS[Math.floor(rand() * ID_CHARS.length)]; return s; }

async function eventId(db) { const d = await db.collection('meta').doc('event').get(); return (d.exists && d.data().id) || 'event4'; }

/* Checks the activation code. Wrong tries are counted and committed (so we return a verdict instead of throwing inside the transaction). */
async function checkActivation(db, code, activation, now) {
  const v = await db.runTransaction(async tx => {
    const ref = db.collection('players_secret').doc(code), s = await tx.get(ref);
    if (!s.exists) return { err: ['not-found', 'This wristband has no activation code yet. Ask an organizer.'] };
    const d = s.data();
    if (d.uid) return { err: ['already-exists', 'This wristband is already activated. Sign in with your password.'] };
    if (d.lockUntil && d.lockUntil > now) return { err: ['resource-exhausted', 'Too many wrong tries. Wait 15 minutes or ask an organizer.'] };
    if (sameHash(hashAct(d.salt, code, digits(activation)), d.hash)) return { ok: true };
    const fails = (d.fails || 0) + 1, lock = fails >= MAX_FAILS;
    tx.update(ref, { fails: lock ? 0 : fails, lockUntil: lock ? now + LOCK_MS : 0 });
    return { err: ['permission-denied', lock ? 'Too many wrong tries. Wait 15 minutes or ask an organizer.' : 'Wrong activation code.'] };
  });
  if (v.err) throw new Fail(v.err[0], v.err[1]);
}

/* First time: wristband code + activation code + a password of the student's choice. Creates the lifetime account. */
async function claimAccount(db, auth, data, opt) {
  const now = (opt && opt.now) || Date.now(), rand = (opt && opt.rand) || Math.random;
  const code = cleanCode(data.code), password = String(data.password || '');
  if (!/^[A-Z0-9-]{3,12}$/.test(code)) throw new Fail('invalid-argument', 'Type the code printed on your wristband.');
  if (password.length < MIN_PASSWORD) throw new Fail('invalid-argument', 'Your password needs at least ' + MIN_PASSWORD + ' characters.');
  if (!(await db.collection('players').doc(code).get()).exists) throw new Fail('not-found', 'This wristband code does not exist.');
  await checkActivation(db, code, data.activation, now);
  const ev = await eventId(db);
  const memberId = newMemberId(rand), email = memberId + '@' + EMAIL_DOMAIN;
  const user = await auth.createUser({ email, password });
  try {
    await db.runTransaction(async tx => {
      const sRef = db.collection('players_secret').doc(code), s = await tx.get(sRef);
      if (s.data().uid) throw new Fail('already-exists', 'This wristband is already activated. Sign in with your password.');
      tx.update(sRef, { uid: user.uid, claimedAt: now, fails: 0, lockUntil: 0 });
      tx.set(db.collection('players_private').doc(code), { uid: user.uid, linked: true }, { merge: true });
      tx.set(db.collection('players').doc(code), { mid: memberId }, { merge: true });
      tx.set(db.collection('members').doc(user.uid), { memberId, email, createdAt: now, codes: { [ev]: code }, events: {} });
    });
  } catch (e) { await auth.deleteUser(user.uid).catch(() => {}); throw e; }
  return { memberId, email };
}

/* Later events: a signed-in member links the NEW wristband with its activation code. */
async function linkBand(db, uid, data, opt) {
  const now = (opt && opt.now) || Date.now();
  if (!uid) throw new Fail('unauthenticated', 'Sign in first.');
  const code = cleanCode(data.code);
  if (!/^[A-Z0-9-]{3,12}$/.test(code)) throw new Fail('invalid-argument', 'Type the code printed on your wristband.');
  const mRef = db.collection('members').doc(uid);
  if (!(await mRef.get()).exists) throw new Fail('failed-precondition', 'No account found. Activate first.');
  if (!(await db.collection('players').doc(code).get()).exists) throw new Fail('not-found', 'This wristband code does not exist.');
  await checkActivation(db, code, data.activation, now);
  const ev = await eventId(db);
  await db.runTransaction(async tx => {
    const sRef = db.collection('players_secret').doc(code), s = await tx.get(sRef), m = await tx.get(mRef);
    if (s.data().uid) throw new Fail('already-exists', 'This wristband is already activated.');
    const md = m.data();
    tx.update(sRef, { uid, claimedAt: now, fails: 0, lockUntil: 0 });
    tx.set(db.collection('players_private').doc(code), { uid, linked: true }, { merge: true });
    tx.set(db.collection('players').doc(code), { mid: md.memberId }, { merge: true });
    tx.update(mRef, { codes: Object.assign({}, md.codes || {}, { [ev]: code }) });
  });
  return { ok: true };
}

/* Full staff, at the end of the event: store each linked member's final team score and rank, so lifetime points add up. Safe to run again. */
async function closeEvent(db, uid, data) {
  const st = await staffOf(db, uid);
  if (!isFull(st)) throw new Fail('permission-denied', 'Only Full staff can close the event.');
  const ev = String(data.event || (await eventId(db)));
  const lb = await db.collection('meta').doc('leaderboard').get();
  if (!lb.exists) throw new Fail('failed-precondition', 'There is no leaderboard yet.');
  const teams = lb.data().teams || [], byKey = {};
  teams.forEach(t => { byKey[t.k] = { points: t.p, rank: 1 + teams.filter(o => o.p > t.p).length, n: teams.length }; });
  const linked = (await db.collection('players_private').where('linked', '==', true).get()).docs;
  let done = 0;
  for (let i = 0; i < linked.length; i += 100) {
    const chunk = linked.slice(i, i + 100);
    await db.runTransaction(async tx => {
      const rows = [];
      for (const d of chunk) {
        const code = d.id, u = d.data().uid;
        const p = await tx.get(db.collection('players').doc(code)), m = await tx.get(db.collection('members').doc(u));
        if (p.exists && m.exists) rows.push({ code, u, p: p.data(), m: m.data() });
      }
      rows.forEach(r => {
        const k = r.p.camp + '|' + r.p.teamName, t = byKey[k];
        if (!t) return;
        const events = Object.assign({}, r.m.events || {}, { [ev]: { points: t.points, rank: t.rank, of: t.n, team: r.p.teamName, camp: r.p.camp, code: r.code } });
        const lifetime = Object.keys(events).reduce((s, e) => s + (events[e].points || 0), 0);
        tx.update(db.collection('members').doc(r.u), { events, lifetime });
        done++;
      });
    });
  }
  return { updated: done };
}

module.exports = { claimAccount, linkBand, closeEvent, hashAct };
