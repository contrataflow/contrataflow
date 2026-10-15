# `audit`

Trilha de auditoria append-only e selagem (DEC-040, ADR-009). Desde a US-073 (DEC-071), dono de
`AuditLog` (`audit_logs`) e do `AuditService`, que grava a trilha de todo o produto.

## Padrão obrigatório para todo caso de uso mutável

Todo comando que muda dados, decide workflow, exporta ou altera configuração grava **um** registro
de auditoria **no mesmo `tx`** da mudança, antes do commit (RN-AUD-01 · DEC-161). Os módulos não
importam este módulo: injetam a porta `AUDIT_TRAIL` do shared kernel (`#shared/audit/audit-trail.js`),
fornecida por este módulo, que é global.

```ts
constructor(
  private readonly transaction: TenantTransaction,
  @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
) {}

await this.transaction.run(async (tx) => {
  const process = await this.processes.create(tx, input);
  await this.audit.record(tx, {
    action: 'process.create',            // catálogo fechado: AUDIT_ACTIONS (events.md §7)
    entityType: 'Process',
    entityId: process.id,
    processId: process.id,
    changes: [{ path: 'title', old: null, new: process.title }], // só o que mudou
    metadata: { processCode: process.code, idempotencyKey },     // RN-AUD-04
  });
  return process;
});
```

- **Não informe** tenant, ator, IP, user-agent, `correlationId`, `requestId` nem `sessionIdHash`: vêm
  do `RequestContext` (RN-AUD-05). A **categoria** vem do catálogo (`AUDIT_ACTIONS` em
  `packages/types`); ação nova entra primeiro em events.md §7.
- `result` padrão `SUCCESS`; `DENIED`/`FAILURE` exigem `reasonCode` (V-02).
- Falha ao gravar propaga e **desfaz a transação de negócio**; partição ausente responde 503
  `DEPENDENCY_UNAVAILABLE` (FA-03).
- Toda rota `POST`/`PUT`/`PATCH`/`DELETE` declara `auditActions` (ou `auditExempt` justificado) no
  `@ApiOperation`; o meta-teste `src/openapi/audit-coverage.spec.ts` reprova o build sem isso
  (RN-AUD-09).
- Ação cujo único efeito é a própria auditoria (acesso negado, início de sessão) usa
  `audit.recordStandalone(entry)`, que abre a transação do tenant do contexto ou, sem tenant, a de
  plataforma.
- Jobs da API abrem o contexto com `runAsSystem({ name, tenantId })` (ator `SYSTEM`, FA-01).
- **Gravação posterior ao fato** (`occurredAt`, US-088): por padrão o registro leva o horário da
  gravação. Quem grava depois do fato — a varredura de sessões audita um logout ou uma expiração
  minutos depois — informa o horário real em `occurredAt`; ele entra no `rowHash`, escolhe a
  partição mensal e é a ordem da trilha. Data inválida ou no futuro (além de 1 s de folga de relógio
  entre réplicas) é `AuditContractError` (`OCCURRED_AT`).
- **Gravação idempotente por sessão** (`oncePerSession: true`, US-088): para quem pode repetir a
  gravação (varredura refeita depois de falha). Exige `sessionIdHash` e tenant no contexto
  (`AuditContractError` `SESSION` sem eles). Antes do INSERT, `AuditLogStore.existsForSession`
  procura `(tenant, ação, occurredAt, sessionIdHash)`; se já existir, devolve
  `{ kind: 'duplicate' }` e não grava. A consulta usa `occurred_at` por igualdade (poda a
  partição) e o índice `audit_logs_action_idx`. Quem faz `switch` em `AuditOutcome` trata
  `recorded`, `coalesced`, `sampled_out` e `duplicate`.

```ts
await this.audit.recordStandalone({
  action: 'auth.session_expired',
  occurredAt: new Date(tombstone.occurredAt), // o limite atingido, não "agora"
  oncePerSession: true,
  metadata: { reason: 'IDLE', idleMinutes: 30 },
});
```

- **Negações de acesso** (`PERMISSION_DENIED`, `MFA_REQUIRED`, `MEMBERSHIP_INACTIVE`,
  `TENANT_SUSPENDED`) são gravadas como `access.denied` pelo filtro RFC 9457 — o caso de uso só
  lança o `ApiError`; num `PERMISSION_DENIED`, informe a permissão ausente em `auditReasonCode`
  (`new ApiError('PERMISSION_DENIED', { auditReasonCode: 'PROCESS_CREATE' })`). Antes de o tenant ser
  validado pelo pipeline, a negação vira registro de plataforma (`tenantId` nulo,
  `metadata.requestedTenantId`): quem não tem vínculo não escreve na trilha de um tenant.

