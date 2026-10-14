import { describe, expect, it } from 'vitest';

import { DfdFacade } from './dfd.facade.js';

describe('DfdFacade', () => {
  it('é instanciável', () => {
    expect(new DfdFacade()).toBeInstanceOf(DfdFacade);
  });
});
