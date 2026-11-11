---
id: FT-065
title: "Workflow padrão v2 e `RuleContext` v2"
epic: EP-021
mvp: 2
priority: P0
stories: [US-129, US-130, US-131]
status: Especificada
---

# FT-065 — Workflow padrão v2 e `RuleContext` v2

## Título
Workflow padrão v2 e `RuleContext` v2

## Épico
EP-021 — Workflow v2

## Descrição
Fixa o contrato do `RuleContext` v2 (DEC-204) — superset do v1 com os namespaces `pca.*`, `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*` e `sla.*`, com montagem preguiçosa por namespace e provedores publicados por cada módulo — e entrega a **versão 2 do workflow padrão** (DEC-196): `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO` → `CONCLUSAO`, com as regras de saída de cada módulo, mais a v2 da contratação direta (art. 72) com `DOTACAO` e `JURIDICO` antes da autorização.

A v2 é **oferecida, nunca imposta**: publicada automaticamente só para tenants que usam o padrão sem customização; os demais recebem a oferta de adoção (cópia como nova versão `DRAFT`). Processos em andamento ficam na versão anterior até uma migração pedida (FT-064). Processos já `COMPLETED` na v1 podem continuar para a fase preparatória completa, entrando em `DOTACAO` por decisão humana.

## Valor para o usuário e para o órgão
- Fase preparatória completa e conforme a Lei 14.133/2021 no fluxo padrão, sem configuração manual.
- Regras de saída consistentes entre módulos graças a um contexto de regras único e versionado.
- Pilotos continuam processos concluídos no MVP 1 sem refazê-los.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — adota (ou dispensa a oferta da) v2 e pede a continuação dos concluídos.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha os processos na nova fase preparatória.
- Desenvolvedor de módulo — publica o provedor do seu namespace do contexto (usuário técnico da story US-129).

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-129 | `RuleContext` v2: contrato versionado e provedores por módulo | P0 | M | US-041, US-044 |
| US-130 | Workflow padrão v2 da fase preparatória e oferta de adoção | P0 | M | US-042, US-045, US-129, US-148, US-155, US-161, US-168 |
| US-131 | Levar à fase preparatória processos concluídos na v1 | P1 | M | US-128, US-130 |

## Escopo
- `ruleContextV2Schema`, `RuleContextContributor` por módulo, `contextVersion` gravada por regra e avaliação de regras v1 com o contexto v1.
- Seeder da v2 do padrão (etapas 7 a 12 da DEC-196) e da v2 da contratação direta; `Workflow.seedKey`, `offeredSeedVersion`, `WorkflowVersion.seedVersion` e comparação por `definitionHash`.
- Publicação automática para tenant sem customização; oferta e adoção para os demais; dispensar a oferta; `workflow.offerSeedUpdates`.
- Continuação v1 → v2 dos processos `COMPLETED` via `WorkflowMigration`, sempre `NEEDS_DECISION`.

## Fora de escopo
- As regras de saída em si (dotação, edital, jurídico, controle interno): EP-024 a EP-027, que publicam o provedor do seu namespace.
- Biblioteca de regras, roteamento, alçadas e simulador — EP-031.
- Pausa de SLA na diligência e políticas de prazo — EP-030.
- Divulgação do edital (MVP 3): `COMPLETED` da v2 significa apenas "fase preparatória concluída".

## Regras de negócio da feature
- RN-WF2-17 — o `RuleContext` v2 é superset do v1: todos os caminhos da v1 mantêm o significado; regras v1 continuam avaliadas com o contexto v1, cada regra gravando a sua `contextVersion` (DEC-204).
- RN-WF2-18 — a montagem do contexto é preguiçosa por namespace e cada módulo publica o provedor do seu namespace; valores de orçamento sigiloso entram no contexto, mas nunca saem em mensagens, eventos, auditoria ou simulador para quem não tem POL-09 (DEC-204, ADR-015).
- RN-WF2-19 — a v2 do padrão segue a ordem `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO` → `CONCLUSAO`, com a ordem entre Jurídico e Controle Interno configurável por tenant (DEC-196, "a validar com o jurídico do piloto").
- RN-WF2-20 — a v2 é publicada automaticamente só quando a versão publicada do tenant tem `seedVersion` preenchido (padrão sem customização); nos demais casos é apenas oferecida, e adotar cria nova versão `DRAFT` do próprio workflow (DEC-196).
- RN-WF2-21 — nenhum processo muda de versão sem `WorkflowMigration`; processos em andamento ficam na versão anterior (DEC-195, DEC-196).
- RN-WF2-22 — o processo `COMPLETED` na v1 só continua para a v2 entrando em `DOTACAO`, sempre como `NEEDS_DECISION`; é o único caminho em que `COMPLETED` volta a `IN_PROGRESS`, e o rótulo "concluído" vem do nome da etapa `END` da versão (DEC-195, DEC-196).

