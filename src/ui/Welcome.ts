import { readFileSync } from 'node:fs';
import { cellWidth, plain, truncate, wrap } from './text.js';
import type { PixelColor, Theme } from './theme.js';
import type { ImageCrop, Raster, WelcomeImageView } from './terminal-image.js';
import { whaleSprite } from './whale-sprite.js';

// Standard quadrant blocks keep all four subpixels solid and work in common fonts.
const quadrants = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
const full: ImageCrop = { left: 0, top: 0, width: 1, height: 1 };

const spriteRenderCache = new WeakMap<Theme, Map<string, string[]>>();
function scaleSprite(source: Raster, width: number, height: number): Raster {
  if (width === source.width && height === source.height) return source;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(source.width - 1, Math.floor((x + .5) * source.width / width));
    const sy = Math.min(source.height - 1, Math.floor((y + .5) * source.height / height));
    const sourceAt = (sy * source.width + sx) * 4, targetAt = (y * width + x) * 4;
    data[targetAt] = source.data[sourceAt]!; data[targetAt + 1] = source.data[sourceAt + 1]!;
    data[targetAt + 2] = source.data[sourceAt + 2]!; data[targetAt + 3] = source.data[sourceAt + 3]!;
  }
  return { width, height, data };
}
interface SizedSprite { raster: Raster }
function chooseSprite(columns: number, rows: number): SizedSprite | undefined {
  if (columns < 16 || rows < 8) return undefined;
  const source = whaleSprite;
  const scale = Math.min(1, columns / source.width, (rows * 2) / source.height);
  const width = Math.max(1, Math.floor(source.width * scale)), height = Math.max(1, Math.floor(source.height * scale));
  return { raster: scaleSprite(source, width, height) };
}
export function welcomeNative(columns: number, rows: number,
  image: Pick<WelcomeImageView, 'aspect' | 'cellAspect'>): { crop: ImageCrop; width: number; height: number } | undefined {
  if (columns < 16 || rows < 8) return undefined;
  const ratio = image.aspect * image.cellAspect;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  const maxWidth = Math.max(1, Math.floor(columns * .8));
  const maxHeight = Math.max(1, Math.floor(rows * .8));
  const height = Math.max(1, Math.floor(Math.min(maxHeight, maxWidth / ratio)));
  const width = Math.max(1, Math.min(maxWidth, Math.round(height * ratio)));
  return { crop: full, width, height };
}

function spriteArt(columns: number, rows: number, theme: Theme): string[] | undefined {
  const chosen = chooseSprite(columns, rows);
  if (!chosen) return undefined;
  const { raster } = chosen;
  const cellRows = Math.ceil(raster.height / 2);
  const top = Math.max(0, Math.floor((rows - cellRows) / 2));
  const left = Math.max(0, Math.floor((columns - raster.width) / 2));
  const key = `${raster.width}x${raster.height}:${columns}x${rows}`;
  let cache = spriteRenderCache.get(theme);
  if (!cache) { cache = new Map(); spriteRenderCache.set(theme, cache); }
  let lines = cache.get(key);
  if (!lines) {
    const pixel = (x: number, y: number): PixelColor | undefined => {
      if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return undefined;
      const at = (y * raster.width + x) * 4;
      return raster.data[at + 3]! < 24 ? undefined : [raster.data[at]!, raster.data[at + 1]!, raster.data[at + 2]!];
    };
    const shades = ['█', '▓', '▒', '░'];
    lines = [];
    for (let row = 0; row < cellRows; row++) {
      let line = '';
      for (let x = 0; x < raster.width; x++) {
        const upper = pixel(x, row * 2), lower = pixel(x, row * 2 + 1);
        if (!upper && !lower) { line += ' '; continue; }
        if (theme.color === false) {
          const pixels = [upper, lower].filter((value): value is PixelColor => value !== undefined);
          const luminance = pixels.reduce((sum, value) => sum + .2126 * value[0] + .7152 * value[1] + .0722 * value[2], 0) / pixels.length;
          line += shades[luminance < 64 ? 0 : luminance < 128 ? 1 : luminance < 192 ? 2 : 3]!;
          continue;
        }
        if (!upper) { line += theme.pixel('▄', lower!); continue; }
        if (!lower) { line += theme.pixel('▀', upper); continue; }
        if (upper[0] === lower[0] && upper[1] === lower[1] && upper[2] === lower[2]) {
          line += theme.pixel('█', upper); continue;
        }
        line += theme.pixel('▀', upper, lower);
      }
      lines.push(line.trimEnd());
    }
    if (cache.size >= 10) cache.delete(cache.keys().next().value!);
    cache.set(key, lines);
  }
  return [...Array<string>(top).fill(''), ...lines.map(line => ' '.repeat(left) + line)];
}

