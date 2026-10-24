import { StringDecoder } from 'node:string_decoder';
export interface MouseReport { button: number; column: number; row: number; release: boolean }

/** Filter SGR mouse reports before readline; pasted reports remain literal text. */
export function mouseInput(forward: (text: string) => void, wheel: (direction: number) => void,
  pointer?: (report: MouseReport) => void, response?: (sequence: string) => void,
  focus?: () => void): { write(chunk: string | Buffer): void; close(): void } {
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
      const focusReport = buffer.match(/^\x1b\[([IO])/);
      if (focusReport) {
        if (pasting) forward(focusReport[0]);
        else if (focusReport[1] === 'I') focus?.();
        buffer = buffer.slice(focusReport[0].length); continue;
      }
      const reply = response && buffer.match(/^(?:\x1b_G[^\x1b]*\x1b\\|\x1b\[\?[\d;]*c|\x1b\[6;\d+;\d+t|\x1b\[\?80;[0-4]\$y)/);
      if (reply) {
        if (pasting) forward(reply[0]); else response?.(reply[0]);
        buffer = buffer.slice(reply[0].length); continue;
      }
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
      if (response && buffer.length < 4096 && /^\x1b(?:_G[^\x1b]*(?:\x1b)?|\[\?[\d;]*\$?|\[6;[\d;]*)$/.test(buffer)) {
        timer = setTimeout(flush, 500); break;
      }
      if (buffer.length < 100 && (['\x1b[200~', '\x1b[201~', '\x1b_G', '\x1b[6;'].some(prefix => prefix.startsWith(buffer)) || /^\x1b\[<[\d;]*$/.test(buffer))) {
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
