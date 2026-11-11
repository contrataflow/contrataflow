---
id: EP-022
title: "Aprovação múltipla"
mvp: 2
priority: P0
features: [FT-066, FT-067]
status: Especificado
---

# EP-022 — Aprovação múltipla

## Título
Aprovação múltipla

## Objetivo
Permitir que uma aprovação seja decidida por mais de uma pessoa, com política explícita (`ANY`, `ALL` ou `SEQUENTIAL`), ordem de aprovadores, decisão por linha, redirecionamento e segregação de funções, sem alterar o comportamento do MVP 1 para quem continua com um aprovador. Dar prazo (`Approval.dueAt`) também às aprovações avulsas de documento (DT-17).

## Contexto e problema
- No MVP 1 a aprovação tem um aprovador resolvido e a política é implicitamente `ANY` (DEC-022). Ritos reais exigem mais de uma assinatura de decisão — ex.: Secretário e Procurador, ou cadeia hierárquica — e o sistema não os impõe.
- DEC-193 resolve a PEND-13: `Approval.decisionPolicy` e uma linha por aprovador em `ApprovalApprover`; na etapa, `WorkflowStage.decisionPolicy` e a lista ordenada `WorkflowStageApprover`. Com `ANY` e um aprovador, o MVP 1 continua idêntico; as aprovações existentes migram com uma linha (`sequence = 1`).
- Decisões sobre a mesma aprovação são serializadas por trava de linha; vale a primeira que efetivar. Não há quórum nem voto de minerva no MVP 2. Decisão registrada é imutável; devolução após votos favoráveis encerra a aprovação e reenviar cria nova `Approval` com todas as linhas.
- O art. 7º, § 1º da Lei 14.133/2021 sustenta a segregação de funções: `approval.preventSelfApproval` vale por linha, com substituto e, sem ele, `SELF_APPROVAL_FORBIDDEN`.
- DT-17 (DEC-209): o campo `approvalPolicy.slaDays` do `DocumentType` já existe e passa a calcular `Approval.dueAt` nas submissões avulsas.

## Escopo
- Configurar a política de decisão e os aprovadores ordenados na etapa `APPROVAL` do workflow (inclusive validação `WF_APPROVERS_INVALID`).
- Solicitar aprovação com várias linhas, decidir (votos, encerramento, concorrência), retirar a aprovação inteira e redirecionar uma linha ainda não decidida.
- Caixa de tarefas, lista e detalhe da aprovação com linhas, votos e vez do próximo aprovador; view `v_inbox_pending_approvals` v2.
- Prazo da aprovação avulsa pelo prazo do tipo de documento.

## Fora de escopo
- Quórum, voto de minerva e retirada de voto já dado.
- Alçada por valor (resolução de política ou aprovador por faixa) — EP-031 (US-198, que depende de US-133); aqui só a base (`decisionPolicyRules`, `WorkflowStageApprover.applicabilityRule` existem no modelo, preenchidos pela biblioteca de regras).
- Prazo por linha por política de SLA — EP-030 (`ApprovalApprover.dueAt`).
- Remoção das colunas legadas de aprovador em `approvals` (contract, M2-22) — fora do MVP 2.
- Aprovação do PCA em si — EP-023 (usa esta mecânica com `subjectType = PCA`).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Autoridade competente | `AUTORIDADE_COMPETENTE` (`APPROVAL_DECIDE`) | Decide a sua linha; vê o que falta |
| Aprovador / substituto | titular ou substituto designado | Decide dentro da segregação de funções |
| Gestor de contratações | `GESTOR_CONTRATACOES` (`PROCESS_ASSIGN`) | Redireciona linha ou retira a aprovação |
| Administrador do órgão | `ADMIN_ORGAO` (`WORKFLOW_MANAGE`) | Configura a política e a ordem dos aprovadores; prazo por tipo de documento |
| Solicitante | quem pede a aprovação | Acompanha votos e a vez de cada aprovador |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-066 | Políticas de decisão com múltiplos aprovadores | US-132, US-133, US-134, US-135, US-136 | P0 |
| FT-067 | Prazo das aprovações avulsas | US-137 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-132 ⏳ | Configurar política de decisão e aprovadores ordenados na etapa | P0 | M | 5 |
| US-133 ⏳ | Solicitar aprovação com múltiplos aprovadores | P0 | L | 8 |
| US-134 ⏳ | Decidir aprovação múltipla: votos, encerramento e concorrência | P0 | L | 8 |
| US-135 ⏳ | Redirecionar linha de aprovação e retirar aprovação múltipla | P0 | M | 5 |
| US-136 ⏳ | Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação | P0 | M | 5 |
| US-137 ⏳ | Prazo da aprovação avulsa por tipo de documento (DT-17) | P1 | S | 2 |
| **Total** | | | | **33** |

