/**
 * 生成插件市场图标 media/icon.png。
 *
 * 市场要求 `icon` 指向一个 PNG 且不小于 128×128，SVG 不被接受；
 * 项目里只有 media/dbviewer.svg（活动栏图标），所以这里补一个位图。
 *
 * 不引第三方图形库：PNG 就是「zlib 压缩的扫描行 + 几个固定 chunk」，
 * 手写一个够用的编码器即可，和 exporters.ts 手写 XLSX 是同一套取舍。
 * 形状用 SDF 判定 + 4 倍超采样，避免圆角与椭圆出现锯齿。
 *
 * 配色沿用项目视觉体系：底色竖向渐变 #2A2A32 → #121216，
 * 数据库圆柱用强调色 #11D080（描边 #098A56、顶盖高光 #4EECAC）。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SCALE = 4;
const SIZE = 256;
const S = SIZE * SCALE;

const BG_TOP = [42, 42, 50];
const BG_BOTTOM = [18, 18, 22];
const PLATE = [17, 208, 128];
const PLATE_DARK = [9, 138, 86];
const PLATE_LIGHT = [78, 236, 172];

const r = new Float32Array(S * S);
const g = new Float32Array(S * S);
const b = new Float32Array(S * S);
const a = new Float32Array(S * S);

const idx = (x, y) => y * S + x;

/** 圆角矩形：把矩形裁成「收缩后的矩形 + 四个角圆」。 */
function roundedRect(cx, cy, halfW, halfH, radius) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (halfW - radius), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cy) - (halfH - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) {
        const t = y / (S - 1);
        const i = idx(x, y);
        r[i] = BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t;
        g[i] = BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t;
        b[i] = BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t;
        a[i] = 1;
      }
    }
  }
}

/** 椭圆填充。 */
function ellipse(cx, cy, rx, ry, color) {
  for (let y = 0; y < S; y++) {
    const ny = (y + 0.5 - cy) / ry;
    if (ny * ny > 1) continue;
    const span = rx * Math.sqrt(1 - ny * ny);
    const from = Math.max(0, Math.ceil(cx - span - 0.5));
    const to = Math.min(S - 1, Math.floor(cx + span - 0.5));
    for (let x = from; x <= to; x++) {
      const i = idx(x, y);
      r[i] = color[0];
      g[i] = color[1];
      b[i] = color[2];
      a[i] = 1;
    }
  }
}

/** 矩形填充。 */
function rect(x0, y0, x1, y1, color) {
  for (let y = Math.max(0, Math.ceil(y0)); y <= Math.min(S - 1, Math.floor(y1)); y++) {
    for (let x = Math.max(0, Math.ceil(x0)); x <= Math.min(S - 1, Math.floor(x1)); x++) {
      const i = idx(x, y);
      r[i] = color[0];
      g[i] = color[1];
      b[i] = color[2];
      a[i] = 1;
    }
  }
}

/** 椭圆下半环（柱体的分层面），内侧挖空靠内外两个椭圆之差实现。 */
function lowerArc(cx, cy, rx, ry, thickness, color) {
  for (let y = 0; y < S; y++) {
    const py = y + 0.5;
    if (py < cy) continue;
    const ny = (py - cy) / ry;
    if (ny * ny > 1) continue;
    const outer = rx * Math.sqrt(1 - ny * ny);
    const innerNy = (py - cy) / (ry - thickness);
    const inner = innerNy * innerNy <= 1 ? (rx - thickness) * Math.sqrt(1 - innerNy * innerNy) : 0;
    for (let x = Math.max(0, Math.ceil(cx - outer - 0.5)); x <= Math.min(S - 1, Math.floor(cx + outer - 0.5)); x++) {
      const dist = Math.abs(x + 0.5 - cx);
      if (dist < inner) continue;
      const i = idx(x, y);
      r[i] = color[0];
      g[i] = color[1];
      b[i] = color[2];
      a[i] = 1;
    }
  }
}

// ---------------------------------------------------------------- 绘制

const c = S / 2;
roundedRect(c, c, c, c, S * 0.22);

const rx = S * 0.255;
const ry = S * 0.083;
const topCy = S * 0.325;
const botCy = S * 0.685;

ellipse(c, botCy, rx, ry, PLATE_DARK);
rect(c - rx, topCy, c + rx, botCy, PLATE);
lowerArc(c, topCy + (botCy - topCy) * 0.42, rx, ry, S * 0.019, PLATE_DARK);
lowerArc(c, topCy + (botCy - topCy) * 0.78, rx, ry, S * 0.019, PLATE_DARK);
ellipse(c, topCy, rx, ry, PLATE_LIGHT);

// ---------------------------------------------------------------- 降采样

const out = Buffer.alloc(SIZE * SIZE * 4);
const n = SCALE * SCALE;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const i = idx(x * SCALE + dx, y * SCALE + dy);
        // 非预乘累加：边缘像素按 alpha 加权，否则透明区会把圆角染黑
        sr += r[i] * a[i];
        sg += g[i] * a[i];
        sb += b[i] * a[i];
        sa += a[i];
      }
    }
    const o = (y * SIZE + x) * 4;
    if (sa > 0) {
      out[o] = Math.round(sr / sa);
      out[o + 1] = Math.round(sg / sa);
      out[o + 2] = Math.round(sb / sa);
    }
    out[o + 3] = Math.round((sa / n) * 255);
  }
}

// ---------------------------------------------------------------- PNG 编码

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i;
      for (let bit = 0; bit < 8; bit++) {
        v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      }
      crcTable[i] = v >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([head, data, tail]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // 颜色类型：RGBA
// 后面 3 字节为压缩/滤波/交错方式，全 0 即默认

// 每行前置一个滤波类型字节（0 = None），这是扫描行的规范要求
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = path.join(__dirname, '..', 'media', 'icon.png');
fs.writeFileSync(target, png);
console.log(`media/icon.png: ${SIZE}x${SIZE} 字节=${png.length}`);
