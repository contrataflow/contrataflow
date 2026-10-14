import { describe, expect, it } from 'vitest';

import { IdentityFacade } from './identity.facade.js';

describe('IdentityFacade', () => {
  it('é instanciável', () => {
    expect(new IdentityFacade()).toBeInstanceOf(IdentityFacade);
  });
});
