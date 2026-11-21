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
  const STYLES = [
    { name: 'POWER', desc: 'DRIVEN, FAST, LITTLE SPIN', vMin: 20, vMax: 34, elev: 6, spin: 0.25, top: 0.3, u: 0, v: 0.25 },
    { name: 'CURVE', desc: 'WHIP IT AROUND THE WALL', vMin: 15, vMax: 28, elev: 14, spin: 1.0, top: 0.5, u: 0.65, v: -0.2 },
    { name: 'TRIVELA', desc: 'OUTSIDE BOOT, LATE SWERVE', vMin: 17, vMax: 30, elev: 12, spin: -1.15, top: 0.4, u: 0.55, v: -0.1, late: true },
    { name: 'KNUCKLE', desc: 'NO SPIN, WILD WOBBLE', vMin: 22, vMax: 33, elev: 12, spin: 0, top: 0, u: 0, v: 0, knuckle: true },
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
      react: Math.max(0.22, 0.38 - n * 0.013), kspeed: Math.min(5.6, 4.0 + n * 0.12), read: Math.min(0.9, 0.5 + n * 0.035),
    };
  }

  function newWorld(n, seed) {
    const L = makeLevel(n), rng = mulberry32(seed | 0), a = L.ang * DEG;
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

  // shot: { style: 0-3, aim: -1..1, power: 0..1, u: -1..1 (strike point, right +), v: -1..1 (up +) }
  function launch(w, shot, b) {
    const st = STYLES[shot.style];
    const speed = st.vMin + (st.vMax - st.vMin) * shot.power;
    const yaw = w.yaw0 + shot.aim * 0.35 + st.spin * shot.u * 0.05; // off-centre contact starts it on the outside of the bend
    const el = (st.elev - shot.v * 9) * DEG, side = -shot.u * st.spin, top = shot.v * st.top;
    b.vx = Math.sin(yaw) * Math.cos(el) * speed; b.vy = Math.sin(el) * speed; b.vz = Math.cos(yaw) * Math.cos(el) * speed;
    b.sx = top * Math.cos(yaw); b.sy = side; b.sz = -top * Math.sin(yaw);
    return st;
  }

  function kick(w, shot) {
    w.st = launch(w, shot, w.ball);
    w.wob = w.st.knuckle ? [3.5 + w.rng() * 2, w.rng() * 6.283, 4 + w.rng() * 2, w.rng() * 6.283] : null;
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
      const lat = 7 * k * Math.sin(wob[0] * t + wob[1]);
      A[0] += (lat * b.vz) / h; A[2] -= (lat * b.vx) / h; A[1] += 4 * k * Math.sin(wob[2] * t + wob[3]);
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
    for (let i = 1; i < 2400; i++) {
      move(b, w, 1 / 240, i / 240, st.late, null, null);
      if (i % 3 === 0) pts.push([b.x, b.y, b.z]);
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
    if (k.state === 'ready' && t >= L.react) {
      const p = predict(w, k.z);
      if (!p || Math.abs(p.x) > HW + 0.7 || p.y > GH + 0.6) k.state = 'watch';
      else {
        const err = 1 - L.read;
        k.tx = p.x + (w.rng() - 0.5) * err * 1.6;
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

  function step(w, dt) {
    const ev = [];
    if (w.phase !== 'flight') return ev;
    const b = w.ball, k = w.keeper, e = w.ev;
    w.ft += dt;
    const t = w.ft;
    for (const d of w.wall) { const p = (t - d.jt) / 0.55; d.y = p > 0 && p < 1 ? 4 * d.jh * p * (1 - p) : 0; }
    updateKeeper(w, dt);
    if (b.held) { b.x = k.bx; b.y = Math.max(R, k.by); b.z = k.z + 0.15; b.vx = b.vy = b.vz = 0; }
    else {
      const px = b.x, py = b.y, pz = b.z;
      move(b, w, dt, t, w.st.late, w.wob, ev);
      b.rot += dt * (Math.hypot(b.sx, b.sy, b.sz) * 35 + (w.wob ? 0.4 : 0) + Math.hypot(b.vx, b.vz) * 0.05);

      // wall: boxes per defender in the wall's own frame
      const fx = Math.sin(w.wallYaw), fz = Math.cos(w.wallYaw);
      for (const d of w.wall) {
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
      for (const sx of [-HW, HW]) {
        const dx = b.x - sx, d = Math.hypot(dx, b.z);
        if (d < R + PR && d > 1e-6 && b.y < GH + PR) hit(dx / d, 0, b.z / d, d);
      }
      if (Math.abs(b.x) < HW) { const dy = b.y - GH, d = Math.hypot(dy, b.z); if (d < R + PR && d > 1e-6) hit(0, dy / d, b.z / d, d); }

      // keeper: capsule from feet/hips (a) to hands (b) in his plane
      if (k.cool <= 0 && Math.abs(b.z - k.z) < 0.25 + R) {
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
      else if (t > 4 || (sp < 0.5 && b.y < R + 0.01)) w.result = why();
      if (w.result) ev.push('result');
    }
    return ev;
  }

  const Sim = { STYLES, LEVELS, TARGETS, TARGET_R, HW, GH, ND, R, PR, makeLevel, newWorld, kick, step, preview };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Sim; return; }

  // =================================================================== BROWSER
  const W = 270, H = 480, UI_Y = 390, STEP = 1 / 240;
  const CAM_BACK = 4.6, CAM_H = 3.8, BALL_SY = 362, BAR_SY = 104, STAND_Z = 8, STAND_TOP = 15;
  const BAR_X = 28, BAR_W = 152, WX = 226, WY = 449, WR = 27;

  const cv = document.getElementById('c'), ctx = cv.getContext('2d', { alpha: false });
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
  function groundPx(gx, gz, lw, lwz) {
    if (gz < 0.5 && gz > -20.3) {
      const ax = gx < 0 ? -gx : gx, d = gz + 11;
      if ((Math.abs(gz) < lwz && ax < 40) ||
        (Math.abs(gz + 5.5) < lwz && ax < 9.16) || (gz > -5.5 && gz < 0 && Math.abs(ax - 9.16) < lw) ||
        (Math.abs(gz + 16.5) < lwz && ax < 20.16) || (gz > -16.5 && gz < 0 && Math.abs(ax - 20.16) < lw) ||
        (ax < lw + 0.1 && Math.abs(d) < lwz + 0.1) ||
        (gz < -16.5 && Math.abs(Math.sqrt(gx * gx + d * d) - 9.15) < lwz)) return LINE;
    }
    return GTEX[Math.floor(gz * 0.25) & 1][(((gz * 3) & 63) << 6) | ((gx * 3) & 63)];
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
  const STAND = [0, 1, 2, 3].map((f) => {
    const t = new Uint32Array(TEX_W * TEX_H);
    for (let y = 0; y < TEX_H; y++) for (let x = 0; x < TEX_W; x++) t[y * TEX_W + x] = standPx((x + 0.5) / TPM - 80, (y + 0.5) / TPM, f);
    return t;
  });
  const SKYBUF = new Uint32Array(W * H);
  for (let i = 0; i < W * H; i++) SKYBUF[i] = hash(i % W, (i / W) | 0) % 397 === 0 && i < W * 150 ? STAR : SKY[(i / W) | 0];
  function renderBG() {
    const f = cam.f, r = cam.r, u = cam.u, iF = 1 / cam.F, cx = cam.cx, cy = cam.cy, X = cam.x, Y = cam.y, Z = cam.z;
    const tex = STAND[excite > 0.05 ? 1 + (Math.floor(tnow * 8) % 3) : 0];
    let o = 0;
    for (let py = 0; py < H; py++) {
      const b = (py - cy) * iF, ry = f[1] - b * u[1];
      const rx0 = f[0] - b * u[0] - cx * iF * r[0], rz0 = f[2] - b * u[2] - cx * iF * r[2], drx = r[0] * iF, drz = r[2] * iF;
      const ground = ry < -1e-5, tg = ground ? -Y / ry : 0;
      const lw = Math.max(0.06, tg * iF * 0.6), lwz = Math.max(0.06, (tg * tg * iF * 0.55) / Y); // keep lines >= 1px at grazing angles
      for (let px = 0; px < W; px++, o++) {
        const rx = rx0 + px * drx, rz = rz0 + px * drz;
        if (ground) { const gz = Z + tg * rz; if (gz < STAND_Z) { buf[o] = groundPx(X + tg * rx, gz, lw, lwz); continue; } }
        if (rz > 1e-5) {
          const ts = (STAND_Z - Z) / rz, sy = Y + ts * ry, sx = X + ts * rx;
          if (sy < STAND_TOP && sx > -80 && sx < 80) { buf[o] = tex[(sy > 0 ? (sy * TPM) | 0 : 0) * TEX_W + (((sx + 80) * TPM) | 0)]; continue; }
        }
        buf[o] = SKYBUF[o];
      }
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
      const d2 = (nodeX(i) - x) ** 2 + (nodeY(j) - y) ** 2;
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
  function defender(skin, hair, jump) {
    return mk(12, 26, (p) => {
      const S = '#d42a34', Sd = '#9a1826', K = '#151515';
      p(4, 0, 4, 2, hair); p(4, 2, 4, 4, skin); p(5, 3, 2, 1, '#2a1a1a'); p(5, 6, 2, 1, skin);
      p(3, 7, 6, 8, S); p(8, 7, 1, 8, Sd); p(5, 7, 2, 1, '#ffffff');
      p(2, 7, 1, 3, S); p(9, 7, 1, 3, Sd); p(2, 10, 1, 3, skin); p(9, 10, 1, 3, skin);
      p(3, 13, 2, 1, skin); p(7, 13, 2, 1, skin); p(4, 14, 4, 1, skin); // hands guarding
      p(3, 15, 6, 4, '#f2f2f2'); p(8, 15, 1, 4, '#c4c4cc');
      if (!jump) { p(3, 19, 2, 3, skin); p(7, 19, 2, 3, skin); p(3, 22, 2, 3, S); p(7, 22, 2, 3, S); p(2, 25, 3, 1, K); p(7, 25, 3, 1, K); }
      else { p(2, 19, 2, 2, skin); p(8, 19, 2, 2, skin); p(2, 21, 2, 2, S); p(8, 21, 2, 2, S); p(1, 23, 3, 1, K); p(8, 23, 3, 1, K); }
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
    stretch: mk(12, 32, (p) => { // arms overhead; rotated along the dive line
      p(1, 0, 3, 3, GL); p(8, 0, 3, 3, GL); p(2, 3, 2, 7, KJ); p(8, 3, 2, 7, KJd);
      p(4, 5, 4, 2, KH); p(4, 7, 4, 3, KS);
      p(3, 10, 6, 8, KJ); p(8, 10, 1, 8, KJd); p(3, 18, 6, 3, '#202028');
      p(3, 21, 2, 5, KS); p(7, 21, 2, 5, KS); p(3, 26, 2, 4, KJd); p(7, 26, 2, 4, KJd);
      p(3, 30, 2, 2, '#151515'); p(7, 30, 2, 2, '#151515');
    }),
  };
  let DEF = [];
  function makeDefenders() {
    DEF = world.wall.map((_, i) => { const s = SKINS[(i * 3 + world.L.n) & 3], h = HAIRS[(i + world.L.n * 2) & 3]; return [defender(s, h, false), defender(s, h, true)]; });
  }

  // football: per-pixel sphere, truncated-icosahedron panels from pentagon/hexagon centre directions
  const PHI = (1 + Math.sqrt(5)) / 2, PENT = [], HEXD = [];
  const nrm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    PENT.push(nrm([0, a, b * PHI]), nrm([a, b * PHI, 0]), nrm([b * PHI, 0, a]));
    HEXD.push(nrm([0, a / PHI, b * PHI]), nrm([a / PHI, b * PHI, 0]), nrm([b * PHI, 0, a / PHI]));
    for (const c of [-1, 1]) HEXD.push(nrm([a, b, c]));
  }
  const WHT = ['#ffffff', '#d0d6e0', '#8e96a8'].map(hex), BLK = ['#3a3a4c', '#262636', '#14141e'].map(hex);
  const SEAM = ['#9aa0b0', '#787e90', '#585e70'].map(hex), BOUT = hex('#181020');
  function ballCanvas(S, ang, axisX) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), d = g.createImageData(S, S), px = new Uint32Array(d.data.buffer);
    const r = S / 2, ca = Math.cos(ang), sa = Math.sin(ang), edge = (1 - 1.5 / r) ** 2;
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
      px[y * S + x] = d2 > edge ? BOUT : Math.abs(k) < 0.014 || (k < 0 && h1 - h2 < 0.012) ? SEAM[lv] : k > 0 ? BLK[lv] : WHT[lv];
    }
    g.putImageData(d, 0, 0);
    return c;
  }
  const BALL = { x: [], y: [] };
  for (let i = 0; i < 16; i++) { BALL.x.push(ballCanvas(24, (i / 16) * Math.PI * 2, true)); BALL.y.push(ballCanvas(24, (i / 16) * Math.PI * 2, false)); }
  const WIDGET = ballCanvas(WR * 2, 0.35, true);

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
  };
  const sfx = (n) => { if (AC) SFX[n](); };
  document.addEventListener('visibilitychange', () => { if (AC) (document.hidden ? AC.suspend() : AC.resume()); });

  // ------------------------------------------------------------------ game state
  let state = 'title', world, level = 0, lives = 3, score = 0, best = 0;
  let levelT = 0, stateT = 0, tnow = 0, excite = 0, acc = 0, whistled = true, msg = null, hint = null, ptr = null;
  const shot = { style: 1, aim: 0, power: 0.6, u: STYLES[1].u, v: STYLES[1].v };
  try { best = +localStorage.getItem('rfk-best') || 0; } catch (_) {}
  const saveBest = () => { try { localStorage.setItem('rfk-best', String(best)); } catch (_) {} };
  const showMsg = (big, sub, col, dur = 2.6, sc = 5) => (msg = { t: 0, big, sub, col, dur, sc });
  const sideName = () => (world.L.ang < -5 ? 'LEFT' : world.L.ang > 5 ? 'RIGHT' : 'CENTRE');

  function setupLevel() {
    world = Sim.newWorld(level, (Math.random() * 2147483647) | 0);
    makeDefenders(); frameCam(); nd.fill(0); nv.fill(0);
    state = 'aim'; levelT = 0; stateT = 0; acc = 0; whistled = false; ptr = null;
    showMsg('LEVEL ' + (level + 1), Math.round(world.L.dist) + 'M ' + sideName() + ' - ' + world.L.wallN + ' IN WALL', '#ffffff', 1.6, 4);
  }
  function startGame() { level = 0; lives = 3; score = 0; setupLevel(); }
  function pickStyle(i) { shot.style = i; shot.u = STYLES[i].u; shot.v = STYLES[i].v; hint = { t: 0, s: STYLES[i].name + ': ' + STYLES[i].desc }; }
  function doKick() {
    if (state !== 'aim') return;
    Sim.kick(world, shot);
    state = 'flight'; stateT = 0; acc = 0; ptr = null; msg = null;
    sfx('kick');
  }
  function onResult() {
    state = 'result'; stateT = 0;
    const r = world.result, e = world.ev, st = world.st;
    if (r === 'goal') {
      const pts = 100 + Math.round((world.L.dist - 18) * 10) + (e.target ? 200 : 0) + (e.post ? 50 : 0) + (st.late || st.knuckle ? 50 : 0);
      score += pts; excite = 1; sfx('cheer');
      if (score > best) { best = score; saveBest(); }
      showMsg('GOAL!', (e.target ? 'TOP BINS! ' : e.post ? 'IN OFF THE POST! ' : st.knuckle ? 'KNUCKLEBALL! ' : '') + '+' + pts, '#ffe040');
    } else {
      sfx('ooh');
      const left = lives - 1;
      showMsg({ save: 'SAVED!', wall: 'BLOCKED!', post: 'POST!', over: 'OVER!', wide: 'WIDE!' }[r] || 'MISS!',
        left > 0 ? left + (left > 1 ? ' BALLS LEFT' : ' BALL LEFT') : 'NO BALLS LEFT', '#ff6a5a');
    }
  }
  function advance() {
    if (world.result === 'goal') { level++; lives = 3; setupLevel(); } // 3 balls per level, refilled on every goal
    else if (--lives <= 0) { state = 'over'; stateT = 0; msg = null; }
    else setupLevel();
  }
  function handle(evs) {
    for (const e of evs) {
      if (e === 'post') sfx('clank');
      else if (e === 'wall') sfx('thud');
      else if (e === 'save') sfx('save');
      else if (e === 'bounce') sfx('bounce');
      else if (e === 'net') { sfx('net'); netHit(world.ball.x, world.ball.y, 9); }
      else if (e === 'sidenet') sfx('net');
      else if (e === 'result') onResult();
    }
  }

  // ------------------------------------------------------------------ input
  const loc = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height]; };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault(); initAudio();
    if (ptr) return;
    const [x, y] = loc(e);
    if (state === 'title') return startGame();
    if (state === 'over') { if (stateT > 0.8) startGame(); return; }
    if (state === 'result') { if (stateT > 0.9) advance(); return; }
    if (state !== 'aim') return;
    let mode = null;
    if (y >= 393 && y < 413) { const i = Math.floor((x - 3) / 66); if (i >= 0 && i < 4) pickStyle(i); return; }
    if (x > 188 && y >= 413) mode = 'whip';
    else if (x < 188 && y >= 413 && y < 429) mode = 'aim';
    else if (x < 188 && y >= 429 && y < 446) mode = 'pwr';
    else if (x < 188 && y >= 446) return doKick();
    else if (y < UI_Y) mode = 'swipe';
    if (!mode) return;
    ptr = { id: e.pointerId, mode, sx: x, sy: y, u0: shot.u, pts: [[x, y]], live: false };
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    drag(x, y);
  });
  cv.addEventListener('pointermove', (e) => { if (ptr && e.pointerId === ptr.id) { const [x, y] = loc(e); drag(x, y); } });
  const release = (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const p = ptr;
    ptr = null;
    if (p.mode === 'swipe' && p.live && e.type === 'pointerup' && shot.power > 0.12) doKick();
  };
  cv.addEventListener('pointerup', release);
  cv.addEventListener('pointercancel', release);
  function drag(x, y) {
    const p = ptr;
    if (p.mode === 'whip') {
      let u = (x - WX) / WR, v = -(y - WY) / WR;
      const l = Math.hypot(u, v);
      if (l > 0.95) { u *= 0.95 / l; v *= 0.95 / l; }
      shot.u = u; shot.v = v;
    } else if (p.mode === 'aim') shot.aim = clamp(((x - BAR_X) / BAR_W) * 2 - 1, -1, 1);
    else if (p.mode === 'pwr') shot.power = clamp((x - BAR_X) / BAR_W, 0, 1);
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
      const hw = Math.round(w * Math.sqrt(Math.max(0, 1 - (dy / (h + 0.5)) ** 2)));
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
      const sway = state === 'aim' || state === 'title' ? Math.sin(tnow * 1.3) * 0.15 : 0;
      const bob = (Math.floor(tnow * 2.5) & 1) * 0.05;
      upright(KEEP.idle, k.x + sway, 0, k.z, k.state === 'ready' ? 1.92 : 2.12 - bob);
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
    const s = Math.max(2, Math.round(2 * R * p[2])), x = Math.round(p[0] - s / 2), y = Math.round(p[1] - s / 2);
    if (s < 5) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, s, s); if (s > 2) { ctx.fillStyle = '#8e96a8'; ctx.fillRect(x + s - 1, y + s - 1, 1, 1); } return; }
    const set = Math.abs(b.sy) > Math.hypot(b.sx, b.sz) ? BALL.y : BALL.x;
    ctx.drawImage(set[((Math.floor((b.rot / (Math.PI * 2)) * 16) % 16) + 16) % 16], x, y, s, s);
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
    ctx.putImageData(img, 0, 0);
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
    wp.forEach((p, i) => add(p[0], 1, p[2], () => upright(DEF[i][world.wall[i].y > 0.02 ? 1 : 0], p[0], p[1], p[2], 2.0)));
    add(b.x, b.y, b.z, drawBall);
    items.sort((p, q) => q[0] - p[0]).forEach((it) => it[1]());

    if (state === 'aim') { // dotted launch arc for the first few metres
      const pts = Sim.preview(world, shot, 7);
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
    hud();
    ui();
    overlays();
  }

  function hud() {
    const L = world.L;
    text('LV ' + (L.n + 1), 4, 4, 2);
    text(Math.round(L.dist) + 'M ' + sideName(), 4, 17, 1, '#c8e8ff');
    text('SCORE ' + score, W - 4, 4, 1, '#ffe040', 1);
    text('BEST ' + best, W - 4, 12, 1, '#a0a8c0', 1);
    for (let i = 0; i < lives; i++) ctx.drawImage(BALL.x[0], W - 11 - i * 9, 20, 7, 7);
    if (L.windSpeed > 0) { // arrow in screen space: up = toward the goal
      const wx = L.wind.x, wz = L.wind.z, X = wx * cam.r[0] + wz * cam.r[2], Zc = wx * cam.f[0] + wz * cam.f[2], l = Math.hypot(X, Zc) || 1;
      const dx = X / l, dy = -Zc / l, cx = 135, cy = 22;
      text('WIND ' + L.windSpeed.toFixed(1) + 'M/S', cx, 4, 1, '#9ff0ff', 0.5);
      line(cx - dx * 7, cy - dy * 7, cx + dx * 7, cy + dy * 7, 1, '#9ff0ff');
      const hx = cx + dx * 7, hy = cy + dy * 7;
      line(hx, hy, hx - dx * 4 - dy * 3, hy - dy * 4 + dx * 3, 1, '#9ff0ff');
      line(hx, hy, hx - dx * 4 + dy * 3, hy - dy * 4 - dx * 3, 1, '#9ff0ff');
    }
  }

  function ui() {
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
    text(Math.round(shot.power * 100) + '%', BAR_X + BAR_W - 3, 434, 1, '#ffffff', 1);
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
    else if (live && level < 2 && Math.floor(tnow * 1.5) & 1) text('SWIPE UP TO SHOOT', W / 2, UI_Y - 9, 1, '#ffffff', 0.5);
  }

  function overlays() {
    if (msg && msg.t < msg.dur) {
      const sc = Math.max(msg.sc, Math.round(msg.sc + 3 - msg.t * 20)), y = 168;
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, y - 6, W, sc * 5 + (msg.sub ? 26 : 12));
      text(msg.big, W / 2, y, sc, msg.col, 0.5);
      if (msg.sub) text(msg.sub, W / 2, y + sc * 5 + 8, 1, '#ffffff', 0.5);
    }
    if (state === 'title' || state === 'over') {
      ctx.fillStyle = 'rgba(6,8,24,0.72)'; ctx.fillRect(0, 0, W, H);
      if (state === 'title') {
        text('RETRO', W / 2, 92, 7, '#ffe040', 0.5);
        text('FREE KICK', W / 2, 136, 4, '#ffffff', 0.5);
        ctx.drawImage(BALL.x[Math.floor(tnow * 10) & 15], W / 2 - 24, 176, 48, 48);
        text('SWIPE UP TO SHOOT', W / 2, 250, 1, '#c8e8ff', 0.5);
        text('OR SET AIM + POWER, THEN KICK', W / 2, 260, 1, '#c8e8ff', 0.5);
        text('DRAG THE BALL WIDGET TO PICK', W / 2, 274, 1, '#c8e8ff', 0.5);
        text('WHERE YOUR BOOT STRIKES IT', W / 2, 284, 1, '#c8e8ff', 0.5);
        text('BEST ' + best, W / 2, 308, 2, '#a0a8c0', 0.5);
      } else {
        text('FULL TIME', W / 2, 120, 5, '#ff6a5a', 0.5);
        text('SCORE ' + score, W / 2, 170, 3, '#ffe040', 0.5);
        text('REACHED LEVEL ' + (level + 1), W / 2, 196, 1, '#ffffff', 0.5);
        text('BEST ' + best, W / 2, 210, 2, '#a0a8c0', 0.5);
      }
      if (Math.floor(tnow * 2) & 1) text(state === 'title' ? 'TAP TO START' : 'TAP TO PLAY AGAIN', W / 2, 340, 2, '#ffffff', 0.5);
    }
  }

  function update(dt) {
    tnow += dt; levelT += dt; stateT += dt;
    excite = Math.max(0, excite - dt * 0.22);
    if (msg) msg.t += dt;
    if (hint) hint.t += dt;
    if (state === 'aim' && levelT > 0.4 && !whistled) { whistled = true; sfx('whistle'); }
    if (state === 'flight' || state === 'result') {
      acc += dt;
      while (acc >= STEP) { acc -= STEP; handle(Sim.step(world, STEP)); netStep(STEP); }
      if (state === 'result' && stateT > 2.8) advance();
    }
    updateCam(dt);
    if (AC) {
      const b = world.ball, fl = state === 'flight' && !b.held, t = AC.currentTime;
      const sp = fl ? Math.hypot(b.vx, b.vy, b.vz) : 0, spin = fl ? Math.hypot(b.sx, b.sy, b.sz) : 0;
      whoosh.g.gain.setTargetAtTime(fl ? clamp((sp - 4) / 30, 0, 1) * (0.05 + spin * 0.12 + (world.wob ? 0.08 : 0)) : 0, t, 0.05);
      whoosh.f.frequency.setTargetAtTime(400 + sp * 30 + (world.wob ? Math.sin(tnow * 40) * 250 : spin * 600), t, 0.03);
      crowd.g.gain.setTargetAtTime(0.03 + excite * 0.12, t, 0.3);
    }
  }

  world = Sim.newWorld(0, 1);
  makeDefenders();
  frameCam();
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame); // first, so one bad frame can't freeze the game
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    try { update(dt); render(); }
    catch (err) { text('ERROR ' + String(err.message).slice(0, 60), 2, H - 8, 1, '#ff4040'); } // visible on-device for bug reports
  }
  requestAnimationFrame(frame);
  window.__rfk = { Sim, get world() { return world; }, get state() { return state; }, shot }; // handle for automated checks
})();
