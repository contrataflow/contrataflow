'use client';

import { AI_TARGET_MODULES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { usePermission } from '@/lib/permissions/use-permission';

import { AiAssistantPanel } from './ai-assistant-panel';

/** O documento é alvo da IA (DFD, ETP, mapa de riscos e TR — DEC-037)? */
export function isAiTarget(systemModule: string | null): systemModule is AiTargetModule {
  return systemModule !== null && (AI_TARGET_MODULES as readonly string[]).includes(systemModule);
}

export interface AiAssistantProps {
  readonly processId: string;
  readonly documentId: string;
  readonly targetModule: AiTargetModule;
  /** Documento em `DRAFT`/`RETURNED`: pode receber geração (a API confere POL-02). */
  readonly editable: boolean;
  /** `?ia=<generationId>` da URL (notificação `AI_GENERATION_READY`). */
  readonly initialGenerationId?: string | null | undefined;
}

/**
 * `AiDraftButton` + `AiAssistantPanel` (SCR-117 · US-115): o botão "Gerar rascunho com IA" só
 * aparece com `AI_GENERATE` (oculto sem a permissão — RN-FND-92) e documento editável; `?ia=`
 * abre o painel direto na geração (proposta e histórico valem para quem vê o processo). Fechar
 * devolve o foco ao botão.
 */
export function AiAssistant({
  processId,
  documentId,
  targetModule,
  editable,
  initialGenerationId = null,
}: AiAssistantProps) {
  const t = useTranslations('ai');
  const { allowed } = usePermission('AI_GENERATE');
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(initialGenerationId !== null);
  const [startAt, setStartAt] = useState<string | null>(initialGenerationId);
  const canGenerate = allowed && editable;

  return (
    <>
      {canGenerate ? (
        <Button
          ref={opener}
          variant="secondary"
          aria-expanded={open}
          onClick={() => {
            setStartAt(null);
            setOpen(true);
          }}
        >
          {t('draftButton')}
        </Button>
      ) : null}
      {open ? (
        <AiAssistantPanel
          processId={processId}
          documentId={documentId}
          targetModule={targetModule}
          canGenerate={canGenerate}
          needSummaryRequired={targetModule === 'DFD'}
          initialGenerationId={startAt}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
