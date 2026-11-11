# MVP 2 — Features e Stories (esqueleto canônico do backlog)

> **Documento canônico** de IDs, títulos, prioridades, estimativas, dependências e nomes de arquivo de todas as features e stories do MVP 2. Os cards detalhados ficam em [`../backlog/`](../backlog/README.md). Épicos: [epics.md](epics.md). Visão geral: [overview.md](overview.md).
> Numeração global contínua depois do MVP 1 (último EP-020, FT-062, US-122): **EP-021..EP-031 · FT-063..FT-090 · US-123..US-200**. Os cards de story escrevem a partir desta lista, **sem renumerar**; ⏳ na coluna Arquivo = card reservado ainda não escrito (o `pnpm docs:check` aceita a linha pendente e exige tirar a marca quando o arquivo existir).
> Estimativa: `XS` ≤ ½ dia · `S` 1–2 dias · `M` 3–5 dias · `L` 6–10 dias · `XL` > 10 dias (deve ser quebrada — nenhuma story do MVP 2 é XL). Pontos: XS = 1, S = 2, M = 5, L = 8, XL = 13.
> Prioridade no MVP 2: `P0` fecha a fase preparatória (workflow v2, aprovação múltipla, dotação, jurídico, controle interno, edital) · `P1` necessária ao release pelos critérios de saída do [roadmap §4.8](../product/roadmap.md#48-critérios-de-saída) (PCA, SLA, regras condicionais, indicadores e gargalos, backoffice, gov.br) e as IAs do parecer e do edital (assistivas, como o EP-020) · `P2` débitos DT-13..DT-16, que não bloqueiam.

Totais: **11 épicos · 28 features · 78 stories** (P0: 33 · P1: 41 · P2: 4) · **422 pontos**. Versão 1 da especificação, revisável depois do UAT do MVP 1 (DEC-192).

### Arquivos dos épicos
| Épico | Título | Área das regras (RN) | Módulo (DEC-040) | Arquivo |
|---|---|---|---|---|
| EP-021 | Workflow v2 | `WF2` | `workflow`, `process` | `epic-021-workflow-v2.md` |
| EP-022 | Aprovação múltipla | `APV` | `approval` | `epic-022-multi-approval.md` |
| EP-023 | PCA | `PCA` | `pca` | `epic-023-pca.md` |
| EP-024 | Dotação orçamentária | `BUD` | `budget` | `epic-024-budget-allocation.md` |
| EP-025 | Jurídico | `LGL` | `legal-review` | `epic-025-legal-review.md` |
| EP-026 | Controle Interno | `ICT` | `internal-control` | `epic-026-internal-control.md` |
| EP-027 | Edital | `TND` | `tender` | `epic-027-tender.md` |
| EP-028 | Indicadores e gargalos | `ANL` | `analytics` | `epic-028-analytics.md` |
| EP-029 | Plataforma e backoffice | `PLAT` | `tenancy`, `identity`, `access`, `audit`, `notification`, `document`, `inbox` | `epic-029-platform-backoffice.md` |
| EP-030 | SLA | `SLA` | `sla`, `notification` | `epic-030-sla.md` |
| EP-031 | Regras condicionais | `RULE` | `rules` | `epic-031-conditional-rules.md` |

Áreas RN novas, para não colidir com a numeração do MVP 1 (`RN-WF-*`, `RN-TRAM-*` etc. continuam valendo e não são renumeradas): as regras novas de cada story usam `RN-<área>-NN` a partir de 01.

---

## EP-021 — Workflow v2

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-063 Etapas paralelas | `PARALLEL_SPLIT`/`PARALLEL_JOIN`, ramos no runtime, caixa de tarefas, painel e prazos (DEC-194, DT-03) | `feature-063-parallel-stages.md` |
| FT-064 Migração entre versões de workflow | Plano, simulação obrigatória, decisões humanas e execução auditada (DEC-195, DT-02, ADR-016) | `feature-064-workflow-version-migration.md` |
| FT-065 Workflow padrão v2 e `RuleContext` v2 | Contexto de regras v2 por módulo, v2 do workflow padrão oferecida para adoção e continuação dos concluídos na v1 (DEC-196, DEC-204) | `feature-065-default-workflow-v2.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-123 | Modelar etapas paralelas no workflow (ramificação e junção) | FT-063 | P0 | L | US-040, US-043, US-045 | `story-123-parallel-stages-model.md` |
| US-124 | Executar ramos paralelos no processo | FT-063 | P0 | L | US-041, US-047, US-048, US-123 | `story-124-parallel-branches-runtime.md` |
| US-125 | Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos | FT-063 | P0 | M | US-004, US-055, US-056, US-124 | `story-125-parallel-branches-inbox-cockpit.md` |
| US-126 | Planejar a migração de processos: mapeamento de etapas e filtro | FT-064 | P0 | M | US-045 | `story-126-workflow-migration-plan.md` |
| US-127 | Simular a migração e decidir os processos que exigem decisão | FT-064 | P0 | L | US-041, US-124, US-126 | `story-127-workflow-migration-simulation.md` |
| US-128 | Executar a migração de forma assíncrona, idempotente e auditada | FT-064 | P0 | L | US-054, US-059, US-073, US-083, US-127 | `story-128-workflow-migration-execution.md` |
| US-129 | `RuleContext` v2: contrato versionado e provedores por módulo | FT-065 | P0 | M | US-041, US-044 | `story-129-rule-context-v2.md` |
| US-130 | Workflow padrão v2 da fase preparatória e oferta de adoção | FT-065 | P0 | M | US-042, US-045, US-129, US-148, US-155, US-161, US-168 | `story-130-default-workflow-v2.md` |
| US-131 | Levar à fase preparatória processos concluídos na v1 | FT-065 | P1 | M | US-128, US-130 | `story-131-completed-processes-to-v2.md` |

## EP-022 — Aprovação múltipla

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-066 Políticas de decisão com múltiplos aprovadores | `decisionPolicy` `ANY`/`ALL`/`SEQUENTIAL`, `ApprovalApprover`, decisão por linha, redirecionamento e visões (DEC-193, PEND-13, DT-03) | `feature-066-approval-decision-policies.md` |
| FT-067 Prazo das aprovações avulsas | `Approval.dueAt` nas submissões avulsas de documento, pelo prazo do `DocumentType` (DT-17) | `feature-067-approval-due-date-by-document-type.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-132 | Configurar política de decisão e aprovadores ordenados na etapa | FT-066 | P0 | M | US-040, US-043, US-045 | `story-132-stage-decision-policy.md` |
| US-133 | Solicitar aprovação com múltiplos aprovadores | FT-066 | P0 | L | US-051, US-132 | `story-133-multi-approver-request.md` |
| US-134 | Decidir aprovação múltipla: votos, encerramento e concorrência | FT-066 | P0 | L | US-052, US-133 | `story-134-multi-approver-decision.md` |
| US-135 | Redirecionar linha de aprovação e retirar aprovação múltipla | FT-066 | P0 | M | US-053, US-134 | `story-135-approval-line-redirect.md` |
| US-136 | Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação | FT-066 | P0 | M | US-056, US-057, US-134 | `story-136-multi-approval-inbox-views.md` |
| US-137 | Prazo da aprovação avulsa por tipo de documento (DT-17) | FT-067 | P1 | S | US-051, US-055, US-061 | `story-137-approval-due-date-by-document-type.md` |

## EP-023 — PCA

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-068 Elaboração do PCA | Plano por exercício, itens e importação por planilha (DEC-197) | `feature-068-pca-authoring.md` |
| FT-069 Aprovação e revisão do PCA | Aprovação pela autoridade (`ApprovalSubjectType` `PCA`) e revisão com nova versão | `feature-069-pca-approval-revision.md` |
| FT-070 Vínculo e reconciliação | `pcaItemId` em DFD e processo; reconciliação das referências textuais do MVP 1 (DEC-029) | `feature-070-pca-linking-reconciliation.md` |
| FT-071 Acompanhamento e divulgação | Execução do plano e exportação para divulgação (art. 12, § 1º) | `feature-071-pca-tracking-disclosure.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-138 | Criar o plano anual e manter os itens do PCA | FT-068 | P1 | L | US-097, US-102, US-104 | `story-138-pca-plan-items.md` ⏳ |
| US-139 | Importar itens do PCA por planilha | FT-068 | P1 | M | US-068, US-083, US-138 | `story-139-pca-spreadsheet-import.md` ⏳ |
| US-140 | Enviar o PCA para aprovação e decidir | FT-069 | P1 | M | US-051, US-052, US-138 | `story-140-pca-approval.md` ⏳ |
| US-141 | Revisar o PCA aprovado com nova versão | FT-069 | P1 | M | US-140 | `story-141-pca-revision.md` ⏳ |
| US-142 | Vincular DFD e processo a item do PCA | FT-070 | P1 | M | US-005, US-014, US-140 | `story-142-pca-item-linking.md` ⏳ |
| US-143 | Reconciliar as referências textuais ao PCA e conciliar manualmente | FT-070 | P1 | L | US-083, US-142 | `story-143-pca-reconciliation.md` ⏳ |
| US-144 | Acompanhar a execução do PCA | FT-071 | P1 | M | US-142 | `story-144-pca-execution-tracking.md` ⏳ |
| US-145 | Exportar o PCA para divulgação | FT-071 | P1 | S | US-083, US-140 | `story-145-pca-disclosure-export.md` ⏳ |

## EP-024 — Dotação orçamentária

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-072 Dotação orçamentária | Classificação, fonte, reserva com evidência, compatibilidade com o valor estimado e regra de saída de `DOTACAO` (DEC-198) | `feature-072-budget-allocation.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-146 | Indicar a dotação orçamentária do processo | FT-072 | P0 | M | US-001, US-013, US-097, US-104 | `story-146-budget-allocation-entry.md` ⏳ |
| US-147 | Confirmar a reserva com evidência e cancelar dotação | FT-072 | P0 | M | US-068, US-146 | `story-147-budget-allocation-confirmation.md` ⏳ |
| US-148 | Compatibilidade da dotação com o valor estimado e regra de saída da etapa | FT-072 | P0 | M | US-032, US-129, US-147 | `story-148-budget-compatibility-exit-rule.md` ⏳ |

## EP-025 — Jurídico

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-073 Fila jurídica priorizada | Abertura da análise na etapa `JURIDICO`, fila por critérios objetivos (art. 53, § 1º, I), distribuição e configuração (DEC-199) | `feature-073-legal-review-queue.md` |
| FT-074 Análise, diligência e parecer | Versões analisadas, diligência, parecer com ressalvas, situação conclusiva e dispensa (art. 53, § 5º) | `feature-074-legal-review-opinion.md` |
| FT-075 IA no parecer jurídico | Gerador `draft.legal_opinion` em cadeia, sem propor a conclusão (DEC-202) | `feature-075-ai-legal-opinion.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-149 | Abrir a análise jurídica e fila priorizada | FT-073 | P0 | L | US-047, US-097, US-104 | `story-149-legal-review-queue.md` ⏳ |
| US-150 | Distribuir análises na assessoria jurídica | FT-073 | P0 | S | US-050, US-149 | `story-150-legal-review-distribution.md` ⏳ |
| US-151 | Configurar critérios da fila e hipóteses de dispensa | FT-073 | P0 | M | US-103, US-104, US-149 | `story-151-legal-review-settings.md` ⏳ |
| US-152 | Conduzir a análise jurídica sobre versões exatas | FT-074 | P0 | M | US-066, US-149 | `story-152-legal-review-analysis.md` ⏳ |
| US-153 | Pedir diligência e retomar a análise | FT-074 | P0 | L | US-048, US-066, US-152 | `story-153-legal-review-diligence.md` ⏳ |
| US-154 | Elaborar o parecer jurídico e registrar ressalvas | FT-074 | P0 | M | US-065, US-110, US-152 | `story-154-legal-opinion-authoring.md` ⏳ |
| US-155 | Concluir a análise com a situação conclusiva | FT-074 | P0 | M | US-129, US-154 | `story-155-legal-review-conclusion.md` ⏳ |
| US-156 | Dispensar a análise jurídica por hipótese configurada | FT-074 | P0 | M | US-149, US-151 | `story-156-legal-review-waiver.md` ⏳ |
| US-157 | Gerar o rascunho do parecer jurídico com IA | FT-075 | P1 | L | US-115, US-116, US-122, US-154 | `story-157-ai-draft-legal-opinion.md` ⏳ |

## EP-026 — Controle Interno

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-076 Checklist do Controle Interno | Modelos de checklist configuráveis e versionados por tenant (DEC-200) | `feature-076-internal-control-checklist.md` |
| FT-077 Manifestação do Controle Interno | Painel com visão de riscos, checklist, achados e recomendações, manifestação e acompanhamento | `feature-077-internal-control-review.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-158 | Gerenciar checklists versionados do Controle Interno | FT-076 | P0 | M | US-097, US-103 | `story-158-internal-control-checklists.md` ⏳ |
| US-159 | Abrir a manifestação e painel do Controle Interno com visão de riscos | FT-077 | P0 | L | US-033, US-047, US-158 | `story-159-internal-control-panel.md` ⏳ |
| US-160 | Responder o checklist e registrar achados e recomendações | FT-077 | P0 | M | US-159 | `story-160-internal-control-checklist-findings.md` ⏳ |
| US-161 | Emitir a manifestação e concluir com a situação | FT-077 | P0 | M | US-065, US-110, US-129, US-160 | `story-161-internal-control-conclusion.md` ⏳ |
| US-162 | Acompanhar o atendimento dos achados | FT-077 | P1 | S | US-160 | `story-162-internal-control-findings-follow-up.md` ⏳ |

## EP-027 — Edital

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-078 Minuta do edital e do contrato | `Tender` com cabeçalho tipado, importação do TR, lotes, matriz de riscos (art. 22), minuta do contrato e conclusão (DEC-201) | `feature-078-tender-draft.md` |
| FT-079 IA no edital | Gerador `draft.tender` em cadeia a partir do TR (DEC-202) | `feature-079-ai-tender-draft.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-163 | Criar a minuta do edital com cabeçalho tipado | FT-078 | P0 | M | US-039, US-065, US-110 | `story-163-tender-draft-creation.md` ⏳ |
| US-164 | Importar itens, critérios e condições do TR para o edital | FT-078 | P0 | M | US-037, US-038, US-163 | `story-164-tender-tr-import.md` ⏳ |
| US-165 | Organizar os lotes do edital | FT-078 | P0 | M | US-006, US-163 | `story-165-tender-lots.md` ⏳ |
| US-166 | Matriz de alocação de riscos do edital | FT-078 | P1 | M | US-035, US-163 | `story-166-tender-risk-allocation.md` ⏳ |
| US-167 | Elaborar a minuta do contrato | FT-078 | P0 | M | US-038, US-163 | `story-167-contract-draft.md` ⏳ |
| US-168 | Concluir a minuta do edital | FT-078 | P0 | M | US-129, US-164, US-165, US-167 | `story-168-tender-draft-conclusion.md` ⏳ |
| US-169 | Gerar o rascunho do edital com IA | FT-079 | P1 | L | US-115, US-116, US-122, US-164 | `story-169-ai-draft-tender.md` ⏳ |

## EP-028 — Indicadores e gargalos

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-080 Read model de indicadores | Tabelas de fatos alimentadas pelo outbox, reconstrução noturna e visões materializadas (DEC-206, ADR-014) | `feature-080-analytics-read-model.md` |
| FT-081 Indicadores e relatórios | Relatórios (SCR-027), relatório detalhado (SCR-028), exportação e execução do PCA | `feature-081-indicators-reports.md` |
| FT-082 Gargalos | Tempo por etapa, unidade e responsável; filas, envelhecimento e comparação entre períodos | `feature-082-bottlenecks.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-170 | Alimentar o read model de indicadores pelos eventos | FT-080 | P1 | L | US-059, US-082, US-083 | `story-170-analytics-event-projection.md` ⏳ |
| US-171 | Reconstruir e reconciliar o read model | FT-080 | P1 | M | US-170 | `story-171-analytics-rebuild-reconciliation.md` ⏳ |
| US-172 | Relatórios de indicadores | FT-081 | P1 | L | US-013, US-097, US-171 | `story-172-indicator-reports.md` ⏳ |
| US-173 | Relatório detalhado com detalhamento por processo | FT-081 | P1 | M | US-172 | `story-173-detailed-report.md` ⏳ |
| US-174 | Exportar relatórios | FT-081 | P1 | M | US-073, US-083, US-172 | `story-174-report-export.md` ⏳ |
| US-175 | Indicadores de execução do PCA | FT-081 | P1 | S | US-144, US-172 | `story-175-pca-execution-indicators.md` ⏳ |
| US-176 | Análise de gargalos por etapa, unidade e responsável | FT-082 | P1 | L | US-171, US-172 | `story-176-bottleneck-analysis.md` ⏳ |
| US-177 | Filas, envelhecimento e comparação entre períodos | FT-082 | P1 | M | US-176 | `story-177-queues-aging-period-comparison.md` ⏳ |

## EP-029 — Plataforma e backoffice

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-083 Backoffice da plataforma | Provisionamento, ciclo de vida do tenant, acesso de suporte e saúde operacional (DEC-208, DT-07, DT-18) | `feature-083-platform-backoffice.md` |
| FT-084 Login gov.br | Fonte federada no Authentik, vínculo da identidade e habilitação por tenant (DEC-207, PEND-18, ADR-017) | `feature-084-govbr-login.md` |
| FT-085 Débitos técnicos do MVP 1 | DT-13 a DT-16 (DEC-209) | `feature-085-mvp1-debts.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-178 | Acesso ao backoffice e provisionamento de tenant e órgãos | FT-083 | P1 | L | US-087, US-090, US-099 | `story-178-backoffice-tenant-provisioning.md` ⏳ |
| US-179 | Ciclo de vida do tenant no backoffice | FT-083 | P1 | M | US-178 | `story-179-backoffice-tenant-lifecycle.md` ⏳ |
| US-180 | Conceder e encerrar acesso de suporte | FT-083 | P1 | M | US-073, US-178 | `story-180-support-access-grants.md` ⏳ |
| US-181 | Saúde operacional por tenant no backoffice | FT-083 | P1 | M | US-085, US-116, US-178 | `story-181-platform-health.md` ⏳ |
| US-182 | Entrar com gov.br via Authentik | FT-084 | P1 | L | US-087, US-103 | `story-182-govbr-login.md` ⏳ |
| US-183 | Vincular e desvincular a identidade gov.br | FT-084 | P1 | M | US-098, US-182 | `story-183-govbr-identity-link.md` ⏳ |
| US-184 | Habilitar o gov.br no órgão e nível de confiança na política de MFA | FT-084 | P1 | S | US-090, US-182 | `story-184-govbr-tenant-settings.md` ⏳ |
| US-185 | Reativar perfil desativado (DT-13) | FT-085 | P2 | S | US-095 | `story-185-role-reactivation.md` ⏳ |
| US-186 | Notificar a quebra do selo de auditoria (DT-14) | FT-085 | P2 | S | US-074, US-111 | `story-186-audit-seal-break-notification.md` ⏳ |
| US-187 | Atualizar a biblioteca padrão de templates com adoção assistida (DT-15) | FT-085 | P2 | M | US-108, US-110 | `story-187-template-library-update.md` ⏳ |
| US-188 | Limite configurável do lote da caixa de tarefas (DT-16) | FT-085 | P2 | XS | US-058, US-103 | `story-188-inbox-bulk-limit-setting.md` ⏳ |

## EP-030 — SLA

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-086 Políticas de SLA | `SlaPolicy` com aplicabilidade, prazos por etapa, pausas e escalonamento (DEC-205, ADR-015) | `feature-086-sla-policies.md` |
| FT-087 Regras de notificação | `NotificationRule`: evento + condição + destinatários + modelo de mensagem | `feature-087-notification-rules.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-189 | Cadastrar políticas de SLA | FT-086 | P1 | L | US-055, US-106, US-129 | `story-189-sla-policies.md` |
| US-190 | Aplicar a política de SLA ao processo e calcular prazos | FT-086 | P1 | M | US-047, US-189 | `story-190-sla-policy-application.md` |
| US-191 | Pausar e retomar prazos | FT-086 | P1 | M | US-008, US-153, US-190 | `story-191-sla-pauses.md` |
| US-192 | Escalonar prazos em degraus | FT-086 | P1 | M | US-114, US-190 | `story-192-sla-escalation.md` |
| US-193 | Regras de notificação condicional | FT-087 | P1 | M | US-083, US-111, US-112, US-129 | `story-193-notification-rules.md` |

## EP-031 — Regras condicionais

| Feature | Descrição | Arquivo |
|---|---|---|
| FT-088 Biblioteca de regras | `RuleDefinition`/`RuleDefinitionVersion`, uso nos workflows por versão fixada e modelos prontos (DEC-204, SCR-035) | `feature-088-rule-library.md` |
| FT-089 Roteamento condicional e alçadas | Etapa dispensada por aplicabilidade, transição condicional e alçadas por valor | `feature-089-conditional-routing-thresholds.md` |
| FT-090 Simulador e testes de regras | Processo hipotético, casos de teste salvos e bloqueio da publicação | `feature-090-rule-simulator-tests.md` |

| Story | Título | Feature | Prio | Est | Depende de | Arquivo |
|---|---|---|---|---|---|---|
| US-194 | Biblioteca de regras reutilizáveis com versões | FT-088 | P1 | L | US-044, US-129 | `story-194-rule-library.md` |
| US-195 | Usar regras da biblioteca nos workflows por versão fixada | FT-088 | P1 | M | US-045, US-194 | `story-195-library-rules-in-workflows.md` |
| US-196 | Modelos prontos de regras | FT-088 | P1 | S | US-194 | `story-196-rule-templates.md` |
| US-197 | Roteamento condicional: etapa dispensada e transição condicional | FT-089 | P1 | L | US-041, US-047, US-195 | `story-197-conditional-routing.md` |
| US-198 | Alçadas por valor | FT-089 | P1 | M | US-133, US-195 | `story-198-value-thresholds.md` |
| US-199 | Simular regras com processo hipotético | FT-090 | P1 | M | US-194 | `story-199-rule-simulator.md` |
| US-200 | Casos de teste de regra e bloqueio da publicação | FT-090 | P1 | M | US-199 | `story-200-rule-test-cases.md` |

---

## Totais por épico

| Épico | Features | Stories | P0 | P1 | P2 | Pontos |
|---|---|---|---|---|---|---|
| EP-021 Workflow v2 | 3 | 9 | 8 | 1 | 0 | 57 |
| EP-022 Aprovação múltipla | 2 | 6 | 5 | 1 | 0 | 33 |
| EP-023 PCA | 4 | 8 | 0 | 8 | 0 | 43 |
| EP-024 Dotação orçamentária | 1 | 3 | 3 | 0 | 0 | 15 |
| EP-025 Jurídico | 3 | 9 | 8 | 1 | 0 | 51 |
| EP-026 Controle Interno | 2 | 5 | 4 | 1 | 0 | 25 |
| EP-027 Edital | 2 | 7 | 5 | 2 | 0 | 38 |
| EP-028 Indicadores e gargalos | 3 | 8 | 0 | 8 | 0 | 46 |
| EP-029 Plataforma e backoffice | 3 | 11 | 0 | 7 | 4 | 48 |
| EP-030 SLA | 2 | 5 | 0 | 5 | 0 | 28 |
| EP-031 Regras condicionais | 3 | 7 | 0 | 7 | 0 | 38 |
| **Total** | **28** | **78** | **33** | **41** | **4** | **422** |

## Notas de priorização e dependências

- **Primeiros cards da implementação (DEC-192):** DT-03 = US-123..US-125 (etapas paralelas) e US-132..US-136 (aprovação múltipla); DT-02 = US-126..US-128 (migração entre versões). O restante do MVP 2 depende deles.
- **US-129 (`RuleContext` v2)** vem cedo: as regras de saída das etapas novas (US-148, US-155, US-161, US-168), o SLA (US-189), as regras de notificação (US-193) e a biblioteca (US-194) leem os namespaces `budget.*`, `legalReview.*`, `internalControl.*`, `tender.*`, `pca.*` e `sla.*`. Cada story de módulo publica o provedor do seu namespace; US-129 fixa o contrato e o mecanismo.
- **US-130 (workflow padrão v2)** fecha a fase preparatória: depende das regras de saída de dotação, jurídico, controle interno e edital. Os módulos não dependem da v2 semeada — testam com versões de workflow próprias de teste.
- **Exceções à regra de prioridade, com motivo:** US-131 (levar à v2 os concluídos na v1) é P1 porque a fase preparatória dos processos novos fecha sem ela; US-137 (DT-17) é P1 porque não é débito da lista P2 da DEC-209 e afeta prazos de aprovação; US-157 e US-169 (IA) são P1 como o EP-020; US-162 (acompanhamento dos achados) e US-166 (matriz de riscos, "quando aplicável" — art. 22) são P1.
- **Sem ciclos:** toda dependência aponta para story de número menor, exceto US-130, que depende de US-148, US-155, US-161 e US-168 (nenhuma delas depende de US-130). Todas as dependências do MVP 1 apontam para stories entregues ou especificadas no MVP 1 (US-001..US-122).

## Apêndice A — Telas do MVP 2

Telas reservadas do roadmap (§4.3 e §8) e telas complementares `SCR-118+` (fora das 41). Rotas web em pt-BR (DEC-001). Rotas e layout finais ficam em [screens.md](screens.md) (card 9 da especificação); os IDs abaixo são canônicos.

| ID | Tela | Rota indicativa | Stories principais |
|---|---|---|---|
| SCR-018 | PCA (plano, itens, aprovação, execução, reconciliação) | `/pca` e `/pca/[pcaId]` | US-138 a US-145 |
| SCR-019 | Jurídico (fila priorizada e painel de análise) | `/juridico` e `/juridico/[reviewId]` | US-149 a US-157 |
| SCR-020 | Controle Interno (fila e manifestação com visão de riscos) | `/controle-interno` e `/controle-interno/[reviewId]` | US-159 a US-162 |
| SCR-021 | Edital (minuta do edital e do contrato) | `/processos/[id]/edital/[tenderId]` | US-163 a US-169 |
| SCR-027 | Relatórios | `/relatorios` | US-172, US-174, US-175 |
| SCR-028 | Relatório detalhado e gargalos | `/relatorios/[relatorio]` | US-173, US-176, US-177 |
| SCR-035 | Regras (biblioteca completa e simulador) | `/admin/regras` e `/admin/regras/[ruleId]` | US-194 a US-200 |
| SCR-006 | Detalhe do processo — ampliado (ramos paralelos, dotação, edital, parecer, manifestação, vínculo ao PCA) | `/processos/[id]` | US-125, US-142, US-146 a US-148 |
| SCR-013/014/015 | Caixa de tarefas, aprovações e detalhe da aprovação — ampliados (ramos, linhas de aprovação) | `/tarefas`, `/aprovacoes`, `/aprovacoes/[id]` | US-125, US-136 |
| SCR-034 | Workflow — ampliado (paralelismo, política de decisão, adoção da v2) | `/admin/workflows/[id]` | US-123, US-130, US-132 |
| SCR-118 | Migração de processos entre versões de workflow | `/admin/workflows/[id]/migracoes/[migrationId]` | US-126 a US-128, US-131 |
| SCR-119 | Checklists do Controle Interno | `/admin/controle-interno/checklists` | US-158 |
| SCR-120 | Configuração da análise jurídica (critérios da fila e hipóteses de dispensa) | `/admin/juridico` | US-151 |
| SCR-121 | Políticas de SLA | `/admin/prazos` | US-189 a US-192 |
| SCR-122 | Regras de notificação | `/admin/notificacoes/regras` | US-193 |
| SCR-123 | Backoffice da plataforma (tenants, ciclo de vida, acesso de suporte, saúde) | `/plataforma` (área separada) | US-178 a US-181 |
