---
id: EP-031
title: "Regras condicionais"
mvp: 2
priority: P1
features: [FT-088, FT-089, FT-090]
status: Especificado
---

# EP-031 — Regras condicionais

## Título
Regras condicionais

## Objetivo
Permitir que o administrador do órgão escreva uma regra uma vez, teste e reutilize em vários workflows, e use regras para decidir o caminho do processo: dispensar etapa que não se aplica, escolher transição por condição e definir quem decide por faixa de valor. Tudo com simulador e casos de teste antes de publicar, sem código e sem risco para os processos em andamento.

## Contexto e problema
- No MVP 1 as regras (`WorkflowRule`: `REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`) são escritas uma a uma dentro de cada versão de workflow, sobre o `RuleContext` v1, e só **bloqueiam** a saída da etapa (ADR-008, DEC-016). O MVP 2 pede regras que **alteram o roteamento** ("valor acima de X exige Controle Interno"), alçadas por valor, uma biblioteca reutilizável (SCR-035), simulador e testes (roadmap §4.2).
- A DEC-204 cria a biblioteca no módulo `rules` (`RuleDefinition` e `RuleDefinitionVersion` imutável), os tipos novos de uso (roteamento, alçada, SLA, notificação), o `RuleContext` v2 (superset da v1) e o simulador estendido a processo hipotético e a casos salvos. O executor continua sendo o único avaliador JSON Logic com *allowlist* da ADR-008: nova função, não nova linguagem ([ADR-015](../adr/adr-015-rules-engine-sla-notifications.md)).
- Workflows referenciam a regra da biblioteca por **versão fixada** (mesma lógica da DEC-014): editar a regra cria nova versão e não altera workflows publicados. Regras v1 continuam com o contexto v1 e não migram à força.
- Risco central (roadmap §4.10): regras complexas demais para administradores. Mitigações: modelos prontos, simulador, casos de teste obrigatórios no roteamento e nas alçadas.
- Etapas legalmente obrigatórias (`isLegallyRequired`, ex.: `JURIDICO` na licitação) não aceitam regra de dispensa (POL-27).

## Escopo
- Biblioteca de regras (SCR-035, `/admin/regras`): `RuleDefinition` por tipo (`VALIDATION`, `ROUTING`, `APPROVAL_THRESHOLD`, `SLA`, `NOTIFICATION`), versões com `contextVersion`, publicação e aposentadoria.
- Uso nos workflows por `RuleRef` em modo `LIBRARY` (versão fixada na publicação do workflow) ou `INLINE`; `WorkflowRule.ruleDefinitionVersionId`.
- Roteamento: `WorkflowStage.applicabilityRule` (etapa `SKIPPED` automaticamente, com registro na timeline e no `ProcessMovement`) e `WorkflowTransition.condition`.
- Alçadas: `WorkflowStage.decisionPolicyRules` e `WorkflowStageApprover.applicabilityRule` por faixa de valor, sobre a política de decisão do EP-022.
- Modelos prontos semeados (`isSystem`): `COBERTURA_DOTACAO`, `CI_ACIMA_DE_VALOR`, `ALCADA_AUTORIDADE_POR_VALOR`, `SLA_PREGAO`, `NOTIFICAR_GESTOR_PRAZO_VENCIDO`.
- Simulador (processo real visível ou contexto hipotético) e casos de teste salvos por versão; publicação recusada com o diff quando um caso falha.

## Fora de escopo
- Encadeamento de regras (uma regra disparando outra) e tabelas de decisão DMN — critérios de revisão da ADR-015.
- Código arbitrário, acesso direto ao banco ou funções fora da *allowlist*.
- Políticas de SLA e regras de notificação em si (EP-030); aqui só o tipo na biblioteca.
- Política de decisão `ANY`/`ALL`/`SEQUENTIAL` e aprovação múltipla (EP-022).
- Migração de processos entre versões de workflow (EP-021).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Administrador do órgão | `ADMIN_ORGAO` | Escrever, testar, publicar e reutilizar regras; ajustar alçadas e roteamento sem suporte |
| Controle interno | `CONTROLE_INTERNO` | Ler a biblioteca e entender por que uma etapa foi ou não dispensada |
| Auditor | `AUDITOR` | Rastrear qual versão de regra decidiu o caminho de um processo |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Saber por que o processo seguiu por um caminho e quem decide a alçada |
| Operador da plataforma | Suporte | Conferir modelos semeados e a *allowlist* |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-088 | Biblioteca de regras | US-194, US-195, US-196 | P1 |
| FT-089 | Roteamento condicional e alçadas | US-197, US-198 | P1 |
| FT-090 | Simulador e testes de regras | US-199, US-200 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-194 | Biblioteca de regras reutilizáveis com versões | P1 | L | 8 |
| US-195 | Usar regras da biblioteca nos workflows por versão fixada | P1 | M | 5 |
| US-196 | Modelos prontos de regras | P1 | S | 2 |
| US-197 | Roteamento condicional: etapa dispensada e transição condicional | P1 | L | 8 |
| US-198 | Alçadas por valor | P1 | M | 5 |
| US-199 | Simular regras com processo hipotético | P1 | M | 5 |
| US-200 | Casos de teste de regra e bloqueio da publicação | P1 | M | 5 |
| **Total** | | | | **38** |

