import type { ToConfirmCategory } from '@contrataflow/validation';

import type { SanitizedContext } from './context-sanitizer.js';

/*
 * `FactSet` e `FactNormalizer` (US-122 · RN-AI-54): o conjunto de fatos das ENTRADAS da geração (o
 * contexto já sanitizado — RN-AI-05) e o reconhecimento, no texto em pt-BR, dos trechos que o
 * GroundingGuard confere — valor monetário, quantidade com unidade, prazo/duração, data e
 * percentual. Tudo normalizado para comparar forma com forma: valores em centavos, durações em
 * dias/meses, datas em ISO, algarismos ("1.200", "1,5") e numerais por extenso comuns ("dez",
 * "trinta e cinco", "mil e quinhentos"). Citações legais (lei, artigo, parágrafo, inciso, alínea)
 * são reconhecidas para ficarem de fora. Determinístico, sem chamada externa e sem log; o conjunto
 * não é persistido (só `contextHash`/`inputRefs` ficam na geração).
 */

/** Tipo do trecho reconhecido (ordem = prioridade quando dois começam no mesmo ponto). */
export type FactKind = 'CITATION' | 'MONEY' | 'DATE' | 'PERCENT' | 'DURATION' | 'QUANTITY';

export interface FactMatch {
  readonly kind: FactKind;
  readonly start: number;
  readonly end: number;
  /** Chaves normalizadas do trecho (ex.: `c:8000000`, `d:90`, `m:12`, `2026-03-15`). */
  readonly keys: readonly string[];
}

/** Categoria do `toConfirm` por tipo de fato (entities.md §5.10: percentual → `VALUE`). */
export const CATEGORY_OF: Readonly<Record<Exclude<FactKind, 'CITATION'>, ToConfirmCategory>> = {
  MONEY: 'VALUE',
  PERCENT: 'VALUE',
  QUANTITY: 'QUANTITY',
  DURATION: 'DEADLINE',
  DATE: 'DATE',
};

// --- Números (algarismos e por extenso) ----------------------------------------------------------

const UNITS: Readonly<Record<string, number>> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  três: 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  duzentas: 200,
  trezentos: 300,
  trezentas: 300,
  quatrocentos: 400,
  quatrocentas: 400,
  quinhentos: 500,
  quinhentas: 500,
  seiscentos: 600,
  seiscentas: 600,
  setecentos: 700,
  setecentas: 700,
  oitocentos: 800,
  oitocentas: 800,
  novecentos: 900,
  novecentas: 900,
};

/*
 * "um"/"uma" sozinhos são quase sempre artigo ("uma unidade de saúde"): só valem dentro de um
 * numeral composto ("vinte e um", "mil e uma"). "mil" multiplica.
 */
const HEAD_WORDS = Object.keys(UNITS)
  .filter((word) => word !== 'um' && word !== 'uma')
  .sort((a, b) => b.length - a.length);
