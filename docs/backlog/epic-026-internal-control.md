---
id: EP-026
title: "Controle Interno"
mvp: 2
priority: P0
features: [FT-076, FT-077]
status: Especificado
---

# EP-026 — Controle Interno

## Título
Controle Interno

## Objetivo
Dar ao Controle Interno uma etapa própria e rastreável na fase preparatória: manifestação formal sobre o processo, com checklist configurável pelo órgão, achados e recomendações classificados por criticidade e uma visão de riscos que reúne o mapa de riscos e os avisos `WARNING` superados durante a tramitação. A manifestação é um documento versionado e o atendimento dos achados é acompanhado até o fim. A autoridade decide com tudo isso à vista, sem que o sistema decida por ela.

## Contexto e problema
- O art. 169, II, da Lei 14.133/2021 coloca o controle interno na segunda linha de defesa das contratações. Hoje a manifestação acontece fora do sistema, em documento solto, sem checklist padronizado e sem ligação com os riscos e alertas que o processo já registrou.
- O MVP 1 já registra a ciência dos avisos `WARNING` superados (L-08) e mantém o mapa de riscos. Falta reuni-los numa visão única para quem manifesta, e falta um lugar para o achado e a recomendação virarem itens rastreáveis.
- DEC-200 define as entidades do módulo `internal-control` (`InternalControlReview`, `InternalControlChecklist`, `InternalControlFinding`) e que a manifestação é um `Document` do tipo `MANIFESTACAO_CONTROLE_INTERNO` (`SystemDocumentModule.INTERNAL_CONTROL_REPORT`). A mecânica de abertura, rodadas e retomada espelha a da análise jurídica (DEC-199, EP-025).
- A manifestação **não é vinculante** (mesma lógica do parecer desfavorável): `NON_COMPLIANT` não bloqueia o processo por si; seguir adiante exige motivação registrada da autoridade na aprovação seguinte (POL-23). O que bloqueia é a saída da etapa sem a manifestação concluída (`internalControl.concluded = true`).
- **Sem IA no MVP 2** para a manifestação (DEC-200; o prd-7 não a pediu). O perfil `CONTROLE_INTERNO` continua sem `AI_GENERATE`.
- O conteúdo do checklist é um dos itens "a validar com o piloto" (overview §7): entra como padrão semeado `FASE_PREPARATORIA` v1, editável por tenant, nunca fixo em código (princípio 17).

## Escopo
- Modelos de checklist versionados por tenant (rascunho, publicado, aposentado), com aplicabilidade por regra e um modelo padrão (US-158).
- Abertura automática da manifestação na entrada em `CONTROLE_INTERNO`, com o checklist publicado fixado na abertura, e painel SCR-020 com a visão de riscos (US-159).
- Resposta do checklist item a item (`COMPLIANT`, `NON_COMPLIANT`, `NOT_APPLICABLE`), evidências, achados com criticidade e recomendações (US-160).
- Manifestação como documento (`MANIFESTACAO_CONTROLE_INTERNO`), conclusão com a situação (`COMPLIANT`, `COMPLIANT_WITH_RECOMMENDATIONS`, `NON_COMPLIANT`) e regra de saída da etapa (US-161).
- Acompanhamento do atendimento dos achados: resposta de quem detém a custódia, risco aceito pela autoridade na autorização, cancelamento pelo Controle Interno antes da conclusão (US-162).
- Fila do Controle Interno (SCR-020) e rascunho restrito da manifestação (POL-24).

## Fora de escopo
- IA para a manifestação do Controle Interno (não pedida; reavaliar no MVP 5 com o assistente contextual).
- Bloqueio automático do processo por `NON_COMPLIANT` ou por achado aberto: a decisão é humana e motivada.
- Auditoria interna ou externa do órgão fora do processo (o Auditor continua com leitura, sem manifestar).
- Integração com sistemas estaduais de prestação de contas aos tribunais (L-15, depois do MVP 3).
- Ordem das etapas Jurídico e Controle Interno e regra de roteamento condicional (EP-021 e EP-031); este épico só entrega a etapa e a regra de saída.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Controle interno | `CONTROLE_INTERNO` | Manifestar-se com checklist e visão de riscos, registrar achados e recomendações, concluir |
| Administrador do órgão | `ADMIN_ORGAO` | Manter os checklists do órgão (criar, publicar, aposentar versões) |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Ler a manifestação e motivar a decisão quando houver `NON_COMPLIANT` ou achado grave aberto |
| Planejamento e área requisitante | `PLANEJAMENTO`, `REQUISITANTE` | Responder aos achados e atender recomendações |
| Auditor | `AUDITOR` | Rastrear manifestações, achados e a motivação das decisões |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-076 | Checklist do Controle Interno | US-158 ⏳ | P0 |
| FT-077 | Manifestação do Controle Interno | US-159 ⏳, US-160 ⏳, US-161 ⏳, US-162 ⏳ | P0 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-158 ⏳ | Gerenciar checklists versionados do Controle Interno | P0 | M | 5 |
| US-159 ⏳ | Abrir a manifestação e painel do Controle Interno com visão de riscos | P0 | L | 8 |
| US-160 ⏳ | Responder o checklist e registrar achados e recomendações | P0 | M | 5 |
| US-161 ⏳ | Emitir a manifestação e concluir com a situação | P0 | M | 5 |
| US-162 ⏳ | Acompanhar o atendimento dos achados | P1 | S | 2 |
| **Total** | | | | **25** |

