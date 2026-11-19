'use strict';
/*
 * Server-side game logic. It only talks to the database through a small Firestore-like interface
 * (collection/doc/where/get/runTransaction), so the same code runs in Cloud Functions and in the tests.
 *
 * Data:
 *   schedule/{round}_{station}  fixed pairings from the sheet: { round, station, teamA, teamB, teams:[A,B], nameA, nameB }
 *   matches/{round}_{station}   one result per game: { result:'win'|'draw', winner, amount, ... }  (created once)
 *   rounds/{round}              written when a round is complete: the awards that were applied (so they can be reversed exactly)
 *   meta/gamepoints             optional: { max: 1000, fixed: { "<station slug>": 100 } }
 */
const S = require('./scoring');

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const FULL = 'Full: Barhams and Score';
const DEFAULT_MAX = 1000; // safety cap for one game's points, can be changed in meta/gamepoints

async function staffOf(db, uid) {
  if (!uid) throw new Fail('unauthenticated', 'Sign in first.');
  const d = await db.collection('staff').doc(uid).get();
  if (!d.exists) throw new Fail('permission-denied', 'This account is not staff.');
  const s = d.data();
  return { id: s.id || uid, name: s.name || '', scope: s.scope || FULL, role: s.role || '', station: String(s.station || '').trim() };
}
const isFull = s => s.scope === FULL;
const canRecord = s => s.scope === FULL || s.scope === 'Score only' || (s.scope === 'Own station only' && s.role === 'Game Leader');
const gameId = (round, station) => round + '_' + S.slug(station);

function checkAmount(n, max) {
  if (!Number.isInteger(n) || n < 1) throw new Fail('invalid-argument', 'Points must be a whole number of 1 or more.');
  if (n > max) throw new Fail('invalid-argument', 'Points are capped at ' + max + ' per game.');
  return n;
}
function amountFor(cfg, station, typed) {
  const max = (cfg && Number.isInteger(cfg.max)) ? cfg.max : DEFAULT_MAX;
  const fixed = cfg && cfg.fixed && cfg.fixed[S.slug(station)];
  return Number.isInteger(fixed) ? checkAmount(fixed, max) : checkAmount(typed, max);
}

/* A game leader (or Full staff) records the winner by scanning ANY player of the winning team. */
async function recordMatch(db, uid, data) {
  const st = await staffOf(db, uid);
  if (!canRecord(st)) throw new Fail('permission-denied', 'Your role cannot give team points.');
  const code = String(data.code || '').trim().toUpperCase();
  if (!code) throw new Fail('invalid-argument', 'Missing player code.');
  const leader = !(isFull(st) || st.scope === 'Score only');
  const station = leader ? st.station : String(data.station || st.station || '').trim();
  if (!station) throw new Fail('invalid-argument', leader ? 'Your account has no station in the Staff sheet.' : 'Type the station.');
  const draw = data.result === 'draw';
  if (draw && !isFull(st)) throw new Fail('permission-denied', 'Only Full staff can record a draw.');

  const out = await db.runTransaction(async tx => {
    const pSnap = await tx.get(db.collection('players').doc(code));
    if (!pSnap.exists) throw new Fail('not-found', 'No player ' + code);
    const p = pSnap.data();
    if (!p.camp || !p.teamName) throw new Fail('failed-precondition', code + ' has no team in the sheet.');
    const key = S.teamKey(p.camp, p.teamName);
    const sch = await tx.get(db.collection('schedule').where('teams', 'array-contains', key));
    let here = sch.docs.map(d => d.data()).filter(g => S.slug(g.station) === S.slug(station));
    if (data.round) here = here.filter(g => Number(g.round) === Number(data.round));
    if (!here.length) throw new Fail('failed-precondition', p.teamName + ' (' + p.camp + ') is not scheduled at ' + station + '.');
    if (here.length > 1) throw new Fail('failed-precondition', p.teamName + ' is scheduled twice at ' + station + '. Choose the round.');
    const g = here[0], id = gameId(g.round, g.station);
    const mRef = db.collection('matches').doc(id);
    const mSnap = await tx.get(mRef);
    const rSnap = await tx.get(db.collection('rounds').doc(String(g.round)));
    const cSnap = await tx.get(db.collection('meta').doc('gamepoints'));
    const winnerName = key === g.teamA ? g.nameA : g.nameB;
    if (mSnap.exists) {
      const m = mSnap.data();
      return { status: 'already', round: g.round, station: g.station, result: m.result, winner: m.winnerName || null };
    }
    if (rSnap.exists && rSnap.data().closed) throw new Fail('failed-precondition', 'Round ' + g.round + ' is closed. Ask Full staff to correct it.');
    const amount = draw ? 0 : amountFor(cSnap.exists ? cSnap.data() : null, g.station, Number(data.amount));
    tx.set(mRef, {
      round: g.round, station: g.station, teamA: g.teamA, teamB: g.teamB, nameA: g.nameA, nameB: g.nameB,
      result: draw ? 'draw' : 'win', winner: draw ? null : key, winnerName: draw ? null : winnerName, amount: amount,
      by: st.id, byName: st.name, ts: Date.now()
    });
    return { status: 'recorded', round: g.round, station: g.station, result: draw ? 'draw' : 'win', winner: draw ? null : winnerName, amount: amount };
  });

  if (out.status === 'recorded') out.round_state = await settleRound(db, out.round, 'auto');
  return out;
}

