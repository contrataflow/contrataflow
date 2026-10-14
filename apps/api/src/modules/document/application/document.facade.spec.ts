import { describe, expect, it } from 'vitest';

import { DocumentFacade } from './document.facade.js';

describe('DocumentFacade', () => {
  it('é instanciável', () => {
    expect(new DocumentFacade()).toBeInstanceOf(DocumentFacade);
  });
});
