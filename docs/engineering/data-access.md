# Como acessar dados (isolamento por tenant)

> Guia para quem implementa stories de negócio na API e no worker. Fonte das regras: [multi-tenancy.md](../architecture/multi-tenancy.md) · [ADR-002](../adr/adr-002-multi-tenancy.md) · DEC-076 (US-100) em [decisions.md](../architecture/decisions.md). Padrões de migração e repositório: [`apps/api/prisma/README.md`](../../apps/api/prisma/README.md).

Resumo: **nunca filtre por tenant à mão como única proteção, e nunca informe o tenant por parâmetro.** O tenant vem do contexto da requisição ou do job; quatro barreiras independentes (contexto, extensão do Prisma, RLS, FKs compostas) garantem o isolamento mesmo com bug.

## 1. Rota: declare o escopo

Toda rota declara `@TenantScope` (meta-teste reprova a que não declarar):

| Escopo | Quando | `X-Tenant-Id` |
| --- | --- | --- |
| `TENANT` | Padrão de negócio (processos, documentos, configurações) | Obrigatório (UUID); ausente/malformado → 400 `MALFORMED_REQUEST` |
| `CROSS_TENANT_LOOKUP` | Dados do próprio usuário em todas as instituições (ME-04, aceite de convite) | Ignorado |
| `PLATFORM` | `/platform/*` (operador da plataforma — US-099) | Ignorado |
| `NONE` | `/health/*`, `/metrics` | Ignorado |

```ts
@Controller('processes')
@TenantScope('TENANT')
export class ProcessesController {
  @Post(':id/export')
  @OffboardingExport()          // só se for exportação liberada em OFFBOARDING (RN-TEN-37)
  export() { … }
}
```

Toda operação também entra no manifesto da suíte "tenant leak" (`apps/api/src/openapi/tenant-leak.manifest.ts`): `covered` com as fixtures de B para cada `{param}` do caminho (`pathParams`) e para as referências do corpo (`body` + `referenceFields`), ou `exempt` com o motivo. Sem isso o build falha.

## 2. Contexto

- `TenantContext.getOrThrow()` (`#shared/tenancy/tenant-context.js`) devolve `tenantId`, `userId`, `membershipId`, `actorType`, `correlationId` e `accessMode`; sem contexto lança `TenantContextMissingError` (500 + alerta). Use-o para gravar `tenantId` nas criações e para auditoria — nunca o `X-Tenant-Id` cru.
- O tenant é imutável durante a requisição ou o job. Precisa agir em outro tenant? Só um caso de uso de plataforma (ator `SYSTEM`/`PLATFORM_OPERATOR`, fora de rota `TENANT`) faz isso, com `TenantTransaction.runForTenant(tenantId, …)`.

## 3. Transação e repositório

```ts
// application: comandos com run, consultas com read
await this.transaction.run((tx) => this.processes.create(tx, input));
const list = await this.transaction.read((tx) => this.processes.list(tx, filter));

// infrastructure: o repositório recebe o tx; o tenantId vem do contexto e a extensão confere
create(tx: TenantTx, input: NewProcess) {
  const { tenantId } = TenantContext.getOrThrow();
  return tx.process.create({ data: { id: newId(), tenantId, ...input } });
}
list(tx: TenantTx, filter: Filter) {
  return tx.process.findMany({ where: { status: filter.status } }); // tenantId injetado no where
}
```

- A extensão `tenant-isolation` injeta `tenantId` no `where` de toda leitura/atualização/exclusão e confere o das criações; `tenantId` divergente (dados, filtro ou `update`) → `TenantIsolationViolationError` (500 + alerta).
- **Escritas aninhadas** (`create` dentro de `create`, `connect` entre agregados) não recebem injeção: grave escalares compostos (`tenantId` + FK) em operações separadas.
- **Modelo novo com `tenant_id`:** acrescente-o a `TENANT_SCOPED_MODELS` (`shared/database/tenant-models.ts`) no mesmo PR — o teste compara com `schema.prisma`.
- **Migração:** depois das FKs, `SELECT cf_apply_tenant_rls('tabela');` (RLS `ENABLE` + `FORCE` + política); `UNIQUE (tenant_id, id)`; FKs compostas começando por `tenant_id`. O CI reprova o que faltar.