/* Full staff: mark a game "no result", or set / correct a winner. Everything affected is recomputed and re-applied exactly. */
async function adminMatch(db, uid, data) {
  const st = await staffOf(db, uid);
  if (!isFull(st)) throw new Fail('permission-denied', 'Only Full staff can do this.');
  const round = Number(data.round), station = String(data.station || '').trim();
  if (!Number.isInteger(round) || !station) throw new Fail('invalid-argument', 'Round and station are required.');
  const action = data.action;
  if (action !== 'noresult' && action !== 'set') throw new Fail('invalid-argument', 'Unknown action.');

  await db.runTransaction(async tx => {
    const sRef = db.collection('schedule').doc(gameId(round, station));
    const sSnap = await tx.get(sRef);
    if (!sSnap.exists) throw new Fail('not-found', 'Round ' + round + ' has no game at ' + station + '.');
    const g = sSnap.data();
    const mRef = db.collection('matches').doc(gameId(g.round, g.station));
    const cSnap = await tx.get(db.collection('meta').doc('gamepoints'));
    let doc;
    if (action === 'noresult') {
      doc = { result: 'draw', winner: null, winnerName: null, amount: 0 };
    } else {
      if (data.winner !== 'A' && data.winner !== 'B') throw new Fail('invalid-argument', 'Choose winner A or B.');
      const key = data.winner === 'A' ? g.teamA : g.teamB;
      doc = { result: 'win', winner: key, winnerName: data.winner === 'A' ? g.nameA : g.nameB, amount: amountFor(cSnap.exists ? cSnap.data() : null, g.station, Number(data.amount)) };
    }
    tx.set(mRef, Object.assign({ round: g.round, station: g.station, teamA: g.teamA, teamB: g.teamB, nameA: g.nameA, nameB: g.nameB,
      by: st.id, byName: st.name, ts: Date.now(), corrected: true }, doc));
  });

  // Recompute this round, then every later round that was already closed (their camp bonus depends on earlier rounds).
  const done = [];
  done.push({ round: round, state: await settleRound(db, round, 'correction') });
  const later = await db.collection('rounds').where('closed', '==', true).get();
  const rounds = later.docs.map(d => d.data().round).filter(r => r > round).sort((a, b) => a - b);
  for (const r of rounds) done.push({ round: r, state: await settleRound(db, r, 'correction') });
  return { status: 'ok', rounds: done };
}

/*
 * Works out a round and applies the difference to the players. Safe to run again: it only applies new - old.
 * Before a round is closed the current rosters are used; once closed the saved roster snapshot is kept,
 * so later team changes never move points that were already given.
 */
