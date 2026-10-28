'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { TemplateDto, TemplateVersionHistoryItem, Violation } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { ApiError } from '@/lib/api/api-error';
import { useIdempotentMutation } from '@/lib/api/use-idempotent-mutation';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { SystemTemplateBadge } from './system-template-badge';
import { formatDateTime, prePublishProblems, retireBlocked } from './template-versions-model';
import type { PublishProblem } from './template-versions-model';
import {
  createTemplateVersion,
  fetchTemplate,
  fetchTemplateVersion,
  fetchTemplateVersions,
  publishTemplateVersion,
  retireTemplateVersion,
  shortHash,
  templateEditorHref,
  templateKeys,
  TEMPLATES_PATH,
  TEMPLATES_STALE_TIME_MS,
} from './templates.api';

const LINK =
  'inline-flex h-8 items-center rounded-control border border-border px-3 text-sm font-medium hover:bg-muted';

/** Mensagem do erro de ação para o usuário (Casos de erro da US-108). */
function actionErrorMessage(error: unknown, t: ReturnType<typeof useTranslations>): string {
  if (!isApiError(error)) return t('versions.errors.generic');
  if (error.code === 'VERSION_CONFLICT') return t('versions.errors.conflict');
  if (error.code === 'TEMPLATE_VERSION_NOT_DRAFT' || error.code === 'INVALID_STATE') {
    return t('versions.errors.state');
  }
  if (error.code === 'DEPENDENCY_UNAVAILABLE') return t('versions.errors.unavailable');
  return error.message;
}

/**
 * SCR-033, aba "Versões" (`/admin/templates/[id]` · US-108): histórico de versões do template
 * (TPL-05) com número, situação, datas, hash resumido e notas; "Iniciar nova versão" (TPL-06,
 * `TEMPLATE_MANAGE`), "Publicar" (TPL-10) e "Aposentar" (TPL-11) para quem tem `TEMPLATE_PUBLISH`.
 * Só `TEMPLATE_VIEW` navega em modo leitura (FA-05). A API decide (RN-FND-92).
 */
