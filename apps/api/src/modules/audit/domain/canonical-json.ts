import { createHash } from 'node:crypto';

/** Valor JSON (I-JSON — RFC 7493): o único aceito pela canonicalização. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = Record<string, JsonValue>;

/** Entrada fora do modelo de dados JSON (erro de programação: sanitize antes com `toJsonValue`). */
export class CanonicalJsonError extends Error {
  constructor(reason: string) {
    super(`JSON canônico (RFC 8785): ${reason}.`);
    this.name = 'CanonicalJsonError';
  }
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * JSON canonicalizado pelo JCS (RFC 8785 — DEC-084): chaves ordenadas por unidades de código
 * UTF-16, sem espaços, números e strings serializados como no ECMAScript (`JSON.stringify`, que
 * já escreve `-0` como `0` e `1e21` como `1e+21`). Determinístico: mesma entrada, mesmos bytes.
 * Recusa o que não é I-JSON (NaN/Infinity, string com surrogate isolado, `undefined`, `Date`…).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('número não finito');
      return JSON.stringify(value);
    case 'string':
      if (!value.isWellFormed()) throw new CanonicalJsonError('string com surrogate isolado');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      if (!isPlainObject(value)) throw new CanonicalJsonError('objeto que não é JSON puro');
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries.map(([key, child]) => `${canonicalJson(key)}:${canonicalJson(child)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`tipo ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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
