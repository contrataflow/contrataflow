---
id: US-079
title: "Pipeline de CI com quality gates"
epic: EP-015
feature: FT-047
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-077]
modules: [platform]
screens: []
endpoints: []
permissions: []
events: []
---

# US-079 — Pipeline de CI com quality gates

## Título
Pipeline de CI com quality gates

## Descrição
**Como** time de engenharia do ContrataFlow, **quero** um pipeline de integração contínua no GitHub Actions que bloqueie automaticamente qualquer Pull Request que quebre lint, tipos, testes, contrato de API, migrações, segurança ou build de imagem, **para** que `main` esteja sempre implantável e nenhuma regressão de isolamento multi-tenant, contrato ou segurança chegue a produção.

Todo PR dispara os 8 estágios definidos na arquitetura (Higiene → Pós-deploy em staging); os 7 primeiros bloqueiam o merge, o 8º bloqueia apenas a promoção para produção. Os estágios reaproveitam os scripts da US-077 (`pnpm build/lint/typecheck/test/depcruise`) e o ambiente da US-078 (Docker Compose para testes de integração e E2E).

## Contexto
- Provedor de CI/CD decidido: **GitHub Actions** (DEC-061). Esta story implementa a decisão, não a toma.
- A arquitetura (`architecture.md` §4.5) já define os 8 estágios obrigatórios e o que cada um bloqueia; esta story os materializa em *workflows* do GitHub Actions — o próprio documento cita explicitamente "detalhe em US-079".
- A US-077 criou os scripts que o CI invoca e deixou pendente apenas a configuração de proteção de branch e dos próprios *workflows* (sua pré-condição citava: "CI/CD decidido — DEC-061; proteção de branch é configurada na US-079").
- Sem este pipeline, as fronteiras de módulo (DEC-041), a ausência de segredos (DEC-137), o contrato de erro (DEC-103) e o isolamento de tenant (DEC-080/081/082) dependem só de revisão humana — insuficiente para um produto B2G com múltiplos tenants de dados sensíveis.

## Objetivo
Garantir que 100% dos PRs contra `main` executem os 8 estágios de CI, que os 7 primeiros sejam *required checks* de branch protection (impossível mesclar sem passar), e que o tempo total do caminho crítico (Higiene→E2E) fique abaixo de 15 minutos com cache quente.

## Persona
- **Principal:** Pessoa desenvolvedora do ContrataFlow (abre e mescla PRs).
- **Secundárias:** Tech Lead/segurança (CODEOWNERS, aprova mudanças de pipeline); pipeline de CD/produção (consome o artefato de imagem assinado ao final).

## Pré-condições
- US-077 concluída (scripts, lockfile, ESLint/dependency-cruiser, commitlint).
- US-078 concluída (Docker Compose reutilizado nos estágios de Testes/E2E).
- Repositório no GitHub com Actions habilitado e OIDC para a AWS configurado (sem chaves de longa duração — security.md §19).

## Fluxo principal
1. A pessoa desenvolvedora abre um Pull Request contra `main`.
2. O GitHub Actions dispara o workflow principal, que executa os estágios em sequência/paralelo conforme dependência:
   1. **Higiene** — `pnpm install --frozen-lockfile`, `gitleaks`, verificação de licenças.
   2. **Estático** — `pnpm lint`, `pnpm typecheck`, `pnpm depcruise`, SAST (CodeQL + Semgrep — security.md §20).
   3. **Contrato** — `pnpm openapi:generate` e diff contra o OpenAPI versionado; *breaking change* na v1 (DEC-108) falha o estágio.
   4. **Testes** — unitários (Vitest) → integração com Testcontainers (Postgres com RLS real, Redis, MinIO, ambiente da US-078) → suíte "tenant leak" → testes de autorização gerados (permissions.md §10); cobertura do código novo verificada como *check* bloqueante (release-checklist.md).
   5. **Migrações** — aplica as migrações do zero e sobre *snapshot* da versão anterior; lint de migração *expand/contract*; checagens de RLS/FK composta (multi-tenancy.md §14).
   6. **Imagens** — build multi-stage de `web`/`api`/`worker`, gera SBOM (CycloneDX/Syft), varredura de vulnerabilidades (Trivy) e assinatura (cosign); CVE crítica/alta com correção disponível falha o estágio.
   7. **E2E** — Playwright + axe-core contra um ambiente efêmero (Docker Compose da US-078, Authentik real).
