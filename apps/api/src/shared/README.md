# Shared kernel (`src/shared/`)

Infraestrutura transversal da API (nível 0 — architecture.md §3.3). Importado por qualquer módulo
como `#shared/<caminho>.js`; **nunca** importa `src/modules/**` (dependency-cruiser).

| Pasta          | Conteúdo (US-080)                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `context/`     | `RequestContext` por `AsyncLocalStorage` e o middleware que o abre e devolve o `X-Correlation-Id` (RN-FND-34)                          |
| `errors/`      | `ApiError`, catálogo dos códigos genéricos e `ProblemDetailsExceptionFilter` (RFC 9457 — RN-FND-31)                                    |
| `auth/`        | Portas `TokenVerifierPort`/`UserPort`/`MembershipPort`/`TenantStatusPort`, guards globais e `@WithoutTenant`/`@RequireMfa` (RN-FND-33) |
| `rate-limit/`  | `RateLimitGuard`, `@RateLimit(classe)` e a porta do armazenamento (Redis em `modules/platform`) (RN-FND-36)                            |
| `idempotency/` | `@Idempotent()`, interceptor e a porta do armazenamento (RN-FND-35)                                                                    |
| `http/`        | Corpo JSON, envelope, paginação (`PageResult`/`CursorResult`) e `@RequireIfMatch` (RN-FND-37 · DEC-104)                                |
| `validation/`  | `ZodValidationPipe`, `@ZodBody`/`@ZodQuery`/`@ZodParams` e a tradução Zod → `errors[]` (RN-FND-32)                                     |
| `openapi/`     | `@ApiOperation` — metadados lidos pelo `openapi:generate` (RN-FND-38)                                                                  |
| `testing/`     | Diretório fixo dos adaptadores em memória (removido na US-081)                                                                         |

Próximas: Unit of Work e `shared/database/**` (US-081), `shared/cache/**` (`TenantCache`).
