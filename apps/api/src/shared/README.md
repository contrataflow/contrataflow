# Shared kernel (`src/shared/`)

Infraestrutura transversal da API (nível 0 — architecture.md §3.3). Importado por qualquer módulo
como `#shared/<caminho>.js`; **nunca** importa `src/modules/**` (dependency-cruiser).

| Pasta          | Conteúdo (US-080)                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context/`     | `RequestContext` por `AsyncLocalStorage` e o middleware que o abre e devolve o `X-Correlation-Id` (RN-FND-34)                                                           |
| `errors/`      | `ApiError`, catálogo dos códigos genéricos e `ProblemDetailsExceptionFilter` (RFC 9457 — RN-FND-31)                                                                     |
| `auth/`        | Portas `TokenVerifierPort`/`UserPort`/`MembershipPort`/`TenantStatusPort`, guards globais e `@WithoutTenant`/`@RequireMfa` (RN-FND-33)                                  |
| `rate-limit/`  | `RateLimitGuard`, `@RateLimit(classe)` e a porta do armazenamento (Redis em `modules/platform`) (RN-FND-36)                                                             |
| `idempotency/` | `@Idempotent()`, interceptor e a porta do armazenamento (RN-FND-35)                                                                                                     |
| `http/`        | Corpo JSON, envelope, paginação (`PageResult`/`CursorResult`) e `@RequireIfMatch` (RN-FND-37 · DEC-104)                                                                 |
| `validation/`  | `ZodValidationPipe`, `@ZodBody`/`@ZodQuery`/`@ZodParams` e a tradução Zod → `errors[]` (RN-FND-32)                                                                      |
| `openapi/`     | `@ApiOperation` — metadados lidos pelo `openapi:generate` (RN-FND-38)                                                                                                   |
| `database/`    | `TenantTransaction` (Prisma 7 + `app.tenant_id` por transação), UUIDv7, decimais, concorrência otimista e travas (US-081 — `prisma/README.md`)                          |
| `audit/`       | Porta `AUDIT_TRAIL` do `AuditService` (módulo `audit`, global) e a porta dos contadores de amostragem de `access.denied` (US-073 · DEC-071)                             |
| `outbox/`      | Porta `OUTBOX_WRITER` e registro `SYNC_EVENT_HANDLERS` (implementados no módulo `platform`, global) — eventos de domínio na transação do caso de uso (US-082 · DEC-072) |
| `sessions/`    | Porta `SESSION_REGISTRY` do Redis de sessões do BFF (adaptador em `modules/platform`), versão desligada e em memória — varredura de encerramentos (US-088 · RN-IAM-28)  |
| `testing/`     | Diretório fixo dos adaptadores em memória (sai quando identidade e tenancy tiverem tabelas reais — US-087/US-100)                                                       |
| `tenancy/`     | `TenantContext`, `@TenantScope`/`@OffboardingExport`, erros e telemetria de isolamento (`security.*`, métricas por barreira) — US-100                                   |
| `cache/`       | `TenantCache`/`PlatformCache` (chave `cf:{env}:t:{tenantId}:…` do contexto) e a porta `CACHE_STORE` (Redis em `modules/platform`) — US-100                              |
| `storage/`     | `StorageKeyBuilder` (`tenants/{tenantId}/…`) e a guarda de tenant do `StorageService` (adaptador S3 na US-068) — US-100                                                 |
| `jobs/`        | `JobMeta` (`buildJobMeta`) e a base `TenantJob` que restaura o contexto do job — US-100 (importável pelo worker)                                                        |

Guia de uso: [`docs/engineering/data-access.md`](../../../../docs/engineering/data-access.md).
