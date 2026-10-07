import { describe, expect, it } from 'vitest';

import { cx } from './cx.js';

describe('cx', () => {
  it('junta classes e ignora valores vazios', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });
});
