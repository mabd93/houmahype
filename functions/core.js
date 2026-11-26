'use strict';
/*
 * Server-side game logic. It only talks to the database through a small Firestore-like interface
 * (collection/doc/where/get/runTransaction), so the same code runs in Cloud Functions and in the tests.
 *
 * Data:
 *   schedule/{round}_{station}  fixed pairings from the sheet: { round, station, teamA, teamB, teams:[A,B], nameA, nameB }
 *   matches/{round}_{station}   one result per game: { result:'win'|'draw'|'void', winner, scoreA, scoreB, ... }  (created once)
 *   rounds/{round}              written when a round is complete: the awards that were applied (so they can be reversed exactly)
 *   meta/gamepoints             optional: { max: 15, limits: { "<station slug>": 15 } }  (highest score one team can get at a station)
 */
const S = require('./scoring');

class Fail extends Error { constructor(code, message) { super(message); this.code = code; } }
const FULL = 'Full: Barhams and Score';
const DEFAULT_MAX = 15; // highest score one team can get in a game, can be changed per station in meta/gamepoints

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

function limitFor(cfg, station) {
  const own = cfg && cfg.limits && cfg.limits[S.slug(station)];
  if (Number.isInteger(own) && own > 0) return own;
  return (cfg && Number.isInteger(cfg.max) && cfg.max > 0) ? cfg.max : DEFAULT_MAX;
}
function checkScore(v, max, label) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 0) throw new Fail('invalid-argument', label + ' must be a whole number of 0 or more.');
  if (n > max) throw new Fail('invalid-argument', label + ' is capped at ' + max + ' for this station.');
  return n;
}
function outcome(scoreA, scoreB, g) {
  if (scoreA === scoreB) return { result: 'draw', winner: null, winnerName: null };
  const a = scoreA > scoreB;
  return { result: 'win', winner: a ? g.teamA : g.teamB, winnerName: a ? g.nameA : g.nameB };
}

/* A game leader (or Full staff) scans ANY player of either team at the station, then enters each team's own score (A = MaZoo team, B = WiSoo team). */
async function recordMatch(db, uid, data) {
  const st = await staffOf(db, uid);
  if (!canRecord(st)) throw new Fail('permission-denied', 'Your role cannot give team points.');
  const code = String(data.code || '').trim().toUpperCase();
  if (!code) throw new Fail('invalid-argument', 'Missing player code.');
  const leader = !(isFull(st) || st.scope === 'Score only');
  const station = leader ? st.station : String(data.station || st.station || '').trim();
  if (!station) throw new Fail('invalid-argument', leader ? 'Your account has no station in the Staff sheet.' : 'Type the station.');
  const lookup = data.lookup === true;

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
    const max = limitFor(cSnap.exists ? cSnap.data() : null, g.station);
    const info = { round: g.round, station: g.station, nameA: g.nameA, nameB: g.nameB, max: max };
    if (mSnap.exists) {
      const m = mSnap.data();
      return Object.assign(info, { status: 'already', result: m.result, winner: m.winnerName || null, scoreA: m.scoreA, scoreB: m.scoreB });
    }
    if (rSnap.exists && rSnap.data().closed) throw new Fail('failed-precondition', 'Round ' + g.round + ' is closed. Ask Full staff to correct it.');
    if (lookup) return Object.assign(info, { status: 'open' });
    const scoreA = checkScore(data.scoreA, max, 'Score of ' + g.nameA), scoreB = checkScore(data.scoreB, max, 'Score of ' + g.nameB);
    const o = outcome(scoreA, scoreB, g);
    tx.set(mRef, {
      round: g.round, station: g.station, teamA: g.teamA, teamB: g.teamB, nameA: g.nameA, nameB: g.nameB,
      result: o.result, winner: o.winner, winnerName: o.winnerName, scoreA: scoreA, scoreB: scoreB,
      by: st.id, byName: st.name, ts: Date.now()
    });
    return Object.assign(info, { status: 'recorded', result: o.result, winner: o.winnerName, scoreA: scoreA, scoreB: scoreB });
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
      doc = { result: 'void', winner: null, winnerName: null, scoreA: 0, scoreB: 0 };
    } else {
      const max = limitFor(cSnap.exists ? cSnap.data() : null, g.station);
      const scoreA = checkScore(data.scoreA, max, 'Score of ' + g.nameA), scoreB = checkScore(data.scoreB, max, 'Score of ' + g.nameB);
      doc = Object.assign({ scoreA: scoreA, scoreB: scoreB }, outcome(scoreA, scoreB, g));
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
      return { station: g.station, teamA: g.teamA, teamB: g.teamB, result: m ? m.result : null, winner: m ? m.winner : null, scoreA: m ? m.scoreA : 0, scoreB: m ? m.scoreB : 0 };
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
        if (det.game) entries.push({ t: 'Round ' + round + (det.station ? ' - ' + det.station : ' score'), d: det.game, ts: now, by: 'system' });
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
    // Round by round history for each team (game points, camp bonus, station) and a one-line summary per round.
    const closedList = closedAll.docs.map(d => d.data()).filter(r => r.round !== round)
      .concat([{ round: round, rosters: rosters, detail: res.detail, wins: res.wins, tie: res.tie, bonus: res.bonus, bonusCamp: res.tie ? null : res.winnerCamp }])
      .sort((x, y) => x.round - y.round);
    const board = Object.keys(names).map(k => {
      const h = closedList.map(r => { const code = ((r.rosters || {})[k] || [])[0]; const det = (code && r.detail && r.detail[code]) || {}; return { r: r.round, g: det.game || 0, b: det.bonus || 0, s: det.station || '' }; });
      return { k: k, c: S.campOf(k), n: k.slice(k.indexOf('|') + 1), p: totals[k] || 0, h: h };
    }).sort((x, y) => y.p - x.p || x.n.localeCompare(y.n));
    const rs = closedList.map(r => ({ r: r.round, w: r.bonusCamp || null, tie: !!r.tie, bonus: r.bonus || 0, wins: r.wins || {} }));
    tx.set(db.collection('meta').doc('leaderboard'), { teams: board, rounds: rs, updatedAt: now });

    tx.set(rRef, {
      round: round, closed: true, closedAt: (old && old.closedAt) || now, updatedAt: now, version: ((old && old.version) || 0) + 1,
      wins: res.wins, threshold: res.threshold, winnerCamp: res.winnerCamp, tie: res.tie, bonus: res.bonus,
      bonusCamp: res.tie ? null : res.winnerCamp, awards: res.awards, detail: res.detail, teamPoints: res.teamPoints, rosters: rosters
    });
    tx.set(db.collection('log').doc(), { by: 'system', kind: 'round', round: round, why: reason, tie: res.tie, bonusCamp: res.tie ? null : res.winnerCamp, bonus: res.bonus, changedPlayers: changed, ts: now });
    return { closed: true, tie: res.tie, winnerCamp: res.winnerCamp, bonus: res.bonus, wins: res.wins, changedPlayers: changed };
  });
}

module.exports = { recordMatch, adminMatch, settleRound, Fail, FULL, staffOf, isFull };
