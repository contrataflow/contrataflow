import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';

import { TIMELINE_LOOKUP_SOURCES } from './ports.js';
import type { AnyTimelineLookupSource } from './ports.js';
import {
  TimelineLookupSourceConflictError,
  TimelineLookupUnavailableError,
} from './timeline-errors.js';
import { TimelineLookups } from '../domain/timeline-lookups.js';
import type {
  TimelineLookupKind,
  TimelineLookupRef,
  TimelineLookupResults,
} from '../domain/timeline-lookups.js';

/**
 * Resolve as referências de uma projeção (RN-TML-04): uma leitura em lote por tipo, sem IDs
 * repetidos, em sequência no `tx` do caso de uso (o `tx` interativo não aceita consultas em
 * paralelo). Tipo sem fonte → `TimelineLookupUnavailableError`.
 */
@Injectable()
export class TimelineLookupResolver {
  private readonly sources = new Map<TimelineLookupKind, AnyTimelineLookupSource>();

  constructor(@Inject(TIMELINE_LOOKUP_SOURCES) sources: readonly AnyTimelineLookupSource[]) {
    for (const source of sources) {
      if (this.sources.has(source.kind)) throw new TimelineLookupSourceConflictError(source.kind);
      this.sources.set(source.kind, source);
    }
  }

  async resolve(tx: TenantTx, refs: readonly TimelineLookupRef[]): Promise<TimelineLookups> {
    const idsByKind = new Map<TimelineLookupKind, Set<string>>();
    for (const ref of refs) {
      const ids = idsByKind.get(ref.kind) ?? new Set<string>();
      ids.add(ref.id);
      idsByKind.set(ref.kind, ids);
    }
    const results: Partial<Record<TimelineLookupKind, ReadonlyMap<string, unknown>>> = {};
    for (const [kind, ids] of idsByKind) {
      const source = this.sources.get(kind);
      if (!source) throw new TimelineLookupUnavailableError(kind);
      results[kind] = await source.lookup(tx, [...ids]);
    }
    return new TimelineLookups(results as TimelineLookupResults);
  }
}
