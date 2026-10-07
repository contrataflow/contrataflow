---
id: US-086
title: "Shell da aplicação web, design system e cliente de API"
epic: EP-015
feature: FT-050
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-077]
modules: [platform]
screens: [SCR-111]
endpoints: []
permissions: []
events: []
---

# US-086 — Shell da aplicação web, design system e cliente de API

## Título
Shell da aplicação web, design system e cliente de API

## Descrição
**Como** pessoa desenvolvedora frontend do ContrataFlow, **quero** o `apps/web` organizado em App Router com os *route groups* de autenticação/aplicação/administração, o `packages/ui` publicado com Storybook, o cliente de API (BFF) que injeta sessão/tenant/correlação, as *query keys* do TanStack Query particionadas por tenant e as páginas globais de erro (SCR-111), **para** que cada tela de negócio seguinte só precise compor componentes e chamar a API, sem reconstruir layout, autenticação, cache ou tratamento de erro.

Esta story não implementa nenhuma tela de negócio: entrega a casca (*shell*) definitiva — navegação, *design system*, cliente de API tipado, convenções de cache e as páginas de erro globais —, validada por uma página de exemplo que exercita autenticação, troca de tenant, permissão (`<Can>`) e cada classe de erro de `architecture.md` §8.12.

## Contexto
- A US-077 deixou `apps/web` como projeto Next.js vazio (só prova que builda); nenhuma convenção de rota, BFF, cache ou design system existe ainda.
- `architecture.md` §8 (Arquitetura do frontend) é a fonte canônica: visão geral (8.1), rotas e *route groups* (8.2), *server* × *client components* (8.3), BFF (8.4), TanStack Query (8.5), formulários (8.6), tabelas (8.7), editor rico (8.8, fora do escopo — entra com a US-086 só a extensão do pacote, não o editor em si), *design system* (8.9), internacionalização (8.10), permissões na UI (8.11), erros e *boundaries* (8.12) e acessibilidade (8.13).
- `security.md` §8 fixa os cabeçalhos de segurança e a CSP que o BFF aplica a toda resposta — sem esta story, nenhuma página sai com HSTS, CSP ou `Permissions-Policy`.
- DEC-053 (BFF no Next.js) e DEC-135 (CSRF/CORS/cabeçalhos) definem que o browser nunca vê token e que todo método mutável exige `X-CF-Request`; esta story é onde essas decisões ganham código.
- A US-001 (primeira story de negócio da UI) pressupõe esse alicerce da mesma forma que pressupõe o esqueleto da API (US-080): layout, cliente de API e `<Can>` já prontos para receber a primeira tela real.

## Objetivo
Entregar um `apps/web` que sobe com os três *route groups* (`(auth)`, `(app)`, `(app)/admin`), o `packages/ui` publicado e documentado no Storybook (com testes de acessibilidade por componente), o cliente de API (`apiServerClient` + proxy `/api/v1/[...path]`) injetando `Authorization`/`X-Tenant-Id`/`X-Correlation-Id`, as *query keys* do TanStack Query particionadas por tenant, o componente `<Can>` e as páginas de SCR-111 (403/404/500/sessão expirada/manutenção/sem vínculo) — tudo demonstrado por uma página de exemplo com teste automatizado, antes que exista qualquer tela de negócio.

## Persona
- **Principal:** Pessoa desenvolvedora frontend do ContrataFlow (usa a casca para construir cada tela de negócio).
- **Secundárias:** Usuário final de qualquer perfil do ContrataFlow (experimenta a navegação, o tema e as páginas de erro desta story mesmo antes de existir uma tela de negócio); pessoa desenvolvedora backend (consome o mesmo contrato de erro/paginação da US-080 agora também do lado do cliente).

## Pré-condições
- US-077 concluída (`apps/web` Next.js vazio, `packages/ui` e `packages/eslint-config`/`tsconfig` criados pelos geradores do monorepo).
- US-080 concluída (contrato de erro RFC 9457, paginação, cabeçalhos — consumido pelo cliente de API desta story).
- Authentik disponível (US-078) para a sessão OIDC real; na ausência, a página de exemplo usa o mesmo `FakeJwksProvider` da US-080 do lado da API.

