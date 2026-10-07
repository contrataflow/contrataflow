---
id: FT-047
title: "Monorepo e ambiente"
epic: EP-015
mvp: 1
priority: P0
stories: [US-077, US-078, US-079]
status: Especificada
---

# FT-047 — Monorepo e ambiente

## Título
Monorepo e ambiente

## Épico
EP-015 — Fundação técnica

## Descrição
Organiza o código-fonte como monorepo pnpm + Turborepo (DEC-051) com padrões de versionamento de dependências, TypeScript estrito, regras de fronteira entre módulos/camadas e commits convencionais (US-077); disponibiliza um ambiente local reprodutível via Docker Compose com todas as dependências de infraestrutura (US-078); e garante que todo Pull Request passe pelos oito estágios de qualidade do pipeline de CI antes do merge e da promoção para produção (US-079).

Sem esta feature não existe onde instalar nenhuma dependência, nenhum ambiente para rodar teste de integração e nenhum portão de qualidade — é o primeiro passo literal de todo o MVP 1.

## Valor para o usuário e para o órgão
- Reduz o tempo de integração de uma nova pessoa na equipe (ambiente local sobe com um único comando).
- Reduz regressão em produção (quality gates bloqueantes antes do merge).
- Garante portabilidade (Linux/macOS/Windows) e ausência de segredo real em repositório, protegendo o órgão contratante de incidente de segurança por vazamento de credencial.

## Personas
- Pessoa desenvolvedora backend/frontend (`equipe de engenharia`) — usa o monorepo, o ambiente local e o CI em todo Pull Request.
- Pipeline de CI (`automação`) — executa os oito estágios de `architecture.md` §4.5 a cada Pull Request.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-077 | Configurar monorepo e padrões de código | P0 | M | — |
| US-078 | Ambiente local com Docker Compose | P0 | M | US-077 |
| US-079 | Pipeline de CI com quality gates | P0 | M | US-077 |

## Escopo
- Catálogo único de versões (`pnpm-workspace.yaml`), TypeScript estrito, ESLint com regras de fronteira e segurança, `dependency-cruiser`, Conventional Commits, modelo *trunk-based* com *squash merge*.
- Docker Compose com PostgreSQL 17 (dois bancos lógicos), dois Redis logicamente separados, MinIO + bootstrap, Authentik (blueprint declarativo), Mailpit, Gotenberg, ClamAV; perfis opcionais `observability` e `full`; seed idempotente de duas prefeituras.
- Pipeline de CI (GitHub Actions) com oito estágios: Higiene, Estático, Contrato, Testes, Migrações, Imagens, E2E, Pós-deploy.

## Fora de escopo
- Infraestrutura de produção (Terraform, AWS) — tratada em `architecture.md` §11, sem story própria neste épico.
- Observabilidade (logs, tracing, métricas, health) — FT-049.

## Regras de negócio da feature
- RN-FND-01 a RN-FND-12 (US-077): versionamento exato de dependências, runtime fixo, TypeScript estrito, regras de fronteira e segurança no ESLint, commits/branches, licenças permitidas, portabilidade.
- RN-FND-13 a RN-FND-19 (US-078): serviços padrão do Compose, bancos lógicos, Redis separados, bootstrap de storage, blueprint do Authentik, seed idempotente, ausência de segredo real.
- RN-FND-20 a RN-FND-28 (US-079): os oito estágios do pipeline, nesta ordem, com seus *gates* bloqueantes.

## Telas
Não aplicável — feature inteiramente de infraestrutura de desenvolvimento, sem interface de usuário final.

## Endpoints
Não aplicável — nenhum endpoint de `api.md` é criado por esta feature.

## Entidades
Não aplicável — nenhuma tabela de negócio; o seed local (US-078) só popula dados de demonstração sobre entidades que ainda não têm schema real nesta feature.

## Eventos
Não aplicável.

## Permissões
Não aplicável — nenhuma permissão de catálogo é introduzida; CODEOWNERS (revisão humana) é o controle de acesso desta feature, não RBAC de aplicação.

## Dependências
- Pré-requisito direto de FT-048, FT-049 e FT-050 (todas as demais features deste épico constroem sobre o monorepo, o ambiente e o CI entregues aqui).
- DEC-050, DEC-051, DEC-052, DEC-058; `architecture.md` §4.

## Critérios de aceite da feature
```gherkin
Feature: Monorepo e ambiente
  Scenario: Jornada ponta a ponta de configurar e validar o ambiente
    Given um checkout limpo do repositório
    When a pessoa desenvolvedora instalar as dependências e subir o Docker Compose
    Then o ambiente local deve ficar pronto com um único comando
    And um Pull Request contra "main" deve executar os oito estágios do pipeline de CI
```

## Métricas de sucesso
- Tempo de `pnpm install` + subida do Compose até ambiente pronto: meta < 5 min em máquina de desenvolvimento padrão.
- Tempo total dos estágios 1–7 do CI: < 15 min p95 (KPI do épico).

## Riscos
- Drift entre o ambiente local (Compose) e produção (AWS) — mitigado por usar as mesmas versões de imagem/protocolos abertos (DEC-058) e pelo estágio de Migrações do CI.
- Dependência nova sem avaliação de licença/segurança — mitigado por RN-FND-10/RN-FND-11 e pelo estágio de Higiene do CI.

## Definition of Done da feature
- [ ] Todas as stories P0 (US-077, US-078, US-079) concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (checkout → ambiente local → PR passando pelos oito estágios)
- [ ] Documentação atualizada (`README.md` do monorepo, `CONTRIBUTING.md`, `architecture.md` §4)
