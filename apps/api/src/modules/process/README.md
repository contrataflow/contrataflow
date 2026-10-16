# `process`

Processo, itens, participantes, etiquetas, runtime da tramitação e visibilidade (DEC-040).

## Painel situacional — ações e checklist (US-041)

- **Rotas:** PRC-08 `GET /processes/{id}/available-actions` e PRC-09 `GET /processes/{id}/checklist`
  (`ProcessActionsController`); `id` malformado → 400 `MALFORMED_REQUEST`; não visível → 404
  `NOT_FOUND` igual ao inexistente. Somente leitura (sem auditoria nem eventos).
- **Visibilidade (DEC-024):** `domain/process-visibility.ts` sobre `isProcessVisible`
  (`#shared/auth/process-access.js`) com o escopo de `PROCESS_VIEW` das permissões efetivas
  (US-097): `TENANT`, órgão do processo, unidades do escopo (subárvore/lotação) contra `ProcessAccess`
  de unidade ou concessão própria. Listagens (US-001+) usam `buildVisibilityPredicate`.
- **Quem consulta:** `ProcessViewerResolver` (permissões efetivas do contexto: escopo, lotações e
  chefias) alimenta a custódia (POL-01/04/05) do motor.
- **Autorização por processo (US-097):** `ProcessRuntimeAccessReader` registrado no
  `ProcessAccessRegistry` — `@RequirePermission(…, { scope: { processParam: 'id' } })` lê o órgão,
  as concessões e as participações (`runtime.access.participations`) do processo.
- **Runtime:** porta `PROCESS_RUNTIME_READER` (`application/ports.ts`) — processo, passagens,
  aprovações de etapa, documentos e concessões num ÚNICO snapshot. Em produção, o
  `ProcessRuntimeLoader` da US-001 (abaixo); testes e modo fake usam `InMemoryProcessRuntimeStore`.

## Criação do processo (US-001)

- **Rotas:** PRC-02 `POST /processes` (`ProcessController`, `@Idempotent`, `PROCESS_CREATE` em algum
  escopo no guard), PRC-03 `POST /processes/check-duplicates` e PRC-04 `GET /processes/{id}` (mínimo
  para o painel SCR-006; a US-004 completa). Contratos em `packages/validation/src/process/process.ts`
  (`createProcessSchema`, `processDateIssues`, `processSchema`) e o evento `ProcessCreated`
  (`process/events.ts`).
- **Caso de uso:** `CreateProcessCommand` — referências (órgão, catálogos ativos, secretaria/setor do
  mesmo órgão e na subárvore — RN-PROC-02/16) → escopo do `PROCESS_CREATE` sobre o setor
  (`AccessFacade.assertCanInDepartment` — RN-PROC-03) → código interno e duplicidade (RN-PROC-09/13)
  → `WorkflowFacade.resolveApplicable` + etapa inicial (`publishedDefinitionIn`, no mesmo `tx`) →
  unidade/responsável/prazo da etapa → número (`NumberingFacade`, **por último**: a linha da
  sequência fica travada só pelas gravações) → processo + passagem nº 1 + responsabilidade +
  tramitação `CREATE` → `process.create` → `ProcessCreated`.
- **Projeções síncronas:** `TimelineProjector` (`PROCESS_CREATED`) e `ProcessAccessProjector`
  (`application/process-access.projector.ts`, concessões de permissions.md §5), ambos no `tx` do
  `OutboxWriter`. O payload do evento traz `initialDepartmentId`/`initialResponsibleId` para isso.
- **Runtime:** `ProcessRuntimeLoader` substitui o `PendingProcessRuntimeReader`: agregado, passagens
  e concessões numa ÚNICA instrução SQL (`PrismaProcessRepository.loadAggregate`). No modo em
  memória, `InMemoryProcessRuntimeReader` lê primeiro o `InMemoryProcessRuntimeStore` (testes da
  US-041) e depois os processos criados.
- **Banco:** migração `20261016100000_processes` (FK circular `current_stage_id` DEFERRABLE, FKs
  compostas — secretaria e setor pelo órgão do processo —, `search_vector` gerado com `cf_unaccent`,
  trigram em `code`/`title`, tramitação só INSERT + gatilho, FK da timeline). Testes com PostgreSQL:
  `test/tenant-leak/processes.spec.ts`.

### Padrão de comando transacional (`TransactionalCommandHandler`)

Base em `#shared/commands/transactional-command.js`, para todo caso de uso que muda estado de
negócio. Estenda e implemente:

```ts
@Injectable()
export class ForwardProcessCommand extends TransactionalCommandHandler<Input, Prepared, Output> {
  constructor(@Inject(PROCESS_TRANSACTIONS) transactions: ProcessTransactions /* , … */) {
    super('process.forward', transactions); // nome do span e do log `process.forward_failed`
  }
  // 1. Fora da transação: configuração e pré-condições baratas (sem escrita).
  protected prepare(input: Input): Promise<Prepared> { … }
  // 2. Numa transação do tenant: referências → autorização por escopo → domínio (puro) →
  //    repositórios → audit.record(tx, …) → outbox.record(tx, Evento.of(…)).
  protected handle(tx: TenantTx, input: Input, prepared: Prepared): Promise<Output> { … }
  // 3. Depois do commit: log de negócio e métricas.
  protected override committed(result: Output, durationMs: number): void { … }
}
```

- Erro em qualquer passo de `handle` desfaz agregado, projeções, auditoria, outbox e sequências.
- Falha inesperada (5xx, banco fora) gera `error <comando>_failed` com `errorCode`, causa e
  `correlationId`; erros de regra (4xx) não são logados como falha. Nunca logue texto livre.
- Leituras de outros módulos dentro de `handle` usam o `tx` recebido (métodos `…In(tx, …)` das
  fachadas): abrir outra transação por requisição esgota o pool sob concorrência.
- Trava de linha (sequência, agregado) o mais tarde possível dentro de `handle`.