3. Ao final dos estágios 1–7, o GitHub reporta os *status checks*; branch protection em `main` exige todos eles verdes **e** aprovação de CODEOWNERS (US-077) antes de habilitar o *squash merge*.
4. Após o merge, um segundo workflow promove a imagem para **staging** e executa o estágio 8 — **Pós-deploy**: ZAP baseline, k6 *smoke*, verificação de *traces*; falha gera alerta, mas não desfaz o merge — apenas bloqueia a promoção seguinte (produção).
5. O título do PR (validado por commitlint — US-077) se torna a mensagem do commit squash em `main`.

## Fluxos alternativos
- **FA-01 — Execuções redundantes:** um novo *push* no mesmo PR cancela a execução anterior em andamento (`concurrency group` por PR), evitando filas desnecessárias.
- **FA-02 — PRs simultâneos:** cada execução usa um ambiente efêmero isolado (Testcontainers/Compose com projeto próprio); nenhuma interferência entre PRs.
- **FA-03 — Exceção de CVE sem correção disponível:** o estágio Imagens não bloqueia quando não há *patch* publicado; a exceção é registrada com prazo de revisão (security.md §19) e some do relatório quando expira sem solução.
- **FA-04 — Falha intermitente de infraestrutura externa (registry/scanner):** o estágio correspondente faz retry automático (política de tentativas com backoff) antes de marcar falha definitiva; cada *job* tem timeout para não travar o pipeline indefinidamente.
- **FA-05 — Mudança só de documentação:** um filtro de caminhos pula os estágios 4–7 para PRs que tocam apenas `docs/**`, mantendo 1–3 (Higiene, Estático, Contrato) sempre ativos. O filtro é feito por condição de job (o Higiene calcula o escopo), não por `paths-ignore` no workflow — senão os *required checks* nunca reportariam (DEC-066).
- **FA-06 — Rebase/force-push:** o pipeline reexecuta do zero; não há *cache* de resultado por SHA antigo.

## Regras de negócio
- **RN-FND-20** — Os 8 estágios de `architecture.md` §4.5 executam nesta ordem para todo PR contra `main`; os estágios 1–7 são *required status checks* de branch protection (bloqueiam merge); o estágio 8 roda só após o merge, contra staging, e bloqueia apenas a promoção para produção.
- **RN-FND-21** — Estágio **Higiene**: `pnpm install --frozen-lockfile`, `gitleaks` (segredos), verificação de licenças de dependências; qualquer falha bloqueia o merge.
- **RN-FND-22** — Estágio **Estático**: `pnpm lint`, `pnpm typecheck`, `pnpm depcruise` (fronteiras DEC-041) e SAST (CodeQL + Semgrep, regras de `security.md` §20: `$queryRawUnsafe`, `dangerouslySetInnerHTML`, `systemPrisma` fora da allowlist, `process.env` fora da configuração, log de objetos de requisição, `Math.random` para segredos); qualquer falha bloqueia.
- **RN-FND-23** — Estágio **Contrato**: gera o OpenAPI a partir dos schemas Zod e compara com o arquivo versionado; qualquer mudança incompatível na v1 (DEC-108) bloqueia — mudanças aditivas passam.
- **RN-FND-24** — Estágio **Testes**: ordem obrigatória unitários → integração → suíte "tenant leak" → matriz de autorização; cobertura mínima de 80% de linhas do código novo em `domain/`+`application/` por módulo tocado no PR, como *check* bloqueante (`ci.coverageGateEnabled = true`), e 100% nas regras de cálculo e políticas, conferido na revisão — mesmos limiares do release-checklist.md.
- **RN-FND-25** — Estágio **Migrações**: aplica todas as migrações do zero e também sobre o *snapshot* da versão publicada anterior (compatibilidade *expand/contract*); falha de qualquer aplicação ou do lint de migração bloqueia.
- **RN-FND-26** — Estágio **Imagens**: build multi-stage por app (`web`/`api`/`worker`), SBOM por imagem, varredura Trivy e assinatura; CVE **crítica ou alta com correção disponível** bloqueia; sem correção disponível, vira exceção registrada com prazo (security.md §19).
- **RN-FND-27** — Estágio **E2E**: Playwright + axe-core contra o Compose da US-078 em modo efêmero, com Authentik real (sem *mocks* de autenticação); falhas de acessibilidade sérias bloqueiam no mesmo nível que falhas funcionais.
- **RN-FND-28** — Estágio **Pós-deploy (staging)**: ZAP *baseline*, k6 *smoke*, verificação de *traces*; resultado **alerta** (não desfaz merge) mas é *gate* obrigatório da promoção para produção; alteração em `.github/**` segue a regra de CODEOWNERS da US-077 (Tech Lead + segurança), mesmo com todos os estágios verdes.

