# ADR-012 — Prisma 7 com *driver adapter* e contexto de tenant por transação

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-14 |
| **Decisores** | Arquitetura/Tech Lead, Plataforma |
| **Decisões relacionadas** | DEC-064, DEC-069, DEC-082, DEC-055, DEC-003; RT-02 (risks-and-decisions §4) |
| **Documentos** | [multi-tenancy.md](../architecture/multi-tenancy.md) §5 · [architecture.md](../architecture/architecture.md) §6.5 · [`apps/api/prisma/README.md`](../../apps/api/prisma/README.md) · story US-081 |

## Contexto

- DEC-064 propôs Prisma ORM 7 com `@prisma/adapter-pg` e condicionou a aceitação ao *spike* RT-02: RLS com contexto definido **por transação** precisa funcionar com o cliente do Prisma e com pool em modo transação (PgBouncer/RDS Proxy) sem vazar `app.tenant_id` entre clientes do pool.
- O Prisma 7 mudou o modelo de execução: não há mais *query engine* binário; o cliente é TypeScript gerado (gerador `prisma-client`) e a conexão é sempre por *driver adapter*. A URL do banco saiu do `schema.prisma` para `prisma.config.ts`.
- A US-081 entrega a fundação de persistência que toda story de negócio reutiliza: papéis de banco, `outbox_events`, a extensão `TenantTransaction`, concorrência otimista e decimais.

## Decisão

1. **Prisma 7.10 + `@prisma/adapter-pg` + `pg` 8** (DEC-064 passa a `Aceita`). Gerador `prisma-client` em ESM (`moduleFormat = "esm"`, `importFileExtension = "js"`) com saída em `apps/api/src/shared/database/generated/` (fora do Git, tarefa `db:generate` do Turborepo antes de build/typecheck/lint/test). *Fallback* Prisma 6 descartado.
2. **Extensão de cliente `TenantTransaction`** (`$tenantTransaction(work, { readOnly })`): transação interativa `READ COMMITTED` cuja primeira instrução é `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('statement_timeout', $3, true)` — e `transaction_read_only = on` nas consultas. O tenant vem do `RequestContext` (`AsyncLocalStorage`); sem tenant, falha antes do banco. Os módulos recebem o provider Nest `TenantTransaction` (`run`/`read`) e o `tx`; o `PrismaClient` só existe em `shared/database/**` (lint `contrataflow/no-prisma-client-outside-database`).
3. **Papéis criados pela migração inicial** em bloco idempotente (`cf_owner`, `cf_migrator` NOINHERIT, `cf_app`, `cf_worker`, `cf_relay` com BYPASSRLS só com GRANT em `outbox_events`, `cf_readonly_report`); toda migração cria objetos depois de `SET ROLE cf_owner`.
4. **Retentativa** de *deadlock*/serialização (SQLSTATE `40P01`/`40001`, Prisma `P2034`) até 2 vezes; erro de conexão/tempo de espera vira `DatabaseUnavailableError` (503). No Prisma 7 o SQLSTATE fica em `meta.driverAdapterError.cause.code`, e conexão derrubada chega como erro do `pg` sem código (classificado pela mensagem).

## Evidência do *spike* (Testcontainers, `apps/api/test/database/**`)

| Verificação | Resultado |
|---|---|
| `prisma migrate deploy` com `SET ROLE cf_owner` na migração | objetos com dono `cf_owner`; `_prisma_migrations` do migrador; reaplicação em outro banco do mesmo cluster reaproveita os papéis |
| `migrate diff` schema × banco migrado | sem diferença (índice parcial declarado sem `WHERE` no schema) |
| Contexto A lendo/escrevendo B (Prisma e SQL bruto) | 0 linhas; `INSERT` viola a política (`42501`) |
| Mesma conexão (pool de 1) usada por A e depois por B | mesmo `pg_backend_pid`, cada transação vê só o próprio tenant; fora da transação a variável volta vazia |
| Consulta fora da `TenantTransaction` | erro (variável inexistente ou `''::uuid`), nunca linhas |
| Duas atualizações com `version = 3` simultâneas | uma afeta 1 linha (→ 4), a outra 0 → `VERSION_CONFLICT` |
| *Deadlock* provocado entre duas transações | refeita automaticamente, ambas concluem |
| Conexão derrubada no meio da transação | 503 transitório, nada persistido |

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **Prisma 6** (*query engine* binário) | Maduro, sem *driver adapter* obrigatório | Binário por plataforma na imagem; linha de manutenção encerrando; mesmo modelo de transação | **Rejeitada:** o Prisma 7 passou no *spike* sem ressalvas |
| **`set_config(…, false)`/`SET` de sessão** com reset ao devolver a conexão | Uma instrução a menos por transação | Vaza contexto se o reset falhar; incompatível com PgBouncer em modo transação | **Rejeitada:** RN-FND-44 |
| **Filtro só na aplicação** (sem RLS) | Sem custo no banco | Um esquecimento vaza dados entre tenants | **Rejeitada:** DEC-082 exige defesa no banco |

## Consequências

**Positivas**
- Toda leitura e escrita de negócio herda isolamento e concorrência sem código por módulo.
- O pool pode ser compartilhado entre tenants (PgBouncer modo `transaction`).
- Sem binário de *query engine* nas imagens de produção.

**Negativas**
- Uma instrução extra (`set_config`) por transação e toda leitura em transação.
- O cliente gerado precisa existir antes de `typecheck`/`lint`/`test` (dependência `db:generate` no Turborepo).
- A CLI do Prisma baixa o *schema engine* no primeiro uso (scripts de instalação ignorados — RS-11).

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| *Pinning* do RDS Proxy com `set_config` | Rodar a suíte de reuso de conexão contra o proxy antes de habilitá-lo (FA-01 da US-081) |
| Mudança do formato de erro do *driver adapter* | Testes unitários e de integração da classificação de erros (`errors.spec.ts`, `persistence.spec.ts`) |
| Migração sem `SET ROLE cf_owner` | Checagem de catálogo do CI (dono ≠ `cf_owner` reprova) |

## Referências
- DEC-064, DEC-069, DEC-082, DEC-055, DEC-003 — [decisions.md](../architecture/decisions.md).
- US-081 — [story-081-persistence-prisma.md](../backlog/story-081-persistence-prisma.md).
