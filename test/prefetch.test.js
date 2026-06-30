import { describe, it, expect } from 'vitest';
import { computeNextFile } from '../src/index.js';

const torrent = {
  id: 32034717,
  files: [
    { id: 5, name: 'Sabaody Archipelago 01.mkv' },
    { id: 4, name: 'Sabaody Archipelago 02.mkv' },
    { id: 1, name: 'Sabaody Archipelago 09.mkv' }, // idx 2
    { id: 9, name: 'readme.txt' },                 // idx 3, non-video
  ],
};

describe('computeNextFile', () => {
  it('returns the next file for an in-bounds video', () => {
    const r = computeNextFile(torrent, 1);
    expect(r.skip).toBe(null);
    expect(r.nextIdx).toBe(2);
    expect(r.nextFile.id).toBe(1);
  });

  it('skips at the arc boundary (last file)', () => {
    const r = computeNextFile(torrent, 3);
    expect(r.skip).toBe('boundary');
    expect(r.nextIdx).toBe(4);
  });

  it('skips when the next file is not a video', () => {
    const r = computeNextFile(torrent, 2);
    expect(r.skip).toBe('non-video');
    expect(r.nextIdx).toBe(3);
  });

  it('skips boundary when torrent has no files', () => {
    const r = computeNextFile({ files: [] }, 0);
    expect(r.skip).toBe('boundary');
  });
});
