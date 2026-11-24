// Run: node --test test/physics.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Sim = require('../www/game.js');

const fly = (lvl, shot, seed = 7) => {
  const w = Sim.newWorld(lvl, seed);
  Sim.kick(w, shot);
  for (let i = 0; i < 240 * 6 && !w.result; i++) Sim.step(w, 1 / 240);
  return w;
};
const endX = (shot) => Sim.preview(Sim.newWorld(0, 1), shot, 25).at(-1)[0];

test('curve bends away from the strike side, trivela bends the other way', () => {
  const base = { aim: 0, power: 0.6, v: 0 };
  assert.ok(endX({ ...base, style: 1, u: 0.7 }) < endX({ ...base, style: 1, u: 0 }) - 1);
  assert.ok(endX({ ...base, style: 2, u: 0.7 }) > endX({ ...base, style: 2, u: 0 }) + 1);
});

test('knuckleball has zero spin but wobbles differently each strike', () => {
  const shot = { style: 3, aim: 0.2, power: 1, u: 0.5, v: 0.3 };
  const xs = [1, 2].map((seed) => {
    const w = Sim.newWorld(6, seed);
    Sim.kick(w, shot);
    assert.equal(Math.hypot(w.ball.sx, w.ball.sy, w.ball.sz), 0);
    for (let i = 0; i < 200; i++) Sim.step(w, 1 / 240);
    return w.ball.x;
  });
  assert.ok(Math.abs(xs[0] - xs[1]) > 0.1);
});

test('striking low lofts the ball, striking high keeps it down', () => {
  const w = Sim.newWorld(0, 1), s = { style: 1, aim: 0, power: 0.6, u: 0 };
  assert.ok(Sim.preview(w, { ...s, v: -0.8 }, 9).at(-1)[1] > Sim.preview(w, { ...s, v: 0.8 }, 9).at(-1)[1] + 1);
});

test('a straight driven shot at the wall does not score', () => {
  assert.notEqual(fly(0, { style: 0, aim: 0, power: 0.8, u: 0, v: 0.2 }).result, 'goal');
});

test('every scripted level can be scored', () => {
  for (let L = 0; L < Sim.LEVELS.length; L++) {
    let found = false;
    search: for (let s = 0; s < 4; s++) for (let a = -1; a <= 1.001; a += 0.1) for (const p of [0.4, 0.7, 1])
      for (const u of [-0.8, -0.4, 0, 0.4, 0.8]) for (const v of [-0.8, -0.4, 0]) {
        if (fly(L, { style: s, aim: a, power: p, u, v }).result === 'goal') { found = true; break search; }
      }
    assert.ok(found, 'level ' + (L + 1) + ' has no scoring shot');
  }
});

test('1000 km/h top speed, and that shot does not tunnel through the wall', () => {
  assert.equal(Math.round(Sim.speed({ style: 0, power: 1, mega: true }) * 3.6), 1000);
  assert.equal(fly(0, { style: 0, aim: 0, power: 1, u: 0, v: 0.25, mega: true }).result, 'wall');
});

test('mega curve bends several times harder', () => {
  const s = { style: 1, aim: 0, power: 0.6, u: 0.7, v: 0 };
  assert.ok(endX({ ...s, insane: true }) < endX(s) * 3);
});

