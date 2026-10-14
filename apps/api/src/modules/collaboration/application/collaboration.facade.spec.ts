import { describe, expect, it } from 'vitest';

import { CollaborationFacade } from './collaboration.facade.js';

describe('CollaborationFacade', () => {
  it('é instanciável', () => {
    expect(new CollaborationFacade()).toBeInstanceOf(CollaborationFacade);
  });
});
