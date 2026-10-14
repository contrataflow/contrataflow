import { describe, expect, it } from 'vitest';

import { PlatformFacade } from './platform.facade.js';

describe('PlatformFacade', () => {
  it('é instanciável', () => {
    expect(new PlatformFacade()).toBeInstanceOf(PlatformFacade);
  });
});
