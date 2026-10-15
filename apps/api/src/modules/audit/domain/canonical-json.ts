import type { JsonValue } from '#shared/integrity/canonical-json.js';

// JCS e SHA-256 vivem no shared kernel (também usados pelos snapshots de workflow — US-040).
export { canonicalJson, CanonicalJsonError, sha256Hex } from '#shared/integrity/canonical-json.js';
export type { JsonObject, JsonValue } from '#shared/integrity/canonical-json.js';

/** Número de caracteres (code points) — o que `varchar(n)` conta. */
export function charLength(text: string): number {
  return Array.from(text).length;
}

const NUL = String.fromCharCode(0);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/** String aceitável no `jsonb`/`text` do PostgreSQL e no JCS: sem NUL nem surrogate isolado. */
function cleanString(value: string): string {
  return value.replaceAll(NUL, REPLACEMENT_CHARACTER).toWellFormed();
}

function clean(value: unknown): JsonValue {
  if (typeof value === 'string') return cleanString(value);
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        cleanString(key),
        clean(child),
      ]),
    );
  }
  return value as JsonValue;
}

/**
 * Converte um valor da aplicação para JSON puro (o que o `jsonb` guarda e o hash cobre): `Date` →
 * ISO, `Decimal` → string (`toJSON`), `bigint` → string, `undefined` omitido, NaN/Infinity → null.
 */
export function toJsonValue(value: unknown): JsonValue {
  // `undefined`, função ou símbolo na raiz: `JSON.stringify` devolve `undefined`.
  const text = JSON.stringify(value, (_key, child: unknown) =>
    typeof child === 'bigint' ? child.toString() : child,
  ) as string | undefined;
  return text === undefined ? null : clean(JSON.parse(text));
}

/** Texto de coluna (`varchar`): limpo e truncado ao tamanho da coluna; vazio → `null`. */
export function columnText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = cleanString(value).trim();
  if (text === '') return null;
  if (charLength(text) <= maxLength) return text;
  // `varchar(n)` conta caracteres (code points): corta por eles, sem partir um par de surrogates.
  return Array.from(text).slice(0, maxLength).join('');
}
