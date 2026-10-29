'use client';

import { AI_GENERATION_ERROR_CODES } from '@contrataflow/types';
import type { AiSectionAction, AiTargetModule } from '@contrataflow/types';
import {
  Alert,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  RadioGroup,
  RadioGroupItem,
  SectionDiffView,
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Sparkles,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@contrataflow/ui';
import {
  AI_INSTRUCTION_MAX,
  AI_SECTION_RESERVED_TOKENS,
  richTextPlainText,
} from '@contrataflow/validation';
import type { AiGenerationDto, DraftSection, SectionState } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, SyntheticEvent } from 'react';

import { saveDocumentSection } from '@/features/dfd/dfd.api';
import { documentKeys, fetchDocument } from '@/features/documents/documents.api';
import { isApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { AiDisclaimer } from './ai-disclaimer';
import { AiGenerationProgress } from './ai-generation-progress';
import { useAiGeneration } from './ai-polling';
import { previewText } from './ai-proposal-section-list';
import {
  canUndo,
  instructionProblem,
  sectionActionOptions,
  sectionPanelPhase,
  sectionSupportsAdjust,
} from './ai-section-model';
import type { AiSectionTarget } from './ai-section-model';
import { aiKeys, applyAiContent, discardAiGeneration, requestAiGeneration } from './ai.api';
import { useAiAvailability } from './use-ai-availability';

/*
 * Ajuste de seção com IA (US-121 · SCR-117 · RN-AI-47..52) nos editores do planejamento:
 *
 *   `AiSectionMenu` no cabeçalho da seção ("IA ▸ Reescrever / Completar / Resumir") — oculto sem
 *   `AI_GENERATE` ou em seção sem narrativa (FA-03); desabilitado com o motivo (AI-05, documento
 *   não editável, seção curta — FA-01).
 *   `AiSectionPanel` — formulário curto (ação, "Orientação" com contador, entradas e consumo
 *   estimado) → AI-01 `SECTION` → acompanhamento por AI-02 → `AiSectionDiffView` (Atual ×
 *   Sugerido, "[a confirmar]" destacados; abaixo de 768 px vira abas) → "Aplicar" (DOC-26 com
 *   `confirmReplaceFilled`, a comparação é a confirmação) / "Descartar" / "Gerar de novo". Depois
 *   de aplicar, "Desfazer" restaura o conteúdo anterior pelo DOC-05 enquanto o painel estiver
 *   aberto e a seção não for editada (FA-06). 410 descarta a sugestão e oferece "Gerar de novo"
 *   com a ação e a orientação preenchidas (FA-02); 412 recarrega o documento (FA-05).
 */

/** A seção como o servidor a deixou (aplicação ou "Desfazer"): o editor adota revisão e texto. */
export interface AiSectionChange {
  readonly key: string;
  readonly revision: number;
  readonly state: SectionState;
  readonly content: DraftSection['content'];
  readonly justification: string | null;
}

export interface AiSectionMenuProps {
  readonly processId: string;
  readonly documentId: string;
  readonly targetModule: AiTargetModule;
  readonly section: AiSectionTarget;
  readonly state: SectionState;
  /** Texto atual no editor (o que a IA vai ler e a base do "Desfazer"). */
  readonly text: string;
  /** Documento em `DRAFT`/`RETURNED` e com edição permitida. */
  readonly editable: boolean;
  /** Seção gravada fora do autosave (DOC-26 ou o "Desfazer" pelo DOC-05). */
  readonly onSectionChanged: (change: AiSectionChange) => void;
}

export function AiSectionMenu({
  processId,
  documentId,
  targetModule,
  section,
  state,
  text,
  editable,
  onSectionChanged,
}: AiSectionMenuProps) {
  const t = useTranslations('ai.section');
  const { allowed } = usePermission('AI_GENERATE');
  const hintId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const [panelAction, setPanelAction] = useState<AiSectionAction | null>(null);
  const supported = sectionSupportsAdjust(section, state, text);
  const visible = allowed && supported;
  const availability = useAiAvailability(processId, documentId, visible && editable);

  if (!visible) return null;
  const disabledReason = !editable ? t('notEditable') : availability.message;
  const options = sectionActionOptions(section, state, text);

  return (
    <div className="inline-flex flex-col gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            ref={opener}
            size="sm"
            variant="secondary"
            aria-label={t('menuLabel', { title: section.title })}
            disabled={!editable || !availability.canGenerate}
            aria-describedby={disabledReason === null ? undefined : hintId}
          >
            {t('menu')} ▸
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          aria-label={t('menuLabel', { title: section.title })}
          className="w-72 max-w-[calc(100vw-2rem)]"
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option.action}
              disabled={option.problem !== null}
              className="flex flex-col items-start gap-0.5"
              onSelect={() => {
                setPanelAction(option.action);
              }}
            >
              <span className="font-medium">{t(`actions.${option.action}`)}</span>
              <span className="text-xs text-muted-foreground">
                {option.problem === 'AI_SECTION_EMPTY'
                  ? t('tooShort')
                  : option.problem === null
                    ? t(`actionHints.${option.action}`)
                    : t('notSupported')}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {disabledReason === null ? null : (
        <span id={hintId} className="text-xs text-muted-foreground">
          {disabledReason}
        </span>
      )}
      {panelAction === null ? null : (
        <AiSectionPanel
          processId={processId}
          documentId={documentId}
          targetModule={targetModule}
          section={section}
          state={state}
          text={text}
          initialAction={panelAction}
          onSectionChanged={onSectionChanged}
          onClose={() => {
            setPanelAction(null);
            opener.current?.focus();
          }}
        />
      )}
    </div>
  );
}

