---
id: EP-008
title: "Tramitação"
mvp: 1
priority: P0
features: [FT-031, FT-032, FT-033, FT-034, FT-035]
status: Especificado
---

# EP-008 — Tramitação

## Título
Tramitação

## Objetivo
Permitir que o processo avance entre etapas do workflow com destinatário, prazo e documentos sempre explícitos — encaminhando, devolvendo, sendo assumido, atribuído e, quando a etapa exigir, aprovado, devolvido ou indeferido —, com histórico completo e imutável de cada passagem e detecção automática de atrasos, para que qualquer pessoa com visibilidade do processo saiba, a qualquer momento, quem está com ele, desde quando e com que prazo, e para que essa linha do tempo sirva de evidência em auditoria.

## Contexto e problema
- Base legal: Lei 14.133/2021, art. 7º, § 1º (segregação de funções na aprovação); o trâmite documentado e as aprovações formais sustentam a defesa do processo perante o TCU e o controle interno.
- Sem um motor único de tramitação, o rastro de "quem teve o processo, quando e por quê" fica disperso em despachos, e-mails e planilhas, dificultando a reconstrução da linha do tempo em auditoria e deixando a responsabilidade individual pouco clara dentro de cada unidade.
- Decisões centrais: DEC-013 (status macro do processo separado da etapa do workflow), DEC-014 (motor de workflow declarativo, com `ProcessStage`/`ProcessAssignment`/`ProcessMovement` como runtime), DEC-022 (aprovação genérica, resolvida no momento da solicitação), DEC-023 (princípio da custódia), DEC-024 (visibilidade de processos) e DEC-031 (prazos e calendário de dias úteis).
- Cada ação deste épico (encaminhar, devolver, assumir, atribuir, aprovar/devolver/indeferir, retirar/redirecionar) é uma transação atômica que grava um `ProcessMovement` imutável, atualiza a etapa e a atribuição ativa e, quando aplicável, cria ou resolve uma `Approval`.

## Escopo
- Encaminhamento do processo para a próxima etapa do workflow, com resolução de unidade, responsável, prazo e documentos destacados (FT-031).
- Devolução direta para uma etapa anterior já percorrida, com motivo obrigatório e sem alteração automática do status dos documentos (FT-032).
- Responsabilidade individual dentro da unidade: assumir (claim) e atribuir/reatribuir (FT-033).
- Aprovações: solicitação e resolução automática do aprovador, decisão (aprovar, devolver ou indeferir), retirada e redirecionamento de pendência (FT-034).
- Histórico completo de tramitações e cálculo de prazos em dias úteis, com aviso de vencimento próximo e detecção automática de atraso (FT-035).

## Fora de escopo
- Definição do grafo de workflow — etapas, transições e regras configuráveis — EP-007.
- Ciclo de vida, versionamento e completude do documento em si — EP-011.
- Agregação das pendências de cada pessoa em uma única caixa de tarefas — EP-009.
- Paralelismo de etapas e política de decisão com múltiplos aprovadores/sequenciais (DEC-022, PEND-13) — MVP 2.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Servidor custodiante | Responsável atual do processo ou membro da unidade que o detém | Encaminha, devolve e assume o processo |
| Gestor de contratações (`GESTOR_CONTRATACOES`) | Titular/substituto da unidade ou detentor de `PROCESS_ASSIGN` | Atribui e reatribui o responsável, acompanha prazos |
| Aprovador (titular, substituto ou perfil competente) | Designado para decidir uma aprovação | Decide, retira ou redireciona aprovações pendentes |
| Autoridade / controle interno | Fiscalização e auditoria | Consulta o histórico de tramitações como evidência de prazo e responsabilidade |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-031 | Encaminhamento | US-047 | P0 |
| FT-032 | Devolução | US-048 | P0 |
| FT-033 | Responsabilidade | US-049, US-050 | P0 |
| FT-034 | Aprovações | US-051, US-052, US-053 | P0 |
| FT-035 | Registro e prazos | US-054, US-055 | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-047 | Encaminhar processo | P0 | L | 8 |
| US-048 | Devolver processo | P0 | M | 5 |
| US-049 | Assumir processo recebido pela unidade | P0 | S | 2 |
| US-050 | Atribuir e reatribuir responsável | P0 | M | 5 |
| US-051 | Solicitar aprovação e resolver o aprovador | P0 | L | 8 |
| US-052 | Decidir aprovação (aprovar, devolver, indeferir) | P0 | L | 8 |
| US-053 | Retirar ou redirecionar aprovação pendente | P1 | M | 5 |
| US-054 | Histórico de tramitações | P0 | M | 5 |
| US-055 | Prazos em dias úteis e detecção de atrasos | P0 | M | 5 |
| **Total** | | | | **51** |

