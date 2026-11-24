'use strict';
// Retro Free Kick. The simulation section is pure JS (node runs it in test/); the rest is canvas + WebAudio.
(function () {
  // =================================================================== SIMULATION
  // World metres: x = right, y = up, z = toward the goal. Goal line is z = 0, goal centre x = 0.
  const DEG = Math.PI / 180;
  const G = 9.81, R = 0.11, ND = 2.0, PR = 0.06;
  let HW = 3.66, GH = 2.44; // goal half-width and height; chaos can scale them for one shot (setGoal)
  const DRAG = 0.012, MAGNUS = 0.36, WALL_D = 9.15;
  const TARGETS = [[-HW + 0.6, GH - 0.55], [HW - 0.6, GH - 0.55]], TARGET_R = 0.5;
  function setGoal(k) { HW = 3.66 * k; GH = 2.44 * k; TARGETS[0] = [-HW + 0.6 * k, GH - 0.55 * k]; TARGETS[1] = [HW - 0.6 * k, GH - 0.55 * k]; }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  function mulberry32(a) {
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // spin > 0: striking right of centre bends the ball left (inside of the boot). Trivela flips it and swerves late.
  // elev/loft: launch angle = elev - v * loft (deg). top0/top: topspin = top0 + v * top, so every struck shot dips
  // (curlers and drives carry topspin) and striking low only lofts it instead of ballooning it with backspin
  const STYLES = [
    { name: 'POWER', desc: 'DRIVEN, FAST, DIPS LATE', vMin: 20, vMax: 34, elev: 9, loft: 11, spin: 0.25, top0: 0.75, top: 0.3, u: 0, v: -0.3 },
    { name: 'CURVE', desc: 'WHIP IT AROUND THE WALL', vMin: 15, vMax: 28, elev: 14, loft: 11, spin: 1.0, top0: 0.6, top: 0.3, u: 0.65, v: -0.2 },
    { name: 'TRIVELA', desc: 'OUTSIDE BOOT, LATE SWERVE', vMin: 17, vMax: 30, elev: 12, loft: 11, spin: -1.15, top0: 0.5, top: 0.3, u: 0.55, v: -0.1, late: true },
    { name: 'KNUCKLE', desc: 'NO SPIN: WOBBLES, DIPS LATE', vMin: 22, vMax: 33, elev: 10, loft: 11, spin: 0, top0: 0, top: 0, u: 0, v: 0, knuckle: true },
  ];

  // [distance m, angle deg (+ = ball right of goal), wall men, wind m/s, top-corner targets]
  const LEVELS = [
    [18, 0, 3, 0, 0], [20, -14, 3, 0, 0], [21, 16, 4, 1, 1], [23, 0, 4, 1.5, 0],
    [24, -20, 4, 2, 1], [25, 12, 5, 2, 1], [26, 0, 5, 3, 1], [27, 22, 4, 3, 1],
    [28, -10, 5, 3.5, 1], [30, 8, 5, 4, 1], [31, -18, 5, 4.5, 1], [32, 0, 5, 5, 1],
  ];

  function makeLevel(n) {
    let d, a, wn, ws, tg;
    if (n < LEVELS.length) [d, a, wn, ws, tg] = LEVELS[n];
    else { const r = mulberry32(n * 7919); d = 26 + r() * 6; a = (r() - 0.5) * 44; wn = 5; ws = 3 + r() * 3; tg = 1; }
    const wa = n * 2.39996 + 1; // golden-angle steps: wind direction varies per level but repeats on retry
    return {
      n, dist: d, ang: a, wallN: wn, windSpeed: ws, targets: !!tg, wind: { x: Math.cos(wa) * ws, z: Math.sin(wa) * ws },
      react: Math.max(0.34, 0.48 - n * 0.012), kspeed: Math.min(4.2, 3.2 + n * 0.08), read: Math.min(0.65, 0.3 + n * 0.03),
      reach: Math.min(2.6, 2.1 + n * 0.04), // one dive covers this far sideways from where he stood, no further
    };
  }

  function newWorld(n, seed, spot) { // spot: optional overrides, e.g. { dist, ang } chosen by the player, { habit } learned by the keeper
    setGoal(1); // a goal grown or shrunk by the last shot's chaos goes back to normal
    const L = Object.assign(makeLevel(n), spot), rng = mulberry32(seed | 0), a = L.ang * DEG;
    const ball = { x: L.dist * Math.sin(a), y: R, z: -L.dist * Math.cos(a), vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, rot: 0, held: false };
    const yaw0 = Math.atan2(-ball.x, -ball.z);
    const side = Math.abs(L.ang) > 5 ? Math.sign(L.ang) : 0;
    // outer man lines up just outside the near post, the rest step in toward the middle
    const wallYaw = side ? Math.atan2(side * (HW + 0.3) - ball.x, -ball.z) : yaw0;
    const fx = Math.sin(wallYaw), fz = Math.cos(wallYaw);
    const wall = [];
    for (let i = 0; i < L.wallN; i++) {
      const off = side ? -side * i * 0.62 : (i - (L.wallN - 1) / 2) * 0.62;
      wall.push({ x: ball.x + fx * WALL_D + fz * off, z: ball.z + fz * WALL_D - fx * off, y: 0,
        jt: 0.12 + i * 0.03 + rng() * 0.08, jh: 0.32 + Math.min(0.18, n * 0.015) });
    }
    // keeper: on the line splitting the angle between the posts, cheating toward the side the wall leaves open,
    // and leaning toward the side this player keeps scoring on (habit -1 left .. 1 right)
    const bis = (Math.atan2(-HW - ball.x, -ball.z) + Math.atan2(HW - ball.x, -ball.z)) / 2;
    const kx = clamp(ball.x + Math.tan(bis) * (-0.4 - ball.z) - side * 0.7 + (L.habit || 0) * 0.35, -HW + 0.5, HW - 0.5);
    return {
      L, rng, ball, yaw0, wall, wallYaw, start: { x: ball.x, z: ball.z },
      keeper: { x: kx, z: -0.4, ax: kx, ay: 0.1, bx: kx, by: 1.95, px: kx, tx: 0, ty: 0, tArr: 9, cool: 0, state: 'idle' },
      phase: 'aim', ft: 0, ev: {}, result: null, st: null, wob: null,
    };
  }

  // shot: { style: 0-3, aim: -1..1, power: 0..1, u: -1..1 (strike point, right +), v: -1..1 (up +),
  //         mega: top power 1000 km/h, insane: 4x sidespin, chaos: one random gust or bird per shot,
  //         pw / cv / tp / kn: perk bonuses to top speed / sidespin / topspin dip / knuckle wobble, e.g. 0.1 = +10% }
  const MEGA_V = 1000 / 3.6;
  const speedOf = (shot) => { const st = STYLES[shot.style]; return st.vMin + ((shot.mega ? MEGA_V : st.vMax * (1 + (shot.pw || 0))) - st.vMin) * shot.power; };
  function launch(w, shot, b) {
    const st = STYLES[shot.style], speed = speedOf(shot), cm = (shot.insane ? 4 : 1) * (1 + (shot.cv || 0));
    const yaw = w.yaw0 + shot.aim * (shot.insane ? 0.8 : 0.35) + st.spin * shot.u * 0.05 * cm; // off-centre contact starts it on the outside of the bend
    // harder strikes launch flatter: no change up to 34 m/s, keeps 1000 km/h shots inside the stadium
    const el = clamp(st.elev - shot.v * st.loft, 1, 30) * DEG * Math.min(1, 34 / speed), side = -shot.u * st.spin * cm, top = (st.top0 + shot.v * st.top) * (1 + (shot.tp || 0));
    b.vx = Math.sin(yaw) * Math.cos(el) * speed; b.vy = Math.sin(el) * speed; b.vz = Math.cos(yaw) * Math.cos(el) * speed;
    b.sx = top * Math.cos(yaw); b.sy = side; b.sz = -top * Math.sin(yaw);
    return st;
  }

  // random events for CHAOS. push = force for dur seconds (osc: wobble), hit = one knock, speed = launch multiplier,
  // react = seconds the keeper loses, and anything without an effect is pure show.
  const CHAOS = [
    { name: 'GUST', msg: 'GUST!', sub: 'WIND HITS THE BALL', push: [4, 0, 0, 1] },
    { name: 'TAILWIND', msg: 'TAILWIND!', sub: 'FREE RIDE', push: [0, 0, 6, 1.5] },
    { name: 'HEADWIND', msg: 'HEADWIND!', sub: 'IT PUSHES BACK', push: [0, 0, -6, 1.5] },
    { name: 'BEE', msg: 'BEE!', sub: 'A BEE TAKES A SHINE TO IT', push: [3, 0, 0, 1.2, 12] },
    { name: 'SUPER BOUNCY', msg: 'BOUNCY!', sub: 'THE BALL IS SUPER BOUNCY', push: [0, 6, 0, 0.5] },
    { name: 'ANVIL', msg: 'ANVIL!', sub: 'SOMEONE DROPPED AN ANVIL ON IT', push: [0, -8, 0, 0.6] },
    { name: 'MOON MODE', msg: 'MOON MODE!', sub: 'GRAVITY TAKES A HOLIDAY', push: [0, 4, 0, 2] },
    { name: 'BIRD', msg: 'BIRD!', sub: 'A BIRD CLIPS THE BALL', hit: [0, 1.5, -1.5] },
    { name: 'DOG', msg: 'DOG!', sub: 'A DOG RUNS ON AND HEADS IT', hit: [3, 1, 0] },
    { name: 'PIGEON', msg: 'PIGEON!', sub: 'IT LANDS ON THE BALL AND STARES', hit: [0, -1, 0] },
    { name: 'BEACH BALL', msg: 'BEACH BALL!', sub: 'A FAN TOSSES ONE ON', hit: [1, 2, 0] },
    { name: 'DIVOT', msg: 'DIVOT!', sub: 'THE BALL HOPS OVER IT', hit: [0, 3, 0] },
    { name: 'MASCOT TRIP', msg: 'MASCOT TRIP!', sub: 'THE MASCOT FALLS OVER', hit: [2.5, 0, -2] },
    { name: 'STREAKER', msg: 'STREAKER!', sub: 'HE RUNS STRAIGHT THROUGH IT', hit: [2, 0, -1.5] },
    { name: 'SLIPPERY', msg: 'SLIPPERY!', sub: 'THE GRASS IS LIKE ICE', speed: 0.85 },
    { name: 'DEFLATED', msg: 'DEFLATED!', sub: 'THE BALL IS A BIT SOFT', speed: 0.7 },
    { name: 'SUN GLARE', msg: 'SUN GLARE!', sub: 'THE KEEPER IS DAZZLED', react: 0.35 },
    { name: 'WHISTLE', msg: 'WHISTLE!', sub: 'THE REF BLEW IT EARLY', react: 0.25 },
    { name: 'CONFETTI', msg: 'CONFETTI!', sub: 'PURELY COSMETIC' },
    { name: 'DRIP', msg: 'DRIP!', sub: 'A DRIP FROM THE ROOF - NO EFFECT' },
    { name: 'SHIN PAD', msg: 'SHIN PAD!', sub: 'ONE FLEW OFF THE BENCH - NO EFFECT' },
    { name: 'THE WAVE', msg: 'THE WAVE!', sub: 'THE CROWD DOES THE WAVE - NO EFFECT' },
    { name: 'CORNER FLAG', msg: 'FLAG!', sub: 'THE CORNER FLAG FALLS OVER - NO EFFECT' },
    // these mess with the people, not the ball (wall: trip/selfie/dance/strike, keeper: trip/scared/nap, size: keeper scale)
    { name: 'SHOELACES', msg: 'SHOELACES!', sub: 'EVERYONE TRIPS - EXCEPT YOU', wall: 'trip', keeper: 'trip' },
    { name: 'CAT', msg: 'CAT!', sub: 'IT SCARES THE KEEPER THE WRONG WAY', keeper: 'scared' },
    { name: 'NAP', msg: 'NAP TIME!', sub: 'THE KEEPER DOZED OFF', keeper: 'nap' },
    { name: 'TYING LACES', msg: 'LACES!', sub: 'THE KEEPER IS TYING HIS LACES', react: 0.4 },
    { name: 'GIANT KEEPER', msg: 'GIANT KEEPER!', sub: 'HE ATE ALL HIS GREENS', size: 1.5 },
    { name: 'TINY KEEPER', msg: 'TINY KEEPER!', sub: 'HE SHRANK IN THE WASH', size: 0.6 },
    { name: 'SELFIE', msg: 'SELFIE!', sub: 'THE WALL STOPS TO POSE', wall: 'selfie' },
    { name: 'DANCE', msg: 'DANCE BREAK!', sub: 'THE WALL BUSTS A MOVE', wall: 'dance' },
    { name: 'ON STRIKE', msg: 'ON STRIKE!', sub: 'THE WALL WALKS OFF', wall: 'strike' },
    // these change the goal or what the taker does (goal: frame scale; act: the taker juggles, dribbles or chips instead)
    { name: 'BIG GOAL', msg: 'BIG GOAL!', sub: 'THE GOAL GREW', goal: 1.5 },
    { name: 'TINY GOAL', msg: 'TINY GOAL!', sub: 'THE GOAL SHRANK', goal: 0.6 },
    { name: 'JUGGLE', msg: 'KEEPY-UPPY!', sub: 'HE SHOWS OFF BEFORE HE SHOOTS', act: 'juggle' },
    { name: 'DRIBBLE', msg: 'DRIBBLE!', sub: 'HE TAKES ON EVERYONE', act: 'dribble' },
    { name: 'CHEEKY CHIP', msg: 'CHEEKY CHIP!', sub: 'A SOFT ONE DOWN THE MIDDLE', act: 'chip', keeper: 'scared' },
  ];

  function applyChaos(w, ev) { // at the strike: sets up the event's push/knock, or changes the wall and keeper
    const side = w.rng() < 0.5 ? -1 : 1, m = 0.7 + w.rng() * 0.6, k = w.keeper;
    const c = { name: ev.name, msg: ev.msg, sub: ev.sub, t0: 0.3 + w.rng() * 0.8, done: false, side, wall: ev.wall, keeper: ev.keeper };
    if (ev.push) Object.assign(c, { kind: 'push', ax: (ev.push[0] || 0) * side * m, ay: ev.push[1] || 0, az: ev.push[2] || 0, dur: ev.push[3], osc: ev.push[4] || 0 });
    if (ev.hit) Object.assign(c, { kind: 'hit', vx: (ev.hit[0] || 0) * side * m, vy: ev.hit[1] || 0, vz: ev.hit[2] || 0 });
    if (ev.speed) { w.ball.vx *= ev.speed; w.ball.vy *= ev.speed; w.ball.vz *= ev.speed; }
    if (ev.react) w.L.react += ev.react; // keeper flinches, is dazzled, or is tying his laces
    if (ev.wall === 'trip' || ev.wall === 'selfie') for (const d of w.wall) d.jh = 0; // nobody jumps
    if (ev.wall === 'dance') { // they shuffle apart: gaps open in the wall
      const fx = Math.sin(w.wallYaw), fz = Math.cos(w.wallYaw), n = w.wall.length;
      w.wall.forEach((d, i) => { const o = (i - (n - 1) / 2) * 0.6; d.x += fz * o; d.z -= fx * o; });
    }
    if (ev.keeper === 'trip') k.state = 'down';
    if (ev.keeper === 'nap') w.L.react = 99;
    if (ev.size) { k.scale = ev.size; w.L.reach *= ev.size; }
    if (ev.goal) setGoal(ev.goal);
    const b = w.ball;
    if (ev.act === 'juggle') { c.jug = { dur: 1.6, n: 0, x: b.x, z: b.z, v: [b.vx, b.vy, b.vz] }; b.vx = b.vy = b.vz = 0; }
    if (ev.act === 'dribble') { // ball at his feet: round the wall on one side, past the keeper, into the net
      const fx = Math.sin(w.wallYaw), fz = Math.cos(w.wallYaw), n = w.wall.length;
      const cx = w.wall.reduce((a, d) => a + d.x, 0) / n, cz = w.wall.reduce((a, d) => a + d.z, 0) / n, out = (n * 0.62) / 2 + 1.3;
      const gx = clamp(k.x + side * 1.8, -HW + 0.6, HW - 0.6);
      c.drib = { pts: [[b.x, b.z], [cx + fz * side * out, cz - fx * side * out], [gx, -2.5], [gx, ND - 0.4]], seg: 0, s: 0, kx: b.x, kz: b.z, done: false, tap: 0 };
      b.vx = b.vy = b.vz = b.sx = b.sy = b.sz = 0; w.wob = null; w.L.react = 99; // keeper is frozen by the skills
    }
    if (ev.act === 'chip') { // a soft lob at the middle of the goal: find the loft that drops it in at 1.2 m
      const yaw = Math.atan2(-b.x, -b.z), hs = 14;
      let best = null;
      for (let vy = 4; vy <= 16; vy += 0.25) {
        const q = { x: b.x, y: b.y, z: b.z, vx: Math.sin(yaw) * hs, vy, vz: Math.cos(yaw) * hs, sx: 0, sy: 0, sz: 0 };
        for (let i = 0; i < 2400 && q.z < 0; i++) move(q, w, 1 / 240, i / 240, null, null, null);
        const e = Math.abs(q.y - 1.2);
        if (q.z >= 0 && (!best || e < best.e)) best = { e, vy };
      }
      Object.assign(b, { vx: Math.sin(yaw) * hs, vy: best ? best.vy : 8, vz: Math.cos(yaw) * hs, sx: 0, sy: 0, sz: 0 });
      w.wob = null; w.st = Object.assign({}, w.st, { late: false, knuckle: false });
    }
    w.chaos = c;
  }

  function scripted(w, dt, t, ev) { // the taker's own tricks; returns true while he still has the ball
    const c = w.chaos, b = w.ball;
    if (c.jug && !c.jug.done) { // keepy-uppies on the spot, then a volley with the shot he lined up
      const j = c.jug, u = t / j.dur, hop = Math.abs(Math.sin(Math.PI * 5 * u));
      if (u < 1) {
        b.x = j.x; b.z = j.z; b.y = R + 0.75 * hop; b.rot += dt * 6;
        if (Math.floor(u * 5) !== j.n) { j.n = Math.floor(u * 5); ev.push('touch'); }
        return true;
      }
      j.done = true; w.tOff = t; b.y = 0.5; b.vx = j.v[0]; b.vy = j.v[1]; b.vz = j.v[2]; ev.push('volley');
      return false;
    }
    if (c.drib && !c.drib.done) { // runs the ball round everyone at 7 m/s, little touches, walks it in
      const d = c.drib, k = w.keeper;
      let a = d.pts[d.seg], q = d.pts[d.seg + 1], len = Math.hypot(q[0] - a[0], q[1] - a[1]);
      d.s += 7 * dt;
      while (d.s > len && d.seg < d.pts.length - 2) { d.s -= len; d.seg++; a = d.pts[d.seg]; q = d.pts[d.seg + 1]; len = Math.hypot(q[0] - a[0], q[1] - a[1]); }
      const f = Math.min(1, d.s / len), ux = (q[0] - a[0]) / len, uz = (q[1] - a[1]) / len, pz = b.z;
      b.x = a[0] + (q[0] - a[0]) * f; b.z = a[1] + (q[1] - a[1]) * f; b.y = R + 0.05 * Math.abs(Math.sin(t * 14));
      b.vx = ux * 7; b.vy = 0; b.vz = uz * 7; b.rot += dt * 20;
      d.kx = b.x - ux * 0.55; d.kz = b.z - uz * 0.55; // he runs right behind it
      if (t - d.tap > 0.3) { d.tap = t; ev.push('touch'); }
      if (b.z > -4 && k.state !== 'down') { k.state = 'down'; ev.push('dummy'); } // sold a dummy: keeper on his backside
      if (pz < 0 && b.z >= 0 && !w.ev.goal) w.ev.goal = { x: b.x, y: b.y };
      if (f >= 1 && d.seg === d.pts.length - 2) { d.done = true; b.vx = b.vy = b.vz = 0; ev.push('net'); }
      return true;
    }
    return false;
  }

  function kick(w, shot) {
    w.st = launch(w, shot, w.ball);
    w.wob = w.st.knuckle ? [3.5 + w.rng() * 2, w.rng() * 6.283, 4 + w.rng() * 2, w.rng() * 6.283, 1 + (shot.kn || 0)] : null;
    // chaos: one random event per shot, drawn from the seeded rng so replays repeat it (see CHAOS below)
    w.chaos = null;
    if (shot.chaos) { const r = w.rng(); applyChaos(w, CHAOS.find((e) => e.name === shot.chaosName) || CHAOS[Math.floor(r * CHAOS.length)]); }
    w.phase = 'flight'; w.ft = 0;
  }

  const A = [0, 0, 0];
  const KN = { crisis: 3, from: 31, span: 9, lat: 4, up: 2.5 }; // knuckleball tuning: drag crisis + wobble (tuned so it scores close to a curler)
  function accel(b, wind, t, st, wob) { // st: the kick style (null = plain flight, as the keeper imagines it)
    const rx = b.vx - wind.x, ry = b.vy, rz = b.vz - wind.z, sp = Math.hypot(rx, ry, rz);
    // drag crisis: a spinless ball's drag jumps once it slows below ~31 m/s, so a knuckleball dies and drops late
    const d = DRAG * sp * (st && st.knuckle ? 1 + KN.crisis * smooth((KN.from - sp) / KN.span) : 1);
    const m = st && st.late ? MAGNUS * (0.25 + 1.3 * smooth((t - 0.1) / 0.6)) : MAGNUS;
    A[0] = -d * rx + m * (b.sy * b.vz - b.sz * b.vy);
    A[1] = -G - d * ry + m * (b.sz * b.vx - b.sx * b.vz);
    A[2] = -d * rz + m * (b.sx * b.vy - b.sy * b.vx);
    if (wob) { // no spin: the wake sheds unevenly, so the ball gets shoved sideways and down at random
      const h = Math.hypot(b.vx, b.vz) || 1, k = clamp((Math.hypot(b.vx, b.vy, b.vz) - 14) / 14, 0, 1);
      const lat = KN.lat * k * wob[4] * Math.sin(wob[0] * t + wob[1]);
      A[0] += (lat * b.vz) / h; A[2] -= (lat * b.vx) / h; A[1] += KN.up * k * wob[4] * Math.sin(wob[2] * t + wob[3]);
    }
    return A;
  }

  function move(b, w, dt, t, st, wob, ev) {
    const a = accel(b, w.L.wind, t, st, wob);
    b.vx += a[0] * dt; b.vy += a[1] * dt; b.vz += a[2] * dt;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    const sd = 1 - 0.12 * dt;
    b.sx *= sd; b.sy *= sd; b.sz *= sd;
    if (b.y < R) {
      b.y = R;
      if (b.vy < 0) { if (ev && b.vy < -2) ev.push('bounce'); b.vy = b.vy < -1 ? -b.vy * 0.45 : 0; }
      const f = 1 - 1.5 * dt;
      b.vx *= f; b.vz *= f; b.sx *= 0.9; b.sy *= 0.9; b.sz *= 0.9;
    }
  }

  // ball path with no wobble and no collisions: the aiming arc, and the tests
  function preview(w, shot, maxD) {
    const b = Object.assign({}, w.ball), st = launch(w, shot, b), pts = [];
    let t = 0, gap = 0; // dot every 0.3 m and step <= 10 cm, so 1000 km/h shots get a proper arc too
    for (let i = 0; i < 6000; i++) {
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1, dt = Math.min(1 / 240, 0.1 / sp);
      t += dt; gap += sp * dt;
      move(b, w, dt, t, st, null, null);
      if (gap >= 0.3) { gap = 0; pts.push([b.x, b.y, b.z]); }
      if (Math.hypot(b.x - w.start.x, b.z - w.start.z) > maxD) break;
    }
    return pts;
  }

  // keeper's read of where the ball crosses his line: he sees the spin only partly, and never the wobble or late swerve
  function predict(w, zp) {
    const b = Object.assign({}, w.ball), r = w.L.read;
    b.sx *= r; b.sy *= r; b.sz *= r;
    for (let i = 1; i < 720; i++) {
      move(b, w, 1 / 240, w.ft + i / 240, null, null, null);
      if (b.z >= zp) return { x: b.x, y: b.y, t: w.ft + i / 240 };
      if (b.vz <= 0) return null;
    }
    return null;
  }

  function seg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1), cx = ax + dx * t, cy = ay + dy * t;
    return { d: Math.hypot(px - cx, py - cy), t, cx, cy };
  }

  function updateKeeper(w, dt) {
    const k = w.keeper, L = w.L, b = w.ball, t = w.ft;
    k.cool -= dt;
    if (k.state === 'idle') k.state = 'ready';
    const ks = k.scale || 1;
    if (k.state === 'down') { k.ax = k.x - 0.9 * ks; k.bx = k.x + 0.9 * ks; k.ay = k.by = 0.15; return; } // tripped: flat on the grass
    // the wall hides the strike: he only reads the ball once it's past the wall line
    if (w.seen === undefined && (b.x - w.start.x) * Math.sin(w.yaw0) + (b.z - w.start.z) * Math.cos(w.yaw0) > WALL_D + 0.3) w.seen = t;
    if (k.state === 'ready' && t >= L.react && w.seen !== undefined && t >= w.seen + 0.12) {
      const p = predict(w, k.z);
      if (!p || Math.abs(p.x) > HW + 0.7 || p.y > GH + 0.6) k.state = 'watch';
      else {
        const err = (1 - L.read) * (L.habit && Math.abs(L.habit) >= 0.5 && Math.sign(p.x - k.x) === Math.sign(L.habit) ? 0.5 : 1); // he expected that side
        k.tx = clamp(p.x + (w.rng() - 0.5) * err * 1.6, k.x - L.reach, k.x + L.reach);
        k.ty = clamp(p.y + (w.rng() - 0.5) * err * 0.6, 0.15, 2.45 * ks);
        k.tArr = p.t;
        if (w.chaos && w.chaos.keeper === 'scared') { // the cat: he throws himself the other way
          const d0 = k.tx - k.x;
          k.tx = clamp(k.x - (Math.sign(d0) || 1) * Math.max(1.5, Math.abs(d0)), k.x - L.reach, k.x + L.reach);
        }
        const dx = k.tx - k.x;
        k.state = Math.abs(dx) < 0.5 && k.ty < 2.0 ? 'block' : k.ty < 0.7 ? 'low' : k.ty > 1.7 ? 'high' : 'mid';
        k.px = k.x; k.t0 = t;
        if (k.state === 'block') k.ty = Math.max(k.ty, 1.2); // stay on his feet: body covers the low ball, hands the high one
        else { k.bx = k.x + Math.sign(dx) * 0.3; k.by = 1.4; }
      }
    }
    if (k.state === 'watch') k.x += clamp(clamp(b.x, -HW, HW) - k.x, -1.5 * dt, 1.5 * dt);
    if (k.state === 'ready' || k.state === 'watch') {
      k.ax = k.bx = k.x; k.ay = 0.1; k.by = (k.state === 'ready' ? 1.7 : 1.95) * ks;
      return;
    }
    if (!k.reread && t >= k.t0 + 0.15 && !b.held && !(w.chaos && w.chaos.keeper === 'scared')) { // second look: correct part of the way if the ball is bending away from his read
      k.reread = true;
      const p = predict(w, k.z);
      if (p && Math.abs(p.x - k.tx) > 0.4) {
        k.tx = clamp(k.tx + (p.x - k.tx) * 0.6, k.px - L.reach, k.px + L.reach);
        k.ty = clamp(k.ty + (p.y - k.ty) * 0.6, k.state === 'block' ? 1.2 : 0.15, 2.45 * ks);
      }
    }
    if (k.state !== 'block' && !b.held && t > k.tArr + 0.25) k.ty = 0.3; // ball has gone by: land on the turf
    // hands chase the read; the body trails back toward the take-off foot (max 1.9 m)
    const sp = k.state === 'block' ? 3.5 : L.kspeed;
    const ddx = k.tx - k.bx, ddy = k.ty - k.by, dd = Math.hypot(ddx, ddy), mv = Math.min(dd, sp * dt);
    if (dd > 1e-6) { k.bx += (ddx / dd) * mv; k.by += (ddy / dd) * mv; }
    const ex = k.bx - k.px, ey = k.by, el = Math.hypot(ex, ey) || 1, len = Math.min(el, 1.9 * ks);
    k.ax = k.bx - (ex / el) * len; k.ay = Math.max(0.1, k.by - (ey / el) * len);
  }

  // substeps keep the ball moving <= 10 cm per tick, so even 1000 km/h shots can't skip through the wall or posts
  function step(w, dt) {
    const ev = [], b = w.ball;
    if (w.phase !== 'flight') return ev;
    const n = Math.min(40, Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy, b.vz) * dt) / 0.1)));
    for (let i = 0; i < n; i++) tick(w, dt / n, ev);
    return ev;
  }
  function tick(w, dt, ev) {
    const b = w.ball, k = w.keeper, e = w.ev;
    w.ft += dt;
    const t = w.ft;
    for (const d of w.wall) { const p = (t - d.jt) / 0.55; d.y = p > 0 && p < 1 ? 4 * d.jh * p * (1 - p) : 0; }
    updateKeeper(w, dt);
    const tk = t - (w.tOff || 0); // time since the ball actually left his foot (a juggle delays it)
    if (w.chaos && scripted(w, dt, t, ev)) { /* he still has the ball */ }
    else if (w.chaos && w.chaos.drib) { /* walked in: nothing more to simulate */ }
    else if (b.held) { b.x = k.bx; b.y = Math.max(R, k.by); b.z = k.z + 0.15; b.vx = b.vy = b.vz = 0; }
    else {
      const px = b.x, py = b.y, pz = b.z;
      move(b, w, dt, tk, w.st, w.wob, ev);
      const c = w.chaos;
      if (c && c.kind === 'push' && t >= c.t0 && t < c.t0 + c.dur) { // wind, lift, weight, bees: a force while it lasts
        const o = c.osc ? Math.sin(c.osc * t) : 1;
        b.vx += c.ax * o * dt; b.vy += c.ay * dt; b.vz += c.az * dt;
      }
      if (c && c.kind === 'hit' && !c.done && t >= c.t0 && (b.y > 0.4 || t > c.t0 + 0.6)) { // birds, dogs, divots: one knock
        c.done = true; b.vx += c.vx; b.vy += c.vy; b.vz += c.vz; ev.push('chaos');
      }
      b.rot += dt * (Math.hypot(b.sx, b.sy, b.sz) * 35 + (w.wob ? 0.4 : 0) + Math.hypot(b.vx, b.vz) * 0.05);

      // wall: boxes per defender in the wall's own frame
      const fx = Math.sin(w.wallYaw), fz = Math.cos(w.wallYaw);
      const wc = w.chaos && w.chaos.wall, tall = wc === 'trip' ? 0.35 : 1.86; // tripped: lying on the grass
      for (const d of wc === 'strike' ? [] : w.wall) { // on strike: nobody there
        const rx = b.x - d.x, rz = b.z - d.z, al = rx * fx + rz * fz, la = rx * fz - rz * fx, hy = b.y - d.y;
        const half = hy > 1.6 ? 0.13 : 0.27;
        if (Math.abs(al) < 0.15 + R && Math.abs(la) < half + R && hy > -R && hy < tall + R) {
          const vn = b.vx * fx + b.vz * fz;
          if (vn > 0) {
            b.vx -= 1.35 * vn * fx; b.vz -= 1.35 * vn * fz; b.vx += (w.rng() - 0.5) * 3; b.vy = Math.abs(b.vy) * 0.3 + 1.5;
            b.sx *= 0.3; b.sy *= 0.3; b.sz *= 0.3; w.wob = null;
            if (!e.wall) e.wall = t;
            ev.push('wall');
          }
        }
      }

      // posts and crossbar (cylinders)
      const hit = (nx, ny, nz, d) => {
        const push = R + PR - d, vn = b.vx * nx + b.vy * ny + b.vz * nz;
        b.x += nx * push; b.y += ny * push; b.z += nz * push;
        if (vn < 0) {
          b.vx -= 1.7 * vn * nx; b.vy -= 1.7 * vn * ny; b.vz -= 1.7 * vn * nz;
          b.sx *= 0.5; b.sy *= 0.5; b.sz *= 0.5; w.wob = null;
          if (!e.post) e.post = t;
          ev.push('post');
        }
      };
      for (const sx of [-HW, HW]) {
        const dx = b.x - sx, d = Math.hypot(dx, b.z);
        if (d < R + PR && d > 1e-6 && b.y < GH + PR) hit(dx / d, 0, b.z / d, d);
      }
      if (Math.abs(b.x) < HW) { const dy = b.y - GH, d = Math.hypot(dy, b.z); if (d < R + PR && d > 1e-6) hit(0, dy / d, b.z / d, d); }

      // keeper: capsule from feet/hips (a) to hands (b) in his plane
      if (k.cool <= 0 && Math.abs(b.z - k.z) < 0.25 + R) {
        const c = seg(b.x, b.y, k.ax, k.ay, k.bx, k.by);
        if (c.d < 0.22 * (k.scale || 1) + R) {
          const sp = Math.hypot(b.vx, b.vy, b.vz);
          k.cool = 0.5;
          if (!e.save) e.save = t;
          ev.push('save');
          if (sp < 18 && c.t > 0.55 && k.state !== 'high') b.held = true;
          else { // parry: always back out of the goal; high ones popped up, the rest palmed sideways
            const out = Math.sign(b.x - k.ax) || 1;
            b.vz = -Math.abs(b.vz) * (0.15 + w.rng() * 0.15);
            b.vx = out * sp * (0.15 + w.rng() * 0.2);
            b.vy = k.state === 'high' ? 6 + w.rng() * 2 : 1.5 + w.rng() * 3;
            b.sx = b.sy = b.sz = 0; w.wob = null;
          }
        }
      }

      // goal line
      if (pz < 0 && b.z >= 0) {
        const f = -pz / (b.z - pz), cx = px + (b.x - px) * f, cy = py + (b.y - py) * f;
        if (Math.abs(cx) < HW && cy < GH) {
          e.goal = { x: cx, y: cy };
          e.target = w.L.targets && TARGETS.some((q) => Math.hypot(cx - q[0], cy - q[1]) < TARGET_R);
        } else if (!e.out) e.out = { x: cx, y: cy };
      }

      // nets: back, sides, roof
      const inX = Math.abs(b.x) < HW, inY = b.y < GH, inZ = b.z > 0 && b.z < ND;
      if (pz < ND && b.z >= ND && inX && inY) { b.z = ND - 0.01; b.vz *= -0.1; b.vx *= 0.4; b.vy *= 0.4; ev.push('net'); }
      if (inZ && inY && (Math.abs(px) < HW) !== inX) { b.x = px; b.vx *= -0.2; b.vz *= 0.6; ev.push('sidenet'); }
      if (inZ && inX && (py < GH) !== inY) { b.y = py; b.vy *= -0.2; b.vz *= 0.6; ev.push('sidenet'); }
    }

    if (!w.result) {
      const sp = Math.hypot(b.vx, b.vy, b.vz), why = () => (e.save ? 'save' : e.wall ? 'wall' : e.post ? 'post' : 'wide');
      if (e.goal) w.result = 'goal';
      else if (b.held) w.result = 'save';
      else if (e.out) w.result = e.save || e.post || e.wall ? why() : e.out.y >= GH ? 'over' : 'wide';
      else if (e.save && t - e.save > 0.8 && b.vz < 3) w.result = 'save';
      else if (e.wall && t - e.wall > 0.9 && b.vz < 2) w.result = 'wall';
      else if (e.post && t - e.post > 1.0 && b.vz < 1) w.result = 'post';
      else if (!(w.chaos && (w.chaos.drib || (w.chaos.jug && !w.chaos.jug.done))) && (tk > 4 || (sp < 0.5 && b.y < R + 0.01))) w.result = why();
      if (w.result) ev.push('result');
    }
  }

  // progression rules (pure, tested in node)
  // stars: 1 = goal, 2 = with the first ball of the level, 3 = first ball + top bins / in off the post / trivela / knuckle
  const stars = (w, firstBall) => (w.result !== 'goal' ? 0 : 1 + (firstBall ? 1 : 0) + (firstBall && (w.ev.target || w.ev.post || w.st.late || w.st.knuckle) ? 1 : 0));
  const multiplier = (streak) => Math.min(5, 1 + streak); // points multiplier for the next goal
  const missBy = (w) => (w.ev.out ? Math.max(0, Math.max(Math.abs(w.ev.out.x) - HW, w.ev.out.y - GH) - R - PR) : null); // gap between ball and frame, m

  // skill ladder: XP from goals moves the taker up; every rank adds a perk and keeps the earlier ones
  const RANKS = [
    { name: 'BEGINNER', xp: 0, perk: 'SCORE GOALS TO EARN XP' },
    { name: 'AMATEUR', xp: 80, perk: 'LONG GUIDE: LONGER AIM ARC' },
    { name: 'SEMI-PRO', xp: 220, perk: 'EXTRA BALL: 4 PER LEVEL' },
    { name: 'PRO', xp: 450, perk: 'WHIP MASTER: +20% CURVE' },
    { name: 'WORLD CLASS', xp: 800, perk: 'CANNON: +10% SHOT POWER' },
    { name: 'ELITE', xp: 1300, perk: 'MIND GAMES: KEEPER READS YOU LATE' },
    { name: 'LEGEND', xp: 2000, perk: 'FULL GUIDE: SEE THE WHOLE FLIGHT' },
  ];
  const rankOf = (xp) => { let r = 0; while (r + 1 < RANKS.length && xp >= RANKS[r + 1].xp) r++; return r; };
  const xpFor = (nStars, streak, dist, chaos) => (10 + 10 * nStars + 5 * Math.min(streak, 5) + Math.max(0, Math.round(dist - 18))) * (chaos ? 10 : 1); // CHAOS mode pays 10x

  function bag(list, rng = Math.random) {
    let q = [], last = null;
    return () => {
      if (!q.length) {
        q = list.slice();
        for (let i = q.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = q[i]; q[i] = q[j]; q[j] = t; }
        if (q.length > 1 && q[q.length - 1] === last) { const t = q[0]; q[0] = q[q.length - 1]; q[q.length - 1] = t; }
      }
      return (last = q.pop());
    };
  }

  const Sim = { bag, applyChaos, CHAOS, setGoal, goal: () => [HW, GH], KN, RANKS, rankOf, xpFor, stars, multiplier, missBy, STYLES, LEVELS, TARGETS, TARGET_R, HW, GH, ND, R, PR, makeLevel, newWorld, kick, step, preview, speed: speedOf };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Sim; return; }

  // =================================================================== BROWSER
  const W = 270, H = 480, UI_Y = 390, STEP = 1 / 240;
  const CAM_BACK = 4.6, CAM_H = 3.8, BALL_SY = 362, BAR_SY = 104, STAND_Z = 8, STAND_TOP = 15;
  const BAR_X = 28, BAR_W = 152, WX = 226, WY = 449, WR = 27;

  const cv = document.getElementById('c');
  let ctx = cv.getContext('2d', { alpha: false }); // swapped to an overlay layer while that layer redraws
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
  const RGB = (r, g, b) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
  const hex = (s) => RGB(parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16));
  const hash = (x, y) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  };

  function resize() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    Object.assign(cv.style, { width: W * s + 'px', height: H * s + 'px', left: (innerWidth - W * s) / 2 + 'px', top: (innerHeight - H * s) / 2 + 'px' });
  }
  addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------------ palettes
  const GRASS = [['#3d9b3d', '#399539', '#41a141', '#3b983b'], ['#2f852f', '#2b7f2b', '#338a33', '#2d822d']].map((a) => a.map(hex));
  const LINE = hex('#e6eee6'), CONCRETE = hex('#4a4a5c'), AISLE = hex('#262636'), ROOF = hex('#1c1c2c'), FLASH = hex('#ffffff');
  const SEAT = [hex('#2e2e48'), hex('#363652')], STAR = hex('#d0d0ff'), AD_TXT = hex('#ffffff');
  const AD = ['#c42020', '#2040b0', '#e8b818', '#18a060'].map(hex);
  const CROWD = ['#d02030', '#f0f0f0', '#2040c0', '#f0d020', '#20a040', '#e07020', '#8030a0', '#40c0e0'].map(hex);
  const SKINS = ['#f0c8a0', '#d8a070', '#a86838', '#704020'], SKINC = SKINS.map(hex);
  const HAIRS = ['#202020', '#603010', '#e0c060', '#101010'];
  const SKY = new Uint32Array(H);
  for (let y = 0; y < H; y++) { const t = Math.min(1, y / 190); SKY[y] = RGB(18 + 78 * t, 20 + 34 * t, 58 + 56 * t); }

  // ------------------------------------------------------------------ camera
  const cam = { x: 0, y: 0, z: 0, f: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0], F: 400, cx: W / 2, cy: 200 };
  function basis(p, l) {
    let fx = l.x - p.x, fy = l.y - p.y, fz = l.z - p.z;
    const fl = Math.hypot(fx, fy, fz); fx /= fl; fy /= fl; fz /= fl;
    const rl = Math.hypot(fz, fx), rx = fz / rl, rz = -fx / rl; // right = up x forward (no roll)
    cam.x = p.x; cam.y = p.y; cam.z = p.z;
    cam.f = [fx, fy, fz]; cam.r = [rx, 0, rz];
    cam.u = [fy * rz, fz * rx - fx * rz, -fy * rx]; // forward x right
  }
  function proj(x, y, z) {
    const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z, f = cam.f, u = cam.u;
    const Z = dx * f[0] + dy * f[1] + dz * f[2];
    if (Z < 0.05) return null;
    const s = cam.F / Z;
    return [cam.cx + (dx * cam.r[0] + dz * cam.r[2]) * s, cam.cy - (dx * u[0] + dy * u[1] + dz * u[2]) * s, s, Z];
  }
  const depth = (x, y, z) => (x - cam.x) * cam.f[0] + (y - cam.y) * cam.f[1] + (z - cam.z) * cam.f[2];

  let camHome, camPos, camLook, camZoom = 1, baseF = 400, baseCy = 200, bgDirty = true;
  function frameCam() { // place ball and crossbar at fixed screen heights so every distance reads the same
    const b = world.ball, fx = Math.sin(world.yaw0), fz = Math.cos(world.yaw0);
    camHome = { x: b.x - fx * CAM_BACK, y: CAM_H, z: b.z - fz * CAM_BACK };
    camPos = Object.assign({}, camHome); camLook = { x: 0, y: 1, z: 0 }; camZoom = 1;
    basis(camPos, camLook);
    const yz = (x, y, z) => { const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z; return (dx * cam.u[0] + dy * cam.u[1] + dz * cam.u[2]) / (dx * cam.f[0] + dy * cam.f[1] + dz * cam.f[2]); };
    const yb = yz(b.x, R, b.z), yc = yz(0, GH, 0);
    baseF = (BALL_SY - BAR_SY) / (yc - yb); baseCy = BALL_SY + baseF * yb;
    cam.F = baseF; cam.cy = baseCy; bgDirty = true;
  }
  function updateCam(dt) {
    const b = world.ball, fx = Math.sin(world.yaw0), fz = Math.cos(world.yaw0);
    let tx = camHome.x, tz = camHome.z, lx = 0, ly = 1, lz = 0, zoom = 1;
    if (state === 'flight' || state === 'result') { // dolly up the pitch behind the ball, keep goal and ball in frame
      const travel = clamp((b.x - world.start.x) * fx + (b.z - world.start.z) * fz, 0, Math.min(world.L.dist - 13, 6)) * 0.85; // stop well short of the wall
      tx += fx * travel; tz += fz * travel;
      lx = b.x * 0.35; ly = 1 + (b.y - 1) * 0.35; lz = b.z * 0.35; zoom = 1.12;
    }
    const k = 1 - Math.exp(-3.5 * dt), o = camPos.x + camPos.z + camLook.x + camLook.y + camLook.z + camZoom;
    camPos.x += (tx - camPos.x) * k; camPos.z += (tz - camPos.z) * k;
    camLook.x += (lx - camLook.x) * k; camLook.y += (ly - camLook.y) * k; camLook.z += (lz - camLook.z) * k;
    camZoom += (zoom - camZoom) * k;
    basis(camPos, camLook);
    cam.F = baseF * camZoom; cam.cy = baseCy;
    if (Math.abs(camPos.x + camPos.z + camLook.x + camLook.y + camLook.z + camZoom - o) > 1e-5) bgDirty = true;
  }

  // ------------------------------------------------------------------ background: per-pixel ray cast of pitch + stand
  // grass noise, stand and sky are baked once; the per-pixel loop is just ray maths + lookups
  const GTEX = [0, 1].map((k) => { const t = new Uint32Array(4096); for (let i = 0; i < 4096; i++) t[i] = GRASS[k][hash(i & 63, i >> 6) & 3]; return t; });
  // pitch markings: on each screen row the ground point moves linearly with px, so every line's pixel span
  // is solved directly instead of testing each pixel against each line
  function span(o, A1, B1, lo1, hi1, A2, B2, lo2, hi2) { // fill px where lo1 < A1 + px*B1 < hi1 and lo2 < A2 + px*B2 < hi2
    let a = 0, b = W - 1;
    if (Math.abs(B1) < 1e-9) { if (!(lo1 < A1 && A1 < hi1)) return; }
    else { let p = (lo1 - A1) / B1, q = (hi1 - A1) / B1; if (p > q) { const t = p; p = q; q = t; } if (p > a) a = p; if (q < b) b = q; }
    if (Math.abs(B2) < 1e-9) { if (!(lo2 < A2 && A2 < hi2)) return; }
    else { let p = (lo2 - A2) / B2, q = (hi2 - A2) / B2; if (p > q) { const t = p; p = q; q = t; } if (p > a) a = p; if (q < b) b = q; }
    for (let px = Math.ceil(a); px <= b; px++) buf[o + px] = LINE;
  }
  function pitchLines(o, xA, xB, zA, zB, lw, lwz) {
    span(o, zA, zB, -lwz, lwz, xA, xB, -40, 40); // goal line
    span(o, zA, zB, -5.5 - lwz, -5.5 + lwz, xA, xB, -9.16, 9.16); // six-yard box
    span(o, zA, zB, -16.5 - lwz, -16.5 + lwz, xA, xB, -20.16, 20.16); // penalty box
    for (let s = -1; s <= 1; s += 2) {
      span(o, xA, xB, s * 9.16 - lw, s * 9.16 + lw, zA, zB, -5.5, 0);
      span(o, xA, xB, s * 20.16 - lw, s * 20.16 + lw, zA, zB, -16.5, 0);
    }
    span(o, xA, xB, -lw - 0.1, lw + 0.1, zA, zB, -11.1 - lwz, -10.9 + lwz); // penalty spot
    // the D is curved: test per pixel, but only inside its depth band
    let a = 0, b = W - 1;
    if (Math.abs(zB) > 1e-9) { let p = (-20.2 - zA) / zB, q = (-16.5 - zA) / zB; if (p > q) { const t = p; p = q; q = t; } a = Math.max(a, p); b = Math.min(b, q); }
    else if (!(zA > -20.2 && zA < -16.5)) return;
    for (let px = Math.ceil(a); px <= b; px++) {
      const gx = xA + px * xB, d = zA + px * zB + 11;
      if (Math.abs(Math.sqrt(gx * gx + d * d) - 9.15) < lwz) buf[o + px] = LINE;
    }
  }
  // stand texture: 160 m wide x 15 m tall at 12 texels/m; frame 0 = seated crowd, 1-3 = cheering (bobbing + camera flashes)
  const TPM = 12, TEX_W = 160 * TPM, TEX_H = STAND_TOP * TPM;
  function standPx(sx, sy, f) {
    if (sy < 0.9) { // advertising boards with blocky pseudo-lettering
      const p = Math.floor((sx + 80) / 6);
      if (sy > 0.2 && sy < 0.7) {
        const lx = Math.floor((sx + 80) / 0.16), ly = Math.floor((sy - 0.2) / 0.1), c = lx & 3;
        if (c < 3 && (hash(lx >> 2, p) >> (ly * 3 + c)) & 1) return AD_TXT;
      }
      return AD[p & 3];
    }
    if (sy < 1.4) return CONCRETE;
    const yy = sy - 1.4, row = Math.floor(yy / 0.5);
    if (yy > 13) return ROOF;
    if (row % 9 === 8) return AISLE;
    const col = Math.floor((sx + 80) / 0.5), h = hash(col, row), fx = (sx + 80) / 0.5 - col;
    let fy = yy / 0.5 - row;
    if (f && h & 3) fy += 0.45 * Math.max(0, Math.sin(f * 2.1 + (h & 31)));
    if (f && (h & 511) === ((f * 167) & 511)) return FLASH;
    if (fy > 0.15 && fy < 0.6 && fx > 0.12 && fx < 0.88) return CROWD[(h >>> 4) & 7];
    if (fy >= 0.6 && fy < 0.85 && fx > 0.3 && fx < 0.7) return SKINC[(h >>> 8) & 3];
    return SEAT[row & 1];
  }
  function bakeRows(t, f, y0, y1) { for (let y = y0; y < y1; y++) for (let x = 0; x < TEX_W; x++) t[y * TEX_W + x] = standPx((x + 0.5) / TPM - 80, (y + 0.5) / TPM, f); }
  const STAND = [new Uint32Array(TEX_W * TEX_H)];
  bakeRows(STAND[0], 0, 0, TEX_H);
  // cheering frames: a dozen rows per tick after launch, so baking never stalls a frame on slow phones
  let bakeT = null, bakeY = 0;
  setTimeout(function more() {
    if (STAND.length > 3) return;
    if (!bakeT) bakeT = new Uint32Array(TEX_W * TEX_H);
    bakeRows(bakeT, STAND.length, bakeY, Math.min(TEX_H, bakeY + 12));
    bakeY += 12;
    if (bakeY >= TEX_H) { STAND.push(bakeT); bakeT = null; bakeY = 0; }
    setTimeout(more, 40);
  }, 1500);
  const SKYBUF = new Uint32Array(W * H);
  for (let i = 0; i < W * H; i++) SKYBUF[i] = hash(i % W, (i / W) | 0) % 397 === 0 && i < W * 150 ? STAR : SKY[(i / W) | 0];
  function renderBG() {
    const f = cam.f, r = cam.r, u = cam.u, iF = 1 / cam.F, cx = cam.cx, cy = cam.cy, X = cam.x, Y = cam.y, Z = cam.z;
    const tex = STAND[excite > 0.05 ? Math.min(STAND.length - 1, 1 + (Math.floor(tnow * 8) % 3)) : 0];
    for (let py = 0, row = 0; py < H; py++, row += W) {
      const b = (py - cy) * iF, ry = f[1] - b * u[1];
      const rx0 = f[0] - b * u[0] - cx * iF * r[0], rz0 = f[2] - b * u[2] - cx * iF * r[2], drx = r[0] * iF, drz = r[2] * iF;
      const ground = ry < -1e-5, tg = ground ? -Y / ry : 0;
      const xA = X + tg * rx0, xB = tg * drx, zA = Z + tg * rz0, zB = tg * drz; // ground point = (xA + px*xB, zA + px*zB)
      for (let px = 0, o = row; px < W; px++, o++) {
        if (ground) {
          const gz = zA + px * zB;
          if (gz < STAND_Z) { const gx = xA + px * xB; buf[o] = GTEX[Math.floor(gz * 0.25) & 1][(((gz * 3) & 63) << 6) | ((gx * 3) & 63)]; continue; }
        }
        const rz = rz0 + px * drz;
        if (rz > 1e-5) {
          const ts = (STAND_Z - Z) / rz, sy = Y + ts * ry, sx = X + ts * (rx0 + px * drx);
          if (sy < STAND_TOP && sx > -80 && sx < 80) { buf[o] = tex[(sy > 0 ? (sy * TPM) | 0 : 0) * TEX_W + (((sx + 80) * TPM) | 0)]; continue; }
        }
        buf[o] = SKYBUF[o];
      }
      // keep lines >= 1px at grazing angles
      if (ground) pitchLines(row, xA, xB, zA, zB, Math.max(0.06, tg * iF * 0.6), Math.max(0.06, (tg * tg * iF * 0.55) / Y));
    }
  }
  function blendLine(x0, y0, x1, y1, c, a) { // Bresenham straight into the pixel buffer
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; n < 1500; n++) {
      if (x0 >= 0 && x0 < W && y0 >= 0 && y0 < H) {
        const i = y0 * W + x0, p = buf[i], R0 = p & 255, G0 = (p >> 8) & 255, B0 = (p >> 16) & 255;
        buf[i] = RGB(R0 + (c[0] - R0) * a, G0 + (c[1] - G0) * a, B0 + (c[2] - B0) * a);
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  // ------------------------------------------------------------------ goal net with spring ripple
  const NX = 15, NY = 7, nd = new Float32Array(NX * NY), nv = new Float32Array(NX * NY);
  const nodeX = (i) => -HW + (2 * HW * i) / (NX - 1), nodeY = (j) => (GH * j) / (NY - 1);
  function netStep(dt) {
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const c = j * NX + i, lap = nd[c - 1] + nd[c + 1] + nd[c - NX] + nd[c + NX] - 4 * nd[c];
      nv[c] += (lap * 900 - nd[c] * 60 - nv[c] * 5) * dt;
    }
    for (let c = 0; c < nd.length; c++) nd[c] += nv[c] * dt;
  }
  function netHit(x, y, s) {
    for (let j = 1; j < NY - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const ex = nodeX(i) - x, ey = nodeY(j) - y, d2 = ex * ex + ey * ey;
      nv[j * NX + i] += s * Math.exp(-d2 / 0.5);
    }
  }
  function drawNet() {
    const c = [235, 235, 245], a = 0.42, P = [];
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) P.push(proj(nodeX(i), nodeY(j), ND + nd[j * NX + i]));
    const L = (p, q) => p && q && blendLine(p[0], p[1], q[0], q[1], c, a);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const p = P[j * NX + i];
      if (i < NX - 1) L(p, P[j * NX + i + 1]);
      if (j < NY - 1) L(p, P[(j + 1) * NX + i]);
    }
    for (let i = 0; i < NX; i++) L(proj(nodeX(i), GH, 0), P[(NY - 1) * NX + i]);
    for (let j = 0; j < NY; j++) { L(proj(-HW, nodeY(j), 0), P[j * NX]); L(proj(HW, nodeY(j), 0), P[j * NX + NX - 1]); }
  }

  // ------------------------------------------------------------------ procedural sprites
  function mk(w, h, fn) { // draws, then adds a 1px dark outline for the 16-bit look
    const c = document.createElement('canvas');
    c.width = w + 2; c.height = h + 2;
    const g = c.getContext('2d');
    fn((x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x + 1, y + 1, ww, hh); });
    const d = g.getImageData(0, 0, c.width, c.height), a = d.data, cw = c.width, ch = c.height, edge = [];
    const on = (x, y) => x >= 0 && y >= 0 && x < cw && y < ch && a[(y * cw + x) * 4 + 3] > 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (!on(x, y) && (on(x + 1, y) || on(x - 1, y) || on(x, y + 1) || on(x, y - 1))) edge.push((y * cw + x) * 4);
    }
    for (const i of edge) { a[i] = 20; a[i + 1] = 14; a[i + 2] = 28; a[i + 3] = 255; }
    g.putImageData(d, 0, 0);
    return c;
  }
  function defender(skin, hair, pose) { // stand | jump | crouch (bracing / landing) | head (hands on head) | cheer (arms up)
    return mk(12, 26, (p) => {
      const S = '#d42a34', Sd = '#9a1826', K = '#151515', c = pose === 'crouch' ? 2 : 0; // crouch drops the upper body 2px
      p(4, c, 4, 2, hair); p(4, 2 + c, 4, 4, skin); p(5, 3 + c, 2, 1, '#2a1a1a'); p(5, 6 + c, 2, 1, skin);
      p(3, 7 + c, 6, 8, S); p(8, 7 + c, 1, 8, Sd); p(5, 7 + c, 2, 1, '#ffffff');
      if (pose === 'cheer') { p(2, 4, 1, 4, S); p(9, 4, 1, 4, Sd); p(2, 1, 1, 3, skin); p(9, 1, 1, 3, skin); }
      else if (pose === 'head') { p(1, 5, 2, 2, S); p(9, 5, 2, 2, Sd); p(2, 2, 1, 3, skin); p(9, 2, 1, 3, skin); p(3, 1, 1, 1, skin); p(8, 1, 1, 1, skin); }
      else { p(2, 7 + c, 1, 3, S); p(9, 7 + c, 1, 3, Sd); p(2, 10 + c, 1, 3, skin); p(9, 10 + c, 1, 3, skin); p(3, 13 + c, 2, 1, skin); p(7, 13 + c, 2, 1, skin); p(4, 14 + c, 4, 1, skin); }
      p(3, 15 + c, 6, 4 - c, '#f2f2f2'); p(8, 15 + c, 1, 4 - c, '#c4c4cc');
      if (pose === 'jump') { p(2, 19, 2, 2, skin); p(8, 19, 2, 2, skin); p(2, 21, 2, 2, S); p(8, 21, 2, 2, S); p(1, 23, 3, 1, K); p(8, 23, 3, 1, K); }
      else if (pose === 'crouch') { p(2, 19, 2, 3, skin); p(8, 19, 2, 3, skin); p(2, 22, 2, 3, S); p(8, 22, 2, 3, S); p(1, 25, 3, 1, K); p(8, 25, 3, 1, K); }
      else { p(3, 19, 2, 3, skin); p(7, 19, 2, 3, skin); p(3, 22, 2, 3, S); p(7, 22, 2, 3, S); p(2, 25, 3, 1, K); p(7, 25, 3, 1, K); }
    });
  }
  const KJ = '#f2d22a', KJd = '#b8960e', GL = '#ffffff', GLd = '#8ad0ff', KS = SKINS[1], KH = '#2a1a10';
  const KEEP = {
    idle: mk(12, 27, (p) => {
      p(4, 0, 4, 2, KH); p(4, 2, 4, 4, KS); p(5, 3, 2, 1, '#2a1a1a'); p(5, 6, 2, 1, KS);
      p(3, 7, 6, 8, KJ); p(8, 7, 1, 8, KJd); p(3, 10, 6, 1, KJd);
      p(2, 7, 1, 2, KJ); p(9, 7, 1, 2, KJd); p(1, 9, 1, 3, KJ); p(10, 9, 1, 3, KJd);
      p(0, 12, 2, 2, GL); p(10, 12, 2, 2, GL); p(0, 13, 2, 1, GLd); p(10, 13, 2, 1, GLd);
      p(3, 15, 6, 3, '#202028'); p(2, 18, 2, 4, KS); p(8, 18, 2, 4, KS);
      p(2, 22, 2, 3, KJd); p(8, 22, 2, 3, KJd); p(1, 25, 3, 2, '#151515'); p(8, 25, 3, 2, '#151515');
    }),
    block: mk(12, 27, (p) => {
      p(4, 0, 4, 2, KH); p(4, 2, 4, 4, KS); p(5, 3, 2, 1, '#2a1a1a'); p(5, 6, 2, 1, KS);
      p(3, 7, 6, 8, KJ); p(8, 7, 1, 8, KJd); p(2, 7, 1, 3, KJ); p(9, 7, 1, 3, KJd);
      p(3, 9, 6, 3, GL); p(3, 11, 6, 1, GLd);
      p(3, 15, 6, 3, '#202028'); p(3, 18, 2, 4, KS); p(7, 18, 2, 4, KS);
      p(3, 22, 2, 3, KJd); p(7, 22, 2, 3, KJd); p(2, 25, 3, 2, '#151515'); p(7, 25, 3, 2, '#151515');
    }),
    set: mk(12, 24, (p) => { // crouched, gloves out: the moment of the strike
      p(4, 0, 4, 2, KH); p(4, 2, 4, 4, KS); p(5, 3, 2, 1, '#2a1a1a'); p(5, 6, 2, 1, KS);
      p(3, 7, 6, 7, KJ); p(8, 7, 1, 7, KJd); p(1, 8, 2, 2, KJ); p(9, 8, 2, 2, KJd); p(0, 10, 2, 2, GL); p(10, 10, 2, 2, GL);
      p(3, 14, 6, 2, '#202028'); p(1, 16, 2, 3, KS); p(9, 16, 2, 3, KS);
      p(1, 19, 2, 3, KJd); p(9, 19, 2, 3, KJd); p(0, 22, 3, 2, '#151515'); p(9, 22, 3, 2, '#151515');
    }),
    stretch: mk(12, 32, (p) => { // arms overhead; rotated along the dive line
      p(1, 0, 3, 3, GL); p(8, 0, 3, 3, GL); p(2, 3, 2, 7, KJ); p(8, 3, 2, 7, KJd);
      p(4, 5, 4, 2, KH); p(4, 7, 4, 3, KS);
      p(3, 10, 6, 8, KJ); p(8, 10, 1, 8, KJd); p(3, 18, 6, 3, '#202028');
      p(3, 21, 2, 5, KS); p(7, 21, 2, 5, KS); p(3, 26, 2, 4, KJd); p(7, 26, 2, 4, KJd);
      p(3, 30, 2, 2, '#151515'); p(7, 30, 2, 2, '#151515');
    }),
  };
  // legendary takers: foot, stance, run-up (m back / m to the side, seconds, stride time), signature style + perk, kit and hair.
  // Stances stay within ~1.6 m back and 1 m aside: further and the camera, 4.6 m behind the ball, loses them or they block the view.
  const HEROES = [
    { name: 'KNUCKLE KID', foot: 'R', back: 1.5, side: 0.8, runT: 0.5, stepT: 0.09, stance: 'stand', style: 3, kn: 0.4, run: 'MEASURED, STRAIGHT',
      perk: 'KNUCKLE KING: WILDER KNUCKLEBALL', skin: '#704020', hair: '#151515', cut: 'short', shirt: '#f2f2f2', num: 8, numCol: '#2040b0', shorts: '#f2f2f2', socks: '#2040b0' },
    { name: 'LEFT WIZARD', foot: 'L', back: 1.1, side: 0.8, runT: 0.38, stepT: 0.08, stance: 'stand', style: 1, cv: 0.15, guide: 3, run: 'SHORT AND QUICK',
      perk: 'FINESSE: +15% CURVE, LONGER GUIDE', skin: '#e8b890', hair: '#4a2a14', cut: 'short', shirt: '#2a9d8f', num: 10, numCol: '#ffffff', shorts: '#1d3557', socks: '#2a9d8f' },
    { name: 'IRON BOOT', foot: 'R', back: 1.6, side: 0.75, runT: 0.55, stepT: 0.11, stance: 'wide', style: 3, pw: 0.08, kn: 0.2, run: 'POWER STANCE, BIG STRIDES',
      perk: 'TOMAHAWK: +8% POWER, KNUCKLE', skin: '#d8a070', hair: '#151515', cut: 'short', shirt: '#6a4c93', num: 7, numCol: '#f0d020', shorts: '#3a2a50', socks: '#6a4c93' },
    { name: 'CURVE CAPTAIN', foot: 'R', back: 1.0, side: 1.0, runT: 0.5, stepT: 0.09, stance: 'stand', style: 1, cv: 0.25, run: 'WIDE ANGLE',
      perk: 'BEND IT: +25% CURVE', skin: '#f0c8a0', hair: '#e8c860', cut: 'short', shirt: '#e76f51', num: 7, numCol: '#ffffff', shorts: '#264653', socks: '#e76f51' },
    { name: 'ROCKET LEFT', foot: 'L', back: 1.6, side: 0.9, runT: 0.5, stepT: 0.07, stance: 'wide', style: 2, pw: 0.12, cv: 0.1, run: 'LONG AND FAST',
      perk: 'BANANA BLAST: +12% POWER, +10% CURVE', skin: '#a86838', hair: '#a86838', cut: 'shaved', shirt: '#e9c46a', num: 6, numCol: '#2a6f4e', shorts: '#1d3557', socks: '#f2f2f2' },
    { name: 'SAMBA SMILE', foot: 'R', back: 1.0, side: 0.7, runT: 0.35, stepT: 0.09, stance: 'stand', style: 1, cv: 0.05, react: 0.06, run: 'SHORT, RELAXED',
      perk: 'TRICKSTER: KEEPER REACTS LATE', skin: '#8a5428', hair: '#101010', cut: 'curly', band: '#ffffff', shirt: '#118ab2', num: 10, numCol: '#ffd166', shorts: '#073b4c', socks: '#118ab2' },
    { name: 'METRONOME', foot: 'R', back: 1.3, side: 1.0, runT: 0.45, stepT: 0.09, stance: 'hips', style: 1, guide: 6, run: 'CALM, ANGLED',
      perk: 'METRONOME: MUCH LONGER AIM GUIDE', skin: '#f0c8a0', hair: '#a07a40', cut: 'short', shirt: '#4a4e69', num: 8, numCol: '#f2f2f2', shorts: '#22223b', socks: '#4a4e69' },
    { name: 'DEEP PLAYMAKER', foot: 'R', back: 0.9, side: 0.9, runT: 0.55, stepT: 0.15, stance: 'hips', style: 0, tp: 0.35, run: 'A SLOW WALK-UP',
      perk: 'DEEP DIP: EXTRA DIP', skin: '#e8b890', hair: '#2a1a10', cut: 'long', shirt: '#1d4e89', num: 21, numCol: '#ffffff', shorts: '#f2f2f2', socks: '#1d4e89' },
    { name: 'ROCKET DEFENDER', foot: 'R', back: 1.6, side: 0.8, runT: 0.6, stepT: 0.08, stance: 'wide', style: 3, pw: 0.1, kn: 0.15, run: 'LONG, ON HIS TOES',
      perk: 'ROCKET: +10% POWER, KNUCKLE', skin: '#d8a070', hair: '#3a2412', cut: 'afro', shirt: '#ffb703', num: 4, numCol: '#2a6f4e', shorts: '#023047', socks: '#f2f2f2' },
    { name: 'STUTTER STAR', foot: 'R', back: 1.0, side: 0.8, runT: 0.42, stepT: 0.07, stance: 'stand', style: 1, cv: 0.1, react: 0.04, run: 'SHORT STUTTER STEPS',
      perk: 'SAMBA: +10% CURVE, KEEPER REACTS LATE', skin: '#c88a5a', hair: '#e8c860', hair2: '#2a1a10', cut: 'mohawk', shirt: '#1a2a5a', centre: '#c81830', num: 10, numCol: '#ffffff', shorts: '#1a2a5a', socks: '#1a2a5a' },
    { name: 'ELEGANCE', foot: 'R', back: 1.2, side: 0.9, runT: 0.48, stepT: 0.1, stance: 'stand', style: 1, cv: 0.08, guide: 4, run: 'UNHURRIED, ELEGANT',
      perk: 'VIRTUOSO: +8% CURVE, LONGER GUIDE', skin: '#d8a878', hair: '#3a2a1a', cut: 'bald', shirt: '#7b2cbf', num: 10, numCol: '#ffffff', shorts: '#f2f2f2', socks: '#7b2cbf' },
    { name: 'DRAGON BUN', foot: 'L', back: 1.6, side: 0.8, runT: 0.55, stepT: 0.1, stance: 'wide', style: 3, pw: 0.1, kn: 0.25, run: 'WIDE STANCE, LONG STRIDES',
      perk: 'DRAGON: +10% POWER, WILD KNUCKLE', skin: '#f0c8a0', hair: '#4a2a14', cut: 'bun', shirt: '#2b2d42', num: 11, numCol: '#ffffff', shorts: '#2b2d42', socks: '#2b2d42' },
    { name: 'STRIPED ARTIST', foot: 'R', back: 1.2, side: 0.9, runT: 0.45, stepT: 0.09, stance: 'hips', style: 1, cv: 0.2, run: 'SHORT, PRECISE',
      perk: 'PRECISION ARC: +20% CURVE', skin: '#e8b890', hair: '#2a1a10', cut: 'short', shirt: '#f2f2f2', stripe: '#151515', num: 10, numCol: '#f0c020', shorts: '#f2f2f2', socks: '#f2f2f2' },
    { name: 'HOOP MAGIC', foot: 'R', back: 1.0, side: 0.8, runT: 0.4, stepT: 0.08, stance: 'stand', style: 1, cv: 0.15, tp: 0.2, run: 'SHORT AND SHARP',
      perk: 'HOOP MAGIC: +15% CURVE, EXTRA DIP', skin: '#e0b088', hair: '#1a1210', cut: 'curly', shirt: '#c81830', hoops: '#151515', num: 10, numCol: '#ffffff', shorts: '#f2f2f2', socks: '#151515' },
    { name: 'PONYTAIL PRINCE', foot: 'R', back: 1.1, side: 0.9, runT: 0.45, stepT: 0.09, stance: 'stand', style: 1, cv: 0.12, guide: 3, run: 'LIGHT, BALANCED',
      perk: 'PONYTAIL PRECISION: +12% CURVE, LONGER GUIDE', skin: '#e8b890', hair: '#1a1210', cut: 'ponytail', shirt: '#2a5ad0', num: 10, numCol: '#ffffff', shorts: '#f2f2f2', socks: '#2a5ad0' },
    { name: 'THUNDER BOOT', foot: 'R', back: 1.6, side: 0.7, runT: 0.55, stepT: 0.1, stance: 'wide', style: 0, pw: 0.14, run: 'LONG, STRAIGHT, HEAVY',
      perk: 'THUNDERBOLT: +14% POWER', skin: '#f0c8a0', hair: '#e8d080', cut: 'short', shirt: '#f77f00', num: 4, numCol: '#151515', shorts: '#f2f2f2', socks: '#f77f00' },
    { name: 'WHIP WINGER', foot: 'R', back: 1.2, side: 1.0, runT: 0.45, stepT: 0.09, stance: 'stand', style: 1, cv: 0.18, guide: 2, run: 'ANGLED, QUICK',
      perk: 'QUARTERBACK: +18% CURVE', skin: '#a86838', hair: '#151515', cut: 'short', shirt: '#d00000', num: 66, numCol: '#ffffff', shorts: '#d00000', socks: '#d00000' },
    { name: 'HAMMER LEFT', foot: 'L', back: 1.5, side: 0.8, runT: 0.5, stepT: 0.08, stance: 'stand', style: 0, pw: 0.14, cv: 0.05, run: 'BRISK, STRAIGHT',
      perk: 'LEFT CANNON: +14% POWER', skin: '#f0c8a0', hair: '#c8a860', cut: 'short', shirt: '#8ecae6', num: 11, numCol: '#1a2a5a', shorts: '#f2f2f2', socks: '#1a2a5a' },
  ];
  function heroSprite(h, pose) { // seen from behind; left-footers are drawn mirrored, except the shirt number
    return mk(16, 33, (raw) => {
      const p = h.foot === 'L' ? (x, y, w, hh, c) => raw(16 - x - w, y, w, hh, c) : raw;
      const SK = h.skin, S = h.shirt, H = h.hair, SH = 'rgba(0,0,0,0.22)', BT = '#151515';
      p(4, 7, 8, 11, S);
      if (h.stripe) for (let x = 5; x < 12; x += 2) p(x, 7, 1, 11, h.stripe);
      if (h.hoops) for (let y = 8; y < 18; y += 3) p(4, y, 8, 1, h.hoops);
      if (h.centre) p(6, 7, 4, 11, h.centre);
      p(11, 7, 1, 11, SH);
      const ds = String(h.num), x0 = ds.length > 1 ? 4 : 6;
      for (let d = 0; d < ds.length; d++) for (let b = 0; b < 15; b++) if (FONT[ds[d]][b] === '1') raw(x0 + d * 4 + (b % 3), 9 + ((b / 3) | 0), 1, 1, h.numCol);
      p(4, 18, 8, 4, h.shorts); p(11, 18, 1, 4, SH);
      p(7, 6, 2, 1, SK);
      if (h.cut === 'shaved') { p(6, 0, 4, 1, SK); p(5, 1, 6, 5, SK); p(5, 1, 6, 1, SH); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK); }
      else if (h.cut === 'afro') { p(5, 0, 6, 1, H); p(3, 1, 10, 5, H); p(4, 6, 8, 1, H); }
      else if (h.cut === 'curly') { p(5, 0, 6, 1, H); p(4, 1, 8, 8, H); if (h.band) p(4, 2, 8, 1, h.band); }
      else if (h.cut === 'bald') { p(6, 0, 4, 1, SK); p(5, 1, 6, 5, SK); p(5, 3, 6, 3, H); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK); } // thinning crown
      else if (h.cut === 'mohawk') { p(5, 1, 6, 5, h.hair2); p(6, 0, 4, 4, H); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK); } // bleached top, dark sides
      else {
        p(6, 0, 4, 1, H); p(5, 1, 6, 5, H); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK);
        if (h.cut === 'long') p(5, 6, 6, 3, H);
        if (h.cut === 'ponytail') p(7, 6, 2, 3, H); // ends above the shirt number
        if (h.cut === 'bun') p(7, 1, 2, 2, SH);
      }
      const leg = (x) => { p(x, 22, 2, 5, SK); p(x, 27, 2, 4, h.socks); p(x - 1, 31, 3, 2, BT); };
      if (pose === 'stand') { p(3, 7, 1, 4, S); p(12, 7, 1, 4, S); p(3, 11, 1, 4, SK); p(12, 11, 1, 4, SK); leg(5); leg(9); }
      else if (pose === 'wide') { p(3, 7, 1, 4, S); p(12, 7, 1, 4, S); p(2, 11, 1, 4, SK); p(13, 11, 1, 4, SK); leg(4); leg(10); }
      else if (pose === 'hips') { p(3, 7, 1, 3, S); p(12, 7, 1, 3, S); p(2, 10, 1, 3, SK); p(13, 10, 1, 3, SK); p(3, 13, 1, 2, SK); p(12, 13, 1, 2, SK); leg(5); leg(9); }
      else if (pose === 'run') { // non-kicking arm forward, other back, kicking foot up behind
        p(3, 7, 1, 3, S); p(3, 10, 1, 2, SK); p(12, 7, 1, 4, S); p(13, 11, 1, 4, SK); leg(5);
        p(9, 22, 2, 3, SK); p(10, 25, 2, 2, SK); p(10, 27, 2, 2, h.socks); p(10, 29, 3, 2, BT);
      } else if (pose === 'pass') { // mid-stride: legs passing under the body
        p(3, 7, 1, 4, S); p(12, 7, 1, 4, S); p(3, 11, 1, 3, SK); p(12, 11, 1, 3, SK); leg(6);
        p(8, 22, 2, 4, SK); p(8, 26, 2, 3, h.socks); p(7, 29, 3, 2, BT);
      } else if (pose === 'plant') { // wind-up: plant foot down, kicking foot cocked high behind, arm out for balance
        p(1, 8, 2, 2, S); p(0, 9, 1, 3, SK); p(12, 7, 1, 4, S); p(13, 11, 1, 3, SK); leg(5);
        p(9, 22, 2, 2, SK); p(10, 20, 2, 3, SK); p(10, 18, 2, 2, h.socks); p(10, 16, 3, 2, BT);
      } else if (pose === 'follow') { // follow-through: kicking leg swung across, both arms out, up on the toes
        p(1, 7, 2, 2, S); p(0, 6, 1, 2, SK); p(13, 7, 2, 2, S); p(15, 6, 1, 2, SK); leg(5);
        p(3, 19, 2, 2, h.socks); p(1, 19, 2, 2, BT);
      } else if (pose === 'run2') {
        p(12, 7, 1, 3, S); p(12, 10, 1, 2, SK); p(3, 7, 1, 4, S); p(2, 11, 1, 4, SK); leg(9);
        p(5, 22, 2, 3, SK); p(4, 25, 2, 2, SK); p(4, 27, 2, 2, h.socks); p(3, 29, 3, 2, BT);
      } else { // strike: arms out, kicking leg swinging through
        p(1, 8, 3, 2, S); p(0, 8, 1, 2, SK); p(12, 8, 3, 2, S); p(15, 8, 1, 2, SK); leg(5);
        p(9, 22, 2, 2, SK); p(10, 23, 3, 2, SK); p(12, 24, 2, 2, h.socks); p(13, 25, 3, 2, BT);
      }
    });
  }
  let hero = 0, HS = null, cards = null; // selected hero, its sprites, selection-screen portraits (built on first open)
  let heroPage = 0, heroFrom = 'title'; // 9 cards per page; where the pick screen returns to
  const starIcon = (c) => mk(5, 5, (p) => { p(2, 0, 1, 1, c); p(1, 1, 3, 1, c); p(0, 2, 5, 1, c); p(1, 3, 3, 1, c); p(1, 4, 1, 1, c); p(3, 4, 1, 1, c); });
  const STAR_ON = starIcon('#ffd020'), STAR_OFF = starIcon('#3a3a5a');
  function drawStars(n, x, y, sc) { for (let i = 0; i < 3; i++) ctx.drawImage(i < n ? STAR_ON : STAR_OFF, Math.round(x + (i - 1.5) * 8 * sc), y, 7 * sc, 7 * sc); }

  // ---------- CHAOS: the sim decides what happens; these show and sound it
  const FX_SPR = {
    bird: [mk(7, 4, (p) => { p(0, 0, 2, 1, '#303040'); p(5, 0, 2, 1, '#303040'); p(2, 1, 3, 2, '#303040'); p(5, 2, 1, 1, '#f0a020'); }),
      mk(7, 4, (p) => { p(0, 2, 2, 1, '#303040'); p(5, 2, 2, 1, '#303040'); p(2, 1, 3, 2, '#303040'); p(5, 2, 1, 1, '#f0a020'); })],
    pigeon: [mk(6, 5, (p) => { p(1, 1, 4, 3, '#8a8a9a'); p(4, 0, 2, 2, '#6a6a7a'); p(4, 2, 1, 1, '#40a080'); p(2, 4, 1, 1, '#e06060'); p(3, 4, 1, 1, '#e06060'); })],
    dog: [mk(10, 6, (p) => { p(2, 1, 6, 3, '#a06030'); p(7, 0, 3, 3, '#a06030'); p(8, 0, 1, 1, '#603010'); p(0, 1, 2, 1, '#a06030'); p(2, 4, 1, 2, '#a06030'); p(7, 4, 1, 2, '#a06030'); }),
      mk(10, 6, (p) => { p(2, 1, 6, 3, '#a06030'); p(7, 0, 3, 3, '#a06030'); p(8, 0, 1, 1, '#603010'); p(0, 0, 2, 1, '#a06030'); p(3, 4, 1, 2, '#a06030'); p(6, 4, 1, 2, '#a06030'); })],
    beach: [mk(8, 8, (p) => { p(1, 1, 3, 3, '#ff4040'); p(4, 1, 3, 3, '#ffffff'); p(1, 4, 3, 3, '#40a0ff'); p(4, 4, 3, 3, '#ffd020'); p(2, 0, 4, 1, '#ffffff'); p(2, 7, 4, 1, '#ffffff'); p(0, 2, 1, 4, '#ff4040'); p(7, 2, 1, 4, '#ffd020'); })],
    streaker: [mk(6, 12, (p) => { p(2, 0, 2, 1, '#603010'); p(2, 1, 2, 1, '#f0c8a0'); p(1, 2, 4, 5, '#f0c8a0'); p(0, 3, 1, 3, '#f0c8a0'); p(5, 2, 1, 3, '#f0c8a0'); p(1, 7, 4, 1, '#151515'); p(1, 8, 1, 4, '#f0c8a0'); p(4, 8, 1, 3, '#f0c8a0'); }),
      mk(6, 12, (p) => { p(2, 0, 2, 1, '#603010'); p(2, 1, 2, 1, '#f0c8a0'); p(1, 2, 4, 5, '#f0c8a0'); p(0, 2, 1, 3, '#f0c8a0'); p(5, 3, 1, 3, '#f0c8a0'); p(1, 7, 4, 1, '#151515'); p(2, 8, 1, 4, '#f0c8a0'); p(3, 8, 1, 4, '#f0c8a0'); })],
    mascot: [mk(8, 14, (p) => { p(1, 0, 6, 4, '#40c040'); p(2, 1, 1, 1, '#ffffff'); p(5, 1, 1, 1, '#ffffff'); p(3, 3, 2, 1, '#c03030'); p(1, 4, 6, 7, '#40c040'); p(1, 11, 2, 3, '#309030'); p(5, 11, 2, 3, '#309030'); }),
      mk(8, 14, (p) => { p(1, 0, 6, 4, '#40c040'); p(2, 1, 1, 1, '#ffffff'); p(5, 1, 1, 1, '#ffffff'); p(3, 3, 2, 1, '#c03030'); p(1, 4, 6, 7, '#40c040'); p(2, 11, 2, 3, '#309030'); p(4, 11, 2, 3, '#309030'); })],
    anvil: [mk(8, 6, (p) => { p(0, 0, 8, 2, '#3a3a44'); p(2, 2, 4, 2, '#2a2a32'); p(1, 4, 6, 2, '#3a3a44'); })],
    bee: [mk(3, 2, (p) => { p(0, 0, 1, 2, '#ffd020'); p(1, 0, 1, 2, '#151515'); p(2, 0, 1, 2, '#ffd020'); })],
    shin: [mk(4, 6, (p) => { p(0, 0, 4, 6, '#f2f2f2'); p(1, 1, 2, 3, '#4060c0'); })],
    flag: [mk(5, 10, (p) => { p(0, 0, 1, 10, '#ffffff'); p(1, 0, 4, 3, '#ffd020'); })],
    cat: [mk(8, 6, (p) => { p(0, 0, 1, 3, '#202028'); p(1, 2, 5, 3, '#202028'); p(5, 0, 3, 3, '#202028'); p(5, 0, 1, 1, '#202028'); p(6, 1, 1, 1, '#f0e040'); p(1, 5, 1, 1, '#202028'); p(5, 5, 1, 1, '#202028'); })],
  };
  // a: actor sprite, h: its height in metres, path: how it moves; screen: full-view effect; snd: synth sound at the event
  const FX = {
    BIRD: { a: 'bird', h: 0.6, path: 'air', snd: 'tweet' }, PIGEON: { a: 'pigeon', h: 0.6, path: 'air', snd: 'coo' },
    DOG: { a: 'dog', h: 0.6, path: 'ground', snd: 'bark' }, 'BEACH BALL': { a: 'beach', h: 0.9, path: 'air', snd: 'boing' },
    'MASCOT TRIP': { a: 'mascot', h: 2, path: 'ground', snd: 'oof' }, STREAKER: { a: 'streaker', h: 1.8, path: 'ground', snd: 'laugh' },
    DIVOT: { snd: 'thud', dirt: true }, ANVIL: { a: 'anvil', h: 0.5, path: 'fall', snd: 'clang' }, BEE: { a: 'bee', h: 0.3, path: 'orbit', snd: 'buzz' },
    GUST: { screen: 'windx', snd: 'wind' }, TAILWIND: { screen: 'windup', snd: 'wind' }, HEADWIND: { screen: 'winddown', snd: 'wind' },
    'SUPER BOUNCY': { sparkle: '#ff60c0', snd: 'boing' }, 'MOON MODE': { screen: 'moon', sparkle: '#c0a0ff', snd: 'moon' },
    SLIPPERY: { sparkle: '#80e0ff', snd: 'squeak', atKick: true }, DEFLATED: { snd: 'hiss', atKick: true, flat: true },
    'SUN GLARE': { screen: 'glare', snd: 'shimmer' }, WHISTLE: { snd: 'whistle', bang: true },
    CONFETTI: { confetti: true, snd: 'pop' }, DRIP: { screen: 'drip', snd: 'plip' }, 'SHIN PAD': { a: 'shin', h: 0.3, path: 'tumble', snd: 'clatter' },
    'THE WAVE': { wave: true, snd: 'cheerlet' }, 'CORNER FLAG': { a: 'flag', h: 1.5, path: 'topple', snd: 'clatter' },
    SHOELACES: { snd: 'trips', atKick: true }, CAT: { a: 'cat', h: 0.45, path: 'keeper', snd: 'meow', atKick: true },
    NAP: { snd: 'snore', atKick: true, zzz: true }, 'TYING LACES': { snd: 'squeak', atKick: true },
    'GIANT KEEPER': { snd: 'dundun', atKick: true }, 'TINY KEEPER': { snd: 'squeaky', atKick: true },
    SELFIE: { snd: 'click', atKick: true, flash: true }, DANCE: { snd: 'dance', atKick: true }, 'ON STRIKE': { snd: 'boo', atKick: true },
    'BIG GOAL': { snd: 'grow', atKick: true, sparkle: '#ffe040' }, 'TINY GOAL': { snd: 'shrink', atKick: true, sparkle: '#80e0ff' },
    JUGGLE: { snd: 'cheerlet', atKick: true }, DRIBBLE: { snd: 'ole', atKick: true }, 'CHEEKY CHIP': { snd: 'ooh', atKick: true },
  };
  let fxFired = false, fxHit = null; // event moment reached; where/when an actor hit the ball

  let DEF = [];
  function makeDefenders() {
    DEF = world.wall.map((_, i) => {
      const s = SKINS[(i * 3 + world.L.n) & 3], h = HAIRS[(i + world.L.n * 2) & 3], o = {};
      for (const pose of ['stand', 'jump', 'crouch', 'head', 'cheer']) o[pose] = defender(s, h, pose);
      return o;
    });
  }

  // football: per-pixel sphere, truncated-icosahedron panels from pentagon/hexagon centre directions
  const PHI = (1 + Math.sqrt(5)) / 2, PENT = [], HEXD = [];
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    PENT.push(nrm([0, a, b * PHI]), nrm([a, b * PHI, 0]), nrm([b * PHI, 0, a]));
    HEXD.push(nrm([0, a / PHI, b * PHI]), nrm([a / PHI, b * PHI, 0]), nrm([b * PHI, 0, a / PHI]));
    for (const c of [-1, 1]) HEXD.push(nrm([a, b, c]));
  }
  const BOUT = hex('#181020');
  // ball skins, unlocked by total stars
  const BALL_SKINS = [
    { name: 'CLASSIC', need: 0, w: ['#ffffff', '#d0d6e0', '#8e96a8'], b: ['#3a3a4c', '#262636', '#14141e'], s: ['#9aa0b0', '#787e90', '#585e70'], trail: '#ffffff' },
    { name: 'GOLD', need: 10, w: ['#fff0a0', '#f0c040', '#b08010'], b: ['#8a5410', '#6a3c08', '#402404'], trail: '#ffd040' },
    { name: 'FIRE', need: 25, w: ['#ffd060', '#ff8020', '#c03810'], b: ['#d01818', '#901010', '#500808'], trail: '#ff6020' },
    { name: 'NEON', need: 50, w: ['#a0ffff', '#40d0f0', '#1880b0'], b: ['#ff50d0', '#c020a0', '#801070'], trail: '#60ffff' },
  ];
  function ballCanvas(S, ang, axisX, pal) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), d = g.createImageData(S, S), px = new Uint32Array(d.data.buffer);
    const r = S / 2, ca = Math.cos(ang), sa = Math.sin(ang), edge = (1 - 1.5 / r) * (1 - 1.5 / r);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const nx = (x + 0.5 - r) / r, ny = (r - y - 0.5) / r, d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(1 - d2);
      let X = nx, Y = ny, Z = nz;
      if (axisX) { Y = ny * ca - nz * sa; Z = ny * sa + nz * ca; } else { X = nx * ca + nz * sa; Z = -nx * sa + nz * ca; }
      let p = -2, h1 = -2, h2 = -2;
      for (const v of PENT) p = Math.max(p, v[0] * X + v[1] * Y + v[2] * Z);
      for (const v of HEXD) { const q = v[0] * X + v[1] * Y + v[2] * Z; if (q > h1) { h2 = h1; h1 = q; } else if (q > h2) h2 = q; }
      const L = -0.45 * nx + 0.55 * ny + 0.7 * nz, lv = L > 0.55 ? 0 : L > 0.15 ? 1 : 2, k = p - h1 - 0.023;
      px[y * S + x] = d2 > edge ? BOUT : Math.abs(k) < 0.014 || (k < 0 && h1 - h2 < 0.012) ? pal.s[lv] : k > 0 ? pal.b[lv] : pal.w[lv];
    }
    g.putImageData(d, 0, 0);
    return c;
  }
  let BALL, WIDGET;
  function useSkin(i) {
    const k = BALL_SKINS[i], pal = { w: k.w.map(hex), b: k.b.map(hex), s: (k.s || [k.w[1], k.w[2], k.b[0]]).map(hex) };
    BALL = { x: [], y: [] };
    for (let j = 0; j < 16; j++) { BALL.x.push(ballCanvas(24, (j / 16) * Math.PI * 2, true, pal)); BALL.y.push(ballCanvas(24, (j / 16) * Math.PI * 2, false, pal)); }
    WIDGET = ballCanvas(WR * 2, 0.35, true, pal);
    HUD_L.key = UI_L.key = null; // both cached layers show the ball
  }

  // ------------------------------------------------------------------ 3x5 pixel font
  const FONT = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
    F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
    K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
    P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
    Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
    4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
    9: '111101111001110', '!': '010010010000010', '.': '000000000000010', ':': '000010000010000', '%': '101001010100101',
    '+': '000010111010000', '-': '000000111000000', '/': '001001010100100', ' ': '000000000000000', '<': '001010100010001',
    '>': '100010001010100', ',': '000000000010100', '?': '110001010000010', '=': '000111000111000',
  };
  const CHARS = Object.keys(FONT), CIDX = {}, atlases = {};
  CHARS.forEach((ch, i) => (CIDX[ch] = i));
  function atlas(col) {
    if (atlases[col]) return atlases[col];
    const c = document.createElement('canvas');
    c.width = CHARS.length * 4; c.height = 5;
    const g = c.getContext('2d');
    g.fillStyle = col;
    CHARS.forEach((ch, i) => { for (let b = 0; b < 15; b++) if (FONT[ch][b] === '1') g.fillRect(i * 4 + (b % 3), (b / 3) | 0, 1, 1); });
    return (atlases[col] = c);
  }
  function text(s, x, y, sc = 1, col = '#ffffff', align = 0, sh = '#000000') {
    s = String(s).toUpperCase();
    x = Math.round(x - (s.length * 4 * sc - sc) * align);
    const pass = (c, ox, oy) => {
      const at = atlas(c);
      for (let i = 0; i < s.length; i++) { const k = CIDX[s[i]]; if (k !== undefined) ctx.drawImage(at, k * 4, 0, 3, 5, x + ox + i * 4 * sc, y + oy, 3 * sc, 5 * sc); }
    };
    if (sh) pass(sh, sc, sc);
    pass(col, 0, 0);
  }

  // ------------------------------------------------------------------ chiptune audio
  let AC = null, master, noiseBuf, whoosh, crowd;
  function initAudio() {
    if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try { setupAudio(Ctor); } catch (err) { AC = null; console.warn('audio off:', err); } // no sound beats a frozen game
  }
  function setupAudio(Ctor) {
    AC = new Ctor();
    master = AC.createGain(); master.gain.value = 0.6; master.connect(AC.destination);
    noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < d.length; i++) { if (i % 4 === 0) v = Math.random() * 2 - 1; d[i] = v; } // sample-and-hold = crunchy 8-bit noise
    const loop = (freq, q, vol) => {
      const s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
      s.buffer = noiseBuf; s.loop = true; f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; g.gain.value = vol;
      s.connect(f).connect(g).connect(master); s.start();
      return { f, g };
    };
    crowd = loop(700, 0.6, 0.03);
    whoosh = loop(900, 2, 0);
  }
  function tone(type, f0, f1, dur, vol, delay = 0) {
    const t = AC.currentTime + delay, o = AC.createOscillator(), g = AC.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function burst(dur, vol, type, freq, q = 1, delay = 0, attack = 0.005) {
    const t = AC.currentTime + delay, s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
    s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f).connect(g).connect(master); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  const SFX = {
    whistle() { // pea whistle: square wave with a fast trill
      const t = AC.currentTime, o = AC.createOscillator(), lfo = AC.createOscillator(), lg = AC.createGain(), g = AC.createGain();
      o.type = 'square'; o.frequency.value = 2800; lfo.frequency.value = 28; lg.gain.value = 180;
      lfo.connect(lg).connect(o.frequency);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.1, t + 0.02); g.gain.setValueAtTime(0.1, t + 0.38); g.gain.linearRampToValueAtTime(0, t + 0.46);
      o.connect(g).connect(master); o.start(t); lfo.start(t); o.stop(t + 0.5); lfo.stop(t + 0.5);
    },
    kick() { tone('sine', 180, 40, 0.2, 0.9); tone('square', 110, 50, 0.07, 0.25); burst(0.07, 0.5, 'lowpass', 1800); },
    clank() { [620, 1480, 2330, 3410].forEach((f, i) => tone(i % 2 ? 'square' : 'triangle', f, f * 0.97, 0.7 - i * 0.12, 0.1)); burst(0.05, 0.3, 'highpass', 3000); },
    cheer() {
      burst(3.4, 0.35, 'bandpass', 1100, 0.5, 0, 0.25); burst(2.6, 0.18, 'bandpass', 2400, 0.8, 0.1, 0.3);
      [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone('square', f, f, 0.13, 0.07, i * 0.09));
    },
    ooh() { burst(1.4, 0.2, 'bandpass', 480, 2, 0, 0.2); },
    net() { burst(0.35, 0.25, 'highpass', 1500, 0.5); },
    thud() { tone('sine', 130, 50, 0.12, 0.5); burst(0.06, 0.25, 'lowpass', 700); },
    bounce() { tone('sine', 110, 50, 0.08, 0.3); },
    save() { tone('sine', 150, 60, 0.12, 0.5); burst(0.1, 0.3, 'lowpass', 900); },
    stars1() { tone('square', 988, 988, 0.12, 0.06); },
    stars2() { [988, 1319].forEach((f, i) => tone('square', f, f, 0.12, 0.06, i * 0.25)); },
    tweet() { [0, 0.12, 0.24].forEach((d) => tone('square', 2600, 3400, 0.06, 0.05, d)); },
    coo() { tone('sine', 320, 260, 0.25, 0.12); tone('sine', 300, 240, 0.3, 0.12, 0.3); },
    bark() { [0, 0.22].forEach((d) => { tone('square', 420, 180, 0.1, 0.12, d); burst(0.08, 0.2, 'lowpass', 900, 1, d); }); },
    boing() { tone('sine', 180, 720, 0.35, 0.2); tone('triangle', 360, 900, 0.3, 0.06, 0.05); },
    oof() { tone('sine', 200, 80, 0.25, 0.3); burst(1, 0.15, 'bandpass', 480, 2, 0.1, 0.2); },
    laugh() { [0, 0.15, 0.3, 0.45].forEach((d) => burst(0.12, 0.18, 'bandpass', 900, 3, d)); },
    clang() { SFX.clank(); tone('sine', 90, 40, 0.3, 0.6); },
    buzz() {
      const t = AC.currentTime, o = AC.createOscillator(), l = AC.createOscillator(), lg = AC.createGain(), g = AC.createGain();
      o.type = 'sawtooth'; o.frequency.value = 230; l.frequency.value = 28; lg.gain.value = 40; l.connect(lg).connect(o.frequency);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.05); g.gain.setValueAtTime(0.05, t + 1.1); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
      o.connect(g).connect(master); o.start(t); l.start(t); o.stop(t + 1.35); l.stop(t + 1.35);
    },
    wind() { burst(1.2, 0.25, 'bandpass', 700, 0.8, 0, 0.3); },
    moon() { tone('sine', 520, 260, 1.2, 0.1); tone('sine', 780, 390, 1.2, 0.05); },
    squeak() { tone('sine', 1800, 2800, 0.12, 0.12); },
    hiss() { burst(0.9, 0.18, 'highpass', 3500, 0.7, 0, 0.02); },
    shimmer() { [1568, 2093, 2637, 3136].forEach((f, i) => tone('triangle', f, f, 0.25, 0.06, i * 0.07)); },
    pop() { burst(0.12, 0.4, 'lowpass', 2500); [880, 1320].forEach((f, i) => tone('square', f, f, 0.08, 0.06, i * 0.06)); },
    plip() { [0, 0.4, 0.75].forEach((d) => tone('sine', 1400, 600, 0.08, 0.12, d)); },
    clatter() { [0, 0.07, 0.15].forEach((d) => burst(0.05, 0.25, 'highpass', 2000, 1, d)); },
    trips() { [0, 0.12, 0.22, 0.3, 0.42].forEach((d) => tone('sine', 140, 50, 0.1, 0.35, d)); burst(1.4, 0.2, 'bandpass', 900, 3, 0.3, 0.1); [0.4, 0.55, 0.7, 0.85].forEach((d) => burst(0.1, 0.16, 'bandpass', 900, 3, d)); },
    meow() { tone('sine', 700, 1200, 0.15, 0.15); tone('sine', 1200, 520, 0.25, 0.15, 0.15); burst(0.35, 0.2, 'highpass', 3000, 0.6, 0.45, 0.01); },
    snore() { [0, 0.9].forEach((d) => { burst(0.5, 0.18, 'lowpass', 300, 1, d, 0.25); tone('sine', 90, 70, 0.5, 0.15, d); }); },
    dundun() { tone('square', 110, 110, 0.25, 0.12); tone('square', 82, 82, 0.4, 0.12, 0.3); },
    squeaky() { tone('square', 1600, 2400, 0.1, 0.07); tone('square', 2000, 2800, 0.1, 0.07, 0.12); },
    click() { [0, 0.25, 0.5].forEach((d) => burst(0.03, 0.4, 'highpass', 4000, 1, d)); },
    dance() { [523, 659, 784, 659, 523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, 0.1, 0.06, i * 0.12)); },
    boo() { burst(1.6, 0.3, 'lowpass', 400, 1, 0, 0.3); tone('sawtooth', 150, 110, 1.4, 0.04); },
    cheerlet() { burst(1.2, 0.25, 'bandpass', 1100, 0.5, 0, 0.2); },
    grow() { tone('square', 160, 640, 0.5, 0.08); tone('triangle', 320, 1280, 0.5, 0.05, 0.05); },
    shrink() { tone('square', 900, 220, 0.45, 0.07); tone('triangle', 1800, 440, 0.45, 0.04, 0.05); },
    ole() { [0, 0.55].forEach((d) => { burst(0.25, 0.25, 'bandpass', 700, 2, d, 0.05); burst(0.45, 0.22, 'bandpass', 1000, 2, d + 0.22, 0.05); }); },
    tap() { tone('sine', 260, 110, 0.06, 0.25); },
    stars3() { [988, 1319, 1976].forEach((f, i) => tone('square', f, f, 0.14, 0.06, i * 0.25)); },
  };
  const sfx = (n) => { if (AC) SFX[n](); };
  document.addEventListener('visibilitychange', () => { if (AC) (document.hidden ? AC.suspend() : AC.resume()); });

  // ------------------------------------------------------------------ game state
  let state = 'title', world, level = 0, lives = 3, score = 0, best = 0;
  let levelT = 0, stateT = 0, tnow = 0, excite = 0, acc = 0, whistled = true, msg = null, hint = null, ptr = null;
  const shot = { style: 1, aim: 0, power: 0.6, u: STYLES[1].u, v: STYLES[1].v, mega: false, insane: false, chaos: false };
  let spot = null, seed = 1, moving = false; // player-chosen kick spot for the current level
  const CHIPS = [['MOVE', 'move'], ['1000KM/H', 'mega'], ['MEGA CURVE', 'insane'], ['CHAOS', 'chaos'], ['SLOW-MO', 'slowmo']], CHIP_Y = 32, CHIP_W = 53;
  // saved progress: best score, furthest level, best stars per level, chosen ball. Anything unreadable starts fresh.
  let slowmo = false, slowSkip = false; // whole-shot slow motion (playback speed only; the outcome is identical)
  let far = 0, starsBy = {}, skin = 0, streak = 0, runCheat = false, cheatKick = false, xp = 0, runXp = 0;
  let shake = 0, timeScale = 1, trail = [], confetti = [];
  let parts = [], ripples = [], squash = 0, fade = 1, flash = 0, shownScore = 0, kCheer = false; // animation state
  function puff(x, y, z, n, cols, spd, up) { // little burst of pixels at a world point: dust, sparks, net threads
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, v = spd * (0.4 + Math.random() * 0.6);
      parts.push({ x, y, z, vx: Math.cos(a) * v, vy: up * (0.5 + Math.random()), vz: Math.sin(a) * v, life: 0.3 + Math.random() * 0.3, c: cols[i % cols.length] });
    }
  }
  let voice = true, introDue = false; // commentary out loud (toggle in the pause menu)
  const GRASS_C = ['#58b858', '#3d9b3d', '#e6eee6'], DUST = ['#8a7a50', '#5a9a4a', '#b0a070'], SPARK = ['#ffffff', '#ffe060', '#ffb030'];
  try {
    const d = JSON.parse(localStorage.getItem('rfk-save') || 'null');
    if (d && typeof d === 'object') {
      best = Math.max(0, +d.best || 0); far = Math.max(0, d.far | 0); xp = Math.max(0, d.xp | 0); hero = clamp(d.hero | 0, 0, HEROES.length - 1); slowmo = d.slowmo === true; voice = d.voice !== false; skin = clamp(d.skin | 0, 0, BALL_SKINS.length - 1);
      if (d.stars && typeof d.stars === 'object') for (const k in d.stars) starsBy[k] = clamp(d.stars[k] | 0, 0, 3);
    } else best = +localStorage.getItem('rfk-best') || 0; // pre-progression saves kept only the best score
  } catch (_) {}
  const persist = () => { try { localStorage.setItem('rfk-save', JSON.stringify({ best, far, stars: starsBy, skin, xp, hero, slowmo, voice })); } catch (_) {} };
  const totalStars = () => Object.keys(starsBy).reduce((a, k) => a + starsBy[k], 0);
  const unlocked = (i) => totalStars() >= BALL_SKINS[i].need;
  if (!unlocked(skin)) skin = 0;
  const rank = () => Sim.rankOf(xp), maxLives = () => (rank() >= 2 ? 4 : 3);
  function applyPerks() { // rank perks stack with the hero's signature
    const h = HEROES[hero];
    shot.cv = (rank() >= 3 ? 0.2 : 0) + (h.cv || 0); shot.pw = (rank() >= 4 ? 0.1 : 0) + (h.pw || 0); shot.tp = h.tp || 0; shot.kn = h.kn || 0;
  }
  function selectHero(i) {
    hero = i;
    const h = HEROES[i];
    HS = {};
    for (const pose of ['stand', 'run', 'pass', 'run2', 'plant', 'kick', 'follow']) HS[pose] = heroSprite(h, pose);
    HS.stance = heroSprite(h, h.stance);
    applyPerks(); pickStyle(h.style);
  }
  // the keeper learns: which side this run's goals went in (-1 left, +1 right), last four
  let recentGoals = [];
  const habit = () => (recentGoals.length < 2 ? 0 : recentGoals.reduce((a, b) => a + b, 0) / recentGoals.length);
  // replays: a goal is re-simulated from its inputs (the sim is deterministic), so a record is ~300 bytes
  let lastKick = null, replay = null, savedLast = false, replays = [];
  const num = (v, a, b) => (typeof v === 'number' && isFinite(v) ? clamp(v, a, b) : null);
  function cleanRec(r) { // stored replays are untrusted: rebuild each one from checked, clamped fields or drop it
    if (!r || typeof r !== 'object' || !r.shot || typeof r.shot !== 'object') return null;
    const s0 = r.shot, sh = { style: s0.style | 0, aim: num(s0.aim, -1, 1), power: num(s0.power, 0, 1), u: num(s0.u, -1, 1), v: num(s0.v, -1, 1),
      mega: !!s0.mega, insane: !!s0.insane, chaos: !!s0.chaos, chaosName: CHAOS.some((e) => e.name === s0.chaosName) ? s0.chaosName : undefined, cv: num(s0.cv || 0, 0, 1), pw: num(s0.pw || 0, 0, 1), tp: num(s0.tp || 0, 0, 1), kn: num(s0.kn || 0, 0, 1) };
    if (sh.style < 0 || sh.style > 3 || [sh.aim, sh.power, sh.u, sh.v, sh.cv, sh.pw, sh.tp, sh.kn].some((x) => x === null)) return null;
    const react = num(r.react, 0, 2), read = num(r.read, 0, 1), hb = num(r.habit || 0, -1, 1), n = r.n | 0;
    if (n < 0 || n > 999 || react === null || read === null || hb === null) return null;
    const spot2 = r.spot && typeof r.spot === 'object' ? { dist: num(r.spot.dist, 17, 40), ang: num(r.spot.ang, -60, 60) } : null;
    if (spot2 && (spot2.dist === null || spot2.ang === null)) return null;
    return { n, seed: r.seed | 0, spot: spot2, shot: sh, react, read, habit: hb, hero: clamp(r.hero | 0, 0, HEROES.length - 1), skin: clamp(r.skin | 0, 0, BALL_SKINS.length - 1),
      pts: Math.max(0, r.pts | 0), how: String(r.how || '').replace(/[^A-Z0-9 !+.-]/g, '').slice(0, 20), dist: clamp(r.dist | 0, 0, 99), d: String(r.d || '').replace(/[^0-9/]/g, '').slice(0, 5) };
  }
  try { const d = JSON.parse(localStorage.getItem('rfk-replays') || '[]'); if (Array.isArray(d)) replays = d.map(cleanRec).filter(Boolean).slice(0, 10); } catch (_) {}
  const saveReplays = () => { try { localStorage.setItem('rfk-replays', JSON.stringify(replays)); } catch (_) {} };
  function startReplay(rec, from) {
    replay = { rec, from, prevWorld: world, prevHero: hero, prevSkin: skin, prevShot: Object.assign({}, shot) };
    if (rec.hero !== hero) selectHero(rec.hero);
    if (rec.skin !== skin) useSkin(rec.skin);
    world = Sim.newWorld(rec.n, rec.seed, Object.assign({}, rec.spot, { habit: rec.habit }));
    world.L.react = rec.react; world.L.read = rec.read;
    makeDefenders(); frameCam(); nd.fill(0); nv.fill(0);
    state = 'runup'; stateT = 0; acc = 0; levelT = 9; trail = []; parts = []; msg = null; fade = 0.6; kCheer = false; timeScale = 1;
  }
  function endReplay() {
    const r = replay;
    replay = null;
    if (r.prevHero !== hero) selectHero(r.prevHero);
    if (r.prevSkin !== skin) useSkin(r.prevSkin);
    Object.assign(shot, r.prevShot);
    if (r.from === 'result') return advance(true); // it was this goal: on to the next level
    world = r.prevWorld; makeDefenders(); frameCam(); state = 'replays'; fade = 0.6;
  }
  function makeWorld() {
    world = Sim.newWorld(level, seed, Object.assign({}, spot, { habit: habit() }));
    if (rank() >= 5) { world.L.read = Math.max(0.1, world.L.read - 0.15); world.L.react += 0.05; } // MIND GAMES
    world.L.react += HEROES[hero].react || 0;
  }

  // ------------------------------------------------------------------ ZOOMER FM: the co-commentator. Glazes goals, roasts misses.
  // The pixel font has no apostrophes, so neither does he. Voice: recorded with ElevenLabs (see voice/CREDITS.txt).
  const BANTER = { // shown text; each line has a recorded clip at voice/<moment>-<n>.mp3 (same order)
    goal: ['NAH THAT WAS DISGUSTING. IN A GOOD WAY.', 'THE KEEPER IS GOING TO THINK ABOUT THAT ONE IN THE SHOWER', 'BRO HAS AURA. INFINITE AURA.', 'CLIP IT. POST IT. FRAME IT. PUT IT IN A MUSEUM.', 'THATS SO TUFF IM LITERALLY SHAKING RN', 'NET COOKED, KEEPER COOKED, WALL COOKED. FULL BARBECUE.', 'MAIN CHARACTER BEHAVIOUR FR FR', 'YOU ATE AND LEFT NO CRUMBS. NOT ONE.', 'THE WALL JUMPED FOR NOTHING. RESPECT THE CARDIO THO', 'THIS IS WHY YOUR MUM SAYS YOU HAVE POTENTIAL', 'CERTIFIED BALLER MOMENT. NO NOTES. NO QUESTIONS.', 'THE KEEPER JUST GOT LEFT ON READ', 'FROM THAT FAR?? BRO SAID DISTANCE IS A SOCIAL CONSTRUCT', 'BRO IS NOT HUMAN. I NEED A BLOOD TEST.'],
    topbins: ['TOP BINS?? THE SPIDER IN THAT CORNER IS HOMELESS NOW', 'PLACED IT WHERE THE KEEPER NEEDS A LADDER AND A PRAYER', 'ROOF OF THE NET. ROOF OF MY HEART.', 'BRO PICKED THE CORNER LIKE HE WAS ONLINE SHOPPING'],
    postin: ['OFF THE POST AND IN. EVEN THE POST WANTED IT', 'RICOCHET RIZZ. THE WOODWORK IS ON YOUR SIDE', 'THE POST SAID GO ON THEN, BESTIE'],
    knuckle: ['THAT BALL WAS DOING THE WORM IN MID AIR', 'THE KNUCKLEBALL HAD THE KEEPER DANCING TO THE WRONG SONG', 'IT WOBBLED LIKE MY WIFI AND STILL WENT IN'],
    trivela: ['OUTSIDE OF THE BOOT?? SHOWING OFF ON PURPOSE', 'TRIVELA. BECAUSE NORMAL GOALS ARE FOR NPCS', 'THAT SWERVE HAD A PLOT TWIST IN ACT THREE'],
    streak: ['ANOTHER ONE. THE KEEPER IS UPDATING HIS CV', 'BRO IS ON A HEATER. SOMEONE CALL THE FIRE BRIGADE', 'STREAK SO HOT THE GRASS IS TURNING BROWN', 'AT THIS POINT THE KEEPER IS JUST A SPECTATOR WITH GLOVES'],
    chaos: ['THE CHAOS CHOSE YOU AND YOU SAID THANK YOU', 'SCRIPT WRITERS COULD NEVER', '10 PERCENT SKILL, 90 PERCENT NONSENSE. I RESPECT IT.', 'PHYSICS LEFT THE CHAT AND YOU STILL SCORED', 'THAT GOAL HAD SIDE QUESTS'],
    cheat: ['1000 KM/H? THAT GOAL HAS AN ASTERISK AND A LAWYER', 'SCORED WITH CHEATS ON. STILL COUNTS IN YOUR HEAD THO', 'BRO DOWNLOADED THAT GOAL'],
    save: ['THE KEEPER SAW THAT COMING MID NAP', 'YOU PASSED IT TO HIM. ARE YOU TWO DATING?', 'HE DID NOT EVEN BREAK A SWEAT. EMBARRASSING.', 'STRAIGHT AT THE KEEPER LIKE A DELIVERY DRIVER', 'HE IS COLLECTING YOUR SHOTS LIKE TRADING CARDS', 'THAT SAVE GOES ON HIS HIGHLIGHT REEL. YOU ARE THE B-ROLL'],
    wall: ['YOU HIT THE WALL. THE WALL DID NOT EVEN FLINCH', 'BRO TRIED TO SHOOT THROUGH FOUR GROWN MEN', 'THE WALL SAID NOT TODAY, BESTIE', 'THAT WAS A PASS TO THE DEFENCE. WHOLESOME, HONESTLY.', 'SKILL ISSUE, BUT MAKE IT A BRICK', 'BRO REALLY LOOKED AT A WALL OF HUMANS AND WENT YEAH'],
    post: ['THE POST IS THE ONLY ONE WHO TOUCHED IT. LOWKEY SAD', 'CLANG. THAT SOUND IS YOUR CONFIDENCE.', 'SO CLOSE YET SO METAL', 'THE WOODWORK HAS MORE TOUCHES THAN YOU TODAY'],
    over: ['THAT BALL IS IN ORBIT. SPACE AGENCIES ARE CALLING', 'ROW Z SAYS THANKS FOR THE SOUVENIR', 'AIMED FOR THE MOON. MISSED THE MOON TOO.', 'THE CROSSBAR WAS NEVER IN DANGER. NEITHER WAS ANYONE.', 'THAT WENT SO HIGH IT NEEDS A PASSPORT'],
    wide: ['WIDE. THE CORNER FLAG IS NERVOUS NOW', 'BRO SHOT AT A DIFFERENT GOAL IN A DIFFERENT STADIUM', 'THE NET IS RIGHT THERE. IT IS NOT HIDING.', 'THAT WAS A CROSS TO NOBODY', 'RESPECTFULLY... WHAT WAS THAT', 'YOU HAD THE WHOLE GOAL AND MISSED THE WHOLE PLANET'],
    close: ['INCHES. CRUEL, PAINFUL, CHARACTER BUILDING INCHES', 'SO CLOSE I FELT IT IN MY SOUL', 'NEARLY. NEARLY DOES NOT GO IN THE GROUP CHAT THO', 'THE NET FELT THE BREEZE AND GOT JEALOUS'],
  };
  const BAGS = {};
  let talk = null; // { s: the line, clip: its recording, t: seconds since the result }
  function say(key) { // the next line for this moment, never the same one twice running
    BAGS[key] = BAGS[key] || Sim.bag(BANTER[key].map((_, i) => i));
    const i = BAGS[key]();
    talk = { s: BANTER[key][i], clip: 'voice/' + key + '-' + i + '.mp3', t: 0 };
  }
  // the broadcast: a play-by-play commentator calls the action (intro, the strike, the result), then ZOOMER FM gives his take.
  // One voice at a time: a cut interrupts, otherwise the next clip waits for the current one to finish.
  const PBP = { intro: 6, power: 2, curve: 2, trivela: 2, knuckle: 2, goal: 6, save: 3, wall: 3, post: 3, over: 3, wide: 3 };
  const pbp = (key) => { BAGS['pbp-' + key] = BAGS['pbp-' + key] || Sim.bag(Array.from({ length: PBP[key] }, (_, i) => i)); return BAGS['pbp-' + key](); };
  const callClip = (key) => 'voice/' + (key === 'intro' ? 'intro' : PBP[key] === 2 ? 'kick-' + key : 'call-' + key) + '-' + pbp(key) + '.mp3';
  let clip = null, nextClip = null; // the recording playing now, and the one queued behind it
  function vo(src, cut) {
    if (!voice) return;
    if (clip && !cut) { nextClip = src; return; }
    hush(); start(src);
  }
  function start(src) {
    try {
      const a = new Audio(src);
      clip = a;
      a.onended = a.onerror = () => { if (clip !== a) return; clip = null; if (nextClip) { const n = nextClip; nextClip = null; start(n); } };
      const p = a.play();
      if (p && p.catch) p.catch(() => { if (clip === a) clip = null; });
    } catch (_) { clip = null; } // no voice beats a crash
  }
  function hush() { nextClip = null; try { if (clip) { clip.pause(); clip = null; } } catch (_) {} }
  document.addEventListener('visibilitychange', () => { if (document.hidden) hush(); });
  function drawTalk() { // types out under the result, above the replay buttons
    if (!talk || state !== 'result' || replay || talk.t < 0.5) return;
    const words = talk.s.slice(0, Math.floor((talk.t - 0.5) * 45)).split(' '), lines = [''];
    for (const wd of words) { const cur = lines[lines.length - 1]; if ((cur + ' ' + wd).trim().length > 60) lines.push(wd); else lines[lines.length - 1] = (cur + ' ' + wd).trim(); }
    const y = 246;
    ctx.fillStyle = 'rgba(10,8,30,0.82)'; ctx.fillRect(4, y, W - 8, 13 + lines.length * 8);
    ctx.fillStyle = '#ff60c0'; ctx.fillRect(4, y, 2, 13 + lines.length * 8);
    text('ZOOMER FM', 10, y + 3, 1, '#ff60c0');
    lines.forEach((l, i) => text(l, 10, y + 11 + i * 8, 1, '#ffffff'));
  }
  const showMsg = (big, sub, col, dur = 2.6, sc = 5, st = -1, extra = '') => (msg = { t: 0, big, sub, col, dur, sc, st, extra });
  const sideName = () => (world.L.ang < -5 ? 'LEFT' : world.L.ang > 5 ? 'RIGHT' : 'CENTRE');

  function setupLevel() {
    seed = (Math.random() * 2147483647) | 0; moving = false;
    makeWorld();
    makeDefenders(); frameCam(); nd.fill(0); nv.fill(0);
    state = 'aim'; levelT = 0; stateT = 0; acc = 0; whistled = false; ptr = null; trail = []; fade = 0.8; kCheer = false; parts = [];
    introDue = lives === maxLives() && Math.random() < 0.75; // most new levels get a word from the commentator
    const h = habit();
    showMsg('LEVEL ' + (level + 1), Math.round(world.L.dist) + 'M ' + sideName() + ' - ' + world.L.wallN + ' IN WALL', '#ffffff', 1.8, 4, starsBy[level] || 0,
      Math.abs(h) >= 0.75 ? 'KEEPER IS READING YOUR ' + (h > 0 ? 'RIGHT' : 'LEFT') + ' SIDE - MIX IT UP' : '');
  }
  function openHeroes(from) { heroFrom = from; heroPage = Math.floor(hero / 9); state = 'heroes'; fade = 0.5; }
  function startGame(n) { level = n; lives = maxLives(); score = 0; streak = 0; runCheat = false; runXp = 0; spot = null; recentGoals = []; applyPerks(); setupLevel(); }
  function placeBall(dist, ang) { spot = { dist, ang }; makeWorld(); frameCam(); }
  function pickStyle(i) { shot.style = i; shot.u = STYLES[i].u * (HEROES[hero].foot === 'L' ? -1 : 1); shot.v = STYLES[i].v; hint = { t: 0, s: STYLES[i].name + ': ' + STYLES[i].desc }; }
  function doKick() {
    if (state !== 'aim') return;
    state = 'runup'; stateT = 0; ptr = null; msg = null; moving = false; trail = []; slowSkip = false;
    cheatKick = shot.mega || shot.insane; // chaos is random for or against you, so it isn't a cheat
  }
  function onResult() {
    state = 'result'; stateT = 0;
    const r = world.result, e = world.ev, st = world.st;
    if (replay) { if (r === 'goal') { excite = 1; shake = 4; flash = 0.55; sfx('cheer'); burstConfetti(); } return; }
    talk = null;
    if (r === 'goal') {
      recentGoals = recentGoals.concat(Math.sign(e.goal.x) || 0).slice(-4);
      const base = 100 + Math.round((world.L.dist - 18) * 10) + (e.target ? 200 : 0) + (e.post ? 50 : 0) + (st.late || st.knuckle ? 50 : 0);
      excite = 1; shake = 4; flash = 0.55; sfx('cheer'); burstConfetti();
      const how = e.target ? 'TOP BINS! ' : e.post ? 'IN OFF THE POST! ' : st.knuckle ? 'KNUCKLEBALL! ' : st.late ? 'TRIVELA! ' : '';
      const today = new Date();
      Object.assign(lastKick, { pts: base, how: how.trim(), dist: Math.round(world.L.dist), d: today.getMonth() + 1 + '/' + today.getDate() });
      say(cheatKick ? 'cheat' : world.chaos ? 'chaos' : streak >= 2 ? 'streak' : e.target ? 'topbins' : e.post ? 'postin' : st.knuckle ? 'knuckle' : st.late ? 'trivela' : 'goal');
      vo(callClip('goal'), true); vo(talk.clip);
      if (cheatKick) { // cheats score points but earn no stars, streak or best score
        score += base; runCheat = true;
        return showMsg('GOAL!', how + '+' + base, '#ffe040', 2.6, 5, -1, 'CHEATS ON - NO STARS');
      }
      const m = Sim.multiplier(streak), pts = base * m, n = Sim.stars(world, lives === maxLives()), before = totalStars();
      const gain = Sim.xpFor(n, streak, world.L.dist, !!world.chaos), r0 = rank();
      score += pts; streak++; xp += gain; runXp += gain; lastKick.pts = pts;
      const up = rank() > r0 ? Sim.RANKS[rank()] : null;
      if (up) { applyPerks(); setTimeout(() => sfx('stars3'), 1200); }
      if (score > best && !runCheat) best = score;
      if (n > (starsBy[level] || 0)) starsBy[level] = n;
      const fresh = BALL_SKINS.find((k) => k.need > before && k.need <= totalStars());
      persist();
      setTimeout(() => sfx('stars' + n), 350);
      showMsg('GOAL!', how + '+' + pts + (m > 1 ? ' (X' + m + ')' : '') + '  +' + gain + 'XP', '#ffe040', up ? 3.4 : 2.8, 5, n,
        up ? 'RANK UP: ' + up.name + '! ' + up.perk : world.chaos ? 'CHAOS BONUS: 10X XP!' : fresh ? 'NEW BALL UNLOCKED: ' + fresh.name : streak >= 3 ? 'ON FIRE! ' + streak + ' IN A ROW' : '');
    } else {
      sfx('ooh');
      const left = lives - 1, gap = Sim.missBy(world), lost = streak >= 2 ? 'STREAK OF ' + streak + ' LOST' : '';
      say((r === 'wide' || r === 'over') && gap !== null && gap < 0.5 ? 'close' : BANTER[r] ? r : 'wide');
      vo(callClip(PBP[r] ? r : 'wide'), true); vo(talk.clip);
      streak = 0;
      const sub = left > 0 ? left + (left > 1 ? ' BALLS LEFT' : ' BALL LEFT') : 'NO BALLS LEFT';
      if ((r === 'wide' || r === 'over') && gap !== null && gap < 0.5) // near misses: tell them how near
        return showMsg('SO CLOSE!', Math.max(1, Math.round(gap * 100)) + 'CM ' + (r === 'over' ? 'OVER' : 'WIDE') + ' - ' + sub, '#ffa040', 2.6, 5, -1, lost);
      showMsg({ save: 'SAVED!', wall: 'BLOCKED!', post: 'POST!', over: 'OVER!', wide: 'WIDE!' }[r] || 'MISS!', sub, '#ff6a5a', 2.6, 5, -1, lost);
    }
  }
  function burstConfetti() {
    const cols = ['#ffd020', '#ff4060', '#40c0ff', '#60ff80', '#ffffff', '#ff8020'];
    for (let i = 0; i < 70; i++) confetti.push({ x: Math.random() * W, y: -Math.random() * 120, vx: (Math.random() - 0.5) * 40, vy: 30 + Math.random() * 50, c: cols[i % cols.length], ph: Math.random() * 6 });
  }
  function advance(goal = world.result === 'goal') {
    if (goal) { level++; lives = maxLives(); spot = null; if (level > far) { far = level; persist(); } setupLevel(); } // 3 balls per level, refilled on every goal
    else if (--lives <= 0) { state = 'over'; stateT = 0; msg = null; fade = 0.7; }
    else setupLevel();
  }
  function handle(evs) {
    for (const e of evs) {
      const b = world.ball;
      if (e === 'post') { sfx('clank'); shake = 5; squash = 0.09; puff(b.x, b.y, b.z, 14, SPARK, 3, 2); }
      else if (e === 'wall') { sfx('thud'); squash = 0.09; puff(b.x, b.y, b.z, 8, ['#d42a34', '#ffffff'], 1.5, 1.5); }
      else if (e === 'save') { sfx('save'); squash = 0.09; puff(b.x, b.y, b.z, 12, ['#ffffff', '#8ad0ff', '#ffffff'], 2.5, 1.5); }
      else if (e === 'bounce') { sfx('bounce'); squash = 0.09; puff(b.x, 0.02, b.z, 6, DUST, 0.8, 1); }
      else if (e === 'chaos') { fxHit = { x: b.x, y: b.y, z: b.z, t: world.ft }; sfx('thud'); squash = 0.09; puff(b.x, b.y, b.z, 10, FX[world.chaos.name] && FX[world.chaos.name].dirt ? DUST : ['#ffffff', '#ffe060'], 1.8, 1.4); }
      else if (e === 'net') { sfx('net'); netHit(b.x, b.y, 9); shake = Math.max(shake, 2); puff(b.x, b.y, b.z, 8, ['#ffffff', '#d8d8e8'], 1.2, 0.5); }
      else if (e === 'sidenet') sfx('net');
      else if (e === 'touch') sfx('tap');
      else if (e === 'volley') { sfx('kick'); squash = 0.09; puff(b.x, b.y, b.z, 8, ['#ffffff', '#ffe060'], 1.2, 1); }
      else if (e === 'dummy') { sfx('oof'); puff(world.keeper.x, 0.05, world.keeper.z, 10, DUST, 1, 1); }
      else if (e === 'result') onResult();
    }
  }

  // ------------------------------------------------------------------ input
  const loc = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height]; };
  let lastTouch = 0;
  function onDown(id, e) {
    initAudio(); lastTouch = tnow;
    if (ptr) return;
    const [x, y] = loc(e);
    ripples.push({ x, y, t: 0 });
    if (replay) return endReplay(); // tap skips a replay
    if (slowNow()) { slowSkip = true; return; } // tap during a slow-mo shot: full speed for the rest of it
    if (state === 'replays') {
      const i = Math.floor((y - 40) / 30);
      if (y >= 40 && i < replays.length && y < 40 + i * 30 + 26) {
        if (x >= 232) { replays.splice(i, 1); saveReplays(); } else startReplay(replays[i], 'replays');
      } else if (y >= 404 && y < 424) { state = 'title'; fade = 0.6; }
      return;
    }
    if (state === 'heroes') {
      const pages = Math.ceil(HEROES.length / 9), col = Math.floor((x - 3) / 89), row = Math.floor((y - 34) / 90), i = heroPage * 9 + row * 3 + col;
      if (y < 30 && x < 34) heroPage = (heroPage + pages - 1) % pages;
      else if (y < 30 && x > 236) heroPage = (heroPage + 1) % pages;
      else if (y >= 34 && y < 304 && col >= 0 && col < 3 && i < HEROES.length) { selectHero(i); persist(); }
      else if (y >= 370 && y < 400) { if (heroFrom === 'pause') setupLevel(); else startGame(far); } // from pause: same level, score and balls
      else if (y >= 404 && y < 424) { state = heroFrom; fade = 0.5; }
      return;
    }
    if (state === 'pause') {
      if (y >= 180 && y < 208) state = 'aim'; // RESUME
      else if (y >= 214 && y < 232) openHeroes('pause');
      else if (y >= 238 && y < 256) { state = 'title'; fade = 0.6; } // MAIN MENU
      else if (y >= 262 && y < 280) { voice = !voice; if (!voice) hush(); persist(); } // COMMENTARY VOICE
      return;
    }
    if (state === 'title') {
      if (y >= 282 && y < 300) return startGame(0); // NEW GAME
      if (y >= 326 && y < 344) return openHeroes('title'); // PLAYER
      if (y >= 348 && y < 366) { state = 'replays'; fade = 0.6; return; } // REPLAYS
      if (y >= 304 && y < 322) { // cycle through unlocked balls
        do skin = (skin + 1) % BALL_SKINS.length; while (!unlocked(skin));
        useSkin(skin); persist(); return;
      }
      return startGame(far); // CONTINUE (or anywhere else)
    }
    if (state === 'over') {
      if (stateT < 0.8) return;
      if (y >= 290 && y < 308) { state = 'title'; fade = 0.6; return; } // MENU
      return startGame(level); // RETRY this level
    }
    if (state === 'result') {
      if (world.result === 'goal' && lastKick && y >= 300 && y < 322) {
        if (x < 135) startReplay(lastKick, 'result');
        else if (!savedLast) { replays = [Object.assign({}, lastKick)].concat(replays).slice(0, 10); saveReplays(); savedLast = true; sfx('stars1'); } // newest first, 10 kept
        return;
      }
      if (stateT > 0.9) advance();
      return;
    }
    if (state !== 'aim') return;
    if (x >= W - 22 && y < 20) { state = 'pause'; return; } // pause / menu button
    let mode = null;
    if (y >= CHIP_Y - 2 && y < CHIP_Y + 14) {
      const c = CHIPS[Math.floor((x - 3) / CHIP_W)];
      if (c) { if (c[1] === 'move') moving = !moving; else if (c[1] === 'slowmo') { slowmo = !slowmo; persist(); } else shot[c[1]] = !shot[c[1]]; }
      return;
    }
    if (y >= 393 && y < 413) { const i = Math.floor((x - 3) / 66); if (i >= 0 && i < 4) pickStyle(i); return; }
    if (x > 188 && y >= 413) mode = 'whip';
    else if (x < 188 && y >= 413 && y < 429) mode = 'aim';
    else if (x < 188 && y >= 429 && y < 446) mode = 'pwr';
    else if (x < 188 && y >= 446) return doKick();
    else if (y < UI_Y) mode = moving ? 'move' : 'swipe';
    if (!mode) return;
    const fl = Math.hypot(cam.f[0], cam.f[2]); // screen axes on the ground at drag start, for MOVE
    ptr = { id, mode, sx: x, sy: y, u0: shot.u, pts: [[x, y]], live: false,
      bx: world.ball.x, bz: world.ball.z, rx: cam.r[0], rz: cam.r[2], fx: cam.f[0] / fl, fz: cam.f[2] / fl };
    drag(x, y);
  }
  function onMove(id, e) { if (ptr && id === ptr.id) { const [x, y] = loc(e); drag(x, y); } }
  function onUp(id, ok) {
    if (!ptr || id !== ptr.id) return;
    const p = ptr;
    ptr = null;
    if (p.mode === 'swipe' && p.live && ok && shot.power > 0.12) doKick();
  }
  if (window.PointerEvent) {
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault(); onDown(e.pointerId, e);
      if (ptr && ptr.id === e.pointerId) try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    });
    cv.addEventListener('pointermove', (e) => onMove(e.pointerId, e));
    cv.addEventListener('pointerup', (e) => onUp(e.pointerId, true));
    cv.addEventListener('pointercancel', (e) => onUp(e.pointerId, false));
  } else { // WebViews older than Chrome 55 (never-updated Android 7) only have touch events
    const each = (fn) => (e) => { e.preventDefault(); for (let i = 0; i < e.changedTouches.length; i++) fn(e.changedTouches[i]); };
    cv.addEventListener('touchstart', each((t) => onDown(t.identifier, t)));
    cv.addEventListener('touchmove', each((t) => onMove(t.identifier, t)));
    cv.addEventListener('touchend', each((t) => onUp(t.identifier, true)));
    cv.addEventListener('touchcancel', each((t) => onUp(t.identifier, false)));
  }
  function drag(x, y) {
    const p = ptr;
    if (p.mode === 'whip') {
      let u = (x - WX) / WR, v = -(y - WY) / WR;
      const l = Math.hypot(u, v);
      if (l > 0.95) { u *= 0.95 / l; v *= 0.95 / l; }
      shot.u = u; shot.v = v;
    } else if (p.mode === 'aim') shot.aim = clamp(((x - BAR_X) / BAR_W) * 2 - 1, -1, 1);
    else if (p.mode === 'pwr') shot.power = clamp((x - BAR_X) / BAR_W, 0, 1);
    else if (p.mode === 'move') { // drag up/down = closer/further, left/right = across the pitch
      const dx = (x - p.sx) * 0.12, dy = (y - p.sy) * 0.12, bx = p.bx + p.rx * dx - p.fx * dy, bz = p.bz + p.rz * dx - p.fz * dy;
      const d = clamp(Math.hypot(bx, bz), 17, 40), lim = Math.min(60, Math.asin(Math.min(1, 32 / d)) / DEG); // stay inside the touchlines
      placeBall(d, clamp(Math.atan2(bx, -bz) / DEG, -lim, lim));
    }
    else { // swipe: direction = aim, length = power, sideways bow of the finger path = extra whip
      p.pts.push([x, y]);
      const dx = x - p.sx, dy = y - p.sy, L = Math.hypot(dx, dy);
      if (-dy < 12) { p.live = false; return; } // dragged back down: cancel, keep the settings
      p.live = true;
      shot.power = clamp(L / 170, 0.05, 1);
      shot.aim = clamp(Math.atan2(dx, -dy) / 0.6, -1, 1);
      let dev = 0;
      for (const q of p.pts) { const s = ((q[0] - p.sx) * -dy + (q[1] - p.sy) * dx) / L; if (Math.abs(s) > Math.abs(dev)) dev = s; }
      shot.u = clamp(p.u0 + clamp(dev / (L * 0.3), -1, 1) * 0.8 * Math.sign(STYLES[shot.style].spin || 1), -0.95, 0.95);
    }
  }

  // ------------------------------------------------------------------ drawing helpers
  function line(x0, y0, x1, y1, w, col) {
    ctx.fillStyle = col;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)))), o = w / 2;
    for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(x0 + ((x1 - x0) * i) / n - o), Math.round(y0 + ((y1 - y0) * i) / n - o), w, w);
  }
  function shadow(x, z, rw, a) {
    const p = proj(x, 0, z);
    if (!p) return;
    const w = rw * p[2], h = Math.max(1, Math.round(w * 0.3));
    ctx.fillStyle = 'rgba(0,24,0,' + a + ')';
    for (let dy = -h; dy <= h; dy++) {
      const q = dy / (h + 0.5), hw = Math.round(w * Math.sqrt(Math.max(0, 1 - q * q)));
      ctx.fillRect(Math.round(p[0]) - hw, Math.round(p[1]) + dy, hw * 2, 1);
    }
  }
  function upright(spr, x, y, z, hM) {
    const p = proj(x, y, z);
    if (!p) return;
    const h = Math.round(hM * p[2]), w = Math.round((spr.width / spr.height) * h);
    ctx.drawImage(spr, Math.round(p[0] - w / 2), Math.round(p[1] - h), w, h);
  }
  function bevel(x, y, w, h, fill, lite, dark) {
    ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = lite; ctx.fillRect(x, y, w, 1); ctx.fillRect(x, y, 1, h);
    ctx.fillStyle = dark; ctx.fillRect(x, y + h - 1, w, 1); ctx.fillRect(x + w - 1, y, 1, h);
  }

  function drawPost(x) {
    const a = proj(x, 0, 0), b = proj(x, GH + PR, 0);
    if (!a || !b) return;
    const w = Math.max(1, Math.round(PR * 2 * a[2]));
    line(a[0], a[1], b[0], b[1], w, '#f4f4f4');
    if (w > 1) line(a[0] + w / 2 - 0.5, a[1], b[0] + w / 2 - 0.5, b[1], 1, '#a8acb8');
  }
  function drawBar() {
    const a = proj(-HW - PR, GH, 0), b = proj(HW + PR, GH, 0);
    if (!a || !b) return;
    const w = Math.max(1, Math.round(PR * 2 * Math.min(a[2], b[2])));
    line(a[0], a[1], b[0], b[1], w, '#f4f4f4');
    if (w > 1) line(a[0], a[1] + w / 2 - 0.5, b[0], b[1] + w / 2 - 0.5, 1, '#a8acb8');
  }
  function drawTargets() {
    const hitT = world.ev.target, on = Math.floor(tnow * 4) & 1;
    for (const [tx, ty] of TARGETS) {
      const c = proj(tx, ty, 0.03);
      if (!c) continue;
      ctx.fillStyle = hitT ? '#ffffff' : on ? '#ffd020' : '#ff7a20';
      const n = Math.max(16, Math.round(TARGET_R * c[2] * 7));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2, p = proj(tx + Math.cos(a) * TARGET_R, ty + Math.sin(a) * TARGET_R, 0.03);
        if (p) ctx.fillRect(Math.round(p[0]), Math.round(p[1]), 1, 1);
      }
      ctx.fillRect(Math.round(c[0]), Math.round(c[1]), 1, 1);
    }
  }
  function drawKeeper() {
    const k = world.keeper;
    if (state === 'aim' || state === 'title' || k.state === 'idle' || k.state === 'ready' || k.state === 'watch') {
      const sway = state === 'aim' || state === 'title' || state === 'runup' ? Math.sin(tnow * 1.3) * 0.15 : 0;
      const bob = (Math.floor(tnow * 2.5) & 1) * 0.05;
      const nap = world.chaos && world.chaos.keeper === 'nap' && (state === 'flight' || state === 'result'), ks = k.scale || 1;
      const set = !nap && (k.state === 'ready' || (state === 'runup' && stateT > HEROES[hero].runT - 0.25)); // crouches as the kicker arrives
      upright(set ? KEEP.set : KEEP.idle, k.x + sway, 0, k.z, (set ? 1.9 : 2.12 - bob) * ks);
    } else if (k.state === 'block') upright(KEEP.block, k.ax, 0, k.z, 2.1 * (k.scale || 1));
    else { // dive: stretch sprite laid along feet -> hands
      const a = proj(k.ax, k.ay, k.z), b = proj(k.bx, k.by, k.z);
      if (!a || !b) return;
      const vx = b[0] - a[0], vy = b[1] - a[1], h = Math.max(Math.hypot(vx, vy), 1.8 * a[2]) * 1.15, w = (h * KEEP.stretch.width) / KEEP.stretch.height;
      ctx.save();
      ctx.translate(Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2));
      ctx.rotate(Math.atan2(vx, -vy));
      ctx.drawImage(KEEP.stretch, Math.round(-w / 2), Math.round(-h / 2), Math.round(w), Math.round(h));
      ctx.restore();
    }
  }
  function actorNow() { // where this shot's event actor is, if it has one and it's on stage
    const c = world.chaos, fx = c && FX[c.name];
    if (!fx || !fx.a || (state !== 'flight' && state !== 'result')) return null;
    const t = world.ft, b = world.ball, sd = c.side || 1, lead = 0.7, fr = Math.floor(t * 10);
    if (fx.path === 'air' || fx.path === 'ground') { // comes in from the side, meets the ball, carries on through
      const air = fx.path === 'air', off = air ? [sd * 5, 1.6, 2] : [sd * 6, 0, 1.5], p = (t - (c.t0 - lead)) / lead;
      if (p < 0) return null;
      if (fxHit) {
        const q = (t - fxHit.t) / lead;
        if (q > 2) return null;
        return { fx, fr, flip: sd > 0, pos: [fxHit.x - off[0] * q, air ? fxHit.y + q * 1.2 : 0, fxHit.z - off[2] * q] };
      }
      const k = Math.max(0, 1 - p);
      return { fx, fr, flip: sd > 0, pos: [b.x + off[0] * k, air ? b.y + off[1] * k : 0, b.z + off[2] * k] };
    }
    if (fx.path === 'fall') { // drops onto the ball, rides it down, ends up on the turf
      if (t < c.t0 - 0.4) return null;
      if (t < c.t0) return { fx, fr, pos: [b.x, b.y + 5 * ((c.t0 - t) / 0.4) + 0.25, b.z] };
      if (t < c.t0 + (c.dur || 0.6)) return { fx, fr, pos: [b.x, b.y + 0.25, b.z] };
      if (!c.rest) c.rest = [b.x, 0, b.z];
      return { fx, fr, pos: c.rest };
    }
    if (fx.path === 'orbit') { // buzzes round the ball while the wobble lasts
      if (t < c.t0 - 0.3 || t > c.t0 + (c.dur || 1.2) + 0.3) return null;
      return { fx, fr, flip: Math.sin(t * 12) > 0, pos: [b.x + Math.cos(t * 12) * 0.45, b.y + 0.2 + Math.sin(t * 17) * 0.25, b.z + Math.sin(t * 12) * 0.45] };
    }
    const wc = world.wall.reduce((a, d) => [a[0] + d.x / world.wall.length, a[1] + d.z / world.wall.length], [0, 0]);
    if (fx.path === 'tumble') { // flies across in front of the wall, spinning
      const q = (t - c.t0) / 1.6;
      if (q < 0 || q > 1) return null;
      return { fx, fr, rot: q * 12, pos: [wc[0] + sd * (-6 + 12 * q), 0.1 + 1.2 * Math.sin(q * Math.PI), wc[1] + 1] };
    }
    if (fx.path === 'keeper') { // pops up beside the keeper, hopping
      if (t < 0.05 || t > 1.4) return null;
      const k = world.keeper;
      return { fx, fr, flip: sd > 0, base: true, pos: [k.x + 0.7 * sd, Math.abs(Math.sin(t * 10)) * 0.3, k.z - 0.4] };
    }
    if (fx.path === 'topple') return { fx, fr, rot: clamp((t - c.t0) / 0.5, 0, 1) * (Math.PI / 2) * sd, base: true, pos: [-sd * 6.5, 0, 0.3] }; // corner flag keels over
    return null;
  }
  function drawActor(a) {
    const p = proj(a.pos[0], a.pos[1], a.pos[2]);
    if (!p || p[3] < 1) return;
    const set = FX_SPR[a.fx.a], spr = set[a.fr % set.length], h = Math.max(3, a.fx.h * p[2]), w = (h * spr.width) / spr.height;
    const grounded = a.fx.path === 'ground' || a.base;
    ctx.save();
    ctx.translate(Math.round(p[0]), Math.round(p[1]));
    if (a.rot) ctx.rotate(a.rot);
    if (a.flip) ctx.scale(-1, 1);
    ctx.drawImage(spr, Math.round(-w / 2), Math.round(grounded ? -h : -h / 2), Math.round(w), Math.round(h)); // grounded actors stand on their feet
    ctx.restore();
  }
  function chaosScreen() { // full-view effects and the event banner
    const c = world.chaos, fx = c && FX[c.name];
    if (!fx || (state !== 'flight' && state !== 'result')) return;
    const t = world.ft, on = t >= c.t0 && t < c.t0 + (c.dur || 1.2);
    if (on && fx.screen && fx.screen.indexOf('wind') === 0) { // streaks of wind across the view
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      for (let i = 0; i < 24; i++) {
        const a = (hash(i, 3) % 340) + 20, b2 = (hash(i, 9) % 250) + 10, m = (t * 520 + i * 97) % (W + 60);
        if (fx.screen === 'windx') ctx.fillRect(Math.round(c.side > 0 ? m - 30 : W + 30 - m), a, 24, 2);
        else ctx.fillRect(b2, Math.round(fx.screen === 'windup' ? UI_Y - (m % UI_Y) : m % UI_Y), 2, 20);
      }
    }
    if (on && fx.screen === 'moon') {
      ctx.fillStyle = 'rgba(90,50,150,0.22)'; ctx.fillRect(0, 0, W, UI_Y);
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 12; i++) if ((hash(i, Math.floor(t * 8)) & 3) === 0) ctx.fillRect(hash(i, 5) % W, hash(i, 7) % 200, 1, 1);
    }
    if (fx.screen === 'glare' && t >= c.t0 && t < c.t0 + 1.4) { // lens flare from the low sun
      const a = 1 - (t - c.t0) / 1.4;
      ctx.fillStyle = 'rgba(255,240,180,' + 0.25 * a + ')'; ctx.fillRect(0, 0, W, UI_Y);
      [[225, 70, 26], [180, 140, 10], [140, 200, 6], [100, 260, 14]].forEach(([x, y, r], i) => {
        ctx.fillStyle = 'rgba(255,' + (230 - i * 30) + ',150,' + (0.5 - i * 0.08) * a + ')';
        for (let dy = -r; dy <= r; dy++) { const hw = Math.round(Math.sqrt(r * r - dy * dy)); ctx.fillRect(x - hw, y + dy, hw * 2, 1); }
      });
    }
    if (fx.screen === 'drip' && t >= c.t0 && t < c.t0 + 1.6) {
      ctx.fillStyle = '#b0e0ff';
      for (let i = 0; i < 16; i++) { const y = ((t - c.t0) * 260 + i * 41) % 320; ctx.fillRect((i * 53 + 17) % W, Math.round(y), 2, 6); }
    }
    if (fx.a === 'cat' && t > 0.05 && t < 1.2) { const k = world.keeper, p = proj(k.x, 2.6, k.z); if (p) text('!', p[0], p[1] - 10, 2, '#ff4040', 0.5); }
    if (fx.zzz) { const k = world.keeper; for (let i = 0; i < 3; i++) { const q = (t * 0.7 + i / 3) % 1, p = proj(k.x + q * 0.6, 2.2 + q * 1.2, k.z); if (p) text('Z', p[0], p[1], 1 + (q > 0.5 ? 1 : 0), '#ffffff', 0.5); } }
    if (fx.bang && t >= c.t0 && t < c.t0 + 1) { const k = world.keeper, p = proj(k.x, 2.6, k.z); if (p) text('!', p[0], p[1] - 10, 2, '#ff4040', 0.5); }
    if (t < c.t0 + 2 && !replay) { // banner up in the stands, well clear of the goal
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 57, W, 24);
      text(c.msg, W / 2, 59, 2, '#60e0ff', 0.5);
      text(c.sub, W / 2, 72, 1, '#ffffff', 0.5);
    }
  }
  function drawBall() {
    const b = world.ball, p = proj(b.x, b.y, b.z);
    if (!p) return;
    const fire = streak >= 3 && !cheatKick; // a hot streak sets the trail alight
    trail.forEach((q, i) => {
      const t = proj(q[0], q[1], q[2]);
      if (!t) return;
      const sz = Math.max(1, Math.round(2 * R * t[2] * (0.3 + (0.6 * i) / trail.length)));
      ctx.globalAlpha = (0.15 + (0.6 * i) / trail.length);
      ctx.fillStyle = fire ? (i & 1 ? '#ff5010' : '#ffd040') : BALL_SKINS[skin].trail;
      ctx.fillRect(Math.round(t[0] - sz / 2), Math.round(t[1] - sz / 2), sz, sz);
    });
    ctx.globalAlpha = 1;
    const s = Math.max(2, Math.round(2 * R * p[2])), x = Math.round(p[0] - s / 2), y = Math.round(p[1] - s / 2);
    if (s < 5) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, s, s); if (s > 2) { ctx.fillStyle = '#8e96a8'; ctx.fillRect(x + s - 1, y + s - 1, 1, 1); } return; }
    const fl = world.chaos && FX[world.chaos.name] && FX[world.chaos.name].flat && (state === 'flight' || state === 'result');
    const set = Math.abs(b.sy) > Math.hypot(b.sx, b.sz) ? BALL.y : BALL.x, q = fl ? 0.8 : squash / 0.09; // squash on impacts; a deflated ball stays flat
    const sw = Math.round(s * (1 + 0.35 * q)), sh = Math.round(s * (1 - 0.25 * q));
    ctx.drawImage(set[((Math.floor((b.rot / (Math.PI * 2)) * 16) % 16) + 16) % 16], Math.round(p[0] - sw / 2), Math.round(p[1] - sh / 2), sw, sh);
  }
  function kickerPos() { // stands at his own spot, runs in to plant beside the ball; left-footers come from the right
    const h = HEROES[hero], s = world.start, fx = Math.sin(world.yaw0), fz = Math.cos(world.yaw0);
    let back = h.back, side = h.side;
    if (state === 'runup') { const e = Math.min(1, stateT / h.runT); back += (0.3 - back) * e; side += (0.32 - side) * e; }
    else if (state === 'flight' || state === 'result') {
      const d = world.chaos && world.chaos.drib;
      if (d) return [d.kx, d.kz]; // dribbling: right behind the ball
      back = 0.3; side = 0.32;
    }
    if (h.foot === 'L') side = -side;
    return [s.x - fx * back - fz * side, s.z - fz * back + fx * side];
  }
  function drawKicker(x, z) {
    const p = proj(x, 0, z);
    if (!p || p[3] < 2.2) return; // the dollying camera passes him: don't blow him up across the screen
    const h = HEROES[hero], run = state === 'runup', after = state === 'flight' || state === 'result';
    // run-up: 4-frame stride cycle, then the wind-up; contact, follow-through, then standing; breathing while he waits
    const c = after && world.chaos, dr = c && c.drib && !c.drib.done, jg = c && c.jug, ts = jg && jg.done ? world.ft - world.tOff : stateT;
    const cycle = (t) => [HS.run, HS.pass, HS.run2, HS.pass][Math.floor(t / (h.stepT / 2)) & 3];
    const spr = run ? (h.runT - stateT < 0.12 ? HS.plant : cycle(stateT)) : dr ? cycle(world.ft)
      : jg && !jg.done ? (world.ball.y < R + 0.15 ? HS.kick : HS.stand) // a touch every time the ball comes down
      : state === 'flight' && ts < 0.12 ? HS.kick : state === 'flight' && ts < 0.5 ? HS.follow : after ? HS.stand : HS.stance;
    const lift = run || dr ? Math.abs(Math.sin(((dr ? world.ft : stateT) * Math.PI) / h.stepT)) * 0.06 : !after && Math.sin(tnow * 2.4) > 0.5 ? 0.012 : 0;
    shadow(x, z, 0.35, 0.3);
    upright(spr, x, lift, z, 2.05);
  }
  function wallPose(d, i) {
    const wc = (state === 'flight' || state === 'result') && world.chaos && world.chaos.wall;
    if (wc === 'selfie') return 'head'; // phones up
    if (wc === 'dance' || wc === 'strike') return (Math.floor(tnow * (wc === 'dance' ? 4 : 6)) + i) & 1 ? (wc === 'dance' ? 'cheer' : 'crouch') : 'stand';
    if (state === 'result' && stateT > 0.35 + i * 0.06) return world.result === 'goal' ? 'head' : 'cheer'; // react, one by one
    if (state === 'flight' || state === 'result') {
      const t = world.ft;
      if (d.y > 0.02) return 'jump';
      if (t < d.jt || (t > d.jt + 0.55 && t < d.jt + 0.7)) return 'crouch'; // load up, then land
    }
    if (state === 'runup' && stateT > HEROES[hero].runT - 0.15) return 'crouch';
    return 'stand';
  }
  function wallPos(d, i) { // during the first second the wall shuffles across into its line
    if (state === 'flight' || state === 'result') {
      const wc = world.chaos && world.chaos.wall, fz = Math.cos(world.wallYaw), fx = Math.sin(world.wallYaw);
      if (wc === 'strike') { const off = Math.min(12, world.ft * 2.5) * (i < world.wall.length / 2 ? -1 : 1); return [d.x + fz * off, 0, d.z - fx * off]; } // walking off
      if (wc === 'dance') return [d.x + fz * Math.sin(tnow * 8 + i) * 0.15, Math.abs(Math.sin(tnow * 8 + i)) * 0.1, d.z - fx * Math.sin(tnow * 8 + i) * 0.15];
    }
    if (state !== 'aim' && state !== 'title') return [d.x, d.y, d.z];
    const e = Math.min(1, levelT / 1.1), q = 1 - e * e * (3 - 2 * e), fz = Math.cos(world.wallYaw), fx = Math.sin(world.wallYaw);
    const off = q * (2.4 + i * 0.4) * (world.L.ang > 0 ? 1 : -1);
    return [d.x + fz * off, Math.abs(Math.sin(levelT * 13 + i)) * 0.06 * q, d.z - fx * off];
  }

  // ------------------------------------------------------------------ frame
  function render() {
    if (bgDirty || excite > 0) { renderBG(); drawNet(); bgDirty = false; }
    const sx = shake > 0.5 ? Math.round((Math.random() - 0.5) * 2 * shake) : 0, sy = shake > 0.5 ? Math.round((Math.random() - 0.5) * 2 * shake) : 0;
    if (sx || sy) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, H); }
    ctx.putImageData(img, sx, sy);
    ctx.save(); ctx.translate(sx, sy); // the world shakes, the HUD doesn't
    const b = world.ball, k = world.keeper;

    shadow(b.x, b.z, R * 1.2, Math.max(0.1, 0.4 - b.y * 0.05));
    shadow((k.ax + k.bx) / 2, k.z, 0.5, 0.3);
    const wp = world.wall.map(wallPos);
    wp.forEach((p) => shadow(p[0], p[2], 0.32, 0.3));

    const items = [];
    const add = (x, y, z, fn) => items.push([depth(x, y, z), fn]);
    add(-HW, 1.2, 0, () => drawPost(-HW));
    add(HW, 1.2, 0, () => drawPost(HW));
    add(0, GH, 0, drawBar);
    if (world.L.targets) add(0, GH - 0.5, 0.05, drawTargets);
    add((k.ax + k.bx) / 2, 1, k.z, drawKeeper);
    wp.forEach((p, i) => add(p[0], 1, p[2], () => {
      const pose = wallPose(world.wall[i], i), bob = pose === 'cheer' ? Math.abs(Math.sin(tnow * 9 + i * 1.3)) * 0.1 : 0;
      if ((state === 'flight' || state === 'result') && world.chaos && world.chaos.wall === 'trip') { // flat on the grass
        const q = proj(p[0], 0, p[2]);
        if (!q) return;
        const h = 2 * q[2], w2 = (h * DEF[i].stand.width) / DEF[i].stand.height;
        ctx.save(); ctx.translate(Math.round(q[0]), Math.round(q[1])); ctx.rotate(clamp(world.ft / 0.25, 0, 1) * (Math.PI / 2) * (i & 1 ? 1 : -1));
        ctx.drawImage(DEF[i].stand, Math.round(-w2 / 2), Math.round(-h), Math.round(w2), Math.round(h)); ctx.restore();
        return;
      }
      upright(DEF[i][pose], p[0], p[1] + bob, p[2], 2.0);
    }));
    add(b.x, b.y, b.z, drawBall);
    const act = actorNow();
    if (act) add(act.pos[0], act.pos[1], act.pos[2], () => drawActor(act));
    const kp = kickerPos();
    add(kp[0], 1, kp[1], () => drawKicker(kp[0], kp[1]));
    items.sort((p, q) => q[0] - p[0]).forEach((it) => it[1]());
    parts.forEach((q) => { // impact particles
      const t = proj(q.x, q.y, q.z);
      if (!t) return;
      const sz = Math.max(1, Math.min(3, Math.round(t[2] * 0.045)));
      ctx.globalAlpha = Math.min(1, q.life * 3); ctx.fillStyle = q.c;
      ctx.fillRect(Math.round(t[0]), Math.round(t[1]), sz, sz);
    });
    ctx.globalAlpha = 1;

    if ((state === 'aim' || state === 'runup') && !replay) { // dotted launch arc for the first few metres
      const pts = Sim.preview(world, shot, (rank() >= 6 ? world.L.dist + 3 : rank() >= 1 ? 12 : 7) + (HEROES[hero].guide || 0)); // guide perks
      pts.forEach((q, i) => {
        const p = proj(q[0], q[1], q[2]);
        if (!p) return;
        const s = Math.max(1, Math.min(3, Math.round(p[2] * 0.09)));
        ctx.globalAlpha = 0.95 - (i / pts.length) * 0.7;
        ctx.fillStyle = i % 4 ? '#ffffff' : '#ffe060';
        ctx.fillRect(Math.round(p[0] - s / 2), Math.round(p[1] - s / 2), s, s);
      });
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    chaosScreen();
    const bar = slowNow() || (replay && slowmo) ? 18 : Math.round(((1 - timeScale) / 0.6) * 18); // cinema bars so slow motion reads as an effect, not lag
    if (bar > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, bar); ctx.fillRect(0, UI_Y - bar, W, bar); }
    hud();
    ui();
    overlays();
  }

  // HUD and control panel change rarely: draw them into their own layer only when what they show changes
  const layer = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.g = c.getContext('2d'); c.g.imageSmoothingEnabled = false; return c; };
  const HUD_L = layer(), UI_L = layer();
  function cached(c, key, y0, h, draw) {
    if (c.key !== key) { c.key = key; const main = ctx; ctx = c.g; ctx.clearRect(0, 0, W, H); draw(); ctx = main; }
    ctx.drawImage(c, 0, y0, W, h, 0, y0, W, h);
  }
  function hud() {
    const L = world.L, wx = L.wind.x, wz = L.wind.z;
    const X = wx * cam.r[0] + wz * cam.r[2], Zc = wx * cam.f[0] + wz * cam.f[2], l = Math.hypot(X, Zc) || 1, dx = Math.round((X / l) * 20) / 20, dy = Math.round((-Zc / l) * 20) / 20;
    cached(HUD_L, [L.n, L.dist, L.ang, shownScore, best, lives, dx, dy, moving, shot.mega, shot.insane, shot.chaos, slowmo, streak, skin, xp].join(), 0, 56, () => drawHud(dx, dy));
  }
  function drawHud(dx, dy) {
    CHIPS.forEach(([label, key], i) => {
      const on = key === 'move' ? moving : key === 'slowmo' ? slowmo : shot[key], x = 3 + i * CHIP_W;
      bevel(x, CHIP_Y, CHIP_W - 2, 12, on ? '#30d070' : 'rgba(20,24,56,0.85)', on ? '#a0ffc0' : '#4a56a0', on ? '#108040' : '#141834');
      text(label, x + (CHIP_W - 2) / 2, CHIP_Y + 4, 1, on ? '#002010' : '#d0dcff', 0.5, on ? null : '#000000');
    });
    const L = world.L;
    text('LV ' + (L.n + 1), 4, 4, 2);
    text(Math.round(L.dist) + 'M ' + sideName(), 4, 17, 1, '#c8e8ff');
    bevel(W - 18, 2, 16, 14, '#2a3264', '#4a56a0', '#141834'); // pause / menu
    ctx.fillStyle = '#ffffff'; ctx.fillRect(W - 14, 5, 3, 8); ctx.fillRect(W - 9, 5, 3, 8);
    text('SCORE ' + shownScore, W - 22, 4, 1, '#ffe040', 1);
    text('BEST ' + best, W - 22, 12, 1, '#a0a8c0', 1);
    for (let i = 0; i < lives; i++) ctx.drawImage(BALL.x[0], W - 11 - i * 9, 20, 7, 7);
    text(Sim.RANKS[rank()].name, W - 4, CHIP_Y + 16, 1, '#60e0ff', 1);
    if (streak > 0) text('STREAK ' + streak + '  NEXT GOAL X' + Sim.multiplier(streak), 4, CHIP_Y + 16, 1, streak >= 3 ? '#ff8030' : '#ffe060');
    if (L.windSpeed > 0) { // arrow in screen space: up = toward the goal
      const cx = 135, cy = 22;
      text('WIND ' + L.windSpeed.toFixed(1) + 'M/S', cx, 4, 1, '#9ff0ff', 0.5);
      line(cx - dx * 7, cy - dy * 7, cx + dx * 7, cy + dy * 7, 1, '#9ff0ff');
      const hx = cx + dx * 7, hy = cy + dy * 7;
      line(hx, hy, hx - dx * 4 - dy * 3, hy - dy * 4 + dx * 3, 1, '#9ff0ff');
      line(hx, hy, hx - dx * 4 + dy * 3, hy - dy * 4 - dx * 3, 1, '#9ff0ff');
    }
  }

  function ui() {
    const live = state === 'aim', hintOn = live && hint && hint.t < 2.2;
    cached(UI_L, [live, live && Math.floor(tnow * 3) & 1, shot.style, shot.aim, shot.power, shot.u, shot.v, shot.mega, shot.insane, shot.chaos,
      hintOn && hint.s, moving, level < 2 && Math.floor(tnow * 1.5) & 1].join(), UI_Y - 10, H - UI_Y + 10, drawUi);
  }
  function drawUi() {
    const live = state === 'aim', st = STYLES[shot.style];
    ctx.fillStyle = 'rgba(10,12,32,0.86)'; ctx.fillRect(0, UI_Y, W, H - UI_Y);
    ctx.fillStyle = '#5a6ab0'; ctx.fillRect(0, UI_Y, W, 1);
    STYLES.forEach((s, i) => {
      const sel = shot.style === i, x = 3 + i * 66;
      bevel(x, 395, 63, 16, sel ? '#f0c020' : '#2a3264', sel ? '#fff0a0' : '#4a56a0', sel ? '#a07800' : '#141834');
      text(s.name, x + 32, 401, 1, sel ? '#201000' : '#d0dcff', 0.5, sel ? null : '#000000');
    });
    // aim bar
    text('AIM', 4, 419, 1, '#c8d4ff');
    bevel(BAR_X, 416, BAR_W, 10, '#141834', '#0a0c1c', '#3a4680');
    ctx.fillStyle = '#5a6ab0'; ctx.fillRect(BAR_X + BAR_W / 2, 417, 1, 8);
    const ax = Math.round(BAR_X + ((shot.aim + 1) / 2) * (BAR_W - 6));
    bevel(ax, 415, 6, 12, '#60d0ff', '#c0f0ff', '#2080b0');
    // power bar
    text('PWR', 4, 434, 1, '#c8d4ff');
    bevel(BAR_X, 431, BAR_W, 11, '#141834', '#0a0c1c', '#3a4680');
    const pw = Math.round((BAR_W - 2) * shot.power);
    [[0, 0.6, '#40d040'], [0.6, 0.85, '#f0d020'], [0.85, 1, '#f04030']].forEach(([a, b, c]) => {
      const x0 = Math.round((BAR_W - 2) * a), x1 = Math.min(pw, Math.round((BAR_W - 2) * b));
      if (x1 > x0) { ctx.fillStyle = c; ctx.fillRect(BAR_X + 1 + x0, 432, x1 - x0, 9); }
    });
    text(Math.round(Sim.speed(shot) * 3.6) + 'KM/H', BAR_X + BAR_W - 3, 434, 1, '#ffffff', 1);
    // kick
    const pulse = live && Math.floor(tnow * 3) & 1;
    bevel(4, 448, 176, 28, live ? (pulse ? '#e03838' : '#c82828') : '#4a2a30', live ? '#ff9090' : '#6a4a50', live ? '#801010' : '#2a1018');
    text('KICK!', 92, 455, 3, live ? '#ffffff' : '#8a6a70', 0.5);
    // strike point ("the whip")
    ctx.drawImage(WIDGET, WX - WR, WY - WR);
    const cx = Math.round(WX + shot.u * WR), cy = Math.round(WY - shot.v * WR);
    ctx.fillStyle = '#ff2040';
    ctx.fillRect(cx - 5, cy, 4, 1); ctx.fillRect(cx + 2, cy, 4, 1); ctx.fillRect(cx, cy - 5, 1, 4); ctx.fillRect(cx, cy + 2, 1, 4);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx, cy, 1, 1);
    const side = -shot.u * st.spin, whip = Math.round(Math.min(1, Math.abs(side)) * 100);
    text(st.knuckle ? 'NO SPIN' : 'WHIP ' + whip + '% ' + (whip < 5 ? '' : side < 0 ? '<' : '>'), WX, 415, 1, '#ffe060', 0.5);
    if (live && hint && hint.t < 2.2) text(hint.s, W / 2, UI_Y - 9, 1, '#ffe060', 0.5);
    else if (live && moving) text('DRAG TO MOVE THE BALL - TAP MOVE TO LOCK', W / 2, UI_Y - 9, 1, '#60ff90', 0.5);
    else if (live && level < 2 && Math.floor(tnow * 1.5) & 1) text('SWIPE UP TO SHOOT', W / 2, UI_Y - 9, 1, '#ffffff', 0.5);
  }

  function rankPanel(y) { // rank name, XP bar to the next rank, and the perk that comes with it
    const r = rank(), R = Sim.RANKS, nx = R[r + 1];
    text('RANK: ' + R[r].name, W / 2, y, 2, '#60e0ff', 0.5);
    bevel(50, y + 14, 170, 7, '#141834', '#0a0c1c', '#3a4680');
    ctx.fillStyle = '#40d0ff';
    ctx.fillRect(51, y + 15, Math.round(168 * (nx ? (xp - R[r].xp) / (nx.xp - R[r].xp) : 1)), 5);
    text(nx ? xp + '/' + nx.xp + 'XP - NEXT: ' + nx.perk : 'MAX RANK - ALL PERKS', W / 2, y + 25, 1, '#a0a8c0', 0.5);
  }
  function overlays() {
    drawOverlays();
    ripples.forEach((r) => { // touch ripple: buttons feel pressed
      const rad = 2 + r.t * 45;
      ctx.globalAlpha = 1 - r.t / 0.3; ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 16; i++) { const a = (i / 16) * 6.283; ctx.fillRect(Math.round(r.x + Math.cos(a) * rad), Math.round(r.y + Math.sin(a) * rad), 1, 1); }
    });
    ctx.globalAlpha = 1;
    if (flash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + flash + ')'; ctx.fillRect(0, 0, W, H); }
    if (fade > 0) { ctx.fillStyle = 'rgba(0,0,0,' + fade + ')'; ctx.fillRect(0, 0, W, H); }
  }
  function drawOverlays() {
    confetti.forEach((c) => { ctx.fillStyle = c.c; ctx.fillRect(Math.round(c.x), Math.round(c.y), 2, Math.sin(c.ph) > 0 ? 2 : 1); });
    if (msg && msg.t < msg.dur) {
      const sc = Math.max(msg.sc, Math.round(msg.sc + 3 - msg.t * 20)), y = 168, h = sc * 5 + (msg.sub ? 26 : 12) + (msg.st >= 0 ? 18 : 0) + (msg.extra ? 10 : 0);
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, y - 6, W, h);
      text(msg.big, W / 2, y, sc, msg.col, 0.5);
      let ly = y + sc * 5 + 8;
      if (msg.sub) { text(msg.sub, W / 2, ly, 1, '#ffffff', 0.5); ly += 10; }
      if (msg.st >= 0) { drawStars(msg.big === 'GOAL!' ? Math.min(msg.st, Math.floor(msg.t * 4)) : msg.st, W / 2, ly, 2); ly += 18; } // stars pop in one by one
      if (msg.extra) text(msg.extra, W / 2, ly, 1, '#60e0ff', 0.5);
    }
    const btn = (label, y, h, hot) => { bevel(50, y, 170, h, hot ? '#c82828' : '#2a3264', hot ? '#ff9090' : '#4a56a0', hot ? '#801010' : '#141834'); text(label, W / 2, y + (h - 5 * (h > 20 ? 2 : 1)) / 2, h > 20 ? 2 : 1, '#ffffff', 0.5); };
    drawTalk();
    if (slowNow()) { text('SLOW-MO', W / 2, UI_Y - 44, 2, '#60e0ff', 0.5); text('TAP FOR FULL SPEED', W / 2, UI_Y - 30, 1, '#c8e8ff', 0.5); } // low down, out of the goal's way
    if (replay) { text('REPLAY', W / 2, 60, 2, Math.floor(tnow * 3) & 1 ? '#ff4040' : '#ffffff', 0.5); text('TAP TO SKIP', W / 2, 74, 1, '#c8e8ff', 0.5); }
    if (state === 'result' && !replay && world.result === 'goal' && lastKick) { // replay / save this goal
      bevel(40, 300, 90, 22, '#c82828', '#ff9090', '#801010'); text('> REPLAY', 85, 308, 1, '#ffffff', 0.5);
      bevel(140, 300, 90, 22, savedLast ? '#108040' : '#2a3264', savedLast ? '#60ff90' : '#4a56a0', savedLast ? '#084020' : '#141834');
      text(savedLast ? 'SAVED!' : 'SAVE REPLAY', 185, 308, 1, '#ffffff', 0.5);
    }
    if (state === 'replays') {
      ctx.fillStyle = 'rgba(6,8,24,0.9)'; ctx.fillRect(0, 0, W, H);
      text('SAVED REPLAYS', W / 2, 14, 2, '#ffe040', 0.5);
      if (!replays.length) { text('NO REPLAYS YET', W / 2, 150, 2, '#ffffff', 0.5); text('SCORE A GOAL, THEN TAP SAVE REPLAY', W / 2, 168, 1, '#a0a8c0', 0.5); }
      replays.forEach((r, i) => {
        const y = 40 + i * 30;
        bevel(8, y, 254, 26, '#1a1e40', '#4a56a0', '#0a0c1c');
        text('LV ' + (r.n + 1) + '  ' + HEROES[r.hero].name + '  ' + r.dist + 'M', 14, y + 5, 1, '#ffffff');
        text((r.how ? r.how + ' ' : '') + '+' + r.pts + (r.d ? '   ' + r.d : ''), 14, y + 15, 1, '#ffe060');
        bevel(200, y + 3, 28, 20, '#c82828', '#ff9090', '#801010'); text('>', 214, y + 8, 2, '#ffffff', 0.5);
        bevel(232, y + 3, 26, 20, '#2a3264', '#4a56a0', '#141834'); text('X', 245, y + 8, 2, '#ff8080', 0.5);
      });
      btn('BACK', 406, 18, false);
    }
    if (state === 'pause') {
      ctx.fillStyle = 'rgba(6,8,24,0.75)'; ctx.fillRect(0, 0, W, H);
      text('PAUSED', W / 2, 120, 5, '#ffffff', 0.5);
      text('LEVEL ' + (level + 1) + '   SCORE ' + score + '   ' + HEROES[hero].name, W / 2, 158, 1, '#ffe060', 0.5);
      btn('RESUME', 180, 28, true); btn('CHANGE PLAYER', 214, 18, false); btn('MAIN MENU', 238, 18, false);
      btn('COMMENTARY VOICE: ' + (voice ? 'ON' : 'OFF'), 262, 18, false);
      text('COMMENTARY VOICES BY ELEVENLABS', W / 2, 286, 1, '#a0a8c0', 0.5); // attribution the free plan asks for
    }
    if (state === 'heroes') {
      ctx.fillStyle = 'rgba(6,8,24,0.88)'; ctx.fillRect(0, 0, W, H);
      text('PICK YOUR TAKER', W / 2, 12, 2, '#ffe040', 0.5);
      const pages = Math.ceil(HEROES.length / 9);
      bevel(4, 6, 26, 20, '#2a3264', '#4a56a0', '#141834'); text('<', 17, 12, 2, '#ffffff', 0.5);
      bevel(240, 6, 26, 20, '#2a3264', '#4a56a0', '#141834'); text('>', 253, 12, 2, '#ffffff', 0.5);
      text((heroPage + 1) + '/' + pages, W / 2, 25, 1, '#a0a8c0', 0.5);
      cards = cards || HEROES.map((h) => heroSprite(h, h.stance));
      HEROES.slice(heroPage * 9, heroPage * 9 + 9).forEach((h, j) => {
        const i = heroPage * 9 + j, x = 3 + (j % 3) * 89, y = 34 + ((j / 3) | 0) * 90, sel = i === hero;
        bevel(x, y, 86, 86, sel ? '#3a3010' : '#1a1e40', sel ? '#ffe060' : '#4a56a0', sel ? '#a07800' : '#0a0c1c');
        ctx.drawImage(cards[i], x + 25, y + 4 - (sel && Math.sin(tnow * 3) > 0 ? 2 : 0), 36, 70); // the picked one breathes
        text(h.name, x + 43, y + 77, 1, sel ? '#ffe060' : '#ffffff', 0.5);
        text(h.foot, x + 81, y + 4, 1, '#60e0ff', 1);
      });
      const h = HEROES[hero];
      text(h.name + ' - ' + (h.foot === 'L' ? 'LEFT' : 'RIGHT') + ' FOOT', W / 2, 310, 1, '#ffe060', 0.5);
      text('RUN-UP: ' + h.run, W / 2, 322, 1, '#c8e8ff', 0.5);
      text('SIGNATURE KICK: ' + STYLES[h.style].name, W / 2, 334, 1, '#c8e8ff', 0.5);
      text(h.perk, W / 2, 346, 1, '#60ff90', 0.5);
      btn(heroFrom === 'pause' ? 'BACK IN AS ' + h.name : 'PLAY AS ' + h.name, 372, 28, true);
      btn('BACK', 406, 18, false);
    }
    if (state === 'title' || state === 'over') {
      ctx.fillStyle = 'rgba(6,8,24,0.72)'; ctx.fillRect(0, 0, W, H);
      if (state === 'title') {
        text('RETRO', W / 2, 52 + Math.round(Math.sin(tnow * 2) * 2), 7, '#ffe040', 0.5);
        text('FREE KICK', W / 2, 94 + Math.round(Math.sin(tnow * 2 + 0.8) * 2), 4, '#ffffff', 0.5);
        ctx.drawImage(BALL.x[Math.floor(tnow * 10) & 15], W / 2 - 18, 122, 36, 36);
        ctx.drawImage(STAR_ON, W / 2 - 52, 164, 14, 14);
        text(totalStars() + ' STARS   BEST ' + best, W / 2 - 34, 168, 1, '#ffe060');
        const nx = BALL_SKINS.find((k) => k.need > totalStars());
        if (nx) text('NEXT BALL: ' + nx.name + ' AT ' + nx.need + ' STARS', W / 2, 184, 1, '#a0a8c0', 0.5);
        rankPanel(200);
        btn(far > 0 ? 'CONTINUE LV ' + (far + 1) : 'PLAY', 250, 28, true);
        btn('NEW GAME', 282, 18, false);
        btn('BALL: ' + BALL_SKINS[skin].name + '  >', 304, 18, false);
        btn('PLAYER: ' + HEROES[hero].name + '  >', 326, 18, false);
        btn('REPLAYS (' + replays.length + ')', 348, 18, false);
        text('SWIPE UP TO SHOOT. DRAG THE BALL', W / 2, 374, 1, '#c8e8ff', 0.5);
        text('WIDGET TO PICK WHERE YOU STRIKE IT.', W / 2, 384, 1, '#c8e8ff', 0.5);
        text('GOALS IN A ROW MULTIPLY YOUR POINTS.', W / 2, 396, 1, '#ffe060', 0.5);
      } else {
        text('FULL TIME', W / 2, 110, 5, '#ff6a5a', 0.5);
        text('SCORE ' + score, W / 2, 160, 3, '#ffe040', 0.5);
        text(runCheat ? 'CHEATS USED - BEST NOT SAVED' : score >= best && score > 0 ? 'NEW BEST!' : 'BEST ' + best, W / 2, 186, 1, '#ffffff', 0.5);
        ctx.drawImage(STAR_ON, W / 2 - 30, 198, 14, 14);
        text(totalStars() + ' STARS   +' + runXp + 'XP', W / 2 - 12, 202, 1, '#ffe060');
        rankPanel(216);
        if (stateT > 0.8) { btn('RETRY LV ' + (level + 1), 256, 28, true); btn('MENU', 290, 18, false); }
      }
    }
  }

  const slowNow = () => slowmo && !slowSkip && !replay && (state === 'runup' || state === 'flight' || (state === 'result' && stateT < 0.6));
  function update(dt) {
    if (replay) dt *= slowmo ? 0.3 : 0.6; // replays: 60% speed, 30% in slow-mo
    else if (slowNow()) dt *= 0.3; // slow-mo: run-up, strike, flight and the first moment after, at 30%
    tnow += dt; levelT += dt; stateT += dt;
    if (introDue && state === 'aim' && levelT > 0.9) { introDue = false; vo(callClip('intro')); }
    excite = Math.max(0, excite - dt * 0.22);
    if (msg) msg.t += dt;
    if (talk) talk.t += dt;
    if (hint) hint.t += dt;
    if (state === 'aim' && levelT > 0.4 && !whistled) { whistled = true; sfx('whistle'); }
    if (state === 'runup' && stateT >= HEROES[hero].runT) {
      if (!replay) { // everything the sim needs to play this exact shot again
        lastKick = { n: level, seed, spot: spot ? { dist: spot.dist, ang: spot.ang } : null, shot: Object.assign({}, shot), react: world.L.react, read: world.L.read, habit: world.L.habit || 0, hero, skin };
        savedLast = false;
      }
      Sim.kick(world, replay ? replay.rec.shot : shot); state = 'flight';
      if (!replay && lastKick && world.chaos) lastKick.shot.chaosName = world.chaos.name;
      stateT = 0; acc = 0; sfx('kick'); fxFired = false; fxHit = null; hush(); introDue = false;
      if (!replay && !(world.chaos && world.chaos.jug) && !(world.chaos && (world.chaos.drib || world.chaos.name === 'CHEEKY CHIP')) && Math.random() < 0.7)
        vo(callClip(['power', 'curve', 'trivela', 'knuckle'][shot.style] || 'power'), true);
      const fk = world.chaos && FX[world.chaos.name];
      if (fk && fk.atKick) {
        fxFired = true; sfx(fk.snd);
        if (fk.sparkle) puff(world.ball.x, 0.1, world.ball.z, 16, [fk.sparkle, '#ffffff'], 1.5, 1);
        if (fk.flash) world.wall.forEach((d) => puff(d.x, 2.1, d.z, 4, ['#ffffff', '#ffffa0'], 0.6, 0.4)); // camera flashes
      }
      squash = 0.09; puff(world.ball.x, 0.05, world.ball.z, 14, GRASS_C, 1.2, 1.6);
    }
    shake = Math.max(0, shake - dt * 20);
    squash = Math.max(0, squash - dt); fade = Math.max(0, fade - dt * 3.5); flash = Math.max(0, flash - dt * 4);
    for (const q of parts) { q.vy -= 6 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt; q.life -= dt; if (q.y < 0) { q.y = 0; q.vy *= -0.3; q.vx *= 0.5; q.vz *= 0.5; } }
    parts = parts.filter((q) => q.life > 0);
    for (const r of ripples) r.t += dt;
    ripples = ripples.filter((r) => r.t < 0.3);
    shownScore = score < shownScore ? score : shownScore + Math.ceil((score - shownScore) * Math.min(1, dt * 6)); // score counts up
    if (state === 'flight' || state === 'result') {
      const k = world.keeper;
      if (/low|mid|high/.test(k.state) && k.by < 0.5 && !k.landed) { k.landed = true; puff(k.bx, 0.05, k.z, 10, DUST, 1, 1); } // dive lands
      if (state === 'result' && world.result === 'save' && stateT > 0.5 && !kCheer) { // keeper gets up and celebrates, ball overhead if caught
        kCheer = true; k.px = k.bx; k.tx = k.bx; k.ty = 2.35; k.tArr = 1e9;
        if (!/low|mid|high/.test(k.state)) k.state = 'mid';
      }
    }
    for (const c of confetti) { c.x += c.vx * dt + Math.sin(c.ph) * 0.5; c.y += c.vy * dt; c.ph += dt * 8; }
    confetti = confetti.filter((c) => c.y < H);
    if (state === 'flight' || state === 'result') {
      // slow motion on close calls: near the post or bar, or within reach of the keeper, and just after the ball goes in
      const b = world.ball, k = world.keeper;
      const close = state === 'flight' && b.vz > 2 && b.z > -4 && b.z < 0.3 && ((Math.abs(b.x) > HW - 0.8 && Math.abs(b.x) < HW + 0.6) || Math.abs(b.y - GH) < 0.5 || Math.hypot(b.x - k.bx, b.y - k.by) < 1);
      timeScale += ((close || (world.result === 'goal' && stateT < 0.3) ? 0.4 : 1) - timeScale) * Math.min(1, dt * 12);
      if (state === 'flight' && !b.held) { trail.push([b.x, b.y, b.z]); if (trail.length > 14) trail.shift(); }
      const c = world.chaos, fe = c && FX[c.name];
      if (fe && !fxFired && world.ft >= c.t0) {
        fxFired = true; sfx(fe.snd);
        if (fe.confetti) burstConfetti();
        if (fe.wave) excite = Math.max(excite, 0.7);
        if (fe.dirt) puff(b.x, 0.05, b.z, 12, DUST, 1.2, 1.5);
      }
      if (fe && fe.sparkle && world.ft >= c.t0 && world.ft < c.t0 + (c.dur || 1) && Math.random() < 0.6) puff(b.x, b.y, b.z, 1, [fe.sparkle, '#ffffff'], 0.8, 0.6);
      acc += dt * timeScale;
      while (acc >= STEP) { acc -= STEP; handle(Sim.step(world, STEP)); netStep(STEP); }
      if (state === 'result') {
        if (replay) { if (stateT > 1.8) endReplay(); }
        else if (stateT > (world.result === 'goal' ? 4 : msg && msg.dur > 3 ? 3.4 : 2.8)) advance(); // goals linger for REPLAY / SAVE
      }
    }
    updateCam(dt);
    if (AC && AC.state === 'running' && idle()) AC.suspend(); // woken by the next tap
    if (AC) {
      const b = world.ball, fl = state === 'flight' && !b.held, t = AC.currentTime;
      const sp = fl ? Math.hypot(b.vx, b.vy, b.vz) : 0, spin = fl ? Math.min(1, Math.hypot(b.sx, b.sy, b.sz)) : 0;
      whoosh.g.gain.setTargetAtTime(fl ? clamp((sp - 4) / 30, 0, 1) * (0.05 + spin * 0.12 + (world.wob ? 0.08 : 0)) : 0, t, 0.05);
      whoosh.f.frequency.setTargetAtTime(400 + sp * 30 + (world.wob ? Math.sin(tnow * 40) * 250 : spin * 600), t, 0.03);
      crowd.g.gain.setTargetAtTime((0.03 + excite * 0.12) * (clip ? 0.55 : 1), t, 0.3); // dips under the commentary
    }
  }

  world = Sim.newWorld(0, 1);
  useSkin(skin);
  selectHero(hero);
  makeDefenders();
  frameCam();
  // battery: a still screen nobody has touched for 20 s draws every 4th frame; any touch is back to full rate next frame
  const idle = () => (state === 'title' || state === 'over' || state === 'aim' || state === 'heroes' || state === 'pause' || state === 'replays') && !ptr && tnow - lastTouch > 20 && excite < 0.05 && !confetti.length && !parts.length && !ripples.length && fade <= 0 && flash <= 0;
  let last = performance.now(), pending = 0, frameNo = 0;
  function frame(now) {
    requestAnimationFrame(frame); // first, so one bad frame can't freeze the game
    pending += Math.min(0.1, (now - last) / 1000);
    last = now;
    if (idle() && ++frameNo & 3) return;
    const dt = Math.min(0.1, pending);
    pending = 0;
    try { update(dt); render(); }
    catch (err) { text('ERROR ' + String(err.message).slice(0, 60), 2, H - 8, 1, '#ff4040'); } // visible on-device for bug reports
  }
  requestAnimationFrame(frame);
  window.__back = () => { // Android back: opens/closes the menu; only quits the app from the title screen
    if (replay) endReplay();
    else if (state === 'replays') { state = 'title'; fade = 0.6; }
    else if (state === 'aim') state = 'pause';
    else if (state === 'pause') state = 'aim';
    else if (state === 'heroes') { state = heroFrom; fade = 0.5; }
    else if (state === 'over') { state = 'title'; fade = 0.6; }
    else return state !== 'title'; // mid-shot: ignore
    return true;
  };
  window.__rfk = { Sim, get world() { return world; }, get state() { return state; }, get replay() { return replay; }, get lastKick() { return lastKick; }, shot }; // handle for automated checks
})();