## Fluxo principal
1. A pessoa desenvolvedora roda o gerador `web-feature` (US-077) para a primeira *feature* de exemplo em `apps/web/src/features/_example/`, sem lógica de negócio.
2. `apps/web` registra os *route groups*: `(auth)` sem *shell* (`/entrar`, `/recuperar-senha`, `/selecionar-orgao`, `/convite/[token]`, `/erro/*` — SCR-111); `(app)` com *shell* autenticado (menu, busca, notificações, seletor de instituição); `(app)/admin` com navegação de administração. O `layout.tsx` de `(app)` resolve a sessão no servidor: sem sessão → `/api/auth/login?returnTo=`; sem tenant ativo → `/selecionar-orgao`.
3. O BFF expõe `/api/auth/*` (sessão OIDC: login, callback, logout, session, switch-tenant, step-up) e o proxy `/api/v1/[...path]`, que injeta `Authorization`/`X-Tenant-Id`/`X-Correlation-Id`, aplica *allowlist* de cabeçalhos de entrada/saída, remove `Cookie`/`Authorization` vindos do browser, exige `X-CF-Request` em métodos mutáveis (CSRF) e aplica *timeout* de 30 s.
4. Toda resposta do BFF carrega os cabeçalhos de segurança de `security.md` §8 (HSTS, CSP com *nonce* por requisição, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, COOP, `Cache-Control: private, no-store` em página autenticada).
5. `apiServerClient` (Server Components) e o cliente *same-origin* (Client Components, via proxy) compartilham o mesmo contrato: `ETag`/`If-Match`, `Idempotency-Key` por intenção do usuário, paginação/envelope (DEC-106) — todos já validados pela US-080 do lado da API.
6. As *query keys* do TanStack Query começam sempre por `['t', tenantId, …]`; a página de exemplo faz *prefetch* no servidor (`HydrationBoundary`) e consome no cliente; troca de tenant ativo dispara `queryClient.clear()` e publica em `BroadcastChannel('cf-session')` para as demais abas.
7. `<Can permission="...">` consulta `usePermission` (alimentado por `GET /api/v1/me/permissions`) para ocultar/desabilitar um botão de exemplo; os erros 401/403/404/409/412/422/429/5xx da página de exemplo são tratados pelos *boundaries* de `architecture.md` §8.12, incluindo as páginas de SCR-111.
8. O `packages/ui` publica os componentes shadcn/ui usados pela casca (botão, menu, *toast*, diálogo) com Storybook e teste de acessibilidade (axe) por componente; next-intl carrega o *namespace* `shell` em pt-BR.

## Fluxos alternativos
- **FA-01 — Sem sessão:** acesso a rota de `(app)` sem cookie de sessão redireciona para `/api/auth/login?returnTo=<rota original>`.
- **FA-02 — Sessão sem tenant ativo:** redireciona para `/selecionar-orgao` (SCR-101, fora do escopo desta story — só a rota e o redirecionamento existem).
- **FA-03 — Múltiplas abas:** troca de tenant em uma aba limpa o cache e notifica as demais via `BroadcastChannel`; o `focus` da janela confere `activeTenantId` contra `GET /api/auth/session`.
- **FA-04 — API indisponível (503):** o segmento exibe `error.tsx` com `correlationId` copiável e botão "Tentar novamente"; `global-error.tsx` é a última barreira para falha não tratada.
- **FA-05 — `If-Match` divergente (412):** diálogo de conflito genérico (recarregar, ver diferenças) — o conteúdo específico da divergência é de cada tela de negócio; esta story entrega o diálogo padrão vazio, reutilizável.
- **FA-06 — Ambiente sem Authentik real:** a página de exemplo usa o `FakeJwksProvider` da API (US-080) por trás da mesma sessão BFF, sem mudar nenhum código desta story quando a US-087 entregar o provedor real.

