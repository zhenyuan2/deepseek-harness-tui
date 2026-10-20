import type { Raster } from './terminal-image.js';

// Broad color clusters keep the reference's smile, spray and flukes readable.
const pixels = [
  '              OOO',
  '             OWWWO',
  '             OWHHO',
  '         OO  OHHHO  OO',
  '        OWHO  OHHO OWHO',
  '        OHHHO OHHO OHHHO',
  '         OHHHOOHHOHHHO',
  '          OOHOHHOHOO',
  '            OHHHHO',
  '         OOOOOOOOOOOO',
  '       OOHHHHHBBBBBBBOO',
  '      OHHHHHBBBBBBBBBBBOO',
  '     OHHHHBBBBBBBBBBBBBBBO',
  '    OHHHBBBBBBBBBBBBBBBBBBO',
  '   OHHBBBBBBBBBBBBBBBBBBBBBO    OOOO    OOOO',
  '   OHBBBBBWBBBBBBBBBBBBBBBBBO   OBBBO  OHHHBO',
  '  OHBBBBBBBBBBBBBBBBBBBBBBBBO   OBHBBBOHHHBBO',
  '  OBBBBBBBBBBBBBBBBBBBBBBBBBBO  OBHBBBBHHBBBO',
  '  OBBBBBBBBBEEEBBBBBBBBBBBBBBO   OBBBBBHBBBO',
  ' OBBBBBBBBBEEWWEBBBBBBBBBBBBBBO   OBBBBBBBO',
  ' OBBWBBBBBBEEWWEBBBBBBBBBBBBBBO    OBBBBO',
  ' OBBBBBBBBBEEEEEBBBBBBBBBBBBBBBO   OBBBO',
  ' OBEBBBEBBBBEEEBHHBBBBBBBBBBBBBBOOOBBBO',
  ' OBBEEEBBBBBBBBHHHBBBSSSBBBBBBBBBBBBBO',
  '  OWWBBBBBBBBBBBBBBBOSHHSSBBBBBBBBBBBO',
  '  OWWWWWWBBBBBBBBBBBOBBHHSSBBBBBBBBBO',
  '   OWWWWWWWWBBBBBBBBOBBBHHSSBBBBBBBO',
  '   OWWWWWWWWWWWWWWWWOSBBBBSSBWWWWO',
  '    OWWWWWWWWWWWWWWWWOSBBBBSSWWWO',
  '     OOWWWWWWWWWWWWWWWOSBBBSSWWO',
  '       OOWWWWWWWWWWWWWWOSSSSWWOO',
  '         OOOWWWWWWWWWWWWWWWOOO',
  '            OOOOWWWWWWOOOOO',
  '                OOOOOO',
];
const palette: Record<string, readonly [number, number, number]> = {
  O: [32, 52, 94], B: [65, 105, 200], S: [49, 83, 160],
  H: [120, 153, 221], W: [228, 236, 250], E: [32, 52, 94],
};

const scale = 4;
const width = Math.max(...pixels.map(row => row.length)) * scale, height = pixels.length * scale;
const data = new Uint8Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const color = palette[pixels[Math.floor(y / scale)]?.[Math.floor(x / scale)] ?? ' '];
  if (color) data.set([...color, 255], (y * width + x) * 4);
}
export const whaleSprite: Raster = { width, height, data };