## Campos
| Campo (configuração do pipeline) | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|
| `GITHUB_TOKEN` (automático) | secret | Sim | gerenciado pelo GitHub | — |
| `AWS_OIDC_ROLE_ARN` | secret/variável | Sim (estágios 6/8) | *role* com permissão mínima (OIDC, sem chaves estáticas) | definido por ambiente do GitHub |
| `SEMGREP_APP_TOKEN` | secret | Não | habilita regras gerenciadas; sem o token, roda só regras locais | vazio |
| `ci.coverageThreshold` | número | Não | 0–100 | `80` |
| `ci.coverageGateEnabled` | booleano | Não | — | `true` (desativar só por decisão registrada da liderança técnica) |
| Branch protection (`main`) | configuração do repositório | Sim | exige os estágios 1–7 + 1 aprovação de CODEOWNERS | configurado nesta story |
| Ambiente `staging` / `production` (GitHub Environments) | configuração | Sim | `production` com *required reviewers* | configurado nesta story |

## Validações
| # | Validação | Estágio | Mensagem ao desenvolvedor | Código/saída |
|---|---|---|---|---|
| V-01 | Lockfile desatualizado | Higiene | "Execute pnpm install e versione o lockfile." | `ERR_PNPM_OUTDATED_LOCKFILE` (US-077) |
| V-02 | Segredo detectado | Higiene | "Segredo detectado em {arquivo}:{linha}. Remova e rotacione." | achado do `gitleaks` |
| V-03 | Erro de lint/tipo/fronteira | Estático | Saída nativa de ESLint/`tsc`/`depcruise` | regra correspondente |
| V-04 | Achado SAST relevante | Estático | Anotação inline no PR com a regra violada | ID da regra CodeQL/Semgrep |
| V-05 | *Breaking change* no OpenAPI v1 | Contrato | "Mudança incompatível em {rota}. Use /api/v2 ou torne aditiva." | `OPENAPI_BREAKING_CHANGE` |
| V-06 | Teste falho (unitário/integração/E2E) | Testes/E2E | Saída nativa do runner com arquivo e asserção | — |
| V-07 | Vazamento entre tenants na suíte "tenant leak" | Testes | "Isolamento de tenant violado em {teste}." | falha da suíte dedicada |
| V-08 | Migração falha do zero ou sobre snapshot anterior | Migrações | Erro nativo do Prisma/SQL | — |
| V-09 | CVE crítica/alta com correção disponível | Imagens | "Vulnerabilidade {CVE} em {pacote}. Atualize para {versão}." | achado do Trivy |
| V-10 | Violação de acessibilidade séria | E2E | "Violação de acessibilidade: {regra} em {página}." | achado do axe-core |

