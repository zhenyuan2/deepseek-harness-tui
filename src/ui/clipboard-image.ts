/** Read raster images from the OS clipboard without routing them through terminal paste. */
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
export interface PendingImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
  /** Display name for file-backed images; clipboard images stay unnamed. */
  name?: string;
  /** UTF-16 offset in submitted text; omitted when the image follows all text. */
  textOffset?: number;
}

/** Stay within the Harness attachment defaults while bounding a mistaken read. */
export const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;
export interface ImageLimits { maxImageBytes: number; maxImagesPerMessage: number; maxMessageImageBytes: number }
/** Compatibility fallback when an older Harness does not expose its limits. */
export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = {
  maxImageBytes: MAX_IMAGE_BYTES, maxImagesPerMessage: MAX_IMAGES, maxMessageImageBytes: MAX_MESSAGE_IMAGE_BYTES,
};
const MAX_COMMAND_OUTPUT = 64 * 1024 * 1024;

export class ClipboardImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClipboardImageError';
  }
}

export interface CommandResult { code: number; stdout: Buffer; stderr: string; missing?: boolean }
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number; maxOutputBytes?: number }) => Promise<CommandResult>;

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
  limits?: ImageLimits;
}

/** Spawn a fixed command without a shell and bound both time and output. */
export function runCommand(command: string, args: readonly string[], options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise(resolve => {
    let settled = false; let bytes = 0; let stderr = '';
    const stdout: Buffer[] = [];
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout: Buffer.alloc(0), stderr: 'timed out' });
    }, timeoutMs);
    timer.unref();
    child.once('error', error => finish({ code: -1, stdout: Buffer.alloc(0), stderr: error.message,
      missing: (error as NodeJS.ErrnoException).code === 'ENOENT' }));
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? MAX_COMMAND_OUTPUT)) {
        child.kill('SIGKILL');
        finish({ code: -1, stdout: Buffer.alloc(0), stderr: 'clipboard output is too large' });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8', 0, Math.min(chunk.length, 4_096 - stderr.length));
    });
    child.once('close', code => finish({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr }));
  });
}

/** Identify the four formats the Harness attachment path accepts. */
export function imageMediaType(data: Uint8Array): ImageMediaType | undefined {
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...data.subarray(offset, offset + length));
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  return undefined;
}

/** AppleScript prints binary clipboard data as «data PNGf<hex>». */
export function parseAppleScriptImage(output: string, kind: string): Buffer | undefined {
  const match = output.match(new RegExp(`«data ${kind}([0-9A-Fa-f]+)»`));
  if (!match?.[1]) return undefined;
  return Buffer.from(match[1], 'hex');
}

