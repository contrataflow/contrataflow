import { describe, expect, it } from 'vitest';

import { RiskFacade } from './risk.facade.js';

describe('RiskFacade', () => {
  it('é instanciável', () => {
    expect(new RiskFacade()).toBeInstanceOf(RiskFacade);
  });
});
