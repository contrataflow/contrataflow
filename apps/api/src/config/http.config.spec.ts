import { describe, expect, it } from 'vitest';

// Importa pelo subpath import do package.json (#config/*), como o restante da API.
import { httpConfig } from '#config/http.config.js';

describe('httpConfig', () => {
  it('usa a porta 4000 no estado hello', () => {
    expect(httpConfig.port).toBe(4000);
    expect(Object.isFrozen(httpConfig)).toBe(true);
  });
});