/** PowerShell prints canonical base64; ignore banners, prompts, or CLIXML noise. */
export function parseBase64Image(output: string): Buffer | undefined {
  const text = output.replace(/\s+/g, '');
  if (!text || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  return Buffer.from(text, 'base64');
}

function byteLabel(bytes: number): string { return bytes >= 1024 * 1024 ? `${bytes / 1024 / 1024} MiB` : `${bytes} bytes`; }

function checkSize(bytes: number, source: string, limits: ImageLimits): void {
  if (bytes > limits.maxImageBytes) throw new ClipboardImageError(`${source} image is larger than ${byteLabel(limits.maxImageBytes)}.`);
}

export function validateImages(images: readonly PendingImage[], limits: ImageLimits = DEFAULT_IMAGE_LIMITS): void {
  if (images.length > limits.maxImagesPerMessage) throw new ClipboardImageError(`At most ${limits.maxImagesPerMessage} images per message.`);
  let total = 0;
  for (const image of images) {
    const data = image.data;
    const source = image.name ?? 'Clipboard';
    if (!data.byteLength) throw new ClipboardImageError(`${source} returned no image data.`);
    checkSize(data.byteLength, source, limits);
    total += data.byteLength;
  }
  if (total > limits.maxMessageImageBytes) throw new ClipboardImageError(`Attached images exceed ${byteLabel(limits.maxMessageImageBytes)}.`);
}

async function appleScriptImage(run: CommandRunner, kind: string): Promise<Buffer | undefined> {
  const result = await run('osascript', ['-e', `the clipboard as «class ${kind}»`], { timeoutMs: 4_000 });
  if (result.code !== 0 || result.missing) return undefined;
  return parseAppleScriptImage(result.stdout.toString('utf8'), kind);
}

async function macClipboard(run: CommandRunner, limits: ImageLimits): Promise<Uint8Array | undefined> {
  let available = false;
  for (const kind of ['PNGf', 'JPEG', 'GIFf', 'WEBP']) {
    const result = await run('osascript', ['-e', `the clipboard as «class ${kind}»`], { timeoutMs: 4_000 });
    if (!result.missing) available = true;
    if (result.code !== 0) continue;
    const data = parseAppleScriptImage(result.stdout.toString('utf8'), kind);
    if (data?.length) return data;
  }
  // Copy Image in several macOS apps exposes TIFF only. sips is part of macOS
  // and keeps the Harness format set unchanged by converting it to PNG.
  const tiff = await appleScriptImage(run, 'TIFF');
  if (tiff?.length) {
    checkSize(tiff.byteLength, 'Clipboard TIFF', limits);
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), 'dsh-clipboard-'));
      const source = join(directory, 'image.tiff'), target = join(directory, 'image.png');
      await writeFile(source, tiff);
      const result = await run('sips', ['-s', 'format', 'png', source, '--out', target], { timeoutMs: 8_000 });
      if (result.missing) throw new ClipboardImageError('sips is unavailable, so the TIFF clipboard image cannot be converted to PNG.');
      if (result.code !== 0) {
        throw new ClipboardImageError(`Could not convert the TIFF clipboard image to PNG${result.stderr.trim() ? `: ${result.stderr.trim()}` : '.'}`);
      }
      let data: Buffer;
      try { data = await readFile(target); }
      catch (error) { throw new ClipboardImageError(`Could not read the PNG produced by TIFF conversion: ${error instanceof Error ? error.message : String(error)}`); }
      if (imageMediaType(data) !== 'image/png') throw new ClipboardImageError('TIFF conversion produced an invalid PNG image.');
      return data;
    } catch (error) {
      if (error instanceof ClipboardImageError) throw error;
      throw new ClipboardImageError(`Could not prepare the TIFF clipboard image for conversion: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!available) throw new ClipboardImageError('osascript is unavailable, so the macOS clipboard cannot be read.');
  return undefined;
}

const windowsScript = [
  '$null = Add-Type -AssemblyName System.Windows.Forms',
  '$null = Add-Type -AssemblyName System.Drawing',
  '$img = [System.Windows.Forms.Clipboard]::GetImage()',
  'if ($null -eq $img) { exit 1 }',
  '$ms = New-Object System.IO.MemoryStream',
  '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))',
].join('; ');

async function windowsClipboard(run: CommandRunner, required: boolean): Promise<Uint8Array | undefined> {
  let available = false;
  for (const command of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
    const result = await run(command, ['-NoProfile', '-NonInteractive', '-STA', '-Command', windowsScript], { timeoutMs: 8_000 });
    if (result.missing) continue;
    available = true;
    if (result.code !== 0) continue;
    const data = parseBase64Image(result.stdout.toString('ascii'));
    if (data?.length) return data;
  }
  if (!available && required) throw new ClipboardImageError('PowerShell is unavailable, so the Windows clipboard cannot be read.');
  return undefined;
}

async function linuxClipboard(run: CommandRunner, env: NodeJS.ProcessEnv): Promise<Uint8Array | undefined> {
  const wsl = !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY && !wsl) {
    throw new ClipboardImageError('No graphical clipboard is available; paste an image file path instead.');
  }
  const attempts: [string, string[]][] = [];
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    attempts.push(['wl-paste', ['--no-newline', '--type', type]]);
    attempts.push(['xclip', ['-selection', 'clipboard', '-t', type, '-o']]);
  }
  let available = false;
  for (const [command, args] of attempts) {
    const result = await run(command, args, { timeoutMs: 1_500 });
    if (!result.missing) available = true;
    if (result.code !== 0 || !result.stdout.length) continue;
    if (imageMediaType(result.stdout)) return result.stdout;
  }
  if (wsl) {
    const data = await windowsClipboard(run, false);
    if (data) return data;
  }
  if (!available) throw new ClipboardImageError('No clipboard image tool is available; install wl-clipboard or xclip.');
  return undefined;
}

/**
 * Read one image from the local terminal clipboard.
 * @returns the encoded image, or undefined when the clipboard holds no image.
 * @throws ClipboardImageError when the platform clipboard cannot be read or contains an unsupported image.
 */
export async function readClipboardImage(options: ClipboardOptions = {}): Promise<PendingImage | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const limits = options.limits ?? DEFAULT_IMAGE_LIMITS;
  // AppleScript returns hex and PowerShell returns base64. The transport cap
  // must also accommodate deployments that permit larger source images.
  const run: CommandRunner = options.run ?? ((command, args, settings) => runCommand(command, args, {
    ...settings, maxOutputBytes: Math.max(MAX_COMMAND_OUTPUT, limits.maxImageBytes * 2 + 1024),
  }));
  if (env.SSH_CONNECTION || env.SSH_TTY) {
    throw new ClipboardImageError('The clipboard belongs to the local terminal; over SSH, paste an image file path instead.');
  }
  let data: Uint8Array | undefined;
  try {
    data = platform === 'darwin' ? await macClipboard(run, limits)
      : platform === 'win32' ? await windowsClipboard(run, true)
        : await linuxClipboard(run, env);
  } catch (error) {
    if (error instanceof ClipboardImageError) throw error;
    throw new ClipboardImageError(error instanceof Error ? error.message : String(error));
  }
  if (!data) return undefined;
  const mediaType = imageMediaType(data);
  if (!mediaType) throw new ClipboardImageError('The clipboard does not contain a supported image (PNG, JPEG, WebP, or GIF).');
  validateImages([{ data, mediaType }], limits);
  return { data, mediaType };
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Candidate spellings of one pasted path: quoted, shell-escaped, file URL, or ~-relative. */
function pathCandidates(value: string, platform: NodeJS.Platform): string[] {
  const candidates = new Set<string>();
  const add = (candidate: string): void => { if (candidate) candidates.add(candidate); };
  add(value);
  let unquoted = value;
  if (unquoted.length >= 2 && ((unquoted.startsWith('"') && unquoted.endsWith('"'))
    || (unquoted.startsWith("'") && unquoted.endsWith("'")))) unquoted = unquoted.slice(1, -1);
  add(unquoted);
  const windowsPath = /^[A-Za-z]:[\\/]/.test(unquoted) || unquoted.startsWith('\\\\');
  if (platform !== 'win32' && !windowsPath) add(unquoted.replace(/\\([\\\s'"()&;|<>*?[\]{}!$`~])/g, '$1'));
  if (/^file:\/\//i.test(unquoted)) {
    try { add(fileURLToPath(unquoted)); } catch { /* A malformed URL is ordinary text. */ }
  }
  for (const candidate of [...candidates]) {
    if (candidate.startsWith('~')) add(join(homedir(), candidate.slice(1)));
  }
  return [...candidates];
}

