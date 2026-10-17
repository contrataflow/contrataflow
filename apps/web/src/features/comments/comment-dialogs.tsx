'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { COMMENT_LIMITS } from '@contrataflow/validation';
import type { CommentDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { composerProblemOf } from './comments-model';
import type { ComposerProblem } from './comments-model';
import { deleteComment } from './comments.api';

export interface CommentDialogProps {
  /** Comentário-alvo (`null` = fechado). */
  readonly comment: CommentDto | null;
  readonly onClose: () => void;
  /** Sucesso ou recusa por estado (412/404/409): o pai recarrega a lista. */
  readonly onChanged: (outcome: 'removed' | 'stale') => void;
}

function useRemoval(onChanged: CommentDialogProps['onChanged'], close: () => void) {
  const [problem, setProblem] = useState<ComposerProblem | null>(null);
  const mutation = useMutation({
    mutationFn: ({ comment, reason }: { comment: CommentDto; reason?: string }) =>
      deleteComment(comment.id, comment.version, reason),
    onSuccess: () => {
      setProblem(null);
      close();
      onChanged('removed');
    },
    onError: (error: unknown) => {
      const found = composerProblemOf(error);
      if (found.key === 'stale' || found.key === 'notFound') {
        close();
        onChanged('stale');
        return;
      }
      setProblem(found);
    },
  });
  return { mutation, problem, setProblem };
}

/** FA-03: confirmação da exclusão pelo autor (foco gerenciado pelo diálogo). */
export function DeleteCommentDialog({ comment, onClose, onChanged }: CommentDialogProps) {
  const t = useTranslations('comments.delete');
  const tErrors = useTranslations('comments.composer.errors');
  const { mutation, problem, setProblem } = useRemoval(onChanged, onClose);
  return (
    <Dialog
      open={comment !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          onClose();
        }
      }}
    >
      <DialogContent closeLabel={null}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <div aria-live="polite">
          {problem ? (
            <Alert
              tone="error"
              title={tErrors(problem.key, { correlationId: problem.correlationId })}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => {
              if (comment !== null) mutation.mutate({ comment });
            }}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** FA-04 (`ModerationDialog`): motivo obrigatório de 10–1.000 caracteres (V-11). */
export function ModerationDialog({ comment, onClose, onChanged }: CommentDialogProps) {
  const t = useTranslations('comments.moderation');
  const tErrors = useTranslations('comments.composer.errors');
  const reasonId = useId();
  const errorId = useId();
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const close = () => {
    setReason('');
    setInvalid(false);
    onClose();
  };
  const { mutation, problem, setProblem } = useRemoval(onChanged, close);
  const trimmed = reason.trim();
  return (
    <Dialog
      open={comment !== null}
      onOpenChange={(open) => {
        if (!open) {
          setProblem(null);
          close();
        }
      }}
    >
      <DialogContent closeLabel={null}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription>{t('description')}</DialogDescription>
        <label htmlFor={reasonId} className="text-sm font-medium">
          {t('reason')}
        </label>
        <textarea
          id={reasonId}
          value={reason}
          rows={3}
          maxLength={COMMENT_LIMITS.reasonMax}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          className="w-full rounded-control border border-border bg-surface p-2 text-sm"
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {invalid ? (
          <p id={errorId} className="text-sm text-destructive">
            {t('reasonError')}
          </p>
        ) : null}
        <div aria-live="polite">
          {problem ? (
            <Alert
              tone="error"
              title={tErrors(problem.key, { correlationId: problem.correlationId })}
            />
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={close}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => {
              const length = Array.from(trimmed).length;
              if (length < COMMENT_LIMITS.reasonMin || length > COMMENT_LIMITS.reasonMax) {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              if (comment !== null) mutation.mutate({ comment, reason: trimmed });
            }}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
