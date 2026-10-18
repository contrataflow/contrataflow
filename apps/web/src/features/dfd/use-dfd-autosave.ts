'use client';

import { AutosaveError, changedHeaderFields, useAutosave } from '@contrataflow/ui';
import type { AutosaveFailure, LocalDraft, LocalDraftStore } from '@contrataflow/ui';
import {
  DFD_PATCH_FIELDS,
  richTextFromPlainText,
  richTextPlainText,
} from '@contrataflow/validation';
import type {
  DfdConflictCurrent,
  DfdDto,
  DfdMeta,
  DfdPatchField,
  DocumentDto,
  SectionConflictCurrent,
} from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { editorDraftStore } from '@/lib/drafts/encrypted-drafts';

import {
  HEADER_TARGET,
  classifyDfdAutosaveError,
  dfdHeaderPatch,
  headerDraftOf,
  mergeDfdHeader,
  sectionKeyOf,
  sectionTarget,
} from './dfd-autosave';
import type { DfdAutosaveBlock, DfdHeaderDraft } from './dfd-autosave';
import { dfdKeys, patchDfd, saveDocumentSection } from './dfd.api';
import { documentKeys } from '../documents/documents.api';

/*
 * Autosave do DFD (US-015 · SCR-007) sobre o `useAutosave` genérico de `@contrataflow/ui`: cada
 * seção é um alvo (DOC-05, `If-Match: "s<revision>"`) e o cabeçalho + o passo do wizard outro
 * (DFD-04, `If-Match: "<version>"`, só os campos alterados). O 412 do cabeçalho é mesclado em
 * silêncio quando os campos não se cruzam (até 3 tentativas — RN-DFD-28); o da seção abre o
 * diálogo. A contingência cifrada guarda as pendências por documento; ao abrir com pendências,
 * oferece "Restaurar"/"Descartar" (FA-08). Validação (DOC-08) invalidada 2 s depois das gravações.
 */

type AutosaveValue = string | DfdHeaderDraft;

export type DfdConflictState =
  | {
      readonly kind: 'section';
      readonly key: string;
      readonly current: SectionConflictCurrent;
    }
  | {
      readonly kind: 'header';
      readonly server: DfdConflictCurrent;
      readonly fields: readonly DfdPatchField[];
      readonly local: DfdHeaderDraft;
    };

export interface DfdRecoveredDrafts {
  readonly drafts: Readonly<Record<string, LocalDraft<AutosaveValue>>>;
  readonly savedAt: number;
}

export interface UseDfdAutosaveInput {
  readonly dfd: DfdDto;
  readonly meta: DfdMeta;
  readonly document: DocumentDto;
  readonly tenantId: string;
  readonly userId: string;
  readonly today: string;
  readonly enabled: boolean;
  /** A tela troca o texto da seção (descartar a minha / restaurar). */
  readonly onSectionText: (key: string, text: string) => void;
  /** A tela troca valores do cabeçalho (merge com o servidor / restaurar / escolhas). */
  readonly onHeader: (draft: DfdHeaderDraft) => void;
  /** Testes: contingência em memória. */
  readonly store?: LocalDraftStore | undefined;
}

/** Máximo de reenvios silenciosos depois de um 412 sem interseção (FA-02). */
const MAX_MERGE_ATTEMPTS = 3;

export function sectionText(document: DocumentDto, key: string): string {
  const content = document.draftContent.sections[key]?.content;
  return content ? richTextPlainText(content) : '';
}

