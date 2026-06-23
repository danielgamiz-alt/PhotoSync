'use strict';

// Generates the tray/app icons from code (no binary assets to ship in git):
//   running.ico  - full-colour aperture (server running)
//   stopped.ico  - desaturated aperture (server stopped)
//   app.png      - app icon for notification toasts
//
// The artwork is the brand's rainbow aperture (same geometry as the SVG in
// desktop/public/index.html and docs/index.html): a dark rounded square with
// six colour wedges around a hexagonal hole. The tray keeps a status signal by
// rendering the wedges in full colour while running and desaturated when
// stopped, instead of relying on a single accent colour.
//
// The .ico files embed classic 32-bit BMP/DIB images (NOT PNG-in-ICO), which
// is what the Windows tray (Shell_NotifyIcon) reliably renders at 16/32 px.
//
// Run with: npm run build-icons

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// Artwork: the rainbow aperture. Geometry is defined in the 108x108 viewBox of
// the brand SVG and scaled to the requested icon size. Returns a top-down RGBA
// buffer. mode 'color' = full brand palette, 'gray' = desaturated (luma).
// ---------------------------------------------------------------------------
const APERTURE_VIEWBOX = 108;
const APERTURE_BG = [21, 22, 26]; // #15161a rounded-square backdrop
// Petal colours ordered by angular sector, starting at the top wedge and going
// clockwise: red, orange, yellow, green, cyan, violet (--ap-* tokens).
const APERTURE_PETALS = [
  [242, 71, 63], // #f2473f
  [247, 151, 46], // #f7972e
  [246, 199, 46], // #f6c72e
  [46, 195, 106], // #2ec36a
  [37, 196, 222], // #25c4de
  [124, 92, 240], // #7c5cf0
];

function drawIcon(size, mode) {
  const VB = APERTURE_VIEWBOX;
  const scale = VB / size; // viewBox units per output pixel
  const cx = 54;
  const cy = 54;
  const rOuter = 32; // outer circle of the wedges
  const cornerR = 24; // rounded-square corner radius (SVG rx)
  const apothem = 12 * Math.cos(Math.PI / 6); // inner hexagon hole (vertex r=12)

  function petalColor(idx) {
    const [r, g, b] = APERTURE_PETALS[idx];
    if (mode === 'gray') {
      const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      return [l, l, l];
    }
    return [r, g, b];
  }

  // Is a viewBox point inside the rounded square?
  function inRoundedSquare(vx, vy) {
    if (vx < 0 || vy < 0 || vx > VB || vy > VB) return false;
    const rx = Math.min(vx, VB - vx);
    const ry = Math.min(vy, VB - vy);
    if (rx >= cornerR || ry >= cornerR) return true;
    const ddx = cornerR - rx;
    const ddy = cornerR - ry;
    return ddx * ddx + ddy * ddy <= cornerR * cornerR;
  }

  // Radius of the hexagonal hole boundary at a given angle (deg).
  function holeRadius(angDeg) {
    let d = (((angDeg - 30) % 60) + 60) % 60; // distance from nearest edge normal
    if (d > 30) d -= 60;
    return apothem / Math.cos((d * Math.PI) / 180);
  }

  // Colour + alpha of a single viewBox sample point.
  function sample(vx, vy) {
    if (!inRoundedSquare(vx, vy)) return [0, 0, 0, 0];
    const dx = vx - cx;
    const dy = vy - cy;
    const r = Math.hypot(dx, dy);
    if (r <= rOuter) {
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang < 0) ang += 360;
      if (r >= holeRadius(ang)) {
        const idx = Math.floor((((ang - 240) % 360) + 360) % 360 / 60) % 6;
        const [r2, g2, b2] = petalColor(idx);
        return [r2, g2, b2, 255];
      }
    }
    return [APERTURE_BG[0], APERTURE_BG[1], APERTURE_BG[2], 255];
  }

  const SS = 4; // 4x4 supersampling for smooth edges
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const vx = (x + (sx + 0.5) / SS) * scale;
          const vy = (y + (sy + 0.5) / SS) * scale;
          const s = sample(vx, vy);
          R += s[0] * s[3];
          G += s[1] * s[3];
          B += s[2] * s[3];
          A += s[3];
        }
      }
      const i = (y * size + x) * 4;
      if (A === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(R / A); // alpha-weighted colour
        rgba[i + 1] = Math.round(G / A);
        rgba[i + 2] = Math.round(B / A);
        rgba[i + 3] = Math.round(A / (SS * SS));
      }
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// One ICO image as a 32-bit BMP/DIB (BITMAPINFOHEADER + BGRA + AND mask).
// ---------------------------------------------------------------------------
function bmpIconImage(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR image + AND mask)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB

  // XOR bitmap: 32bpp BGRA, bottom-up.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const dstY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (dstY * size + x) * 4;
      xor[d] = rgba[s + 2]; // B
      xor[d + 1] = rgba[s + 1]; // G
      xor[d + 2] = rgba[s]; // R
      xor[d + 3] = rgba[s + 3]; // A
    }
  }

  // AND mask: 1 bit/pixel, rows padded to 4 bytes. 1 = transparent.
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRowBytes * size, 0);
  for (let y = 0; y < size; y++) {
    const dstY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const a = rgba[(y * size + x) * 4 + 3];
      if (a === 0) and[dstY * maskRowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }

  return Buffer.concat([header, xor, and]);
}

function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + count * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size;
    e[1] = img.size >= 256 ? 0 : img.size;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function ico(mode) {
  // Include 16 and 32 px so the tray picks a crisp native size.
  return buildIco(
    [16, 32].map((size) => ({ size, data: bmpIconImage(size, drawIcon(size, mode)) }))
  );
}

// ---------------------------------------------------------------------------
// PNG (RGBA) for the notification toast icon.
// ---------------------------------------------------------------------------
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc(size * (1 + stride));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (1 + stride) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = __dirname;

fs.writeFileSync(path.join(out, 'running.ico'), ico('color'));
fs.writeFileSync(path.join(out, 'stopped.ico'), ico('gray'));
fs.writeFileSync(path.join(out, 'app.png'), encodePng(64, drawIcon(64, 'color')));

// Multi-size launcher/app icon (used as the PhotoServer.exe icon).
const appIco = buildIco([16, 32, 48].map((size) => ({ size, data: bmpIconImage(size, drawIcon(size, 'color')) })));
fs.writeFileSync(path.join(out, 'app.ico'), appIco);

// Favicon for the dashboard — this becomes the app-window/taskbar icon when
// the dashboard is opened as its own Edge "app mode" window.
const publicDir = path.join(out, '..', 'public');
fs.writeFileSync(path.join(publicDir, 'favicon.png'), encodePng(64, drawIcon(64, 'color')));
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), appIco);

console.log('Wrote running.ico, stopped.ico, app.ico, app.png + public/favicon.* ');
