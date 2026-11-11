'use client';

import { Alert, Button } from '@contrataflow/ui';
import type {
  ApprovalDecisionPolicy,
  WorkflowStageApproversDto,
  WorkflowStageDto,
} from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { outcomeOf } from './workflow-editor-errors';
import type { EditorProblem } from './workflow-editor-errors';
import { setStageApprovers } from './workflows.api';
import {
  ApproverLinesEditor,
  ApproverSummary,
  DecisionPolicySelect,
} from '../approvers/approver-lines-editor';
import {
  approverListProblems,
  draftsOf,
  hasProblems,
  lineIndexOf,
  linesBody,
  sameLines,
} from '../approvers/approver-lines-model';
import type { ApproverLineDraft, ApproverListProblems } from '../approvers/approver-lines-model';
import { useApproverLookups } from '../approvers/use-approver-lookups';

/**
 * A etapa depois do WF-65: política, linhas, `ETag` e — com lista — o aprovador único espelhando a
 * linha 1 (RN-APV-08), para o cache do editor ficar igual ao que a API gravou.
 */
export function stageWithApprovers(
  stage: WorkflowStageDto,
  result: WorkflowStageApproversDto,
): WorkflowStageDto {
  const [first] = result.approvers;
  const approvers = result.approvers.map(({ resolved: _resolved, ...line }) => line);
  return {
    ...stage,
    decisionPolicy: result.decisionPolicy,
    approvers,
    version: result.version,
    ...(first
      ? {
          approverType: first.approverType,
          approverUserId: first.approverUserId,
          approverRoleId: first.approverRoleId,
          approverDepartmentResolution: first.approverDepartmentResolution,
          approverFixedDepartmentId: first.approverFixedDepartmentId,
          allowDeputy: first.allowDeputy,
        }
      : {}),
  };
}

/**
 * "Quem decide" (SCR-034 · US-132 passos 1–5): política de decisão e lista ordenada de aprovadores
 * da etapa `APPROVAL`, salvas juntas pelo WF-65 com o `If-Match` da etapa. O rascunho aceita
 * `ALL`/`SEQUENTIAL` com menos de duas linhas (FA-03) — a validação da versão aponta o problema.
 * Sem `WORKFLOW_MANAGE` (ou versão publicada) a seção fica só em leitura, com o resumo.
 */
export function StageApproversSection({
  stage,
  readOnly,
  onSaved,
  onProblem,
}: {
  readonly stage: WorkflowStageDto;
  readonly readOnly: boolean;
  readonly onSaved: (stage: WorkflowStageDto) => void;
  readonly onProblem: (problem: EditorProblem) => void;
}) {
  const t = useTranslations('workflows.editor.approvers');
  const ids = useId();
  const [saved, setSaved] = useState(() => ({
    policy: stage.decisionPolicy,
    lines: draftsOf(stage.approvers),
  }));
  const [policy, setPolicy] = useState<ApprovalDecisionPolicy>(saved.policy);
  const [lines, setLines] = useState<ApproverLineDraft[]>(saved.lines);
  const [problems, setProblems] = useState<ApproverListProblems | null>(null);
  const [serverErrors, setServerErrors] = useState<Readonly<Record<number, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const lookups = useApproverLookups({
    users: lines.some((line) => line.approverType === 'USER'),
    roles: lines.some((line) => line.approverType === 'ROLE'),
    departments: lines.some((line) => line.approverDepartmentResolution === 'FIXED'),
  });

  const save = useMutation({
    mutationFn: () =>
      setStageApprovers(stage, { decisionPolicy: policy, approvers: linesBody(lines) }),
    onSuccess: (result) => {
      setSaved({ policy, lines });
      setStatus(t('saved'));
      onSaved(stageWithApprovers(stage, result.data));
    },
    onError: (error) => {
      setStatus('');
      const outcome = outcomeOf(error);
      if (outcome.kind === 'fields') {
        const byLine: Record<number, string> = {};
        const general: string[] = [];
        for (const item of outcome.errors) {
          const index = lineIndexOf(item.field);
          if (index === null) general.push(item.message);
          else byLine[index] ??= item.message;
        }
        setServerErrors(byLine);
        setFormError(general[0] ?? null);
      } else if (outcome.kind === 'screen') {
        onProblem(outcome.problem);
      } else {
        setFormError(t('failed'));
      }
    },
  });

  const dirty = policy !== saved.policy || !sameLines(lines, saved.lines);
  const submit = () => {
    const found = approverListProblems(policy, lines, { requireMinimum: false });
    setProblems(found);
    setServerErrors({});
    setFormError(null);
    if (hasProblems(found)) return;
    save.mutate();
  };

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <h3 id={`${ids}-title`} className="text-sm font-bold text-brand-ink">
        {t('title')}
      </h3>
      <ApproverSummary policy={saved.policy} lines={saved.lines} lookups={lookups} />
      {readOnly ? null : (
        <>
          <DecisionPolicySelect
            value={policy}
            onChange={(next) => {
              setPolicy(next);
              setStatus('');
            }}
          />
          <ApproverLinesEditor
            context="stage"
            policy={policy}
            lines={lines}
            onLinesChange={(next) => {
              setLines(next);
              setStatus('');
            }}
            problems={problems}
            serverErrors={serverErrors}
          />
          {policy !== 'ANY' && lines.length < 2 ? (
            <p className="text-[0.8125rem] text-muted-foreground">{t('minimumHint')}</p>
          ) : null}
          {formError ? <Alert tone="error" title={formError} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={!dirty || save.isPending}
              aria-busy={save.isPending}
              onClick={submit}
            >
              {save.isPending ? t('saving') : t('save')}
            </Button>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {status}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