export function TemplateVersionsView({ templateId }: { readonly templateId: string }) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const canManage = usePermission('TEMPLATE_MANAGE').allowed;
  const canPublish = usePermission('TEMPLATE_PUBLISH').allowed;
  const [publishing, setPublishing] = useState<TemplateVersionHistoryItem | null>(null);
  const [retiring, setRetiring] = useState<TemplateVersionHistoryItem | null>(null);
  const [draftExists, setDraftExists] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const template = useQuery({
    queryKey: templateKeys.detail(tenantId, templateId),
    queryFn: async ({ signal }) => (await fetchTemplate(templateId, signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
  });
  const history = useQuery({
    queryKey: templateKeys.versions(tenantId, templateId),
    queryFn: async ({ signal }) => (await fetchTemplateVersions(templateId, signal)).data,
    staleTime: TEMPLATES_STALE_TIME_MS,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: templateKeys.all(tenantId) });
  };

  const create = useIdempotentMutation({
    mutationFn: (_: undefined, context) => createTemplateVersion(templateId, context),
  });

  const onCreate = async () => {
    setCreateError(null);
    setDraftExists(false);
    try {
      const result = await create.submit(undefined);
      toast({
        title: t('versions.toast.created', { number: result.data.versionNumber }),
        tone: 'success',
      });
      refresh();
      router.push(templateEditorHref(templateId, result.data.id));
    } catch (error) {
      // RN-TPL-13: outra pessoa criou o rascunho primeiro — a tela passa a oferecê-lo.
      if (isApiError(error) && error.code === 'TEMPLATE_DRAFT_EXISTS') {
        setDraftExists(true);
        refresh();
        return;
      }
      setCreateError(actionErrorMessage(error, t));
    }
  };

  const failure = template.error ?? history.error;
  if (failure && isApiError(failure) && failure.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const data = template.data;
  const items = history.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={TEMPLATES_PATH} className="text-sm text-muted-foreground hover:underline">
          ← {t('versions.back')}
        </Link>
      </div>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data?.name ?? <Skeleton className="h-8 w-64" />}
          </h1>
          {data ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
              <span>{t('versions.subtitle', { type: data.documentType.name })}</span>
              {data.isSystem ? <SystemTemplateBadge /> : null}
              {data.isDefault ? <Badge tone="ok">{t('badges.default')}</Badge> : null}
              {!data.isActive ? <Badge tone="muted">{t('badges.inactive')}</Badge> : null}
            </p>
          ) : null}
        </div>
        {canManage && data?.draftVersion === null ? (
          <Button
            disabled={create.isPending}
            aria-busy={create.isPending}
            onClick={() => void onCreate()}
          >
            {create.isPending ? t('versions.creating') : t('versions.newVersion')}
          </Button>
        ) : null}
      </header>

      {draftExists ? (
        <Alert tone="info" title={t('versions.draftExists')}>
          {data?.draftVersion ? (
            <Link href={templateEditorHref(templateId, data.draftVersion.id)} className={LINK}>
              {t('versions.openDraft')}
            </Link>
          ) : null}
        </Alert>
      ) : null}
      {createError ? <Alert tone="error" title={createError} /> : null}

      <section aria-labelledby="template-versions-heading" className="flex flex-col gap-2">
        <h2 id="template-versions-heading" className="text-lg font-semibold">
          {t('versions.heading')}
        </h2>
        {history.isPending || template.isPending ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">{t('versions.loading')}</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : null}
        {history.isError || template.isError ? (
          <Alert tone="error" title={t('versions.loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void template.refetch();
                void history.refetch();
              }}
            >
              {t('retry')}
            </Button>
          </Alert>
        ) : null}
        {data && history.data ? (
          <VersionHistoryTable
            template={data}
            items={items}
            canPublish={canPublish}
            onPublish={setPublishing}
            onRetire={setRetiring}
          />
        ) : null}
      </section>

      <PublishConfirmDialog
        templateId={templateId}
        item={publishing}
        onClose={() => {
          setPublishing(null);
        }}
        onDone={refresh}
      />
      <RetireConfirmDialog
        template={data ?? null}
        item={retiring}
        blocked={retiring !== null && retireBlocked(retiring, items, data?.isDefault ?? false)}
        onClose={() => {
          setRetiring(null);
        }}
        onDone={refresh}
      />
    </div>
  );
}