test('chaos: many different random events, each shot still resolves, and the same seed repeats it', () => {
  const run = (seed) => { const w = Sim.newWorld(4, seed); Sim.kick(w, { style: 1, aim: 0, power: 0.7, u: 0.3, v: -0.3, chaos: true }); for (let i = 0; i < 1440 && !w.result; i++) Sim.step(w, 1 / 240); return w; };
  const names = new Set();
  for (let s = 1; s <= 120; s++) { const w = run(s); names.add(w.chaos.name); assert.ok(w.result, 'shot ended'); }
  assert.ok(names.size >= 15, `only ${names.size} different events`);
  assert.equal(run(9).ball.x, run(9).ball.x);
});
test('chaos: a gust blows the ball sideways compared with the same shot with no chaos', () => {
  const plain = Sim.newWorld(0, 3), gust = Sim.newWorld(0, 3);
  Sim.kick(plain, { style: 0, aim: 0, power: 0.6, u: 0, v: -0.3 });
  Sim.kick(gust, { style: 0, aim: 0, power: 0.6, u: 0, v: -0.3 });
  gust.chaos = { name: 'GUST', kind: 'push', ax: 6, ay: 0, az: 0, dur: 1, t0: 0.2, done: false };
  for (let i = 0; i < 480; i++) { Sim.step(plain, 1 / 240); Sim.step(gust, 1 / 240); }
  assert.ok(gust.ball.x > plain.ball.x + 0.3, `gust moved it ${(gust.ball.x - plain.ball.x).toFixed(2)} m`);
});
test('a chosen spot moves the ball', () => {
  const w = Sim.newWorld(0, 1, { dist: 35, ang: 30 });
  assert.ok(Math.abs(Math.hypot(w.ball.x, w.ball.z) - 35) < 1e-9 && w.ball.x > 0);
});

test('a power shot can clear the wall and dip under the bar from 26 m central', () => {
  let over = 0;
  for (let v = -1; v <= -0.4; v += 0.1) for (const power of [0.6, 0.8, 1]) for (const aim of [-0.25, 0.25]) {
    const w = Sim.newWorld(6, 1); w.keeper.z = 50; // keeper out of the way: testing the flight only
    Sim.kick(w, { style: 0, aim, power, u: 0, v });
    let atWall = 0;
    for (let i = 0; i < 240 * 6 && !w.result; i++) { Sim.step(w, 1 / 240); if (!atWall && w.ball.z > w.wall[0].z) atWall = w.ball.y; }
    if (w.result === 'goal' && atWall > 2) over++;
  }
  assert.ok(over >= 3, 'only ' + over + ' power shots went over the wall and in');
});

test('stars: goal 1, first-ball goal 2, first ball plus a trick 3; misses 0', () => {
  const w = (result, ev = {}, st = {}) => ({ result, ev, st });
  assert.equal(Sim.stars(w('save'), true), 0);
  assert.equal(Sim.stars(w('goal'), false), 1);
  assert.equal(Sim.stars(w('goal', { target: true }), false), 1);
  assert.equal(Sim.stars(w('goal'), true), 2);
  for (const [ev, st] of [[{ target: true }, {}], [{ post: 1 }, {}], [{}, { late: true }], [{}, { knuckle: true }]])
    assert.equal(Sim.stars(w('goal', ev, st), true), 3);
});

test('streak multiplier climbs to x5; near-miss gap is measured from the frame', () => {
  assert.deepEqual([0, 1, 2, 4, 9].map(Sim.multiplier), [1, 2, 3, 5, 5]);
  const gap = (x, y) => Sim.missBy({ ev: { out: { x, y } } });
  assert.ok(Math.abs(gap(Sim.HW + 0.3, 1) - (0.3 - Sim.R - Sim.PR)) < 1e-9);
  assert.ok(Math.abs(gap(0, Sim.GH + 0.5) - (0.5 - Sim.R - Sim.PR)) < 1e-9);
  assert.equal(Sim.missBy({ ev: {} }), null);
});

test('skill ladder: XP thresholds map to ranks; goals earn more XP for stars, streaks and distance', () => {
  assert.equal(Sim.xpFor(2, 1, 25, true), 10 * Sim.xpFor(2, 1, 25), 'CHAOS mode pays 10x XP');
  assert.deepEqual([0, 79, 80, 450, 1999, 2000, 99999].map(Sim.rankOf), [0, 0, 1, 3, 5, 6, 6]);
  assert.ok(Sim.xpFor(3, 0, 18) > Sim.xpFor(1, 0, 18));
  assert.ok(Sim.xpFor(1, 4, 18) > Sim.xpFor(1, 0, 18));
  assert.ok(Sim.xpFor(1, 0, 30) > Sim.xpFor(1, 0, 18));
});

test('perks: CANNON adds 10% top speed, WHIP MASTER bends it further', () => {
  const s = { style: 1, power: 1 };
  assert.ok(Math.abs(Sim.speed({ ...s, pw: 0.1 }) - Sim.speed(s) - 0.1 * Sim.STYLES[1].vMax) < 1e-9);
  const c = { style: 1, aim: 0, power: 0.6, u: 0.7, v: 0 };
  assert.ok(endX({ ...c, cv: 0.2 }) < endX(c) - 0.3);
});

