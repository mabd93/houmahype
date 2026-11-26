'use strict';
const test = require('node:test'), assert = require('node:assert');
const { makeDb } = require('./fake');
const core = require('../core');
const S = require('../scoring');

// 4 teams per camp (T1..T4), 5 players each. Round r has 3 games: Station 1..3, MaZoo T(i) vs WiSoo T(i); T4 rests.
function setup(rounds) {
  const db = makeDb();
  ['MaZoo', 'WiSoo'].forEach(c => { for (let t = 1; t <= 4; t++) for (let n = 1; n <= 5; n++)
    db.put('players/' + c[0] + t + '00' + n, { code: c[0] + t + '00' + n, camp: c, teamName: 'T' + t, aura: 0, barhams: 50, tx: [] }); });
  for (let r = 1; r <= (rounds || 2); r++) for (let i = 1; i <= 3; i++) {
    const a = S.teamKey('MaZoo', 'T' + i), b = S.teamKey('WiSoo', 'T' + i);
    db.put('schedule/' + r + '_station-' + i, { round: r, station: 'Station ' + i, teamA: a, teamB: b, teams: [a, b], nameA: 'T' + i, nameB: 'T' + i });
  }
  db.put('staff/full', { id: 'S01', name: 'Boss', scope: core.FULL, role: 'Owner', station: '' });
  for (let i = 1; i <= 3; i++) db.put('staff/gl' + i, { id: 'G0' + i, name: 'Leader ' + i, scope: 'Own station only', role: 'Game Leader', station: 'Station ' + i });
  db.put('staff/stl', { id: 'ST1', name: 'Shop', scope: 'Own station only', role: 'Station leader', station: 'Shop' });
  db.put('meta/teams', { MaZoo: 0, WiSoo: 0 });
  return db;
}
const aura = (db, code) => db.get('players/' + code).aura;
// Leader i scans `code` (any player of the pair at his station) and enters both scores: A = MaZoo team, B = WiSoo team.
const play = (db, i, code, a, b, round) => core.recordMatch(db, 'gl' + i, { code, scoreA: a, scoreB: b, round });