/** Render a simple blue whale with the same silhouette in color and monochrome. */
export function WelcomeArt(columns: number, rows: number, theme: Theme): string[] {
  return spriteArt(columns, rows, theme) ?? [];
}

const lettering: Record<string, string[]> = {
  D: ['███ ', '█  █', '█  █', '█  █', '███ '],
  E: ['████', '█   ', '███ ', '█   ', '████'],
  P: ['███ ', '█  █', '███ ', '█   ', '█   '],
  S: [' ███', '█   ', ' ██ ', '   █', '███ '],
  K: ['█  █', '█ █ ', '██  ', '█ █ ', '█  █'],
  H: ['█  █', '█  █', '████', '█  █', '█  █'],
  A: [' ██ ', '█  █', '████', '█  █', '█  █'],
  R: ['███ ', '█  █', '███ ', '█ █ ', '█  █'],
  N: ['█  █', '██ █', '█ ██', '█  █', '█  █'],
  T: ['████', ' ██ ', ' ██ ', ' ██ ', ' ██ '],
  U: ['█  █', '█  █', '█  █', '█  █', ' ██ '],
  I: ['████', ' ██ ', ' ██ ', ' ██ ', '████'],
  ' ': ['    ', '    ', '    ', '    ', '    '],
};
let packageVersion = '';
try { packageVersion = String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version ?? ''); }
catch { /* Branding remains usable when package metadata is unavailable. */ }

/** Pack the same letter pixels into quadrant cells without dropping any strokes. */
function blockTitle(word: string, compact: boolean): string[] {
  const pixels = Array.from({ length: 5 }, (_, row) =>
    [...word].map(letter => lettering[letter]![row]).join(' '));
  if (!compact) return pixels;
  return Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: Math.ceil(pixels[0]!.length / 2) }, (_, column) => {
      let mask = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (pixels[row * 2 + Math.floor(bit / 2)]?.[column * 2 + bit % 2] === '█') mask |= 1 << bit;
      }
      return quadrants[mask]!;
    }).join(''));
}

/** Compose text and graphics together so native images never overlap the information. */
export function WelcomePanel(columns: number, rows: number, theme: Theme,
  info: { model: string; reasoning: string }, image?: WelcomeImageView): string[] {
  if (rows <= 0) return [];
  const inner = Math.max(1, Math.min(110, columns - 4));
  const left = Math.floor((columns - inner) / 2);
  const artWidth = columns >= 36 && rows >= 8 ? Math.max(16, Math.floor(inner * .4)) : 0;
  const gap = artWidth ? (columns >= 76 ? 4 : 2) : 0;
  const textWidth = inner - artWidth - gap;
  const blue = (text: string, light = false): string => theme.pixel(text, light ? [120, 153, 221] : [65, 105, 200]);
  const large = artWidth > 0 && textWidth >= 54 && rows >= 19;
  const compact = artWidth > 0 && textWidth >= 27 && rows >= 13;
  const title = large || compact ? ['DEEPSEEK', 'HARNESS TUI'].flatMap((word, index) =>
    [...(index ? [''] : []), ...blockTitle(word, !large).map(line => blue(line, index === 1))])
    : wrap('DeepSeek Harness TUI', textWidth).map(line => blue(theme.paint('bold', line)));
  const model = [plain(info.model).replace(/[\n\r]/g, ' '), plain(info.reasoning).replace(/[\n\r]/g, ' ')].filter(Boolean).join(' · ');
  const text = [...(packageVersion ? [theme.paint('muted', `v${packageVersion}`)] : []), ...title, '',
    ...(model ? [model] : []), theme.paint('muted', 'Explore the uncharted!'),
    theme.paint('muted', 'Tip: /model to choose a model')].map(line => truncate(line, textWidth));
  const artRows = artWidth ? Math.min(rows, 26) : 0;
  const native = image ? welcomeNative(artWidth, artRows, image) : undefined;
  const art = native ? [] : WelcomeArt(artWidth, artRows, theme);
  const height = Math.max(artRows, text.length);
  const top = Math.max(0, Math.floor((rows - height) / 2));
  const textTop = top + Math.max(0, Math.floor((height - text.length) / 2));
  const artTop = top + Math.max(0, Math.floor((height - artRows) / 2));
  if (native && image) {
    image.crop = native.crop;
    image.placement = { left: left + Math.floor((artWidth - native.width) / 2),
      top: artTop + Math.floor((artRows - native.height) / 2), width: native.width, height: native.height };
  }
  return Array.from({ length: rows }, (_, row) => {
    const picture = art[row - artTop] ?? '';
    const label = text[row - textTop] ?? '';
    return truncate(' '.repeat(left) + picture + ' '.repeat(Math.max(0, artWidth + gap - cellWidth(picture))) + label, columns);
  });
}
