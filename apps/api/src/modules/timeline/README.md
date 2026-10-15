# `timeline`

Timeline do processo (DEC-040 · DEC-025): narrativa curada para quem vê o processo, com nomes
congelados no momento do fato — não é auditoria (sem IP, user-agent nem diff). Dono de
`ProcessTimelineEntry` (`process_timeline_entries`). Decisões de implementação em DEC-077.

## Projeção síncrona (US-059 · DEC-161)

O `TimelineProjector` se registra no `SYNC_EVENT_HANDLERS` do `platform`. Todo caso de uso que grava
um evento com `outbox.record(tx, Evento.of({...}))` dispara a projeção **no mesmo `tx`**: se ela
falhar, agregado, evento e timeline são desfeitos juntos. Não há chamada direta ao projetor nos
casos de uso.

1. `domain/timeline-mappings.ts` — uma linha por evento de events.md §5 (registro
   `TimelineEntryType` em `packages/types`): lê do payload só o que a entrada precisa (campo
   ausente → `TimelinePayloadError`, 500), declara as referências a congelar e monta `params`,
   visibilidade (POL-09) e entidade (`entityType`/`entityId`/`movementId`). Evento sem linha, ou
   discriminador sem linha (ex.: `ProcessAssigned` `STAGE_ENTRY`), é ignorado com
   `debug timeline.event_not_mapped`.
2. `application/timeline-lookup.resolver.ts` — resolve as referências em lote, uma leitura por
   tipo, no `tx` do caso de uso (RLS do tenant).
3. `infrastructure/prisma-timeline-entry.store.ts` —
   `INSERT … ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING`: reprocessar o mesmo evento
   não duplica (`warn timeline.duplicate_ignored`).

## Story que passa a publicar um evento mapeado

- Payload conforme events.md §4 — os campos lidos estão no schema da linha em
  `timeline-mappings.ts` (teste: `timeline-mappings.spec.ts`).
- **Registre a fonte de nomes** de cada referência nova em `TIMELINE_LOOKUP_SOURCES`
  (`timeline.module.ts`): uma classe em `infrastructure/` que implementa
  `TimelineLookupSource<'TIPO'>` sobre a **fachada** do módulo dono (método que recebe o `tx`).
  Sem a fonte, a projeção falha com `TimelineLookupUnavailableError` — de propósito, para não
  gravar nomes nulos por esquecimento.

| Tipo                  | Dono (fachada)   | Registro devolvido                | Fonte (story que registra) |
| --------------------- | ---------------- | --------------------------------- | -------------------------- |
| `USER`                | `identity`       | `{ name }` (nome social ou civil) | US-059 (já registrada)     |
| `DEPARTMENT`          | `organization`   | `{ name }`                        | US-102                     |
| `ROLE`                | `access`         | `{ name }`                        | US-095                     |
| `PROCESS`             | `process`        | `{ code, isBudgetConfidential }`  | US-001                     |
| `PROCESS_STAGE`       | `process`        | `{ name }`                        | US-001/US-047              |
| `PROCESS_PARTICIPANT` | `process`        | `{ name, role }`                  | US-012                     |
| `DOCUMENT`            | `document`       | `{ code, title, typeName }`       | US-014/US-065              |
| `DOCUMENT_VERSION`    | `document`       | `{ versionNumber }`               | US-066                     |
| `APPROVAL`            | `approval`       | `{ title }`                       | US-051                     |
| `COMMENT`             | `collaboration`  | `{ excerpt }` (≤ 140 caracteres)  | US-071                     |
| `ATTACHMENT`          | `files`          | `{ fileName, targetType }`        | US-068                     |
| `ETP_ALTERNATIVE`     | `etp`            | `{ name }`                        | US-021                     |
| `PRICE_ITEM`          | `price-research` | `{ sequence }`                    | US-024                     |
| `QUOTATION`           | `price-research` | `{ sourceLabel }`                 | US-027                     |
| `RISK`                | `risk`           | `{ code, title }`                 | US-033                     |

- O nome do ator vem do `RequestContext` (carregado na autenticação) quando é o mesmo ator do
  evento; num reprocessamento, é lido pela fonte `USER`. `actorDepartmentName` vem de
  `payload.actorDepartmentId`, quando o produtor o informa (e, em tramitações, da unidade de
  origem).
- Eventos gerados no **worker** (`AttachmentUploaded`, `ProcessStageOverdue`) precisam do outbox e
  deste projetor no worker (US-083/US-055/US-068).

## Testes

- Unitários: `domain/*.spec.ts` (todas as linhas de events.md §5, POL-09, V-01) e
  `application/*.spec.ts` (projetor com o `OutboxWriter` real em memória, logs e métricas).
- Integração: `test/timeline/timeline-projection.spec.ts` — PostgreSQL real com RLS, mesma
  transação, rollback, reprocessamento, concorrência e falha de banco (também na suíte
  `test:tenant-leak`).
