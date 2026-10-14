import { describe, expect, it } from 'vitest';

import { EtpFacade } from './etp.facade.js';

describe('EtpFacade', () => {
  it('é instanciável', () => {
    expect(new EtpFacade()).toBeInstanceOf(EtpFacade);
  });
});
