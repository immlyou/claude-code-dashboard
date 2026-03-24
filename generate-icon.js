#!/usr/bin/env node
/**
 * Generate all icon sizes for the macOS app.
 * Uses shared icon-draw.js — campfire with cash being thrown in.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildPNG, drawCampfire } = require('./icon-draw');

// Use frame 4: cash stack mid-flight from the right, clearly visible
console.log('Drawing campfire + cash icon at 1024x1024...');
const master = drawCampfire(1024, 4, { showBackground: true });

const iconsetDir = path.join(__dirname, 'build', 'icon.iconset');
fs.mkdirSync(iconsetDir, { recursive: true });

const sizes = [16, 32, 64, 128, 256, 512, 1024];
for (const s of sizes) {
  console.log(`  ${s}x${s}`);
  const scaled = s === 1024 ? master : master.scaleDown(s, s);
  fs.writeFileSync(path.join(iconsetDir, `icon_${s}x${s}.png`), buildPNG(s, s, scaled.buf));
  if (s <= 512) {
    const s2 = s * 2;
    const scaled2x = s2 === 1024 ? master : master.scaleDown(s2, s2);
    fs.writeFileSync(path.join(iconsetDir, `icon_${s}x${s}@2x.png`), buildPNG(s2, s2, scaled2x.buf));
  }
}

fs.writeFileSync(path.join(__dirname, 'icon-preview.png'), buildPNG(1024, 1024, master.buf));
console.log('✅ Done! Run: iconutil -c icns build/icon.iconset -o build/icon.icns');
