import { readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Raster { width: number; height: number; data: Uint8Array }
export interface ImagePlacement { left: number; top: number; width: number; height: number }
export interface ImageCrop { left: number; top: number; width: number; height: number }
export interface WelcomeImageView { aspect: number; cellAspect: number; crop?: ImageCrop; placement?: ImagePlacement }

let portrait: Raster | undefined;
let portraitLoaded = false;
/** Decode the bundled 8-bit PNG asset, without a native image dependency. */
export function decodePng(bytes: Buffer): Raster {
  if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Invalid PNG');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), kind = bytes[25];
  const channels = kind === 6 ? 4 : kind === 2 ? 3 : kind === 4 ? 2 : kind === 0 || kind === 3 ? 1 : 0;
  if (!width || !height || width > 4096 || height > 4096 || bytes[24] !== 8 || bytes[28] !== 0 || !channels) {
    throw new Error('Unsupported PNG asset');
  }
  const chunks: Buffer[] = [];
  let palette: Buffer | undefined, alpha: Buffer | undefined;
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8);
    if (at + 12 + length > bytes.length) throw new Error('Truncated PNG');
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') chunks.push(data);
    if (type === 'PLTE') palette = data;
    if (type === 'tRNS') alpha = data;
    at += 12 + length;
    if (type === 'IEND') break;
  }
  const stride = width * channels, expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
  if (raw.length !== expected) throw new Error('Invalid PNG scanlines');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    if (filter > 4) throw new Error('Invalid PNG filter');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels]! : 0;
      const up = y ? pixels[at - stride]! : 0;
      const corner = y && x >= channels ? pixels[at - stride - channels]! : 0;
      const p = left + up - corner;
      const a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2)
        : filter === 4 ? a <= b && a <= c ? left : b <= c ? up : corner : 0;
      pixels[at] = raw[y * (stride + 1) + x + 1]! + predictor;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * channels, out = pixel * 4, value = pixels[at]!;
    if (kind === 3) {
      if (!palette || value * 3 + 2 >= palette.length) throw new Error('Invalid PNG palette');
      data.set(palette.subarray(value * 3, value * 3 + 3), out); data[out + 3] = alpha?.[value] ?? 255;
    } else {
      data[out] = value; data[out + 1] = channels >= 3 ? pixels[at + 1]! : value;
      data[out + 2] = channels >= 3 ? pixels[at + 2]! : value;
      const transparent = alpha && (kind === 0 ? value === alpha.readUInt16BE(0)
        : kind === 2 && value === alpha.readUInt16BE(0) && data[out + 1] === alpha.readUInt16BE(2) && data[out + 2] === alpha.readUInt16BE(4));
      data[out + 3] = kind === 6 ? pixels[at + 3]! : kind === 4 ? pixels[at + 1]! : transparent ? 0 : 255;
    }
  }
  return { width, height, data };
}
/** One decode per process; unavailable artwork leaves the character fallback intact. */
export function characterPortrait(): Raster | undefined {
  if (!portraitLoaded) {
    portraitLoaded = true;
    try { portrait = decodePng(readFileSync(new URL('../../assets/whale-pro.png', import.meta.url))); }
    catch { /* The pixel whale remains available when the PNG is missing. */ }
  }
  return portrait;
}

export async function loadPortrait(): Promise<Raster | undefined> {
  return characterPortrait();
}

/** Crop a normalized source rectangle without resampling; native display handles the fit. */
export function cropRaster(source: Raster, crop: ImageCrop): Raster {
  if (crop.left <= 0 && crop.top <= 0 && crop.width >= 1 && crop.height >= 1) return source;
  const left = Math.max(0, Math.min(source.width - 1, Math.round(crop.left * source.width)));
  const top = Math.max(0, Math.min(source.height - 1, Math.round(crop.top * source.height)));
  const width = Math.max(1, Math.min(source.width - left, Math.round(crop.width * source.width)));
  const height = Math.max(1, Math.min(source.height - top, Math.round(crop.height * source.height)));
  const data = new Uint8Array(width * height * 4), stride = source.width * 4;
  for (let y = 0; y < height; y++) {
    const start = (top + y) * stride + left * 4;
    data.set(source.data.subarray(start, start + width * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Lossless RGBA PNG, with row filters chosen before compression. */
export function encodePng(source: Raster): Buffer {
  const { width, height, data } = source, stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height), candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    let best = Infinity;
    for (let filter = 0; filter <= 4; filter++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const at = y * stride + x;
        const left = x >= 4 ? data[at - 4]! : 0, up = y ? data[at - stride]! : 0;
        const corner = y && x >= 4 ? data[at - stride - 4]! : 0;
        const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
        const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2)
          : filter === 4 ? a <= b && a <= c ? left : b <= c ? up : corner : 0;
        const delta = (data[at]! - predictor) & 255;
        candidate[x] = delta; score += Math.min(delta, 256 - delta);
      }
      if (score < best) {
        best = score; scanlines[y * (stride + 1)] = filter;
        candidate.copy(scanlines, y * (stride + 1) + 1);
      }
    }
  }
  const chunk = (name: string, payload: Buffer): Buffer => {
    const result = Buffer.alloc(payload.length + 12);
    result.writeUInt32BE(payload.length); result.write(name, 4); payload.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, payload.length + 8)), payload.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

