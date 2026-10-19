'use client';

import { useAutosave } from '@contrataflow/ui';
import type { AutosaveFailure, LocalDraft, LocalDraftStore } from '@contrataflow/ui';
import type {
  DocumentSectionSavedDto,
  DraftContent,
  SectionConflictCurrent,
} from '@contrataflow/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { editorDraftStore } from '@/lib/drafts/encrypted-drafts';

import { sectionDraftOf, sectionKeyOf, sectionSaveBody, sectionTarget } from './etp-editor-model';
import type { EtpSectionDraft } from './etp-editor-model';
import { classifyDfdAutosaveError } from '../dfd/dfd-autosave';
import type { DfdAutosaveBlock } from '../dfd/dfd-autosave';
import { saveDocumentSection } from '../dfd/dfd.api';
import { documentKeys } from '../documents/documents.api';

/*
 * Autosave das seções do ETP (US-020 · SCR-008 · RN-ETP-10) sobre o `useAutosave` genérico de
 * `@contrataflow/ui` (o mesmo mecanismo do DFD — US-015): cada seção é um alvo `SECTION:<CHAVE>`
 * gravado pelo DOC-05 com `If-Match: "s<revision>"` (debounce de 1,5 s e perda de foco). O 412
 * abre o diálogo de conflito (FA-01); rede/5xx deixam a pendência na contingência cifrada local e
 * reenviam ao reconectar (FA-04); 403/404/409 bloqueiam a edição (FA-05). O DOC-08 é relido 2 s
 * depois das gravações para a navegação lateral (RN-ETP-13).
 */

export interface EtpSectionConflict {
  readonly key: string;
  readonly current: SectionConflictCurrent;
}

export interface EtpRecoveredDrafts {
  readonly drafts: Readonly<Record<string, LocalDraft<EtpSectionDraft>>>;
  readonly savedAt: number;
}

/**
 * O documento que o autosave grava: só o id e o rascunho por seção (a revisão-base de cada uma).
 * O ETP e o TR (US-036 — o mesmo DOC-05, nenhum mecanismo paralelo) satisfazem a forma.
 */
export interface AutosaveDocument {
  readonly documentId: string;
  readonly draftContent: DraftContent;
}

export interface UseEtpAutosaveInput {
  readonly etp: AutosaveDocument;
  readonly tenantId: string;
  readonly userId: string;
  readonly enabled: boolean;
  /** A tela troca a seção (descartar a minha / restaurar). */
  readonly onSection: (key: string, draft: EtpSectionDraft) => void;
  /** A gravação confirmada (estado e revisão — a navegação lateral se atualiza) e o valor gravado. */
  readonly onSaved?: ((saved: DocumentSectionSavedDto, value: EtpSectionDraft) => void) | undefined;
  /** Testes: contingência em memória. */
  readonly store?: LocalDraftStore | undefined;
}

