import type { AiInputRef, AiOutputWarning } from '@contrataflow/validation';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

/*
 * `ContextSanitizer` (RN-AI-05 · DEC-140 · DEC-030 · tests.md §3.10): minimiza o contexto antes de
 * ele sair para o provedor (subprocessador externo). Rede de segurança determinística — os
 * geradores já montam o contexto só com o necessário, por papel/unidade, mas nada que escape deles
 * passa daqui:
 *
 * 1. Chaves excluídas em qualquer profundidade: comentários, anexos, fornecedores, contatos
 *    (e-mail, telefone, CPF, CEP, endereço), nomes e ids de pessoas.
 * 2. Processo com orçamento sigiloso: toda chave de valor/preço/orçamento sai, qualquer que seja
 *    a permissão do solicitante (DEC-030), com o aviso `BUDGET_CONFIDENTIAL_VALUES_OMITTED`.
 * 3. Textos livres: CPF, e-mail, telefone e CEP viram `[dado pessoal omitido]`.
 * 4. Tamanho: partes opcionais saem (da última para a primeira) com `CONTEXT_TRUNCATED`; se o
 *    obrigatório não couber → `ContextTooLargeError` (`FAILED`/`CONTEXT_TOO_LARGE`).
 *
 * Cada parte recebe o `contentHash` (SHA-256 do JSON canônico — RFC 8785, como em DEC-017) e o
 * contexto inteiro o `contextHash`. Nada do conteúdo é registrado em log.
 */

export const PERSONAL_DATA_PLACEHOLDER = '[dado pessoal omitido]';

/** Uma entrada do contexto, como o gerador a montou (ainda sem hash). */
export interface ContextPart {
  readonly ref: Omit<AiInputRef, 'contentHash'>;
  /** Rótulo da parte no prompt ("Processo", "Itens"…) — nunca dado pessoal. */
  readonly label: string;
  readonly data: unknown;
  /** Pode ser omitida se o contexto não couber (FA-07). */
  readonly optional?: boolean;
}

export interface SanitizedPart {
  readonly label: string;
  readonly data: unknown;
  readonly ref: AiInputRef;
}

export interface SanitizedContext {
  readonly parts: readonly SanitizedPart[];
  readonly inputRefs: readonly AiInputRef[];
  readonly contextHash: string;
  readonly warnings: readonly AiOutputWarning[];
  /** Contagens para métricas e logs (sem conteúdo). */
  readonly stats: {
    readonly removedKeys: number;
    readonly redactions: number;
    readonly omittedParts: number;
    readonly chars: number;
  };
}

export interface SanitizeOptions {
  /** Processo com orçamento sigiloso: valores nunca entram (DEC-030). */
  readonly isBudgetConfidential: boolean;
  /** Teto do contexto serializado, em caracteres. */
  readonly maxChars: number;
}

/** O obrigatório não cabe no contexto (FA-07). */
export class ContextTooLargeError extends Error {
  constructor(
    readonly chars: number,
    readonly maxChars: number,
  ) {
    super(`Contexto obrigatório com ${String(chars)} caracteres (máximo ${String(maxChars)}).`);
    this.name = 'ContextTooLargeError';
  }
}

/** Comentários, anexos e fornecedores (e o que deles derive) nunca entram. */
const EXCLUDED_COLLECTIONS = new Set([
  'comment',
  'comments',
  'comentario',
  'comentarios',
  'attachment',
  'attachments',
  'anexo',
  'anexos',
]);
const SUPPLIER_WORDS = new Set(['supplier', 'suppliers', 'fornecedor', 'fornecedores']);
/** Contato e documento pessoal, em qualquer palavra da chave. */
const CONTACT_WORDS = new Set([
  'email',
  'mail',
  'phone',
  'telefone',
  'celular',
  'whatsapp',
  'cpf',
  'cep',
  'zip',
  'address',
  'endereco',
]);
/** Pessoas: nomes e ids de usuários (são referidas por papel/unidade — RN-AI-05). */
const PERSON_WORDS = new Set([
  'user',
  'users',
  'person',
  'pessoa',
  'responsible',
  'responsavel',
  'requester',
  'solicitante',
  'author',
  'autor',
  'creator',
  'approver',
  'aprovador',
  'contact',
  'contato',
  'signer',
  'signatario',
  'fiscal',
  'manager',
  'gestor',
  'custodian',
  'reviewer',
  'revisor',
  'participant',
  'participante',
]);
const PERSON_SUFFIXES = new Set(['name', 'nome', 'id', 'ids']);
/** Valores orçamentários (só em processo sigiloso). */
const BUDGET_WORDS = new Set([
  'value',
  'values',
  'valor',
  'valores',
  'price',
  'prices',
  'preco',
  'precos',
  'amount',
  'montante',
  'budget',
  'orcamento',
  'cost',
  'custo',
  'total',
]);

/** Palavras da chave em minúsculas, sem acento: `requestingDepartmentName` → requesting, …. */
function wordsOf(key: string): string[] {
  return key
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_.-]+/)
    .filter((word) => word !== '');
}

function isPersonKey(words: readonly string[]): boolean {
  const last = words.at(-1) ?? '';
  if (PERSON_WORDS.has(last)) return true;
  if (!PERSON_SUFFIXES.has(last) || words.length < 2) return false;
  // `createdById`, `responsibleName`, `approverUserId`: a palavra antes do sufixo é de pessoa.
  const previous = words.at(-2) ?? '';
  return PERSON_WORDS.has(previous) || previous === 'by';
}

