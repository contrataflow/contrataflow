/** Regra do CODEOWNERS: padrão no estilo gitignore e donos. A última regra que casa vence. */
export interface CodeownersRule {
  readonly line: number;
  readonly pattern: string;
  readonly owners: readonly string[];
  readonly regex: RegExp;
}

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Converte um padrão do CODEOWNERS (sem `!` nem `[]`, como no GitHub) em expressão regular. */
export function patternToRegExp(pattern: string): RegExp {
  let body = pattern;
  const anchored = body.startsWith('/') || body.slice(0, -1).includes('/');
  body = body.replace(/^\//, '');
  const directory = body.endsWith('/');
  body = body.replace(/\/$/, '');

  const segments = body.split('/');
  const source = segments
    .map((segment, index) => {
      const last = index === segments.length - 1;
      if (segment === '**') return last ? '.*' : '(?:.*/)?';
      const glob = escapeRegex(segment).replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
      return last ? glob : `${glob}/`;
    })
    .join('');

  const prefix = anchored ? '^' : '^(?:.*/)?';
  const suffix = directory ? '/.*$' : '(?:/.*)?$';
  return new RegExp(`${prefix}${source}${suffix}`);
}

export function parseCodeowners(text: string): CodeownersRule[] {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const content = raw.replace(/(^|\s)#.*$/, '').trim();
    if (content === '') return [];
    const [pattern, ...owners] = content.split(/\s+/);
    if (pattern === undefined) return [];
    return [{ line: index + 1, pattern, owners, regex: patternToRegExp(pattern) }];
  });
}

/** Donos de um caminho relativo à raiz (`apps/api/src/...`). */
export function ownersOf(rules: readonly CodeownersRule[], filePath: string): readonly string[] {
  const normalized = filePath.replace(/^\//, '');
  let owners: readonly string[] = [];
  for (const rule of rules) {
    if (rule.regex.test(normalized)) owners = rule.owners;
  }
  return owners;
}
