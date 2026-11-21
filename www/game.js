'use strict';
// Retro Free Kick. The simulation section is pure JS (node runs it in test/); the rest is canvas + WebAudio.
(function () {
  // =================================================================== SIMULATION
  // World metres: x = right, y = up, z = toward the goal. Goal line is z = 0, goal centre x = 0.
  const DEG = Math.PI / 180;
  const G = 9.81, R = 0.11, HW = 3.66, GH = 2.44, ND = 2.0, PR = 0.06;
  const DRAG = 0.012, MAGNUS = 0.36, WALL_D = 9.15;
  const TARGETS = [[-HW + 0.6, GH - 0.55], [HW - 0.6, GH - 0.55]], TARGET_R = 0.5;
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
    { name: 'KNUCKLE', desc: 'NO SPIN, WILD WOBBLE', vMin: 22, vMax: 33, elev: 12, loft: 11, spin: 0, top0: 0, top: 0, u: 0, v: 0, knuckle: true },
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

  function newWorld(n, seed, spot) { // spot: optional { dist, ang } chosen by the player
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
    const kx = -side * 0.9; // keeper cheats toward the side the wall doesn't cover
    return {
      L, rng, ball, yaw0, wall, wallYaw, start: { x: ball.x, z: ball.z },
      keeper: { x: kx, z: -0.4, ax: kx, ay: 0.1, bx: kx, by: 1.95, px: kx, tx: 0, ty: 0, tArr: 9, cool: 0, state: 'idle' },
      phase: 'aim', ft: 0, ev: {}, result: null, st: null, wob: null,
    };
  }

  // shot: { style: 0-3, aim: -1..1, power: 0..1, u: -1..1 (strike point, right +), v: -1..1 (up +),
  //         mega: top power 1000 km/h, insane: 4x sidespin, assist: ball homes into the net,
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

  function kick(w, shot) {
    w.st = launch(w, shot, w.ball);
    w.wob = w.st.knuckle ? [3.5 + w.rng() * 2, w.rng() * 6.283, 4 + w.rng() * 2, w.rng() * 6.283, 1 + (shot.kn || 0)] : null;
    w.assist = null;
    if (shot.assist) { // home on the spot in the goal nearest to where the shot was heading anyway
      const c = preview(w, Object.assign({}, shot, { assist: false }), 80).find((q) => q[2] >= 0);
      w.assist = { x: clamp(c ? c[0] : shot.aim * HW, -HW + 0.6, HW - 0.6), y: clamp(c ? c[1] : 1.5, 0.5, GH - 0.5), z: 0.8 };
    }
    w.phase = 'flight'; w.ft = 0;
  }

  const A = [0, 0, 0];
  function accel(b, wind, t, late, wob) {
    const rx = b.vx - wind.x, ry = b.vy, rz = b.vz - wind.z, d = DRAG * Math.hypot(rx, ry, rz);
    const m = late ? MAGNUS * (0.25 + 1.3 * smooth((t - 0.1) / 0.6)) : MAGNUS;
    A[0] = -d * rx + m * (b.sy * b.vz - b.sz * b.vy);
    A[1] = -G - d * ry + m * (b.sz * b.vx - b.sx * b.vz);
    A[2] = -d * rz + m * (b.sx * b.vy - b.sy * b.vx);
    if (wob) { // no spin: the wake sheds unevenly, so the ball gets shoved sideways and down at random
      const h = Math.hypot(b.vx, b.vz) || 1, k = clamp((Math.hypot(b.vx, b.vy, b.vz) - 14) / 14, 0, 1);
      const lat = 7 * k * wob[4] * Math.sin(wob[0] * t + wob[1]);
      A[0] += (lat * b.vz) / h; A[2] -= (lat * b.vx) / h; A[1] += 4 * k * wob[4] * Math.sin(wob[2] * t + wob[3]);
    }
    return A;
  }

  function move(b, w, dt, t, late, wob, ev) {
    const a = accel(b, w.L.wind, t, late, wob);
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
      move(b, w, dt, t, st.late, null, null);
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
      move(b, w, 1 / 240, w.ft + i / 240, false, null, null);
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
    // the wall hides the strike: he only reads the ball once it's past the wall line
    if (w.seen === undefined && (b.x - w.start.x) * Math.sin(w.yaw0) + (b.z - w.start.z) * Math.cos(w.yaw0) > WALL_D + 0.3) w.seen = t;
    if (k.state === 'ready' && t >= L.react && w.seen !== undefined && t >= w.seen + 0.12) {
      const p = predict(w, k.z);
      if (!p || Math.abs(p.x) > HW + 0.7 || p.y > GH + 0.6) k.state = 'watch';
      else {
        const err = 1 - L.read;
        k.tx = clamp(p.x + (w.rng() - 0.5) * err * 1.6, k.x - L.reach, k.x + L.reach);
        k.ty = clamp(p.y + (w.rng() - 0.5) * err * 0.6, 0.15, 2.45);
        k.tArr = p.t;
        const dx = k.tx - k.x;
        k.state = Math.abs(dx) < 0.5 && k.ty < 2.0 ? 'block' : k.ty < 0.7 ? 'low' : k.ty > 1.7 ? 'high' : 'mid';
        k.px = k.x;
        if (k.state === 'block') k.ty = Math.max(k.ty, 1.2); // stay on his feet: body covers the low ball, hands the high one
        else { k.bx = k.x + Math.sign(dx) * 0.3; k.by = 1.4; }
      }
    }
    if (k.state === 'watch') k.x += clamp(clamp(b.x, -HW, HW) - k.x, -1.5 * dt, 1.5 * dt);
    if (k.state === 'ready' || k.state === 'watch') {
      k.ax = k.bx = k.x; k.ay = 0.1; k.by = k.state === 'ready' ? 1.7 : 1.95;
      return;
    }
    if (k.state !== 'block' && !b.held && t > k.tArr + 0.25) k.ty = 0.3; // ball has gone by: land on the turf
    // hands chase the read; the body trails back toward the take-off foot (max 1.9 m)
    const sp = k.state === 'block' ? 3.5 : L.kspeed;
    const ddx = k.tx - k.bx, ddy = k.ty - k.by, dd = Math.hypot(ddx, ddy), mv = Math.min(dd, sp * dt);
    if (dd > 1e-6) { k.bx += (ddx / dd) * mv; k.by += (ddy / dd) * mv; }
    const ex = k.bx - k.px, ey = k.by, el = Math.hypot(ex, ey) || 1, len = Math.min(el, 1.9);
    k.ax = k.bx - (ex / el) * len; k.ay = Math.max(0.1, k.by - (ey / el) * len);
  }

  // aim assist: steer the velocity toward a waypoint over the wall, then the target; turns harder as it closes in
  function home(w, b, dt) {
    const T = w.assist, clear = WALL_D + 0.5, lx = T.x - w.start.x, lz = T.z - w.start.z, ll = Math.hypot(lx, lz);
    let tx = T.x, ty = T.y, tz = T.z;
    if (((b.x - w.start.x) * lx + (b.z - w.start.z) * lz) / ll < clear - 0.3) { // progress measured along start -> target
      const f = clear / Math.max(clear + 1, ll);
      tx = w.start.x + lx * f; tz = w.start.z + lz * f; ty = 2.9;
    }
    const dx = tx - b.x, dy = ty - b.y, dz = tz - b.z, d = Math.hypot(dx, dy, dz) || 1;
    const sp = Math.max(18, Math.hypot(b.vx, b.vy, b.vz)), k = Math.min(1, (dt * sp * 3) / Math.max(d, 1.5));
    b.vx += ((dx / d) * sp - b.vx) * k; b.vy += ((dy / d) * sp - b.vy) * k; b.vz += ((dz / d) * sp - b.vz) * k;
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
    const b = w.ball, k = w.keeper, e = w.ev, ghost = !!w.assist && !e.goal; // assisted ball passes through wall/keeper/frame
    w.ft += dt;
    const t = w.ft;
    for (const d of w.wall) { const p = (t - d.jt) / 0.55; d.y = p > 0 && p < 1 ? 4 * d.jh * p * (1 - p) : 0; }
    updateKeeper(w, dt);
    if (b.held) { b.x = k.bx; b.y = Math.max(R, k.by); b.z = k.z + 0.15; b.vx = b.vy = b.vz = 0; }
    else {
      const px = b.x, py = b.y, pz = b.z;
      move(b, w, dt, t, w.st.late, w.wob, ev);
      if (ghost) home(w, b, dt);
      b.rot += dt * (Math.hypot(b.sx, b.sy, b.sz) * 35 + (w.wob ? 0.4 : 0) + Math.hypot(b.vx, b.vz) * 0.05);

      // wall: boxes per defender in the wall's own frame
      const fx = Math.sin(w.wallYaw), fz = Math.cos(w.wallYaw);
      for (const d of ghost ? [] : w.wall) {
        const rx = b.x - d.x, rz = b.z - d.z, al = rx * fx + rz * fz, la = rx * fz - rz * fx, hy = b.y - d.y;
        const half = hy > 1.6 ? 0.13 : 0.27;
        if (Math.abs(al) < 0.15 + R && Math.abs(la) < half + R && hy > -R && hy < 1.86 + R) {
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
      for (const sx of ghost ? [] : [-HW, HW]) {
        const dx = b.x - sx, d = Math.hypot(dx, b.z);
        if (d < R + PR && d > 1e-6 && b.y < GH + PR) hit(dx / d, 0, b.z / d, d);
      }
      if (!ghost && Math.abs(b.x) < HW) { const dy = b.y - GH, d = Math.hypot(dy, b.z); if (d < R + PR && d > 1e-6) hit(0, dy / d, b.z / d, d); }

      // keeper: capsule from feet/hips (a) to hands (b) in his plane
      if (!ghost && k.cool <= 0 && Math.abs(b.z - k.z) < 0.25 + R) {
        const c = seg(b.x, b.y, k.ax, k.ay, k.bx, k.by);
        if (c.d < 0.22 + R) {
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
        } else if (!e.out && !ghost) e.out = { x: cx, y: cy };
      }

      // nets: back, sides, roof
      const inX = Math.abs(b.x) < HW, inY = b.y < GH, inZ = b.z > 0 && b.z < ND;
      if (ghost && inX && inY && b.z > R && b.z < ND) e.goal = { x: b.x, y: b.y }; // mega curve can swing it in from the side
      if (pz < ND && b.z >= ND && inX && inY) { b.z = ND - 0.01; b.vz *= -0.1; b.vx *= 0.4; b.vy *= 0.4; ev.push('net'); }
      if (!ghost && inZ && inY && (Math.abs(px) < HW) !== inX) { b.x = px; b.vx *= -0.2; b.vz *= 0.6; ev.push('sidenet'); }
      if (!ghost && inZ && inX && (py < GH) !== inY) { b.y = py; b.vy *= -0.2; b.vz *= 0.6; ev.push('sidenet'); }
    }

    if (!w.result) {
      const sp = Math.hypot(b.vx, b.vy, b.vz), why = () => (e.save ? 'save' : e.wall ? 'wall' : e.post ? 'post' : 'wide');
      if (e.goal) w.result = 'goal';
      else if (b.held) w.result = 'save';
      else if (e.out) w.result = e.save || e.post || e.wall ? why() : e.out.y >= GH ? 'over' : 'wide';
      else if (e.save && t - e.save > 0.8 && b.vz < 3) w.result = 'save';
      else if (e.wall && t - e.wall > 0.9 && b.vz < 2) w.result = 'wall';
      else if (e.post && t - e.post > 1.0 && b.vz < 1) w.result = 'post';
      else if (t > 4 || (sp < 0.5 && b.y < R + 0.01)) w.result = why();
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
  const xpFor = (nStars, streak, dist) => 10 + 10 * nStars + 5 * Math.min(streak, 5) + Math.max(0, Math.round(dist - 18));

  const Sim = { RANKS, rankOf, xpFor, stars, multiplier, missBy, STYLES, LEVELS, TARGETS, TARGET_R, HW, GH, ND, R, PR, makeLevel, newWorld, kick, step, preview, speed: speedOf };
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
    { name: 'JUNINHO', foot: 'R', back: 1.5, side: 0.8, runT: 0.5, stepT: 0.09, stance: 'stand', style: 3, kn: 0.4, run: 'MEASURED, STRAIGHT',
      perk: 'KNUCKLE KING: WILDER KNUCKLEBALL', skin: '#704020', hair: '#151515', cut: 'short', shirt: '#f2f2f2', num: 8, numCol: '#2040b0', shorts: '#f2f2f2', socks: '#2040b0' },
    { name: 'MESSI', foot: 'L', back: 1.1, side: 0.8, runT: 0.38, stepT: 0.08, stance: 'stand', style: 1, cv: 0.15, guide: 3, run: 'SHORT AND QUICK',
      perk: 'FINESSE: +15% CURVE, LONGER GUIDE', skin: '#e8b890', hair: '#4a2a14', cut: 'short', shirt: '#f2f2f2', stripe: '#78c0f0', num: 10, numCol: '#101828', shorts: '#101828', socks: '#f2f2f2' },
    { name: 'CR7', foot: 'R', back: 1.6, side: 0.75, runT: 0.55, stepT: 0.11, stance: 'wide', style: 3, pw: 0.08, kn: 0.2, run: 'POWER STANCE, BIG STRIDES',
      perk: 'TOMAHAWK: +8% POWER, KNUCKLE', skin: '#d8a070', hair: '#151515', cut: 'short', shirt: '#d01828', num: 7, numCol: '#f0d020', shorts: '#108040', socks: '#d01828' },
    { name: 'BECKHAM', foot: 'R', back: 1.0, side: 1.0, runT: 0.5, stepT: 0.09, stance: 'stand', style: 1, cv: 0.25, run: 'WIDE ANGLE',
      perk: 'BEND IT: +25% CURVE', skin: '#f0c8a0', hair: '#e8c860', cut: 'short', shirt: '#f2f2f2', num: 7, numCol: '#2030a0', shorts: '#2030a0', socks: '#f2f2f2' },
    { name: 'R. CARLOS', foot: 'L', back: 1.6, side: 0.9, runT: 0.5, stepT: 0.07, stance: 'wide', style: 2, pw: 0.12, cv: 0.1, run: 'LONG AND FAST',
      perk: 'BANANA BLAST: +12% POWER, +10% CURVE', skin: '#a86838', hair: '#a86838', cut: 'shaved', shirt: '#f8d820', num: 6, numCol: '#108040', shorts: '#2050c0', socks: '#f2f2f2' },
    { name: 'RONALDINHO', foot: 'R', back: 1.0, side: 0.7, runT: 0.35, stepT: 0.09, stance: 'stand', style: 1, cv: 0.05, react: 0.06, run: 'SHORT, RELAXED',
      perk: 'TRICKSTER: KEEPER REACTS LATE', skin: '#8a5428', hair: '#101010', cut: 'curly', band: '#ffffff', shirt: '#203c9c', stripe: '#a01838', num: 10, numCol: '#f0d020', shorts: '#203c9c', socks: '#203c9c' },
    { name: 'KROOS', foot: 'R', back: 1.3, side: 1.0, runT: 0.45, stepT: 0.09, stance: 'hips', style: 1, guide: 6, run: 'CALM, ANGLED',
      perk: 'METRONOME: MUCH LONGER AIM GUIDE', skin: '#f0c8a0', hair: '#a07a40', cut: 'short', shirt: '#f2f2f2', num: 8, numCol: '#101010', shorts: '#101010', socks: '#f2f2f2' },
    { name: 'PIRLO', foot: 'R', back: 0.9, side: 0.9, runT: 0.55, stepT: 0.15, stance: 'hips', style: 0, tp: 0.35, run: 'A SLOW WALK-UP',
      perk: 'MALEDETTA: EXTRA DIP', skin: '#e8b890', hair: '#2a1a10', cut: 'long', shirt: '#1c50c0', num: 21, numCol: '#ffffff', shorts: '#f2f2f2', socks: '#1c50c0' },
    { name: 'DAVID LUIZ', foot: 'R', back: 1.6, side: 0.8, runT: 0.6, stepT: 0.08, stance: 'wide', style: 3, pw: 0.1, kn: 0.15, run: 'LONG, ON HIS TOES',
      perk: 'ROCKET: +10% POWER, KNUCKLE', skin: '#d8a070', hair: '#3a2412', cut: 'afro', shirt: '#f8d820', num: 4, numCol: '#108040', shorts: '#2050c0', socks: '#f2f2f2' },
  ];
  function heroSprite(h, pose) { // seen from behind; left-footers are drawn mirrored, except the shirt number
    return mk(16, 33, (raw) => {
      const p = h.foot === 'L' ? (x, y, w, hh, c) => raw(16 - x - w, y, w, hh, c) : raw;
      const SK = h.skin, S = h.shirt, H = h.hair, SH = 'rgba(0,0,0,0.22)', BT = '#151515';
      p(4, 7, 8, 11, S);
      if (h.stripe) for (let x = 5; x < 12; x += 2) p(x, 7, 1, 11, h.stripe);
      p(11, 7, 1, 11, SH);
      const ds = String(h.num), x0 = ds.length > 1 ? 4 : 6;
      for (let d = 0; d < ds.length; d++) for (let b = 0; b < 15; b++) if (FONT[ds[d]][b] === '1') raw(x0 + d * 4 + (b % 3), 9 + ((b / 3) | 0), 1, 1, h.numCol);
      p(4, 18, 8, 4, h.shorts); p(11, 18, 1, 4, SH);
      p(7, 6, 2, 1, SK);
      if (h.cut === 'shaved') { p(6, 0, 4, 1, SK); p(5, 1, 6, 5, SK); p(5, 1, 6, 1, SH); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK); }
      else if (h.cut === 'afro') { p(5, 0, 6, 1, H); p(3, 1, 10, 5, H); p(4, 6, 8, 1, H); }
      else if (h.cut === 'curly') { p(5, 0, 6, 1, H); p(4, 1, 8, 8, H); p(4, 2, 8, 1, h.band); }
      else { p(6, 0, 4, 1, H); p(5, 1, 6, 5, H); p(4, 3, 1, 2, SK); p(11, 3, 1, 2, SK); if (h.cut === 'long') p(5, 6, 6, 3, H); }
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
  const starIcon = (c) => mk(5, 5, (p) => { p(2, 0, 1, 1, c); p(1, 1, 3, 1, c); p(0, 2, 5, 1, c); p(1, 3, 3, 1, c); p(1, 4, 1, 1, c); p(3, 4, 1, 1, c); });
  const STAR_ON = starIcon('#ffd020'), STAR_OFF = starIcon('#3a3a5a');
  function drawStars(n, x, y, sc) { for (let i = 0; i < 3; i++) ctx.drawImage(i < n ? STAR_ON : STAR_OFF, Math.round(x + (i - 1.5) * 8 * sc), y, 7 * sc, 7 * sc); }

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
    stars3() { [988, 1319, 1976].forEach((f, i) => tone('square', f, f, 0.14, 0.06, i * 0.25)); },
  };
  const sfx = (n) => { if (AC) SFX[n](); };
  document.addEventListener('visibilitychange', () => { if (AC) (document.hidden ? AC.suspend() : AC.resume()); });

  // ------------------------------------------------------------------ game state
  let state = 'title', world, level = 0, lives = 3, score = 0, best = 0;
  let levelT = 0, stateT = 0, tnow = 0, excite = 0, acc = 0, whistled = true, msg = null, hint = null, ptr = null;
  const shot = { style: 1, aim: 0, power: 0.6, u: STYLES[1].u, v: STYLES[1].v, mega: false, insane: false, assist: false };
  let spot = null, seed = 1, moving = false; // player-chosen kick spot for the current level
  const CHIPS = [['MOVE', 'move'], ['1000KM/H', 'mega'], ['MEGA CURVE', 'insane'], ['AIM ASSIST', 'assist']], CHIP_Y = 32;
  // saved progress: best score, furthest level, best stars per level, chosen ball. Anything unreadable starts fresh.
  let far = 0, starsBy = {}, skin = 0, streak = 0, runCheat = false, cheatKick = false, xp = 0, runXp = 0;
  let shake = 0, timeScale = 1, trail = [], confetti = [];
  let parts = [], ripples = [], squash = 0, fade = 1, flash = 0, shownScore = 0, kCheer = false; // animation state
  function puff(x, y, z, n, cols, spd, up) { // little burst of pixels at a world point: dust, sparks, net threads
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, v = spd * (0.4 + Math.random() * 0.6);
      parts.push({ x, y, z, vx: Math.cos(a) * v, vy: up * (0.5 + Math.random()), vz: Math.sin(a) * v, life: 0.3 + Math.random() * 0.3, c: cols[i % cols.length] });
    }
  }
  const GRASS_C = ['#58b858', '#3d9b3d', '#e6eee6'], DUST = ['#8a7a50', '#5a9a4a', '#b0a070'], SPARK = ['#ffffff', '#ffe060', '#ffb030'];
  try {
    const d = JSON.parse(localStorage.getItem('rfk-save') || 'null');
    if (d && typeof d === 'object') {
      best = Math.max(0, +d.best || 0); far = Math.max(0, d.far | 0); xp = Math.max(0, d.xp | 0); hero = clamp(d.hero | 0, 0, HEROES.length - 1); skin = clamp(d.skin | 0, 0, BALL_SKINS.length - 1);
      if (d.stars && typeof d.stars === 'object') for (const k in d.stars) starsBy[k] = clamp(d.stars[k] | 0, 0, 3);
    } else best = +localStorage.getItem('rfk-best') || 0; // pre-progression saves kept only the best score
  } catch (_) {}
  const persist = () => { try { localStorage.setItem('rfk-save', JSON.stringify({ best, far, stars: starsBy, skin, xp, hero })); } catch (_) {} };
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
  function makeWorld() {
    world = Sim.newWorld(level, seed, spot);
    if (rank() >= 5) { world.L.read = Math.max(0.1, world.L.read - 0.15); world.L.react += 0.05; } // MIND GAMES
    world.L.react += HEROES[hero].react || 0;
  }
  const showMsg = (big, sub, col, dur = 2.6, sc = 5, st = -1, extra = '') => (msg = { t: 0, big, sub, col, dur, sc, st, extra });
  const sideName = () => (world.L.ang < -5 ? 'LEFT' : world.L.ang > 5 ? 'RIGHT' : 'CENTRE');

  function setupLevel() {
    seed = (Math.random() * 2147483647) | 0; moving = false;
    makeWorld();
    makeDefenders(); frameCam(); nd.fill(0); nv.fill(0);
    state = 'aim'; levelT = 0; stateT = 0; acc = 0; whistled = false; ptr = null; trail = []; fade = 0.8; kCheer = false; parts = [];
    showMsg('LEVEL ' + (level + 1), Math.round(world.L.dist) + 'M ' + sideName() + ' - ' + world.L.wallN + ' IN WALL', '#ffffff', 1.8, 4, starsBy[level] || 0);
  }
  function startGame(n) { level = n; lives = maxLives(); score = 0; streak = 0; runCheat = false; runXp = 0; spot = null; applyPerks(); setupLevel(); }
  function placeBall(dist, ang) { spot = { dist, ang }; makeWorld(); frameCam(); }
  function pickStyle(i) { shot.style = i; shot.u = STYLES[i].u * (HEROES[hero].foot === 'L' ? -1 : 1); shot.v = STYLES[i].v; hint = { t: 0, s: STYLES[i].name + ': ' + STYLES[i].desc }; }
  function doKick() {
    if (state !== 'aim') return;
    state = 'runup'; stateT = 0; ptr = null; msg = null; moving = false; trail = [];
    cheatKick = shot.mega || shot.insane || shot.assist;
  }
  function onResult() {
    state = 'result'; stateT = 0;
    const r = world.result, e = world.ev, st = world.st;
    if (r === 'goal') {
      const base = 100 + Math.round((world.L.dist - 18) * 10) + (e.target ? 200 : 0) + (e.post ? 50 : 0) + (st.late || st.knuckle ? 50 : 0);
      excite = 1; shake = 4; flash = 0.55; sfx('cheer'); burstConfetti();
      const how = e.target ? 'TOP BINS! ' : e.post ? 'IN OFF THE POST! ' : st.knuckle ? 'KNUCKLEBALL! ' : st.late ? 'TRIVELA! ' : '';
      if (cheatKick) { // cheats score points but earn no stars, streak or best score
        score += base; runCheat = true;
        return showMsg('GOAL!', how + '+' + base, '#ffe040', 2.6, 5, -1, 'CHEATS ON - NO STARS');
      }
      const m = Sim.multiplier(streak), pts = base * m, n = Sim.stars(world, lives === maxLives()), before = totalStars();
      const gain = Sim.xpFor(n, streak, world.L.dist), r0 = rank();
      score += pts; streak++; xp += gain; runXp += gain;
      const up = rank() > r0 ? Sim.RANKS[rank()] : null;
      if (up) { applyPerks(); setTimeout(() => sfx('stars3'), 1200); }
      if (score > best && !runCheat) best = score;
      if (n > (starsBy[level] || 0)) starsBy[level] = n;
      const fresh = BALL_SKINS.find((k) => k.need > before && k.need <= totalStars());
      persist();
      setTimeout(() => sfx('stars' + n), 350);
      showMsg('GOAL!', how + '+' + pts + (m > 1 ? ' (X' + m + ')' : '') + '  +' + gain + 'XP', '#ffe040', up ? 3.4 : 2.8, 5, n,
        up ? 'RANK UP: ' + up.name + '! ' + up.perk : fresh ? 'NEW BALL UNLOCKED: ' + fresh.name : streak >= 3 ? 'ON FIRE! ' + streak + ' IN A ROW' : '');
    } else {
      sfx('ooh');
      const left = lives - 1, gap = Sim.missBy(world), lost = streak >= 2 ? 'STREAK OF ' + streak + ' LOST' : '';
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
  function advance() {
    if (world.result === 'goal') { level++; lives = maxLives(); spot = null; if (level > far) { far = level; persist(); } setupLevel(); } // 3 balls per level, refilled on every goal
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
      else if (e === 'net') { sfx('net'); netHit(b.x, b.y, 9); shake = Math.max(shake, 2); puff(b.x, b.y, b.z, 8, ['#ffffff', '#d8d8e8'], 1.2, 0.5); }
      else if (e === 'sidenet') sfx('net');
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
    if (state === 'heroes') {
      const col = Math.floor((x - 3) / 89), row = Math.floor((y - 34) / 90);
      if (y >= 34 && y < 304 && col >= 0 && col < 3) { selectHero(row * 3 + col); persist(); return; }
      if (y >= 370 && y < 400) return startGame(far);
      if (y >= 404 && y < 424) { state = 'title'; fade = 0.6; }
      return;
    }
    if (state === 'title') {
      if (y >= 282 && y < 300) return startGame(0); // NEW GAME
      if (y >= 326 && y < 344) { state = 'heroes'; fade = 0.6; return; } // PLAYER
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
    if (state === 'result') { if (stateT > 0.9) advance(); return; }
    if (state !== 'aim') return;
    let mode = null;
    if (y >= CHIP_Y - 2 && y < CHIP_Y + 14) {
      const c = CHIPS[Math.floor((x - 3) / 67)];
      if (c) { if (c[1] === 'move') moving = !moving; else shot[c[1]] = !shot[c[1]]; }
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
      const set = k.state === 'ready' || (state === 'runup' && stateT > HEROES[hero].runT - 0.25); // crouches as the kicker arrives
      upright(set ? KEEP.set : KEEP.idle, k.x + sway, 0, k.z, set ? 1.9 : 2.12 - bob);
    } else if (k.state === 'block') upright(KEEP.block, k.ax, 0, k.z, 2.1);
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
    const set = Math.abs(b.sy) > Math.hypot(b.sx, b.sz) ? BALL.y : BALL.x, q = squash / 0.09; // squash on impacts
    const sw = Math.round(s * (1 + 0.35 * q)), sh = Math.round(s * (1 - 0.25 * q));
    ctx.drawImage(set[((Math.floor((b.rot / (Math.PI * 2)) * 16) % 16) + 16) % 16], Math.round(p[0] - sw / 2), Math.round(p[1] - sh / 2), sw, sh);
  }
  function kickerPos() { // stands at his own spot, runs in to plant beside the ball; left-footers come from the right
    const h = HEROES[hero], s = world.start, fx = Math.sin(world.yaw0), fz = Math.cos(world.yaw0);
    let back = h.back, side = h.side;
    if (state === 'runup') { const e = Math.min(1, stateT / h.runT); back += (0.3 - back) * e; side += (0.32 - side) * e; }
    else if (state === 'flight' || state === 'result') { back = 0.3; side = 0.32; }
    if (h.foot === 'L') side = -side;
    return [s.x - fx * back - fz * side, s.z - fz * back + fx * side];
  }
  function drawKicker(x, z) {
    const p = proj(x, 0, z);
    if (!p || p[3] < 2.2) return; // the dollying camera passes him: don't blow him up across the screen
    const h = HEROES[hero], run = state === 'runup', after = state === 'flight' || state === 'result';
    // run-up: 4-frame stride cycle, then the wind-up; contact, follow-through, then standing; breathing while he waits
    const spr = run ? (h.runT - stateT < 0.12 ? HS.plant : [HS.run, HS.pass, HS.run2, HS.pass][Math.floor(stateT / (h.stepT / 2)) & 3])
      : state === 'flight' && stateT < 0.12 ? HS.kick : state === 'flight' && stateT < 0.5 ? HS.follow : after ? HS.stand : HS.stance;
    const lift = run ? Math.abs(Math.sin((stateT * Math.PI) / h.stepT)) * 0.06 : !after && Math.sin(tnow * 2.4) > 0.5 ? 0.012 : 0;
    shadow(x, z, 0.35, 0.3);
    upright(spr, x, lift, z, 2.05);
  }
  function wallPose(d, i) {
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
      upright(DEF[i][pose], p[0], p[1] + bob, p[2], 2.0);
    }));
    add(b.x, b.y, b.z, drawBall);
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

    if (state === 'aim' || state === 'runup') { // dotted launch arc for the first few metres
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
    const bar = Math.round(((1 - timeScale) / 0.6) * 18); // cinema bars so slow motion reads as an effect, not lag
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
    cached(HUD_L, [L.n, L.dist, L.ang, shownScore, best, lives, dx, dy, moving, shot.mega, shot.insane, shot.assist, streak, skin, xp].join(), 0, 56, () => drawHud(dx, dy));
  }
  function drawHud(dx, dy) {
    CHIPS.forEach(([label, key], i) => {
      const on = key === 'move' ? moving : shot[key], x = 3 + i * 67;
      bevel(x, CHIP_Y, 64, 12, on ? '#30d070' : 'rgba(20,24,56,0.85)', on ? '#a0ffc0' : '#4a56a0', on ? '#108040' : '#141834');
      text(label, x + 32, CHIP_Y + 4, 1, on ? '#002010' : '#d0dcff', 0.5, on ? null : '#000000');
    });
    const L = world.L;
    text('LV ' + (L.n + 1), 4, 4, 2);
    text(Math.round(L.dist) + 'M ' + sideName(), 4, 17, 1, '#c8e8ff');
    text('SCORE ' + shownScore, W - 4, 4, 1, '#ffe040', 1);
    text('BEST ' + best, W - 4, 12, 1, '#a0a8c0', 1);
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
    cached(UI_L, [live, live && Math.floor(tnow * 3) & 1, shot.style, shot.aim, shot.power, shot.u, shot.v, shot.mega, shot.insane, shot.assist,
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
    if (state === 'heroes') {
      ctx.fillStyle = 'rgba(6,8,24,0.88)'; ctx.fillRect(0, 0, W, H);
      text('PICK YOUR TAKER', W / 2, 12, 2, '#ffe040', 0.5);
      cards = cards || HEROES.map((h) => heroSprite(h, h.stance));
      HEROES.forEach((h, i) => {
        const x = 3 + (i % 3) * 89, y = 34 + ((i / 3) | 0) * 90, sel = i === hero;
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
      btn('PLAY AS ' + h.name, 372, 28, true);
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
        text('SWIPE UP TO SHOOT. DRAG THE BALL', W / 2, 354, 1, '#c8e8ff', 0.5);
        text('WIDGET TO PICK WHERE YOU STRIKE IT.', W / 2, 364, 1, '#c8e8ff', 0.5);
        text('GOALS IN A ROW MULTIPLY YOUR POINTS.', W / 2, 378, 1, '#ffe060', 0.5);
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

  function update(dt) {
    tnow += dt; levelT += dt; stateT += dt;
    excite = Math.max(0, excite - dt * 0.22);
    if (msg) msg.t += dt;
    if (hint) hint.t += dt;
    if (state === 'aim' && levelT > 0.4 && !whistled) { whistled = true; sfx('whistle'); }
    if (state === 'runup' && stateT >= HEROES[hero].runT) {
      Sim.kick(world, shot); state = 'flight'; stateT = 0; acc = 0; sfx('kick');
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
      acc += dt * timeScale;
      while (acc >= STEP) { acc -= STEP; handle(Sim.step(world, STEP)); netStep(STEP); }
      if (state === 'result' && stateT > (msg && msg.dur > 3 ? 3.4 : 2.8)) advance();
    }
    updateCam(dt);
    if (AC && AC.state === 'running' && idle()) AC.suspend(); // woken by the next tap
    if (AC) {
      const b = world.ball, fl = state === 'flight' && !b.held, t = AC.currentTime;
      const sp = fl ? Math.hypot(b.vx, b.vy, b.vz) : 0, spin = fl ? Math.min(1, Math.hypot(b.sx, b.sy, b.sz)) : 0;
      whoosh.g.gain.setTargetAtTime(fl ? clamp((sp - 4) / 30, 0, 1) * (0.05 + spin * 0.12 + (world.wob ? 0.08 : 0)) : 0, t, 0.05);
      whoosh.f.frequency.setTargetAtTime(400 + sp * 30 + (world.wob ? Math.sin(tnow * 40) * 250 : spin * 600), t, 0.03);
      crowd.g.gain.setTargetAtTime(0.03 + excite * 0.12, t, 0.3);
    }
  }

  world = Sim.newWorld(0, 1);
  useSkin(skin);
  selectHero(hero);
  makeDefenders();
  frameCam();
  // battery: a still screen nobody has touched for 20 s draws every 4th frame; any touch is back to full rate next frame
  const idle = () => (state === 'title' || state === 'over' || state === 'aim' || state === 'heroes') && !ptr && tnow - lastTouch > 20 && excite < 0.05 && !confetti.length && !parts.length && !ripples.length && fade <= 0 && flash <= 0;
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
  window.__rfk = { Sim, get world() { return world; }, get state() { return state; }, shot }; // handle for automated checks
})();
