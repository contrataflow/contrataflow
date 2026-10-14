import { FIELD_ERROR_CODES } from '@contrataflow/types';
import type { FieldErrorCode } from '@contrataflow/types';
import type { FieldError } from '@contrataflow/validation';
import type { z } from 'zod';

type Issue = z.core.$ZodIssue;
type RawIssue = z.core.$ZodRawIssue;

const FIELD_CODES = new Set<string>(FIELD_ERROR_CODES);

/** Mensagens pt-BR padrão por código de campo (usadas quando o schema não define a sua). */
const DEFAULT_MESSAGES: Readonly<Record<FieldErrorCode, string>> = {
  REQUIRED: 'Campo obrigatório.',
  TOO_SHORT: 'Valor curto demais.',
  TOO_LONG: 'Valor longo demais.',
  INVALID_FORMAT: 'Formato inválido.',
  INVALID_ENUM: 'Valor não permitido.',
  OUT_OF_RANGE: 'Valor fora do intervalo permitido.',
  DATE_IN_PAST: 'A data não pode estar no passado.',
  INVALID_DECIMAL: 'Número decimal inválido.',
  INVALID_CNPJ: 'CNPJ inválido.',
  INVALID_CPF: 'CPF inválido.',
  REFERENCE_NOT_FOUND: 'Registro não encontrado.',
  REFERENCE_INACTIVE: 'Registro inativo.',
  DEPARTMENT_NOT_IN_SECRETARIAT: 'O setor não pertence à secretaria informada.',
  CONDITIONAL_REQUIRED: 'Campo obrigatório nesta situação.',
  DUPLICATE_IN_LIST: 'Item repetido na lista.',
  NOT_ALLOWED: 'Campo não permitido.',
};

/**
 * Campo ausente. Os issues finais só trazem `input` quando o parse usa `reportInput` (o
 * `ZodValidationPipe` usa); para `ZodError` vindo de outro lugar, cai na mensagem padrão do Zod.
 */
function isMissing(issue: Issue | RawIssue): boolean {
  if (issue.code !== 'invalid_type') return false;
  return 'input' in issue
    ? issue.input === undefined
    : issue.message.endsWith(' received undefined');
}

/** Traduz um issue do Zod para a taxonomia de api.md §2.1.1. */
export function fieldErrorCode(issue: Issue | RawIssue): FieldErrorCode {
  switch (issue.code) {
    case 'invalid_type':
      return isMissing(issue) ? 'REQUIRED' : 'INVALID_FORMAT';
    case 'too_small':
      if (issue.origin === 'string' || issue.origin === 'array' || issue.origin === 'set') {
        return Number(issue.minimum) <= 1 && issue.origin === 'string' ? 'REQUIRED' : 'TOO_SHORT';
      }
      return 'OUT_OF_RANGE';
    case 'too_big':
      return issue.origin === 'string' || issue.origin === 'array' || issue.origin === 'set'
        ? 'TOO_LONG'
        : 'OUT_OF_RANGE';
    case 'invalid_value':
      return 'INVALID_ENUM';
    case 'unrecognized_keys':
      return 'NOT_ALLOWED';
    case 'custom': {
      const code: unknown = issue.params?.code;
      return typeof code === 'string' && FIELD_CODES.has(code)
        ? (code as FieldErrorCode)
        : 'INVALID_FORMAT';
    }
    default:
      return 'INVALID_FORMAT';
  }
}

/**
 * Mapa de erros por parse: só atua quando o schema não definiu mensagem própria, trocando as
 * mensagens padrão (inglês) do Zod pelas mensagens pt-BR da taxonomia.
 */
export const ptBrErrorMap: z.core.$ZodErrorMap = (issue) => DEFAULT_MESSAGES[fieldErrorCode(issue)];

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/** Converte os issues de um `ZodError` em `errors[]` (um item por campo inválido). */
export function toFieldErrors(issues: readonly Issue[], prefix?: string): FieldError[] {
  const errors: FieldError[] = [];
  for (const issue of issues) {
    const base = prefix ? [prefix, ...issue.path] : issue.path;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        errors.push({
          field: formatPath([...base, key]),
          code: 'NOT_ALLOWED',
          message: DEFAULT_MESSAGES.NOT_ALLOWED,
        });
      }
      continue;
    }
    errors.push({ field: formatPath(base), code: fieldErrorCode(issue), message: issue.message });
  }
  return errors;
}
