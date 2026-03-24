/**
 * Shared campfire icon drawing module.
 * Animated campfire with wood being tossed into the fire.
 * Used by both:
 *   - generate-icon.js  (app icon for .icns / DMG)
 *   - main.js           (animated tray icon in menu bar)
 */
'use strict';
const zlib = require('zlib');

// ─── PNG Encoder ─────────────────────────────────────────────────────

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (~c) >>> 0;
}

function buildPNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function chunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crcBuf]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const comp = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', comp), chunk('IEND', Buffer.alloc(0))]);
}

// ─── Canvas ──────────────────────────────────────────────────────────

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 4, 0);
  }

  set(x, y, r, g, b, a) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const srcA = a / 255, dstA = this.buf[i + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      this.buf[i]     = Math.round((r * srcA + this.buf[i]     * dstA * (1 - srcA)) / outA);
      this.buf[i + 1] = Math.round((g * srcA + this.buf[i + 1] * dstA * (1 - srcA)) / outA);
      this.buf[i + 2] = Math.round((b * srcA + this.buf[i + 2] * dstA * (1 - srcA)) / outA);
      this.buf[i + 3] = Math.round(outA * 255);
    }
  }

  fillCircle(cx, cy, radius, r, g, b, a) {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 <= r2) {
          const edge = Math.sqrt(d2) - radius + 1;
          const aa = edge > 0 ? Math.max(0, 1 - edge) : 1;
          this.set(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  fillEllipse(cx, cy, rx, ry, r, g, b, a) {
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const d2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d2 <= 1) {
          const edge = Math.sqrt(d2) - 1 + 0.02;
          const aa = edge > 0 ? Math.max(0, 1 - edge * rx * 0.5) : 1;
          this.set(x, y, r, g, b, Math.round(a * Math.min(1, aa)));
        }
      }
    }
  }

  fillRect(x1, y1, x2, y2, r, g, b, a) {
    for (let y = Math.round(y1); y <= Math.round(y2); y++)
      for (let x = Math.round(x1); x <= Math.round(x2); x++)
        this.set(x, y, r, g, b, a);
  }

  fillTriangle(x1, y1, x2, y2, x3, y3, r, g, b, a) {
    const minX = Math.floor(Math.min(x1, x2, x3));
    const maxX = Math.ceil(Math.max(x1, x2, x3));
    const minY = Math.floor(Math.min(y1, y2, y3));
    const maxY = Math.ceil(Math.max(y1, y2, y3));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
        if (Math.abs(d) < 0.001) continue;
        const wa = ((y2 - y3) * (x - x3) + (x3 - x2) * (y - y3)) / d;
        const wb = ((y3 - y1) * (x - x3) + (x1 - x3) * (y - y3)) / d;
        const wc = 1 - wa - wb;
        if (wa >= -0.01 && wb >= -0.01 && wc >= -0.01) this.set(x, y, r, g, b, a);
      }
    }
  }

  drawLine(x1, y1, x2, y2, thickness, r, g, b, a) {
    const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
    if (len === 0) return;
    const half = thickness / 2;
    const minX = Math.floor(Math.min(x1, x2) - half - 1);
    const maxX = Math.ceil(Math.max(x1, x2) + half + 1);
    const minY = Math.floor(Math.min(y1, y2) - half - 1);
    const maxY = Math.ceil(Math.max(y1, y2) + half + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x2 - x1, dy = y2 - y1;
        let t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
        t = Math.max(0, Math.min(1, t));
        const dist = Math.sqrt((x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2);
        if (dist <= half + 0.5) {
          const aa = dist > half - 0.5 ? Math.max(0, 1 - (dist - half + 0.5)) : 1;
          this.set(x, y, r, g, b, Math.round(a * aa));
        }
      }
    }
  }

  scaleDown(newW, newH) {
    const dst = new Canvas(newW, newH);
    const scaleX = this.w / newW, scaleY = this.h / newH;
    for (let dy = 0; dy < newH; dy++) {
      for (let dx = 0; dx < newW; dx++) {
        let rS = 0, gS = 0, bS = 0, aS = 0, cnt = 0;
        const sx1 = Math.floor(dx * scaleX), sy1 = Math.floor(dy * scaleY);
        const sx2 = Math.min(this.w - 1, Math.floor((dx + 1) * scaleX));
        const sy2 = Math.min(this.h - 1, Math.floor((dy + 1) * scaleY));
        for (let sy = sy1; sy <= sy2; sy++) {
          for (let sx = sx1; sx <= sx2; sx++) {
            const si = (sy * this.w + sx) * 4;
            rS += this.buf[si]; gS += this.buf[si + 1]; bS += this.buf[si + 2]; aS += this.buf[si + 3];
            cnt++;
          }
        }
        if (cnt > 0) {
          const di = (dy * newW + dx) * 4;
          dst.buf[di] = Math.round(rS / cnt); dst.buf[di + 1] = Math.round(gS / cnt);
          dst.buf[di + 2] = Math.round(bS / cnt); dst.buf[di + 3] = Math.round(aS / cnt);
        }
      }
    }
    return dst;
  }
}