## Permissões
- **Permissão (acesso a segredos/ambientes):** segredos de `staging`/`production` ficam em *Environments* do GitHub com *required reviewers*; nenhum *job* de PR de contribuinte externo acessa segredos de produção (workflows de `pull_request_target` evitados).
- **Políticas:** mudanças em `.github/**`, `pnpm-workspace.yaml`, `.dependency-cruiser.cjs` exigem aprovação de CODEOWNERS (Tech Lead + segurança — já listado na US-077); acesso à AWS só por OIDC de curta duração (security.md §19), nunca chaves estáticas no repositório.
- **MFA:** exigido a nível de organização do GitHub para quem aprova *merges* em `main` (configuração do GitHub, fora do código).
- **Sem permissão:** PR de colaborador externo roda os estágios 1–7 em modo restrito (sem acesso a segredos); estágio 8 (deploy) só executa para merges feitos por quem tem o papel de *maintainer*.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Não aplicável: pipeline de CI não é um agregado de domínio do produto. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| Falha de estágio obrigatório | Autor do PR | Comentário do GitHub Actions no PR + e-mail nativo do GitHub | Qualquer estágio 1–7 falha |
| Alerta de Pós-deploy | Time de engenharia | Slack `#cf-ci` (operacional; fora do módulo `notification`) | Estágio 8 falha ou CVE sem correção expira |

## Critérios de aceite em Gherkin
```gherkin
Feature: Pipeline de CI com quality gates

  Background:
    Given que o repositório segue o padrão da US-077 (scripts, lockfile, ESLint, dependency-cruiser)
    And o ambiente de Compose da US-078 está disponível para os estágios de Testes e E2E

  Scenario: [Sucesso] Pull Request aprovado em todos os estágios obrigatórios
    Given um Pull Request contra "main" sem erros de lint, tipo, teste, contrato ou segurança
    When o workflow de CI for executado
    Then os estágios 1 a 7 devem terminar com sucesso
    And o PR deve ficar elegível para "squash merge" após aprovação de CODEOWNERS

  Scenario: [Validação] Erro de tipo bloqueia o merge
    Given um Pull Request com um erro de TypeScript introduzido
    When o estágio "Estático" for executado
    Then o "check" deve falhar apontando o arquivo e a linha
    And o botão de merge deve permanecer bloqueado

  Scenario: [Permissão] Alteração em arquivo protegido sem aprovação de CODEOWNERS
    Given um Pull Request que altera ".github/workflows/ci.yml"
    When todos os estágios 1 a 7 terminarem com sucesso
    And nenhum CODEOWNER tiver aprovado
    Then o merge deve permanecer bloqueado pela regra de branch protection

  Scenario: [Tenant incorreto] Regressão de isolamento é bloqueada
    Given um Pull Request que introduz uma consulta sem filtro de tenant
    When a suíte "tenant leak" do estágio "Testes" for executada
    Then o estágio deve falhar
    And o merge deve permanecer bloqueado

  Scenario: [Duplicidade] Execuções redundantes são canceladas
    Given um Pull Request com uma execução de CI em andamento
    When um novo commit for enviado ao mesmo Pull Request
    Then a execução anterior deve ser cancelada
    And apenas a execução mais recente deve reportar o resultado final

  Scenario: [Concorrência] Pull Requests simultâneos não interferem entre si
    Given dois Pull Requests abertos ao mesmo tempo, cada um alterando módulos diferentes
    When os workflows de CI de ambos forem executados
    Then cada execução deve usar seu próprio ambiente efêmero
    And o resultado de um não deve afetar o resultado do outro

  Scenario: [Falha de banco] Migração falha ao aplicar sobre o snapshot anterior
    Given um Pull Request cuja migração nova falha ao aplicar sobre o snapshot da versão publicada anterior
    When o estágio "Migrações" for executado
    Then o estágio deve falhar com o erro nativo do Prisma/SQL
    And o merge deve permanecer bloqueado

  Scenario: [Falha de integração] Scanner de vulnerabilidades fica indisponível
    Given que o serviço de varredura (Trivy) está temporariamente indisponível
    When o estágio "Imagens" for executado
    Then o job deve tentar novamente automaticamente antes de falhar definitivamente
    And, se o tempo limite for excedido, o estágio deve falhar de forma explícita em vez de travar indefinidamente
```

