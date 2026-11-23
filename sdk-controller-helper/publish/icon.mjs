// A listing picture for an Add On that ships none: UA Universe shows the manifest's icon, and an
// Add On without one appears blank. Draws a 512 px PNG with no dependencies, in SDK Controller's
// look (slate tile, glowing rings), with a hue taken from the Add On's name so each looks its own.
import { crc32, deflateSync } from 'node:zlib';

const SIZE = 512;

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** A stable hue for a name. */
export function hueOf(name) {
  let h = 2166136261;
  for (const ch of String(name)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return (h >>> 0) % 360;
}

/** The PNG for an Add On called `name`. */
export function listingIcon(name) {
  const hue = hueOf(name);
  const accent = hsl(hue, 0.85, 0.62);
  const rings = 3 + (hueOf(`${name}#`) % 3);
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const c = SIZE / 2;
  const half = 240;
  const radius = 96;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Rounded tile, antialiased at its edge.
      const qx = Math.max(Math.abs(x + 0.5 - c) - (half - radius), 0);
      const qy = Math.max(Math.abs(y + 0.5 - c) - (half - radius), 0);
      const edge = Math.hypot(qx, qy) - radius;
      const alpha = Math.max(0, Math.min(1, 0.5 - edge));
      if (alpha <= 0) continue;
      // Ground: LUNA's slate, top to bottom.
      const t = (y - (c - half)) / (2 * half);
      let r = 0.235 + (0.106 - 0.235) * t;
      let g = 0.255 + (0.114 - 0.255) * t;
      let b = 0.271 + (0.122 - 0.271) * t;
      // Rings and a core, each a soft glow plus a crisp line.
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      let glow = Math.exp(-((d / 34) ** 2)) * 1.1;
      for (let i = 0; i < rings; i++) {
        const rr = 62 + i * (140 / rings);
        const width = 7 - i * 0.8;
        const dist = Math.abs(d - rr);
        glow += Math.max(0, 1 - Math.max(0, dist - width / 2)) * (0.95 - i * 0.12) + Math.exp(-((dist / 18) ** 2)) * 0.25;
      }
      glow = Math.min(1.4, glow);
      r = r + (accent[0] - r) * Math.min(1, glow) + Math.max(0, glow - 1) * 0.6;
      g = g + (accent[1] - g) * Math.min(1, glow) + Math.max(0, glow - 1) * 0.6;
      b = b + (accent[2] - b) * Math.min(1, glow) + Math.max(0, glow - 1) * 0.6;
      const i4 = (y * SIZE + x) * 4;
      out[i4] = Math.round(Math.min(1, r) * 255);
      out[i4 + 1] = Math.round(Math.min(1, g) * 255);
      out[i4 + 2] = Math.round(Math.min(1, b) * 255);
      out[i4 + 3] = Math.round(alpha * 255);
    }
  }
  return png(SIZE, SIZE, out);
}
