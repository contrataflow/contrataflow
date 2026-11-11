---
id: FT-072
title: "Dotação orçamentária"
epic: EP-024
mvp: 2
priority: P0
stories: [US-146, US-147, US-148]
status: Especificada
---

# FT-072 — Dotação orçamentária

## Título
Dotação orçamentária

## Épico
EP-024 — Dotação orçamentária

## Descrição
Na etapa `DOTACAO` do processo, o gestor ou a Contabilidade indicam a dotação: exercício, unidade orçamentária, programa de trabalho/ação, natureza da despesa, fonte de recursos e valor reservado (US-146). Um processo pode ter mais de uma dotação (mais de uma fonte ou exercício). A dotação nasce em rascunho.

A Contabilidade confirma a reserva informando o número e a data da reserva ou pré-empenho e anexando a evidência; a confirmação é ato humano e imutável salvo cancelamento, que exige motivo (US-147). A plataforma compara a soma das dotações `CONFIRMED` com o valor estimado do processo e aplica a regra de saída de `DOTACAO`: por padrão, só avança com cobertura total (BLOCKING), configurável para aviso (US-148). Cancelar uma dotação depois que o processo saiu da etapa gera aviso na timeline e para o responsável.

## Valor para o usuário e para o órgão
- A reserva orçamentária deixa de ser texto livre e passa a ter classificação, evidência e conferência com o valor estimado.
- O processo não segue sem recurso reservado, o que reduz devolução tardia do jurídico e do controle interno.
- Orçamento sigiloso permanece protegido.

## Personas
- Contabilidade (`CONTABILIDADE`) — indica, confirma e cancela.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — indica em rascunho e acompanha a cobertura.
- Planejamento (`PLANEJAMENTO`) — consulta a cobertura do valor estimado.
- Auditor (`AUDITOR`) — verifica evidências e cancelamentos.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-146 ⏳ | Indicar a dotação orçamentária do processo | P0 | M | US-001, US-013, US-097, US-104 |
| US-147 ⏳ | Confirmar a reserva com evidência e cancelar dotação | P0 | M | US-068, US-146 |
| US-148 ⏳ | Compatibilidade da dotação com o valor estimado e regra de saída da etapa | P0 | M | US-032, US-129, US-147 |

## Escopo
- Indicação, edição e exclusão lógica de dotação em `DRAFT`, com seleção nos catálogos `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE` e `FUNDING_SOURCE`.
- Confirmação com `reservationNumber`, `reservationDate` e evidência `AVAILABLE`.
- Cancelamento de dotação `DRAFT` e `CONFIRMED`, com motivo (>= 10 caracteres).
- Cálculo da cobertura: Σ `reservedAmount` das `CONFIRMED` ÷ valor estimado; exposição como `budget.coverageRatio` no `RuleContext` v2.
- Regra de saída padrão de `DOTACAO` (cobertura >= 1) com severidade `BLOCKING` ou `WARNING`.
- Máscara de valores para orçamento sigiloso e eventos sem valores.
- Painel de dotação na etapa `DOTACAO` (SCR-006) e tarefa na caixa (SCR-013).

## Fora de escopo
- Integração e consulta a sistemas contábeis; verificação automática do saldo (MVP 3).
- Empenho, liquidação e pagamento.
- Aprovação da dotação por mais de uma pessoa.
- Relatório consolidado de dotações (EP-028).

## Regras de negócio da feature
- RN-BUD-01 — `BudgetAllocation` pertence a um processo (1:N); exige exercício, unidade orçamentária, programa de trabalho/ação, natureza da despesa, fonte de recursos e valor reservado > 0 (DEC-198).
- RN-BUD-02 — Só a dotação em `DRAFT` pode ser editada; `CONFIRMED` é imutável salvo cancelamento (DEC-198).
- RN-BUD-03 — Confirmar exige número e data da reserva e evidência anexada e verificada (`AVAILABLE`); sem elas, `BUDGET_EVIDENCE_REQUIRED` (422) (DEC-198, POL-25).
- RN-BUD-04 — A mesma reserva (`reservationNumber` e exercício) não confirma duas dotações (DEC-198).
- RN-BUD-05 — Indicar e editar exigem `BUDGET_ALLOCATION_MANAGE`; confirmar e cancelar dotação confirmada exigem `BUDGET_ALLOCATION_CONFIRM`; ambas exigem custódia da etapa `DOTACAO` (ou titular ou substituto da unidade) e processo editável (POL-25; DEC-198).
- RN-BUD-06 — Cancelar exige motivo, recalcula a cobertura e, se o processo já passou de `DOTACAO`, registra aviso na timeline e notifica o responsável (DEC-198).
- RN-BUD-07 — Cobertura = Σ `reservedAmount` das dotações `CONFIRMED` ÷ `Process.estimatedValue` (DEC-032, DEC-198).
- RN-BUD-08 — A saída de `DOTACAO` exige `budget.coverageRatio >= 1` como regra `BLOCKING`; o tenant pode rebaixá-la para `WARNING` (`budget.coverageRuleSeverity`), com reconhecimento registrado (DEC-196, DEC-198).
- RN-BUD-09 — Com orçamento sigiloso, `reservedAmount` e a cobertura são mascarados (`null` e `masked: true`) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, na leitura e na escrita, nos indicadores e na simulação de regras; eventos e notificações não carregam valores (DEC-030, DEC-198, POL-09).
- RN-BUD-10 — A confirmação e o cancelamento são atos humanos; nenhuma regra ou integração confirma dotação sozinha (DEC-198).

