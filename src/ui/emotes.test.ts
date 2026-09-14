import { describe, expect, it } from 'vitest';
import { emoteHtml } from './emotes.ts';

describe('emoteHtml', () => {
  it('escapes unknown reaction ids instead of rendering them', () => {
    const html = emoteHtml('<img onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html.startsWith('<span>')).toBe(true);
  });

  it('gives every render a unique gradient id', () => {
    // Two bubbles of the same colour on one page must not share DOM ids —
    // a duplicate makes the second bunny render with no fill.
    const a = emoteHtml('wahoo', '#a83a30', 0);
    const b = emoteHtml('wahoo', '#a83a30', 0);
    const idOf = (s: string) => /radialGradient id="([^"]+)"/.exec(s)?.[1];
    expect(idOf(a)).toBeTruthy();
    expect(idOf(a)).not.toBe(idOf(b));
    // Each SVG references its own gradient.
    expect(a).toContain(`url(#${idOf(a)})`);
  });

  it('draws each seat with its own ears', () => {
    const bySeat = [0, 1, 2, 3].map(s => emoteHtml('plain', '#a83a30', s));
    // All four ear layouts differ from one another.
    const earMarkup = bySeat.map(s => s.replace(/bg[0-9a-f]+-\d+/g, 'g'));
    expect(new Set(earMarkup).size).toBe(4);
    // Green is the lop: its ears hang on the ±142° base pose.
    expect(bySeat[2]).toContain('rotate(-142)');
    // No seat given: the classic tall pair, same as Red.
    const generic = emoteHtml('plain', '#a83a30').replace(/bg[0-9a-f]+-\d+/g, 'g');
    expect(generic).toBe(earMarkup[0]);
  });
});
