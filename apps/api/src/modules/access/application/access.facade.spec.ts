import { describe, expect, it } from 'vitest';

import { AccessFacade } from './access.facade.js';

describe('AccessFacade', () => {
  it('é instanciável', () => {
    expect(new AccessFacade()).toBeInstanceOf(AccessFacade);
  });
});