## 4. SQL bruto

Só `tx.$queryRaw`/`tx.$executeRaw` com *tagged template*, dentro da transação (fora dela a extensão recusa), com `tenant_id = ${tenantId}` explícito mesmo com RLS e `tenant_id` em toda junção ([multi-tenancy.md](../architecture/multi-tenancy.md) §5.6). PR com SQL bruto tem revisão obrigatória.

## 5. Erros que o banco devolve

| Situação | Tradução automática | Resposta |
| --- | --- | --- |
| ID de outro tenant no caminho | Leitura volta `null` (extensão + RLS) | Lance 404 `<RESOURCE>_NOT_FOUND` |
| ID de outro tenant no corpo (FK composta, SQLSTATE 23503) | `REFERENCE_NOT_FOUND` no campo da FK | 422 `VALIDATION_ERROR` |
| Escrita barrada pela RLS (42501) | `TenantIsolationViolationError` | 500 + alerta (bug) |
| Banco fora / conexão caiu (inclusive no `set_config`) | `DatabaseUnavailableError` | 503 + `Retry-After` |

Valide as referências do corpo antes de gravar (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE` no campo); a FK composta é a rede de proteção.

## 6. Jobs

```ts
// produtor (na requisição ou em outro job): o meta vem do contexto
const meta = await buildJobMeta('notifications', 'dispatch');
await queue.add('dispatch', { meta, payload: { notificationId } }); // JobProducer da US-083

// consumidor
export class DispatchNotificationJob extends TenantJob<Payload> {
  protected readonly payloadSchema = payloadSchema;
  protected async handle(payload: Payload) {
    await this.transaction.run((tx) => …); // tenant do job
  }
}
```

Fila de tenant sem tenant no contexto é recusada na origem; só os pares da lista de plataforma (queues.md §9.3) aceitam `tenantId` nulo. Tenant fora de `ACTIVE` → o job conclui sem efeito. O payload leva só IDs: o handler relê os dados no tenant do job.

## 7. Cache

```ts
const perms = await tenantCache.getOrSet('access', `eff:${membershipId}`, () => load(), {
  ttlSeconds: 300,
  schema: effectivePermissionsSchema,
});
// chave: cf:{env}:t:{tenantId do contexto}:access:eff:{membershipId}
```

`TenantCache` para dados de tenant, `PlatformCache` (`cf:{env}:p:…`) para dados globais. TTL obrigatório; Redis fora → o `getOrSet` carrega da fonte. Cliente Redis direto é proibido fora do módulo `platform` (lint).

## 8. Storage

Chaves só pelo `StorageKeyBuilder` (`tenants/{tenantId}/…`, tenant do contexto); URLs só pelo `StorageService`, que recusa chave fora do prefixo do tenant antes de assinar (300 s no máximo). Nada de chave vinda do cliente.

## 9. Acesso de plataforma

`SystemDbService.run(reason, work, { caller })` (papel `cf_platform`): só para os adaptadores autorizados (provisionamento, ciclo de vida de tenants, convites e vínculos entre tenants, auditoria de plataforma) e com motivo da lista fechada. Para trabalhar nos dados de um tenant, enumere pelo `SystemDbService` e abra `runForTenant` em cada um.

## 10. Frontend

Chaves do TanStack Query começam por `['t', tenantId, …]` (`tenantKey`); `sessionStorage`/IndexedDB usam `cf:{tenantId}:{userId}:…`; a troca de instituição limpa caches e estado local (US-093). 400 `MALFORMED_REQUEST` no campo `X-Tenant-Id` leva à seleção de instituição; 403 `MEMBERSHIP_INACTIVE`/`TENANT_SUSPENDED`, à SCR-111.