## Módulos e entidades
- Módulos: `rules` (novo, dono da biblioteca e do simulador); `workflow` (referências, validação do grafo na publicação); `process` (execução da dispensa e da transição); `approval` (resolução por alçada); leitura de `pca`, `budget`, `legal-review`, `internal-control`, `tender` e `sla` pelo `RuleContext` v2.
- Entidades: `RuleDefinition`, `RuleDefinitionVersion` (dono `rules`); `WorkflowStage` (`applicabilityRule`, `decisionPolicyRules`, `isLegallyRequired`), `WorkflowTransition` (`condition`), `WorkflowRule` (`ruleDefinitionVersionId`, `contextVersion`), `WorkflowVersion` (`ruleRefs`); `ProcessStage` (`SKIPPED`), `ProcessMovement` (`SKIP`). Estruturas: `RuleRef`, `RuleContext` v2, `RuleTestCase` ([entities.md §7.1–7.3](../mvp-02/entities.md)).

## Telas
- SCR-035 — Regras: biblioteca completa e simulador (`/admin/regras` e `/admin/regras/[ruleId]`).
- SCR-034 — Workflow (seletor de regra da biblioteca, aplicabilidade, condição de transição e faixas de alçada).
- SCR-006 — Detalhe do processo (etapa dispensada e motivo na linha do tempo).

## Integrações
- Internas: executor JSON Logic com *allowlist* (ADR-008), montador de `RuleContext` v2 (`RuleContextContributor` de cada módulo), outbox e timeline. Sem integração externa.

## Eventos principais
- `RuleVersionPublished`, `RuleVersionRetired`, `ProcessStageSkipped`; consumidos: `WorkflowVersionPublished` (MVP 1) para fixar `ruleRefs`.

## Permissões envolvidas
- `RULE_VIEW`, `RULE_MANAGE`, `RULE_PUBLISH` (risco H, POL-27); `WORKFLOW_MANAGE` e `WORKFLOW_PUBLISH` (MVP 1) para usar regras no workflow; `PROCESS_VIEW` no simulador com processo real; `PROCESS_VIEW_CONFIDENTIAL_BUDGET` para ver valores sigilosos no simulador (POL-09).

## Regras configuráveis
- Etapas `isLegallyRequired` (semeadas) — não aceitam `applicabilityRule`.
- `budget.coverageRuleSeverity` e `tender.riskMatrixValueThreshold` — valores lidos pelos modelos de regra.
- Matriz de perfis (`RULE_*`) e o valor-limite do modelo `CI_ACIMA_DE_VALOR`, configurável por tenant.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Regras da biblioteca usadas em mais de um workflow | ≥ 30% das regras ativas | `WorkflowVersion.ruleRefs` |
| Versões de regra de roteamento e alçada publicadas com casos de teste verdes | 100% | `RuleDefinitionVersion.testRunHash` |
| Etapas dispensadas por regra sem reclamação de erro (devolução por "pulo indevido") | ≥ 95% | `ProcessStageSkipped` × movimentos `RETURN` |
| Tempo de criação de uma regra a partir de modelo | ≤ 10 min | Auditoria da publicação |
| Publicações recusadas por teste falhando que evitaram regra errada | Acompanhar (sem meta) | `RULE_TESTS_FAILING` |

## Dependências
- **Depende de:** EP-007 (workflow e regras do MVP 1), EP-008 (tramitação); EP-021 (`RuleContext` v2, US-129, e a publicação de workflows v2); EP-022 (alçadas sobre a política de decisão).
- **Habilita:** EP-030 (regras de SLA e de notificação na biblioteca); EP-026 e EP-027 (regras de saída e de aplicabilidade dos módulos novos).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Regras complexas demais para administradores | Alta | Médio | Modelos prontos, simulador, casos de teste obrigatórios, revisão por especialista sugerida na publicação (ADR-015) |
| Dispensa indevida de etapa obrigatória por lei | Baixa | Alto | `isLegallyRequired` bloqueia `applicabilityRule` na publicação (`RULE_NOT_ALLOWED_ON_LEGAL_STAGE`) |
| Dispensa parece "pulo" para o usuário | Média | Médio | Evento, linha do tempo e movimento `SKIP` com regra e versão, visíveis no detalhe do processo |
| Contexto v2 grande aumenta o custo de avaliação | Média | Baixo | Montagem preguiçosa por namespace, cache por requisição |
| Vazamento de valor sigiloso pelo simulador | Baixa | Alto | Mascaramento sem POL-09; valor nunca em mensagem, evento ou auditoria |
| Tenants que customizaram o workflow padrão | Média | Médio | Regras da biblioteca são adotadas por escolha; nada é imposto (roadmap §4.10) |

## Pontos em aberto
- Modelos de regra semeados e valores-limite sugeridos: "a validar com o piloto" (entities.md §9).
- Contratos de API do simulador (extensão da WF-23) e layout do SCR-035: fixados no `api.md` e no `screens.md` do MVP 2.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (criar regra → testar → publicar → usar no workflow → processo dispensa etapa e roteia por valor)
- [ ] Regras v1 do MVP 1 continuam avaliadas com o contexto v1 (teste de regressão)
- [ ] Documentação e treinamento (guia do administrador) atualizados
