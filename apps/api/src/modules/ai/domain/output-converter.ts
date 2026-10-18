import type {
  AiGenerationOutput,
  AiOutputSection,
  AiOutputWarning,
  RichTextNode,
  ToConfirmCategory,
} from '@contrataflow/validation';
import type { z } from 'zod';

import { structuredResponseSchema } from './structured-output.js';
import type { StructuredBlock, StructuredResponse } from './structured-output.js';

/*
 * `OutputConverter` (RN-AI-07 · entities.md §5.10): valida a resposta do provedor (JSON conforme o
 * schema do gerador) e converte cada seção para TipTap só com os nós permitidos — parágrafo,
 * títulos 3–4, listas, negrito, itálico, tabela simples e o nó em linha `toConfirm` (US-122). Seção
 * acima de `maxChars`, seção desconhecida, repetida ou faltando conta como saída inválida (uma
 * tentativa de reparo; persistindo, `FAILED`/`OUTPUT_INVALID`). Os problemas descrevem só caminhos
 * e códigos — nunca o texto gerado.
 */

/** Seção pedida ao provedor (do template do documento). */
export interface SectionSpec {
  readonly sectionKey: string;
  readonly title: string;
  /** Padrão de `SectionDefinition.maxChars` (entities.md §5.1): 50.000. */
  readonly maxChars: number;
  readonly legalBasis?: string | null;
  /** Seção `OPTIONAL` sem base nas entradas pode vir ausente na resposta (FA-08 da US-117). */
  readonly optional?: boolean;
}

export const DEFAULT_SECTION_MAX_CHARS = 50_000;

/** Categorias do nó `toConfirm` (contrato em `@contrataflow/validation` — RN-AI-53). */
export type { ToConfirmCategory };

export interface ConversionSpec {
  readonly sections: readonly SectionSpec[];
  /** Schema do gerador (padrão: o comum). */
  readonly schema?: z.ZodType<StructuredResponse>;
  /** Avisos já conhecidos (sanitização) somados à proposta. */
  readonly warnings?: readonly AiOutputWarning[];
}

export type ConversionResult =
  | { readonly ok: true; readonly output: AiGenerationOutput }
  | { readonly ok: false; readonly issues: readonly string[] };

const TO_CONFIRM = /\[a confirmar(?:\s*:\s*([^\]]{0,200}))?\]/gi;
const EMPHASIS = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
const HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const DEFAULT_TO_CONFIRM_LABEL = 'informação';
const MAX_LABEL = 120;

/** Remove caracteres de controle (exceto quebra de linha e tabulação) e marcação HTML. */
export function cleanText(text: string): string {
  let out = '';
  for (const char of text.replace(HTML_TAG, '')) {
    const code = char.charCodeAt(0);
    const control = (code < 32 && code !== 9 && code !== 10) || code === 127;
    if (!control) out += char;
  }
  return out;
}

/** Categoria do `toConfirm` pelo rótulo (entities.md §5.10 — rótulos padrão do GroundingGuard). */
export function toConfirmCategoryOf(label: string): ToConfirmCategory {
  const lower = label.toLowerCase();
  if (/valor|pre[cç]o|percentual|custo|r\$/.test(lower)) return 'VALUE';
  if (/quantidade|quantitativo/.test(lower)) return 'QUANTITY';
  if (/prazo|dura[cç][aã]o|vig[eê]ncia/.test(lower)) return 'DEADLINE';
  if (/\bdata\b/.test(lower)) return 'DATE';
  if (/decis[aã]o/.test(lower)) return 'DECISION';
  if (/dado|[oó]rg[aã]o|processo|unidade/.test(lower)) return 'DATA';
  return 'OTHER';
}

export function toConfirmNode(label: string, category?: ToConfirmCategory): RichTextNode {
  const trimmed = cleanText(label).trim().slice(0, MAX_LABEL) || DEFAULT_TO_CONFIRM_LABEL;
  return {
    type: 'toConfirm',
    attrs: { label: trimmed, category: category ?? toConfirmCategoryOf(trimmed), origin: 'AI' },
  };
}

function textNodes(text: string, mark: 'bold' | 'italic' | null): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'hardBreak' });
    if (line === '') return;
    nodes.push(
      mark === null
        ? { type: 'text', text: line }
        : { type: 'text', text: line, marks: [{ type: mark }] },
    );
  });
  return nodes;
}

function emphasisNodes(text: string): RichTextNode[] {
  const nodes: RichTextNode[] = [];
  let last = 0;
  for (const match of text.matchAll(EMPHASIS)) {
    nodes.push(...textNodes(text.slice(last, match.index), null));
    const bold = match[1];
    nodes.push(
      ...(bold === undefined ? textNodes(match[2] ?? '', 'italic') : textNodes(bold, 'bold')),
    );
    last = match.index + match[0].length;
  }
  nodes.push(...textNodes(text.slice(last), null));
  return nodes;
}