## Módulos e entidades
- Módulos: `approval` (dono), `workflow` (configuração da etapa); consumidos `process` (`ProcessAccess`, status), `inbox`, `notification`, `document` (`DocumentType`).
- Entidades: `ApprovalApprover` (dona, `approval`); `WorkflowStageApprover` (dona, `workflow`); `Approval` (alterada: `decisionPolicy`, espelho da linha corrente); `WorkflowStage` (alterada: `decisionPolicy`, `decisionPolicyRules`); `ProcessAccess` (`USER/APPROVER` por linha); `DocumentType.approvalPolicy` (consumida, DT-17).

## Telas
- SCR-034 — Workflow, ampliado (política de decisão e aprovadores) — `/admin/workflows/[id]`
- SCR-013/014/015 — Caixa de tarefas, aprovações e detalhe da aprovação, ampliados (linhas de aprovação) — `/tarefas`, `/aprovacoes`, `/aprovacoes/[id]`

## Integrações
- Internas: `process` (status `AWAITING_APPROVAL` até a decisão final), `inbox` (view v2), `notification`, `audit`, `analytics` (projeta `approval.*`).
- Nenhuma integração externa.

## Eventos principais
- `ApprovalRequested` (MVP 1, uso ampliado: uma linha `PENDING` por aprovador), `ApprovalVoteRecorded`, `ApprovalApproverActivated`, `ApprovalReassigned` (MVP 1, agora por linha)
- Eventos de decisão e retirada do MVP 1, com `approvalApproverId` e `decisionPolicy` nos metadados

## Permissões envolvidas
- `APPROVAL_DECIDE` — decidir a própria linha (POL-03 por linha).
- `APPROVAL_REASSIGN` — redirecionar linha (POL-17).
- `PROCESS_ASSIGN` — retirar a aprovação inteira (DEC-193).
- `APPROVAL_VIEW` — consultar linhas e votos.
- `WORKFLOW_MANAGE` — configurar política e aprovadores da etapa.

## Regras configuráveis
- `approval.preventSelfApproval` — segregação de funções, avaliada por linha.
- `WorkflowStage.decisionPolicy` / `WorkflowStageApprover` — política e ordem por etapa.
- `DocumentType.approvalPolicy.slaDays` (`slaType`) — prazo da aprovação avulsa (DT-17).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Aprovações `ALL`/`SEQUENTIAL` encerradas sem inconsistência de estado | 100% | Teste de invariante + `approval.*` |
| Conflitos de decisão resolvidos com `APPROVAL_NOT_PENDING`/`APPROVAL_LINE_NOT_PENDING` e sem dupla decisão | 100% | Auditoria `approval.decide` |
| Tempo mediano até o encerramento de aprovação múltipla | ≤ prazo configurado em 90% | Read model de indicadores (`approval.*`) |
| Aprovações avulsas com `dueAt` calculado quando o tipo tem prazo | 100% | `Approval.dueAt` |
| Aprovações do MVP 1 com comportamento idêntico após a migração | 100% | Testes de contrato (backfill M2-03) |

## Dependências
- **Depende de:** EP-007 (etapa `APPROVAL` e política do tipo de documento), EP-008 (tramitação), EP-009 (caixa de tarefas), EP-011 (documentos e submissão de aprovação).
- **Habilita:** EP-023 (aprovação do PCA), EP-025 a EP-027 (aprovação do edital na etapa `AUTORIZACAO_LICITACAO`), EP-031 (alçadas por valor, US-198 sobre US-133).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Corrida entre decisões simultâneas | Média | Alto | `SELECT … FOR UPDATE` na `Approval`; primeira vale, segunda recebe 409 |
| Leitores do MVP 1 quebram com `approverType` nulo | Média | Médio | Fase expand: colunas espelham a linha corrente; view v1 mantida até o contract |
| Aprovador fora do escopo ou autor do documento decide | Baixa | Alto | Segregação por linha, substituto, `SELF_APPROVAL_FORBIDDEN` |
| Backfill das aprovações existentes incorreto | Baixa | Alto | Lotes idempotentes por `(approval_id, sequence)` e relatório de reconciliação (M2-03) |
| Prazos de aprovação avulsa surpreendem usuários | Baixa | Baixo | Prazo só onde o tipo de documento já o configura; exibido na solicitação |

## Pontos em aberto
- IDs, contratos e erros dos endpoints de aprovação múltipla e do redirecionamento por linha serão fixados no `api.md` do MVP 2.
- Prazo por linha em etapas `APPROVAL` depende de política de SLA (EP-030) e não é entregue aqui.
- Aplicação das alçadas por valor sobre a política (US-198) fica no EP-031.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (`ALL`, `SEQUENTIAL`, redirecionamento, retirada, prazo avulso)
- [ ] Documentação e treinamento (guia do usuário) atualizados
