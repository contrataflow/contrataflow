/*
 * Redação de dados proibidos em logs (DEC-138 · RN-FND-73 · observability.md §2.4 ·
 * security.md §5). Duas camadas, aplicadas a todo objeto logado (inclusive aninhado):
 * 1. por nome de campo — o valor inteiro vira `[REDACTED]` (e-mail sai mascarado);
 * 2. por padrão no texto — JWT, `Bearer`, CPF formatado, URL pré-assinada e e-mail em qualquer
 *    string (inclusive `msg` e mensagens de erro), para o que escapar da primeira camada.
 * Campo sensível novo em DTO entra em `SENSITIVE_KEYS` com teste de redação antes do merge.
 */

export const REDACTED = '[REDACTED]';

/**
 * Nomes de campo cujo valor nunca vai para log, comparados sem caixa, `-`, `_` nem `.`
 * (`access_token`, `accessToken` e `Access-Token` são o mesmo campo).
 */
export const SENSITIVE_KEYS: readonly string[] = [
  // Credenciais e sessão
  'authorization',
  'proxyAuthorization',
  'cookie',
  'setCookie',
  'password',
  'newPassword',
  'currentPassword',
  'senha',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'sessionToken',
  'csrfToken',
  'apiKey',
  'secret',
  'clientSecret',
  'signingKey',
  'privateKey',
  'authorizationCode',
  'codeVerifier',
  // Dados pessoais
  'cpf',
  'email',
  // Conteúdo de documentos e corpos (requisição, resposta, upload)
  'content',
  'draftContent',
  'sections',
  'snapshot',
  'body',
  'rawBody',
  // Arquivos e links com credencial ao portador
  'fileName',
  'originalFileName',
  'originalName',
  'url',
  'presignedUrl',
  'uploadUrl',
  'downloadUrl',
  'inviteLink',
  'invitationUrl',
  'recoveryLink',
  'resetLink',
  // Orçamento sigiloso (POL-09)
  'estimatedValue',
  'confidentialValue',
  'budgetValue',
  'referenceValue',
];

/** Campos mascarados em vez de omitidos (DEC-138: `j***@dominio.gov.br`). */
const MASKED_KEYS = new Set(['email']);

function normalizeKey(key: string): string {
  return key.replace(/[-_.]/g, '').toLowerCase();
}

const SENSITIVE = new Set(SENSITIVE_KEYS.map(normalizeKey));

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.has(normalizeKey(key));
}

/** `joao.silva@dominio.gov.br` → `j***@dominio.gov.br`; texto que não é e-mail → `[REDACTED]`. */
export function maskEmail(value: unknown): string {
  if (typeof value !== 'string') return REDACTED;
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return REDACTED;
  return `${value.charAt(0)}***${value.slice(at)}`;
}

const TEXT_PATTERNS: readonly (readonly [RegExp, (match: string) => string])[] = [
  // URL pré-assinada (S3/MinIO): a assinatura é credencial ao portador.
  [/\bhttps?:\/\/\S*(?:X-Amz-Signature|X-Amz-Credential|Signature=)\S*/gi, () => REDACTED],
  // JWT (access/id/refresh token) e esquemas de autorização.
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]+/g, () => REDACTED],
  [/\b(Bearer|Basic)\s+[\w~+/.=-]+/gi, (match) => `${match.split(/\s+/)[0] ?? ''} ${REDACTED}`],
  // CPF formatado.
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, () => REDACTED],
  // E-mail em texto livre: mascarado.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (match) => maskEmail(match)],
];

/** Aplica os padrões de texto proibido (camada 2) a uma string. */
export function scrubText(value: string): string {
  let result = value;
  for (const [pattern, replace] of TEXT_PATTERNS) result = result.replace(pattern, replace);
  return result;
}

const MAX_DEPTH = 8;

/**
 * Cópia redigida de um valor para log: campos sensíveis em qualquer nível, padrões proibidos em
 * strings, `Error` convertido em `{ type, message, code, stack }` e ciclos interrompidos.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  if (value instanceof Error) return serializeError(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = MASKED_KEYS.has(normalizeKey(key)) ? maskEmail(child) : REDACTED;
    } else {
      result[key] = redactValue(child, depth + 1, seen);
    }
  }
  return result;
}

/** Forma de erro nos logs (observability.md §2.2): `stack` só nos níveis `error`/`fatal`. */
export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
}

export function serializeError(error: unknown, options: { stack?: boolean } = {}): SerializedError {
  const withStack = options.stack ?? true;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      type: error.name,
      message: scrubText(error.message),
      ...(typeof code === 'string' ? { code } : {}),
      ...(withStack && error.stack ? { stack: scrubText(error.stack) } : {}),
    };
  }
  if (error !== null && typeof error === 'object' && 'message' in error) {
    // Já serializado (ex.: reaplicado pelo serializer do pino): só redige e ajusta o `stack`.
    const { type, message, code, stack } = error as Record<string, unknown>;
    return {
      type: typeof type === 'string' ? type : 'Error',
      message: scrubText(String(message)),
      ...(typeof code === 'string' ? { code } : {}),
      ...(withStack && typeof stack === 'string' ? { stack: scrubText(stack) } : {}),
    };
  }
  return { type: typeof error, message: scrubText(String(error)) };
}