// ─── Seeded random for deterministic frames ──────────────────────────

function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// ─── Draw Campfire ───────────────────────────────────────────────────

// Total animation: 48 frames (~7.2s at 150ms/frame)
// Frames 0-9:   stack of cash from RIGHT
// Frames 16-25: stack of cash from LEFT
// Frames 32-41: stack of cash from RIGHT
const TOTAL_FRAMES = 48;

function drawCampfire(size, frame, opts = {}) {
  const { showBackground = true } = opts;
  const c = new Canvas(size, size);
  const S = size;
  const cx = S / 2;
  const baseY = S * 0.78; // ground line

  const rand = seededRandom(frame * 137 + 42);

  // ── Background (for app icon only) ──
  if (showBackground) {
    const pad = S * 0.06, bgRad = S * 0.22;
    for (let y = pad; y < S - pad; y++) {
      const t = (y - pad) / (S - 2 * pad);
      // Dark warm gradient
      const r = Math.round(30 + (50 - 30) * t);
      const g = Math.round(20 + (25 - 20) * t);
      const b = Math.round(40 + (30 - 40) * t);
      for (let x = pad; x < S - pad; x++) {
        let inside = true;
        const checks = [
          [pad + bgRad, pad + bgRad, x < pad + bgRad && y < pad + bgRad],
          [S - pad - bgRad, pad + bgRad, x > S - pad - bgRad && y < pad + bgRad],
          [pad + bgRad, S - pad - bgRad, x < pad + bgRad && y > S - pad - bgRad],
          [S - pad - bgRad, S - pad - bgRad, x > S - pad - bgRad && y > S - pad - bgRad],
        ];
        for (const [ccx, ccy, cond] of checks) {
          if (cond && (x - ccx) ** 2 + (y - ccy) ** 2 > bgRad * bgRad) { inside = false; break; }
        }
        if (inside) c.set(x, y, r, g, b, 255);
      }
    }
  }

  // ── Ground glow ──
  c.fillEllipse(cx, baseY + S * 0.04, S * 0.38, S * 0.06, 80, 30, 10, 60);

  // ── Logs (crossed sticks) ──
  const logThick = S * 0.045;
  const logColor = [110, 65, 30]; // brown

  // Bottom log - horizontal
  c.drawLine(cx - S * 0.25, baseY, cx + S * 0.25, baseY, logThick, ...logColor, 255);
  // Cross log - angled left
  c.drawLine(cx - S * 0.22, baseY - S * 0.02, cx + S * 0.05, baseY + S * 0.06, logThick * 0.9, 90, 55, 25, 255);
  // Cross log - angled right
  c.drawLine(cx + S * 0.22, baseY - S * 0.02, cx - S * 0.05, baseY + S * 0.06, logThick * 0.9, 90, 55, 25, 255);

  // ── Embers / hot coals at base ──
  for (let i = 0; i < 6; i++) {
    const ex = cx + (rand() - 0.5) * S * 0.2;
    const ey = baseY - S * 0.01 + rand() * S * 0.03;
    const er = S * 0.015 + rand() * S * 0.01;
    const brightness = 150 + rand() * 105;
    c.fillCircle(ex, ey, er, brightness, 40 + rand() * 40, 0, 180 + rand() * 75);
  }

  // ── Fire (multiple flame tongues) ──
  // Use a faster phase cycle so flames visibly pulse big/small
  const flamePhase = (frame % 9) / 9 * Math.PI * 2;
  // Global size multiplier: flames breathe between 0.7x and 1.3x
  const breathe = 1.0 + Math.sin((frame % 18) / 18 * Math.PI * 2) * 0.3;

  // Helper: draw a single flame tongue
  function drawFlame(offsetX, heightMul, widthMul, rBase, gBase, bBase, alpha) {
    const flameH = S * 0.34 * heightMul * breathe;
    const flameW = S * 0.10 * widthMul * (0.8 + breathe * 0.2);
    const fCX = cx + offsetX;
    const fBaseY = baseY - S * 0.03;

    const steps = 12;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const y = fBaseY - flameH * t;
      const w = flameW * (1 - t * t);
      const h = flameH / steps * 1.5;

      // Big wobble for small-icon visibility
      const wobble = Math.sin(flamePhase + t * 3 + offsetX * 10) * S * 0.07 * t;

      const r = Math.min(255, Math.round(rBase + (255 - rBase) * t * 0.5));
      const g = Math.min(255, Math.round(gBase + (255 - gBase) * t));
      const b = Math.min(255, Math.round(bBase + (100 - bBase) * t * t));
      const a = Math.round(alpha * (1 - t * 0.6));

      if (w > 0.5) {
        c.fillEllipse(fCX + wobble, y, w, h, r, g, b, a);
      }
    }
  }

  // Main central flame
  drawFlame(0, 1.0 + Math.sin(flamePhase) * 0.4, 1.3, 255, 120, 0, 240);
  // Left flame
  drawFlame(-S * 0.08, 0.8 + Math.sin(flamePhase + 1.5) * 0.35, 1.0, 255, 80, 0, 220);
  // Right flame
  drawFlame(S * 0.08, 0.85 + Math.sin(flamePhase + 3) * 0.35, 1.0, 255, 90, 0, 220);
  // Outer left flicker
  drawFlame(-S * 0.14, 0.5 + Math.sin(flamePhase + 2) * 0.3, 0.7, 255, 100, 10, 180);
  // Outer right flicker
  drawFlame(S * 0.14, 0.45 + Math.sin(flamePhase + 4) * 0.3, 0.7, 255, 100, 10, 180);
  // Inner bright core
  drawFlame(0, 0.6 + Math.sin(flamePhase * 1.3) * 0.25, 0.6, 255, 220, 80, 200);

  // ── Sparks ──
  for (let i = 0; i < 5; i++) {
    const sparkPhase = (frame * 0.35 + i * 1.5) % 6;
    const sparkT = sparkPhase / 6;
    if (sparkT < 0.85) {
      const sx = cx + (Math.sin(i * 2.3 + frame * 0.25) * S * 0.15);
      const sy = baseY - S * 0.15 - sparkT * S * 0.4;
      const sparkAlpha = Math.round(255 * (1 - sparkT));
      const sr = S * 0.01 + (1 - sparkT) * S * 0.006;
      c.fillCircle(sx, sy, sr, 255, 200 + Math.round(sparkT * 55), 50, sparkAlpha);
    }
  }

  // ── Flying objects — big bundles of logs + fat stacks of cash ──

  // Helper: arc trajectory from one side into the fire
  function arcPos(t, fromRight, arcHeight, yOffset) {
    const side = fromRight ? 1 : -1;
    const startX = cx + side * S * 0.48;
    const startY = baseY - S * 0.58 + yOffset;
    const endX = cx + (rand() - 0.5) * S * 0.04;
    const endY = baseY - S * 0.06;
    return {
      x: startX + (endX - startX) * t,
      y: startY + (endY - startY) * t - Math.sin(t * Math.PI) * S * arcHeight,
    };
  }

  // Draw a BIG bundle of logs (5 thick sticks, spread out)
  function drawLogBundle(tossStart, tossLen, fromRight) {
    const tf = frame - tossStart;
    if (tf < 0 || tf > tossLen) return;
    const t = tf / tossLen;
    if (t >= 0.92) return;

    const side = fromRight ? 1 : -1;
    const alpha = Math.round(255 * (1 - t * 0.3));
    const logs = [
      { spread: 0,           arcH: 0.28, rot: 1.8, len: 0.16, thick: 1.2, color: [130, 80, 35] },
      { spread: -S * 0.03,   arcH: 0.32, rot: 1.2, len: 0.14, thick: 1.0, color: [110, 65, 30] },
      { spread: S * 0.035,   arcH: 0.24, rot: 2.3, len: 0.15, thick: 1.1, color: [140, 85, 40] },
      { spread: -S * 0.015,  arcH: 0.26, rot: 0.8, len: 0.12, thick: 0.9, color: [100, 58, 28] },
      { spread: S * 0.02,    arcH: 0.30, rot: 1.5, len: 0.13, thick: 0.85, color: [120, 72, 32] },
    ];

    for (const log of logs) {
      const pos = arcPos(t, fromRight, log.arcH, log.spread);
      const angle = t * Math.PI * log.rot * side;
      const logLen = S * log.len;
      const dx = Math.cos(angle) * logLen;
      const dy = Math.sin(angle) * logLen;
      c.drawLine(pos.x - dx, pos.y - dy, pos.x + dx, pos.y + dy,
        logThick * log.thick, ...log.color, alpha);
      // bark ring detail
      c.fillCircle(pos.x - dx * 0.5, pos.y - dy * 0.5, S * 0.012,
        log.color[0] - 25, log.color[1] - 15, log.color[2] - 8, Math.round(alpha * 0.6));
      // end grain circle
      c.fillCircle(pos.x + dx, pos.y + dy, logThick * log.thick * 0.45,
        log.color[0] + 20, log.color[1] + 15, log.color[2] + 10, Math.round(alpha * 0.8));
    }
  }

  // Draw a THICK stack of cash — visible thickness + wind-blown top bills
  function drawCashStack(tossStart, tossLen, fromRight) {
    const tf = frame - tossStart;
    if (tf < 0 || tf > tossLen) return;
    const t = tf / tossLen;
    if (t >= 0.92) return;

    const side = fromRight ? 1 : -1;
    const alpha = Math.round(255 * (1 - t * 0.25));
    const pos = arcPos(t, fromRight, 0.28, 0);
    const bx = pos.x, by = pos.y;

    // Stack rotation (slow tumble)
    const angle = t * Math.PI * 0.5 * side;
    const cos = Math.cos(angle), sin2 = Math.sin(angle);

    // Stack dimensions — THICC
    const stackW = S * 0.38;   // width of bill
    const stackH = S * 0.18;   // height of bill
    const stackD = S * 0.08;   // thickness (many bills stacked)

    const hw = stackW / 2, hh = stackH / 2;

    // ── Draw the thick stack body (side edge showing thickness) ──
    // Bottom face of stack
    const bot = [
      { x: bx + cos * hw - sin2 * hh + sin2 * stackD, y: by + sin2 * hw + cos * hh - cos * stackD },
      { x: bx - cos * hw - sin2 * hh + sin2 * stackD, y: by - sin2 * hw + cos * hh - cos * stackD },
      { x: bx - cos * hw + sin2 * hh + sin2 * stackD, y: by - sin2 * hw - cos * hh - cos * stackD },
      { x: bx + cos * hw + sin2 * hh + sin2 * stackD, y: by + sin2 * hw - cos * hh - cos * stackD },
    ];
    // Top face of stack
    const top = [
      { x: bx + cos * hw - sin2 * hh, y: by + sin2 * hw + cos * hh },
      { x: bx - cos * hw - sin2 * hh, y: by - sin2 * hw + cos * hh },
      { x: bx - cos * hw + sin2 * hh, y: by - sin2 * hw - cos * hh },
      { x: bx + cos * hw + sin2 * hh, y: by + sin2 * hw - cos * hh },
    ];

    // Side edge (shows stack thickness) — darker green
    c.fillTriangle(bot[0].x, bot[0].y, bot[1].x, bot[1].y, top[1].x, top[1].y, 45, 95, 40, alpha);
    c.fillTriangle(bot[0].x, bot[0].y, top[1].x, top[1].y, top[0].x, top[0].y, 45, 95, 40, alpha);
    // Bottom side edge
    c.fillTriangle(bot[1].x, bot[1].y, bot[2].x, bot[2].y, top[2].x, top[2].y, 35, 80, 32, alpha);
    c.fillTriangle(bot[1].x, bot[1].y, top[2].x, top[2].y, top[1].x, top[1].y, 35, 80, 32, alpha);

    // Stacked bill lines on the side edge (horizontal stripes)
    for (let li = 1; li < 8; li++) {
      const lt = li / 8;
      const lx1 = bot[0].x + (top[0].x - bot[0].x) * lt;
      const ly1 = bot[0].y + (top[0].y - bot[0].y) * lt;
      const lx2 = bot[1].x + (top[1].x - bot[1].x) * lt;
      const ly2 = bot[1].y + (top[1].y - bot[1].y) * lt;
      c.drawLine(lx1, ly1, lx2, ly2, S * 0.003, 60, 110, 55, Math.round(alpha * 0.5));
    }

    // ── Top face (the visible bill) ──
    c.fillTriangle(top[0].x, top[0].y, top[1].x, top[1].y, top[2].x, top[2].y, 75, 155, 65, alpha);
    c.fillTriangle(top[0].x, top[0].y, top[2].x, top[2].y, top[3].x, top[3].y, 75, 155, 65, alpha);

    // Border on top bill
    c.drawLine(top[0].x, top[0].y, top[1].x, top[1].y, S * 0.005, 40, 90, 35, Math.round(alpha * 0.8));
    c.drawLine(top[1].x, top[1].y, top[2].x, top[2].y, S * 0.005, 40, 90, 35, Math.round(alpha * 0.8));
    c.drawLine(top[2].x, top[2].y, top[3].x, top[3].y, S * 0.005, 40, 90, 35, Math.round(alpha * 0.8));
    c.drawLine(top[3].x, top[3].y, top[0].x, top[0].y, S * 0.005, 40, 90, 35, Math.round(alpha * 0.8));

    // Inner denomination rectangle on top bill
    const innerScale = 0.5;
    const ic = top.map(cr => ({ x: bx + (cr.x - bx) * innerScale, y: by + (cr.y - by) * innerScale }));
    c.fillTriangle(ic[0].x, ic[0].y, ic[1].x, ic[1].y, ic[2].x, ic[2].y, 100, 185, 90, Math.round(alpha * 0.7));
    c.fillTriangle(ic[0].x, ic[0].y, ic[2].x, ic[2].y, ic[3].x, ic[3].y, 100, 185, 90, Math.round(alpha * 0.7));

    // $ symbol on top bill
    const ds = S * 0.028;
    c.drawLine(bx, by - ds, bx, by + ds, S * 0.006, 40, 95, 35, Math.round(alpha * 0.9));
    c.fillCircle(bx - ds * 0.25, by - ds * 0.3, ds * 0.35, 40, 95, 35, Math.round(alpha * 0.7));
    c.fillCircle(bx + ds * 0.25, by + ds * 0.3, ds * 0.35, 40, 95, 35, Math.round(alpha * 0.7));

    // ── Bills peeling off in the wind ──
    const peelers = [
      { delay: 0, driftDir: -1, arcExtra: 0.06, rotMul: 2.5, flutterOff: 0 },
      { delay: 2, driftDir: 1,  arcExtra: 0.08, rotMul: 3.0, flutterOff: 1.5 },
      { delay: 1, driftDir: -1, arcExtra: 0.10, rotMul: 2.0, flutterOff: 3.0 },
    ];
    for (const p of peelers) {
      const pt = (tf - p.delay) / tossLen;
      if (pt < 0.05 || pt >= 0.9) continue;

      // Peel position: starts at stack, drifts away
      const peelDrift = pt * pt * S * 0.18 * p.driftDir * side;
      const peelUp = pt * S * p.arcExtra;
      const px = bx + peelDrift;
      const py = by - peelUp;

      // Flutter: perspective flip
      const windPhase = pt * Math.PI * 8 + p.flutterOff;
      const flip = Math.sin(windPhase);
      const billW = S * 0.30;
      const billH = S * 0.14 * (0.25 + Math.abs(flip) * 0.75);

      const pAngle = angle + pt * Math.PI * p.rotMul * side;
      const pCos = Math.cos(pAngle), pSin = Math.sin(pAngle);
      const phw = billW / 2, phh = billH / 2;

      const pc = [
        { x: px + pCos * phw - pSin * phh, y: py + pSin * phw + pCos * phh },
        { x: px - pCos * phw - pSin * phh, y: py - pSin * phw + pCos * phh },
        { x: px - pCos * phw + pSin * phh, y: py - pSin * phw - pCos * phh },
        { x: px + pCos * phw + pSin * phh, y: py + pSin * phw - pCos * phh },
      ];

      // Curl top edge
      const curl = Math.sin(windPhase + 1) * S * 0.02;
      pc[0].y += curl; pc[3].y += curl;

      const isFront = flip >= 0;
      const bR = isFront ? 70 : 50, bG = isFront ? 150 : 110, bB = isFront ? 60 : 45;
      const pAlpha = Math.round(alpha * (1 - pt * 0.4));

      c.fillTriangle(pc[0].x, pc[0].y, pc[1].x, pc[1].y, pc[2].x, pc[2].y, bR, bG, bB, pAlpha);
      c.fillTriangle(pc[0].x, pc[0].y, pc[2].x, pc[2].y, pc[3].x, pc[3].y, bR, bG, bB, pAlpha);

      // Border
      c.drawLine(pc[0].x, pc[0].y, pc[1].x, pc[1].y, S * 0.004, 35, 80, 30, Math.round(pAlpha * 0.6));
      c.drawLine(pc[2].x, pc[2].y, pc[3].x, pc[3].y, S * 0.004, 35, 80, 30, Math.round(pAlpha * 0.6));
    }

    // ── Paper band around the stack (white/cream) ──
    const bandW = stackW * 0.15;
    const bandOff = cos * bandW / 2;
    const bandMid = [
      { x: (top[0].x + top[1].x) / 2, y: (top[0].y + top[1].y) / 2 },
      { x: (top[3].x + top[2].x) / 2, y: (top[3].y + top[2].y) / 2 },
      { x: (bot[0].x + bot[1].x) / 2, y: (bot[0].y + bot[1].y) / 2 },
      { x: (bot[3].x + bot[2].x) / 2, y: (bot[3].y + bot[2].y) / 2 },
    ];
    // Band on top face
    c.drawLine(bandMid[0].x - bandOff, bandMid[0].y, bandMid[1].x - bandOff, bandMid[1].y, bandW * 0.8, 230, 220, 200, Math.round(alpha * 0.6));
    // Band on side face
    c.drawLine(bandMid[0].x - bandOff, bandMid[0].y, bandMid[2].x - bandOff, bandMid[2].y, bandW * 0.7, 210, 200, 180, Math.round(alpha * 0.5));
  }

  // Toss 1: stack of cash from RIGHT (frames 0-10)
  drawCashStack(0, 10, true);
  // Toss 2: stack of cash from LEFT (frames 16-26)
  drawCashStack(16, 10, false);
  // Toss 3: stack of cash from RIGHT (frames 32-42)
  drawCashStack(32, 10, true);

  return c;
}

