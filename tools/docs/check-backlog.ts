/**
 * Verificador do backlog (docs/backlog + docs/mvp-NN/features.md).
 * Uso: pnpm docs:check [raiz-docs]
 * Regras: front matter, id x arquivo, 28 seções do template em ordem, 8 categorias Gherkin,
 * referências (epic/feature/depends_on), cobertura em features.md por MVP e IDs sem duplicidade.
 * Linha de tabela com ⏳ em features.md = card reservado ainda não escrito: o arquivo pode faltar,
 * mas, depois de escrito, a marca precisa sair da linha.
 * Endpoints e telas: todo código em `endpoints:`/`screens:` de uma story precisa ter ficha
 * (`### CÓDIGO`) em algum `mvp-NN/api/*.md`/`mvp-NN/screens.md`, e toda ficha precisa ser citada
 * por ao menos uma story no MVP em que aparece pela primeira vez (só quando esses documentos existem).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export interface Problem {
  file: string;
  rule: string;
  message: string;
}

/** Desvio real do MVP 1 aceito de forma explícita (vale só para mvp: 1). */
export interface Exception {
  file: string;
  rule: string;
  reason: string;
}

export const MVP1_EXCEPTIONS: readonly Exception[] = [
  {
    file: 'mvp-01/api/15-platform-health.md',
    rule: 'endpoint-orfao',
    reason:
      'PLT-08 (corrigir dados do tenant) tem contrato no MVP 1 sem story própria; fora da FT-083 (US-179, lacuna 10).',
  },
];

export const STORY_FIELDS = [
  'id',
  'title',
  'epic',
  'feature',
  'mvp',
  'priority',
  'estimate',
  'status',
  'depends_on',
  'modules',
  'screens',
  'endpoints',
  'permissions',
  'events',
] as const;

export const CATEGORIES = [
  'Sucesso',
  'Validação',
  'Permissão',
  'Tenant incorreto',
  'Duplicidade',
  'Concorrência',
  'Falha de banco',
  'Falha de integração',
] as const;

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ESTIMATES = ['XS', 'S', 'M', 'L', 'XL'];
const GHERKIN_SECTION = 'Critérios de aceite em Gherkin';

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function splitFrontMatter(text: string): { data: Record<string, unknown> | null; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: null, body: text };
  try {
    const data = parse(m[1] ?? '') as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return { data: data as Record<string, unknown>, body: m[2] ?? '' };
    }
  } catch {
    // front matter inválido cai no retorno nulo
  }
  return { data: null, body: m[2] ?? '' };
}

/** Títulos `## ` fora de blocos de código. */
function sections(body: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  let fence = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    const h = !fence ? /^## (.+?)\s*$/.exec(line) : null;
    if (h) out.push({ title: h[1] ?? '', text: '' });
    else {
      const last = out.at(-1);
      if (last)
        last.text += `${line}
`;
    }
  }
  return out;
}

function templateSections(backlog: string): string[] {
  const t = join(backlog, '_templates', 'story-template.md');
  return sections(splitFrontMatter(read(t)).body).map((s) => s.title);
}

function templateStatuses(backlog: string): string[] {
  const t = read(join(backlog, '_templates', 'story-template.md'));
  const m = /^status:\s*\S+\s*#\s*(.+)$/m.exec(t);
  return m ? (m[1] ?? '').split('|').map((s) => s.trim()) : [];
}

function listFiles(dir: string, re: RegExp): string[] {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
    : [];
}

/** IDs definidos como primeira célula de linha de tabela (`| US-001 |`, `| FT-001 Título |`, `| EP-001 Título |`). */
function tableIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*((?:EP|FT|US)-\d{3})\b/.exec(line);
    if (m) ids.push(m[1] ?? '');
  }
  return ids;
}

/** Marca de card reservado e ainda não escrito (linha de tabela em features.md). */
export const PENDING_MARK = '⏳';

/** Arquivos citados em linhas de tabela; `pending` quando a linha traz ⏳ (card ainda não escrito). */
function fileRefs(
  text: string,
  kind: 'story' | 'feature' | 'epic',
): { file: string; pending: boolean }[] {
  const re = new RegExp(`\`(${kind}-\\d{3}-[a-z0-9-]+\\.md)\``, 'g');
  const refs: { file: string; pending: boolean }[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const pending = line.includes(PENDING_MARK);
    for (const m of line.matchAll(re)) refs.push({ file: m[1] ?? '', pending });
  }
  return refs;
}

