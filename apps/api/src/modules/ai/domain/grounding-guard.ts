import { TO_CONFIRM_DEFAULT_LABELS } from '@contrataflow/validation';
import type { AiGenerationOutput, AiOutputSection, RichTextNode } from '@contrataflow/validation';

import { CATEGORY_OF, FactSet, findFacts } from './fact-set.js';
import { toConfirmNode } from './output-converter.js';
import type { AiOutputPostProcessor, PostProcessingInput } from './post-processing.js';

/*
 * `GroundingGuard` (US-122 · RN-AI-54 · princípio "nada inventado" da DEC-037): pós-processador
 * determinístico da saída do provedor, aplicado depois da validação de schema e antes de gravar.
 * Todo valor monetário, quantidade com unidade, prazo/duração, data e percentual do texto gerado
 * precisa existir no conjunto de fatos das entradas (`FactSet`); o que não existir vira o nó
 * `toConfirm` da categoria correspondente (monetário/percentual → `VALUE`, quantidade →
 * `QUANTITY`, prazo → `DEADLINE`, data → `DATE`) e conta em `groundingReplacements`. Citações
 * legais ficam como estão; numeração de listas e anos soltos não são fatos conferidos. Marcação
 * literal "[a confirmar: …]" que sobrar em texto também vira nó (sem contar como troca).
 *
 * Puro e idempotente (rodar de novo sobre a própria saída não troca nada) — reexecutável no retry
 * do job. Exceção aqui = falha fechada: o processador termina a geração `FAILED`/`OUTPUT_INVALID`
 * sem gravar `output`. Nunca registra o texto nem os valores trocados.
 */

const LITERAL_TO_CONFIRM = /\[a confirmar(?:\s*:\s*([^\]]{0,200}))?\]/gi;

interface Rewritten {
  readonly nodes: RichTextNode[];
  readonly replacements: number;
}

function textNode(node: RichTextNode, text: string): RichTextNode[] {
  return text === '' ? [] : [{ ...node, text }];
}

/** Um trecho de texto sem marcações literais: troca os fatos não sustentados. */
function groundText(node: RichTextNode, text: string, facts: FactSet): Rewritten {
  const nodes: RichTextNode[] = [];
  let replacements = 0;
  let last = 0;
  for (const match of findFacts(text)) {
    if (match.kind === 'CITATION' || facts.supports(match)) continue;
    const category = CATEGORY_OF[match.kind];
    nodes.push(...textNode(node, text.slice(last, match.start)));
    nodes.push(toConfirmNode(TO_CONFIRM_DEFAULT_LABELS[category], category));
    replacements += 1;
    last = match.end;
  }
  nodes.push(...textNode(node, text.slice(last)));
  return { nodes, replacements };
}

/** Nó de texto → texto, marcações literais convertidas e fatos não sustentados trocados. */
function groundTextNode(node: RichTextNode, facts: FactSet): Rewritten {
  const text = node.text ?? '';
  const nodes: RichTextNode[] = [];
  let replacements = 0;
  let last = 0;
  for (const match of text.matchAll(LITERAL_TO_CONFIRM)) {
    const before = groundText(node, text.slice(last, match.index), facts);
    nodes.push(...before.nodes, toConfirmNode(match[1] ?? TO_CONFIRM_DEFAULT_LABELS.OTHER));
    replacements += before.replacements;
    last = match.index + match[0].length;
  }
  const rest = groundText(node, text.slice(last), facts);
  return { nodes: [...nodes, ...rest.nodes], replacements: replacements + rest.replacements };
}

function groundNodes(nodes: readonly RichTextNode[], facts: FactSet): Rewritten {
  const out: RichTextNode[] = [];
  let replacements = 0;
  for (const node of nodes) {
    if (node.type === 'text') {
      const rewritten = groundTextNode(node, facts);
      out.push(...rewritten.nodes);
      replacements += rewritten.replacements;
    } else if (node.content !== undefined) {
      const rewritten = groundNodes(node.content, facts);
      out.push({ ...node, content: rewritten.nodes });
      replacements += rewritten.replacements;
    } else {
      out.push(node);
    }
  }
  return { nodes: out, replacements };
}

/** Seção conferida contra os fatos (soma as trocas às já registradas por outros ganchos). */
export function groundSection(section: AiOutputSection, facts: FactSet): AiOutputSection {
  const content = section.content as { readonly type: 'doc'; readonly content?: RichTextNode[] };
  const rewritten = groundNodes(content.content ?? [], facts);
  return {
    ...section,
    content: { ...content, content: rewritten.nodes },
    groundingReplacements: section.groundingReplacements + rewritten.replacements,
  };
}

export class GroundingGuard implements AiOutputPostProcessor {
  readonly name = 'grounding-guard';

  process({ output, context }: PostProcessingInput): AiGenerationOutput {
    const facts = FactSet.fromContext(context);
    return { ...output, sections: output.sections.map((section) => groundSection(section, facts)) };
  }
}
