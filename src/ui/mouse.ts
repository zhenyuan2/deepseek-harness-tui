import { StringDecoder } from 'node:string_decoder';
export interface MouseReport { button: number; column: number; row: number; release: boolean }

/** Filter SGR mouse reports before readline; pasted reports remain literal text. */
export function mouseInput(forward: (text: string) => void, wheel: (direction: number) => void,
  pointer?: (report: MouseReport) => void): { write(chunk: string | Buffer): void; close(): void } {
  const decoder = new StringDecoder('utf8');
  let buffer = ''; let pasting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => { timer = undefined; const text = buffer; buffer = ''; if (text) forward(text); };
  const drain = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    while (buffer) {
      const escape = buffer.indexOf('\x1b');
      if (escape === -1) { forward(buffer); buffer = ''; break; }
      if (escape > 0) { forward(buffer.slice(0, escape)); buffer = buffer.slice(escape); }
      const report = buffer.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
      if (report) {
        if (pasting) forward(report[0]);
        else {
          const button = Number(report[1]);
          if (report[4] === 'M' && (button & 64) && (button & 3) < 2) wheel((button & 1) ? 1 : -1);
          else if (!(button & 64)) pointer?.({ button, column: Number(report[2]) - 1, row: Number(report[3]) - 1, release: report[4] === 'm' });
        }
        buffer = buffer.slice(report[0].length); continue;
      }
      const paste = buffer.match(/^\x1b\[(200|201)~/);
      if (paste) { pasting = paste[1] === '200'; forward(paste[0]); buffer = buffer.slice(paste[0].length); continue; }
      if (buffer.length < 100 && ('\x1b[200~'.startsWith(buffer) || '\x1b[201~'.startsWith(buffer) || /^\x1b\[<[\d;]*$/.test(buffer))) {
        timer = setTimeout(flush, 40); break;
      }
      forward(buffer[0]!); buffer = buffer.slice(1);
    }
  };
  return {
    write(chunk) { buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk); drain(); },
    close() { if (timer) clearTimeout(timer); buffer = ''; },
  };
}
