import { randomInt } from 'node:crypto';
import { cropRaster, encodePng, encodeSixel, kittyUpload, loadPortrait, prepareKittyImage, resizeRaster,
  type ImagePlacement, type Raster, type WelcomeImageView } from './terminal-image.js';

type Protocol = 'none' | 'kitty' | 'sixel';
export interface GraphicsCapabilities {
  protocol?: Exclude<Protocol, 'none'>;
  cell?: { width: number; height: number };
  displayMode?: number;
}
const st = '\x1b\\';
const queryPixel = encodePng({ width: 1, height: 1, data: new Uint8Array(4) }).toString('base64');

/** Own just the welcome portrait: capability queries, one placement, and cleanup. */
export class TerminalGraphics {
  private readonly id = randomInt(0x40000000, 0x7ffffffe);
  private protocol: Protocol = 'none';
  private source?: Raster;
  private cropped?: Raster;
  private croppedKey = '';
  private uploaded = false;
  private uploadedSize = '';
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private kitty = false;
  private sixel = false;
  private displayMode = 0;
  private cell = { width: 8, height: 16 };
  private measuredCell = false;
  private displayed?: ImagePlacement;
  private key = '';
  private variants = new Map<string, string>();
  view?: WelcomeImageView;
  constructor(private readonly write: (text: string) => unknown, private readonly changed: () => void,
    private readonly load: () => Promise<Raster | undefined> = loadPortrait,
    private readonly override = process.env.DEEPSEEK_TUI_IMAGE_PROTOCOL,
    private readonly capabilities: GraphicsCapabilities = {}) {}

