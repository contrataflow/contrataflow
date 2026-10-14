import { describe, expect, it } from 'vitest';

import { TimelineFacade } from './timeline.facade.js';

describe('TimelineFacade', () => {
  it('é instanciável', () => {
    expect(new TimelineFacade()).toBeInstanceOf(TimelineFacade);
  });
});
