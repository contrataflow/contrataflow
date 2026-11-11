---
id: EP-024
title: "Dotação orçamentária"
mvp: 2
priority: P0
features: [FT-072]
status: Especificado
---

# EP-024 — Dotação orçamentária

## Título
Dotação orçamentária

## Objetivo
Registrar na plataforma a indicação da dotação orçamentária do processo e a confirmação da reserva pela Contabilidade, com evidência anexada, e impedir que o processo saia da etapa `DOTACAO` sem dotação confirmada que cubra o valor estimado. A confirmação é sempre um ato humano; a plataforma não consulta sistemas contábeis no MVP 2.

## Contexto e problema
- A indicação de recursos orçamentários é exigência da fase preparatória (art. 18, e art. 72, IV, na contratação direta; art. 150 veda contratar sem créditos orçamentários). Hoje os órgãos contornam a etapa com uma tarefa genérica e um documento de texto livre (contorno do roadmap §3.2), sem classificação estruturada nem verificação contra o valor estimado.
- A DEC-196 posiciona `DOTACAO` na versão 2 do workflow padrão, depois de `APROVACAO_AUTORIDADE` e antes de `MINUTA_EDITAL` e `JURIDICO`. A saída exige `BudgetAllocation` `CONFIRMED` cobrindo o valor estimado (BLOCKING).
- A DEC-198 define `BudgetAllocation` por processo (1:N), com classificação em catálogos novos (unidade orçamentária, programa de trabalho/ação, natureza da despesa, fonte de recursos), valor reservado, número e data da reserva e evidência.
- Sem tela dedicada entre as 41 do MVP 1: a dotação ocorre como etapa no detalhe do processo (SCR-006) e na caixa de tarefas (SCR-013).
- Sigilo do orçamento (DEC-030, POL-09): o valor reservado é mascarado para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, inclusive em eventos, notificações e indicadores.

## Escopo
- Módulo `budget` e entidade `BudgetAllocation` com ciclo `DRAFT`, `CONFIRMED`, `CANCELED`.
- Catálogos `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE` e `FUNDING_SOURCE` semeados "a validar com o piloto".
- Indicação em rascunho pelo gestor ou pela Contabilidade (US-146).
- Confirmação da reserva com número, data e evidência; cancelamento com motivo (US-147).
- Compatibilidade: Σ dotações `CONFIRMED` x valor estimado, exposta no `RuleContext` v2 como `budget.coverageRatio`; regra de saída padrão da etapa `DOTACAO`, com severidade configurável (US-148).
- Regras do épico: `RN-BUD-NN`.

## Fora de escopo
- Integração com sistemas contábeis e consulta de saldo (adapters do MVP 3).
- Empenho, liquidação e pagamento; execução orçamentária do contrato.
- Reserva em lote para vários processos ou controle de saldo da dotação ao longo do exercício.
- IA para a dotação; assistência à classificação orçamentária.
- Tela dedicada de dotações (a visão consolidada, se pedida, vem com o EP-028).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Contabilidade | `CONTABILIDADE` | Indicar, confirmar com evidência e cancelar dotações |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Indicar a dotação em rascunho e acompanhar a cobertura do valor estimado |
| Planejamento | `PLANEJAMENTO` | Saber se o valor estimado está coberto antes de seguir |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Verificar evidência, confirmação e cancelamentos |
| Administrador do órgão | `ADMIN_ORGAO` | Manter catálogos orçamentários e a severidade da regra de cobertura |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-072 | Dotação orçamentária | US-146, US-147, US-148 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-146 | Indicar a dotação orçamentária do processo | P0 | M | 5 |
| US-147 | Confirmar a reserva com evidência e cancelar dotação | P0 | M | 5 |
| US-148 | Compatibilidade da dotação com o valor estimado e regra de saída da etapa | P0 | M | 5 |
| **Total** | | | | **15** |

## Módulos e entidades
- Módulos:
  - `budget` (novo), dono de `BudgetAllocation`;
  - `process` e `workflow`, pela etapa `DOTACAO` e pela regra de saída (`RuleContext` v2);
  - `catalog` e `files` (evidência), `tenancy`, e os transversais `timeline`, `notification`, `audit` e `platform`.
- Entidades: `BudgetAllocation` (dono `budget`); `CatalogItem` com os tipos `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`; `Attachment` com `targetType = BUDGET_ALLOCATION`; enum `BudgetAllocationStatus`.

## Telas
- SCR-006 — Detalhe do processo: painel de dotação na etapa `DOTACAO`.
- SCR-013 — Caixa de tarefas: tarefa da etapa `DOTACAO`.
- SCR-041 — Configurações gerais: severidade da regra de cobertura; catálogos orçamentários na administração de catálogos.

