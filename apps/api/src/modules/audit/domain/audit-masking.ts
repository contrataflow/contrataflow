import { canonicalJson, charLength, sha256Hex, toJsonValue } from './canonical-json.js';
import type { JsonObject, JsonValue } from './canonical-json.js';

/*
 * Mascaramento do que vai para `changes` e `metadata` (RN-AUD-03 · DEC-138 · V-04): segredos são
 * omitidos, CPF é mascarado, texto rico e texto longo viram `{ hash, length }` — nunca o conteúdo.
 * Regras por nome de campo (comparado sem caixa, `-`, `_`, `.` nem espaço) e, para o que escapar,
 * por padrão no valor: string com cara de segredo ou CPF sem regra cadastrada é redigida por inteiro.
 */

export const REDACTED = '[REDACTED]';

/** Texto acima disto vira resumo (`{ hash, length }`). */
export const LONG_TEXT_LIMIT = 500;

/** Credenciais e segredos: o valor nunca é gravado. */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'newpassword',
  'currentpassword',
  'passwordconfirmation',
  'senha',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'csrftoken',
  'invitetoken',
  'invitetokenhash',
  'apikey',
  'apitoken',
  'secret',
  'clientsecret',
  'signingkey',
  'privatekey',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'authorizationcode',
  'codeverifier',
  'otp',
  'totp',
  'mfasecret',
  'recoverycode',
  'recoverycodes',
]);

/** Conteúdo de documento e corpos: resumidos por hash, mesmo curtos (DEC-138). */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'draftcontent',
  'richtext',
  'html',
  'body',
  'rawbody',
  'snapshot',
]);

/** Valores que denunciam segredo ou CPF em campo sem regra (V-04: redação total por padrão). */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]+/, // JWT
  /\bBearer\s+[\w~+/.-]{8,}/i,
  /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/, // CPF formatado
];

export interface ContentDigest {
  readonly hash: string;
  readonly length: number;
}

function normalizeKey(key: string): string {
  return key.replace(/[-_.\s]/g, '').toLowerCase();
}

type KeyRule = 'secret' | 'cpf' | 'content' | null;

function ruleFor(key: string | null): KeyRule {
  if (key === null) return null;
  const normalized = normalizeKey(key);
  if (SECRET_KEYS.has(normalized)) return 'secret';
  if (normalized.includes('cpf')) return 'cpf';
  if (CONTENT_KEYS.has(normalized)) return 'content';
  return null;
}

/**
 * Resumo de conteúdo: texto → SHA-256 do texto (UTF-8) e número de caracteres; estrutura (ex.:
 * TipTap JSON) → SHA-256 do JSON canonicalizado e o tamanho dele.
 */
export function digestOf(value: JsonValue): ContentDigest {
  if (typeof value === 'string') return { hash: sha256Hex(value), length: charLength(value) };
  const canonical = canonicalJson(value);
  return { hash: sha256Hex(canonical), length: canonical.length };
}

function digestJson(value: JsonValue): JsonValue {
  const { hash, length } = digestOf(value);
  return { hash, length };
}

/** `***.456.789-**` (padrão de mascaramento de CPF em documentos públicos); outro formato → redigido. */
export function maskCpf(value: JsonValue): JsonValue {
  if (value === null) return null;
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (digits.length !== 11) return REDACTED;
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

function isRichTextDocument(value: JsonObject): boolean {
  return value.type === 'doc' && Array.isArray(value.content);
}

function maskValue(value: JsonValue, key: string | null): JsonValue {
  switch (ruleFor(key)) {
    case 'secret':
      return value === null ? null : REDACTED;
    case 'cpf':
      return maskCpf(value);
    case 'content':
      return value === null ? null : digestJson(value);
    default:
      break;
  }
  if (typeof value === 'string') {
    if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
    return charLength(value) > LONG_TEXT_LIMIT ? digestJson(value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskValue(item, null));
  if (value !== null && typeof value === 'object') {
    if (isRichTextDocument(value)) return digestJson(value);
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [childKey, maskValue(child, childKey)]),
    );
  }
  return value;
}

/** Último segmento do caminho do campo (`sections.JUSTIFICATION.content` → `content`). */
function lastSegment(path: string): string | null {
  const segments = path.split(/[.[\]]/).filter(Boolean);
  return segments.at(-1) ?? null;
}

export interface ChangeInput {
  readonly path: string;
  readonly old: unknown;
  readonly new: unknown;
}

/** `changes` gravado: `[{ path, old, new }]` com cada valor mascarado pela regra do campo. */
export function maskChanges(changes: readonly ChangeInput[]): JsonValue[] {
  return changes.map((change) => {
    const key = lastSegment(change.path);
    return {
      path: change.path,
      old: maskValue(toJsonValue(change.old), key),
      new: maskValue(toJsonValue(change.new), key),
    };
  });
}

/** `metadata` gravado: objeto JSON com as mesmas regras de mascaramento. */
export function maskMetadata(metadata: Readonly<Record<string, unknown>>): JsonObject {
  const json = toJsonValue(metadata);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return {};
  return maskValue(json, null) as JsonObject;
}
