# Persistência (`prisma/`) — US-081

Schema único (`schema.prisma`), migrações versionadas (`migrations/<timestamp>_<nome>/migration.sql`)
e a configuração do Prisma 7 (`../prisma.config.ts`, DEC-064). O cliente é gerado em
`src/shared/database/generated/` (fora do Git) pela tarefa `db:generate` do Turborepo, que roda
antes de `build`, `typecheck`, `lint` e `test`.

| Comando                                            | Para quê                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm db:migrate` (raiz)                           | aplica as migrações no PostgreSQL local e define a senha local dos papéis |
| `pnpm --filter @contrataflow/api db:migrate:dev`   | cria uma migração nova a partir do schema (pede `DATABASE_MIGRATION_URL`) |
| `pnpm --filter @contrataflow/api db:generate`      | regenera o cliente depois de mudar o schema                               |
| `pnpm --filter @contrataflow/api test:tenant-leak` | isolamento por tenant contra PostgreSQL real (Testcontainers)             |
| `pnpm --filter @contrataflow/api test:integration` | tudo de `test/**`, inclusive concorrência, papéis e falha de banco        |

## Papéis de banco (RN-FND-46)

| Papel                | Login | Uso                                                                            |
| -------------------- | ----- | ------------------------------------------------------------------------------ |
| `cf_owner`           | não   | dono de todos os objetos; só via `SET ROLE` do migrador                        |
| `cf_migrator`        | sim   | `prisma migrate deploy` (NOINHERIT: sem `SET ROLE` não altera nada)            |
| `cf_app`             | sim   | API (`DATABASE_URL`) — sem `BYPASSRLS`, sem DDL                                |
| `cf_worker`          | sim   | worker — mesmas regras do `cf_app`                                             |
| `cf_relay`           | sim   | relay do outbox (US-082): `BYPASSRLS`, só `SELECT`/`UPDATE` em `outbox_events` |
| `cf_readonly_report` | sim   | reservado (FA-03): `SELECT` em views `report_*`                                |

A migração inicial cria os papéis que faltarem (bloco idempotente — papéis são do cluster) sem
senha. Em dev, `pnpm db:migrate` define a senha como `POSTGRES_PASSWORD`; em produção a
infraestrutura cria os papéis de login com senha (Secrets Manager) **antes** do primeiro deploy e
concede `CREATE` no schema `public` ao `cf_migrator` — a migração então não recria nada.

## Toda migração nova

```sql
SET ROLE cf_owner;                       -- o dono é sempre cf_owner (checagem de catálogo do CI)

CREATE TABLE processes (
  id uuid PRIMARY KEY,                   -- UUIDv7 da aplicação (newId()), sem DEFAULT no banco
  tenant_id uuid NOT NULL,
  -- …colunas do modelo…
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_id uuid,
  updated_by_id uuid,
  version int NOT NULL DEFAULT 1,        -- agregados mutáveis (DEC-055)
  deleted_at timestamptz,                -- só com exclusão lógica
  UNIQUE (tenant_id, id)                 -- alvo das FKs compostas (DEC-081)
);
CREATE INDEX processes_status_idx ON processes (tenant_id, status, updated_at DESC);

ALTER TABLE processes ENABLE ROW LEVEL SECURITY;
ALTER TABLE processes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON processes
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

GRANT SELECT, INSERT, UPDATE ON processes TO cf_app, cf_worker;  -- sem DELETE se a exclusão é lógica

RESET ROLE;
```

- Gere o DDL do modelo com `prisma migrate dev --create-only` e complete à mão com `SET ROLE`, RLS,
  `GRANT`s, índices parciais, triggers e partições — o Prisma não expressa nada disso (RN-FND-47).
  Índice parcial: declare no schema o mesmo `@@index` (com `map`) sem o `WHERE`.
- Nunca `set_config(…, false)` nem `SET app.*` de sessão (RN-FND-44): `pnpm ci:sql-lint` barra.
- **FK para tabela com RLS `FORCE`** (ex.: `tenant_memberships`): ao criar a FK, o PostgreSQL valida
  as linhas como o dono da tabela — que está sujeito à RLS — e falha por falta de `app.tenant_id`
  ("unrecognized configuration parameter"). Na mesma migração, crie as FKs **antes** de ligar a RLS
  (US-087); em migração posterior, defina um tenant nulo só para a validação, na mesma transação:
  `SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);` antes do
  `ADD CONSTRAINT` (a tabela nova está vazia; a política continua valendo para a aplicação).
- O CI reprova (estágio Migrações e suíte tenant leak): tabela com `tenant_id` sem RLS
  `ENABLE`+`FORCE`+política, `tenant_id` nulo fora de `audit_logs`/`outbox_events`, tabela sem
  `tenant_id` fora de `tenants`/`users`/`permissions`, FK ou unicidade sem `tenant_id` e objeto cujo
  dono não é `cf_owner`. Operação destrutiva só em release posterior (`-- cf:contract DEC-NNN`).
- Snapshot imutável (DEC-084): `CREATE TRIGGER <t>_immutable BEFORE UPDATE ON <t> FOR EACH ROW
EXECUTE FUNCTION cf_prevent_snapshot_update('content', 'content_hash');` — o `UPDATE` de uma coluna
  listada falha com "snapshot imutável".

## Acesso a dados (RN-FND-43)

O único ponto de acesso é o `TenantTransaction` (`#shared/database/database.module.js`, global).
Cada chamada abre uma transação `READ COMMITTED` cuja primeira instrução é
`set_config('app.tenant_id', <tenant do contexto>, true)`; sem tenant no `RequestContext` falha antes
do banco (`TenantContextMissingError`). O lint `contrataflow/no-prisma-client-outside-database`
proíbe o `PrismaClient`, o adapter e o `pg` fora de `shared/database/**`.

```ts
// modules/process/infrastructure/prisma-process.repository.ts
import { updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { TenantTx } from '#shared/database/prisma.js';

export class PrismaProcessRepository {
  rename(tx: TenantTx, id: string, expectedVersion: number, title: string) {
    return updateVersioned({ aggregateType: 'Process', aggregateId: id, expectedVersion }, () =>
      tx.process.updateMany({
        where: { id, version: expectedVersion },
        data: { title, version: { increment: 1 } },
      }),
    );
  }
}

// application: comandos com run, consultas com read (transação somente leitura — FA-02)
await this.transaction.run((tx) => this.processes.rename(tx, id, ifMatch, title));
const process = await this.transaction.read((tx) => this.processes.findById(tx, id));
```

- **Concorrência otimista (DEC-055):** todo `UPDATE` de agregado mutável filtra por
  `version = @expected` e incrementa `version` no mesmo comando; 0 linhas ⇒ `VersionConflictError`
  (412 `VERSION_CONFLICT`, log `db.optimistic_concurrency_conflict`). Nunca por trigger.
- **Trava pessimista pontual:** `SELECT … FOR UPDATE` dentro de `withLockTiming(...)`
  (`#shared/database/row-lock.js`) — espera acima de 200 ms gera `warn db.lock_wait`. Rollback
  libera a trava sem consumir valor (FA-04).
- **Decimais (DEC-003):** grave com `toDbDecimal(valor, 'money' | 'unitPrice' | 'quantity' |
'percentage')` — recusa (`DecimalScaleError`) valor com mais casas que a escala ou acima da
  precisão, nunca arredonda calado; leia com `fromDbDecimal` (decimal.js). Arredondar é explícito:
  `roundTo(valor, 'money')` (`ROUND_HALF_UP`).
- **IDs:** `newId()` (`#shared/database/ids.js`), UUIDv7.
- **SQL bruto:** só `$queryRaw`/`$executeRaw` com _tagged template_ sobre o `tx`, com
  `tenant_id = ${tenantId}` explícito mesmo com RLS (multi-tenancy.md §5.6).
- **Erros:** banco/pool fora do ar → `DatabaseUnavailableError` (503 `DEPENDENCY_UNAVAILABLE`);
  _deadlock_/serialização → a transação inteira é refeita até 2 vezes, então o trabalho dentro de
  `run` não pode ter efeito externo (architecture.md §6.5).
- **Pool:** `DATABASE_POOL_SIZE` por réplica; o contexto vale só na transação, então PgBouncer em
  modo `transaction` é compatível. RDS Proxy: revalidar o _pinning_ com
  `test/database/tenant-isolation.spec.ts` (reuso de conexão) antes de habilitar (FA-01).
