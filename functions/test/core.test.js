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
const win = (db, i, code, amount, round) => core.recordMatch(db, 'gl' + i, { code, amount, round });

test('scan one member: nothing is paid until the round is complete, then the whole team gets it once', async () => {
  const db = setup(1);
  const r1 = await win(db, 1, 'M1003', 20);
  assert.equal(r1.status, 'recorded'); assert.equal(r1.winner, 'T1'); assert.equal(r1.round_state.closed, false);
  assert.deepEqual(r1.round_state.missing.sort(), ['Station 2', 'Station 3']);
  assert.equal(aura(db, 'M1001'), 0); // pending
  await win(db, 2, 'M2001', 30); const last = await win(db, 3, 'W3002', 40);
  assert.equal(last.round_state.closed, true);
  // MaZoo won 2 of 3 -> bonus 1 for every MaZoo player
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M100' + n), 21);
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M200' + n), 31);
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M300' + n), 1);   // lost, still bonus
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'M400' + n), 1);   // resting team, bonus
  for (let n = 1; n <= 5; n++) assert.equal(aura(db, 'W300' + n), 40);  // won, no bonus
  assert.equal(aura(db, 'W1001'), 0);
  // camp totals count each team once: MaZoo T1 20 + T2 30 + bonus 1 x 4 teams; WiSoo T3 40
  assert.deepEqual(db.get('meta/teams'), { MaZoo: 20 + 30 + 4, WiSoo: 40 });
});
test('second scan of the same team, or of the opponent, changes nothing', async () => {
  const db = setup(1);
  await win(db, 1, 'M1001', 20);
  const again = await win(db, 1, 'M1002', 20), opp = await win(db, 1, 'W1001', 20);
  assert.equal(again.status, 'already'); assert.equal(opp.status, 'already'); assert.equal(opp.winner, 'T1');
  await win(db, 2, 'M2001', 20); await win(db, 3, 'M3001', 20);
  const before = aura(db, 'M1001');
  const late = await win(db, 1, 'W1001', 20);
  assert.equal(late.status, 'already'); // round is closed and the game is locked
  assert.equal(aura(db, 'M1001'), before); assert.equal(aura(db, 'W1001'), 0);
});
test('permissions: not staff, wrong station, station leader, draw by a leader, bad amounts', async () => {
  const db = setup(1);
  await assert.rejects(core.recordMatch(db, 'nobody', { code: 'M1001', amount: 5 }), e => e.code === 'permission-denied');
  await assert.rejects(core.recordMatch(db, null, { code: 'M1001', amount: 5 }), e => e.code === 'unauthenticated');
  await assert.rejects(core.recordMatch(db, 'stl', { code: 'M1001', amount: 5 }), e => e.code === 'permission-denied');
  await assert.rejects(core.recordMatch(db, 'gl2', { code: 'M1001', amount: 5 }), e => e.code === 'failed-precondition'); // T1 is at Station 1
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M4001', amount: 5 }), e => e.code === 'failed-precondition'); // T4 not scheduled
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', result: 'draw' }), e => e.code === 'permission-denied');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', amount: 0 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', amount: 5000 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'M1001', amount: 2.5 }), e => e.code === 'invalid-argument');
  await assert.rejects(core.recordMatch(db, 'gl1', { code: 'ZZ99', amount: 5 }), e => e.code === 'not-found');
  assert.equal(db.get('matches/1_station-1'), undefined);
});
test('a leader cannot pick another station: the account station is always used', async () => {
  const db = setup(1);
  const r = await core.recordMatch(db, 'gl1', { code: 'M1001', amount: 10, station: 'Station 2' });
  assert.equal(r.station, 'Station 1');
});
test('fixed points from meta/gamepoints override what is typed', async () => {
  const db = setup(1); db.put('meta/gamepoints', { fixed: { 'station-1': 100 } });
  const r = await core.recordMatch(db, 'gl1', { code: 'M1001', amount: 7 });
  assert.equal(r.amount, 100);
});
test('tied round (2 wins each + draw handled by Full staff): points swap, no bonus', async () => {
  const db = setup(1);
  // 3 games: M wins 1, W wins 1, one draw -> nobody has more than half (needs 2) -> tie
  await win(db, 1, 'M1001', 10); await win(db, 2, 'W2001', 20);
  const d = await core.adminMatch(db, 'full', { action: 'noresult', round: 1, station: 'Station 3' });
  assert.equal(d.rounds[0].state.closed, true); assert.equal(d.rounds[0].state.winnerCamp, null);
  assert.equal(aura(db, 'W1001'), 10);  // M team won game 1 -> WiSoo T1 gets the points
  assert.equal(aura(db, 'M1001'), 0);
  assert.equal(aura(db, 'M2001'), 20);  // W team won game 2 -> MaZoo T2 gets the points
  assert.equal(aura(db, 'W2001'), 0);
  assert.equal(aura(db, 'M3001'), 0); assert.equal(aura(db, 'W3001'), 0); // draw
  assert.equal(aura(db, 'M4001'), 0); // no bonus
});
test('Full staff correction: flipping a winner re-applies exactly, and later bonuses follow', async () => {
  const db = setup(2);
  for (const [i, c] of [[1, 'M1001'], [2, 'M2001'], [3, 'M3001']]) await win(db, i, c, 10, 1); // round 1: MaZoo wins all
  for (const [i, c] of [[1, 'M1001'], [2, 'M2001'], [3, 'M3001']]) await win(db, i, c, 10, 2); // round 2: MaZoo wins all
  assert.equal(aura(db, 'M1001'), 10 + 1 + 10 + 2); assert.equal(aura(db, 'W1001'), 0);
  assert.equal(db.get('rounds/2').bonus, 2);
  // Round 1 was really won by WiSoo in stations 1 and 2.
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 1', winner: 'B', amount: 10 });
  const r = await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 2', winner: 'B', amount: 10 });
  assert.equal(db.get('rounds/1').winnerCamp, 'WiSoo');
  assert.equal(db.get('rounds/2').bonus, 1); // MaZoo's second win is now its first (it lost round 1)
  assert.equal(aura(db, 'W1001'), 10 + 1);             // won its game in round 1 + bonus 1; round 2 nothing
  assert.equal(aura(db, 'M1001'), 0 + 10 + 1);         // lost round 1 (nothing), round 2: 10 + bonus 1
  assert.equal(aura(db, 'M3001'), 10 + 0 + 10 + 1);    // M3 still won its game in round 1, no round-1 bonus; round 2: 10 + 1
  assert.equal(aura(db, 'W4001'), 1);                  // resting team: round-1 bonus only
  assert.equal(aura(db, 'M4001'), 0 + 1);              // resting team: round-2 bonus (now 1)
  // Running the same correction again changes nothing.
  const snapshot = JSON.stringify([...db.store.entries()].filter(([k]) => k.startsWith('players/')));
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 2', winner: 'B', amount: 10 });
  assert.equal(JSON.stringify([...db.store.entries()].filter(([k]) => k.startsWith('players/'))), snapshot);
  // Camp totals follow the team points: MaZoo T3 (10) + bonus 1x4 teams in round 2... recomputed from rounds docs
  const sum = c => [1, 2].reduce((t, rr) => t + Object.entries(db.get('rounds/' + rr).teamPoints).filter(([k]) => k.startsWith(c)).reduce((a, [, v]) => a + v, 0), 0);
  assert.deepEqual(db.get('meta/teams'), { MaZoo: sum('MaZoo'), WiSoo: sum('WiSoo') });
});
test('correction by a non-Full account is refused', async () => {
  const db = setup(1);
  await assert.rejects(core.adminMatch(db, 'gl1', { action: 'noresult', round: 1, station: 'Station 1' }), e => e.code === 'permission-denied');
});
test('roster changes after a round closed do not move points already given', async () => {
  const db = setup(1);
  for (const [i, c] of [[1, 'M1001'], [2, 'M2001'], [3, 'M3001']]) await win(db, i, c, 10);
  const before = aura(db, 'M1001');
  const p = db.get('players/M1001'); p.teamName = 'T4'; db.put('players/M1001', p); // moved to another team in the sheet
  await core.adminMatch(db, 'full', { action: 'set', round: 1, station: 'Station 1', winner: 'A', amount: 10 }); // same result again
  assert.equal(aura(db, 'M1001'), before);
});