## Regras de negócio
- **RN-FND-87** — A árvore de rotas segue exatamente os três *route groups* de `architecture.md` §8.2 (`(auth)` sem *shell*; `(app)` com *shell* autenticado; `(app)/admin` com navegação de administração); o `layout.tsx` de `(app)` resolve sessão e tenant ativo no servidor antes de renderizar qualquer filho (sem sessão → login; sem tenant → seleção de órgão).
- **RN-FND-88** — Server Components fazem *prefetch* de leitura via `apiServerClient` e hidratam o TanStack Query (`HydrationBoundary`); `'use client'` só nas folhas interativas; nenhuma página autenticada é cacheada (`dynamic = 'force-dynamic'`, `Cache-Control: private, no-store`); código em `src/bff/**` e `apiServerClient` importa `server-only`.
- **RN-FND-89** — O cliente de API tem um único caminho de mutação: `/api/v1/*` via proxy do BFF (sem *Server Actions* de negócio); o proxy aplica *allowlist* de cabeçalhos de entrada (`Content-Type`, `If-Match`, `Idempotency-Key`, `Accept`) e saída (`ETag`, `Location`, `Idempotent-Replayed`, `RateLimit-*`, `Retry-After`, `X-Correlation-Id`), remove `Cookie`/`Authorization` do browser, exige `X-CF-Request` em métodos mutáveis (DEC-135), tem *timeout* de 30 s e corpo ≤ 2 MB; 401 da API após *refresh* malsucedido destrói a sessão e responde `SESSION_EXPIRED`.
- **RN-FND-90** — *Query keys* do TanStack Query sempre iniciam por `['t', tenantId, …]` (exceto dados independentes de tenant: `['me']`, `['me', 'memberships']`); troca de tenant ativo executa `queryClient.clear()` e publica em `BroadcastChannel('cf-session')`; `ETag` é exposto em `meta.etag` e reenviado como `If-Match` pela mutação correspondente; `Idempotency-Key` é gerada uma vez por intenção do usuário e reutilizada nas retentativas automáticas.
- **RN-FND-91** — `packages/ui` (shadcn/ui + Radix + Tailwind) expõe somente componentes genéricos com tokens semânticos e tema restrito a `branding.primaryColor` com contraste validado; cada componente tem história no Storybook com teste de acessibilidade (axe) sem violação séria/crítica; componentes de domínio (ex.: `ProcessStatusBadge`) nunca entram no pacote — ficam em `apps/web/src/features/**`.
- **RN-FND-92** — `usePermission(code)` consome `GET /api/v1/me/permissions`; `<Can>` oculta quando a ação nunca seria possível e desabilita com explicação quando a indisponibilidade é contextual (via `meta.allowedActions`/`available-actions`); nenhuma tela reimplementa política de autorização no cliente — a API decide.
- **RN-FND-93** — Erros e *boundaries* seguem a tabela de `architecture.md` §8.12 (401 → login; 403 `MFA_REQUIRED` → *step-up*; 403 `MEMBERSHIP_INACTIVE`/`TENANT_SUSPENDED` → seleção de órgão ou SCR-111; 404 → mensagem única que nunca distingue inexistente de sem acesso; 409/412 → diálogo de conflito; 429 → aviso com `Retry-After`; 5xx/503 → `error.tsx` com `correlationId` copiável); as páginas de SCR-111 (403, 404, 500, sessão expirada, manutenção, sem vínculo) existem em `(auth)/erro/*` nesta story.
- **RN-FND-94** — Toda resposta do BFF carrega os cabeçalhos de `security.md` §8: HSTS (`max-age=63072000; includeSubDomains; preload`), CSP com *nonce* por requisição (`script-src 'self' 'nonce-{nonce}' 'strict-dynamic'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` restritiva, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: private, no-store` em página autenticada e em `/api/*`; o IP do cliente usado por *rate limit*/sessão/auditoria vem só do último salto adicionado pelo ALB (`TRUSTED_PROXY_CIDRS`).
- **RN-FND-95** — next-intl opera com locale único `pt-BR`, mensagens por *namespace* de *feature*; datas formatadas no fuso do tenant (`Tenant.timezone`); valores monetários formatados a partir da **string** decimal da API, nunca convertidos para `number`; nenhum código técnico é exibido ao usuário, exceto `correlationId` em telas de erro.
- **RN-FND-96** — Acessibilidade conforme WCAG 2.1 AA + eMAG 3.1 (DEC-183): *primitives* Radix (foco, teclado, ARIA), *skip links*, foco gerenciado após navegação e em diálogos, erros de formulário associados por `aria-describedby`, regiões `aria-live` para autosave/*toasts*, contraste ≥ 4,5:1, alvo de toque ≥ 24 px; axe-core no Storybook e em cada teste Playwright como *gate* de CI (zero violações sérias/críticas).

## Campos
| Campo (variável de ambiente / config) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `NEXT_PUBLIC_APP_NAME` | texto | Não | lista fechada, sem segredo | `ContrataFlow` |
| `API_INTERNAL_URL` | URL | Sim | URL válida, rede interna | US-078 (`apps/api`) |
| `SESSION_COOKIE_NAME` | texto | Não | fixo por contrato (DEC-131) | `__Host-cf_session` |
| `CSP_REPORT_URI` | URL | Não | *endpoint* interno de relatório | `/api/csp-report` |
| `TRUSTED_PROXY_CIDRS` | lista | Sim | CIDRs válidos | CIDR do ALB (US-078 local: `127.0.0.1/32`) |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Requisição mutável sem `X-CF-Request` | BFF (proxy) | — (bloqueada antes de chegar à API) | `CSRF_REJECTED` |
| V-02 | `Origin`/`Sec-Fetch-Site` inválido em método mutável | BFF (proxy) | — | `CSRF_REJECTED` |
| V-03 | Sessão ausente em rota de `(app)` | `layout.tsx` (servidor) | Redireciona para login | — |
| V-04 | Variável `NEXT_PUBLIC_*` fora da lista fechada | *Lint* de build (US-077) | Build falha | — |
| V-05 | Componente novo em `packages/ui` sem história/teste axe | CI (US-079) | Build falha | — |

## Permissões
- **Permissão:** esta story não introduz nenhuma permissão `RESOURCE_ACTION` — ela constrói o **mecanismo** (`usePermission`, `<Can>`) que toda tela de negócio futura vai usar; a página de exemplo usa `PROCESS_CREATE` apenas como ilustração.
- **Políticas:** a UI nunca decide por conta própria — consome `available-actions`/`meta.allowedActions`; a ordem de prioridade de erro (sessão → MFA → tenant/vínculo → 404 → política) é a política transversal desta story (RN-FND-93).
- **MFA:** o *boundary* de `403 MFA_REQUIRED` redireciona para `/api/auth/step-up?returnTo=…`, preservando a ação a repetir; nenhuma tela desta story exige MFA por si.
- **Sem permissão:** `<Can>` oculta (nunca possível) ou desabilita com texto explicativo (indisponível no contexto) — nunca mostra um botão que leva a 403 sem explicação.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: esta story não produz evento de domínio; eventos de UI (ex.: troca de tenant) ficam só em `BroadcastChannel`, sem persistência. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Não aplicável nesta story; o contador/lista de notificações in-app é tela de negócio própria (fora do escopo do *shell*). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Shell da aplicação web, design system e cliente de API

  Background:
    Given que "apps/web" está registrado com os route groups "(auth)", "(app)" e "(app)/admin"
    And existe uma página de exemplo protegida pelo shell autenticado

  Scenario: [Sucesso] Usuário autenticado acessa o shell com prefetch no servidor
    Given que "Ana" está autenticada no tenant "Prefeitura A"
    When "Ana" acessar a página de exemplo em "(app)"
    Then o shell deve renderizar menu, busca e seletor de instituição
    And os dados da página devem chegar pré-carregados via "HydrationBoundary"

  Scenario: [Validação] Formulário de exemplo usa os schemas compartilhados
    Given que a página de exemplo tem um formulário com "zodResolver"
    When "Ana" enviar o formulário com um campo obrigatório vazio
    Then o campo deve exibir a mensagem de erro em pt-BR
    And nenhuma chamada à API deve ser feita antes da validação local passar

  Scenario: [Permissão] Botão de ação é ocultado sem a permissão
    Given que "Carlos" não possui a permissão "PROCESS_CREATE" em nenhum escopo
    When "Carlos" acessar a página de exemplo
    Then o botão de exemplo protegido por "<Can>" não deve aparecer

  Scenario: [Tenant incorreto] Troca de tenant limpa o cache de dados
    Given que "Ana" tem dados carregados do tenant "Prefeitura A"
    When "Ana" trocar para o tenant "Prefeitura B"
    Then o cache do TanStack Query deve ser completamente limpo
    And nenhuma informação da "Prefeitura A" deve aparecer após a troca

  Scenario: [Duplicidade] Clique duplo no botão de exemplo reaproveita a chave de idempotência
    Given que "Ana" clicou no botão de exemplo uma vez
    When "Ana" clicar novamente antes da resposta chegar
    Then a segunda chamada deve reutilizar a mesma "Idempotency-Key"
    And a API deve responder com o mesmo resultado da primeira chamada

  Scenario: [Concorrência] Duas abas com tenants diferentes se sincronizam
    Given que "Ana" tem duas abas abertas, uma em cada tenant
    When "Ana" trocar o tenant ativo em uma das abas
    Then a outra aba deve ser notificada por "BroadcastChannel"
    And deve recarregar seus dados ao voltar o foco

  Scenario: [Falha de banco] API indisponível exibe a página de erro padrão
    Given que a API responde 503 "DEPENDENCY_UNAVAILABLE" para a página de exemplo
    When "Ana" acessar essa página
    Then deve ser exibido o "error.tsx" do segmento com o correlationId copiável
    And deve haver um botão "Tentar novamente"

  Scenario: [Falha de integração] Sessão expirada durante uma chamada do proxy
    Given que a sessão de "Ana" expirou no meio de uma navegação
    When o proxy "/api/v1/*" receber 401 "SESSION_EXPIRED" da API após tentar renovar
    Then a sessão deve ser destruída
    And "Ana" deve ser redirecionada para "/api/auth/login?returnTo=<rota atual>"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Sem sessão em rota autenticada | — | — | — | Redireciona para `/api/auth/login?returnTo=` |
| Sessão/token expirado | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente." | Destrói sessão local; redireciona para login |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade para continuar." | Redireciona para *step-up*, preserva ação |
| Vínculo/tenant inativo | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | `/selecionar-orgao` ou SCR-111 |
| CSRF rejeitado | 403 | `CSRF_REJECTED` | "Não foi possível confirmar a origem da solicitação." | Pede para recarregar a página |
| Recurso inexistente/sem acesso | 404 | `NOT_FOUND` | "Página não encontrada ou sem acesso." | `not-found.tsx`, nunca distingue as duas causas |
| Conflito de versão | 412 | `VERSION_CONFLICT` | "Este registro foi alterado por outra pessoa." | Diálogo de conflito (recarregar/ver diferenças) |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Aviso com tempo de espera (`Retry-After`) |
| Erro inesperado/indisponibilidade | 500/503 | `INTERNAL_ERROR` / `DEPENDENCY_UNAVAILABLE` | "Ocorreu um erro inesperado. Código: {correlationId}." | `error.tsx` com `correlationId` copiável e "Tentar novamente" |

## Dependências
- **Stories:** US-077 (monorepo, `packages/ui` inicial, geradores — pré-requisito direto); consome o contrato de erro/paginação/cabeçalhos da US-080 (sem acoplar a nenhuma tabela real). Habilita toda tela de negócio da UI a partir de US-001 e a SCR-111 fica disponível para qualquer story que precise de página de erro global (ex.: US-088).
- **Decisões/ADRs:** DEC-053, DEC-054, DEC-056 (só a extensão do pacote, não o editor), DEC-104, DEC-105, DEC-106, DEC-131, DEC-135, DEC-181, DEC-182 (convenção, sem autosave real ainda), DEC-183, DEC-184; ADR-003, ADR-010.
- **Configurações:** variáveis da tabela "Campos"; nenhuma `TenantSetting` de negócio (branding/tema por tenant é consumido, não criado, por esta story).
- **Lacunas nas fontes canônicas:** (1) `architecture.md` §8.11/§8.6 marca com `†` a API exata do componente `<Can>` (`<Can permission="...">` ou `<Can action="..." capabilities={…}>`) e a contingência de autosave em IndexedDB cifrada por sessão — convenções propostas, não fixadas; esta story adota a primeira forma de `<Can>` (`permission`) como definitiva para o mecanismo, mantendo a segunda (`action`/`capabilities`) como extensão futura, e **não** implementa a contingência de autosave (sem autosave real nesta story, que é de infraestrutura, não de uma tela com formulário de negócio); (2) o diálogo padrão de conflito (FA-05/412) é descrito funcionalmente (DEC-182) mas sem *copy* fixado em fonte canônica — proposta desta story: texto genérico reaproveitado por toda tela até ser substituído por um específico.

## Impacto técnico
- Define o **contrato de shell** que toda tela de negócio herda: rota, *layout*, cliente de API, *query keys*, `<Can>`, tratamento de erro. Mudança futura (ex.: novo cabeçalho de proxy, nova convenção de *query key*) é transversal e revisada como regra de fronteira (CODEOWNERS da US-077).
- `packages/ui` nesta story publica só os componentes genéricos necessários à casca (navegação, *toast*, diálogo, botão, *skeleton*); o volume completo do *design system* cresce incrementalmente com cada tela de negócio — não é objetivo desta story portar todo o catálogo do shadcn/ui de uma vez.
- CSP com *nonce* por requisição exige que **todo** script inline futuro passe pelo mecanismo de *nonce* do `proxy.ts`; qualquer biblioteca que injete `<script>` sem suporte a *nonce* quebra a política e precisa de avaliação própria.
- Esta story não introduz nenhuma tabela nem rota de negócio; o custo principal é arquitetural (convenções que não podem ser revertidas sem retrabalho em todas as telas).

## Backend
Não aplicável como módulo de domínio da API — o "backend" desta story é o próprio BFF (`apps/web/src/bff/**`, `server-only`): rotas `/api/auth/*`, proxy `/api/v1/[...path]`, aplicação dos cabeçalhos de segurança. Nenhum módulo de `apps/api` (DEC-040) é alterado.

## Frontend
- **Tela(s):** SCR-111 (`/erro/*` — 403, 404, 500, sessão expirada, manutenção, sem vínculo); página de exemplo interna (não documentada em `features.md`) para demonstrar o *shell*.
- **Componentes:** `AppShell` (menu, busca, notificações, seletor de instituição), `<Can>`, `ErrorBoundary`/`error.tsx`/`global-error.tsx`, componentes genéricos iniciais de `packages/ui` (botão, menu, *toast*, diálogo, *skeleton*).
- **Estados:** *loading* (*skeleton* do *shell*), vazio (não aplicável a esta story — sem lista de negócio), erro (cada classe de `architecture.md` §8.12), sucesso (*shell* renderizado com sessão/tenant resolvidos).
- **Acessibilidade e responsividade:** *skip link* no `AppShell`; navegação por teclado no menu e nos diálogos; *shell* responsivo (menu colapsa em telas estreitas); contraste e alvo de toque conforme RN-FND-96.

## Banco de dados
Não aplicável — nenhuma tabela, migração ou índice nesta story; o *branding* por tenant (DEC-059/`TenantSetting`) é **lido**, não criado, pela casca.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| — | GET | `/api/auth/login`, `/api/auth/callback`, `/api/auth/session`, `/api/auth/step-up` | — | Sessão OIDC (BFF) | 200, 302 |
| — | POST | `/api/auth/logout`, `/api/auth/switch-tenant` | — | Encerra/troca sessão | 200, 302 |
| — | * | `/api/v1/[...path]` | Proxy autenticado para `apps/api` | Repassa envelope/erro de `api.md` | conforme rota de destino |

Não aplicável como *endpoints de negócio* do catálogo `api.md` §3 — as rotas acima são do BFF (`architecture.md` §8.4), documentadas ali, não no OpenAPI da API interna.

## Logs
- `info` `bff.proxy_request_completed` — rota de destino (template), status, duração, `correlationId`.
- `warn` `bff.session_refresh_failed` — *refresh* de token malsucedido (antecede `SESSION_EXPIRED`).
- `warn` `bff.csrf_rejected` — `X-CF-Request`/`Origin` ausente ou inválido em método mutável.
- `error` `bff.unhandled_exception` — exceção não tratada no proxy ou nas rotas `/api/auth/*`.
- **Nunca logar:** token, cookie de sessão, corpo de requisição/resposta, CSP *nonce* (previsível o suficiente para não precisar ir a log).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável: ações de auditoria de negócio (`access.denied`, `process.*`, …) são escritas pela API, não pelo BFF; esta story só garante que `correlationId` chega à API para que o `AuditLog` correspondente o registre. |

## Testes necessários
- **Unitários:** *helpers* de *query key* (prefixo de tenant); validador de `correlationId` recebido do cliente (reaproveita a regra da US-084 do lado do BFF); lógica de `<Can>` (oculta × desabilita).
- **Integração (Testcontainers/mock da API):** proxy `/api/v1/[...path]` com *allowlist* de cabeçalhos, CSRF, *timeout*, remoção de `Cookie`/`Authorization`; rotas `/api/auth/*` com sessão simulada.
- **API/contrato:** cabeçalhos de segurança (HSTS, CSP, `Permissions-Policy` etc.) presentes em toda resposta, inclusive erro.
- **RBAC e multi-tenant:** `<Can>` oculta/desabilita corretamente para cada combinação de permissão simulada; troca de tenant limpa 100% do cache (sem dado do tenant anterior sobrevivendo).
- **Concorrência:** duas abas com tenants diferentes sincronizam via `BroadcastChannel` sem race condition visível ao usuário.
- **E2E (Playwright):** jornada mínima: login (fake) → *shell* → página de exemplo → cada classe de erro de §8.12 provocada e verificada → logout; axe-core sem violação séria/crítica em cada tela.
- **Acessibilidade/performance:** Storybook com axe por componente do `packages/ui`; meta de performance: *shell* interativo (TTI) sob 2,5 s em conexão simulada 4G no CI.

## Definition of Done
- [ ] Três *route groups* registrados com resolução de sessão/tenant no servidor
- [ ] `packages/ui` publicado com Storybook e teste axe por componente, zero violação séria/crítica
- [ ] Proxy `/api/v1/[...path]` e rotas `/api/auth/*` funcionando com CSRF, *timeout* e *allowlist* de cabeçalhos
- [ ] Cabeçalhos de segurança e CSP de `security.md` §8 presentes em toda resposta
- [ ] *Query keys* particionadas por tenant; troca de tenant limpa o cache e sincroniza abas
- [ ] `<Can>` e `usePermission` funcionando contra `GET /api/v1/me/permissions`
- [ ] Páginas de SCR-111 (403/404/500/sessão expirada/manutenção/sem vínculo) implementadas
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas no *shell*
- [ ] Logs sem dado sensível; `correlationId` visível nas telas de erro
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — toca contrato transversal do frontend (rotas, BFF, cache, design system, segurança, erros) que todas as ~90 telas de negócio seguintes vão herdar; exige rigor mesmo sem nenhuma tela de negócio real ainda (página de exemplo com interface definitiva).

## Prioridade
**P0** — nenhuma tela de negócio pode ser construída de forma consistente sem esta casca; bloqueia toda a `feature` FT-050 e, por padrão, toda story de negócio da UI do MVP 1.