function Badge({ children, tone }: { readonly children: string; readonly tone: 'muted' | 'ok' }) {
  return (
    <span
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${
        tone === 'ok' ? 'bg-success-soft text-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {children}
    </span>
  );
}

/** `VersionHistoryTable`: situação, datas, hash resumido, notas e ações por linha. */
function VersionHistoryTable({
  template,
  items,
  canPublish,
  onPublish,
  onRetire,
}: {
  readonly template: TemplateDto;
  readonly items: readonly TemplateVersionHistoryItem[];
  readonly canPublish: boolean;
  readonly onPublish: (item: TemplateVersionHistoryItem) => void;
  readonly onRetire: (item: TemplateVersionHistoryItem) => void;
}) {
  const t = useTranslations('templates');
  const tooltipId = useId();
  if (items.length === 0) return <p className="text-muted-foreground">{t('versions.empty')}</p>;
  return (
    <div className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">{t('versions.caption')}</caption>
        <thead className="bg-muted text-xs text-muted-foreground uppercase">
          <tr>
            {(
              ['number', 'status', 'publishedAt', 'retiredAt', 'hash', 'notes', 'actions'] as const
            ).map((column) => (
              <th key={column} scope="col" className="px-3 py-2">
                {t(`versions.table.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const blocked = retireBlocked(item, items, template.isDefault);
            const hash = shortHash(item.contentHash);
            return (
              <tr key={item.id} className="border-t border-border align-top">
                <th scope="row" className="px-3 py-2 font-medium">
                  {t('versions.number', { number: item.versionNumber })}
                </th>
                <td className="px-3 py-2">
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={item.status === 'PUBLISHED' ? 'ok' : 'muted'}>
                      {t(`versions.status.${item.status}`)}
                    </Badge>
                    {item.isCurrent ? <Badge tone="ok">{t('versions.current')}</Badge> : null}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {formatDateTime(item.publishedAt) ?? t('versions.noValue')}
                </td>
                <td className="px-3 py-2">
                  {formatDateTime(item.retiredAt) ?? t('versions.noValue')}
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  {hash ? (
                    <span title={item.contentHash ?? undefined}>{hash}</span>
                  ) : (
                    t('versions.noValue')
                  )}
                </td>
                <td className="max-w-xs px-3 py-2 text-muted-foreground">
                  {item.changeNotes ?? t('versions.noValue')}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={templateEditorHref(template.id, item.id)}
                      className={LINK}
                      aria-label={
                        item.status === 'DRAFT'
                          ? t('versions.actions.edit', { number: item.versionNumber })
                          : t('versions.actions.view', { number: item.versionNumber })
                      }
                    >
                      {item.status === 'DRAFT'
                        ? t('versions.actions.editLabel')
                        : t('versions.actions.viewLabel')}
                    </Link>
                    {canPublish && item.status === 'DRAFT' ? (
                      <Button
                        size="sm"
                        aria-label={t('versions.actions.publish', { number: item.versionNumber })}
                        onClick={() => {
                          onPublish(item);
                        }}
                      >
                        {t('versions.actions.publishLabel')}
                      </Button>
                    ) : null}
                    {canPublish && item.status === 'PUBLISHED' ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={blocked}
                          aria-label={t('versions.actions.retire', { number: item.versionNumber })}
                          aria-describedby={blocked ? `${tooltipId}-${item.id}` : undefined}
                          title={blocked ? t('versions.retireBlocked') : undefined}
                          onClick={() => {
                            onRetire(item);
                          }}
                        >
                          {t('versions.actions.retireLabel')}
                        </Button>
                        {blocked ? (
                          <span id={`${tooltipId}-${item.id}`} className="sr-only">
                            {t('versions.retireBlocked')}
                          </span>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Lista de pendências (locais ou do 422), referenciada pelo `aria-describedby` do diálogo. */
function ProblemList({
  id,
  problems,
}: {
  readonly id: string;
  readonly problems: readonly PublishProblem[];
}) {
  return (
    <ul id={id} className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {problems.map((problem, index) => (
        <li key={`${problem.sectionKey ?? 'geral'}-${String(index)}`}>
          {problem.sectionKey ? <span className="font-mono">{problem.sectionKey}: </span> : null}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

const fromViolations = (violations: readonly Violation[]): PublishProblem[] =>
  violations.map((violation) => ({ sectionKey: violation.sectionKey, message: violation.message }));

/**
 * `PublishConfirmDialog` (passos 2–4): confere o rascunho com a validação do editor antes de
 * enviar (desabilita "Publicar" havendo pendências) e mostra as violações do 422 por seção.
 */
function PublishConfirmDialog({
  templateId,
  item,
  onClose,
  onDone,
}: {
  readonly templateId: string;
  readonly item: TemplateVersionHistoryItem | null;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {item ? (
        <PublishBody
          key={item.id}
          templateId={templateId}
          item={item}
          onClose={onClose}
          onDone={onDone}
        />
      ) : null}
    </Dialog>
  );
}

function PublishBody({
  templateId,
  item,
  onClose,
  onDone,
}: {
  readonly templateId: string;
  readonly item: TemplateVersionHistoryItem;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('templates');
  const tenantId = useTenantId();
  const ids = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [serverProblems, setServerProblems] = useState<PublishProblem[]>([]);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const draft = useQuery({
    queryKey: templateKeys.version(tenantId, item.id),
    queryFn: async ({ signal }) => (await fetchTemplateVersion(item.id, signal)).data,
    staleTime: 0,
  });
  const localProblems = draft.data ? prePublishProblems(draft.data) : [];
  const problems = serverProblems.length > 0 ? serverProblems : localProblems;

  const publish = useIdempotentMutation({
    mutationFn: (_: undefined, context) => publishTemplateVersion(item.id, item.version, context),
  });

  const onConfirm = async () => {
    setError(null);
    setServerProblems([]);
    try {
      const result = await publish.submit(undefined);
      toast({
        title: t('versions.toast.published', {
          number: result.data.versionNumber,
          hash: shortHash(result.data.contentHash) ?? '',
        }),
        tone: 'success',
      });
      onDone();
      onClose();
    } catch (failure) {
      if (isApiError(failure) && failure.code === 'TEMPLATE_INVALID') {
        setServerProblems(fromViolations(failure.violations));
        return;
      }
      setError(failure instanceof Error ? failure : new Error(String(failure)));
      if (isApiError(failure) && failure.code !== 'DEPENDENCY_UNAVAILABLE') onDone();
    }
  };

  const blocked = problems.length > 0 || draft.isPending || draft.isError;
  const unavailable = isApiError(error) && error.code === 'DEPENDENCY_UNAVAILABLE';
  // Foco inicial na ação primária assim que o rascunho conferido a habilita.
  useEffect(() => {
    if (!blocked) confirmRef.current?.focus();
  }, [blocked]);
  return (
    <DialogContent
      aria-describedby={problems.length > 0 ? `${ids}-problems` : `${ids}-description`}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        confirmRef.current?.focus();
      }}
    >
      <DialogTitle>{t('versions.publish.title', { number: item.versionNumber })}</DialogTitle>
      <DialogDescription id={`${ids}-description`}>
        {t('versions.publish.description')}
      </DialogDescription>
      {draft.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('versions.publish.checking')}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <Alert tone="error" title={t('versions.publish.violationsTitle')}>
          <ProblemList id={`${ids}-problems`} problems={problems} />
          <Link href={templateEditorHref(templateId, item.id)} className={`${LINK} mt-2`}>
            {t('versions.publish.openEditor')}
          </Link>
        </Alert>
      ) : null}
      {error ? <Alert tone="error" title={actionErrorMessage(error, t)} /> : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {t('versions.publish.cancel')}
        </Button>
        <Button
          ref={confirmRef}
          disabled={blocked || publish.isPending || (error !== null && !unavailable)}
          aria-busy={publish.isPending}
          title={problems.length > 0 ? t('versions.publishBlocked') : undefined}
          onClick={() => void onConfirm()}
        >
          {publish.isPending
            ? t('versions.publish.publishing')
            : unavailable
              ? t('versions.errors.retry')
              : t('versions.publish.confirm')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * `RetireConfirmDialog` (passo 6 · FA-03): bloqueia com explicação quando é a única versão
 * publicada de um template padrão (`TEMPLATE_IN_USE`) e sugere iniciar uma nova versão.
 */
function RetireConfirmDialog({
  template,
  item,
  blocked,
  onClose,
  onDone,
}: {
  readonly template: TemplateDto | null;
  readonly item: TemplateVersionHistoryItem | null;
  readonly blocked: boolean;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useTranslations('templates');
  const ids = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  const retire = useMutation({
    mutationFn: (target: TemplateVersionHistoryItem) =>
      retireTemplateVersion(target.id, target.version),
    onSuccess: (result) => {
      toast({
        title: t('versions.toast.retired', { number: result.data.versionNumber }),
        tone: 'success',
      });
      onDone();
      onClose();
    },
    onError: (error) => {
      setMessage(
        isApiError(error) && error.code === 'TEMPLATE_IN_USE'
          ? error.message
          : actionErrorMessage(error, t),
      );
      onDone();
    },
  });

  const inUse = blocked
    ? t('versions.retire.inUse', { type: template?.documentType.name ?? '' })
    : null;
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (!open) {
          setMessage(null);
          onClose();
        }
      }}
    >
      {item ? (
        <DialogContent
          aria-describedby={`${ids}-description`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            confirmRef.current?.focus();
          }}
        >
          <DialogTitle>{t('versions.retire.title', { number: item.versionNumber })}</DialogTitle>
          <DialogDescription id={`${ids}-description`}>
            {inUse ?? t('versions.retire.description')}
          </DialogDescription>
          {message ? <Alert tone="error" title={message} /> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setMessage(null);
                onClose();
              }}
            >
              {t('versions.retire.cancel')}
            </Button>
            <Button
              ref={confirmRef}
              variant="destructive"
              disabled={inUse !== null || message !== null || retire.isPending}
              aria-busy={retire.isPending}
              onClick={() => {
                retire.mutate(item);
              }}
            >
              {retire.isPending ? t('versions.retire.retiring') : t('versions.retire.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