export function useEtpAutosave(input: UseEtpAutosaveInput) {
  const queryClient = useQueryClient();
  const latest = useRef(input);
  latest.current = input;
  const store = input.store ?? editorDraftStore();
  const scope = {
    tenantId: input.tenantId,
    userId: input.userId,
    documentId: input.etp.documentId,
  };
  // A revisão de cada seção confirmada pelo servidor (o `If-Match` do alvo).
  const revisions = useRef<Record<string, number>>(
    Object.fromEntries(
      Object.entries(input.etp.draftContent.sections).map(([key, section]) => [
        key,
        section.revision,
      ]),
    ),
  );
  const [conflict, setConflict] = useState<EtpSectionConflict | null>(null);
  const [blocked, setBlocked] = useState<DfdAutosaveBlock | null>(null);
  const [recovered, setRecovered] = useState<EtpRecoveredDrafts | null>(null);
  const validationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const invalidateValidation = () => {
    if (validationTimer.current !== null) clearTimeout(validationTimer.current);
    validationTimer.current = setTimeout(() => {
      void queryClient.invalidateQueries({
        queryKey: documentKeys.validation(latest.current.tenantId, latest.current.etp.documentId),
      });
    }, 2000);
  };

  const baseOf = (target: string) =>
    `s${String(revisions.current[sectionKeyOf(target) ?? ''] ?? 0)}`;

  const autosave = useAutosave<EtpSectionDraft>({
    enabled: input.enabled,
    save: async (target, value, { resolution }) => {
      const key = sectionKeyOf(target);
      if (key === null) return;
      const revision = revisions.current[key] ?? 0;
      const saved = await saveDocumentSection(
        latest.current.etp.documentId,
        key,
        sectionSaveBody(value, resolution === 'keepMine' ? revision : undefined),
        revision,
      );
      revisions.current[key] = saved.revision;
      latest.current.onSaved?.(saved, value);
      invalidateValidation();
    },
    classify: classifyDfdAutosaveError,
    local: {
      persist: (target, value) => store.save(scope, target, { base: baseOf(target), value }),
      remove: (target) => store.remove(scope, target),
    },
    onConflict: (target, failure: AutosaveFailure) => {
      if (failure.kind !== 'conflict') return;
      const current = failure.current as
        { kind: 'section'; current: SectionConflictCurrent } | { kind: 'reload' } | undefined;
      const key = sectionKeyOf(target);
      if (current?.kind === 'section' && key !== null)
        setConflict({ key, current: current.current });
    },
    onBlocked: (failure) => {
      if (failure.kind === 'sessionExpired') setBlocked({ code: 'SESSION_EXPIRED' });
      else if (failure.kind === 'blocked') {
        setBlocked((failure.detail as DfdAutosaveBlock | undefined) ?? { code: failure.reason });
      }
    },
  });

  // FA-04: pendências desta pessoa neste ETP ao abrir (mesma aba — chave da sessão).
  useEffect(() => {
    if (!input.enabled) return;
    let active = true;
    void store
      .loadAll<EtpSectionDraft>(scope)
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
  }, [input.etp.documentId, input.enabled]);

  return {
    snapshot: autosave.snapshot,
    flush: autosave.flush,
    hasPending: autosave.hasPending,
    conflict,
    blocked,
    recovered,
    /** Digitação (debounce de 1,5 s). */
    change(key: string, draft: EtpSectionDraft) {
      autosave.change(sectionTarget(key), draft);
    },
    /** "Não se aplica" confirmado / "Voltar a preencher": grava já. */
    async commit(key: string, draft: EtpSectionDraft) {
      autosave.change(sectionTarget(key), draft);
      await autosave.flush(sectionTarget(key));
    },
    /** FA-01 "Manter a minha versão": reenvia sobre a revisão atual com `overwrittenRevision`. */
    async keepMine(draft: EtpSectionDraft) {
      if (conflict === null) return;
      const target = sectionTarget(conflict.key);
      revisions.current[conflict.key] = conflict.current.revision;
      setConflict(null);
      autosave.change(target, draft);
      await autosave.keepMine(target);
    },
    /** FA-01 "Descartar a minha e recarregar": fica a do servidor; a pendência local é apagada. */
    async discardMine() {
      if (conflict === null) return;
      const { key, current } = conflict;
      revisions.current[key] = current.revision;
      setConflict(null);
      latest.current.onSection(key, sectionDraftOf(current));
      await autosave.discard(sectionTarget(key));
    },
    /**
     * FA-04 "Restaurar": a pendência só é reaplicada direto se a revisão-base for a atual; senão
     * abre o diálogo de conflito com a seção do servidor.
     */
    async restore() {
      if (recovered === null) return;
      setRecovered(null);
      for (const [target, draft] of Object.entries(recovered.drafts)) {
        const key = sectionKeyOf(target);
        if (key === null) continue;
        const revision = revisions.current[key] ?? 0;
        latest.current.onSection(key, draft.value);
        if (draft.base === `s${String(revision)}`) {
          autosave.change(target, draft.value);
          continue;
        }
        const section = latest.current.etp.draftContent.sections[key];
        setConflict({
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
      await autosave.flush();
    },
    /** FA-04 "Descartar": apaga as pendências locais do ETP. */
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