## Telas
- SCR-034 — Workflow, ampliado (oferta e adoção da v2, comparação com a versão atual) (`/admin/workflows/[id]`)
- SCR-118 — Migração de processos entre versões de workflow (continuação dos concluídos na v1) (`/admin/workflows/[id]/migracoes/[migrationId]`)

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /workflows/{id}/seed-offer` — consultar a oferta de nova versão do padrão
- `POST /workflows/{id}/seed-offer/adopt` — adotar (cria versão `DRAFT` copiada da semente)
- `POST /workflows/{id}/seed-offer/dismiss` — dispensar a oferta
- `POST /rules/context-preview` — pré-visualizar o `RuleContext` v2 de um processo (técnico, sob POL-09)
- `POST /workflows/{id}/migrations` — criar a migração de continuação (FT-064), com filtro `COMPLETED`

## Entidades
- `Workflow` — `seedKey`, `offeredSeedVersion`, `offerDismissedAt`.
- `WorkflowVersion` — `seedVersion`, `ruleRefs`.
- `WorkflowStage` / `WorkflowRule` — `isLegallyRequired`, `pauseSlaWhileReturned`, `contextVersion`.
- `WorkflowMigration` / `WorkflowMigrationItem` — continuação v1 → v2.
- `Process` — volta de `COMPLETED` para `IN_PROGRESS` apenas pela migração.

## Eventos
- `WorkflowSeedVersionOffered` — seeder oferece a v2.
- `WorkflowSeedVersionAdopted` — publicação automática ou adoção pelo administrador.
- `ProcessWorkflowMigrated` — cada processo continuado.

## Permissões
- `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` — adotar e publicar a v2.
- `WORKFLOW_MIGRATE` — continuação dos concluídos (POL-21).

## Dependências
- Stories: US-041, US-044 (motor e regras), US-042, US-045 (padrão e publicação), US-128 (execução da migração); US-148, US-155, US-161 e US-168 (regras de saída de dotação, jurídico, controle interno e edital) — única dependência "de volta" do épico.
- Decisões: DEC-196, DEC-204, DEC-195; ADR-015.
- Os módulos não dependem da v2 semeada: testam com versões de workflow próprias.

## Critérios de aceite da feature
```gherkin
Feature: Workflow padrão v2 e RuleContext v2
  Scenario: Tenant sem customização recebe a v2 e continua um processo concluído
    Given um tenant que usa o workflow padrão da v1 sem customização
    When o seeder da v2 rodar
    Then a v2 é publicada com as etapas de dotação, edital, jurídico e controle interno
    And os processos em andamento continuam na versão anterior
    When o administrador migrar um processo "COMPLETED" da v1 para a v2 com decisão e justificativa
    Then o processo entra em "DOTACAO" com status "IN_PROGRESS" e a timeline registra a migração

  Scenario: Tenant com customização recebe oferta, não imposição
    Given um tenant cuja versão publicada do padrão foi customizada
    When o seeder da v2 rodar
    Then é criada apenas a oferta "WorkflowSeedVersionOffered"
    When o administrador adotar a oferta
    Then surge uma nova versão "DRAFT" copiada da v2, sem alterar a versão publicada

  Scenario: Regra v1 continua avaliada com o contexto v1
    Given uma regra criada no MVP 1 com "contextVersion" 1
    When o motor avaliar a regra depois da publicação do contexto v2
    Then o resultado é o mesmo de antes da v2
```

## Métricas de sucesso
- 100% dos tenants sem customização com a v2 publicada ou a oferta resolvida (adotada ou dispensada).
- 0 regressões nas regras v1 após a publicação do contexto v2 (suíte de regras do MVP 1 verde).

## Riscos
- Ordem Jurídico e Controle Interno não confirmada pelo piloto — configurável por tenant e validada antes da adoção.
- Dependência "de volta" das regras de saída de quatro épicos — a v2 só é semeada quando US-148, US-155, US-161 e US-168 estão prontas.
- Vazamento de valor sigiloso pelo contexto — avaliação só no servidor e POL-09 em mensagens, eventos, auditoria e simulador.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