## Módulos e entidades
- Módulos: `internal-control` (novo); leitura de `process`, `risk`, `workflow` e `legal-review`; `document` (manifestação); transversais `timeline`, `notification` e `audit`.
- Entidades: `InternalControlChecklist`, `InternalControlReview`, `InternalControlChecklistAnswer` e `InternalControlFinding` (donos `internal-control`; entities.md §4.4); `Document` do tipo `MANIFESTACAO_CONTROLE_INTERNO` (consumida); `Risk` (consumida, `riskId` do achado); `Attachment` com `targetType = INTERNAL_CONTROL_REVIEW` (papéis de trabalho; entities.md §5.11).

## Telas
- SCR-020 — Controle Interno (fila e manifestação com visão de riscos), `/controle-interno` e `/controle-interno/[reviewId]`.
- SCR-119 — Checklists do Controle Interno (`/admin/controle-interno/checklists`), tela complementar fora das 41.

## Integrações
- Internas: `workflow` (`StageLifecycleListener` abre a manifestação na entrada em `CONTROLE_INTERNO`; `RuleContext` v2 com o namespace `internalControl.*`), `document` (versões e PDF da manifestação), `risk` (mapa de riscos e avisos superados), `legal-review` (parecer considerado), outbox e relay, `NotificationDispatcher`, `TimelineProjector`.
- Nenhuma integração externa.

## Eventos principais
- `InternalControlReviewOpened`, `InternalControlReviewStarted`, `InternalControlFindingRecorded`, `InternalControlFindingResolved`, `InternalControlReviewConcluded`, `InternalControlReviewCanceled`, `InternalControlChecklistPublished`.
- `DocumentFinalized` do tipo `MANIFESTACAO_CONTROLE_INTERNO` (nome especializado `InternalControlReportIssued`).

## Permissões envolvidas
- `INTERNAL_CONTROL_REVIEW_VIEW` (fila e painel), `INTERNAL_CONTROL_REVIEW_MANAGE` (responder, achados, editar a manifestação), `INTERNAL_CONTROL_REVIEW_CONCLUDE` (concluir), `INTERNAL_CONTROL_CHECKLIST_MANAGE` (checklists).
- `PROCESS_VIEW` (ler a manifestação concluída), `APPROVAL_DECIDE` (autoridade na etapa `AUTORIZACAO_LICITACAO`).
- Políticas: POL-20 (segregação e escopo da manifestação), POL-23 (motivação na autorização), POL-24 (rascunho restrito).

## Regras configuráveis
- `internalControl.defaultChecklistKey` — chave do checklist padrão do tenant (padrão `FASE_PREPARATORIA`).
- `InternalControlChecklist.applicabilityRule` e `isDefault` — qual checklist se aplica a cada processo (por exemplo, por modalidade).
- Regra de saída da etapa `CONTROLE_INTERNO` (`internalControl.concluded = true`, `BLOCKING`) e aviso `internalControl.openFindingsHighOrCritical > 0` na autorização — editáveis na versão do workflow.
- Template do documento `MANIFESTACAO_CONTROLE_INTERNO` — seções e orientações por órgão.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Manifestações concluídas dentro do prazo da etapa | ≥ 85% | Read model de indicadores (`AnalyticsStageFact`, etapa `CONTROLE_INTERNO`) |
| Manifestações com checklist 100% respondido na conclusão | 100% | `InternalControlChecklistAnswer` × `InternalControlReview` |
| Achados `HIGH`/`CRITICAL` atendidos ou com risco aceito motivado antes da autorização | ≥ 95% | `InternalControlFinding.status` e `Approval.decisionComment` |
| Devoluções da autoridade por manifestação incompleta | Redução ≥ 30% frente ao processo sem checklist | Movimentos `RETURN` da etapa `AUTORIZACAO_LICITACAO` |
| Tempo médio de manifestação | ≤ 5 dias úteis | `InternalControlReview.startedAt` × `concludedAt` |

## Dependências
- **Depende de:** EP-005 (mapa de riscos que alimenta a visão), EP-008 (tramitação e etapas), EP-011 (documentos e versões), EP-016 e EP-017 (permissões e configurações), EP-018 (templates); EP-021 (`RuleContext` v2 e a etapa `CONTROLE_INTERNO` no workflow).
- **Habilita:** EP-021 (a v2 semeada só sai com a regra de saída da US-161), EP-028 (desfecho da manifestação nos fatos de processo), EP-031 (regras sobre `internalControl.*`).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Práticas de controle muito diferentes entre órgãos | Alta | Médio | Checklist versionado e configurável; padrão semeado a validar com o piloto |
| `NON_COMPLIANT` tratado como bloqueio e o processo travar | Média | Alto | Parecer não vinculante: avisos `WARNING` com motivação da autoridade (POL-23); só a conclusão da manifestação bloqueia a saída |
| Rascunho da manifestação vazar antes de finalizado | Baixa | Alto | POL-24 (leitura só de quem manifesta e do Auditor) com testes de autorização |
| Visão de riscos exibir valor de orçamento sigiloso a quem não pode | Baixa | Alto | POL-09 aplicada na visão; teste de tenant leak e de autorização |
| Ordem Jurídico × Controle Interno diferente da semeada | Média | Baixo | Ordem configurável por versão do workflow (DEC-194, DEC-196); a manifestação lê o parecer vigente quando existir |

## Pontos em aberto
- Itens e agrupamentos do checklist padrão `FASE_PREPARATORIA`: "a validar com o piloto" (overview §7), semeados e editáveis, não são pendência.
- Layout da SCR-119 (checklists do Controle Interno) e da SCR-020 fica no `screens.md` do MVP 2 (card 9).
- IDs e contratos de API das operações listadas nas features: fixados no `api.md` do MVP 2 (card 9).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (abrir → responder → achados → concluir → autorizar com motivação)
- [ ] Testes de autorização das POL-20 e POL-24 e de tenant leak da manifestação e dos achados
- [ ] Documentação e treinamento (guia do usuário) atualizados
