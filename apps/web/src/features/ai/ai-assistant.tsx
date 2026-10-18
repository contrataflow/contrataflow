'use client';

import { AI_TARGET_MODULES } from '@contrataflow/types';
import type { AiTargetModule } from '@contrataflow/types';
import { Button } from '@contrataflow/ui';
import type { DocumentDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { usePermission } from '@/lib/permissions/use-permission';

import { AiAssistantPanel } from './ai-assistant-panel';
import { useAiAvailability } from './use-ai-availability';

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
  /** DOC-26 aplicado (US-117): o editor recarrega as seções. */
  readonly onApplied?: ((document: DocumentDto) => void) | undefined;
}

/**
 * `AiDraftButton` + `AiAssistantPanel` (SCR-117 · US-115): o botão "Gerar rascunho com IA" só
 * aparece com `AI_GENERATE` (oculto sem a permissão — RN-FND-92) e documento editável; `?ia=`
 * abre o painel direto na geração (proposta e histórico valem para quem vê o processo). Fechar
 * devolve o foco ao botão. US-116: com a IA desligada, o provedor fora ou um limite atingido
 * (AI-05), o botão fica desabilitado com a explicação.
 */
export function AiAssistant({
  processId,
  documentId,
  targetModule,
  editable,
  initialGenerationId = null,
  onApplied,
}: AiAssistantProps) {
  const t = useTranslations('ai');
  const { allowed } = usePermission('AI_GENERATE');
  const opener = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const [open, setOpen] = useState(initialGenerationId !== null);
  const [startAt, setStartAt] = useState<string | null>(initialGenerationId);
  const visible = allowed && editable;
  const availability = useAiAvailability(processId, documentId, visible);
  const canGenerate = visible && availability.canGenerate;

  return (
    <>
      {visible ? (
        <span className="inline-flex flex-col gap-1">
          <Button
            ref={opener}
            variant="secondary"
            aria-expanded={open}
            disabled={!availability.canGenerate}
            aria-describedby={availability.message === null ? undefined : hintId}
            onClick={() => {
              setStartAt(null);
              setOpen(true);
            }}
          >
            {t('draftButton')}
          </Button>
          {availability.message === null ? null : (
            <span id={hintId} className="text-xs text-muted-foreground">
              {availability.message}
            </span>
          )}
        </span>
      ) : null}
      {open ? (
        <AiAssistantPanel
          processId={processId}
          documentId={documentId}
          targetModule={targetModule}
          canGenerate={canGenerate}
          needSummaryRequired={targetModule === 'DFD'}
          initialGenerationId={startAt}
          onApplied={onApplied}
          onClose={() => {
            setOpen(false);
            opener.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
