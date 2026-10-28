// 依存なしのアニメGIFエンコーダー。doc はパレット形式なのでそのままGIFの色表にできる。
import { hexToRgb } from "./pixel.js";

function lzw(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let cur = 0;
  let bits = 0;
  const write = (code) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(cur & 0xff);
      cur >>>= 8;
      bits -= 8;
    }
  };
  write(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const code = dict.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    write(prefix);
    if (next === 4096) {
      write(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  write(prefix);
  write(eoi);
  if (bits > 0) out.push(cur & 0xff);
  return out;
}

export function encodeGif(doc, scale = 1) {
  const w = doc.width * scale;
  const h = doc.height * scale;
  const transparent = doc.palette.length; // パレットの次の番号を透明色に使う
  let colorBits = 1;
  while (1 << colorBits < doc.palette.length + 1) colorBits++;
  const minCodeSize = Math.max(2, colorBits);
  const delay = Math.max(2, Math.round(100 / (doc.fps || 8))); // 1/100秒単位

  const bytes = [];
  const u16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const str = (s) => [...s].forEach((ch) => bytes.push(ch.charCodeAt(0)));

  str("GIF89a");
  u16(w);
  u16(h);
  bytes.push(0x80 | ((colorBits - 1) << 4) | (colorBits - 1), 0, 0);
  for (let i = 0; i < 1 << colorBits; i++) bytes.push(...(doc.palette[i] ? hexToRgb(doc.palette[i]) : [0, 0, 0]));
  // 無限ループ指定
  bytes.push(0x21, 0xff, 0x0b);
  str("NETSCAPE2.0");
  bytes.push(0x03, 0x01, 0, 0, 0);

  for (const frame of doc.frames) {
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | 1); // 次のコマの前に背景へ戻す + 透明色あり
    u16(delay);
    bytes.push(transparent, 0);
    bytes.push(0x2c);
    u16(0); u16(0); u16(w); u16(h);
    bytes.push(0);
    const indices = new Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = frame[Math.floor(y / scale) * doc.width + Math.floor(x / scale)];
        indices[y * w + x] = v < 0 ? transparent : v;
      }
    }
    bytes.push(minCodeSize);
    const data = lzw(indices, minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}
