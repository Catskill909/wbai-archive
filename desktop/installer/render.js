#!/usr/bin/env node
/**
 * Renders a station's installer artwork.
 *
 *     node installer/render.js wbai
 *
 * Output (paths are relative to src-tauri/, which is what tauri.conf.json and
 * the station profiles reference):
 *
 *     src-tauri/installer/<slug>/nsis-header.bmp    150x57,  24-bit BMP
 *     src-tauri/installer/<slug>/nsis-sidebar.bmp   164x314, 24-bit BMP
 *     src-tauri/installer/<slug>/dmg-background.png 1320x800 (2x of 660x400)
 *
 * Why this exists rather than a design file: the artwork is per station, and
 * the palette and the icon come from the app itself. Regenerating has to be one
 * command, or the fifth station's installer will quietly not match the first's.
 *
 * Two hard requirements it enforces, both learned from the tooling refusing
 * them: NSIS bitmaps must be **BMP with no alpha** (so the canvas colour is
 * baked in), and Tauri's icons must be **32-bit RGBA** (see docs/TAURI.md).
 *
 * Rendering is Chrome in headless mode, screenshotting a fixed-size page. It is
 * already on any machine doing this work, and it means the sources in
 * installer/src/ are editable HTML rather than binary.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, 'src');
const OUT_ROOT = path.join(__dirname, '..', 'src-tauri', 'installer');
const STATIONS = path.join(__dirname, '..', 'src-tauri', 'stations');
const ICONS = path.join(__dirname, '..', 'src-tauri', 'icons');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  process.env.CHROME_PATH,
].filter(Boolean).find((p) => fs.existsSync(p));

/**
 * Palette. Five of these six are sampled from the app icon's quadrants; the
 * canvas is --surface-0 from public/styles.css. Deliberately not a new brand:
 * the installer should look like the app it installs.
 */
const PALETTE = {
  CANVAS: '#14100f',
  INK: '#fafafa',
  INK_DIM: '#b7a99e',
  INK_FAINT: '#7d7168',
  ACCENT: '#2f8ab9', // the "I" quadrant — the one saturated colour in the mark
};

/**
 * `minInk` is the floor for "how much of this image isn't just canvas colour",
 * and it exists because a template that renders blank produces a perfectly
 * valid, perfectly empty BMP. Nothing downstream notices: the file size of a
 * 24-bit BMP is fixed by its dimensions, Tauri bundles it happily, and the
 * installer just looks unfinished. Asserting the *effect* rather than the
 * declaration is CLAUDE.md §3a; this is that rule applied to artwork.
 *
 * The thresholds are deliberately far below what each sheet actually measures,
 * so ordinary design changes don't trip them.
 */
const SHEETS = [
  { template: 'nsis-header.html', out: 'nsis-header', width: 150, height: 57, format: 'bmp', minInk: 0.06 },
  { template: 'nsis-sidebar.html', out: 'nsis-sidebar', width: 164, height: 314, format: 'bmp', minInk: 0.04 },
  { template: 'dmg-background.html', out: 'dmg-background', width: 1320, height: 800, format: 'png', minInk: 0.01 },
];

// ---------------------------------------------------------------- PNG reading

