# MVP 1 — Estratégia e Plano de Testes

> **Objetivo:** garantir que toda story do MVP 1 chegue à produção com os critérios de aceite automatizados, o isolamento entre tenants comprovado, a autorização verificada e as metas de qualidade, desempenho e segurança atendidas — do teste unitário à jornada de aceite em staging.
> Critérios de aceite e jornadas: [acceptance-criteria.md](acceptance-criteria.md). Permissões e matriz de autorização: [permissions.md](permissions.md) §10. Definition of Done e checklist de release: [release-checklist.md](release-checklist.md).

Sumário: [1. Objetivos e princípios](#1-objetivos-e-princípios) · [2. Níveis e ferramentas](#2-níveis-de-teste-e-ferramentas) · [3. Suítes transversais obrigatórias](#3-suítes-transversais-obrigatórias) · [4. Jornadas de aceite (E2E)](#4-jornadas-de-aceite-e2e) · [5. Dados de teste e ambientes](#5-dados-de-teste-e-ambientes) · [6. Gates de CI e de release](#6-gates-de-ci-e-de-release) · [7. Testes não funcionais](#7-testes-não-funcionais) · [8. Rastreabilidade](#8-rastreabilidade) · [9. Riscos de qualidade](#9-riscos-de-qualidade-e-mitigação)

---

## 1. Objetivos e princípios

O MVP 1 adota a **pirâmide de testes**: muitos testes unitários rápidos e baratos na base, menos testes de integração, ainda menos testes de contrato e E2E no topo, com testes não funcionais (desempenho, segurança, acessibilidade) como camada transversal que atravessa todos os níveis.

Princípios:
- **Nenhuma regra "no olho":** todo critério de aceite — transversal (CA-T-01 a CA-T-10) ou por story — nasce como cenário Gherkin e vira teste automatizado rastreável; o que não é automatizável (ex.: UAT com o cliente-piloto) é explicitamente marcado como manual assistido.
- **"Testes necessários" de cada card** (Definition of Done, [release-checklist.md §1.1](release-checklist.md#11-card-story)): critérios de aceite automatizados (API e, quando há tela, E2E) cobrindo as **8 categorias obrigatórias de cenário** — Sucesso, Validação, Permissão, Tenant incorreto, Duplicidade, Concorrência, Falha de banco, Falha de integração — mais teste de isolamento na suíte "tenant leak", permissões/políticas aplicadas, auditoria/eventos verificados, OpenAPI sem quebra de contrato não planejada e cobertura mínima atingida.
- **Testável desde a infraestrutura:** o ambiente local (US-078) já nasce com dois tenants semeados para que qualquer story de negócio exercite isolamento multi-tenant desde o primeiro commit.
- **Gate automatizado em vez de checklist manual:** sempre que uma regra pode ser verificada por um meta-teste que percorre todo o catálogo (rotas, permissões, modelos do Prisma, operações do OpenAPI), o MVP 1 prefere o meta-teste à revisão manual — exemplos na seção 3.
- **Card, feature/épico e MVP têm DoD próprios e crescentes** ([release-checklist.md §1](release-checklist.md#1-definition-of-done)): o que passa no card não basta para o épico (jornada E2E do épico) nem para o MVP (jornadas J-01–J-11, suítes 100% verdes, UAT do piloto).

## 2. Níveis de teste e ferramentas

Ferramentas confirmadas nas fontes ([architecture.md §4](../architecture/architecture.md), [decisions.md](../architecture/decisions.md)): **Vitest, Testcontainers, Supertest, Playwright, k6, axe-core, OWASP ZAP**.

| Nível | Ferramenta | Escopo e meta | Onde roda |
|---|---|---|---|
| Unitário | Vitest | `domain/` e `application/` isolados (sem I/O); 100% de cobertura em regras de cálculo e políticas | Estágio 4 Testes (CI) |
| Integração | Vitest + Supertest + **Testcontainers** (PostgreSQL com RLS real, Redis, MinIO) | Casos de uso completos, RLS real, atomicidade, concorrência, cascatas — mesma implementação de produção | Estágio 4 Testes, `apps/api/test/` |
| Contrato | Geração de OpenAPI (`packages/validation`, a partir dos schemas Zod) + diff contra o arquivo versionado | Zero quebra incompatível não planejada na v1 (DEC-108); mudanças aditivas passam | Estágio 3 Contrato |
| Autorização (matriz gerada) | Teste *table-driven* rotas × perfis × escopos | 100% das rotas mutáveis com permissão/política declarada (meta-teste); fonte única `packages/types` | Estágio 4 Testes, após integração ([permissions.md §10](permissions.md#10-testes-de-autorização)) |
| Isolamento ("tenant leak") | Testcontainers, iterando sobre toda operação do OpenAPI | 100% das operações classificadas; zero vazamento ([multi-tenancy.md §14](../architecture/multi-tenancy.md)) | Estágio 4 Testes |
| E2E | Playwright + axe-core | Jornadas J-01 a J-11 e critérios de tela, contra Authentik real (sem *mocks* de autenticação) | Estágio 7 E2E, contra o Compose efêmero da US-078 |
| Acessibilidade | axe-core (via Playwright) | Zero violação séria/crítica (CA-T-10); navegação por teclado; 360/768/1280 px | Estágio 7 E2E |
| Performance/carga | k6 | SLOs de [observability.md §1.1](../architecture/observability.md#11-slos-do-mvp-1) | *Smoke* no estágio 8 Pós-deploy; carga completa em staging dedicado antes do release |
| Segurança (SAST/segredos/IaC) | CodeQL + Semgrep, gitleaks, checkov/`trivy config`/tflint | Regras de [security.md §20](../architecture/security.md#20-sast-dast-e-testes-de-segurança) | Estágios 1 Higiene e 2 Estático |
| Segurança (imagens) | Trivy (varredura) + SBOM + assinatura | CVE crítica/alta com correção disponível bloqueia | Estágio 6 Imagens |
| Segurança (DAST/pentest) | OWASP ZAP (*baseline*/*full scan*) + pentest externo caixa-cinza | Zero achado crítico/alto aberto antes do *go-live* | Estágio 8 + ciclo pré-go-live/anual |

## 3. Suítes transversais obrigatórias

As nove suítes abaixo cobrem os critérios transversais de [acceptance-criteria.md §1](acceptance-criteria.md#1-critérios-transversais-ca-t). CA-T-03 (validação e mensagens) não forma suíte própria — é verificada por story, dentro da categoria "Validação" das 8 obrigatórias.

| ID | Suíte |
|---|---|
| CA-T-01 | Isolamento entre tenants ("tenant leak") |
| CA-T-02 | Matriz de autorização |
| CA-T-04 | Concorrência otimista (`If-Match`) |
| CA-T-05 | Idempotência |
| CA-T-06 | Auditoria e eventos atômicos (outbox) |
| CA-T-07 | Falhas de dependências |
| CA-T-08 | Orçamento sigiloso (POL-09) |
| CA-T-09 | Sessão, limites e formatos |
| CA-T-10 | Acessibilidade e responsividade |

A geração com IA (EP-020) não tem CA-T próprio: estende as suítes acima e acrescenta as verificações da §3.10.

### 3.1 CA-T-01 — Isolamento entre tenants ("tenant leak")
- **Cobre:** recurso de outro tenant pela URL ou no corpo, listagens/buscas/agregados, cabeçalho `X-Tenant-Id` sem vínculo, defesa em profundidade via RLS, `tenantId` em cache/storage/filas/auditoria.
- **Como é implementada:** suíte automatizada com Testcontainers que, para **cada operação do OpenAPI**, substitui parâmetros por IDs dos tenants "Prefeitura A"/"Prefeitura B" com massa equivalente ([multi-tenancy.md §14](../architecture/multi-tenancy.md)); toda operação é classificada (coberta ou isenta com motivo) — operação nova sem classificação falha o *build* (RN-TEN-36).
- **Onde roda no CI:** estágio 4 Testes, logo após os testes de integração.
- **Critério de aprovação:** `GET`/`PATCH`/`PUT`/`DELETE`/comandos com ID de outro tenant → 404; ID de outro tenant no corpo → 422 `REFERENCE_NOT_FOUND`; nenhum dado do outro tenant lido, alterado, auditado ou publicado como evento; suíte 100% verde é critério de saída do MVP 1.

### 3.2 CA-T-02 — Matriz de autorização
- **Cobre:** ação sem permissão, recurso não visível (404), MFA obrigatório para permissão de risco alto.
- **Como é implementada:** teste *table-driven* que percorre todas as rotas (metadados `@RequirePermission`/`@Policy`) × perfis padrão × escopos e compara com a matriz de [permissions.md §3](permissions.md#3-perfis-padrão-e-matriz); meta-teste garante que toda rota mutável declara permissão e política ou está na lista explícita de rotas públicas/implícitas.
- **Onde roda no CI:** estágio 4 Testes, após a suíte "tenant leak".
- **Critério de aprovação:** matriz 100% verde (DoD do MVP 1); zero rota sem classificação; um teste por política (POL) cobrindo sucesso e violação, incluindo segregação de funções e anti-escalonamento.

### 3.3 CA-T-04 — Concorrência otimista (`If-Match`)
- **Cobre:** versão divergente (412 `VERSION_CONFLICT` com `currentVersion`) e ausência de `If-Match` em recurso versionado (428 `PRECONDITION_REQUIRED`).
- **Como é implementada:** teste de integração por story, dentro da categoria obrigatória "Concorrência": versiona o recurso, envia `If-Match` divergente e, em outro cenário, omite o cabeçalho; corridas reais (ex.: duas tramitações simultâneas) usam `FOR UPDATE`/índice único sob concorrência com Testcontainers.
- **Onde roda no CI:** estágio 4 Testes (integração), por módulo tocado no PR.
- **Critério de aprovação:** toda rota de atualização versionada cobre os dois cenários; nenhuma escrita é aceita sem `If-Match` quando a entidade exige versionamento.

### 3.4 CA-T-05 — Idempotência
- **Cobre:** reenvio idêntico com `Idempotency-Key` (resposta repetida com `Idempotent-Replayed: true`), mesma chave com corpo diferente (422 `IDEMPOTENCY_KEY_REUSED`), requisição original ainda em processamento (409 `IDEMPOTENCY_IN_PROGRESS`).
- **Como é implementada:** teste de integração com Testcontainers + Redis simulando requisições concorrentes com a mesma chave (idempotência com escopo de tenant, DEC-105); categoria obrigatória "Duplicidade" por story.
- **Onde roda no CI:** estágio 4 Testes (integração), em toda rota de criação/comando que aceite `Idempotency-Key`.
- **Critério de aprovação:** os três cenários verdes para cada rota elegível; nenhum efeito duplicado em reenvio.

### 3.5 CA-T-06 — Auditoria e eventos atômicos (outbox)
- **Cobre:** toda ação mutável bem-sucedida grava auditoria, publica eventos no outbox e atualiza projeções síncronas na mesma transação da mudança de estado; ação que falha não deixa alteração, auditoria, timeline ou evento parcial.
- **Como é implementada:** teste de integração com falha induzida (*fault injection*) em um ponto da transação, verificando que nada persiste (padrão outbox, [ADR-004](../adr/adr-004-outbox-events.md)); presente nas categorias "Falha de banco" e "Falha de integração" de cada story.
- **Onde roda no CI:** estágio 4 Testes (integração), por story com efeito colateral auditável.
- **Critério de aprovação:** zero estado parcial em qualquer cenário de falha simulada; auditoria e outbox sempre consistentes com o estado final.

### 3.6 CA-T-07 — Falhas de dependências
- **Cobre:** dependência crítica indisponível (PostgreSQL; Redis de sessão do BFF) → 503 `DEPENDENCY_UNAVAILABLE` com `Retry-After`, sem estado parcial; dependência não crítica (relay do outbox, fila, Gotenberg, ClamAV, SMTP, cache) → ação principal completa e o trabalho assíncrono fica pendente sem duplicidade.
- **Como é implementada:** Testcontainers interrompe/pausa o contêiner da dependência durante a chamada; a tabela de criticidade por aplicação ([observability.md §6.2](../architecture/observability.md#62-dependências-por-aplicação-alinhado-a-ca-t-07-e-dec-131)) define o que é crítico, degradável ou irrelevante por app (api/worker/web); health checks `/health/live` e `/health/ready` são verificados nos mesmos testes.
- **Onde roda no CI:** estágio 4 Testes (integração); comportamento validado operacionalmente pelos runbooks RB-01, RB-02, RB-04 e RB-05 em staging/produção.
- **Critério de aprovação:** nenhum estado parcial; *readiness* correta por dependência; nenhum arquivo liberado sem verificação antivírus mesmo com o ClamAV instável.

### 3.7 CA-T-08 — Orçamento sigiloso (POL-09)
- **Cobre:** mascaramento de todo valor estimado (`null` + `<campo>Masked`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia, em processo, itens, ETP, pesquisa de preços, TR, dashboard, exportações, PDFs, timeline e notificações.
- **Como é implementada:** teste por artefato/endpoint comparando a resposta para um usuário sem permissão/custódia e para um usuário com custódia; verificação de que documentos com valores ficam `RESTRICTED`.
- **Onde roda no CI:** estágio 4 Testes, em toda story que exponha valor estimado (política POL-09 de [permissions.md §6](permissions.md#6-políticas-contextuais)).
- **Critério de aprovação:** nenhum valor sigiloso vaza em nenhum canal (API, exportação, PDF, notificação) para quem não pode vê-lo.

### 3.8 CA-T-09 — Sessão, limites e formatos
- **Cobre:** sessão expirada (401 `SESSION_EXPIRED`), limite de requisições por classe de rota (429 `RATE_LIMITED` com `Retry-After` e cabeçalhos `RateLimit-*`), formatos (datas ISO 8601 UTC, decimais como *string*).
- **Como é implementada:** teste de integração simulando expiração de sessão e excedente de requisições (`api.md §1.6`); teste de contrato/schema para os formatos de campo.
- **Onde roda no CI:** estágio 4 Testes; preservação de rascunho local após expiração é verificada em E2E (estágio 7).
- **Critério de aprovação:** cabeçalhos corretos presentes; rascunhos preservados; nenhuma rota fora da classe de rate limit declarada.

### 3.9 CA-T-10 — Acessibilidade e responsividade
- **Cobre:** todas as telas do MVP 1 sem violações sérias/críticas no axe; toda ação executável por teclado com foco visível; uso em 360 px (consulta, caixa, notificações, aprovações) ou aviso de uso recomendado em desktop (edição de documentos).
- **Como é implementada:** axe-core integrado ao Playwright, executado contra cada tela especificada em `screens.md` durante o E2E.
- **Onde roda no CI:** estágio 7 E2E; falha de acessibilidade séria bloqueia no mesmo nível que falha funcional.
- **Critério de aprovação:** zero violação séria/crítica; verificação manual pontual em 360/768/1280 px como parte do DoD do card.

### 3.10 Geração com IA (EP-020)
- **Cobre:**
  - CA-T-01: `AiGeneration`, AI-02/AI-03 e DOC-26/27/RSK-11/12 de outro tenant → 404; o contexto montado só contém dados do tenant do job.
  - CA-T-02: POL-18 e `AI_GENERATE` por perfil; só o solicitante aplica e descarta.
  - CA-T-05: AI-01, DOC-26 e RSK-11 com `Idempotency-Key`; o job não executa duas vezes.
  - CA-T-06: auditoria e eventos na mesma transação; nenhum texto em auditoria, evento ou log.
  - CA-T-07: provedor indisponível, 429, *timeout*, saída inválida e disjuntor.
  - CA-T-08: valores de orçamento sigiloso nunca entram no contexto.
- **Testes específicos:**
  - `GroundingGuard`: testes de propriedade com números, valores, prazos, datas e percentuais inventados × presentes nas entradas; exceções de citação legal.
  - `ContextSanitizer`: CPF, e-mail, telefone e CEP redigidos; nomes de pessoas omitidos.
  - Injeção de instruções: conteúdo de seção com "ignore as instruções…", tentativa de HTML/script na saída e pedido de dados de outro processo. A resposta continua estruturada e sanitizada, sem efeito no sistema; o modelo não tem ferramentas.
  - Violações `SECTION_AI_REVIEW_PENDING`/`SECTION_PLACEHOLDER_PENDING` bloqueando finalizar, submeter e encaminhar.
- **Como é implementada:**
  - `FakeAiProvider` determinístico, com fixtures por `promptKey`, em todos os testes do CI. **Nenhuma chamada real ao provedor no CI.**
  - O adaptador real, quando decidido (ADR-013), tem testes de contrato sobre respostas gravadas.
  - A qualidade do texto é medida fora do CI pelo conjunto de avaliação `pnpm ai:eval` (10 processos sintéticos × 4 documentos, nota de especialista), executado a cada nova `promptVersion` e na escolha do provedor.
- **Onde roda no CI:** estágio 4 (integração, tenant leak e autorização) e estágio 7 (E2E J-11).
- **Critério de aprovação:** zero vazamento; zero texto de documento em logs, eventos e auditoria (varredura nos testes de integração); 100% de `GroundingGuard` e `ContextSanitizer` em cobertura de ramos.

## 4. Jornadas de aceite (E2E)

As onze jornadas de [acceptance-criteria.md §2](acceptance-criteria.md#2-jornadas-de-aceite-do-mvp-1) usam, como cenário de negócio principal, o tenant **"Prefeitura de São José"** com o workflow padrão (DEC-015), feriados semeados e as unidades "Secretaria de Obras" › "Setor de Manutenção", "Secretaria de Administração" › "Departamento de Compras" e "Gabinete do Prefeito" — um seed mais narrativo do que o par genérico "Prefeitura A"/"Prefeitura B" semeado por `pnpm env:seed` (US-078) para exercitar isolamento (usado na suíte "tenant leak", §3.1). J-10 soma um segundo tenant, "Câmara de Vila Nova".

| Jornada | Épicos/stories cobertos | Seed necessário | Automação | Ambiente |
|---|---|---|---|---|
| J-01 — Implantação do órgão | EP-017 (US-099 provisionamento) + EP-016 (convite, MFA, perfis) | Tenant provisionado do zero nesta jornada (não usa o seed padrão) | E2E (Playwright) | Staging |
| J-02 — Abertura e formalização da demanda | EP-001 (US-001) + EP-002 (US-014–017 DFD) + EP-008 (US-051/052 aprovação) | "Prefeitura de São José"; Ana (REQUISITANTE) e Carlos (titular) | E2E | CI efêmero (Compose US-078) / Staging |
| J-03 — Planejamento completo da contratação (até a aprovação da autoridade) | EP-003 (US-019–023 ETP) + EP-005 (US-033–035 riscos) + EP-004 (US-024–032 pesquisa de preços) + EP-006 (US-036–039 TR) + EP-008 (aprovação da autoridade) | Mesmo tenant; Paula (PLANEJAMENTO), Rui (COMPRAS), Autoridade | E2E | Staging |
| J-04 — Devolução e correção | EP-008 (US-048 devolução) + EP-006 (TR) | Processo da J-03 na etapa `APROVACAO_AUTORIDADE` | E2E | Staging |
| J-05 — Orçamento sigiloso | EP-001 (US-013) + POL-09 | Processo com `isBudgetConfidential = true`; Ana sem custódia, Rui com custódia | E2E | CI efêmero / Staging |
| J-06 — Prazos, suspensão e retomada | EP-007 (workflow/SLA) + EP-001 (US-008 suspensão) + EP-019 (notificações) + US-055 (vencimentos) | Etapa com SLA de 10 dias úteis e feriado municipal semeado | E2E com relógio controlado + verificação manual assistida do painel de atrasados | Staging |
| J-07 — Cancelamento | EP-001 (US-009) | Processo em `AWAITING_APPROVAL` | E2E | CI efêmero / Staging |
| J-08 — Caixa de tarefas e notificações | EP-009 (US-049 assumir, US-050 atribuir) + EP-008 (substituto, `allowDeputy`) | Processo sem responsável no "Departamento de Compras"; titular e substituto cadastrados | E2E | CI efêmero / Staging |
| J-09 — Auditoria e integridade | EP-013 (auditoria: consulta, exportação, selos) | Processo da J-03; auditor com `AUDIT_VIEW`/`AUDIT_EXPORT` e MFA | E2E + verificação manual assistida (alteração direta simulada em registro selado, só em ambiente de teste) | Staging |
| J-10 — Consultoria externa em mais de um órgão | EP-016/017 (vínculo `EXTERNAL`) + EP-001 (US-012 participantes) | "Prefeitura de São José" e "Câmara de Vila Nova"; Eva com vínculos `EXTERNAL` em ambos (60 dias) | E2E | Staging |
| J-11 — Rascunhos com IA em cadeia e revisão humana | EP-020 (US-115..US-122) sobre EP-002/003/005/006 | Mesmo tenant com IA ligada; fixtures do `FakeAiProvider` para DFD, ETP, mapa de riscos e TR | E2E | CI efêmero / Staging |

O Definition of Done do MVP 1 exige as onze jornadas passando em staging (J-11 com o `FakeAiProvider` no CI e com o provedor decidido em staging) ([release-checklist.md §1.3](release-checklist.md#13-mvp-1)); nenhuma delas é considerada aprovada só pela execução em ambiente efêmero de PR. Passos sem suporte confirmado nas fontes (ex.: controle de relógio determinístico em J-06, endpoint de teste para violação simulada de selo em J-09) ficam como automação parcial até a Sprint que especificar o harness de teste correspondente.

## 5. Dados de teste e ambientes

Os três ambientes compartilham a mesma topologia de serviços (US-078); o que muda é a persistência dos dados e o uso.

| Ambiente | Infraestrutura | Dados | Uso |
|---|---|---|---|
| Local | Docker Compose (US-078): PostgreSQL 17 + pgvector/RLS real, dois Redis lógicos (sessão e cache/filas, DEC-131), MinIO com buckets `quarantine`/`documents`/`renditions`, Authentik por *blueprint*, Mailpit, Gotenberg, ClamAV — todos com *healthcheck* | `pnpm env:seed` idempotente cria exatamente os tenants **"Prefeitura A"** e **"Prefeitura B"** (RN-FND-18) | Desenvolvimento e testes manuais de isolamento desde o primeiro dia |
| CI | Mesmo Compose em modo efêmero (RN-FND-27); Testcontainers sobe instâncias isoladas por execução para os testes de integração | Seed equivalente ao local, recriado por execução | Estágios 4 (integração, tenant leak, autorização) e 7 (E2E) do pipeline |
| Staging | Infraestrutura próxima de produção (Terraform, `sa-east-1`) | Dados sintéticos das jornadas J-01–J-11 e, quando houver, cópia anonimizada do estado de produção para medir tempo de migração ([release-checklist.md §3.2](release-checklist.md#32-engenharia-e-qualidade)) | Demonstração ao PO (DoD de card), jornadas E2E, testes de carga, ZAP *baseline*, UAT do piloto |

**Fixtures de IA:** `AI_PROVIDER=fake` em local e CI; as respostas do `FakeAiProvider` ficam em `apps/api/test/fixtures/ai/<promptKey>/` e são escolhidas pelo `contextHash` (sem *match*, devolvem uma resposta genérica com marcações [a confirmar]). Staging usa o provedor decidido (ADR-013), com limite de tokens próprio do ambiente.

**Fixtures de documentos/arquivos:** a verificação antivírus usa a *string* de teste **EICAR**, gerada em tempo de execução — nunca versionada no repositório, pois antivírus locais colocariam o arquivo em quarentena ([storage.md](../architecture/storage.md)). O `FakeScanner` existe só em testes unitários e o *bootstrap* falha se for configurado com `NODE_ENV=production`, para que nenhum ambiente real rode sem o ClamAV real.

## 6. Gates de CI e de release

**Cobertura** ([release-checklist.md §1.1](release-checklist.md#11-card-story); RN-FND-24): mínimo de **80% de linhas do código novo em `domain/` e `application/`**, por módulo tocado no PR, como *check* bloqueante (`ci.coverageGateEnabled = true`); **100% nas regras de cálculo e políticas**, conferido na revisão de código (não apenas pela ferramenta).

**Estágios do pipeline** (US-079, `architecture.md §4.5`) — 1 a 7 bloqueiam o merge; o 8 bloqueia só a promoção para produção:

| # | Estágio | Conteúdo | Bloqueia |
|---|---|---|---|
| 1 | Higiene | `pnpm install --frozen-lockfile`, gitleaks, licenças de dependências | Merge |
| 2 | Estático | lint, typecheck, `depcruise` (fronteiras DEC-041), SAST (CodeQL + Semgrep) | Merge |
| 3 | Contrato | OpenAPI gerado dos schemas Zod × arquivo versionado | Merge, se quebra incompatível na v1 |
| 4 | Testes | unitários → integração → suíte "tenant leak" → matriz de autorização; gate de cobertura | Merge |
| 5 | Migrações | aplicação do zero e sobre o *snapshot* da versão publicada anterior (*expand/contract*) | Merge |
| 6 | Imagens | *build* multi-stage por app, SBOM, varredura Trivy, assinatura | Merge, se CVE crítica/alta com correção disponível |
| 7 | E2E | Playwright + axe-core contra o Compose efêmero, Authentik real | Merge, inclusive por falha de acessibilidade séria |
| 8 | Pós-deploy (staging) | ZAP *baseline*, k6 *smoke*, verificação de *traces* | Só a promoção para produção |

**Critérios de saída do MVP 1** ([release-checklist.md §1.3](release-checklist.md#13-mvp-1)):
- 100% das stories P0 e P1 concluídas (DoD de card).
- Jornadas E2E J-01 a J-11 (seção 4) passando em staging.
- Suíte "tenant leak" 100% verde; matriz de autorização (RBAC) 100% verde.
- Testes de carga atendendo às metas da seção 7.1/7.2.
- Pentest externo sem achados críticos/altos abertos; ZAP *baseline* limpo.
- Zero defeito crítico/alto aberto; defeitos médios com plano aceito pelo PO.
- UAT assinado pelo cliente-piloto (jornada completa da fase preparatória).
- Observabilidade, backup/restauração e plano de rollback validados em produção.

> **Meta do painel situacional:** p95 ≤ 800 ms (product-overview C2; observability SLO-04). As divergências antigas (500 ms no release-checklist, 600 ms em architecture.md, 500 ms em US-004) foram alinhadas a esse valor na consolidação.

## 7. Testes não funcionais

### 7.1 Desempenho (metas por fluxo)
Fonte: [observability.md §1.1](../architecture/observability.md#11-slos-do-mvp-1) (SLOs do MVP 1).

| Fluxo | Meta (p95) |
|---|---|
| Leitura de recurso e listas paginadas | ≤ 500 ms (p99 ≤ 1,2 s) |
| Busca textual (`?q=`) | ≤ 800 ms |
| Painel situacional (`/processes/{id}/summary`) | ≤ 800 ms (ver divergência na seção 6) |
| Comandos (`/forward`, `/return`, `/decide`…) | ≤ 1 s (p99 ≤ 2,5 s) |
| Escritas simples e autosave de seção | ≤ 500 ms |
| Dashboard operacional | ≤ 1,5 s |
| Upload — intenção/confirmação e URL de download | ≤ 500 ms |
| PDF `PREVIEW` (interativo) | ≤ 15 s; falhas < 0,5% |
| PDF `CONTENT`/`APPROVAL_STAMPED` (assíncrono) | ≤ 30 s; falhas < 0,5% |
| Lag do outbox | < 5 s (p99 < 30 s) |
| Notificação in-app | < 10 s |
| E-mail | < 2 min |
| Verificação de upload (até 50 MB) | < 60 s |
| IA — solicitar geração (AI-01, 202) | ≤ 1 s |
| IA — rascunho completo (pedido → `SUCCEEDED`) | ≤ 90 s; falhas < 2% (excluídas as indisponibilidades do provedor) |
| IA — ajuste de seção (pedido → `SUCCEEDED`) | ≤ 20 s |
| IA — aplicar proposta (DOC-26/RSK-11) | ≤ 1 s |

### 7.2 Carga
- **Ferramenta:** k6 (confirmada em `decisions.md`).
- **No pipeline:** *smoke* no estágio 8 Pós-deploy em staging — resultado de alerta, não desfaz o merge, mas é *gate* da promoção para produção (RN-FND-28).
- **No release:** carga completa como critério de saída do MVP 1 — cenário de referência de 100 mil processos no tenant ([architecture.md](../architecture/architecture.md)), validando listas, painel (nota de divergência da seção 6), escrita, PDF e lag do outbox contra as metas da seção 7.1.
- **Periodicidade/orquestração da carga completa fora do pipeline por PR:** a definir.

### 7.3 Resiliência (dependências indisponíveis)
Fonte: [observability.md §6.2](../architecture/observability.md#62-dependências-por-aplicação-alinhado-a-ca-t-07-e-dec-131) e runbooks (§12).

| Dependência | Criticidade | Efeito testado (CA-T-07) | Runbook |
|---|---|---|---|
| PostgreSQL | Crítica (api/worker) | 503 `DEPENDENCY_UNAVAILABLE`, sem estado parcial | RB-07 (reservado) |
| Redis de sessões | Crítica (web/BFF) | BFF responde 503 | RB-08 (reservado) |
| Redis de filas/idempotência/cache | Crítica (worker); degradável (api/web) | Ação principal completa; trabalho assíncrono pendente sem duplicidade | RB-01 (lag do outbox) |
| S3 | Degradável | 503 só nas rotas de upload/download; scan/render aguardam | — |
| JWKS/Authentik | Crítica só no *startup*; depois degradável | Tokens válidos continuam aceitos; novos *logins* falham | RB-04 |
| Gotenberg | Degradável (worker) | Renderização pausada pelo *circuit breaker* | RB-03 |
| ClamAV | Degradável (worker) | Scan pausado; nenhum arquivo liberado | RB-05 |
| SMTP/SES | Degradável | E-mails ficam `PENDING` | — |
| Provedor de IA | Degradável (worker) | Disjuntor aberto → AI-01 503 `AI_PROVIDER_UNAVAILABLE`; gerações `FAILED` com notificação; editores e demais fluxos intactos | RB a criar na US-115 |

**Implementação:** Testcontainers interrompe ou pausa o contêiner da dependência durante o teste de integração; *health checks* `/health/live` (processo vivo) e `/health/ready` (dependências críticas) validam o comportamento, com resultado em cache de 5 s.

### 7.4 Segurança
Fonte: [security.md §20](../architecture/security.md#20-sast-dast-e-testes-de-segurança).

- **SAST** — CodeQL + Semgrep (regras: `$queryRawUnsafe`, `dangerouslySetInnerHTML`, `systemPrisma` fora da *allowlist*, `process.env` fora da configuração, log de objetos de requisição, `Math.random` para segredos) — todo PR.
- **Segredos** — gitleaks + *push protection* — *pre-commit* e PR.
- **IaC** — checkov / `trivy config` / tflint — PR de infraestrutura.
- **Validação de conteúdo** — testes de propriedade (*fuzzing*) do validador TipTap e do sanitizador HTML com cargas XSS conhecidas — todo PR.
- **DAST** — OWASP ZAP *baseline* (passivo) a cada *deploy* em staging; *full scan* autenticado semanal.
- **Pentest** — externo, caixa-cinza, antes do *go-live* e anualmente; o escopo inclui a geração com IA (injeção de instruções, exfiltração entre processos ou tenants e conteúdo malicioso na saída — §3.10).
- **Padrão de referência:** OWASP ASVS nível 2, conforme [overview.md §7](overview.md#7-premissas-e-restrições). As fontes revisadas não citam um mapeamento formal a "OWASP Top 10" como checklist separado — tratado como **a definir**.

### 7.5 LGPD
Fonte: [security.md §21](../architecture/security.md#21-lgpd).

- Cada instituição contratante (tenant) é **controladora**; o ContrataFlow é **operador**, controlador apenas dos dados de seus próprios operadores e contatos comerciais.
- Teste de inventário: CPF cifrado com *blind index*, aviso de EXIF em anexos, auditoria com alterações mascaradas, sessão sem *backup* no Redis.
- Teste de incidente: simulação do prazo contratual de comunicação ao controlador (até 24 h propostas) e verificação das evidências preservadas.
- IA (EP-020): teste do `ContextSanitizer` (minimização) e da omissão de valores sigilosos; inventário de dados e termos de uso com o provedor de IA como suboperador e a transferência internacional (ADR-013); nenhum conteúdo de documento em logs.
- Direitos do titular (art. 18): exportação/correção/anonimização — fluxo majoritariamente administrativo no MVP 1 (PEND-07 pendente sobre temporalidade); nível de automação do teste: **a definir**.

## 8. Rastreabilidade

- **Índice por story:** [acceptance-criteria.md §3](acceptance-criteria.md#3-índice-de-critérios-por-story) é, nas fontes atuais, um *placeholder* (`<!-- INDICE-POR-STORY -->`) com a nota "gerado a partir dos cards em `../backlog/`… será atualizado a cada revisão do backlog" — ainda **a ser gerado na consolidação**, não disponível nesta versão.
- **Onde vivem os cenários hoje:** cada card do backlog já traz suas 8 categorias de cenário Gherkin (ex.: `story-001-create-process.md`, `story-100-tenant-isolation.md`); o índice por story, quando gerado, deve ligar cada cenário a um identificador de teste automatizado.
- **Identificadores estáveis citáveis entre documentos:** `US-xxx` (story), `CA-T-xx` (critério transversal), `J-xx` (jornada), `RN-<módulo>-nn` (regra de negócio), `POL-xx` (política) — usados de forma consistente em todas as fontes revisadas.
- **Estrutura de pastas** ([architecture.md](../architecture/architecture.md)): `apps/api/test/` concentra integração (Testcontainers), contrato e *tenant-leak*; testes unitários ficam junto do código em `domain/`/`application/` por módulo.
- **Convenção de nomes de arquivo e *tags* Gherkin** (ex.: `@CA-T-01`, `@J-01`, `*.spec.ts` × `*.e2e.spec.ts`): não encontrada nas fontes revisadas — **a definir** na consolidação, espelhando os identificadores estáveis acima.
- **Gates gerados como rastreabilidade ativa** (reduzem a dependência de um índice manual): rota mutável sem permissão/política declarada falha o *build* (`permissions.md §10`); operação do OpenAPI sem classificação na suíte "tenant leak" falha o *build* (RN-TEN-36); `TENANT_SCOPED_MODELS` fora de sincronia com o schema Prisma falha o CI (RN-TEN-24).

## 9. Riscos de qualidade e mitigação

| Risco | Mitigação |
|---|---|
| Índice de critérios por story ainda não gerado (*placeholder*) | Gerar o índice antes do fechamento do MVP 1 e usá-lo como checklist de auditoria de cobertura por story |
| Metas de p95 divergentes entre `release-checklist.md`, `architecture.md` e `observability.md` (seção 6) | Consolidar um único valor por fluxo em `observability.md` antes do ciclo de testes de carga e propagar aos demais documentos |
| Cobertura alta (80%/100%) sem qualidade de asserção ("cobertura vaidade") | Revisão de código avalia os testes, não só o percentual; 100% em cálculo/políticas é conferido na revisão, não só pela ferramenta (RN-FND-24) |
| Ambiente efêmero (Testcontainers/CI) mascara problemas de capacidade real | Testes de carga completos e *smoke* de ZAP sempre em staging persistente antes do *go-live* |
| Seeds divergentes entre jornadas ("Prefeitura de São José"/"Câmara de Vila Nova") e suíte de isolamento ("Prefeitura A"/"Prefeitura B") | Documentar explicitamente os dois propósitos (demonstração de negócio × isolamento genérico) e evitar duplicar scripts de seed |
| Geração de EICAR em runtime falha silenciosamente e o scan nunca é exercitado de fato | Meta-teste que falha se o ClamAV real não for efetivamente invocado no teste de integração de upload |
| Pentest e ZAP *full scan* são periódicos, não por PR | SAST/Semgrep e ZAP *baseline* por PR/*deploy* funcionam como rede de segurança contínua entre execuções |
| Convenção de *tags*/nomes de teste ainda não definida (seção 8) | Fixá-la na consolidação antes de crescer o número de suítes, para não exigir retrabalho de rotulagem |
| Não determinismo da IA torna testes instáveis | `FakeAiProvider` determinístico no CI; qualidade medida à parte pelo `pnpm ai:eval`; asserções sobre estrutura, marcações e rastreabilidade, nunca sobre o texto livre |
| Harness de teste para J-06 (relógio controlado) e J-09 (violação simulada de selo) não confirmado nas fontes | Especificar o mecanismo (ex.: endpoint de teste, injeção de clock) na Sprint que implementar essas jornadas, antes de declará-las automatizadas |
