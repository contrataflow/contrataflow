---
id: FT-076
title: "Checklist do Controle Interno"
epic: EP-026
mvp: 2
priority: P0
stories: [US-158]
status: Especificada
---

# FT-076 — Checklist do Controle Interno

## Título
Checklist do Controle Interno

## Épico
EP-026 — Controle Interno

## Descrição
Modelos de checklist configuráveis e versionados por tenant (DEC-200). Cada modelo tem uma chave lógica (`key`, por exemplo `FASE_PREPARATORIA`), um número de versão e uma lista de itens (`ChecklistItem`): grupo, pergunta, base legal, obrigatoriedade, dica de evidência e, opcionalmente, uma regra de sugestão de resposta (`autoCheck`) calculada sobre o `RuleContext` v2.

A versão nasce em rascunho, é publicada e passa a ser imutável; mudanças viram uma nova versão. Cada manifestação fixa a versão publicada no momento da abertura, de modo que alterar o modelo depois não muda uma análise em curso. Um modelo pode ter regra de aplicabilidade (por exemplo, por modalidade) e um deles é o padrão do tenant. O tenant recebe o modelo `FASE_PREPARATORIA` v1 semeado, com itens sobre DFD, ETP, pesquisa de preços (art. 23), mapa de riscos, TR, dotação, edital, parecer e avisos `WARNING` superados (a validar com o piloto).

## Valor para o usuário e para o órgão
- O órgão passa a ter o seu roteiro de verificação em vez de um modelo único e fixo.
- Todo processo é analisado pelos mesmos critérios, o que reduz variação entre analistas e devoluções por omissão.
- Mudanças de critério ficam datadas e auditáveis, sem reescrever o que já foi analisado.

## Personas
- Administrador do órgão (`ADMIN_ORGAO`) — cria, publica e aposenta versões.
- Controle interno (`CONTROLE_INTERNO`) — também gerencia os modelos (matriz de permissões do MVP 2).
- Auditor (`AUDITOR`) — consulta as versões e o histórico.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-158 ⏳ | Gerenciar checklists versionados do Controle Interno | P0 | M | US-097, US-103 |

## Escopo
- Listar, criar, duplicar, editar rascunho, publicar e aposentar versões de `InternalControlChecklist`.
- Itens com grupo, pergunta, base legal, obrigatoriedade, dica de evidência e `autoCheck` opcional; de 1 a 200 itens.
- Regra de aplicabilidade e marcação de modelo padrão (um só publicado por tenant).
- Pré-visualização do modelo como será respondido.
- Semente `FASE_PREPARATORIA` v1 por tenant, incluindo tenants existentes, respeitando customizações.
- Seleção da chave padrão em `internalControl.defaultChecklistKey`.

## Fora de escopo
- Responder o checklist em uma manifestação (FT-077).
- Importar ou exportar checklists entre tenants.
- Checklist para outras etapas (Jurídico, dotação).

## Regras de negócio da feature
- RN-ICT-01 — Versão `PUBLISHED` ou `RETIRED` é imutável (trigger no banco); só mudam `status` e a data de aposentadoria (DEC-200).
- RN-ICT-02 — Há no máximo um rascunho por chave e um único modelo padrão publicado por tenant; publicar um novo padrão exige aposentar ou desmarcar o anterior (DEC-200).
- RN-ICT-03 — O modelo tem de 1 a 200 itens, com `key` única dentro do modelo; `autoCheck` apenas **sugere** a resposta, nunca a grava (DEC-200).
- RN-ICT-04 — Publicar exige ao menos um item obrigatório e validação das regras de `autoCheck` e de aplicabilidade contra o `RuleContext` v2 (DEC-200, DEC-204).
- RN-ICT-05 — Aposentar uma versão não afeta manifestações abertas, que mantêm a versão fixada na abertura (DEC-200).
- RN-ICT-06 — Criar, publicar e aposentar exigem `INTERNAL_CONTROL_CHECKLIST_MANAGE` (permissão `HIGH`, com MFA) e geram auditoria de configuração (DEC-200).

## Telas
- SCR-119 — Checklists do Controle Interno (`/admin/controle-interno/checklists`).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /internal-control/checklists` — listar modelos e versões do tenant.
- `POST /internal-control/checklists` — criar modelo ou nova versão em rascunho.
- `GET /internal-control/checklists/{id}` — ler uma versão.
- `PATCH /internal-control/checklists/{id}` — editar o rascunho.
- `POST /internal-control/checklists/{id}/publish` — publicar a versão.
- `POST /internal-control/checklists/{id}/retire` — aposentar a versão.
- `POST /internal-control/checklists/{id}/preview` — pré-visualizar com um processo opcional (sugestões de `autoCheck`).

## Entidades
- `InternalControlChecklist` — modelo versionado (dono).
- `ChecklistItem` — esquema dos itens em `items` (entities.md §7.6).
- `TenantSetting` `internalControl.defaultChecklistKey` — chave padrão.

## Eventos
- `InternalControlChecklistPublished` — ao publicar uma versão (auditoria `internal_control_checklist.publish`).
- Auditoria `internal_control_checklist.create` e `internal_control_checklist.retire` — sem evento de domínio próprio.

## Permissões
- `INTERNAL_CONTROL_CHECKLIST_MANAGE` — gerenciar modelos; sem escopo de unidade.
- `INTERNAL_CONTROL_REVIEW_VIEW` — consultar o modelo aplicado na manifestação (fora da administração).

## Dependências
- US-097 (autorização no API e no frontend) e US-103 (configurações do tenant).
- DEC-200 (modelo) e DEC-204 (`RuleContext` v2 para `autoCheck` e aplicabilidade).
- Semeadura incremental por tenant (entities.md §9).

## Critérios de aceite da feature
```gherkin
Feature: Checklist versionado do Controle Interno
  Scenario: Publicar uma nova versão sem alterar a análise em curso
    Given que o tenant tem o checklist "FASE_PREPARATORIA" v1 publicado e padrão
    And existe uma manifestação em análise que fixou a v1
    When "Marta" (administradora) criar a v2 em rascunho, acrescentar um item obrigatório e publicá-la
    Then a v2 deve ficar publicada e a v1 aposentada
    And a manifestação em análise deve continuar com os itens da v1
    And a próxima manifestação aberta deve usar a v2
    And a publicação deve constar na auditoria com a chave e o número da versão

  Scenario: Versão publicada não é editável
    Given um checklist publicado
    When "Marta" tentar alterar um item
    Then o sistema deve recusar a alteração e orientar a criar nova versão
```

## Métricas de sucesso
- 100% das manifestações abertas com um checklist publicado fixado.
- Publicar uma versão em até 3 cliques a partir da duplicação da anterior.

## Riscos
- Modelo padrão rígido demais para o órgão — o conteúdo é semeado e editável, e é validado com o piloto no UAT.
- Regra de `autoCheck` mal escrita induzir resposta errada — só sugere, a resposta é sempre humana, e a publicação valida a regra.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