/** Minimal PNG decode: 8-bit, non-interlaced, colour type 2 or 6. */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  const idat = [];

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (depth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${path.basename(file)}: need 8-bit RGB or RGBA, got depth ${depth} type ${colorType}`);
  }

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Paeth included; Chrome emits it.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }

  return { width, height, channels, stride, pixels: out };
}

// ---------------------------------------------------------------- BMP writing

/**
 * 24-bit BI_RGB BMP: bottom-up rows, BGR order, each row padded to 4 bytes.
 *
 * No alpha, by necessity — NSIS bitmaps have no alpha channel, so anything
 * transparent in the source is composited onto `background` here instead of
 * arriving as garbage.
 */
function encodeBmp24(img, background) {
  const { width, height, channels, stride, pixels } = img;
  const bg = [
    parseInt(background.slice(1, 3), 16),
    parseInt(background.slice(3, 5), 16),
    parseInt(background.slice(5, 7), 16),
  ];

  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const fileSize = 54 + pixelBytes;

  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(fileSize, 2);
  header.writeUInt32LE(54, 10);       // pixel data offset
  header.writeUInt32LE(40, 14);       // BITMAPINFOHEADER size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);    // positive: bottom-up
  header.writeUInt16LE(1, 26);        // planes
  header.writeUInt16LE(24, 28);       // bits per pixel
  header.writeUInt32LE(0, 30);        // BI_RGB
  header.writeUInt32LE(pixelBytes, 34);

  const body = Buffer.alloc(pixelBytes);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * stride; // flip vertically
    const dst = y * rowSize;
    for (let x = 0; x < width; x++) {
      const i = src + x * channels;
      let r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (channels === 4) {
        const a = pixels[i + 3] / 255;
        r = Math.round(r * a + bg[0] * (1 - a));
        g = Math.round(g * a + bg[1] * (1 - a));
        b = Math.round(b * a + bg[2] * (1 - a));
      }
      body[dst + x * 3] = b;
      body[dst + x * 3 + 1] = g;
      body[dst + x * 3 + 2] = r;
    }
  }

  return Buffer.concat([header, body]);
}

/**
 * Fraction of pixels that differ perceptibly from the canvas colour — i.e. how
 * much artwork is actually on the sheet. A blank render scores ~0.
 */
function inkCoverage(img) {
  const { width, height, channels, stride, pixels } = img;
  const canvas = [
    parseInt(PALETTE.CANVAS.slice(1, 3), 16),
    parseInt(PALETTE.CANVAS.slice(3, 5), 16),
    parseInt(PALETTE.CANVAS.slice(5, 7), 16),
  ];

  let inked = 0;
  let total = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * stride + x * channels;
      const d = Math.abs(pixels[i] - canvas[0]) +
                Math.abs(pixels[i + 1] - canvas[1]) +
                Math.abs(pixels[i + 2] - canvas[2]);
      if (d > 12) inked++; // 12/765 ignores antialiasing against the canvas
      total++;
    }
  }
  return inked / total;
}

// ------------------------------------------------------------------- pipeline

function stationValues(slug) {
  const profilePath = path.join(STATIONS, `${slug}.json`);
  if (!fs.existsSync(profilePath)) {
    const available = fs.readdirSync(STATIONS).filter((f) => f.endsWith('.json')).join(', ');
    throw new Error(`No station profile ${slug}.json. Available: ${available || 'none'}`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

  // The station's own icon if it ships one, else the shared default.
  const iconList = (profile.bundle && profile.bundle.icon) || [];
  const png = iconList.find((p) => p.endsWith('.png') && !p.includes('32x32'));
  const iconPath = png
    ? path.join(__dirname, '..', 'src-tauri', png)
    : path.join(ICONS, '128x128@2x.png');

  return {
    ...PALETTE,
    NAME: profile.productName || 'Station Archive',
    FOOTER: (profile.bundle && profile.bundle.copyright) || '',
    ICON_DATA_URI: `data:image/png;base64,${fs.readFileSync(iconPath).toString('base64')}`,
    _iconPath: iconPath,
  };
}

function render(slug) {
  if (!CHROME) {
    throw new Error('No Chrome found. Install Google Chrome, or set CHROME_PATH.');
  }

  const values = stationValues(slug);
  const outDir = path.join(OUT_ROOT, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), `installer-${slug}-`));

  console.log(`${values.NAME} (${slug})`);
  console.log(`  icon: ${path.relative(path.join(__dirname, '..'), values._iconPath)}`);

  for (const sheet of SHEETS) {
    let html = fs.readFileSync(path.join(SRC, sheet.template), 'utf8');
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('_')) continue;
      html = html.split(`{{${key}}}`).join(value);
    }
    const left = html.match(/\{\{([A-Z_]+)\}\}/);
    if (left) throw new Error(`${sheet.template}: unfilled placeholder ${left[0]}`);

    const page = path.join(tmp, sheet.template);
    const shot = path.join(tmp, `${sheet.out}.png`);
    fs.writeFileSync(page, html);

    execFileSync(CHROME, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${sheet.width},${sheet.height}`,
      `--screenshot=${shot}`,
      `file://${page}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const img = decodePng(shot);
    if (img.width !== sheet.width || img.height !== sheet.height) {
      throw new Error(`${sheet.out}: rendered ${img.width}x${img.height}, wanted ${sheet.width}x${sheet.height}`);
    }

    const ink = inkCoverage(img);
    if (ink < sheet.minInk) {
      throw new Error(
        `${sheet.out}: only ${(ink * 100).toFixed(2)}% of pixels differ from the canvas — ` +
        `expected at least ${(sheet.minInk * 100).toFixed(1)}%. The page rendered nearly blank.\n` +
        `  The usual cause is a centered position:absolute element whose width comes from ` +
        `left/right or a percentage; give it an explicit pixel width. See the note in ` +
        `installer/src/${sheet.template}.`
      );
    }

    const ext = sheet.format === 'bmp' ? '.bmp' : '.png';
    const dest = path.join(outDir, sheet.out + ext);
    fs.writeFileSync(dest, sheet.format === 'bmp' ? encodeBmp24(img, PALETTE.CANVAS) : fs.readFileSync(shot));

    const size = (fs.statSync(dest).size / 1024).toFixed(1);
    console.log(
      `  ${path.basename(dest).padEnd(22)} ${String(img.width + 'x' + img.height).padEnd(9)}` +
      ` ${size.padStart(6)} KB   ink ${(ink * 100).toFixed(1)}%`
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  -> src-tauri/installer/${slug}/`);
}

const slug = process.argv[2];
if (!slug) {
  console.error('usage: node installer/render.js <station-slug>');
  process.exit(1);
}
render(slug);