const TO_CONFIRM = /(\[a confirmar[^\]]*\])/gi;
const IS_TO_CONFIRM = /^\[a confirmar[^\]]*\]$/i;

/** Texto com cada "[a confirmar: …]" destacado (rótulo, não só cor). */
function HighlightedText({ text }: { readonly text: string }) {
  const parts = text.split(TO_CONFIRM);
  return (
    <p className="break-words whitespace-pre-wrap">
      {parts.map((part, index) =>
        IS_TO_CONFIRM.test(part) ? (
          // A posição no texto é a identidade estável do trecho.
          <mark key={index} className="rounded bg-warning-soft px-0.5 font-medium">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}

export interface AiSectionPanelProps {
  readonly processId: string;
  readonly documentId: string;
  readonly targetModule: AiTargetModule;
  readonly section: AiSectionTarget;
  readonly state: SectionState;
  readonly text: string;
  readonly initialAction: AiSectionAction;
  readonly onSectionChanged: (change: AiSectionChange) => void;
  readonly onClose: () => void;
}

interface Applied {
  /** Texto aplicado (o "Desfazer" vale enquanto o editor ainda o mostra). */
  readonly text: string;
  readonly revision: number;
  /** A seção antes da aplicação, como estava no servidor. */
  readonly previous: Pick<DraftSection, 'state' | 'content'>;
}

/** Painel lateral do ajuste (SCR-117): formulário → acompanhamento → comparação → aplicar/desfazer. */
export function AiSectionPanel({
  processId,
  documentId,
  targetModule,
  section,
  state,
  text,
  initialAction,
  onSectionChanged,
  onClose,
}: AiSectionPanelProps) {
  const t = useTranslations('ai.section');
  const tStates = useTranslations('ai.states');
  const tenantId = useTenantId();
  const session = useShellSession();
  const queryClient = useQueryClient();
  const formId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  const [action, setAction] = useState<AiSectionAction>(initialAction);
  const [instruction, setInstruction] = useState('');
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [tab, setTab] = useState<'current' | 'suggested'>('suggested');
  const { generation, stalled } = useAiGeneration(generationId);
  const document = useQuery({
    queryKey: documentKeys.detail(tenantId, documentId),
    queryFn: ({ signal }) => fetchDocument(documentId, signal),
    throwOnError: false,
  });

  useEffect(() => {
    if (applied !== null) undoButton.current?.focus();
  }, [applied]);

  const request = useIdempotentMutation({
    mutationFn: (_: undefined, context) =>
      requestAiGeneration(
        processId,
        {
          targetModule,
          documentId,
          kind: 'SECTION',
          action,
          sectionKey: section.key,
          ...(instruction.trim() === '' ? {} : { instruction: instruction.trim() }),
        },
        context,
      ),
  });
  const apply = useIdempotentMutation({
    mutationFn: (variables: { generationId: string; version: number }, context) =>
      applyAiContent(
        documentId,
        {
          generationId: variables.generationId,
          sectionKeys: [section.key],
          confirmReplaceFilled: true,
        },
        variables.version,
        context,
      ),
  });

  const options = sectionActionOptions(section, state, text);
  const instructionLength = instruction.trim().length;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    setError(null);
    const chosen = options.find((option) => option.action === action);
    if (instructionProblem(instruction) !== null || chosen?.problem !== null) {
      setFormError(
        chosen?.problem === 'AI_SECTION_EMPTY' ? t('tooShort') : t('instructionInvalid'),
      );
      return;
    }
    setFormError(null);
    try {
      const created = await request.submit(undefined);
      queryClient.setQueryData(aiKeys.generation(tenantId, created.id), created);
      setStale(false);
      setApplied(null);
      setGenerationId(created.id);
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.availabilityAll(tenantId) });
    } catch (failure) {
      const apiError = isApiError(failure) ? failure : null;
      const meta = (apiError?.problem as { meta?: { generationId?: unknown } } | null)?.meta;
      if (
        apiError?.code === 'AI_GENERATION_IN_PROGRESS' &&
        typeof meta?.generationId === 'string'
      ) {
        setGenerationId(meta.generationId);
        setNotice(t('inProgress'));
        return;
      }
      setFormError(
        apiError?.code === 'AI_PROVIDER_UNAVAILABLE'
          ? tStates('unavailable')
          : (apiError?.message ?? tStates('requestFailed')),
      );
    }
  }

  async function discard(current: AiGenerationDto, message: string | null = t('discarded')) {
    setBusy(true);
    try {
      const updated = await discardAiGeneration(current.id);
      queryClient.setQueryData(aiKeys.generation(tenantId, updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      if (message !== null) setNotice(message);
    } catch (failure) {
      setError(isApiError(failure) ? failure.message : tStates('requestFailed'));
    } finally {
      setBusy(false);
    }
  }

  function regenerate() {
    // Ação e orientação continuam preenchidas (FA-02).
    setGenerationId(null);
    setApplied(null);
    setStale(false);
    setError(null);
  }

  async function applySuggestion(current: AiGenerationDto) {
    const loaded = document.data;
    if (loaded === undefined) return;
    setError(null);
    setNotice(null);
    const before = loaded.document.draftContent.sections[section.key];
    try {
      const result = await apply.submit({
        generationId: current.id,
        version: loaded.document.version,
      });
      queryClient.setQueryData(documentKeys.detail(tenantId, documentId), {
        document: result.document,
        meta: loaded.meta,
      });
      void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, documentId) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.generation(tenantId, current.id) });
      void queryClient.invalidateQueries({ queryKey: aiKeys.history(tenantId, processId) });
      const after = result.document.draftContent.sections[section.key];
      if (after !== undefined) {
        onSectionChanged({
          key: section.key,
          revision: after.revision,
          state: after.state,
          content: after.content,
          justification: after.justification,
        });
        setApplied({
          text: after.content ? richTextPlainText(after.content) : '',
          revision: after.revision,
          previous: { state: before?.state ?? 'EMPTY', content: before?.content ?? null },
        });
      }
      setNotice(t('applied'));
    } catch (failure) {
      const apiError = isApiError(failure) ? failure : null;
      if (apiError?.code === 'AI_SUGGESTION_STALE') {
        // FA-02: a sugestão não serve para o texto novo — descarta e oferece "Gerar de novo".
        setStale(true);
        await discard(current, null);
        return;
      }
      if (apiError?.status === 412) {
        // FA-05: outra parte do documento mudou — recarrega; a seção decide se ainda vale.
        setNotice(t('conflict'));
        void document.refetch();
        return;
      }
      setError(
        apiError?.code === 'AI_GENERATION_NOT_OWNED'
          ? t('notOwned')
          : (apiError?.message ?? t('failed')),
      );
    }
  }

  async function undo() {
    if (applied === null) return;
    setBusy(true);
    setError(null);
    const restoreText = applied.previous.state === 'FILLED' && applied.previous.content !== null;
    try {
      const saved = await saveDocumentSection(
        documentId,
        section.key,
        {
          content: restoreText ? applied.previous.content : null,
          notApplicable: false,
          justification: null,
        },
        applied.revision,
      );
      onSectionChanged({
        key: section.key,
        revision: saved.revision,
        state: saved.state,
        content: restoreText ? applied.previous.content : null,
        justification: null,
      });
      void queryClient.invalidateQueries({ queryKey: documentKeys.all(tenantId, documentId) });
      setApplied(null);
      setNotice(t('undone'));
    } catch (failure) {
      const apiError = isApiError(failure) ? failure : null;
      setApplied(null);
      setError(apiError?.status === 412 ? t('undoConflict') : (apiError?.message ?? t('failed')));
    } finally {
      setBusy(false);
    }
  }

  const phase =
    applied !== null ? 'applied' : generationId === null ? 'form' : sectionPanelPhase(generation);
  const currentSection = document.data?.document.draftContent.sections[section.key];
  // FA-05: depois do 412, se a própria seção mudou, a sugestão ficou obsoleta.
  const sectionMoved =
    generation?.baseRevision !== null &&
    generation?.baseRevision !== undefined &&
    currentSection !== undefined &&
    currentSection.revision !== generation.baseRevision;
  const suggested = generation?.output?.sections.find((item) => item.sectionKey === section.key);
  const suggestedText = suggested
    ? previewText(suggested.content as Parameters<typeof previewText>[0])
    : '';
  const owner = generation?.requestedBy.id === session.user.id;
  // FA-04: seção de IA já revisada por uma pessoa volta a exigir revisão.
  const reviewed = Boolean(currentSection?.ai?.reviewedAt);
  const undoAvailable = canUndo(applied, text);

  let body: ReactNode = null;
  if (phase === 'form') {
    body = (
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={t('actionLegend')} group>
          <RadioGroup
            value={action}
            onValueChange={(value) => {
              setAction(value as AiSectionAction);
            }}
          >
            {options.map((option) => (
              <div key={option.action} className="flex items-start gap-2 text-sm">
                <RadioGroupItem
                  id={`${formId}-${option.action}`}
                  className="mt-0.5"
                  value={option.action}
                  disabled={option.problem !== null}
                />
                <label htmlFor={`${formId}-${option.action}`} className="flex flex-col">
                  <span className="font-medium">{t(`actions.${option.action}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.problem === 'AI_SECTION_EMPTY'
                      ? t('tooShort')
                      : t(`actionHints.${option.action}`)}
                  </span>
                </label>
              </div>
            ))}
          </RadioGroup>
        </Field>
        <Field
          label={t('instruction')}
          description={
            <>
              {t('instructionHint')}
              <span
                className={`block ${instructionLength > AI_INSTRUCTION_MAX ? 'font-semibold text-destructive' : ''}`}
                aria-live="polite"
              >
                {t('instructionCount', { count: instructionLength })}
              </span>
            </>
          }
        >
          <Textarea
            value={instruction}
            aria-invalid={instructionProblem(instruction) !== null}
            onChange={(event) => {
              setInstruction(event.target.value);
            }}
          />
        </Field>
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{t('inputsTitle')}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            <li>{t('inputs.section')}</li>
            <li>{t('inputs.document')}</li>
            <li>{t('inputs.process')}</li>
          </ul>
          <p className="text-xs text-muted-foreground">
            {t('estimate', { tokens: AI_SECTION_RESERVED_TOKENS.toLocaleString('pt-BR') })}
          </p>
        </div>
        {formError ? (
          <Alert tone="error" title={formError}>
            {null}
          </Alert>
        ) : null}
        <div>
          <Button type="submit" disabled={request.isPending}>
            {request.isPending ? t('submitting') : t('submit')}
          </Button>
        </div>
      </form>
    );
  } else if (phase === 'generating') {
    body =
      generation === undefined ? (
        <div role="status" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <AiGenerationProgress
          status={generation.status}
          stalled={stalled}
          canceling={busy}
          onCancel={() => void discard(generation, null)}
        />
      );
  } else if (phase === 'failed' && generation !== undefined) {
    const reason = (AI_GENERATION_ERROR_CODES as readonly string[]).includes(
      generation.errorCode ?? '',
    )
      ? (generation.errorCode ?? 'default')
      : 'default';
    body = (
      <Alert tone="error" title={tStates('failedTitle')}>
        <p>{tStates(`failedReason.${reason}`)}</p>
        <Button variant="secondary" onClick={regenerate}>
          {tStates('retry')}
        </Button>
      </Alert>
    );
  } else if (phase === 'ready' && generation !== undefined && !stale) {
    const blocked = sectionMoved || !owner;
    body = (
      <div className="flex flex-col gap-3">
        <h3 className="font-medium">{t('compareTitle')}</h3>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t('placeholders', { count: suggested?.placeholdersCount ?? 0 })}
        </p>
        {reviewed ? (
          <Alert tone="warning" live={false} title={t('reviewedWarning')}>
            {null}
          </Alert>
        ) : null}
        {/* Abaixo de 768 px a comparação vira abas "Atual" / "Sugerido". */}
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(value as 'current' | 'suggested');
          }}
          className="md:hidden"
        >
          <TabsList>
            <TabsTrigger value="current">{t('current')}</TabsTrigger>
            <TabsTrigger value="suggested">{t('suggested')}</TabsTrigger>
          </TabsList>
          {(['current', 'suggested'] as const).map((item) => (
            <TabsContent
              key={item}
              value={item}
              className="mt-3 rounded-control bg-muted p-3 pt-3 text-sm"
            >
              <HighlightedText text={item === 'current' ? text : suggestedText} />
            </TabsContent>
          ))}
        </Tabs>
        <div className="hidden md:block">
          <SectionDiffView
            serverText={text}
            localText={suggestedText}
            labels={{
              serverColumn: t('current'),
              mineColumn: t('suggested'),
              inserted: t('suggested'),
              removed: t('current'),
              empty: '—',
            }}
          />
          <div className="mt-2 rounded-control bg-muted p-3 text-sm">
            <HighlightedText text={suggestedText} />
          </div>
        </div>
        {sectionMoved ? (
          <Alert tone="warning" title={t('stale')}>
            {null}
          </Alert>
        ) : null}
        {owner ? null : <p className="text-sm text-muted-foreground">{t('notOwned')}</p>}
        <div className="flex flex-wrap gap-2">
          {blocked ? null : (
            <Button
              disabled={apply.isPending || busy || document.data === undefined}
              onClick={() => void applySuggestion(generation)}
            >
              {apply.isPending ? t('applying') : t('apply')}
            </Button>
          )}
          {owner ? (
            <Button variant="secondary" disabled={busy} onClick={() => void discard(generation)}>
              {busy ? t('discarding') : t('discard')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={regenerate}>
            {t('regenerate')}
          </Button>
        </div>
      </div>
    );
  } else if (phase === 'applied' && applied !== null) {
    body = (
      <div className="flex flex-col gap-3">
        {undoAvailable ? (
          <div>
            <Button
              ref={undoButton}
              variant="secondary"
              disabled={busy}
              onClick={() => void undo()}
            >
              {busy ? t('undoing') : t('undo')}
            </Button>
          </div>
        ) : null}
        <Button variant="ghost" onClick={regenerate}>
          {t('regenerate')}
        </Button>
      </div>
    );
  } else {
    const message = stale
      ? t('stale')
      : phase === 'expired'
        ? t('expired')
        : phase === 'applied' && notice === null
          ? tStates('applied')
          : null;
    body = (
      <div className="flex flex-col gap-3">
        {message === null ? null : <p className="text-sm">{message}</p>}
        <div>
          <Button variant="secondary" onClick={regenerate}>
            {t('regenerate')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Sheet
      open
      // Não modal: o editor continua editável enquanto a IA ajusta a seção (SCR-117).
      modal={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        closeLabel={t('close')}
        aria-describedby={undefined}
        className="md:max-w-[30rem] 2xl:max-w-xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          heading.current?.focus();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <SheetHeader>
          <SheetTitle ref={heading} tabIndex={-1} className="outline-none">
            <span className="inline-flex items-center gap-2">
              <Sparkles aria-hidden="true" className="size-5 flex-none text-primary" />
              {t('panelTitle', { title: section.title })}
            </span>
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          {notice ? (
            <Alert tone="info" title={notice}>
              {null}
            </Alert>
          ) : null}
          {error ? (
            <Alert tone="error" title={error}>
              {null}
            </Alert>
          ) : null}
          {body}
        </SheetBody>
        <SheetFooter className="justify-start py-3">
          <AiDisclaimer />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