const ALL_WORDS = [...Object.keys(UNITS), 'mil'].sort((a, b) => b.length - a.length);
const HEAD = `(?:${[...HEAD_WORDS, 'mil'].join('|')})`;
const ANY_WORD = `(?:${ALL_WORDS.join('|')})`;
/** Numeral por extenso: "dez", "trinta e cinco", "mil e quinhentos", "dez mil". */
const SPELLED = `${HEAD}(?![\\p{L}\\d])(?:\\s+(?:e\\s+)?${ANY_WORD}(?![\\p{L}\\d]))*`;
/** Algarismos pt-BR: "1.200", "1.234,56", "12", "1,5". */
const DIGITS = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?`;
/** Número com extenso opcional entre parênteses ("10 (dez)") ou só por extenso. */
const NUMBER = `(?:(?:${DIGITS})(?:\\s*\\((?:${SPELLED}|${DIGITS})\\))?|${SPELLED})`;

const BEFORE = String.raw`(?<![\p{L}\d])`;
const AFTER = String.raw`(?![\p{L}\d])`;

/** Algarismos pt-BR → número ("1.234,56" → 1234.56; "1.200" → 1200); `null` se não for número. */
export function parseDigits(raw: string): number | null {
  const text = raw.trim();
  let normalized: string;
  if (text.includes(',')) normalized = text.replaceAll('.', '').replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(text)) normalized = text.replaceAll('.', '');
  else normalized = text;
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/** Numeral por extenso → número ("trinta e cinco" → 35, "dez mil" → 10000); `null` se não for. */
export function parseSpelled(raw: string): number | null {
  const words = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '' && word !== 'e');
  if (words.length === 0) return null;
  let total = 0;
  let current = 0;
  for (const word of words) {
    if (word === 'mil') {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      continue;
    }
    const value = UNITS[word];
    if (value === undefined) return null;
    current += value;
  }
  return total + current;
}

/** Primeiro número do trecho (os algarismos, se houver; senão o extenso). */
function leadingNumber(text: string): number | null {
  const digits = new RegExp(`^(?:${DIGITS})`).exec(text);
  if (digits) return parseDigits(digits[0]);
  const spelled = new RegExp(`^${SPELLED}`, 'iu').exec(text);
  return spelled ? parseSpelled(spelled[0]) : null;
}

/** Chave estável de um número (até 3 casas). */
export function numberKey(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

// --- Reconhecedores ------------------------------------------------------------------------------

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

const MONTH_NUMBER: Readonly<Record<string, number>> = {
  janeiro: 1,
  fevereiro: 2,
  março: 3,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const QUANTITY_UNITS = [
  'unidades?',
  'un\\.',
  'itens',
  'item',
  'pe[çc]as?',
  'kg',
  'quilos?',
  'quilogramas?',
  'gramas?',
  'toneladas?',
  'litros?',
  'ml',
  'm²',
  'm³',
  'm2',
  'm3',
  'metros?(?:\\s+(?:quadrados|c[úu]bicos|lineares))?',
  'km',
  'quil[ôo]metros?',
  'caixas?',
  'pacotes?',
  'fardos?',
  'resmas?',
  'kits?',
  'conjuntos?',
  'lotes?',
  'licen[çc]as?',
  'equipamentos?',
  'computadores?',
  'notebooks?',
  'tablets?',
  'impressoras?',
  've[íi]culos?',
  'cadeiras?',
  'mesas?',
  'servidores?',
  'pessoas?',
  'alunos?',
  'profissionais',
  'profissional',
  'postos?',
  'refei[çc][õo]es',
  'refei[çc][ãa]o',
  'cestas?',
  'doses?',
  'frascos?',
  'ampolas?',
  'comprimidos?',
  'rolos?',
  'sacos?',
  'gal[õo]es',
  'gal[ãa]o',
  'diárias',
  'diária',
];

const PATTERNS: readonly { readonly kind: FactKind; readonly regex: RegExp }[] = [
  {
    kind: 'CITATION',
    regex: new RegExp(
      String.raw`${BEFORE}(?:arts?\.|artigos?|§{1,2}|par[áa]grafos?|incisos?|al[íi]neas?|leis?(?:\s+complementar)?|decretos?(?:-lei)?|portarias?|resolu[çc][ãa]o|instru[çc][ãa]o\s+normativa)\s*(?:n[º°o]?\.?\s*)?(?:\d[\w.\/º°ª-]*|[IVXLCDM]+${AFTER}|[a-z]\)?(?=[\s,.;)]|$))`,
      'giu',
    ),
  },
  {
    kind: 'MONEY',
    regex: new RegExp(
      String.raw`R\$\s*(?:${DIGITS})(?:\s+(?:mil|milh[ãa]o|milh[õo]es|bilh[ãa]o|bilh[õo]es)${AFTER})?|${BEFORE}${NUMBER}\s+(?:(?:mil|milh[ãa]o|milh[õo]es)\s+)?(?:de\s+)?reais${AFTER}`,
      'giu',
    ),
  },
  {
    kind: 'DATE',
    regex: new RegExp(
      String.raw`${BEFORE}(?:\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}º?\s+de\s+(?:${MONTHS.join('|')})\s+de\s+\d{4})${AFTER}`,
      'giu',
    ),
  },
  {
    kind: 'PERCENT',
    regex: new RegExp(String.raw`${BEFORE}${NUMBER}\s*(?:%|por\s+cento${AFTER})`, 'giu'),
  },
  {
    kind: 'DURATION',
    regex: new RegExp(
      String.raw`${BEFORE}${NUMBER}\s+(?:dias?(?:\s+(?:[úu]teis|corridos))?|semanas?|m[êe]s|meses|anos?|horas?)${AFTER}`,
      'giu',
    ),
  },
  {
    kind: 'QUANTITY',
    regex: new RegExp(
      String.raw`${BEFORE}${NUMBER}\s*(?:de\s+)?(?:${QUANTITY_UNITS.join('|')})${AFTER}`,
      'giu',
    ),
  },
];

const PRIORITY: Readonly<Record<FactKind, number>> = {
  CITATION: 0,
  MONEY: 1,
  DATE: 2,
  PERCENT: 3,
  DURATION: 4,
  QUANTITY: 5,
};

const MULTIPLIERS: readonly [RegExp, number][] = [
  [/bilh/i, 1e9],
  [/milh/i, 1e6],
  [/\bmil\b/i, 1e3],
];

function moneyKeys(text: string): string[] {
  const amount = text.includes('R$')
    ? parseDigits(new RegExp(DIGITS).exec(text.replace(/^R\$\s*/, ''))?.[0] ?? '')
    : leadingNumber(text);
  if (amount === null) return [];
  const tail = text.includes('R$')
    ? text.replace(new RegExp(`^R\\$\\s*(?:${DIGITS})`), '')
    : text.replace(new RegExp(`^${NUMBER}`, 'iu'), '');
  const multiplier = MULTIPLIERS.find(([regex]) => regex.test(tail))?.[1] ?? 1;
  return [`c:${String(Math.round(amount * multiplier * 100))}`];
}

function dateKeys(text: string): string[] {
  const pad = (value: number) => String(value).padStart(2, '0');
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slash) return [`${slash[3] ?? ''}-${pad(Number(slash[2]))}-${pad(Number(slash[1]))}`];
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return [text];
  const spelled = /^(\d{1,2})º?\s+de\s+(\S+)\s+de\s+(\d{4})$/iu.exec(text);
  const month = MONTH_NUMBER[spelled?.[2]?.toLowerCase() ?? ''];
  if (spelled && month !== undefined) {
    return [`${spelled[3] ?? ''}-${pad(month)}-${pad(Number(spelled[1]))}`];
  }
  return [];
}

/** Durações normalizadas em dias e meses (30 dias = 1 mês; 1 ano = 12 meses = 365 dias). */
export function durationKeys(amount: number, unit: string): string[] {
  const lower = unit.toLowerCase();
  if (lower.startsWith('dia')) {
    return [
      `d:${numberKey(amount)}`,
      ...(amount % 30 === 0 ? [`m:${numberKey(amount / 30)}`] : []),
    ];
  }
  if (lower.startsWith('semana')) return [`d:${numberKey(amount * 7)}`];
  if (lower.startsWith('m')) return [`m:${numberKey(amount)}`, `d:${numberKey(amount * 30)}`];
  if (lower.startsWith('ano')) {
    return [`m:${numberKey(amount * 12)}`, `d:${numberKey(amount * 365)}`];
  }
  return [`h:${numberKey(amount)}`];
}

function keysOf(kind: FactKind, text: string): string[] {
  switch (kind) {
    case 'CITATION':
      return [];
    case 'MONEY':
      return moneyKeys(text);
    case 'DATE':
      return dateKeys(text);
    case 'PERCENT': {
      const value = leadingNumber(text);
      return value === null ? [] : [`p:${numberKey(value)}`];
    }
    case 'DURATION': {
      const value = leadingNumber(text);
      const unit = /(dias?|semanas?|m[êe]s|meses|anos?|horas?)/iu.exec(text)?.[1] ?? 'dia';
      return value === null ? [] : durationKeys(value, unit);
    }
    case 'QUANTITY': {
      const value = leadingNumber(text);
      return value === null ? [] : [`q:${numberKey(value)}`];
    }
  }
}

/**
 * `FactNormalizer`: trechos reconhecidos no texto, sem sobreposição — o que começa antes vence; no
 * mesmo ponto, a citação legal e depois o tipo mais específico (valor > data > percentual > prazo >
 * quantidade).
 */
export function findFacts(text: string): FactMatch[] {
  const candidates: FactMatch[] = [];
  for (const { kind, regex } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      if (match[0].trim() === '') continue;
      candidates.push({
        kind,
        start: match.index,
        end: match.index + match[0].length,
        keys: keysOf(kind, match[0]),
      });
    }
  }
  candidates.sort(
    (a, b) => a.start - b.start || PRIORITY[a.kind] - PRIORITY[b.kind] || b.end - a.end,
  );
  const taken: FactMatch[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    taken.push(candidate);
    cursor = candidate.end;
  }
  return taken;
}

const BARE_NUMBER = new RegExp(`${BEFORE}(?:${DIGITS}|${SPELLED})${AFTER}`, 'giu');
const DURATION_KEY = /dias|days|prazo|deadline|dura[cç][aã]o|duration|vig[eê]ncia|validade/i;
const MONTH_KEY = /mes|meses|month|vig[eê]ncia|prazo|deadline|dura[cç][aã]o|duration/i;
const PERCENT_KEY = /percent|percentual|taxa|rate|aliquota|al[ií]quota/i;
const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:T|$)/;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Conjunto de fatos das entradas, normalizado (RN-AI-54). */
export class FactSet {
  private readonly keys = new Set<string>();

  /** Fatos do contexto sanitizado que a IA recebeu. */
  static fromContext(context: Pick<SanitizedContext, 'parts'>): FactSet {
    const facts = new FactSet();
    for (const part of context.parts) facts.collect(part.data, null);
    return facts;
  }

  /** Fatos de valores soltos (testes e reuso). */
  static of(...values: unknown[]): FactSet {
    const facts = new FactSet();
    for (const value of values) facts.collect(value, null);
    return facts;
  }

  /** O trecho reconhecido é sustentado pelas entradas (citação legal sempre). */
  supports(match: FactMatch): boolean {
    if (match.kind === 'CITATION') return true;
    return match.keys.some((key) => this.keys.has(key));
  }

  /** Só para depuração de testes: quantas chaves o conjunto tem. */
  get size(): number {
    return this.keys.size;
  }

  /**
   * Número de campo estruturado: sustenta a mesma quantidade em qualquer unidade e o valor
   * monetário em reais (o valor estimado vem da pesquisa de preços como número); prazo e
   * percentual só pelo nome do campo.
   */
  private addNumber(value: number, key: string): void {
    const normalized = numberKey(value);
    this.keys.add(`q:${normalized}`);
    this.keys.add(`c:${String(Math.round(value * 100))}`);
    if (DURATION_KEY.test(key)) this.keys.add(`d:${normalized}`);
    if (MONTH_KEY.test(key)) this.keys.add(`m:${normalized}`);
    if (PERCENT_KEY.test(key)) this.keys.add(`p:${normalized}`);
  }

  private collectText(text: string): void {
    for (const match of findFacts(text)) {
      for (const key of match.keys) this.keys.add(key);
      if (match.kind === 'DATE') {
        for (const key of match.keys) this.keys.add(`q:${String(Number(key.slice(0, 4)))}`);
      }
    }
    for (const match of text.matchAll(BARE_NUMBER)) {
      const value = parseDigits(match[0]) ?? parseSpelled(match[0]);
      if (value !== null) this.keys.add(`q:${numberKey(value)}`);
    }
  }

  private collect(value: unknown, key: string | null): void {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) this.addNumber(value, key ?? '');
      return;
    }
    if (typeof value === 'string') {
      const iso = ISO_DATE.exec(value);
      if (iso?.[1]) {
        this.keys.add(iso[1]);
        this.keys.add(`q:${String(Number(iso[1].slice(0, 4)))}`);
        return;
      }
      if (DECIMAL.test(value.trim())) {
        this.addNumber(Number(value.trim()), key ?? '');
        return;
      }
      this.collectText(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.collect(item, key);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, child] of Object.entries(value)) this.collect(child, childKey);
    }
  }
}