// ─── Static icon (frame 2 for a nice flame pose) ────────────────────

function drawCampfireStatic(size, opts = {}) {
  return drawCampfire(size, 2, opts);
}

// ─── Money Stack Icon (for App Icon) ─────────────────────────────────

function drawMoneyIcon(size) {
  const c = new Canvas(size, size);
  const S = size;
  const cx = S / 2;
  const cy = S / 2;

  // ── Background: rounded square with gradient ──
  const pad = S * 0.06;
  const bgRad = S * 0.22;
  for (let y = pad; y < S - pad; y++) {
    const t = (y - pad) / (S - 2 * pad);
    // Dark green gradient
    const r = Math.round(20 + (35 - 20) * t);
    const g = Math.round(60 + (45 - 60) * t);
    const b = Math.round(30 + (25 - 30) * t);
    for (let x = pad; x < S - pad; x++) {
      let inside = true;
      const checks = [
        [pad + bgRad, pad + bgRad, x < pad + bgRad && y < pad + bgRad],
        [S - pad - bgRad, pad + bgRad, x > S - pad - bgRad && y < pad + bgRad],
        [pad + bgRad, S - pad - bgRad, x < pad + bgRad && y > S - pad - bgRad],
        [S - pad - bgRad, S - pad - bgRad, x > S - pad - bgRad && y > S - pad - bgRad],
      ];
      for (const [ccx, ccy, cond] of checks) {
        if (cond && (x - ccx) ** 2 + (y - ccy) ** 2 > bgRad * bgRad) { inside = false; break; }
      }
      if (inside) c.set(x, y, r, g, b, 255);
    }
  }

  // ── Stack of bills (3D effect) ──
  const stackW = S * 0.65;
  const stackH = S * 0.35;
  const stackD = S * 0.15; // thickness
  const stackCX = cx;
  const stackCY = cy + S * 0.05;

  // Shadow under stack
  c.fillEllipse(stackCX, stackCY + stackH / 2 + S * 0.08, stackW * 0.5, S * 0.06, 10, 30, 15, 80);

  // Draw multiple bills in the stack (bottom to top)
  const numBills = 8;
  for (let i = 0; i < numBills; i++) {
    const t = i / (numBills - 1);
    const offsetY = -t * stackD;
    const offsetX = (Math.random() - 0.5) * S * 0.01 * (numBills - i); // slight misalignment

    const bx = stackCX + offsetX;
    const by = stackCY + offsetY;

    // Bill colors: darker at bottom, brighter at top
    const baseR = 55 + t * 30;
    const baseG = 130 + t * 40;
    const baseB = 50 + t * 25;

    // Bill body
    const hw = stackW / 2;
    const hh = stackH / 2;

    // Main bill rectangle
    c.fillRect(bx - hw, by - hh, bx + hw, by + hh, baseR, baseG, baseB, 255);

    // Border
    c.drawLine(bx - hw, by - hh, bx + hw, by - hh, S * 0.008, baseR - 20, baseG - 30, baseB - 15, 255);
    c.drawLine(bx - hw, by + hh, bx + hw, by + hh, S * 0.008, baseR - 20, baseG - 30, baseB - 15, 255);
    c.drawLine(bx - hw, by - hh, bx - hw, by + hh, S * 0.008, baseR - 20, baseG - 30, baseB - 15, 255);
    c.drawLine(bx + hw, by - hh, bx + hw, by + hh, S * 0.008, baseR - 20, baseG - 30, baseB - 15, 255);
  }

  // ── Top bill details ──
  const topY = stackCY - stackD;
  const hw = stackW / 2;
  const hh = stackH / 2;

  // Lighter top bill
  c.fillRect(cx - hw, topY - hh, cx + hw, topY + hh, 85, 175, 75, 255);

  // Inner decorative border
  const inset = S * 0.04;
  c.drawLine(cx - hw + inset, topY - hh + inset, cx + hw - inset, topY - hh + inset, S * 0.006, 60, 130, 55, 200);
  c.drawLine(cx - hw + inset, topY + hh - inset, cx + hw - inset, topY + hh - inset, S * 0.006, 60, 130, 55, 200);
  c.drawLine(cx - hw + inset, topY - hh + inset, cx - hw + inset, topY + hh - inset, S * 0.006, 60, 130, 55, 200);
  c.drawLine(cx + hw - inset, topY - hh + inset, cx + hw - inset, topY + hh - inset, S * 0.006, 60, 130, 55, 200);

  // Inner rectangle (denomination area)
  const innerW = stackW * 0.45;
  const innerH = stackH * 0.55;
  c.fillRect(cx - innerW / 2, topY - innerH / 2, cx + innerW / 2, topY + innerH / 2, 100, 195, 90, 200);

  // ── Large $ symbol ──
  const dollarSize = S * 0.18;

  // Vertical line of $
  c.drawLine(cx, topY - dollarSize * 0.9, cx, topY + dollarSize * 0.9, S * 0.025, 40, 100, 40, 255);

  // Top curve of S
  c.fillEllipse(cx - dollarSize * 0.15, topY - dollarSize * 0.35, dollarSize * 0.4, dollarSize * 0.3, 40, 100, 40, 255);
  // Bottom curve of S
  c.fillEllipse(cx + dollarSize * 0.15, topY + dollarSize * 0.35, dollarSize * 0.4, dollarSize * 0.3, 40, 100, 40, 255);

  // Cut out the inner parts to make S shape
  c.fillEllipse(cx - dollarSize * 0.15, topY - dollarSize * 0.35, dollarSize * 0.2, dollarSize * 0.15, 100, 195, 90, 255);
  c.fillEllipse(cx + dollarSize * 0.15, topY + dollarSize * 0.35, dollarSize * 0.2, dollarSize * 0.15, 100, 195, 90, 255);

  // S middle connection
  c.drawLine(cx - dollarSize * 0.3, topY, cx + dollarSize * 0.3, topY, S * 0.03, 40, 100, 40, 255);

  // ── Corner "100" text indicators ──
  const cornerOff = S * 0.08;
  // Top-left 100
  c.fillCircle(cx - hw + cornerOff + S * 0.02, topY - hh + cornerOff, S * 0.025, 50, 110, 45, 180);
  c.fillCircle(cx - hw + cornerOff + S * 0.05, topY - hh + cornerOff, S * 0.02, 50, 110, 45, 180);
  c.fillCircle(cx - hw + cornerOff + S * 0.075, topY - hh + cornerOff, S * 0.02, 50, 110, 45, 180);
  // Bottom-right 100
  c.fillCircle(cx + hw - cornerOff - S * 0.02, topY + hh - cornerOff, S * 0.025, 50, 110, 45, 180);
  c.fillCircle(cx + hw - cornerOff - S * 0.05, topY + hh - cornerOff, S * 0.02, 50, 110, 45, 180);
  c.fillCircle(cx + hw - cornerOff - S * 0.075, topY + hh - cornerOff, S * 0.02, 50, 110, 45, 180);

  // ── Outer border of top bill ──
  c.drawLine(cx - hw, topY - hh, cx + hw, topY - hh, S * 0.012, 45, 105, 40, 255);
  c.drawLine(cx - hw, topY + hh, cx + hw, topY + hh, S * 0.012, 45, 105, 40, 255);
  c.drawLine(cx - hw, topY - hh, cx - hw, topY + hh, S * 0.012, 45, 105, 40, 255);
  c.drawLine(cx + hw, topY - hh, cx + hw, topY + hh, S * 0.012, 45, 105, 40, 255);

  // ── Shine/highlight on top ──
  for (let x = cx - hw + S * 0.02; x < cx + hw - S * 0.02; x++) {
    const shine = Math.max(0, 1 - Math.abs(x - (cx - hw * 0.3)) / (S * 0.15));
    if (shine > 0) {
      c.set(x, topY - hh + S * 0.015, 150, 220, 140, Math.round(shine * 60));
      c.set(x, topY - hh + S * 0.02, 150, 220, 140, Math.round(shine * 40));
    }
  }

  return c;
}

module.exports = { Canvas, buildPNG, drawCampfire, drawCampfireStatic, drawMoneyIcon, TOTAL_FRAMES };
