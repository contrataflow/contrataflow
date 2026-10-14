import { describe, expect, it } from 'vitest';

import { TenancyFacade } from './tenancy.facade.js';

describe('TenancyFacade', () => {
  it('é instanciável', () => {
    expect(new TenancyFacade()).toBeInstanceOf(TenancyFacade);
  });
});