  start(): void {
    const forced = this.override === 'kitty' || this.override === 'sixel';
    if (this.override === 'none' || (!forced && process.env.TERM === 'dumb') || process.env.TMUX || process.env.STY) return;
    if (this.capabilities.cell) { this.cell = { ...this.capabilities.cell }; this.measuredCell = true; }
    this.displayMode = this.capabilities.displayMode ?? 0;
    if (!forced && this.capabilities.protocol) void this.activate(this.capabilities.protocol);
    this.write(`\x1b_Gi=${this.id + 1},s=1,v=1,a=q,t=d,f=100;${queryPixel}${st}\x1b[c\x1b[16t\x1b[?80$p`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // VS Code's image addon can acknowledge Kitty queries without drawing it.
      const detected = process.env.TERM_PROGRAM === 'vscode' ? this.sixel ? 'sixel' : 'none'
        : this.kitty ? 'kitty' : this.sixel ? 'sixel' : 'none';
      const chosen = this.override === 'kitty' || this.override === 'sixel' ? this.override
        : detected;
      if (chosen !== 'sixel' || this.displayMode !== 3) void this.activate(chosen);
    }, 250);
    this.timer.unref();
  }

  /** Consume terminal replies before readline, including errors for our uploads. */
  response(sequence: string): void {
    if (this.disposed) return;
    const kitty = sequence.match(/^\x1b_G([^;]*);([^\x1b]*)\x1b\\$/);
    if (kitty) {
      const id = Number(kitty[1]!.match(/(?:^|,)i=(\d+)/)?.[1]);
      if (id === this.id + 1) this.kitty = kitty[2]!.startsWith('OK');
      if (id === this.id && !kitty[2]!.startsWith('OK')) {
        this.capabilities.protocol = undefined;
        this.protocol = 'none'; this.view = undefined; this.changed();
      }
      return;
    }
    const attributes = sequence.match(/^\x1b\[\?([\d;]*)c$/);
    if (attributes) this.sixel = attributes[1]!.split(';').slice(1).includes('4');
    const mode = sequence.match(/^\x1b\[\?80;([0-4])\$y$/);
    if (mode) {
      this.displayMode = Number(mode[1]);
      this.capabilities.displayMode = this.displayMode;
      if (this.displayMode === 3 && this.protocol === 'sixel') {
        this.capabilities.protocol = undefined;
        this.protocol = 'none'; this.view = undefined; this.changed();
      }
    }
    const cell = sequence.match(/^\x1b\[6;(\d+);(\d+)t$/);
    if (cell) {
      const height = Number(cell[1]), width = Number(cell[2]);
      if (width >= 1 && width <= 200 && height >= 1 && height <= 400) {
        this.cell = { width, height }; this.measuredCell = true;
        this.capabilities.cell = { ...this.cell };
        if (this.view) this.view.cellAspect = height / width;
        this.variants.clear(); this.changed();
      }
    }
  }

  private async activate(protocol: Protocol): Promise<void> {
    if (protocol === 'none' || this.disposed) return;
    try {
      const source = await this.load();
      if (!source || this.disposed || (protocol === 'sixel' && this.displayMode === 3)) return;
      if (this.override !== 'kitty' && this.override !== 'sixel') this.capabilities.protocol = protocol;
      this.source = source; this.cropped = undefined; this.croppedKey = ''; this.protocol = protocol;
      this.view = { aspect: source.width / source.height, cellAspect: this.cell.height / this.cell.width };
      this.changed();
    } catch { /* Missing or invalid art keeps the character fallback. */ }
  }

  resize(): void {
    if (!this.disposed && this.timer === undefined && (this.view || this.measuredCell)) this.write('\x1b[16t');
  }

  /** Erase before the text renderer repaints the cells beneath the old image. */
  prepare(placement: ImagePlacement | undefined, columns: number, rows: number): boolean {
    const crop = this.view?.crop ? JSON.stringify(this.view.crop) : '';
    const key = placement ? `${this.protocol}:${JSON.stringify(placement)}:${crop}:${this.cell.width}x${this.cell.height}:${columns}x${rows}` : '';
    if (key === this.key) return false;
    const erased = this.clear(columns, rows);
    this.key = key;
    return erased;
  }

  private rasterSource(): Raster | undefined {
    if (!this.source) return undefined;
    const crop = this.view?.crop;
    const key = crop ? JSON.stringify(crop) : '';
    if (this.croppedKey !== key || !this.cropped) {
      this.croppedKey = key; this.cropped = crop ? cropRaster(this.source, crop) : this.source; this.variants.clear();
    }
    return this.cropped;
  }

  paint(placement: ImagePlacement | undefined): void {
    if (!placement || !this.source || this.protocol === 'none' || this.displayed || this.disposed) return;
    const source = this.rasterSource()!;
    const { left, top, width, height } = placement;
    let content: string;
    if (this.protocol === 'kitty') {
      const image = prepareKittyImage(source, width * this.cell.width, height * this.cell.height);
      const size = `${image.width}x${image.height}:${this.croppedKey}`;
      content = this.uploadedSize === size ? '' : kittyUpload(image, this.id);
      this.uploaded = true;
      this.uploadedSize = size;
      // The uploaded raster already fits the box; cell dimensions would stretch it.
      content += `\x1b_Ga=p,i=${this.id},p=1,C=1,q=1${st}`;
    } else {
      const scale = Math.min(width * this.cell.width / source.width, height * this.cell.height / source.height,
        1536 / Math.max(source.width, source.height));
      const pixelsWide = Math.max(1, Math.floor(source.width * scale));
      const pixelsHigh = Math.max(1, Math.floor(source.height * scale));
      const size = `${pixelsWide}x${pixelsHigh}:${this.croppedKey}`;
      content = this.variants.get(size) ?? encodeSixel(resizeRaster(source, pixelsWide, pixelsHigh));
      if (this.variants.size >= 2) this.variants.clear();
      this.variants.set(size, content);
      if (this.displayMode === 1) content = '\x1b[?80l' + content + '\x1b[?80h';
    }
    this.write(`\x1b7\x1b[${top + 1};${left + 1}H${content}\x1b8`);
    this.displayed = { ...placement };
  }

  clear(columns: number, rows: number): boolean {
    const old = this.displayed;
    this.displayed = undefined; this.key = '';
    if (!old) return false;
    let content = this.uploaded ? `\x1b_Ga=d,d=i,i=${this.id},p=1,q=2${st}` : '';
    // ECH clears Sixel pixels too; bound erasure after shrinking the viewport.
    const width = Math.min(old.width, columns - old.left);
    if (width > 0) for (let y = old.top; y < Math.min(rows, old.top + old.height); y++) {
      content += `\x1b[${y + 1};${old.left + 1}H\x1b[${width}X`;
    }
    this.write(`\x1b7\x1b[0m${content}\x1b8`);
    return true;
  }

  resetScreen(columns: number, rows: number): void {
    this.clear(columns, rows);
    // Re-entering the alternate buffer can discard terminal-side image data.
    this.uploadedSize = '';
  }

  dispose(columns: number, rows: number): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.clear(columns, rows);
    if (this.uploaded) this.write(`\x1b_Ga=d,d=I,i=${this.id},q=2${st}`);
    this.view = undefined; this.source = undefined; this.cropped = undefined; this.croppedKey = ''; this.variants.clear();
  }
}
