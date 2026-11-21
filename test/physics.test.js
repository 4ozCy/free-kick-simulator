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