export function useDfdAutosave(input: UseDfdAutosaveInput) {
  const queryClient = useQueryClient();
  const latest = useRef(input);
  latest.current = input;
  const store = input.store ?? editorDraftStore();
  const scope = {
    tenantId: input.tenantId,
    userId: input.userId,
    documentId: input.dfd.documentId,
  };
  // Base do cabeçalho (o que o servidor confirmou) e revisões das seções (o `If-Match` de cada alvo).
  const base = useRef<{
    readonly draft: DfdHeaderDraft;
    readonly version: number;
    readonly dto: DfdDto;
  }>({
    draft: headerDraftOf(input.dfd),
    version: input.dfd.version,
    dto: input.dfd,
  });
  const revisions = useRef<Record<string, number>>(
    Object.fromEntries(
      Object.entries(input.document.draftContent.sections).map(([key, section]) => [
        key,
        section.revision,
      ]),
    ),
  );
  const [conflict, setConflict] = useState<DfdConflictState | null>(null);
  const [blocked, setBlocked] = useState<DfdAutosaveBlock | null>(null);
  const [recovered, setRecovered] = useState<DfdRecoveredDrafts | null>(null);
  const validationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateValidation = () => {
    if (validationTimer.current !== null) clearTimeout(validationTimer.current);
    validationTimer.current = setTimeout(() => {
      void queryClient.invalidateQueries({
        queryKey: documentKeys.validation(latest.current.tenantId, latest.current.dfd.documentId),
      });
    }, 2000);
  };

  const adoptServerDfd = (dto: DfdDto) => {
    base.current = { draft: headerDraftOf(dto), version: dto.version, dto };
    queryClient.setQueryData(dfdKeys.detail(latest.current.tenantId, dto.id), {
      dfd: dto,
      meta: latest.current.meta,
    });
  };

  const baseOf = (target: string): string => {
    const key = sectionKeyOf(target);
    return key === null ? String(base.current.version) : `s${String(revisions.current[key] ?? 0)}`;
  };

  async function saveSection(key: string, text: string, keepMine: boolean): Promise<void> {
    const revision = revisions.current[key] ?? 0;
    const saved = await saveDocumentSection(
      latest.current.dfd.documentId,
      key,
      {
        content: text.trim() === '' ? null : richTextFromPlainText(text),
        notApplicable: false,
        justification: null,
        ...(keepMine ? { overwrittenRevision: revision } : {}),
      },
      revision,
    );
    revisions.current[key] = saved.revision;
    invalidateValidation();
  }

  async function saveHeader(value: DfdHeaderDraft): Promise<void> {
    let local = value;
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
      const { patch } = dfdHeaderPatch(local, base.current.draft, { today: latest.current.today });
      if (Object.keys(patch).length === 0) return;
      try {
        const result = await patchDfd(latest.current.dfd.id, patch, base.current.version);
        adoptServerDfd(result.dfd);
        invalidateValidation();
        return;
      } catch (error) {
        if (!(isApiError(error) && error.status === 412 && error.code === 'VERSION_CONFLICT')) {
          throw error;
        }
        const server = (error.problem?.meta as { current?: DfdConflictCurrent } | undefined)
          ?.current;
        if (server === undefined) throw error;
        const merged = mergeDfdHeader(base.current.draft, local, headerDraftOf(server));
        if (merged.conflicts.length > 0) {
          throw new AutosaveError({
            kind: 'conflict',
            current: { kind: 'header', server, fields: merged.conflicts, local: merged.local },
          });
        }
        adoptServerDfd(server);
        local = merged.local;
        // A tela passa a mostrar as alterações de quem salvou antes (sem perder as minhas).
        if (merged.remote.length > 0) latest.current.onHeader(local);
      }
    }
    throw new AutosaveError({ kind: 'offline' });
  }

  const autosave = useAutosave<AutosaveValue>({
    enabled: input.enabled,
    save: async (target, value, { resolution }) => {
      const key = sectionKeyOf(target);
      if (key !== null) await saveSection(key, value as string, resolution === 'keepMine');
      else await saveHeader(value as DfdHeaderDraft);
    },
    classify: classifyDfdAutosaveError,
    local: {
      persist: (target, value) => {
        // POL-09: a estimativa mascarada nunca vai para o navegador.
        const stored =
          typeof value === 'string' || value.estimatedValueMasked !== true
            ? value
            : { ...value, estimatedValue: null };
        return store.save(scope, target, { base: baseOf(target), value: stored });
      },
      remove: (target) => store.remove(scope, target),
    },
    onConflict: (target, failure: AutosaveFailure) => {
      if (failure.kind !== 'conflict') return;
      const current = failure.current as
        | { kind: 'section'; current: SectionConflictCurrent }
        | {
            kind: 'header';
            server: DfdConflictCurrent;
            fields: DfdPatchField[];
            local: DfdHeaderDraft;
          }
        | { kind: 'reload' }
        | undefined;
      const key = sectionKeyOf(target);
      if (current?.kind === 'section' && key !== null) {
        setConflict({ kind: 'section', key, current: current.current });
      } else if (current?.kind === 'header') {
        setConflict({
          kind: 'header',
          server: current.server,
          fields: current.fields,
          local: current.local,
        });
      }
    },
    onBlocked: (failure) => {
      if (failure.kind === 'sessionExpired') setBlocked({ code: 'SESSION_EXPIRED' });
      else if (failure.kind === 'blocked') {
        setBlocked((failure.detail as DfdAutosaveBlock | undefined) ?? { code: failure.reason });
      }
    },
  });

  // FA-08: pendências desta pessoa neste documento ao abrir (mesma aba — chave da sessão).
  useEffect(() => {
    if (!input.enabled) return;
    let active = true;
    void store
      .loadAll<AutosaveValue>(scope)
      .then((drafts) => {
        const savedAt = Math.max(0, ...Object.values(drafts).map((draft) => draft.savedAt));
        if (active && Object.keys(drafts).length > 0) setRecovered({ drafts, savedAt });
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (validationTimer.current !== null) clearTimeout(validationTimer.current);
    };
    // Uma vez por documento aberto.
  }, [input.dfd.documentId, input.enabled]);

  return {
    snapshot: autosave.snapshot,
    flush: autosave.flush,
    hasPending: autosave.hasPending,
    conflict,
    blocked,
    recovered,
    changeSection(key: string, text: string) {
      autosave.change(sectionTarget(key), text);
    },
    changeHeader(draft: DfdHeaderDraft) {
      autosave.change(HEADER_TARGET, draft);
    },
    /** FA-01 "Manter a minha versão": reenvia sobre a revisão atual com `overwrittenRevision`. */
    async keepMine(text: string) {
      if (conflict?.kind !== 'section') return;
      const target = sectionTarget(conflict.key);
      revisions.current[conflict.key] = conflict.current.revision;
      setConflict(null);
      autosave.change(target, text);
      await autosave.keepMine(target);
    },
    /** FA-01 "Descartar a minha e recarregar": fica a do servidor; a pendência local é apagada. */
    async discardMine() {
      if (conflict?.kind !== 'section') return;
      const { key, current } = conflict;
      revisions.current[key] = current.revision;
      setConflict(null);
      latest.current.onSectionText(key, current.content ? richTextPlainText(current.content) : '');
      await autosave.discard(sectionTarget(key));
    },
    /** FA-02: escolhas por campo; os demais já estavam mesclados. */
    async resolveHeader(choices: Readonly<Record<string, 'mine' | 'theirs'>>) {
      if (conflict?.kind !== 'header') return;
      const serverDraft = headerDraftOf(conflict.server);
      const resolved: Record<string, unknown> = { ...conflict.local };
      for (const field of conflict.fields) {
        if (choices[field] === 'theirs')
          resolved[field] = serverDraft[field as keyof DfdHeaderDraft];
      }
      adoptServerDfd(conflict.server);
      setConflict(null);
      const next = resolved as unknown as DfdHeaderDraft;
      latest.current.onHeader(next);
      autosave.change(HEADER_TARGET, next);
      await autosave.keepMine(HEADER_TARGET);
    },
    /**
     * FA-08 "Restaurar": a pendência da seção só é reaplicada direto se a revisão-base for a atual;
     * senão abre o diálogo de conflito. O cabeçalho volta e passa pelo merge do DFD-04.
     */
    async restore() {
      if (recovered === null) return;
      setRecovered(null);
      for (const [target, draft] of Object.entries(recovered.drafts)) {
        const key = sectionKeyOf(target);
        if (key !== null && typeof draft.value === 'string') {
          const revision = revisions.current[key] ?? 0;
          const text = draft.value;
          latest.current.onSectionText(key, text);
          if (draft.base === `s${String(revision)}`) {
            autosave.change(target, text);
          } else {
            const section = latest.current.document.draftContent.sections[key];
            setConflict({
              kind: 'section',
              key,
              current: {
                sectionKey: key,
                state: section?.state ?? 'EMPTY',
                revision,
                content: section?.content ?? null,
                justification: section?.justification ?? null,
                updatedAt: section?.updatedAt ?? new Date().toISOString(),
                updatedBy: null,
              },
            });
          }
        } else if (key === null && typeof draft.value !== 'string') {
          const server = base.current.draft;
          const value: DfdHeaderDraft = {
            ...draft.value,
            estimatedValue: server.estimatedValueMasked
              ? server.estimatedValue
              : draft.value.estimatedValue,
            estimatedValueMasked: server.estimatedValueMasked === true,
          };
          if (draft.base === String(base.current.version)) {
            latest.current.onHeader(value);
            autosave.change(HEADER_TARGET, value);
            continue;
          }
          // Outra gravação depois da base local: cada campo diferente do servidor é escolhido.
          const fields = (
            changedHeaderFields(
              server as unknown as Record<string, unknown>,
              value as unknown as Record<string, unknown>,
              DFD_PATCH_FIELDS,
            ) as DfdPatchField[]
          ).filter((field) => field !== 'wizardStep' && field !== 'completedSteps');
          if (fields.length > 0) {
            setConflict({
              kind: 'header',
              server: { ...base.current.dto, updatedBy: null },
              fields,
              local: {
                ...value,
                wizardStep: server.wizardStep,
                completedSteps: server.completedSteps,
              },
            });
          }
        }
      }
      await autosave.flush();
    },
    /** FA-08 "Descartar": apaga as pendências locais do documento. */
    async discardRecovered() {
      if (recovered === null) return;
      setRecovered(null);
      await Promise.all(
        Object.keys(recovered.drafts).map((target) =>
          store.remove(scope, target).catch(() => undefined),
        ),
      );
    },
  };
}