/** Texto em linha → nós TipTap (marcações `[a confirmar…]`, negrito e itálico). */
export function inlineNodes(raw: string): RichTextNode[] {
  const text = cleanText(raw);
  const nodes: RichTextNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TO_CONFIRM)) {
    nodes.push(...emphasisNodes(text.slice(last, match.index)));
    nodes.push(toConfirmNode(match[1] ?? DEFAULT_TO_CONFIRM_LABEL));
    last = match.index + match[0].length;
  }
  nodes.push(...emphasisNodes(text.slice(last)));
  return nodes;
}

function paragraph(text: string): RichTextNode {
  const content = inlineNodes(text);
  return content.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content };
}

function blockNodes(block: StructuredBlock): RichTextNode[] {
  switch (block.type) {
    case 'paragraph':
      return [paragraph(block.text)];
    case 'heading': {
      const content = inlineNodes(block.text);
      return content.length === 0
        ? []
        : [{ type: 'heading', attrs: { level: block.level }, content }];
    }
    case 'bulletList':
    case 'orderedList':
      return [
        {
          type: block.type,
          content: block.items.map((item) => ({ type: 'listItem', content: [paragraph(item)] })),
        },
      ];
    case 'table': {
      const row = (cells: readonly string[], cellType: 'tableHeader' | 'tableCell') => ({
        type: 'tableRow',
        content: cells.map((cell) => ({ type: cellType, content: [paragraph(cell)] })),
      });
      return [
        {
          type: 'table',
          content: [
            row(block.header, 'tableHeader'),
            ...block.rows.map((cells) => row(cells, 'tableCell')),
          ],
        },
      ];
    }
  }
}

/** Documento TipTap de uma lista de blocos. */
export function blocksToDoc(blocks: readonly StructuredBlock[]): {
  type: 'doc';
  content: RichTextNode[];
} {
  return { type: 'doc', content: blocks.flatMap(blockNodes) };
}

function walk(nodes: readonly RichTextNode[] | undefined, visit: (node: RichTextNode) => void) {
  for (const node of nodes ?? []) {
    visit(node);
    walk(node.content, visit);
  }
}

/** Marcações `toConfirm` no documento. */
export function countToConfirm(doc: { readonly content?: readonly RichTextNode[] }): number {
  let count = 0;
  walk(doc.content, (node) => {
    if (node.type === 'toConfirm') count += 1;
  });
  return count;
}

/** Caracteres visíveis do documento (texto + rótulos das marcações) — conferência de `maxChars`. */
export function plainTextLength(doc: { readonly content?: readonly RichTextNode[] }): number {
  let length = 0;
  walk(doc.content, (node) => {
    if (node.type === 'text') length += node.text?.length ?? 0;
    if (node.type === 'toConfirm') length += String(node.attrs?.label ?? '').length + 15;
  });
  return length;
}

function parseRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Valida e converte a resposta do provedor (RN-AI-07). */
export function convertStructuredOutput(raw: unknown, spec: ConversionSpec): ConversionResult {
  const parsed = (spec.schema ?? structuredResponseSchema).safeParse(parseRaw(raw));
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.code}`,
      ),
    };
  }
  const expected = new Map(spec.sections.map((section) => [section.sectionKey, section]));
  const issues: string[] = [];
  const seen = new Set<string>();
  const sections: AiOutputSection[] = [];
  for (const [index, section] of parsed.data.sections.entries()) {
    const definition = expected.get(section.sectionKey);
    if (definition === undefined) {
      issues.push(`sections.${String(index)}.sectionKey: unknown_section`);
      continue;
    }
    if (seen.has(section.sectionKey)) {
      issues.push(`sections.${String(index)}.sectionKey: duplicated_section`);
      continue;
    }
    seen.add(section.sectionKey);
    const content = blocksToDoc(section.blocks);
    if (plainTextLength(content) > definition.maxChars) {
      issues.push(`sections.${String(index)}.blocks: too_long`);
      continue;
    }
    sections.push({
      sectionKey: section.sectionKey,
      title: definition.title,
      content,
      placeholdersCount: countToConfirm(content),
      groundingReplacements: 0,
    });
  }
  for (const [key, definition] of expected) {
    if (!seen.has(key) && definition.optional !== true) issues.push(`sections: missing_section`);
  }
  if (issues.length > 0) return { ok: false, issues: [...new Set(issues)] };
  return {
    ok: true,
    output: {
      sections,
      ...(parsed.data.risks === undefined ? {} : { risks: parsed.data.risks }),
      warnings: [...(spec.warnings ?? [])],
    },
  };
}

/** Total de marcações `toConfirm` da proposta (seções). */
export function placeholdersOf(output: AiGenerationOutput): number {
  return output.sections.reduce((sum, section) => sum + section.placeholdersCount, 0);
}