## Integrações
- Nenhuma externa: dados digitados com evidência anexada (DEC-198). Consulta a sistemas contábeis fica para os adapters do MVP 3.
- Internas: armazenamento de arquivos (verificação do anexo), `RuleContext` v2 (EP-021), outbox e `NotificationDispatcher`.

## Eventos principais
- `BudgetAllocationCreated`, `BudgetAllocationUpdated`, `BudgetAllocationConfirmed`, `BudgetAllocationCanceled` (payloads sem valores).

## Permissões envolvidas
- `BUDGET_ALLOCATION_MANAGE` (indicar, editar e cancelar rascunho) e `BUDGET_ALLOCATION_CONFIRM` (confirmar e cancelar dotação confirmada), ambas sob a POL-25.
- `PROCESS_VIEW` e `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (leitura de valores; POL-09).
- Padrão: `CONTABILIDADE` é o único perfil com `BUDGET_ALLOCATION_CONFIRM`; o gestor indica mas não confirma.

## Regras configuráveis
- `budget.coverageRuleSeverity` — severidade da regra de cobertura (`BLOCKING` padrão ou `WARNING`).
- Catálogos orçamentários do tenant (unidade, ação, natureza, fonte), semeados a validar.
- Unidade responsável pela etapa `DOTACAO` (unidade fixa configurada, `CHOSEN_ON_FORWARD` até o administrador configurar — DEC-196).
- Matriz de perfis para as permissões `BUDGET_ALLOCATION_*`.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo médio na etapa `DOTACAO` | ≤ 3 dias úteis | `ProcessStage` da etapa `DOTACAO` |
| Devoluções à `DOTACAO` por cobertura insuficiente ou evidência ausente | ≤ 10% dos processos | Movimentos `RETURN` com motivo, `BudgetAllocationCanceled` |
| Processos que saem de `DOTACAO` com cobertura total | 100% (regra BLOCKING padrão) | `BudgetAllocationConfirmed` (`coverageReached`) |
| Dotações confirmadas com evidência | 100% | Auditoria `budget_allocation.confirm` |
| Valores sigilosos expostos | 0 | Testes de tenant leak e de serialização |

## Dependências
- **Depende de:**
  - EP-001 e EP-004 — processo e catálogos;
  - EP-011 — anexos e verificação;
  - EP-016 e EP-017 — permissões e configurações;
  - EP-021 — versão 2 do workflow e `RuleContext` v2 (`budget.coverageRatio`);
  - US-032 (valor estimado do processo, pesquisa de preços).
- **Habilita:** EP-025 e EP-026 (o parecer e a manifestação conferem a dotação); EP-027 (insumo do edital); EP-028 (indicadores, com mascaramento).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Classificação orçamentária varia entre órgãos | Alta | Médio | Catálogos por tenant, semeados e configuráveis; validação no UAT |
| Dotação digitada incorreta ou sem lastro | Média | Alto | Evidência obrigatória e verificada para confirmar; ato humano; auditoria; cancelamento com motivo |
| Cancelamento da dotação depois que o processo passou de `DOTACAO` | Média | Alto | Recalcular a cobertura, avisar o responsável e registrar na timeline; sem devolução automática |
| Vazamento do valor reservado de processo sigiloso | Baixa | Alto | POL-09 por linha; eventos e notificações sem valores; testes de tenant leak |
| Mesma reserva usada em duas dotações | Média | Médio | Unicidade por `(tenant, reservationNumber, fiscalYear)` em dotações confirmadas |

## Pontos em aberto
- Semeadura dos catálogos `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE` e `FUNDING_SOURCE` e a classificação do órgão: "a validar com o piloto" (roadmap §4.7, DEC-198).
- Ordem das etapas (`DOTACAO` depois da aprovação dos artefatos e antes do jurídico — L-04, DEC-196): a validar com o jurídico do piloto.
- Contratos de API e layout do painel de dotação na etapa: a fixar no `api.md` e nas telas do MVP 2 (card 9).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (eventos `BudgetAllocation*`, `ProcessStage` e auditoria)
- [ ] Testes E2E da jornada (indicar, confirmar com evidência, cobertura, avançar; cancelar depois da saída)
- [ ] Testes de sigilo do orçamento e de tenant leak passando
- [ ] Regra de saída padrão da etapa `DOTACAO` coberta na versão 2 do workflow semeada
- [ ] Documentação e treinamento (guia da Contabilidade) atualizados
