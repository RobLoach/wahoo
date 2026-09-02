import { describe, expect, it } from 'vitest';
import { esc } from './dom.ts';

describe('esc', () => {
  it('neutralizes HTML metacharacters', () => {
    expect(esc('<img src=x onerror=alert(1)>')).toBe(
      '&#60;img src=x onerror=alert(1)&#62;',
    );
    expect(esc(`&"'`)).toBe('&#38;&#34;&#39;');
  });

  it('leaves plain text and suits untouched', () => {
    expect(esc('Red tucks a bunny into the burrow!')).toBe('Red tucks a bunny into the burrow!');
    expect(esc('K♦')).toBe('K♦');
  });
});
