'use strict';
const test = require('node:test'), assert = require('node:assert');
const S = require('../scoring');

function world(nGames) {
  const rosters = {}, games = [];
  for (let i = 1; i <= nGames + 1; i++) { // one extra pair rests
    ['MaZoo', 'WiSoo'].forEach(c => { const k = S.teamKey(c, 'T' + i); rosters[k] = [1, 2, 3, 4, 5].map(n => c[0] + i + '-' + n); });
  }
  for (let i = 1; i <= nGames; i++) games.push({ station: 'S' + i, teamA: S.teamKey('MaZoo', 'T' + i), teamB: S.teamKey('WiSoo', 'T' + i), result: null, winner: null, amount: 0 });
  return { rosters, games };
}
function decide(games, winners, amount) { // winners: string of M / W / D per game; the winner scores `amount`, the other team 2 (draw: both 2)
  const hi = amount || 10;
  return games.map((g, i) => winners[i] === 'D' ? Object.assign({}, g, { result: 'draw', winner: null, scoreA: 2, scoreB: 2 })
    : Object.assign({}, g, { result: 'win', winner: winners[i] === 'M' ? g.teamA : g.teamB, scoreA: winners[i] === 'M' ? hi : 2, scoreB: winners[i] === 'M' ? 2 : hi }));
}

test('incomplete round awards nothing', () => {
  const w = world(3); const g = w.games.slice(); g[0] = decide(w.games, 'MMM')[0];
  const r = S.computeRound({ games: g, rosters: w.rosters });
  assert.equal(r.complete, false); assert.deepEqual(r.awards, {});
});
test('every team gets its own score, the winning camp gets the bonus on top', () => {
  const w = world(3); const r = S.computeRound({ games: decide(w.games, 'MMW', 10), rosters: w.rosters });
  assert.equal(r.winnerCamp, 'MaZoo'); assert.equal(r.bonus, 1); assert.equal(r.tie, false);
  assert.equal(r.awards['M1-1'], 11); assert.equal(r.awards['M2-5'], 11); // score 10 + bonus 1
  assert.equal(r.awards['W1-1'], 2);   // lost but keeps its own score of 2
  assert.equal(r.awards['M3-1'], 3);   // score 2 + bonus 1
  assert.equal(r.awards['M4-1'], 1);   // resting MaZoo team gets the bonus too
  assert.equal(r.awards['W3-1'], 10);  // WiSoo team that won its game, no bonus
  assert.equal(r.teamPoints[S.teamKey('MaZoo', 'T1')], 11);
});
test('bonus grows with each round the camp wins: M, M, W, M -> 1, 2, 1, 3', () => {
  const w = world(3); const rounds = ['MMW', 'MMM', 'WWM', 'MMW'].map((x, i) => ({ round: i + 1, games: decide(w.games, x), rosters: w.rosters }));
  const res = S.computeSeason(rounds);
  assert.deepEqual(res.map(r => [r.winnerCamp, r.bonus]), [['MaZoo', 1], ['MaZoo', 2], ['WiSoo', 1], ['MaZoo', 3]]);
});
test('tied round: no camp bonus, nothing swaps, every team keeps its own score', () => {
  const w = world(4); const r = S.computeRound({ games: decide(w.games, 'MMWW', 10), rosters: w.rosters });
  assert.equal(r.tie, true); assert.equal(r.bonus, 0); assert.equal(r.winnerCamp, null);
  assert.equal(r.awards['M1-1'], 10); assert.equal(r.awards['W1-1'], 2);
  assert.equal(r.awards['W3-1'], 10); assert.equal(r.awards['M3-1'], 2);
});
test('a draw counts for nobody but both teams keep their scores; a voided game gives nothing', () => {
  const w = world(3); const r = S.computeRound({ games: decide(w.games, 'MWD', 10), rosters: w.rosters });
  assert.equal(r.tie, true); assert.equal(r.awards['M3-1'], 2); assert.equal(r.awards['W3-1'], 2);
  const g = decide(w.games, 'MWD', 10); g[2] = Object.assign({}, g[2], { result: 'void', scoreA: 0, scoreB: 0 });
  const v = S.computeRound({ games: g, rosters: w.rosters });
  assert.equal(v.complete, true); assert.equal(v.awards['M3-1'], undefined);
  const s = S.computeSeason([{ round: 1, games: decide(w.games, 'MWD'), rosters: w.rosters }, { round: 2, games: decide(w.games, 'MMW'), rosters: w.rosters }]);
  assert.equal(s[1].bonus, 1); // tied round 1 did not count as a win for anybody
});
test('17 games: one camp always has more than half when nothing is drawn', () => {
  const w = world(17);
  for (let m = 0; m <= 17; m++) {
    const x = 'M'.repeat(m) + 'W'.repeat(17 - m); const r = S.computeRound({ games: decide(w.games, x), rosters: w.rosters });
    assert.equal(r.tie, false, 'no tie for ' + m + ' MaZoo wins'); assert.equal(r.winnerCamp, m >= 9 ? 'MaZoo' : 'WiSoo');
  }
});
test('17 games with 8-8 and one draw is a tie; 8-7 with two draws is also a tie (nobody has more than half)', () => {
  const w = world(17);
  assert.equal(S.computeRound({ games: decide(w.games, 'M'.repeat(8) + 'W'.repeat(8) + 'D'), rosters: w.rosters }).tie, true);
  assert.equal(S.computeRound({ games: decide(w.games, 'M'.repeat(8) + 'W'.repeat(7) + 'DD'), rosters: w.rosters }).tie, true);
});
test('diff only reports changes', () => {
  assert.deepEqual(S.diff({ a: 5, b: 3 }, { a: 5, b: 1, c: 2 }), { b: -2, c: 2 });
});