export function checkBacklog({ root }: { root: string }): Problem[] {
  const problems: Problem[] = [];
  const add = (file: string, rule: string, message: string): void => {
    problems.push({ file, rule, message });
  };
  const backlog = join(root, 'backlog');
  const stories = listFiles(backlog, /^story-\d{3}-.+\.md$/);
  const features = listFiles(backlog, /^feature-\d{3}-.+\.md$/);
  const epics = listFiles(backlog, /^epic-\d{3}-.+\.md$/);
  const num = (f: string): string => /-(\d{3})-/.exec(f)?.[1] ?? '';

  const tplSections = templateSections(backlog);
  const tplStatuses = templateStatuses(backlog);

  // Unicidade de número de arquivo.
  for (const [kind, files] of [
    ['story', stories],
    ['feature', features],
    ['epic', epics],
  ] as const) {
    const seen = new Map<string, string>();
    for (const f of files) {
      const n = num(f);
      const prev = seen.get(n);
      if (prev) add(`backlog/${f}`, 'id-duplicado', `${kind} ${n} também existe em ${prev}`);
      else seen.set(n, f);
    }
  }
  const hasNum = (files: string[], n: string): boolean => files.some((f) => num(f) === n);

  // Stories reservadas (⏳) em algum features.md: podem ser citadas em depends_on antes de existirem.
  const reservedStories = new Set<string>();
  for (const d of listFiles(root, /^mvp-\d{2}$/)) {
    const p = join(root, d, 'features.md');
    if (!existsSync(p)) continue;
    for (const r of fileRefs(read(p), 'story')) if (r.pending) reservedStories.add(num(r.file));
  }

  const storyRefs: { rel: string; endpoints: string[]; screens: string[] }[] = [];
  const storyMvp = new Map<string, number>();
  const featureMvp = new Map<string, number>();
  const epicMvp = new Map<string, number>();
  const idSeen = new Map<string, string>();

  for (const f of stories) {
    const rel = `backlog/${f}`;
    const text = read(join(backlog, f));
    const { data, body } = splitFrontMatter(text);
    if (!data) {
      add(rel, 'front-matter', 'front matter YAML ausente ou inválido');
      continue;
    }
    for (const k of STORY_FIELDS) {
      if (!(k in data)) add(rel, 'front-matter', `campo ausente: ${k}`);
    }
    for (const k of Object.keys(data)) {
      if (!(STORY_FIELDS as readonly string[]).includes(k))
        add(rel, 'front-matter', `campo inesperado: ${k}`);
    }
    if (typeof data.mvp !== 'number') add(rel, 'front-matter', 'mvp deve ser número');
    else storyMvp.set(f, data.mvp);
    if (!PRIORITIES.includes(String(data.priority)))
      add(rel, 'front-matter', `priority inválida: ${String(data.priority)}`);
    if (!ESTIMATES.includes(String(data.estimate)))
      add(rel, 'front-matter', `estimate inválida: ${String(data.estimate)}`);
    if (!tplStatuses.includes(String(data.status)))
      add(rel, 'front-matter', `status inválido: ${String(data.status)}`);
    for (const k of ['depends_on', 'modules', 'screens', 'endpoints', 'permissions', 'events']) {
      if (k in data && !Array.isArray(data[k])) add(rel, 'front-matter', `${k} deve ser lista`);
    }
    const list = (k: string): string[] =>
      Array.isArray(data[k]) ? (data[k] as unknown[]).map((x) => String(x)) : [];
    storyRefs.push({ rel, endpoints: list('endpoints'), screens: list('screens') });

    const n = num(f);
    const id = String(data.id);
    if (id !== `US-${n}`) add(rel, 'id', `id ${id} difere do número do arquivo (esperado US-${n})`);
    const prev = idSeen.get(id);
    if (prev) add(rel, 'id-duplicado', `id ${id} já usado em ${prev}`);
    else idSeen.set(id, f);

    const ep = /^EP-(\d{3})$/.exec(String(data.epic));
    if (!ep || !hasNum(epics, ep[1] ?? ''))
      add(rel, 'referencia', `epic ${String(data.epic)} sem arquivo epic-NNN-*.md`);
    const ft = /^FT-(\d{3})$/.exec(String(data.feature));
    if (!ft || !hasNum(features, ft[1] ?? ''))
      add(rel, 'referencia', `feature ${String(data.feature)} sem arquivo feature-NNN-*.md`);
    for (const d of Array.isArray(data.depends_on) ? data.depends_on : []) {
      const m = /^US-(\d{3})$/.exec(String(d));
      if (!m || !(hasNum(stories, m[1] ?? '') || reservedStories.has(m[1] ?? '')))
        add(rel, 'referencia', `depends_on ${String(d)} sem arquivo story-NNN-*.md`);
    }

    // Seções: as do template, na ordem (extras toleradas).
    const secs = sections(body);
    let cursor = 0;
    for (const want of tplSections) {
      const at = secs.findIndex((s, i) => i >= cursor && s.title === want);
      if (at < 0) {
        const anywhere = secs.some((s) => s.title === want);
        add(rel, 'secao', anywhere ? `seção fora de ordem: ${want}` : `seção ausente: ${want}`);
      } else cursor = at + 1;
    }

    // Gherkin.
    const g = secs.find((s) => s.title === GHERKIN_SECTION);
    if (g) {
      const scenarios = g.text.split('\n').filter((l) => /^\s*Scenario( Outline)?:/.test(l));
      for (const c of CATEGORIES) {
        if (!scenarios.some((l) => l.includes(`[${c}]`)))
          add(rel, 'gherkin', `categoria sem cenário: [${c}]`);
      }
    }
  }

  // Features e épicos: front matter mínimo (mvp) para mapear ao MVP.
  for (const [files, map, prefix] of [
    [features, featureMvp, 'FT'],
    [epics, epicMvp, 'EP'],
  ] as const) {
    for (const f of files) {
      const rel = `backlog/${f}`;
      const { data } = splitFrontMatter(read(join(backlog, f)));
      if (!data) {
        add(rel, 'front-matter', 'front matter YAML ausente ou inválido');
        continue;
      }
      const id = String(data.id);
      if (id !== `${prefix}-${num(f)}`)
        add(rel, 'id', `id ${id} difere do número do arquivo (esperado ${prefix}-${num(f)})`);
      if (typeof data.mvp !== 'number') add(rel, 'front-matter', 'mvp deve ser número');
      else map.set(f, data.mvp);
    }
  }

  // Cobertura em features.md por MVP e IDs entre MVPs.
  const mvpDirs = listFiles(root, /^mvp-\d{2}$/);
  const definedIn = new Map<string, string>();
  for (const d of mvpDirs) {
    const mvp = Number(d.slice(4));
    const featRel = `${d}/features.md`;
    const featPath = join(root, d, 'features.md');
    const ownFiles = (files: string[], map: Map<string, number>): string[] =>
      files.filter((f) => map.get(f) === mvp);
    if (existsSync(featPath)) {
      const text = read(featPath);
      for (const [kind, files, map] of [
        ['story', stories, storyMvp],
        ['feature', features, featureMvp],
        ['epic', epics, epicMvp],
      ] as const) {
        const refs = fileRefs(text, kind);
        const cited = new Set(refs.map((r) => r.file));
        for (const f of ownFiles(files, map)) {
          if (!cited.has(f)) add(featRel, 'cobertura', `${f} (mvp ${mvp}) sem linha em ${featRel}`);
        }
        for (const r of refs) {
          const exists = files.includes(r.file);
          if (!exists && !r.pending)
            add(featRel, 'cobertura', `linha aponta para arquivo inexistente: ${r.file}`);
          else if (exists && r.pending)
            add(featRel, 'pendente', `${r.file} já existe; remova ${PENDING_MARK} da linha`);
        }
      }
    } else if (ownFiles(stories, storyMvp).length + ownFiles(features, featureMvp).length > 0) {
      add(featRel, 'cobertura', `arquivo ausente, mas há cards do mvp ${mvp} em backlog/`);
    }
    for (const doc of ['features.md', 'epics.md']) {
      const p = join(root, d, doc);
      if (!existsSync(p)) continue;
      const own = new Set<string>();
      for (const id of tableIds(read(p))) {
        if (own.has(id) && doc === 'features.md' && id.startsWith('EP-')) continue;
        own.add(id);
      }
      for (const id of own) {
        const prev = definedIn.get(id);
        if (prev && prev.split('/')[0] !== d)
          add(`${d}/${doc}`, 'id-duplicado', `${id} também definido em ${prev}`);
        else if (!prev) definedIn.set(id, `${d}/${doc}`);
      }
    }
  }
  // Duplicidade dentro do mesmo arquivo (stories e features não se repetem em linha própria).
  for (const d of mvpDirs) {
    const p = join(root, d, 'features.md');
    if (!existsSync(p)) continue;
    const count = new Map<string, number>();
    for (const id of tableIds(read(p)))
      if (!id.startsWith('EP-')) count.set(id, (count.get(id) ?? 0) + 1);
    for (const [id, c] of count) {
      if (c > 1) add(`${d}/features.md`, 'id-duplicado', `${id} aparece em ${c} linhas`);
    }
  }

  checkEndpointsAndScreens(root, mvpDirs, storyRefs, add);
  return problems;
}

