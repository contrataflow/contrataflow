import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import { describeClaimError } from './claim-model';

/*
 * US-049 — o que a UI faz em cada recusa do PRC-21 ("Casos de erro"): o 412 do clique duplo é
 * sucesso já aplicado (FA-03) e o 409 mostra quem assumiu (FA-01).
 */

const failure = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError({
    status,
    code,
    correlationId: 'c-1',
    problem: { status, code, ...extra } as never,
  });

describe('describeClaimError', () => {
  it('412 VERSION_CONFLICT: reenvio do clique duplo = sucesso já aplicado', () => {
    expect(describeClaimError(failure(412, 'VERSION_CONFLICT'))).toEqual({ kind: 'alreadyDone' });
  });

  it('409 PROCESS_ALREADY_ASSIGNED: com o nome de quem assumiu, quando o corpo traz', () => {
    expect(
      describeClaimError(
        failure(409, 'PROCESS_ALREADY_ASSIGNED', {
          currentResponsible: { id: 'u-1', name: 'Marina Costa' },
        }),
      ),
    ).toEqual({ kind: 'alreadyAssigned', name: 'Marina Costa' });
    expect(describeClaimError(failure(409, 'PROCESS_ALREADY_ASSIGNED'))).toEqual({
      kind: 'alreadyAssigned',
      name: null,
    });
  });

  it('409 INVALID_PROCESS_STATUS, 403 e 404', () => {
    expect(describeClaimError(failure(409, 'INVALID_PROCESS_STATUS'))).toEqual({ kind: 'status' });
    expect(describeClaimError(failure(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'denied' });
    expect(describeClaimError(failure(404, 'PROCESS_NOT_FOUND'))).toEqual({ kind: 'notFound' });
  });

  it.each([429, 502, 503, 504])('%s: indisponível', (status) => {
    expect(describeClaimError(failure(status, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
  });

  it('erro inesperado leva o correlationId; erro que não é da API não tem código', () => {
    expect(describeClaimError(failure(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeClaimError(new Error('x'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});
