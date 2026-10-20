import { AI_SECTION_ACTIONS } from '@contrataflow/types';
import type { AiSectionAction } from '@contrataflow/types';
import { aiSectionAdjustProblem, AI_INSTRUCTION_MAX } from '@contrataflow/validation';
import type {
  AiGenerationDto,
  AiSectionAdjustProblem,
  SectionRender,
  SectionState,
} from '@contrataflow/validation';

/*
 * Regras de tela do ajuste de seção com IA (US-121 · SCR-117), puras e testadas: quais ações do
 * `AiSectionMenu` ficam habilitadas (FA-01/FA-03 — a mesma regra da API, de
 * `@contrataflow/validation`), a validação do formulário (V-01), a fase do painel a partir da
 * geração acompanhada e quando o "Desfazer" ainda vale (FA-06).
 */

export interface AiSectionTarget {
  readonly key: string;
  readonly title: string;
  readonly render: SectionRender;
  readonly allowNarrative: boolean;
}

export interface AiSectionActionOption {
  readonly action: AiSectionAction;
  /** `null` = habilitada. */
  readonly problem: AiSectionAdjustProblem | null;
}

/** As três ações do menu, cada uma com o motivo da indisponibilidade (FA-01). */
export function sectionActionOptions(
  section: AiSectionTarget,
  state: SectionState,
  text: string,
): AiSectionActionOption[] {
  return AI_SECTION_ACTIONS.map((action) => ({
    action,
    problem: aiSectionAdjustProblem({ action, section, state, text }),
  }));
}

/** A seção aceita ajuste por alguma ação (senão o menu não aparece — FA-03). */
export function sectionSupportsAdjust(
  section: AiSectionTarget,
  state: SectionState,
  text: string,
): boolean {
  return sectionActionOptions(section, state, text).some(
    (option) => option.problem !== 'AI_SECTION_NOT_SUPPORTED',
  );
}

/** V-01: a orientação aceita até 500 caracteres (vazia = ausente). */
export function instructionProblem(instruction: string): 'TOO_LONG' | null {
  return instruction.trim().length > AI_INSTRUCTION_MAX ? 'TOO_LONG' : null;
}

export type SectionPanelPhase =
  'form' | 'generating' | 'ready' | 'failed' | 'applied' | 'expired' | 'closed';

/** Fase do painel pela geração acompanhada (AI-02); `undefined` = ainda carregando. */
export function sectionPanelPhase(generation: AiGenerationDto | undefined): SectionPanelPhase {
  if (generation === undefined) return 'generating';
  switch (generation.status) {
    case 'QUEUED':
    case 'RUNNING':
      return 'generating';
    case 'SUCCEEDED':
      return generation.output === null ? 'failed' : 'ready';
    case 'FAILED':
      return 'failed';
    case 'APPLIED':
      return 'applied';
    case 'EXPIRED':
      return 'expired';
    case 'DISCARDED':
    case 'CANCELED':
      return 'closed';
  }
}

/** Texto comparável (sem espaços nas pontas nem diferença de quebra de linha). */
function normalized(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * FA-06: "Desfazer" vale enquanto o painel está aberto e a seção não foi editada depois da
 * aplicação — o texto no editor ainda é o aplicado.
 */
export function canUndo(applied: { readonly text: string } | null, currentText: string): boolean {
  return applied !== null && normalized(applied.text) === normalized(currentText);
}
