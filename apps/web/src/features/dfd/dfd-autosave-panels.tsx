'use client';

import {
  Alert,
  Button,
  ConflictDialog,
  HeaderConflictDialog,
  RecoveredDraftBanner,
} from '@contrataflow/ui';
import type { DfdTemplateSectionDto } from '@contrataflow/validation';
import { richTextPlainText } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { headerDraftOf } from './dfd-autosave';
import type { DfdAutosaveBlock, DfdHeaderDraft } from './dfd-autosave';
import type { useDfdAutosave } from './use-dfd-autosave';

/*
 * Faixas e diálogos do autosave do DFD (US-015 · SCR-007): bloqueio (FA-05/06/07 — "Copiar meu
 * texto"), recuperação de pendências locais (FA-08), conflito na seção (FA-01/FA-10 — com "Ver
 * diferenças") e conflito no cabeçalho por campo (FA-02). Os componentes são os genéricos de
 * `@contrataflow/ui`; aqui só os textos, os valores formatados e a ligação com o hook.
 */

type DfdAutosave = ReturnType<typeof useDfdAutosave>;

export interface DfdAutosavePanelsProps {
  readonly autosave: DfdAutosave;
  readonly userId: string;
  readonly timeZone: string;
  readonly sections: Readonly<Record<string, string>>;
  readonly templateSections: readonly DfdTemplateSectionDto[];
}

function timeOf(value: string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(value),
  );
}

export function DfdBlockedBanner({
  block,
  timeZone,
  sections,
  templateSections,
}: {
  readonly block: DfdAutosaveBlock;
  readonly timeZone: string;
  readonly sections: Readonly<Record<string, string>>;
  readonly templateSections: readonly DfdTemplateSectionDto[];
}) {
  const t = useTranslations('dfd');
  const tProcesses = useTranslations('processes');
  const [copied, setCopied] = useState(false);
  let title: string;
  switch (block.code) {
    case 'DOCUMENT_NOT_EDITABLE':
      title =
        block.status !== undefined && block.statusSince !== undefined
          ? t('autosave.blocked.notEditable', {
              status: t(`readOnly.status.${block.status}` as never),
              time: timeOf(block.statusSince, timeZone),
            })
          : t('autosave.blocked.notEditableNoTime');
      break;
    case 'NOT_PROCESS_CUSTODIAN':
    case 'PERMISSION_DENIED':
      title = t('autosave.blocked.notCustodian');
      break;
    case 'INVALID_PROCESS_STATUS':
      title = t('autosave.blocked.processStatus', {
        status:
          block.processStatus === undefined
            ? ''
            : tProcesses(`statuses.${block.processStatus}` as never).toLowerCase(),
      });
      break;
    case 'SESSION_EXPIRED':
      title = t('autosave.blocked.sessionExpired');
      break;
    default:
      title = t('autosave.blocked.generic');
  }
  const text = templateSections
    .map((section) => [section.title, sections[section.key] ?? ''] as const)
    .filter(([, value]) => value.trim() !== '')
    .map(([heading, value]) => `${heading}\n${value}`)
    .join('\n\n');
  return (
    <Alert tone="warning" title={title}>
      <p>{t('autosave.blocked.kept')}</p>
      {text === '' ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
              });
            }}
          >
            {t('autosave.blocked.copy')}
          </Button>
          {copied ? <span role="status">{t('autosave.blocked.copied')}</span> : null}
        </div>
      )}
    </Alert>
  );
}

export function DfdAutosavePanels({
  autosave,
  userId,
  timeZone,
  sections,
  templateSections,
}: DfdAutosavePanelsProps) {
  const t = useTranslations('dfd');
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>) => {
    setBusy(true);
    void work().finally(() => {
      setBusy(false);
    });
  };
  const { conflict, recovered, blocked } = autosave;
  const conflictLabels = {
    title: t('autosave.conflict.title'),
    changedBy: (name: string, time: string) => t('autosave.conflict.changedBy', { name, time }),
    changedBySelf: (time: string) => t('autosave.conflict.changedBySelf', { time }),
    description: t('autosave.conflict.description'),
    showDiff: t('autosave.conflict.showDiff'),
    hideDiff: t('autosave.conflict.hideDiff'),
    keepMine: t('autosave.conflict.keepMine'),
    discardMine: t('autosave.conflict.discardMine'),
    serverColumn: t('autosave.conflict.serverColumn'),
    mineColumn: t('autosave.conflict.mineColumn'),
    inserted: t('autosave.conflict.inserted'),
    removed: t('autosave.conflict.removed'),
    empty: t('autosave.conflict.empty'),
  };
  const formatField = (field: string, draft: DfdHeaderDraft): string => {
    const value = draft[field as keyof DfdHeaderDraft];
    if (value === null || value === undefined || value === '')
      return t('autosave.headerConflict.empty');
    if (field === 'priority') return t(`identification.priorities.${String(value)}` as never);
    if ((field === 'requestDate' || field === 'expectedDate') && typeof value === 'string') {
      const [year, month, day] = value.split('-');
      return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
    }
    return Array.isArray(value) ? value.join(', ') : String(value);
  };
  return (
    <>
      {blocked === null ? null : (
        <DfdBlockedBanner
          block={blocked}
          timeZone={timeZone}
          sections={sections}
          templateSections={templateSections}
        />
      )}
      {recovered === null || blocked !== null ? null : (
        <RecoveredDraftBanner
          time={timeOf(recovered.savedAt, timeZone)}
          busy={busy}
          labels={{
            title: (time) => t('autosave.recovered.title', { time }),
            restore: t('autosave.recovered.restore'),
            discard: t('autosave.recovered.discard'),
          }}
          onRestore={() => {
            run(() => autosave.restore());
          }}
          onDiscard={() => {
            run(() => autosave.discardRecovered());
          }}
        />
      )}
      {conflict?.kind === 'section' ? (
        <ConflictDialog
          open
          busy={busy}
          authorName={conflict.current.updatedBy?.name ?? t('autosave.conflict.someone')}
          isSelf={conflict.current.updatedBy?.id === userId}
          time={timeOf(conflict.current.updatedAt, timeZone)}
          sectionTitle={
            templateSections.find((section) => section.key === conflict.key)?.title ?? conflict.key
          }
          serverText={conflict.current.content ? richTextPlainText(conflict.current.content) : ''}
          localText={sections[conflict.key] ?? ''}
          labels={conflictLabels}
          onKeepMine={() => {
            run(() => autosave.keepMine(sections[conflict.key] ?? ''));
          }}
          onDiscardMine={() => {
            run(() => autosave.discardMine());
          }}
        />
      ) : null}
      {conflict?.kind === 'header' ? (
        <HeaderConflictDialog
          open
          busy={busy}
          authorName={conflict.server.updatedBy?.name ?? t('autosave.conflict.someone')}
          time={timeOf(conflict.server.updatedAt, timeZone)}
          fields={conflict.fields.map((field) => ({
            field,
            label: t(`autosave.headerConflict.fields.${field}` as never),
            mine: formatField(field, conflict.local),
            theirs: formatField(field, headerDraftOf(conflict.server)),
          }))}
          labels={{
            title: t('autosave.headerConflict.title'),
            description: (fields) => t('autosave.headerConflict.description', { fields }),
            mine: t('autosave.headerConflict.mine'),
            theirs: (name, time) => t('autosave.headerConflict.theirs', { name, time }),
            confirm: t('autosave.headerConflict.confirm'),
          }}
          onResolve={(choices) => {
            run(() => autosave.resolveHeader(choices));
          }}
        />
      ) : null}
    </>
  );
}
