import type { AiSectionAction } from '@contrataflow/types';

import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';

import type { SanitizedContext } from './context-sanitizer.js';
import type { SectionSpec } from './output-converter.js';
import {
  COMMON_SYSTEM_PROMPT,
  COMMON_SYSTEM_PROMPT_VERSION,
  DATA_CLOSE,
  DATA_OPEN,
} from '../prompts/common/system-prompt.js';

/*
 * Prompts versionados (RN-AI-06 · DEC-079): cada gerador declara `promptKey` + `promptVersion` +
 * as instruções específicas; o texto final = prompt de sistema comum + instruções. A impressão
 * digital (SHA-256 do JSON canônico de chave, versão e textos) é travada em
 * `prompt-fingerprints.ts`: texto mudou sem versão nova → teste vermelho. O material de referência
 * vai entre delimitadores, com os delimitadores neutralizados dentro dos dados.
 */

export interface PromptTemplate {
  /** `draft.dfd`, `draft.etp`, `draft.risk_map`, `draft.tr`, `section.rewrite`… */
  readonly key: string;
  /** Versão semântica (`1.0.0`). */
  readonly version: string;
  /** Instruções específicas do gerador (somadas ao prompt de sistema comum). */
  readonly instructions: string;
}

export interface RenderedPrompt {
  readonly system: string;
  readonly user: string;
}

const SEMVER = /^\d+\.\d+\.\d+$/;
const PROMPT_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export class PromptRegistry {
  private readonly templates = new Map<string, PromptTemplate>();

  register(template: PromptTemplate): void {
    if (!PROMPT_KEY.test(template.key) || template.key.length > 60) {
      throw new Error(`promptKey inválida: ${template.key}`);
    }
    if (!SEMVER.test(template.version)) {
      throw new Error(`promptVersion inválida em ${template.key}: ${template.version}`);
    }
    const current = this.templates.get(template.key);
    if (current !== undefined && current !== template) {
      throw new Error(`Prompt ${template.key} registrado duas vezes`);
    }
    this.templates.set(template.key, template);
  }

  get(key: string): PromptTemplate | undefined {
    return this.templates.get(key);
  }

  all(): PromptTemplate[] {
    return [...this.templates.values()];
  }
}

/** Impressão digital do prompt (inclui o texto comum e a versão dele). */
export function promptFingerprint(template: PromptTemplate): string {
  return sha256Hex(
    canonicalJson({
      key: template.key,
      version: template.version,
      common: { version: COMMON_SYSTEM_PROMPT_VERSION, text: COMMON_SYSTEM_PROMPT },
      instructions: template.instructions,
    }),
  );
}

/** Impressão digital só do prompt comum (`common@<versão>`). */
export function commonPromptFingerprint(): string {
  return sha256Hex(
    canonicalJson({ version: COMMON_SYSTEM_PROMPT_VERSION, text: COMMON_SYSTEM_PROMPT }),
  );
}

const ACTION_TASKS: Readonly<Record<AiSectionAction, string>> = {
  REWRITE: 'Reescreva a seção pedida com mais clareza e formalidade, sem acrescentar fatos.',
  COMPLETE: 'Complete a seção pedida com o que falta, usando só os dados de referência.',
  SUMMARIZE: 'Resuma a seção pedida mantendo as informações essenciais.',
};

/** Neutraliza os delimitadores dentro dos dados (o modelo não pode "fechar" o bloco de dados). */
function escapeDelimiters(text: string): string {
  return text.replaceAll('<<<', '«‹').replaceAll('>>>', '›»');
}

export interface PromptInput {
  readonly sections: readonly SectionSpec[];
  readonly context: SanitizedContext;
  readonly action: AiSectionAction | null;
}

export function renderPrompt(template: PromptTemplate, input: PromptInput): RenderedPrompt {
  const sections = input.sections
    .map((section) => {
      const legal = section.legalBasis ? ` — legalBasis: ${section.legalBasis}` : '';
      return `- ${section.sectionKey} — ${section.title} — até ${String(section.maxChars)} caracteres${legal}`;
    })
    .join('\n');
  const data = escapeDelimiters(
    JSON.stringify(
      input.context.parts.map((part) => ({ parte: part.label, dados: part.data })),
      null,
      1,
    ),
  );
  const task = input.action === null ? null : ACTION_TASKS[input.action];
  const user = [
    ...(task === null ? [] : [`Tarefa: ${task}`, '']),
    'Seções a produzir (sectionKey — título — limite):',
    sections,
    '',
    'Dados de referência:',
    DATA_OPEN,
    data,
    DATA_CLOSE,
    '',
    'Formato da resposta (JSON): {"sections":[{"sectionKey":"<chave>","blocks":[{"type":"paragraph","text":"..."}]}]}. Tipos de bloco: paragraph, heading (level 3 ou 4), bulletList e orderedList (items), table (header e rows).',
  ].join('\n');
  return { system: `${COMMON_SYSTEM_PROMPT}\n\n${template.instructions}`, user };
}

/** Pedido de reparo após saída inválida (RN-AI-07): só códigos dos problemas, nunca o conteúdo. */
export function repairInstruction(issues: readonly string[]): string {
  return [
    'A resposta anterior não seguiu o formato pedido. Problemas encontrados:',
    ...issues.slice(0, 20).map((issue) => `- ${issue}`),
    'Responda novamente apenas com o objeto JSON válido, com todas as seções pedidas e dentro dos limites.',
  ].join('\n');
}
