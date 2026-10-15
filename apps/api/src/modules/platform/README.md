# `platform`

Infraestrutura compartilhada (nível 0, DEC-040): outbox, filas, storage, cache, PDF, e-mail, observabilidade, health — e os armazenamentos Redis do rate limit e da idempotência (US-080). Módulo **global** desde a US-082: os demais módulos injetam as portas do shared kernel (`OUTBOX_WRITER`, `SYNC_EVENT_HANDLERS`) sem importá-lo.

## Outbox transacional (US-082 · DEC-072 · ADR-004)

Todo fato de domínio é gravado em `outbox_events` **na mesma transação** da mudança de estado e publicado depois pelo relay do worker (`apps/worker/src/outbox`). Nenhum caso de uso publica direto num broker (RN-FND-49).

### 1. Declarar o evento (story dona do evento)

Em `packages/validation/src/events/`, com o nome em `DOMAIN_EVENT_NAMES` (`packages/types`), a definição em `DOMAIN_EVENT_DEFINITIONS` e a decisão de roteamento em `ROUTING_DECISIONS` (`apps/worker/src/events/routes.ts`) — os testes de V-03 quebram se faltar uma das três.

```ts
export const DocumentCreated = defineDomainEvent({
  eventType: 'DocumentCreated',
  eventVersion: 1,
  aggregateType: 'Document',
  payload: z.strictObject({ documentId: uuidV7Schema, documentTypeCode: z.enum([...]) }),
  // Nome especializado = routing key especializada, nunca outra linha (DEC-162 · RN-FND-51).
  routingKey: (payload) => `document.created.${payload.documentTypeCode.toLowerCase()}`,
});
```

Payload: só IDs e o mínimo necessário, nunca dado sigiloso ou pessoal (events.md §1, POL-09), até 16 KB.

### 2. Gravar no caso de uso

```ts
constructor(
  private readonly transaction: TenantTransaction,
  @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriterPort,
) {}

await this.transaction.run(async (tx) => {
  const document = await this.documents.create(tx, input);
  await this.audit.record(tx, { action: 'document.create', ... }); // auditoria explícita (RN-FND-53)
  await this.outbox.record(
    tx,
    DocumentCreated.of({ aggregateId: document.id, processId: document.processId, payload: { ... } }),
  );
  return document;
});
```

- `tenantId`, `actor` e `correlationId` vêm do `RequestContext`; `causationId` só quando o caso de uso roda por causa de outro evento (`Evento.of({ ..., causationId: envelope.eventId })`).
- Envelope ou payload fora do contrato → `OutboxContractError` antes do INSERT (500 `INTERNAL_ERROR`, transação desfeita). `tx` que não é o da transação ativa, sem tenant ou com ator anônimo também são recusados.
- `occurred_at` é o `clock_timestamp()` do INSERT — grave o evento **depois** do `SELECT … FOR UPDATE` do agregado, para a ordem por agregado ficar correta (queues.md §5.4).
- O `pg_notify('cf_outbox')` sai junto e só é entregue no commit.

### 3. Projeções síncronas (só `TimelineProjector` e `ProcessAccessProjector`)

O módulo dono registra o handler na subida; ele roda no mesmo `tx`, logo depois do INSERT, e qualquer erro desfaz agregado, evento e projeção (RN-FND-52). Outro nome falha na subida.

```ts
@Injectable()
export class TimelineProjector implements SyncEventHandler, OnModuleInit {
  readonly name = 'TimelineProjector';
  readonly routingKeys = ['process.*', 'document.*'];
  constructor(
    @Inject(SYNC_EVENT_HANDLERS) private readonly registry: SyncEventHandlerRegistryPort,
  ) {}
  onModuleInit() {
    this.registry.register(this);
  }
  async handle(tx: TenantTx, event: RecordedDomainEvent) {
    /* INSERT … ON CONFLICT DO NOTHING */
  }
}
```

Efeitos que não precisam ser atômicos (notificação, e-mail, cache, métricas) são **assíncronos**: rota em `apps/worker/src/events/routes.ts` e consumidor idempotente por `eventId` (queues.md §8).

### Modo fake e testes

Com `OIDC_FAKE_SIGNING_KEY` (identidade fake, sem banco) o outbox fica em memória (`InMemoryOutboxStore`). Integração com banco real: `apps/api/test/outbox/outbox-writer.spec.ts` (atomicidade, rollback, NOTIFY só no commit e isolamento do handler síncrono — também na suíte `test:tenant-leak`).