## Casos de erro
| Situação | Estágio | Código/saída | Mensagem | Comportamento |
|---|---|---|---|---|
| Lockfile desatualizado | Higiene | `ERR_PNPM_OUTDATED_LOCKFILE` | "Execute pnpm install e versione o lockfile." | Bloqueia merge |
| Segredo detectado | Higiene | achado `gitleaks` | "Segredo detectado em {arquivo}." | Bloqueia merge; orienta rotação |
| Lint/tipo/fronteira | Estático | regra correspondente | Saída nativa da ferramenta | Bloqueia merge |
| Breaking change no contrato | Contrato | `OPENAPI_BREAKING_CHANGE` | "Mudança incompatível em {rota}." | Bloqueia merge |
| Teste falho | Testes/E2E | — | Saída nativa do runner | Bloqueia merge |
| Isolamento de tenant violado | Testes | — | "Isolamento de tenant violado em {teste}." | Bloqueia merge; alerta de segurança |
| Migração falha | Migrações | — | Erro nativo do Prisma/SQL | Bloqueia merge |
| CVE crítica/alta | Imagens | achado Trivy | "Vulnerabilidade {CVE} em {pacote}." | Bloqueia merge (ou exceção com prazo) |
| Violação de acessibilidade séria | E2E | achado axe-core | "Violação de acessibilidade: {regra}." | Bloqueia merge |
| Falha de infraestrutura externa do CI | Qualquer | timeout/erro de rede | "Falha ao contatar {serviço}. Tentando novamente." | Retry automático; falha definitiva após o limite |
| Promoção pós-deploy falha | Pós-deploy | achado ZAP/k6 | — | Bloqueia promoção para produção; não desfaz o merge |

## Dependências
- **Stories:** US-077 (scripts, lockfile, dependency-cruiser, CODEOWNERS, commitlint — pré-requisito direto); US-078 (ambiente de Compose reaproveitado nos estágios Testes/E2E). Habilita implicitamente todas as demais ao garantir qualidade contínua.
- **Decisões/ADRs:** DEC-041, DEC-050, DEC-054, DEC-108, DEC-137; DEC-061; ADR-001, ADR-010.
- **Configurações:** `ci.coverageThreshold`, `ci.coverageGateEnabled`; *Environments* `staging`/`production` do GitHub.
- **Lacunas nas fontes canônicas:** nenhuma (limiares de cobertura do release-checklist.md: 80% do código novo em `domain`/`application`; 100% em regras de cálculo e políticas).

## Impacto técnico
- Pipeline define o "contrato de qualidade" que toda story subsequente deve satisfazer; qualquer mudança nos estágios (ex.: novo *gate*) é mudança de alto impacto e exige aprovação de CODEOWNERS.
- Tempo total do caminho crítico (estágios 1–7) é a métrica de saúde do próprio processo de entrega; cache do Turborepo (`actions/cache`, sem cache remoto de terceiros no MVP 1 — US-077) é essencial para o orçamento de 15 min.
- *Workflows* reutilizáveis (`workflow_call`) evitam duplicação entre o pipeline de PR e o de pós-merge/deploy.
- Ambientes efêmeros (Testcontainers/Compose) devem ser descartados ao final de cada execução, mesmo em falha, para não acumular custo em *runners*.