/** A pasted path without an extension is still an image if its bytes say so. */
function looksLikePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\') || value.includes('/') || value.includes('\\');
}

/** Split quoted/escaped path lists as data; never expand or execute shell syntax. */
function pathWords(line: string, platform: NodeJS.Platform): string[] | undefined {
  const words: string[] = [];
  let word = '', started = false;
  let quote: string | undefined;
  let windowsWord = platform === 'win32';
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (!quote && /\s/u.test(char)) {
      if (started) { words.push(word); word = ''; started = false; windowsWord = platform === 'win32'; }
      continue;
    }
    started = true;
    if (char === quote) { quote = undefined; continue; }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    if (/^[A-Za-z]:/.test(word) || (!word && line.slice(i).startsWith('\\\\'))) windowsWord = true;
    if (char === '\\' && quote !== "'" && !windowsWord) {
      const next = line[i + 1];
      if (next === undefined) return undefined;
      // Within double quotes the shell preserves backslashes before ordinary
      // characters; outside quotes one backslash escapes the next character.
      if (!quote || /["\\$`]/.test(next)) { word += next; i++; continue; }
    }
    word += char;
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

interface PastedPathLine { literal: string[]; words?: string[][] }
function pastedPathLines(text: string, platform: NodeJS.Platform): PastedPathLine[] | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const candidates = (value: string): string[] => pathCandidates(value, platform).filter(candidate => {
    const extension = extname(candidate).toLowerCase();
    return IMAGE_EXTENSIONS.has(extension) || (!extension && looksLikePath(candidate));
  });
  const paths: PastedPathLine[] = [];
  for (const line of lines) {
    const literal = candidates(line);
    const words = pathWords(line, platform);
    if (words?.length === 1) {
      for (const candidate of candidates(words[0]!)) if (!literal.includes(candidate)) literal.push(candidate);
    }
    const split = words && words.length > 1 ? words.map(candidates) : undefined;
    const multiple = split?.every(word => word.length > 0) ? split : undefined;
    if (!literal.length && !multiple) return undefined;
    paths.push({ literal, words: multiple });
  }
  return paths;
}

/**
 * Recognize a bracketed paste that is entirely one or more image file paths.
 * A dropped file and a copied path look identical to the terminal, so this is
 * the only way drag-and-drop can become an attachment instead of text.
 * @returns candidate spellings per file, or undefined when the paste is ordinary text.
 */
export function imagePathCandidatesFromPaste(text: string, platform: NodeJS.Platform = process.platform): string[][] | undefined {
  return pastedPathLines(text, platform)?.flatMap(line => line.words ?? [line.literal]);
}

/** Read only the signature bytes; a pasted text file is never loaded in full. */
async function sniffImageMediaType(path: string): Promise<ImageMediaType | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'r');
    const header = Buffer.alloc(12);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return imageMediaType(header.subarray(0, bytesRead));
  } catch { return undefined; }
  finally { await file?.close(); }
}