async function settleRound(db, round, reason) {
  return db.runTransaction(async tx => {
    const rRef = db.collection('rounds').doc(String(round));
    const rSnap = await tx.get(rRef);
    const sch = await tx.get(db.collection('schedule').where('round', '==', round));
    const ms = await tx.get(db.collection('matches').where('round', '==', round));
    const closedAll = await tx.get(db.collection('rounds').where('closed', '==', true));
    const players = await tx.get(db.collection('players'));
    const tRef = db.collection('meta').doc('teams');
    const tSnap = await tx.get(tRef);
    const old = rSnap.exists ? rSnap.data() : null;

    const mById = {};
    ms.docs.forEach(d => { mById[d.id] = d.data(); });
    const games = sch.docs.map(d => d.data()).map(g => {
      const m = mById[gameId(g.round, g.station)];
      return { station: g.station, teamA: g.teamA, teamB: g.teamB, result: m ? m.result : null, winner: m ? m.winner : null, amount: m ? m.amount : 0 };
    });
    if (!games.length) return { closed: false, missing: [], note: 'No schedule for this round.' };

    let rosters;
    if (old && old.closed) rosters = old.rosters;
    else {
      rosters = {};
      players.docs.forEach(d => { const p = d.data(); if (p.camp && p.teamName) (rosters[S.teamKey(p.camp, p.teamName)] = rosters[S.teamKey(p.camp, p.teamName)] || []).push(d.id); });
    }
    const prior = {};
    closedAll.docs.map(d => d.data()).filter(r => r.round < round && r.bonusCamp).forEach(r => { prior[r.bonusCamp] = (prior[r.bonusCamp] || 0) + 1; });

    const res = S.computeRound({ games: games, rosters: rosters, priorWins: prior });
    if (!res.complete) return { closed: false, missing: games.filter(g => !g.result).map(g => g.station) };

    const delta = S.diff(old && old.awards, res.awards);
    const teamDelta = S.diff(old && old.teamPoints, res.teamPoints);
    const pById = {};
    players.docs.forEach(d => { pById[d.id] = d; });
    const label = old && old.closed ? 'Round ' + round + ' correction' : 'Round ' + round;
    const now = Date.now();
    let changed = 0;

    Object.keys(delta).forEach(code => {
      const d = pById[code]; if (!d) return;
      const p = d.data();
      const entries = [];
      if (old && old.closed) entries.push({ t: label, d: delta[code], ts: now, by: 'system' });
      else {
        const det = res.detail[code] || {};
        if (det.game) entries.push({ t: (res.tie ? 'Round ' + round + ' swap (tied round)' : 'Round ' + round + ' win') + (det.station ? ' - ' + det.station : ''), d: det.game, ts: now, by: 'system' });
        if (det.bonus) entries.push({ t: 'Round ' + round + ' camp bonus', d: det.bonus, ts: now, by: 'system' });
      }
      tx.update(d.ref, { aura: (p.aura || 0) + delta[code], tx: entries.reverse().concat(p.tx || []).slice(0, 20) });
      changed++;
    });

    const campDelta = {};
    Object.keys(teamDelta).forEach(k => { const c = S.campOf(k); campDelta[c] = (campDelta[c] || 0) + teamDelta[k]; });
    if (Object.keys(campDelta).length) {
      const cur = tSnap.exists ? tSnap.data() : {}, upd = {};
      Object.keys(campDelta).forEach(c => { upd[c] = (cur[c] || 0) + campDelta[c]; });
      tx.set(tRef, upd, { merge: true });
    }

    // Public leaderboard for the student app: every team with its total (game points + camp bonus of all closed rounds).
    const totals = {};
    closedAll.docs.map(d => d.data()).filter(r => r.round !== round).forEach(r => { Object.keys(r.teamPoints || {}).forEach(k => { totals[k] = (totals[k] || 0) + r.teamPoints[k]; }); });
    Object.keys(res.teamPoints).forEach(k => { totals[k] = (totals[k] || 0) + res.teamPoints[k]; });
    const names = {};
    players.docs.forEach(d => { const p = d.data(); if (p.camp && p.teamName) names[S.teamKey(p.camp, p.teamName)] = true; });
    Object.keys(totals).forEach(k => { names[k] = true; });
    const board = Object.keys(names).map(k => ({ k: k, c: S.campOf(k), n: k.slice(k.indexOf('|') + 1), p: totals[k] || 0 }))
      .sort((x, y) => y.p - x.p || x.n.localeCompare(y.n));
    tx.set(db.collection('meta').doc('leaderboard'), { teams: board, updatedAt: now });

    tx.set(rRef, {
      round: round, closed: true, closedAt: (old && old.closedAt) || now, updatedAt: now, version: ((old && old.version) || 0) + 1,
      wins: res.wins, threshold: res.threshold, winnerCamp: res.winnerCamp, tie: res.tie, bonus: res.bonus,
      bonusCamp: res.tie ? null : res.winnerCamp, awards: res.awards, detail: res.detail, teamPoints: res.teamPoints, rosters: rosters
    });
    tx.set(db.collection('log').doc(), { by: 'system', kind: 'round', round: round, why: reason, tie: res.tie, bonusCamp: res.tie ? null : res.winnerCamp, bonus: res.bonus, changedPlayers: changed, ts: now });
    return { closed: true, tie: res.tie, winnerCamp: res.winnerCamp, bonus: res.bonus, wins: res.wins, changedPlayers: changed };
  });
}

module.exports = { recordMatch, adminMatch, settleRound, Fail, FULL };