## Backend
- **Módulo(s):** `platform` (CI é infraestrutura compartilhada; não há módulo de negócio envolvido).
- **Casos de uso:** não aplicável.
- **Domínio:** não aplicável.
- **Scripts/arquivos:** `.github/workflows/ci.yml` (PR), `.github/workflows/deploy-staging.yml` (pós-merge, estágios 6–8), `.github/CODEOWNERS` (US-077, revisado aqui para `.github/**`), `tools/ci/*.ts` (helpers de diff de OpenAPI, agregação de cobertura).

## Frontend
Não aplicável — story de infraestrutura de CI, sem interface própria. O estágio E2E executa contra `apps/web`, mas não altera seu código.

## Banco de dados
- **Uso no pipeline:** Postgres efêmero (Testcontainers) nos estágios Testes e Migrações, descartado ao final de cada execução; nenhuma migração de schema de produto é introduzida por esta story (schema é da US-081).
- **Migrações:** não aplicável a esta story além de validar as migrações que outras stories trouxerem.
- **Índices/constraints relevantes:** não aplicável.

## API
Não aplicável — nenhum endpoint REST é introduzido; o estágio "Contrato" valida o OpenAPI de endpoints definidos por outras stories.

## Logs
- `info` `ci.stage_completed` — estágio, duração, resultado.
- `warn` `ci.coverage_below_threshold` — cobertura abaixo de `ci.coverageThreshold`.
- `warn` `ci.cve_exception_registered` — exceção de CVE sem correção disponível, com prazo.
- `error` `ci.stage_failed` — estágio, causa resumida, link para os logs completos do GitHub Actions.
- **Nunca logar:** conteúdo de segredos, tokens de OIDC/AWS, saída bruta do `gitleaks` com o segredo encontrado (só caminho e linha).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Não aplicável ao módulo `audit` do produto; o histórico de execuções e aprovações é o próprio log de auditoria nativo do GitHub (fora do ContrataFlow). |

## Testes necessários
- **Unitários:** `tools/ci/*.ts` (diff de OpenAPI, agregação de cobertura) com casos de mudança aditiva × *breaking*.
- **Integração:** execução completa do workflow em um PR de teste (*fixture*) com uma violação proposital por estágio (lint, tipo, fronteira, contrato, migração, CVE, acessibilidade) — cada uma deve falhar o estágio certo.
- **Suíte "tenant leak":** incluída no estágio Testes (reaproveita fixtures das stories de negócio conforme forem chegando).
- **Carga do próprio pipeline:** medição do tempo total em cache quente/frio por 10 execuções consecutivas; p95 do caminho crítico (1–7) < 15 min.
- **Segurança do pipeline:** teste de que um PR de fork/colaborador externo não acessa segredos de `production`.

## Definition of Done
- [ ] Os 8 estágios implementados e configurados como *required status checks* (1–7) em `main`
- [ ] Ambiente efêmero de Testes/E2E reutilizando o Compose da US-078 funcionando no CI
- [ ] Diff de OpenAPI bloqueando *breaking changes* da v1 (DEC-108)
- [ ] Suíte "tenant leak" rodando a cada PR
- [ ] SBOM, varredura de vulnerabilidades e assinatura de imagem funcionando no estágio Imagens
- [ ] Estágio Pós-deploy (ZAP baseline, k6 smoke) rodando contra staging após merge
- [ ] Branch protection e CODEOWNERS configurados e testados com um PR fictício por estágio
- [ ] Tempo do caminho crítico (1–7) medido e dentro do orçamento (p95 < 15 min)
- [ ] Documentação do pipeline (`CONTRIBUTING.md` ou `docs/architecture/architecture.md`) atualizada com qualquer ajuste feito nesta implementação
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — a arquitetura já define os 8 estágios e o que cada um faz (architecture.md §4.5); o esforço é de configuração e integração (GitHub Actions, Testcontainers, SBOM/assinatura, ZAP/k6), não de desenho.

## Prioridade
**P0** — sem CI automatizado, nenhuma garantia de qualidade/segurança/isolamento é contínua; é pré-requisito informal (qualidade) de todo o restante do backlog, mesmo sem bloquear tecnicamente outras stories.