/** Primeira ocorrência de cada ficha `### CÓDIGO` por MVP (o diretório mais antigo é a "casa"). */
function headings(
  root: string,
  mvpDirs: string[],
  files: (d: string) => string[],
  re: RegExp,
): Map<string, string> {
  const home = new Map<string, string>();
  for (const d of mvpDirs) {
    for (const rel of files(d)) {
      for (const line of read(join(root, rel)).split('\n')) {
        const m = re.exec(line);
        if (m?.[1] && !home.has(m[1])) home.set(m[1], rel);
      }
    }
  }
  return home;
}

function checkEndpointsAndScreens(
  root: string,
  mvpDirs: string[],
  storyRefs: { rel: string; endpoints: string[]; screens: string[] }[],
  add: (file: string, rule: string, message: string) => void,
): void {
  const endpointHome = headings(
    root,
    mvpDirs,
    (d) => listFiles(join(root, d, 'api'), /\.md$/).map((f) => `${d}/api/${f}`),
    /^### ([A-Z]{2,5}-\d{2,3})\b/,
  );
  const screenHome = headings(
    root,
    mvpDirs,
    (d) => (existsSync(join(root, d, 'screens.md')) ? [`${d}/screens.md`] : []),
    /^### (SCR-\d{3})\b/,
  );
  const citedEndpoints = new Set<string>();
  const citedScreens = new Set<string>();
  for (const r of storyRefs) {
    for (const e of r.endpoints) {
      citedEndpoints.add(e);
      if (endpointHome.size > 0 && !endpointHome.has(e))
        add(r.rel, 'endpoint', `endpoint ${e} sem ficha em nenhum mvp-NN/api/*.md`);
    }
    for (const s of r.screens) {
      citedScreens.add(s);
      if (screenHome.size > 0 && !screenHome.has(s))
        add(r.rel, 'tela', `tela ${s} sem ficha em nenhum mvp-NN/screens.md`);
    }
  }
  for (const [code, file] of endpointHome) {
    if (!citedEndpoints.has(code))
      add(file, 'endpoint-orfao', `${code} não aparece em endpoints: de nenhuma story`);
  }
  for (const [scr, file] of screenHome) {
    if (!citedScreens.has(scr))
      add(file, 'tela-orfa', `${scr} não aparece em screens: de nenhuma story`);
  }
}

/** Remove problemas cobertos por exceções declaradas (só MVP 1). */
export function applyExceptions(
  problems: Problem[],
  exceptions: readonly Exception[] = MVP1_EXCEPTIONS,
): Problem[] {
  return problems.filter((p) => !exceptions.some((e) => p.file === e.file && p.rule === e.rule));
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(process.argv[2] ?? join(here, '..', '..', 'docs'));
  const problems = applyExceptions(checkBacklog({ root }));
  if (problems.length === 0) {
    console.log('docs:check: nenhum problema');
    return;
  }
  for (const p of problems) console.error(`${p.file}: [${p.rule}] ${p.message}`);
  console.error(`docs:check: ${problems.length} problema(s)`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