test('keeper is beatable in the corners but still saves shots hit near him', () => {
  let farS = 0, farN = 0, nearS = 0, nearN = 0, seed = 1;
  for (const L of [2, 8]) for (let st = 0; st < 4; st++) for (let a = -1; a <= 1.001; a += 0.2) for (const p of [0.4, 0.7, 1]) for (const v of [-0.8, -0.4, 0]) {
    const shot = { style: st, aim: a, power: p, u: 0.6 * Math.sign(a), v }, sd = seed++;
    const free = Sim.newWorld(L, sd); free.keeper.z = 50; Sim.kick(free, shot);
    for (let i = 0; i < 1440 && !free.result; i++) Sim.step(free, 1 / 240);
    if (free.result !== 'goal') continue; // only shots that were going in
    const w = fly(L, shot, sd), dx = Math.abs(free.ev.goal.x - w.keeper.px);
    if (dx > 2.4) { farN++; if (w.result !== 'goal') farS++; } else if (dx < 1.2) { nearN++; if (w.result !== 'goal') nearS++; }
  }
  assert.ok(farN > 10 && farS / farN < 0.35, `corner shots saved ${farS}/${farN}`);
  assert.ok(nearN > 10 && nearS / nearN > 0.5, `near shots saved ${nearS}/${nearN}`);
});

test('hero perks: extra topspin dips the ball lower, knuckle bonus wobbles it harder', () => {
  const w = Sim.newWorld(6, 1), s = { style: 0, aim: 0, power: 0.8, u: 0, v: -0.6 };
  assert.ok(Sim.preview(w, { ...s, tp: 0.35 }, 20).at(-1)[1] < Sim.preview(w, s, 20).at(-1)[1] - 0.3);
  const x = (kn) => { const v = Sim.newWorld(6, 5); Sim.kick(v, { style: 3, aim: 0, power: 1, u: 0, v: 0, kn }); for (let i = 0; i < 220; i++) Sim.step(v, 1 / 240); return v.ball.x; };
  assert.ok(Math.abs(x(1) - x(0)) > 0.05);
});

test('knuckleball dips late instead of sailing over, and scores about as often as a curler', () => {
  let kg = 0, ko = 0, cg = 0, n = 0, seed = 1;
  for (const L of [0, 6]) for (let a = -1; a <= 1.001; a += 0.2) for (const p of [0.5, 0.8, 1]) for (const v of [-0.9, -0.5, 0]) {
    const sd = seed++, k = fly(L, { style: 3, aim: a, power: p, u: 0, v }, sd), c = fly(L, { style: 1, aim: a, power: p, u: 0.6 * Math.sign(a), v }, sd);
    n++; if (k.result === 'goal') kg++; if (k.result === 'over') ko++; if (c.result === 'goal') cg++;
  }
  assert.ok(ko / n < 0.25, `knuckleballs over the bar: ${ko}/${n}`);
  assert.ok(kg >= cg * 0.6, `knuckle goals ${kg} vs curve goals ${cg}`);
});

test('replays: rebuilding a world from the recorded inputs replays the exact same shot', () => {
  const rec = { n: 7, seed: 12345, spot: { dist: 27, ang: -12 }, habit: 0.5, react: 0.5, read: 0.4, shot: { style: 2, aim: -0.3, power: 0.8, u: 0.6, v: -0.4, cv: 0.2, kn: 0.1 } };
  const play = () => {
    const w = Sim.newWorld(rec.n, rec.seed, Object.assign({}, rec.spot, { habit: rec.habit }));
    w.L.react = rec.react; w.L.read = rec.read;
    Sim.kick(w, rec.shot);
    for (let i = 0; i < 240 * 6 && !w.result; i++) Sim.step(w, 1 / 240);
    return [w.result, w.ball.x, w.ball.y, w.ball.z, w.keeper.bx, w.keeper.by].join();
  };
  assert.equal(play(), play());
});

