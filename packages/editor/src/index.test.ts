import { describe, expect, it } from 'vitest';

import { editorExtensions, editorSchemaVersion } from './index.js';

describe('@contrataflow/editor', () => {
  it('expõe a versão do schema como inteiro positivo', () => {
    expect(Number.isInteger(editorSchemaVersion)).toBe(true);
    expect(editorSchemaVersion).toBeGreaterThan(0);
  });

  it('mantém a lista de extensões imutável', () => {
    expect(Object.isFrozen(editorExtensions)).toBe(true);
  });
});
