---
id: EP-007
title: "Workflow"
mvp: 1
priority: P0
features: [FT-028, FT-029, FT-030]
status: Especificado
---

# EP-007 — Workflow

## Título
Workflow

## Objetivo
Dar a cada órgão um fluxo de trabalho configurável e versionado para a fase preparatória da contratação — com um workflow padrão já pronto para uso imediato, um motor de regras determinístico que decide o que pode avançar, e um editor próprio para adaptar ou criar novos fluxos — sem depender de código para mudar o rito de contratação.

## Contexto e problema
- A Lei 14.133/2021 (art. 18) exige uma sequência de atos na fase preparatória (formalização da demanda, ETP, pesquisa de preços, TR, aprovações), mas o rito exato varia por órgão, por modalidade (ex.: dispensa/inexigibilidade seguem o rito simplificado do art. 72) e evolui com o tempo (nova legislação, reorganização interna).
- Hoje, sem workflow configurável, o rito vive em manuais e na cabeça dos servidores; exigências como "ETP completo antes da aprovação da autoridade" não são impostas pelo sistema.
- DEC-014 define o motor de workflow como próprio, declarativo e versionado (não um motor de terceiros); DEC-015 fixa o conteúdo do workflow padrão semeado; DEC-016 define regras parametrizáveis em JSON Logic sobre um `RuleContext` versionado; DEC-084 estende a snapshots imutáveis com hash também à definição de workflow publicada.
- O processo fixa a versão do workflow na criação (DEC-014) para que mudanças futuras nunca alterem, "por baixo", as regras de um processo já em andamento.

## Escopo
- Modelo declarativo versionado: `Workflow` → `WorkflowVersion` (`DRAFT`→`PUBLISHED`→`RETIRED`) → `WorkflowStage`/`WorkflowTransition`/`WorkflowRule`, com validação completa do grafo e imutabilidade após publicar.
- Motor de execução puro e somente leitura: ações disponíveis (`getAvailableActions`) e avaliação de regras (`evaluateRules`) sobre a versão publicada fixada no processo.
- Dois workflows semeados e publicados no provisionamento do tenant (padrão da fase preparatória e contratação direta art. 72), com resolução automática por aplicabilidade.
- Editor visual (etapas, transições), painel de regras com teste (dry-run), publicação/versionamento/aposentadoria e diagrama somente leitura.

## Fora de escopo
- Execução da tramitação em si (encaminhar, devolver, aprovar) — EP-008 Tramitação, que **consome** este motor antes de aceitar qualquer transição.
- Paralelismo de etapas e aprovação sequencial/múltipla — MVP 2+ (DEC-014, DEC-022).
- Migração de processos em andamento para uma nova versão publicada — postergado (DEC-014).
- Edição visual de posição dos nós do diagrama — US-046 é somente leitura com layout automático.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` (`WORKFLOW_MANAGE`/`WORKFLOW_PUBLISH`) | Cria, edita, testa, publica e aposenta workflows e regras |
| Gestor de contratações | `GESTOR_CONTRATACOES` (`WORKFLOW_MANAGE`) | Colabora na configuração do fluxo e das regras |
| Responsável/colaborador de etapa | qualquer perfil com `PROCESS_VIEW` | Consome o motor (ações disponíveis, checklist) no painel do processo |
| Perfis de consulta (Planejamento, Compras, Licitações, Controle Interno, Autoridade, Auditor) | `WORKFLOW_VIEW` | Consultam etapas, regras e diagrama sem editar |
| Sistema de provisionamento | ator `SYSTEM` | Executa o seeder dos workflows padrão ao criar o tenant |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-028 | Motor de workflow | US-040, US-041 | P0 |
| FT-029 | Workflow padrão e aplicabilidade | US-042 | P0 |
| FT-030 | Administração de workflows | US-043, US-044, US-045, US-046 | P1/P2 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-040 | Modelo de definição de workflow versionado | P0 | L | 8 |
| US-041 | Motor de execução: ações disponíveis e avaliação de regras | P0 | L | 8 |
| US-042 | Workflow padrão e seleção por aplicabilidade | P0 | M | 5 |
| US-043 | Editor de workflow (etapas e transições) | P1 | L | 8 |
| US-044 | Regras de etapa e de transição | P1 | M | 5 |
| US-045 | Publicar, versionar e aposentar workflow | P1 | M | 5 |
| US-046 | Visualizar diagrama do workflow | P2 | M | 5 |
| **Total** | | | | **44** |

## Módulos e entidades
- Módulos: `workflow` (dono); consumido por `process`, `document` (leitura), `access` (permissões), `platform` (outbox/idempotência), `audit`.
- Entidades: `Workflow`, `WorkflowVersion`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule` (dono); `ProcessStage`, `ProcessAssignment`, `ProcessMovement` (consumidas, só leitura, pertencem ao módulo `process`); `DocumentType` (consumida, referenciada por `REQUIRED_DOCUMENT`).

