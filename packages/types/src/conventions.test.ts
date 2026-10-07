import { describe, expect, it } from 'vitest';

import { DOMAIN_EVENT_NAMES, ERROR_CODES, PERMISSION_CODES, QUEUE_NAMES } from './index.js';

/** Convenções de nomenclatura de DEC-001, verificadas a cada entrada nova dos registros. */
const CONVENTIONS: readonly [string, readonly string[], RegExp][] = [
  ['permissões (RESOURCE_ACTION)', PERMISSION_CODES, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/],
  ['códigos de erro (SCREAMING_SNAKE_CASE)', ERROR_CODES, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/],
  ['eventos (PascalCase)', DOMAIN_EVENT_NAMES, /^[A-Z][A-Za-z0-9]+$/],
  ['filas (kebab-case)', QUEUE_NAMES, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/],
];

describe('registros de @contrataflow/types', () => {
  it.each(CONVENTIONS)('%s seguem a convenção e não se repetem', (_name, values, pattern) => {
    for (const value of values) expect(value).toMatch(pattern);
    expect(new Set(values).size).toBe(values.length);
  });
});