## Telas
- SCR-006 — Detalhe do processo: painel de dotação na etapa `DOTACAO`.
- SCR-013 — Caixa de tarefas.
- SCR-041 — Configurações gerais: severidade da regra de cobertura.

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /processes/{id}/budget-allocations` — listar dotações e cobertura.
- `POST /processes/{id}/budget-allocations` — indicar dotação.
- `PATCH /budget-allocations/{allocationId}` — editar rascunho.
- `DELETE /budget-allocations/{allocationId}` — excluir rascunho.
- `POST /budget-allocations/{allocationId}/confirm` — confirmar a reserva com evidência.
- `POST /budget-allocations/{allocationId}/cancel` — cancelar com motivo.
- Endpoints do MVP 1 estendidos: `POST /processes/{id}/forward` (PRC-19) passa a avaliar a regra de saída de `DOTACAO`.

## Entidades
- `BudgetAllocation` — dotação, com `status` `DRAFT`, `CONFIRMED`, `CANCELED`.
- `CatalogItem` — `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`.
- `Attachment` (`targetType = BUDGET_ALLOCATION`) — evidência.
- `Process` e `ProcessStage` — valor estimado e etapa `DOTACAO`.

## Eventos
- `BudgetAllocationCreated` — dotação indicada (timeline, regras).
- `BudgetAllocationUpdated` — rascunho editado.
- `BudgetAllocationConfirmed` — reserva confirmada, com `coverageReached` (timeline, notificação, auditoria).
- `BudgetAllocationCanceled` — cancelamento (timeline, notificação, auditoria).

## Permissões
- `BUDGET_ALLOCATION_MANAGE` — indicar, editar e cancelar rascunho.
- `BUDGET_ALLOCATION_CONFIRM` — confirmar e cancelar confirmada (MFA, permissão sensível).
- `PROCESS_VIEW` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — leitura de valores.

## Dependências
- EP-021 — versão 2 do workflow e `RuleContext` v2 (US-129).
- US-032 (valor estimado), US-068 (anexos), US-013 (sigilo do orçamento).
- Catálogos orçamentários semeados e a unidade responsável pela etapa configurada.

## Critérios de aceite da feature
```gherkin
Feature: Dotação orçamentária do processo
  Scenario: Indicar, confirmar com evidência e avançar com cobertura total
    Given que o processo "0045/2026" está na etapa "DOTACAO" com valor estimado de 100.000,00
    When "Marcos", da Contabilidade, indicar duas dotações de 60.000,00 e 40.000,00 em fontes distintas
    And confirmar cada uma informando o número da reserva, a data e a evidência anexada
    Then a cobertura do valor estimado deve ser 100%
    And o processo deve poder avançar para a etapa seguinte

  Scenario: Cancelar a dotação depois da saída da etapa e proteger o sigilo
    Given que o processo "0045/2026" já saiu de "DOTACAO" e o orçamento é sigiloso
    When "Marcos" cancelar a dotação de 40.000,00 informando o motivo
    Then a cobertura deve ser recalculada e o responsável deve ser avisado na timeline
    And um usuário sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" deve ver o valor reservado mascarado
    And nenhum evento ou notificação deve conter valores
```

## Métricas de sucesso
- Tempo médio na etapa `DOTACAO` ≤ 3 dias úteis.
- 100% das dotações confirmadas com evidência.
- 0 valores sigilosos expostos em testes de tenant leak.

## Riscos
- Classificação diferente por órgão — catálogos configuráveis por tenant, semeados a validar com o piloto.
- Cancelamento posterior ao avanço do processo — aviso, recálculo e registro; sem devolução automática.
- Evidência falsa ou irrelevante — verificação do anexo, auditoria e conferência pelo Controle Interno.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
