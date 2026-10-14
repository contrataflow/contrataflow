import { describe, expect, it } from 'vitest';

import { TermFacade } from './term.facade.js';

describe('TermFacade', () => {
  it('é instanciável', () => {
    expect(new TermFacade()).toBeInstanceOf(TermFacade);
  });
});
