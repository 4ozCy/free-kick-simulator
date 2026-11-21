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

test('aim assist scores from anywhere, whatever the strike', () => {
  for (const spot of [undefined, { dist: 17, ang: 0 }, { dist: 40, ang: -50 }, { dist: 30, ang: 55 }])
    for (const style of [0, 1, 2, 3]) for (const aim of [-1, 0, 1]) for (const v of [-0.9, 0.9])
      for (const mega of [false, true]) for (const insane of [false, true]) {
        const w = Sim.newWorld(5, 3, spot);
        Sim.kick(w, { style, aim, power: 1, u: 0.9, v, mega, insane, assist: true });
        for (let i = 0; i < 240 * 6 && !w.result; i++) Sim.step(w, 1 / 240);
        assert.equal(w.result, 'goal', JSON.stringify({ spot, style, aim, v, mega, insane }));
      }
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
