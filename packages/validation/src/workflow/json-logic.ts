/*
 * Whitelist de JSON Logic (ADR-008 · US-040 · RN-WF-17): o que uma expressão `CONDITION` (e a
 * aplicabilidade — US-042) pode usar. Compartilhada pela escrita (API e editor) e pelo avaliador do
 * motor (US-041), que recusa em tempo de execução o mesmo que é recusado aqui. `method` e `log`
 * (efeitos colaterais e acesso a métodos do JavaScript) nunca entram; operação desconhecida também
 * não. Os caminhos de `var`/`missing` são conferidos contra o RuleContext v1 pelo chamador.
 */

/** Operações aceitas (as de `json-logic-js` sem `method` e `log`). */
export const JSON_LOGIC_ALLOWED_OPERATIONS: readonly string[] = Object.freeze([
  'var',
  'missing',
  'missing_some',
  'if',
  '?:',
  '==',
  '===',
  '!=',
  '!==',
  '!',
  '!!',
  'or',
  'and',
  '>',
  '>=',
  '<',
  '<=',
  'max',
  'min',
  '+',
  '-',
  '*',
  '/',
  '%',
  'map',
  'filter',
  'reduce',
  'all',
  'none',
  'some',
  'merge',
  'in',
  'cat',
  'substr',
]);

/** Profundidade máxima de aninhamento (objetos e listas) da expressão. */
export const JSON_LOGIC_MAX_DEPTH = 20;
/** Tamanho máximo da expressão serializada (UTF-8). */
export const JSON_LOGIC_MAX_BYTES = 10 * 1024;

/** Operações que iteram uma lista: o 2º argumento é avaliado sobre cada item (`var` relativo). */
const ITERATORS = new Set(['map', 'filter', 'reduce', 'all', 'none', 'some']);
const ALLOWED = new Set(JSON_LOGIC_ALLOWED_OPERATIONS);

export type JsonLogicIssueKind = 'OPERATOR_FORBIDDEN' | 'PATH_UNKNOWN' | 'INVALID';

export interface JsonLogicIssue {
  readonly kind: JsonLogicIssueKind;
  /** Detalhe pt-BR sem o conteúdo da expressão (só o nome da operação ou do caminho). */
  readonly detail: string;
}

export interface JsonLogicInspection {
  readonly issues: readonly JsonLogicIssue[];
  /** Caminhos absolutos lidos por `var`/`missing`/`missing_some` (fora de iteradores). */
  readonly paths: readonly string[];
}

export interface JsonLogicInspectOptions {
  /** Caminho absoluto aceito (ex.: `isRuleContextPath`). */
  readonly isPathAllowed: (path: string) => boolean;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function depthOf(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depthOf));
  if (value !== null && typeof value === 'object') {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

/**
 * Inspeciona a expressão inteira e devolve TODOS os problemas (não para no primeiro): operação
 * proibida ou desconhecida, caminho fora do contexto, caminho dinâmico, objeto que não é operação,
 * profundidade > 20 e tamanho > 10 KB.
 */
export function inspectJsonLogic(
  expression: unknown,
  options: JsonLogicInspectOptions,
): JsonLogicInspection {
  const issues: JsonLogicIssue[] = [];
  const paths: string[] = [];
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(expression);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return { issues: [{ kind: 'INVALID', detail: 'a expressão não é JSON válido' }], paths };
  }
  if (byteLength(serialized) > JSON_LOGIC_MAX_BYTES) {
    issues.push({ kind: 'INVALID', detail: 'a expressão excede 10 KB' });
  }
  if (depthOf(expression) > JSON_LOGIC_MAX_DEPTH) {
    issues.push({ kind: 'INVALID', detail: `a expressão excede ${JSON_LOGIC_MAX_DEPTH} níveis` });
    return { issues, paths };
  }

  const checkPath = (path: unknown, scoped: boolean) => {
    if (scoped) return;
    if (typeof path !== 'string' || path === '') {
      issues.push({ kind: 'PATH_UNKNOWN', detail: 'caminho dinâmico ou vazio não é permitido' });
      return;
    }
    paths.push(path);
    if (!options.isPathAllowed(path)) {
      issues.push({
        kind: 'PATH_UNKNOWN',
        detail: `o campo ${path} não pertence ao contexto de regras (RuleContext v1)`,
      });
    }
  };

  const visit = (node: unknown, scoped: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, scoped);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const entries = Object.entries(node);
    if (entries.length !== 1) {
      issues.push({ kind: 'INVALID', detail: 'objeto que não é uma operação' });
      return;
    }
    const [operation, rawArgs] = entries[0] as [string, unknown];
    if (!ALLOWED.has(operation)) {
      issues.push({
        kind: 'OPERATOR_FORBIDDEN',
        detail: `a operação ${operation} não é permitida`,
      });
      return;
    }
    const args: readonly unknown[] = Array.isArray(rawArgs) ? (rawArgs as unknown[]) : [rawArgs];
    if (operation === 'var') {
      const [path, fallback] = args;
      if (path !== null && typeof path === 'object') {
        issues.push({ kind: 'PATH_UNKNOWN', detail: 'caminho dinâmico não é permitido' });
        visit(path, scoped);
      } else if (!scoped) {
        checkPath(typeof path === 'number' ? String(path) : path, scoped);
      }
      visit(fallback, scoped);
      return;
    }
    if (operation === 'missing') {
      const list = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
      for (const path of list) checkPath(path, scoped);
      return;
    }
    if (operation === 'missing_some') {
      const [minimum, list] = args;
      visit(minimum, scoped);
      if (Array.isArray(list)) for (const path of list) checkPath(path, scoped);
      else issues.push({ kind: 'INVALID', detail: 'missing_some exige uma lista de campos' });
      return;
    }
    if (ITERATORS.has(operation)) {
      const [source, logic, ...rest] = args;
      visit(source, scoped);
      visit(logic, true);
      for (const item of rest) visit(item, scoped);
      return;
    }
    for (const item of args) visit(item, scoped);
  };

  visit(expression, false);
  return { issues, paths };
}