## Telas
- SCR-034 — Workflow (lista e editor) — `/admin/workflows` e `/admin/workflows/[id]` (abas Etapas, Transições, Versões, Diagrama)
- SCR-035 — Regras (painel de regras do workflow) — `/admin/workflows/[id]/regras`

## Integrações
- Interna: módulo `process` (consome `WorkflowFacade` antes de aceitar qualquer transição; fixa `workflowVersionId` na criação do processo — EP-001); módulo `document` (tipos de documento referenciados por regras e por etapas); módulo `access` (autorização por `WORKFLOW_*`); `audit`/`platform` (auditoria e outbox dos eventos).
- Externa: nenhuma (motor e editor são 100% internos; sem dependência de serviço de terceiros).

## Eventos principais
- `WorkflowCreated`
- `WorkflowVersionPublished`
- `WorkflowVersionRetired`
- `WorkflowDefaultChanged`

## Permissões envolvidas
- `WORKFLOW_VIEW`
- `WORKFLOW_MANAGE`
- `WORKFLOW_PUBLISH`

## Regras configuráveis
- Nenhuma chave de configuração própria do módulo `workflow` no MVP 1; a única configuração que afeta o épico é a de plataforma `security.mfaPolicy` (pode exigir MFA para `WORKFLOW_PUBLISH`, risco `H`).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Processos criados sem workflow aplicável (`NO_APPLICABLE_WORKFLOW`) | 0% dos tenants provisionados | Logs/métricas de `WF-06` (US-042) |
| Latência p95 de `getAvailableActions`/`evaluateRules` | < 300 ms | Métricas do motor (US-041) |
| Versões publicadas com snapshot e hash gravados | 100% | Auditoria `workflow.version_publish` (US-045) |
| Publicações bloqueadas por erro de grafo detectadas antes de afetar processos | 100% | `WF-20`/`WF-21` (US-045) |

## Dependências
- **Depende de:** EP-011 Documentos (tipos de documento usados por `REQUIRED_DOCUMENT`, `documentTypeCodes` e `approvalDocumentTypeCodes`); EP-017 Tenant e estrutura organizacional (provisionamento/seeder, RLS, unidades para `departmentResolution`/`approverDepartmentResolution`, catálogo `MODALITY` para a aplicabilidade do rito de contratação direta).
- **Habilita:** EP-001 Processo de contratação (fixa a versão do workflow na criação e usa a etapa inicial); EP-008 Tramitação (consome o motor de execução antes de qualquer encaminhamento/devolução/aprovação).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Workflow publicado com etapa inalcançável ou sem saída, travando processos em produção | Média | Alto | Validação de grafo obrigatória e bloqueante antes de publicar (`WF_*`, US-040/US-045) |
| Regra `CONDITION` mal configurada (operador perigoso ou lógica incorreta) aprovando/bloqueando processos indevidamente | Média | Alto | Allowlist de operadores (DEC-016) + "Testar regra" contra processo real antes de publicar (US-044) |
| Degradação de performance do motor sob muitos processos simultâneos avaliando regras | Baixa | Médio | Motor somente leitura e puro, com cache em memória por `workflowVersionId` imutável (US-041) |
| Administrador aposenta a versão corrente sem substituta, impedindo criação de novos processos | Baixa | Alto | Bloqueio `WORKFLOW_IN_USE` (US-045, RN-WF-66) |

## Pontos em aberto
- PEND-02 — destino da transição `REJECT` de etapas `APPROVAL` (hoje sempre a etapa de origem — RN-WF-13, US-040); avaliar se deve ser configurável em versão futura.
- Lacunas de implementação específicas (códigos `WF_*` em api.md, rota de descarte de rascunho, endpoint de teste de regra) estão registradas nas seções "Dependências → Lacunas nas fontes canônicas" de US-040 e US-044; nenhum identificador provisório foi criado neste épico.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
