import { describe, expect, it } from 'vitest';

import { FilesFacade } from './files.facade.js';

describe('FilesFacade', () => {
  it('é instanciável', () => {
    expect(new FilesFacade()).toBeInstanceOf(FilesFacade);
  });
});