## O que o serviço faz

| Etapa                          | Regra     | Onde                                                    |
| ------------------------------ | --------- | ------------------------------------------------------- |
| Contrato (V-01, V-02, V-03)    | RN-AUD-02 | `application/audit.service.ts`                          |
| Contexto da requisição/job     | RN-AUD-05 | `RequestContext` (`shared/context`)                     |
| Mascaramento                   | RN-AUD-03 | `domain/audit-masking.ts`                               |
| Coalescência (`draft_update`)  | RN-AUD-06 | `domain/audit-coalescer.ts` + último registro no banco  |
| Amostragem de `access.denied`  | RN-AUD-07 | `AUDIT_SAMPLING_STORE` (Redis em `modules/platform`)    |
| `rowHash` (RFC 8785 + SHA-256) | RN-AUD-08 | `domain/audit-record.ts`, `domain/canonical-json.ts`    |
| INSERT no `tx` (sem RETURNING) | RN-AUD-01 | `infrastructure/prisma-audit-log.store.ts`              |
| `oncePerSession` (dedup)       | US-088    | `AuditLogStore.existsForSession` (Prisma e em memória)  |
| Partições mensais (job diário) | FA-03     | `application/ensure-audit-partitions.job.ts`, scheduler |

- **Mascaramento:** segredos (`password`, `token`, `accessToken`, `secret`, `cookie`…) viram
  `[REDACTED]`; campos com `cpf` no nome são mascarados (`***.456.789-**`); `content`, `body`,
  `html`, texto rico TipTap e texto com mais de 500 caracteres viram `{ hash, length }` (texto:
  SHA-256 do UTF-8; estrutura: SHA-256 do JSON canonicalizado). JWT, `Bearer …` ou CPF formatado em
  campo sem regra são redigidos por inteiro (V-04).
- **Coalescência:** com `coalesce: { scope, revision, size }`, uma chamada dentro da janela
  (`AUDIT_COALESCE_WINDOW_MINUTES`, 10) do último registro da mesma chave (tenant, entidade, escopo,
  ator, ação) é descartada, salvo salto de revisão (`AUDIT_COALESCE_MAX_REVISION_GAP`, 20) ou de
  tamanho (`AUDIT_COALESCE_MAX_SIZE_VARIATION_PCT`, 30%). O estado fica em `metadata.coalesce` do
  registro gravado e é lido do próprio `audit_logs` na transação (DEC-071).
- **Amostragem:** até `AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW` (20) por tenant, usuário (ou
  IP) e ação a cada `AUDIT_ACCESS_DENIED_SAMPLING_WINDOW_SECONDS` (60); o excedente vai para
  `metadata.suppressedCount` do próximo registro. Redis fora → grava tudo e loga
  `warn audit.sampling_unavailable`.

## `rowHash` (para a selagem e a verificação — US-074)

`rowHash = sha256_hex(JCS(record))`, em que `record` tem exatamente os campos de `HASHED_FIELDS`
(todos os de entities.md §4 menos `rowHash`), com os nomes camelCase de entities.md, `null` para
ausente e `occurredAt` em ISO 8601 UTC com milissegundos. Para recalcular a partir do banco, leia
`host(ip)` (o IP é normalizado na gravação como o `inet` o devolve) e os demais campos como estão.

## Logs e métricas

`info audit.recorded` · `warn audit.coalesced` (agregado por minuto) · `warn
audit.sampling_unavailable` · `error audit.write_failed` (stack só em `debug`) · `error
audit.partition_missing` · `error audit.partition_ensure_failed`. Métricas (OpenTelemetry):
`audit_recorded_total{category,result}`, `audit_write_failed_total{reason}`,
`audit_coalesced_total`, `audit_sampled_out_total`, `audit_record_duration_ms`. Nunca conteúdo de
`changes`.

## Banco

Migração `20261014210000_audit_logs`: tabela particionada por mês (RANGE em `occurred_at`, UTC),
trigger que barra `UPDATE`/`DELETE`/`TRUNCATE`, `cf_app`/`cf_worker` só com `INSERT`/`SELECT`, RLS
`ENABLE` + `FORCE` (leitura e escrita no tenant do contexto; `platform_insert` aceita `tenant_id`
nulo só sem tenant na transação) e a função `cf_audit_ensure_partitions(meses)` (SECURITY DEFINER da
dona da tabela), chamada pelo job diário da API até o worker ter agendador (US-083).