function isBudgetKey(words: readonly string[]): boolean {
  // Sinalizadores (`isBudgetConfidential`) e contagens (`totalItems`) não são valores.
  if (words[0] === 'is' || words[0] === 'has') return false;
  if (words[0] === 'total' && words.length > 1 && ['items', 'count'].includes(words[1] ?? '')) {
    return false;
  }
  return words.some((word) => BUDGET_WORDS.has(word));
}

const CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const CEP = /(?<!\d)\d{5}-\d{3}(?!\d)|\bCEP:?\s*\d{5}-?\d{3}(?!\d)/gi;
const PHONE = /(?:\+?55\s?)?(?:\(\d{2}\)\s?|(?<!\d)\d{2}\s)?(?<!\d)9?\d{4}-\d{4}(?!\d)/g;

interface Counters {
  removedKeys: number;
  redactions: number;
  budgetValuesRemoved: number;
}

function excludedKey(key: string, isBudgetConfidential: boolean, counters: Counters): boolean {
  const words = wordsOf(key);
  const personal =
    EXCLUDED_COLLECTIONS.has(words.join('')) ||
    SUPPLIER_WORDS.has(words[0] ?? '') ||
    words.some((word) => CONTACT_WORDS.has(word)) ||
    isPersonKey(words);
  if (personal) {
    counters.removedKeys += 1;
    return true;
  }
  if (isBudgetConfidential && isBudgetKey(words)) {
    counters.removedKeys += 1;
    counters.budgetValuesRemoved += 1;
    return true;
  }
  return false;
}

/** Redige CPF, e-mail, telefone e CEP num texto livre. */
export function redactPersonalData(text: string): {
  readonly text: string;
  readonly count: number;
} {
  let count = 0;
  const replace = (input: string, pattern: RegExp) =>
    input.replace(pattern, () => {
      count += 1;
      return PERSONAL_DATA_PLACEHOLDER;
    });
  // E-mail antes dos números (domínios com dígitos); CPF antes do telefone (11 dígitos).
  const redacted = [EMAIL, CPF, CEP, PHONE].reduce(replace, text);
  return { text: redacted, count };
}

function sanitizeValue(value: unknown, options: SanitizeOptions, counters: Counters): unknown {
  if (typeof value === 'string') {
    const { text, count } = redactPersonalData(value);
    counters.redactions += count;
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, options, counters));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (excludedKey(key, options.isBudgetConfidential, counters)) continue;
      out[key] = sanitizeValue(item, options, counters);
    }
    return out;
  }
  // number, boolean, null; undefined e funções não são JSON — saem.
  return value === undefined || typeof value === 'function' ? null : value;
}

function hashOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sizeOf(part: { readonly label: string; readonly data: unknown }): number {
  return canonicalJson({ label: part.label, data: part.data }).length;
}

/**
 * Sanitiza as partes, aplica o teto de tamanho e calcula os hashes. Determinístico: a mesma
 * entrada produz o mesmo `contextHash` (o `FakeAiProvider` escolhe a fixture por ele).
 */
export function sanitizeContext(
  parts: readonly ContextPart[],
  options: SanitizeOptions,
): SanitizedContext {
  const counters: Counters = { removedKeys: 0, redactions: 0, budgetValuesRemoved: 0 };
  const sanitized = parts.map((part) => ({
    part,
    data: sanitizeValue(part.data, options, counters),
  }));

  const warnings: AiOutputWarning[] = [];
  if (counters.budgetValuesRemoved > 0)
    warnings.push({ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' });

  const required = sanitized.filter((entry) => entry.part.optional !== true);
  const requiredChars = required.reduce(
    (sum, entry) => sum + sizeOf({ label: entry.part.label, data: entry.data }),
    0,
  );
  if (requiredChars > options.maxChars) {
    throw new ContextTooLargeError(requiredChars, options.maxChars);
  }

  // Partes opcionais entram na ordem do gerador enquanto couberem; as que não couberem saem.
  let chars = requiredChars;
  const kept = new Set(required);
  let omittedParts = 0;
  for (const entry of sanitized) {
    if (entry.part.optional !== true) continue;
    const size = sizeOf({ label: entry.part.label, data: entry.data });
    if (chars + size <= options.maxChars) {
      kept.add(entry);
      chars += size;
    } else {
      omittedParts += 1;
    }
  }
  if (omittedParts > 0) {
    warnings.push({ code: 'CONTEXT_TRUNCATED', params: { omittedParts: String(omittedParts) } });
  }

  const finalParts = sanitized
    .filter((entry) => kept.has(entry))
    .map(({ part, data }) => ({
      label: part.label,
      data,
      ref: { ...part.ref, contentHash: hashOf({ label: part.label, data }) },
    }));
  return {
    parts: finalParts,
    inputRefs: finalParts.map((part) => part.ref),
    contextHash: hashOf(finalParts.map((part) => ({ label: part.label, data: part.data }))),
    warnings,
    stats: {
      removedKeys: counters.removedKeys,
      redactions: counters.redactions,
      omittedParts,
      chars,
    },
  };
}
