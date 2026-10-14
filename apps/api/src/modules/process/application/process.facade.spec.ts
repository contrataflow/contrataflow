import { describe, expect, it } from 'vitest';

import { ProcessFacade } from './process.facade.js';

describe('ProcessFacade', () => {
  it('é instanciável', () => {
    expect(new ProcessFacade()).toBeInstanceOf(ProcessFacade);
  });
});
