import { describe, expect, it } from 'vitest';

import { AiRetryableError } from '#modules/ai/application/ai-generation.processor.js';
import {
  RenderDeferredError,
  RenderFailedError,
  RenderRetryableError,
} from '#modules/document/application/render-document.processor.js';
import { ScanDeferredError } from '#modules/files/application/scan-file.processor.js';
import { InvalidJobDataError } from '#shared/jobs/tenant-job.js';
import { TenantContextMissingError } from '#shared/tenancy/isolation.js';

import { classifyApiJobFailure } from './job-failures.js';

describe('classifyApiJobFailure (DEC-052 · queues.md §10.2/§10.3)', () => {
  it('disjuntor aberto do Gotenberg ou do ClamAV adia o job sem consumir tentativa', () => {
    expect(classifyApiJobFailure(new RenderDeferredError(30))).toEqual({
      kind: 'deferred',
      dependency: 'gotenberg',
    });
    expect(classifyApiJobFailure(new ScanDeferredError(30))).toEqual({
      kind: 'deferred',
      dependency: 'clamav',
    });
  });

  it('respeita o consumesAttempt da IA: limite do provedor adia; falha transitória tenta de novo', () => {
    expect(
      classifyApiJobFailure(new AiRetryableError('PROVIDER_RATE_LIMITED', 5_000, false)),
    ).toEqual({ kind: 'deferred', dependency: 'ai-provider' });
    expect(classifyApiJobFailure(new AiRetryableError('PROVIDER_UNAVAILABLE', null, true))).toEqual(
      {
        kind: 'transient',
      },
    );
  });

  it('rendition FAILED e dados inválidos são permanentes (dead-letter sem retry)', () => {
    expect(classifyApiJobFailure(new RenderFailedError('RENDERER_REJECTED'))).toEqual({
      kind: 'permanent',
      code: 'RENDERER_REJECTED',
    });
    expect(classifyApiJobFailure(new InvalidJobDataError('payload'))).toEqual({
      kind: 'permanent',
      code: 'INVALID_JOB_PAYLOAD',
    });
    expect(classifyApiJobFailure(new InvalidJobDataError('meta'))).toEqual({
      kind: 'permanent',
      code: 'INVALID_JOB_META',
    });
  });

  it('job de tenant sem tenant é falha de segurança (V-09)', () => {
    expect(classifyApiJobFailure(new TenantContextMissingError())).toEqual({
      kind: 'security',
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  });

  it('o restante (retry do render, banco, desconhecido) é transitório', () => {
    expect(classifyApiJobFailure(new RenderRetryableError('RENDERER_UNAVAILABLE'))).toEqual({
      kind: 'transient',
    });
    expect(classifyApiJobFailure(new Error('ECONNRESET'))).toEqual({ kind: 'transient' });
    expect(classifyApiJobFailure('texto')).toEqual({ kind: 'transient' });
  });
});