interface ImageFile { path: string; size: number }
async function resolveImageFile(candidates: readonly string[], signal?: AbortSignal): Promise<ImageFile | undefined> {
  for (const path of candidates) {
    signal?.throwIfAborted();
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      size = info.size;
    } catch { signal?.throwIfAborted(); continue; }
    signal?.throwIfAborted();
    const sniffed = await sniffImageMediaType(path);
    signal?.throwIfAborted();
    if (sniffed) return { path, size };
  }
  return undefined;
}

/**
 * Read image files named by a dropped/copied path list. A missing or non-image
 * path is ordinary text; a real image that is too large is a user-visible error.
 */
export async function imagesFromPastedText(text: string, platform: NodeJS.Platform = process.platform,
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS, signal?: AbortSignal,
  imagesConfirmed?: () => void): Promise<PendingImage[] | undefined> {
  signal?.throwIfAborted();
  const lines = pastedPathLines(text, platform);
  if (!lines) return undefined;
  // Classify the entire paste before applying attachment limits. A long list
  // containing a missing or non-image path is still ordinary text.
  const files: ImageFile[] = [];
  for (const line of lines) {
    signal?.throwIfAborted();
    // Prefer a real literal filename, including unquoted spaces. Only fall
    // back to a shell-style list when that whole-line path does not exist.
    const alternatives = [...(line.literal.length ? [[line.literal]] : []), ...(line.words ? [line.words] : [])];
    let matched: ImageFile[] | undefined;
    for (const paths of alternatives) {
      const batch: ImageFile[] = [];
      for (const candidates of paths) {
        const file = await resolveImageFile(candidates, signal);
        if (!file) break;
        batch.push(file);
      }
      if (batch.length === paths.length) { matched = batch; break; }
    }
    if (!matched) return undefined;
    files.push(...matched);
  }
  if (files.length > limits.maxImagesPerMessage) throw new ClipboardImageError(`At most ${limits.maxImagesPerMessage} images per message.`);
  for (const { path, size } of files) checkSize(size, basename(path), limits);
  if (files.reduce((sum, file) => sum + file.size, 0) > limits.maxMessageImageBytes) {
    throw new ClipboardImageError(`Attached images exceed ${byteLabel(limits.maxMessageImageBytes)}.`);
  }
  imagesConfirmed?.();
  const images: PendingImage[] = [];
  let total = 0;
  // Read sequentially to bound concurrent disk work and temporary buffers.
  for (const { path } of files) {
    signal?.throwIfAborted();
    let data: Buffer;
    try { data = await readFile(path, { signal }); }
    catch (error) {
      signal?.throwIfAborted();
      throw new ClipboardImageError(`Could not read ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    signal?.throwIfAborted();
    const mediaType = imageMediaType(data);
    if (!mediaType) return undefined;
    checkSize(data.byteLength, basename(path), limits);
    total += data.length;
    if (total > limits.maxMessageImageBytes) {
      throw new ClipboardImageError(`Attached images exceed ${byteLabel(limits.maxMessageImageBytes)}.`);
    }
    images.push({ data, mediaType, name: basename(path) });
  }
  return images.length ? images : undefined;
}