test('keeper stands on the angle between the posts and cheats away from the wall', () => {
  assert.ok(Math.abs(Sim.newWorld(0, 1).keeper.x) < 1e-9); // central kick: dead centre
  assert.ok(Sim.newWorld(2, 1).keeper.x < 0); // ball on the right, wall covers the near post: he favours the left
  assert.ok(Sim.newWorld(4, 1).keeper.x > 0); // and the mirror case
});

test('keeper learns habits: leans to the favoured side and stops more shots there', () => {
  assert.ok(Sim.newWorld(6, 1, { habit: 1 }).keeper.x > Sim.newWorld(6, 1).keeper.x + 0.3);
  let base = 0, learned = 0, seed = 1;
  for (const L of [3, 6]) for (let a = 0.1; a <= 1.001; a += 0.1) for (const p of [0.5, 0.8]) for (const st of [0, 1, 3]) for (const v of [-0.8, -0.4]) {
    const shot = { style: st, aim: a, power: p, u: st === 1 ? 0.6 : 0, v }, sd = seed++;
    const run = (spot) => { const w = Sim.newWorld(L, sd, spot); Sim.kick(w, shot); for (let i = 0; i < 1440 && !w.result; i++) Sim.step(w, 1 / 240); return w; };
    const a0 = run(undefined), a1 = run({ habit: 1 });
    if (a0.ev.goal && a0.ev.goal.x > 0) base++;     // right-side goals against a fresh keeper
    if (a1.ev.goal && a1.ev.goal.x > 0) learned++;  // ... against one who expects the right
  }
  assert.ok(learned < base, `right-side goals: fresh keeper ${base}, learned keeper ${learned}`);
});

test('people chaos: shoelaces, cat, nap, giant keeper, dance and strike do what they say', () => {
  const ev = (name) => Sim.CHAOS.find((e) => e.name === name);
  const run = (L, shot, name, until) => {
    const w = Sim.newWorld(L, 2); Sim.kick(w, shot); if (name) Sim.applyChaos(w, ev(name));
    for (let i = 0; i < 1440 && !w.result && !(until && until(w)); i++) Sim.step(w, 1 / 240);
    return w;
  };
  const atWall = { style: 0, aim: 0, power: 0.7, u: 0, v: -0.3 }; // normally hits the wall at chest height (1.2 m)
  assert.ok(run(0, atWall).ev.wall, 'normally blocked');
  const laces = run(0, atWall, 'SHOELACES');
  assert.ok(!laces.ev.wall, 'goes over a wall lying on the grass');
  assert.ok(laces.wall.every((d) => d.y === 0) && laces.keeper.state === 'down', 'nobody jumps, keeper flat out');
  assert.ok(!run(0, atWall, 'ON STRIKE').ev.wall, 'no wall to hit');
  // cat: he dives away from where he reads the ball going
  const right = { style: 1, aim: 0.6, power: 0.7, u: 0, v: -0.5 }, decided = (w) => w.keeper.t0 !== undefined;
  const calm = run(6, right, null, decided), cat = run(6, right, 'CAT', decided);
  assert.ok(Math.sign(calm.keeper.tx - calm.keeper.px) === -Math.sign(cat.keeper.tx - cat.keeper.px), 'cat sends him the other way');
  assert.equal(run(6, right, 'NAP').keeper.state, 'ready'); // never moved
  const g = Sim.newWorld(6, 2); Sim.kick(g, right); Sim.applyChaos(g, ev('GIANT KEEPER')); Sim.step(g, 1 / 240);
  assert.ok(Math.abs(g.keeper.by - 1.7 * 1.5) < 1e-9, 'giant keeper stands 1.5x tall');
  const spread = (w) => Math.max(...w.wall.slice(1).map((d, i) => Math.hypot(d.x - w.wall[i].x, d.z - w.wall[i].z)));
  const d0 = Sim.newWorld(6, 2), d1 = Sim.newWorld(6, 2); Sim.kick(d1, right); Sim.applyChaos(d1, ev('DANCE'));
  assert.ok(spread(d1) > spread(d0) + 0.3, 'dancing opens gaps in the wall');
});

