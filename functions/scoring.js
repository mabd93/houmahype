'use strict';
/*
 * Pure scoring rules for the event. No database in here, so they can be tested on their own.
 *
 * A "team" is identified by a key "Camp|TeamName" (for example "MaZoo|Team 3").
 * A "game" is one scheduled match of one round at one station between two teams (one per camp).
 *
 * Rules (agreed with the owner):
 *  1. The winner of a game gets that game's points: every player of the team gets them once.
 *  2. After the round is complete, the camp that won MORE THAN HALF of the round's games gets a bonus:
 *     the number of rounds that camp has won so far, counting this one (1, 2, 3...). Every player of every
 *     team of that camp gets it, on top of the game points.
 *  3. If no camp won more than half (a tied round), there is no camp bonus and, in every game of that
 *     round, the win points go to the LOSING team instead. A drawn game ("no result") gives nobody points.
 */

function teamKey(camp, name) { return String(camp || '').trim() + '|' + String(name || '').trim(); }
function campOf(key) { return String(key).split('|')[0]; }
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

/*
 * input.games   : every scheduled game of the round: { station, teamA, teamB, result: 'win'|'draw'|null, winner, amount }
 * input.rosters : { teamKey: [player codes] } for ALL teams (also the team that rests this round)
 * input.priorWins: { camp: number of earlier rounds that camp won }
 */
function computeRound(input) {
  const games = input.games || [], rosters = input.rosters || {}, prior = input.priorWins || {};
  const n = games.length;
  const complete = n > 0 && games.every(g => g.result === 'win' || g.result === 'draw');
  const wins = {};
  games.forEach(g => { wins[campOf(g.teamA)] = wins[campOf(g.teamA)] || 0; wins[campOf(g.teamB)] = wins[campOf(g.teamB)] || 0; });
  games.forEach(g => { if (g.result === 'win') wins[campOf(g.winner)] = (wins[campOf(g.winner)] || 0) + 1; });
  const threshold = Math.floor(n / 2) + 1;
  const out = { complete: complete, wins: wins, threshold: threshold, winnerCamp: null, tie: false, bonus: 0,
    awards: {}, detail: {}, teamPoints: {}, campTotals: {} };
  if (!complete) return out;

  let winnerCamp = null;
  Object.keys(wins).forEach(c => { if (wins[c] >= threshold) winnerCamp = c; });
  out.winnerCamp = winnerCamp;
  out.tie = !winnerCamp;

  function give(key, pts, kind, station) {
    if (!pts) return;
    out.teamPoints[key] = (out.teamPoints[key] || 0) + pts;
    (rosters[key] || []).forEach(code => {
      out.awards[code] = (out.awards[code] || 0) + pts;
      const d = out.detail[code] = out.detail[code] || { game: 0, bonus: 0, station: null };
      d[kind] += pts;
      if (station) d.station = station;
    });
  }
  games.forEach(g => {
    if (g.result !== 'win') return;
    const loser = g.winner === g.teamA ? g.teamB : g.teamA;
    give(out.tie ? loser : g.winner, g.amount, 'game', g.station);
  });
  if (winnerCamp) {
    out.bonus = (prior[winnerCamp] || 0) + 1;
    Object.keys(rosters).filter(k => campOf(k) === winnerCamp).forEach(k => give(k, out.bonus, 'bonus'));
  }
  Object.keys(out.teamPoints).forEach(k => { const c = campOf(k); out.campTotals[c] = (out.campTotals[c] || 0) + out.teamPoints[k]; });
  return out;
}

/* rounds: [{ round, games, rosters }] -> results in round order, with the running count of rounds won per camp. */
function computeSeason(rounds) {
  const prior = {};
  return rounds.slice().sort((a, b) => a.round - b.round).map(r => {
    const res = computeRound({ games: r.games, rosters: r.rosters, priorWins: prior });
    if (res.complete && res.winnerCamp) prior[res.winnerCamp] = (prior[res.winnerCamp] || 0) + 1;
    return Object.assign({ round: r.round }, res);
  });
}

/* Per-key difference new - old, only where it is not zero. */
function diff(oldMap, newMap) {
  const out = {}, keys = {};
  Object.keys(oldMap || {}).forEach(k => keys[k] = 1); Object.keys(newMap || {}).forEach(k => keys[k] = 1);
  Object.keys(keys).forEach(k => { const d = ((newMap || {})[k] || 0) - ((oldMap || {})[k] || 0); if (d) out[k] = d; });
  return out;
}

module.exports = { teamKey, campOf, slug, computeRound, computeSeason, diff };