test('scan one member and enter both scores: nothing is paid until the round is complete, then each team gets its own score once', async () => {
  const db = setup(1);
  const r1 = await play(db, 1, 'M1003', 12, 5);
  assert.equal(r1.status, 'recorded'); assert.equal(r1.winner, 'T1'); assert.equal(r1.round_state.closed, false);
  assert.deepEqual(r1.round_state.missing.sort(), ['Station 2', 'Station 3']);
  assert.equal(aura(db, 'M1001'), 0); // pending
  await play(db, 2, 'M2001', 9, 3); const last = await play(db, 3, 'W3002', 4, 14);
  assert.equal(last.round_state.closed, true);
  // MaZoo won 2 of 3 -> bonus 1 for every MaZoo player
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M100' + n), 13);
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M200' + n), 10);
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M300' + n), 5);    // lost with 4, plus bonus 1
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M400' + n), 1);    // resting team, bonus
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'W300' + n), 14);   // won, no bonus
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'W100' + n), 5);    // lost but keeps own score
  assert.deepEqual(db.get('meta/teams'), { MaZoo: 12 + 9 + 4 + 4, WiSoo: 5 + 3 + 14 });
});
test('a lookup shows the pair and the station maximum without recording anything', async () => {
  const db = setup(1);
  const r = await core.recordMatch(db, 'gl1', { code: 'W1002', lookup: true });
  assert.equal(r.status, 'open'); assert.equal(r.nameA, 'T1'); assert.equal(r.max, 15);
  assert.equal(db.get('matches/1_station-1'), undefined);
});
test('second scan of the same pair changes nothing', async () => {
  const db = setup(1);
  await play(db, 1, 'M1001', 10, 4);
  const again = await play(db, 1, 'M1002', 1, 1), opp = await play(db, 1, 'W1001', 1, 1);
  assert.equal(again.status, 'already'); assert.equal(opp.status, 'already'); assert.equal(opp.scoreA, 10);
  await play(db, 2, 'M2001', 5, 5); await play(db, 3, 'M3001', 5, 5);
  const before = aura(db, 'M1001');
  const late = await play(db, 1, 'W1001', 1, 1);
  assert.equal(late.status, 'already'); // round is closed and the game is locked
  assert.equal(aura(db, 'M1001'), before);
});
test('permissions and bad scores', async () => {
  const db = setup(1);
  await assert.rejects(core.recordMatch(db, 'nobody', { code: 'M1001', scoreA: 5, scoreB: 5 }), e => e.code === 'permission-denied');
  await assert.rejects(core.recordMatch(db, null, { code: 'M1001', scoreA: 5, scoreB: 5 }), e => e.code === 'unauthenticated');
  await assert.rejects(core.recordMatch(db, 'stl', { code: 'M1001', scoreA: 5, scoreB: 5 }), e => e.code === 'permission-denied');
  await assert.rejects(core.recordMatch(db, 'gl2', { code: 'M1001', scoreA: 5, scoreB: 5 }), e => e.code === 'failed-precondition'); // T1 is at Station 1
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M4001', scoreA: 5, scoreB: 5 }), e => e.code === 'failed-precondition'); // T4 not scheduled
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', scoreA: 16, scoreB: 5 }), e => e.code === 'invalid-argument'); // over the max of 15
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', scoreA: -1, scoreB: 5 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', scoreA: 2.5, scoreB: 5 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', scoreB: 5 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'ZZ99', scoreA: 5, scoreB: 5 }), e => e.code === 'not-found');
  assert.equal(db.get('matches/1_station-1'), undefined);
});
test('a leader cannot pick another station: the account station is always used', async () => {
  const db = setup(1);
  const r = await core.recordMatch(db, 'gl1', { code: 'M1001', scoreA: 10, scoreB: 3, station: 'Station 2' });
  assert.equal(r.station, 'Station 1');
});
test('per-station limit from meta/gamepoints', async () => {
  const db = setup(1); db.put('meta/gamepoints', { max: 15, limits: { 'station-1': 12 } });
  await assert.rejects(play(db, 1, 'M1001', 13, 1), e => e.code === 'invalid-argument');
  const r = await play(db, 1, 'M1001', 12, 1); assert.equal(r.max, 12);
});
test('equal scores are a draw; tied round: no camp bonus, no swap', async () => {
  const db = setup(1);
  // M wins game 1, W wins game 2, game 3 is a draw -> nobody has more than half (needs 2) -> tie
  await play(db, 1, 'M1001', 10, 4); await play(db, 2, 'W2001', 6, 11); const last = await play(db, 3, 'M3001', 7, 7);
  assert.equal(last.result, 'draw'); assert.equal(last.round_state.closed, true); assert.equal(last.round_state.winnerCamp, null);
  assert.equal(aura(db, 'M1001'), 10); assert.equal(aura(db, 'W1001'), 4);
  assert.equal(aura(db, 'M2001'), 6); assert.equal(aura(db, 'W2001'), 11);
  assert.equal(aura(db, 'M3001'), 7); assert.equal(aura(db, 'W3001'), 7);
  assert.equal(aura(db, 'M4001'), 0); // no bonus
});
test('Full staff: void a game gives nobody points', async () => {
  const db = setup(1);
  await play(db, 1, 'M1001', 10, 4); await play(db, 2, 'M2001', 10, 4);
  const d = await core.adminMatch(db, 'full', { action: 'noresult', round: 1, station: 'Station 3' });
  assert.equal(d.rounds[0].state.closed, true);
  assert.equal(aura(db, 'M3001'), 1); assert.equal(aura(db, 'W3001'), 0); // only the camp bonus (MaZoo won 2 of 3)
});
test('Full staff correction: changing scores re-applies exactly, and later bonuses follow', async () => {
  const db = setup(2);
  for (const r of [1, 2]) for (const [i, c] of [[1, 'M1001'], [2, 'M2001'], [3, 'M3001']]) await play(db, i, c, 10, 3, r); // MaZoo wins every game in both rounds
  assert.equal(aura(db, 'M1001'), 10 + 1 + 10 + 2); assert.equal(aura(db, 'W1001'), 3 + 3);
  assert.equal(db.get('rounds/2').bonus, 2);
  // Round 1 was really won by WiSoo in stations 1 and 2.
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 1', scoreA: 4, scoreB: 9 });
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 2', scoreA: 4, scoreB: 9 });
  assert.equal(db.get('rounds/1').winnerCamp, 'WiSoo');
  assert.equal(db.get('rounds/2').bonus, 1); // MaZoo's second win is now its first
  assert.equal(aura(db, 'W1001'), 9 + 1 + 3);        // round 1: 9 + bonus 1; round 2: 3
  assert.equal(aura(db, 'M1001'), 4 + 10 + 1);       // round 1: 4; round 2: 10 + bonus 1
  assert.equal(aura(db, 'M3001'), 10 + 10 + 1);      // station 3 unchanged in round 1 (no bonus), round 2: 10 + 1
  assert.equal(aura(db, 'W4001'), 1); assert.equal(aura(db, 'M4001'), 1);
  const snapshot = JSON.stringify([...db.store.entries()].filter(([k]) => k.startsWith('players/')));
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 2', scoreA: 4, scoreB: 9 });
  assert.equal(JSON.stringify([...db.store.entries()].filter(([k]) => k.startsWith('players/'))), snapshot);
  const sum = c => [1, 2].reduce((t, rr) => t + Object.entries(db.get('rounds/' + rr).teamPoints).filter(([k]) => k.startsWith(c)).reduce((a, [, v]) => a + v, 0), 0);
  assert.deepEqual(db.get('meta/teams'), { MaZoo: sum('MaZoo'), WiSoo: sum('WiSoo') });
});
test('correction by a non-Full account is refused', async () => {
  const db = setup(1);
  await assert.rejects(core.adminMatch(db, 'gl1', { action: 'noresult', round: 1, station: 'Station 1' }), e => e.code === 'permission-denied');
});
test('roster changes after a round closed do not move points already given', async () => {
  const db = setup(1);
  for (const [i, c] of [[1, 'M1001'], [2, 'M2001'], [3, 'M3001']]) await play(db, i, c, 10, 3);
  const before = aura(db, 'M1001');
  const p = db.get('players/M1001'); p.teamName = 'T4'; db.put('players/M1001', p);
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 1', scoreA: 10, scoreB: 3 });
  assert.equal(aura(db, 'M1001'), before);
});
test('public leaderboard lists every team with its total, including teams on a break', async () => {
  const db = setup(1);
  await play(db, 1, 'M1003', 12, 5); await play(db, 2, 'M2001', 9, 3); await play(db, 3, 'W3002', 4, 14);
  const lb = db.get('meta/leaderboard');
  assert.equal(lb.teams.length, 8);
  const pts = {}; lb.teams.forEach(x => { pts[x.k] = x.p; });
  assert.equal(pts[S.teamKey('MaZoo', 'T1')], 13);
  assert.equal(pts[S.teamKey('MaZoo', 'T4')], 1);
  assert.equal(pts[S.teamKey('WiSoo', 'T3')], 14);
  assert.equal(pts[S.teamKey('WiSoo', 'T1')], 5);
  assert.equal(lb.teams[0].p, 14);
});
test('leaderboard keeps a round-by-round history per team and a summary per round', async () => {
  const db = setup(2);
  for (const r of [1, 2]) { await play(db, 1, 'M1001', 12, 5, r); await play(db, 2, 'M2001', 9, 3, r); await play(db, 3, 'W3001', 4, 14, r); }
  const lb = db.get('meta/leaderboard');
  const t1 = lb.teams.find(x => x.k === S.teamKey('MaZoo', 'T1'));
  assert.deepEqual(t1.h.map(x => x.r), [1, 2]);
  assert.equal(t1.h[0].g, 12); assert.equal(t1.h[0].b, 1); assert.equal(t1.h[1].b, 2); assert.equal(t1.h[0].s, 'Station 1');
  const t4 = lb.teams.find(x => x.k === S.teamKey('MaZoo', 'T4'));
  assert.equal(t4.h[0].g, 0); assert.equal(t4.h[0].b, 1);
  assert.equal(lb.rounds.length, 2); assert.equal(lb.rounds[1].w, 'MaZoo'); assert.equal(lb.rounds[1].bonus, 2);
});