test('goal and taker chaos: big/tiny goal, juggle, dribble and cheeky chip do what they say', () => {
  const ev = (name) => Sim.CHAOS.find((e) => e.name === name);
  const at = (name, x) => { // a ball rolled at the goal line at x, 1 m up, with the keeper frozen in the middle
    const w = Sim.newWorld(0, 2); Sim.kick(w, { style: 0, aim: 0, power: 0.5, u: 0, v: 0 });
    if (name) Sim.applyChaos(w, ev(name));
    w.L.react = 99; Object.assign(w.ball, { x, y: 1, z: -1, vx: 0, vy: 0, vz: 12, sx: 0, sy: 0, sz: 0 }); w.wob = null;
    for (let i = 0; i < 960 && !w.result; i++) Sim.step(w, 1 / 240);
    return w.result;
  };
  assert.notEqual(at(null, 4.5), 'goal'); assert.equal(at('BIG GOAL', 4.5), 'goal');
  assert.equal(at(null, 2.8), 'goal'); assert.notEqual(at('TINY GOAL', 2.8), 'goal');
  Sim.newWorld(0, 1); assert.deepEqual(Sim.goal(), [3.66, 2.44], 'the next shot gets a normal goal back');

  const run = (L, s, name) => { const w = Sim.newWorld(L, s); Sim.kick(w, { style: 1, aim: 0.1, power: 0.7, u: 0.3, v: -0.3, chaos: true, chaosName: name }); const log = []; for (let i = 0; i < 240 * 8 && !w.result; i++) { Sim.step(w, 1 / 240); log.push([w.ft, Math.hypot(w.ball.x - w.start.x, w.ball.z - w.start.z)]); } return { w, log }; };
  const j = run(4, 3, 'JUGGLE');
  assert.ok(j.log.filter(([t]) => t < 1.55).every(([, d]) => d < 0.01), 'keeps it on the spot while juggling');
  assert.ok(j.w.tOff >= 1.6 && j.w.result, 'then volleys it and the shot resolves');
  for (let L = 0; L < 12; L++) for (let s = 1; s <= 5; s++) {
    assert.equal(run(L, s, 'DRIBBLE').w.result, 'goal', 'dribbles it in on level ' + L);
    assert.equal(run(L, s, 'CHEEKY CHIP').w.result, 'goal', 'chips it in on level ' + L);
  }
  const d = run(5, 1, 'DRIBBLE').w;
  assert.ok(d.keeper.state === 'down' && !d.ev.wall && !d.ev.save, 'round the wall, keeper sold a dummy');
});

test('daily challenge: same kick for everyone on a date, numbered from day one, always scorable', () => {
  const a = Sim.daily(2026, 11, 25), b = Sim.daily(2026, 11, 25), c = Sim.daily(2026, 11, 26);
  assert.deepEqual(a, b, 'the same date always gives the same kick');
  assert.equal(Sim.daily(2026, 11, 24).no, 1); assert.equal(a.no, 2); assert.equal(c.no, 3); assert.equal(Sim.daily(2027, 1, 1).no, 39);
  assert.notDeepEqual(a.spot, c.spot, 'the next day is a different kick');
  const shots = [];
  for (let st = 0; st < 4; st++) for (let aim = -1; aim <= 1.001; aim += 0.1) for (const v of [-0.8, -0.4, 0]) for (const u of [-0.6, 0, 0.6]) shots.push({ style: st, aim, power: 0.75, u, v });
  for (let i = 0; i < 30; i++) {
    const day = new Date(Date.UTC(2026, 10, 25 + i)), d = Sim.daily(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    assert.ok(d.spot.dist >= 20 && d.spot.dist <= 32 && Math.abs(d.spot.ang) <= 30 && d.spot.wallN >= 3 && d.spot.wallN <= 5, 'sensible kick ' + d.no);
    const scores = shots.some((s) => { const w = Sim.newWorld(d.n, d.seed, Object.assign({}, d.spot, { habit: 0 })); Sim.kick(w, s); for (let k = 0; k < 1440 && !w.result; k++) Sim.step(w, 1 / 240); return w.result === 'goal'; });
    assert.ok(scores, 'daily #' + d.no + ' can be scored');
  }
});
