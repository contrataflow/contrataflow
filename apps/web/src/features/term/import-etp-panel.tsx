'use client';

import {
  Alert,
  Button,
  cx,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import { TERM_IMPORT_MESSAGES } from '@contrataflow/validation';
import type {
  TermImportField,
  TermImportFieldPreviewDto,
  TermImportItemPreviewDto,
  TermImportResultDto,
  TermImportSectionPreviewDto,
  TermTemplateSectionDto,
} from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { newIdempotencyKey } from '@/lib/api/client';
import { useTenantId } from '@/lib/session/session-context';

import {
  canApplySelection,
  classifyEtpImportError,
  initialSelection,
  itemsToImport,
  needsValueSourceConfirmation,
  toApplyBody,
  toggle,
} from './etp-import-model';
import type { EtpImportFailure, EtpImportSelection } from './etp-import-model';
import { applyEtpImport, previewEtpImport, termKeys } from './term.api';

/*
 * Painel "Importar do ETP" (SCR-012 · US-037 · fluxo principal 1–8): TRM-05 (prévia com o "antes /
 * depois" de cada seção, os campos e os itens, tudo pré-marcado) → seleção → TRM-06 (`If-Match` do
 * TR e uma `Idempotency-Key` por prévia). FA-01: sem seleção, "Aplicar" desabilitado. FA-02: aviso
 * de ETP em elaboração. FA-03: prévia expirada recarrega sozinha. FA-04: "Sobrescrever itens já
 * especificados". FA-05: valor sigiloso não aparece. RN-TR-22: confirmação da troca da origem do
 * valor (`ReplaceValueSourceDialog`). Abaixo de 768 px o "antes / depois" vira abas.
 */

export interface ImportEtpPanelProps {
  readonly open: boolean;
  readonly processId: string;
  readonly termId: string;
  /** Versão do TR (`If-Match`). */
  readonly version: number;
  readonly sections: readonly TermTemplateSectionDto[];
  readonly onClose: () => void;
  /** Importação aplicada: recarregar o TR (editor e timeline). */
  readonly onImported: (result: TermImportResultDto) => Promise<void>;
  /** O TR mudou (412/428) ou ficou bloqueado: recarregar o documento. */
  readonly onStale: () => Promise<void>;
}

export function ImportEtpPanel(props: ImportEtpPanelProps) {
  const { open, onClose } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" closeLabel={null}>
        {open ? <ImportEtpFlow {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportEtpFlow({
  processId,
  termId,
  version,
  sections,
  onClose,
  onImported,
  onStale,
}: ImportEtpPanelProps) {
  const t = useTranslations('term.editor.import');
  const tenantId = useTenantId();
  // TRM-05 é somente leitura: cada abertura do painel pede uma prévia nova (sem cache).
  const query = useQuery({
    queryKey: termKeys.importPreview(tenantId, termId),
    queryFn: () => previewEtpImport(termId),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    throwOnError: false,
  });
  const [chosen, setChosen] = useState<{
    readonly token: string;
    readonly selection: EtpImportSelection;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<EtpImportFailure | null>(null);
  /** Uma chave por prévia: o reenvio da mesma aplicação repete a chave. */
  const applyKey = useRef<{ readonly token: string; readonly key: string } | null>(null);
  const titles = new Map(sections.map((section) => [section.key, section.title]));

  const preview = query.data;
  const current: EtpImportSelection | null =
    preview === undefined
      ? null
      : chosen?.token === preview.importToken
        ? chosen.selection
        : initialSelection(preview);

  const reload = async () => {
    setFailure(null);
    setChosen(null);
    await query.refetch();
  };

  const apply = async (confirmReplaceValueSource: boolean) => {
    if (preview === undefined || current === null) return;
    if (!confirmReplaceValueSource && needsValueSourceConfirmation(preview, current)) {
      setConfirming(true);
      return;
    }
    if (applyKey.current?.token !== preview.importToken) {
      applyKey.current = { token: preview.importToken, key: newIdempotencyKey() };
    }
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await applyEtpImport(
        termId,
        toApplyBody(preview, current, confirmReplaceValueSource),
        version,
        applyKey.current.key,
      );
      toast({
        title: TERM_IMPORT_MESSAGES.applied(result.sectionsImported.length, result.itemsImported),
        tone: 'success',
      });
      onClose();
      await onImported(result);
    } catch (error) {
      const outcome = classifyEtpImportError(error, t('unexpected'));
      setConfirming(false);
      if (outcome.kind === 'reload') {
        // FA-03: a prévia venceu ou a origem mudou — recarrega sozinha, com o aviso.
        setNotice(outcome.message);
        await reload();
        return;
      }
      if (outcome.kind === 'conflict' || outcome.kind === 'blocked') {
        onClose();
        toast({ title: outcome.message, tone: 'error' });
        await onStale();
        return;
      }
      setFailure(outcome);
    } finally {
      setBusy(false);
    }
  };

  const header = (
    <>
      <DialogTitle>{t('title')}</DialogTitle>
      <DialogDescription>{t('description')}</DialogDescription>
    </>
  );

  if (query.isFetching || (preview === undefined && query.error === null)) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
        {notice === null ? null : <p className="text-sm">{notice}</p>}
      </div>
    );
  }

  const loadFailure =
    query.error === null ? null : classifyEtpImportError(query.error, t('unexpected'));
  if (loadFailure?.kind === 'noEtp' || failure?.kind === 'noEtp') {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        <Alert tone="info" title={TERM_IMPORT_MESSAGES.etpRequired}>
          <Link className="text-primary underline" href={`/processos/${processId}`}>
            {t('createEtp')}
          </Link>
        </Alert>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  if (loadFailure !== null || preview === undefined || current === null) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {header}
        {loadFailure === null ? null : (
          <FailureAlert failure={loadFailure} busy={busy} onRetry={() => void reload()} />
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  const update = (next: Partial<EtpImportSelection>) => {
    setChosen({ token: preview.importToken, selection: { ...current, ...next } });
    setConfirming(false);
  };
  const applicable = canApplySelection(current);
  const items = itemsToImport(preview, current);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {notice === null ? null : (
        <Alert tone="info" title={notice}>
          {null}
        </Alert>
      )}
      {preview.etp.inProgress ? (
        <Alert tone="warning" title={TERM_IMPORT_MESSAGES.etpInProgress}>
          {null}
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {preview.etp.versionNumber === null
          ? t('source', { code: preview.etp.code ?? 'ETP' })
          : t('sourceVersion', {
              code: preview.etp.code ?? 'ETP',
              version: preview.etp.versionNumber,
            })}
      </p>
      <p aria-live="polite" className="sr-only">
        {t('summary', {
          sections: preview.sections.length,
          fields: preview.fields.length,
          items: preview.items.count,
        })}
      </p>

      <SectionImportList
        sections={preview.sections}
        titles={titles}
        selected={current.sections}
        onToggle={(key, checked) => {
          update({ sections: toggle(current.sections, key, checked) });
        }}
      />
      <FieldImportList
        fields={preview.fields}
        selected={current.fields}
        onToggle={(field, checked) => {
          update({ fields: toggle(current.fields, field, checked) });
        }}
      />
      <ItemsImportTable
        items={preview.items.preview}
        copyItems={current.copyItems}
        overwriteExisting={current.overwriteExisting}
        onCopyItems={(copyItems) => {
          update({ copyItems });
        }}
        onOverwrite={(overwriteExisting) => {
          update({ overwriteExisting });
        }}
      />

      {confirming ? (
        <ReplaceValueSourceDialog
          busy={busy}
          onConfirm={() => void apply(true)}
          onCancel={() => {
            setConfirming(false);
          }}
        />
      ) : null}
      <div aria-live="polite">
        {failure === null ? null : (
          <FailureAlert failure={failure} busy={busy} onRetry={() => void apply(false)} />
        )}
      </div>
      <p className="text-sm" aria-live="polite">
        {t('selected', { sections: current.sections.length, items })}
      </p>
      {applicable ? null : (
        <p id="import-etp-empty" className="text-sm text-warning">
          {TERM_IMPORT_MESSAGES.noSelection}
        </p>
      )}
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          disabled={!applicable || busy || confirming}
          aria-describedby={applicable ? undefined : 'import-etp-empty'}
          onClick={() => void apply(false)}
        >
          {busy ? t('applying') : t('apply')}
        </Button>
      </DialogFooter>
    </div>
  );
}

function FailureAlert({
  failure,
  busy,
  onRetry,
}: {
  readonly failure: EtpImportFailure;
  readonly busy: boolean;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('term.editor.import');
  const tErrors = useTranslations('errors.correlation');
  const message = failure.kind === 'noEtp' ? TERM_IMPORT_MESSAGES.etpRequired : failure.message;
  const correlationId = failure.kind === 'retry' ? failure.correlationId : null;
  return (
    <Alert tone="error" title={message}>
      {failure.kind === 'retry' ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onRetry}>
            {t('retry')}
          </Button>
          {correlationId === null ? null : (
            <CorrelationCode
              correlationId={correlationId}
              labels={{
                code: tErrors('label', { correlationId }),
                copy: tErrors('copy'),
                copied: tErrors('copied'),
              }}
            />
          )}
        </div>
      ) : null}
    </Alert>
  );
}

// --- Seções ("antes / depois") -------------------------------------------------------------------

function SectionImportList({
  sections,
  titles,
  selected,
  onToggle,
}: {
  readonly sections: readonly TermImportSectionPreviewDto[];
  readonly titles: ReadonlyMap<string, string>;
  readonly selected: readonly string[];
  readonly onToggle: (key: string, checked: boolean) => void;
}) {
  const t = useTranslations('term.editor.import');
  const id = useId();
  if (sections.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('sections.empty')}</p>;
  }
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-semibold">{t('sections.legend')}</legend>
      {sections.map((section) => {
        const checkboxId = `${id}-${section.target}`;
        const title = titles.get(section.target) ?? section.target;
        return (
          <div key={section.target} className="rounded-control border border-border p-3">
            <div className="flex items-start gap-2">
              <input
                id={checkboxId}
                type="checkbox"
                className="mt-1 size-4"
                checked={selected.includes(section.target)}
                onChange={(event) => {
                  onToggle(section.target, event.target.checked);
                }}
              />
              <label htmlFor={checkboxId} className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium break-words">{title}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`sections.mode.${section.mode}`)}
                </span>
              </label>
            </div>
            <BeforeAfter before={section.before} after={section.preview} />
          </div>
        );
      })}
    </fieldset>
  );
}

function BeforeAfter({ before, after }: { readonly before: string; readonly after: string }) {
  const t = useTranslations('term.editor.import');
  const [tab, setTab] = useState<'before' | 'after'>('after');
  const column = (side: 'before' | 'after', text: string) => (
    <section
      aria-label={t(`diff.${side}`)}
      className={cx('min-w-0 flex-col gap-1', tab === side ? 'flex' : 'hidden md:flex')}
    >
      <h4 className="hidden text-xs font-semibold md:block">{t(`diff.${side}`)}</h4>
      <div className="max-h-48 overflow-auto rounded-control border border-border p-2 text-sm break-words whitespace-pre-wrap">
        {text === '' ? <span className="text-muted-foreground">{t('diff.empty')}</span> : text}
      </div>
    </section>
  );
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div role="group" aria-label={t('diff.label')} className="flex gap-1 md:hidden">
        {(['before', 'after'] as const).map((side) => (
          <Button
            key={side}
            size="sm"
            variant={tab === side ? 'primary' : 'secondary'}
            aria-pressed={tab === side}
            onClick={() => {
              setTab(side);
            }}
          >
            {t(`diff.${side}`)}
          </Button>
        ))}
      </div>
      <div className="grid min-w-0 gap-2 md:grid-cols-2">
        {column('before', before)}
        {column('after', after)}
      </div>
    </div>
  );
}

// --- Campos --------------------------------------------------------------------------------------

export function FieldImportList({
  fields,
  selected,
  onToggle,
}: {
  readonly fields: readonly TermImportFieldPreviewDto[];
  readonly selected: readonly TermImportField[];
  readonly onToggle: (field: TermImportField, checked: boolean) => void;
}) {
  const t = useTranslations('term.editor.import');
  const id = useId();
  if (fields.length === 0) return null;
  const valueOf = (field: TermImportFieldPreviewDto, value: string | null) => {
    if (field.valueMasked) return t('fields.masked');
    if (value === null) return t('fields.none');
    return field.target === 'estimatedTotalValue' ? money(value) : t('fields.linked');
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-semibold">{t('fields.legend')}</legend>
      {fields.map((field) => {
        const checkboxId = `${id}-${field.target}`;
        return (
          <div key={field.target} className="flex items-start gap-2">
            <input
              id={checkboxId}
              type="checkbox"
              className="mt-1 size-4"
              disabled={field.valueMasked}
              checked={!field.valueMasked && selected.includes(field.target)}
              onChange={(event) => {
                onToggle(field.target, event.target.checked);
              }}
            />
            <label htmlFor={checkboxId} className="flex min-w-0 flex-col text-sm">
              <span className="font-medium">{t(`fields.${field.target}`)}</span>
              <span className="text-muted-foreground">
                {t('fields.change', {
                  current: valueOf(field, field.current),
                  next: valueOf(field, field.value),
                })}
              </span>
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

function money(value: string): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
    Number(value),
  );
}

function quantity(value: string): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(Number(value));
}

// --- Itens ---------------------------------------------------------------------------------------

export function ItemsImportTable({
  items,
  copyItems,
  overwriteExisting,
  onCopyItems,
  onOverwrite,
}: {
  readonly items: readonly TermImportItemPreviewDto[];
  readonly copyItems: boolean;
  readonly overwriteExisting: boolean;
  readonly onCopyItems: (value: boolean) => void;
  readonly onOverwrite: (value: boolean) => void;
}) {
  const t = useTranslations('term.editor.import');
  const id = useId();
  if (items.length === 0) return null;
  const specified = items.some((item) => item.specified);
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-2 text-sm font-semibold">{t('items.legend')}</legend>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-copy`}
          type="checkbox"
          role="switch"
          className="size-4"
          checked={copyItems}
          onChange={(event) => {
            onCopyItems(event.target.checked);
          }}
        />
        <label htmlFor={`${id}-copy`} className="text-sm">
          {t('items.copy', { count: items.length })}
        </label>
      </div>
      {specified ? (
        <div className="flex items-center gap-2">
          <input
            id={`${id}-overwrite`}
            type="checkbox"
            role="switch"
            className="size-4"
            disabled={!copyItems}
            checked={overwriteExisting}
            onChange={(event) => {
              onOverwrite(event.target.checked);
            }}
          />
          <label htmlFor={`${id}-overwrite`} className="text-sm">
            {t('items.overwrite')}
          </label>
        </div>
      ) : null}
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <caption className="sr-only">{t('items.caption')}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-2">
                {t('items.sequence')}
              </th>
              <th scope="col" className="py-1 pr-2">
                {t('items.description')}
              </th>
              <th scope="col" className="py-1 pr-2 text-right">
                {t('items.etpQuantity')}
              </th>
              <th scope="col" className="py-1 text-right">
                {t('items.trQuantity')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.processItemId} className="border-b border-border last:border-b-0">
                <td className="py-1 pr-2">{item.sequence}</td>
                <td className="py-1 pr-2 break-words">
                  {item.description}
                  {item.specified ? (
                    <span className="ml-1 text-xs text-warning">{t('items.specified')}</span>
                  ) : null}
                </td>
                <td className="py-1 pr-2 text-right">{quantity(item.etpQuantity)}</td>
                <td className="py-1 text-right">
                  {item.trCurrentQuantity === null
                    ? t('items.new')
                    : quantity(item.trCurrentQuantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </fieldset>
  );
}

// --- Confirmação da origem do valor (RN-TR-22) --------------------------------------------------

export function ReplaceValueSourceDialog({
  busy,
  onConfirm,
  onCancel,
}: {
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('term.editor.import');
  const id = useId();
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="flex flex-col gap-2 rounded-control border border-warning p-3"
    >
      <p id={`${id}-title`} className="font-medium">
        {t('confirmSource.title')}
      </p>
      <p id={`${id}-body`} className="text-sm">
        {TERM_IMPORT_MESSAGES.confirmReplaceValueSource}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onConfirm}>
          {t('confirmSource.confirm')}
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          {t('confirmSource.cancel')}
        </Button>
      </div>
    </div>
  );
}

// --- Aviso de defasagem (RN-TR-24) --------------------------------------------------------------

export function StaleEtpBanner({
  editable,
  onReimport,
}: {
  readonly editable: boolean;
  readonly onReimport: () => void;
}) {
  const t = useTranslations('term.editor.import');
  return (
    <Alert tone="warning" title={TERM_IMPORT_MESSAGES.staleEtp}>
      {editable ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onReimport}>
          {t('reimport')}
        </Button>
      ) : null}
    </Alert>
  );
}