## Módulos e entidades
- Módulos: `process` (dono), `approval` (dono); `workflow`, `document`, `organization`, `identity`, `access`, `catalog`, `timeline`, `audit`, `notification`, `platform` (consumidos/compartilhados).
- Entidades: `ProcessStage`, `ProcessAssignment`, `ProcessMovement`, `ProcessAccess` (dono, módulo `process`); `Approval`, `ApprovalDocument` (dono, módulo `approval`); `Document`, `DocumentVersion`, `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule`, `Department`, `User`, `Holiday` (consumidas).

## Telas
- SCR-006 — Detalhe do processo (painel situacional + aba Tramitação)
- SCR-015 — Detalhe da aprovação
- SCR-103 — Encaminhar processo (painel lateral)
- SCR-104 — Devolver processo (diálogo)
- SCR-115 — Atribuir responsável / assumir (diálogo)

## Integrações
- Interna com `workflow` (EP-007: transições, regras `BLOCKING`/`WARNING` avaliadas sobre o `RuleContext` v1).
- Interna com `document` (EP-011: submissão e ciclo de vida dos documentos cobertos por etapa `APPROVAL`, DEC-017/DEC-018).
- Interna com `organization`/`identity` (titular, substituto, lotação e vínculos ativos usados na resolução de responsável e aprovador).
- Interna com `notification` (recebimento de processo, aprovação solicitada, prazo próximo/vencido).
- Nenhuma integração externa no MVP 1.

## Eventos principais
- `ProcessStageChanged` (especializações `ProcessForwarded`, `ProcessReturned`)
- `ProcessStatusChanged` (especializações `ProcessSuspended`/`ProcessResumed`, `ProcessCanceled`, `ProcessCompleted`)
- `ProcessAssigned`, `ProcessNumberAssigned`
- `ApprovalRequested`, `ApprovalCompleted`, `ApprovalReturned`, `ApprovalRejected`, `ApprovalCanceled`, `ApprovalReassigned`
- `ProcessStageDueSoon`, `ProcessStageOverdue`

## Permissões envolvidas
- `PROCESS_FORWARD`
- `PROCESS_RETURN`
- `PROCESS_CLAIM`
- `PROCESS_ASSIGN`
- `APPROVAL_VIEW`
- `APPROVAL_DECIDE`
- `APPROVAL_REASSIGN`
- `PROCESS_VIEW`
- `AUDIT_VIEW`

## Regras configuráveis
- `approval.preventSelfApproval` — impede que o autor de um documento coberto decida a própria aprovação (segregação de funções, art. 7º, § 1º).
- `deadlines.warnBeforeBusinessDays` — dias úteis de antecedência do aviso de vencimento próximo de etapa (padrão 2).
- `calendar.optionalHolidaysAreNonBusiness` — define se pontos facultativos contam como dia não útil no cálculo de prazo.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Etapas com responsável ou fila de unidade sempre identificável (sem lacuna de custódia) | 100% | `ProcessStage`/`ProcessAssignment` |
| Etapas que recebem `ProcessStageDueSoon` antes de atingir `ProcessStageOverdue` | 100% | Job `deadlines` |
| Solicitações de aprovação resolvidas sem `APPROVER_UNRESOLVED` | ≥ 95% | Auditoria `approval.request` |

## Dependências
- **Depende de:** EP-001 (processo, custódia e visibilidade — DEC-023/DEC-024), EP-007 (motor de workflow — transições e regras, DEC-014/ADR-005), EP-011 (ciclo de vida e versionamento do documento — DEC-017/DEC-018).
- **Habilita:** EP-002 DFD (a aprovação da demanda tramita pelas etapas e aprovações deste épico), EP-009 Caixa de tarefas (agrega as pendências de encaminhamento, assunção e aprovação geradas aqui), EP-014 Dashboard (indicadores de tramitação e prazo).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Aprovador não resolvido (unidade sem titular, perfil sem detentor no escopo exigido) bloquear o avanço do processo | Média | Alto | `APPROVER_UNRESOLVED` desfaz integralmente a transação de origem (RN-TRAM-49), mantendo o processo na etapa anterior até a configuração do aprovador ser corrigida |
| Múltiplas instâncias do worker duplicarem avisos de prazo (`ProcessStageDueSoon`/`ProcessStageOverdue`) | Baixa | Médio | Lock distribuído por ciclo do job `deadlines` (RN-TRAM-85) e idempotência por `dueSoonNotifiedAt`/`overdueNotifiedAt` |

## Pontos em aberto
- Nenhum ponto em aberto (lacunas registradas pelas stories do épico — ex.: detalhamento do schema de `ProcessMovement.metadata` e do contrato de prévia de transição em `PRC-08` — resolvidas nas fontes canônicas em 2026-10-07).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