export interface KittyImage { width: number; height: number; base64: string }
const kittyImages = new WeakMap<Raster, Map<string, KittyImage>>();

/** Bound upload resolution to the physical display box; share encoding across mounts. */
export function prepareKittyImage(source: Raster, boxWidth: number, boxHeight: number): KittyImage {
  const scale = Math.min(1, boxWidth / source.width, boxHeight / source.height);
  const width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale));
  const key = `${width}x${height}`;
  let sizes = kittyImages.get(source);
  if (!sizes) { sizes = new Map(); kittyImages.set(source, sizes); }
  const cached = sizes.get(key);
  if (cached) { sizes.delete(key); sizes.set(key, cached); return cached; }
  const fitted = width === source.width && height === source.height ? source : resizeRaster(source, width, height);
  const image = { width, height, base64: encodePng(fitted).toString('base64') };
  if (sizes.size >= 4) sizes.delete(sizes.keys().next().value!);
  sizes.set(key, image);
  return image;
}

/** PNG transport is distinct from Kitty's optional compressed raw-RGBA transport. */
export function kittyUpload(source: KittyImage, id: number): string {
  const data = source.base64;
  let result = '';
  for (let start = 0; start < data.length; start += 4096) {
    const more = start + 4096 < data.length ? 1 : 0;
    const header = start === 0 ? `a=t,t=d,f=100,i=${id},q=1,` : '';
    result += `\x1b_G${header}m=${more};${data.slice(start, start + 4096)}\x1b\\`;
  }
  return result;
}

/** Premultiplied-alpha bilinear resize keeps hidden RGB out of visible edges. */
export function resizeRaster(source: Raster, width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.max(0, (x + .5) * source.width / width - .5);
    const sy = Math.max(0, (y + .5) * source.height / height - .5);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const x1 = Math.min(source.width - 1, x0 + 1), y1 = Math.min(source.height - 1, y0 + 1);
    const a = (y0 * source.width + x0) * 4, b = (y0 * source.width + x1) * 4;
    const c = (y1 * source.width + x0) * 4, d = (y1 * source.width + x1) * 4;
    const wa = (1 - fx) * (1 - fy) * source.data[a + 3]!;
    const wb = fx * (1 - fy) * source.data[b + 3]!;
    const wc = (1 - fx) * fy * source.data[c + 3]!;
    const wd = fx * fy * source.data[d + 3]!;
    const alpha = wa + wb + wc + wd, out = (y * width + x) * 4;
    data[out + 3] = Math.round(alpha);
    if (data[out + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel++) {
      data[out + channel] = Math.round((source.data[a + channel]! * wa + source.data[b + channel]! * wb
        + source.data[c + channel]! * wc + source.data[d + channel]! * wd) / alpha);
    }
  }
  return { width, height, data };
}

/** A shared adaptive palette keeps the mascot's blue gradients and skin tones. */
export function encodeSixel(source: Raster): string {
  const { data, width, height } = source;
  const histogram = new Map<number, { count: number; r: number; g: number; b: number }>();
  const keyAt = (at: number): number => ((data[at]! >> 3) << 10) | ((data[at + 1]! >> 3) << 5) | (data[at + 2]! >> 3);
  for (let at = 0; at < data.length; at += 4) {
    if (data[at + 3]! < 128) continue;
    const key = keyAt(at), entry = histogram.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    entry.count++; entry.r += data[at]!; entry.g += data[at + 1]!; entry.b += data[at + 2]!;
    histogram.set(key, entry);
  }
  const entries = [...histogram.entries()].sort((a, b) => b[1].count - a[1].count);
  const palette = entries.slice(0, 256).map(([, p]) => [p.r / p.count, p.g / p.count, p.b / p.count]);
  const indices = new Map<number, number>();
  for (const [key, p] of entries) {
    let best = 0, error = Infinity;
    palette.forEach((color, index) => {
      const delta = (p.r / p.count - color[0]!) ** 2 + (p.g / p.count - color[1]!) ** 2 + (p.b / p.count - color[2]!) ** 2;
      if (delta < error) { best = index; error = delta; }
    });
    indices.set(key, best);
  }
  let result = `\x1bP0;1;0q"1;1;${width};${height}`;
  palette.forEach((color, index) => { result += `#${index};2;${color.map(value => Math.round(value * 100 / 255)).join(';')}`; });
  for (let band = 0; band < height; band += 6) {
    const masks = new Map<number, Uint8Array>();
    for (let y = band; y < Math.min(height, band + 6); y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (data[at + 3]! < 128) continue;
      const index = indices.get(keyAt(at))!;
      let mask = masks.get(index);
      if (!mask) { mask = new Uint8Array(width); masks.set(index, mask); }
      mask[x] = mask[x]! | (1 << (y - band));
    }
    for (const [index, mask] of masks) {
      let end = width;
      while (end && mask[end - 1] === 0) end--;
      result += `#${index}`;
      for (let x = 0; x < end;) {
        let next = x + 1;
        while (next < end && mask[next] === mask[x]) next++;
        const char = String.fromCharCode(63 + mask[x]!);
        result += next - x > 3 ? `!${next - x}${char}` : char.repeat(next - x);
        x = next;
      }
      result += '$';
    }
    if (band + 6 < height) result += '-';
  }
  return result + '\x1b\\';
}
