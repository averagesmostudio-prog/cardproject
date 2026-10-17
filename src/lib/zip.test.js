import { describe, it, expect } from 'vitest';
import { buildZip } from './zip.js';

describe('buildZip', () => {
  it('writes a valid store-only archive listing every file with correct sizes', async () => {
    const a = new Blob([new Uint8Array([1, 2, 3])]);
    const b = new Blob([new Uint8Array([4, 5, 6, 7, 8])]);
    const zip = await buildZip([{ name: 'deck_sheet_1.png', blob: a }, { name: 'deck_sheet_2.png', blob: b }]);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);

    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const eocd = bytes.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(2);

    const cdOffset = view.getUint32(eocd + 16, true);
    expect(view.getUint32(cdOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(cdOffset + 24, true)).toBe(3);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const second = cdOffset + 46 + nameLen;
    expect(view.getUint32(second, true)).toBe(0x02014b50);
    expect(view.getUint32(second + 24, true)).toBe(5);
  });
});