test('public leaderboard lists every team with its total, including teams on a break', async () => {
  const db = setup(1);
  await win(db, 1, 'M1003', 20); await win(db, 2, 'M2001', 30); await win(db, 3, 'W3002', 40);
  const lb = db.get('meta/leaderboard');
  assert.equal(lb.teams.length, 8);                                   // 4 + 4 teams, resting ones included
  const pts = {}; lb.teams.forEach(x => { pts[x.k] = x.p; });
  assert.equal(pts[S.teamKey('MaZoo', 'T1')], 21);                     // 20 + bonus 1
  assert.equal(pts[S.teamKey('MaZoo', 'T4')], 1);                      // rested, still got the camp bonus
  assert.equal(pts[S.teamKey('WiSoo', 'T3')], 40);
  assert.equal(pts[S.teamKey('WiSoo', 'T1')], 0);
  assert.equal(lb.teams[0].p, 40);                                     // sorted best first
});

test('leaderboard keeps a round-by-round history per team and a summary per round', async () => {
  const db = setup(2);
  for (const r of [1, 2]) { await win(db, 1, 'M1001', 20, r); await win(db, 2, 'M2001', 30, r); await win(db, 3, 'W3001', 40, r); }
  const lb = db.get('meta/leaderboard');
  const t1 = lb.teams.find(x => x.k === S.teamKey('MaZoo', 'T1'));
  assert.deepEqual(t1.h.map(x => x.r), [1, 2]);
  assert.equal(t1.h[0].g, 20); assert.equal(t1.h[0].b, 1); assert.equal(t1.h[1].b, 2); assert.equal(t1.h[0].s, 'Station 1');
  const t4 = lb.teams.find(x => x.k === S.teamKey('MaZoo', 'T4'));
  assert.equal(t4.h[0].g, 0); assert.equal(t4.h[0].b, 1);            // resting team: no game, still the camp bonus
  assert.equal(lb.rounds.length, 2); assert.equal(lb.rounds[1].w, 'MaZoo'); assert.equal(lb.rounds[1].bonus, 2);
});
