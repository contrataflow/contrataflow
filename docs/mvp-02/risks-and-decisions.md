# MVP 2 — Riscos, Débitos Técnicos, Decisões e Pontos em Aberto

> Fechamento do MVP 2: riscos do roadmap com a mitigação detalhada; riscos técnicos, legais, de segurança, de multi-tenancy e de performance; débitos técnicos assumidos (DT-21+); pontos ambíguos; decisões de produto pendentes; lacunas de especificação; regras configuráveis; integrações; decisões de arquitetura; validação para iniciar o MVP 3.
> Decisões canônicas: [decisions.md](../architecture/decisions.md#mvp-2--governança-e-controle) (DEC-192 a DEC-210). Plano: [delivery-plan.md](delivery-plan.md). Release: [release-checklist.md](release-checklist.md). Os riscos e débitos do [MVP 1](../mvp-01/risks-and-decisions.md) continuam valendo; os IDs aqui continuam a numeração global (RT-13+, RL-11+, RS-13+, RM-09+, RP-10+, DT-21+, A-38+).
> **Versão 1, revisável depois do UAT do MVP 1** (DEC-192).

Sumário: [1. Riscos do roadmap](#1-riscos-do-roadmap-410-com-mitigação-detalhada) · [2. Riscos técnicos](#2-riscos-técnicos) · [3. Riscos legais](#3-riscos-legais-e-regulatórios) · [4. Segurança](#4-riscos-de-segurança) · [5. Multi-tenancy](#5-riscos-de-multi-tenancy) · [6. Performance](#6-riscos-de-performance) · [7. Débitos técnicos](#7-débitos-técnicos-assumidos) · [8. Pontos ambíguos](#8-pontos-ambíguos-do-pedido-e-interpretação-adotada) · [9. Decisões de produto](#9-regras-que-precisam-de-decisão-de-produto) · [10. Lacunas de especificação](#10-lacunas-de-especificação-abertas) · [11. Regras configuráveis](#11-regras-configuráveis) · [12. Integrações](#12-integrações-externas) · [13. Decisões de arquitetura](#13-decisões-de-arquitetura-do-mvp-2) · [14. Validação para o MVP 3](#14-validação-para-iniciar-o-mvp-3)

Escala: **Probabilidade** e **Impacto** em Baixa/Média/Alta.

---

## 1. Riscos do roadmap (§4.10) com mitigação detalhada

Os seis riscos do [roadmap §4.10](../product/roadmap.md#410-riscos), com o que a especificação fez para tratá-los e o que fica para a implementação.

| ID | Risco (roadmap §4.10) | Prob. | Impacto | Mitigação especificada | Na implementação | Dono |
|---|---|---|---|---|---|---|
| RR-01 | Práticas muito diferentes entre Procuradorias | Alta | Alta | Situações fixas por lei (as seis do produto + `WAIVED`), mas critérios da fila, hipóteses de dispensa e modelo de parecer são **configuração por tenant** (US-151, US-154; DEC-199); a ordem Jurídico × Controle Interno é configurável (DEC-194, DEC-196); parecer não vinculante (DEC-199) | Validar o modelo de parecer e os critérios da fila com a Procuradoria do piloto na Sprint 0; teste de usabilidade com procurador no M2.2 | PO + especialista em contratações |
| RR-02 | Referências textuais ao PCA não resolvidas na migração | Alta | Média | Reconciliação por `pcaYear` + `pcaItemCode` normalizado, uma transação por alvo, idempotente; não resolvidos ficam `UNRESOLVED` com **sugestões por similaridade** do objeto; conciliação manual assistida e em lote; campos textuais nunca apagados (US-143, DEC-197, [entities.md §10](entities.md#10-migrações-expandcontract)) | Rodar a reconciliação no staging com cópia anonimizada do piloto antes do release; meta de resolução automática medida e registrada no relatório | Trilha PCA |
| RR-03 | Etapas paralelas aumentam a complexidade do motor e da experiência | Média | Alta | Decidido por ADR (DEC-194, ADR-005 revisada): um nível de ramificação, um `PARALLEL_JOIN` por `PARALLEL_SPLIT`, validação do grafo na publicação (`WF_PARALLEL_INVALID`); `Process.currentStageId` preservado para compatibilidade; `activeStages[]` aditivo; custódia por ramo; a v2 do padrão é **sequencial** — paralelismo só por escolha do tenant | US-124 com *pairing* e revisão de arquitetura; spike da troca de índices (M2-06) na Sprint 0; teste de propriedades do motor com ramos | Tech Lead |
| RR-04 | Relatórios pesados sobre o banco transacional | Alta | Alta | Read model próprio (DEC-206, ADR-014): fatos alimentados pelo outbox, visões materializadas com `REFRESH CONCURRENTLY`, reconstrução noturna; relatórios **nunca** leem `ProcessStage`/`ProcessMovement` em produção; réplica de leitura opcional | Carga com 100 mil processos e 24 meses de histórico na sprint 10 ([tests.md §7.2](tests.md#72-carga)); defasagem ≤ 5 min monitorada | Plataforma |
| RR-05 | Regras condicionais complexas demais para administradores | Alta | Média | Modelos prontos semeados (US-196), simulador com processo hipotético (US-199), casos de teste obrigatórios nas regras de roteamento e bloqueio da publicação (US-200), etapas legalmente obrigatórias não aceitam `applicabilityRule` (ADR-015) | Revisão por especialista sugerida na publicação; guia do administrador com exemplos do piloto | PO + Trilha regras |
| RR-06 | Tenants que customizaram o workflow padrão | Média | Média | A v2 é **oferecida, nunca imposta** (DEC-196): publicada automaticamente só onde a versão vigente tem `seedVersion` (sem customização); os demais recebem a oferta como nova versão `DRAFT` do próprio workflow; processos em andamento ficam na versão anterior até uma migração pedida e simulada (DEC-195) | Comunicar a oferta aos administradores no release; acompanhar a adoção por tenant no backoffice | PO |

## 2. Riscos técnicos

| ID | Risco | Prob. | Impacto | Mitigação | Dono |
|---|---|---|---|---|---|
| RT-13 | Várias `ProcessStage` ativas quebrarem consultas, índices únicos e telas que supõem uma etapa ativa (caixa, painel, prazos, `ProcessAccess`) | Alta | Alta | Troca dos índices únicos `CONCURRENTLY` (M2-06) com *down* enquanto não houver ramo; `currentStageId` preservado; `activeStages[]` aditivo; regressão J-01..J-11 no endurecimento M2.1; inventário de leitores de `currentStageId` na US-124 | Trilha workflow |
| RT-14 | **Migração de versão de workflow em produção** levar processos a etapa errada ou deixar efeito parcial | Média | Alta | Simulação obrigatória (US-127), `NEEDS_DECISION` com decisão humana, execução assíncrona com uma transação por processo e idempotência por item, `expectedStageId` contra corrida com a tramitação, auditoria e timeline por processo, migração inversa como volta (ADR-016); J-15 em staging com cópia do piloto; janela de migração combinada com o órgão | Tech Lead |
| RT-15 | Decisões concorrentes na aprovação `ALL`/`SEQUENTIAL` gerarem estado inconsistente (dois encerramentos, linha decidida depois do encerramento) | Média | Alta | `SELECT … FOR UPDATE` na `Approval`, primeira que efetivar vale, 409 `APPROVAL_NOT_PENDING` à segunda (DEC-193); cenários de concorrência em todas as stories do EP-022; spike na Sprint 0 | Trilha workflow |
| RT-16 | `RuleContext` v2 virar gargalo: contrato instável, custo de montagem crescente, quebra das regras v1 | Média | Alta | Contrato versionado (`contextVersion` gravado por regra), montagem preguiçosa por namespace e cache por requisição (ADR-015), meta ≤ 50 ms por entrada em etapa ([tests.md §7.1](tests.md#71-desempenho-metas-por-fluxo)); US-129 na sprint 1, antes de qualquer provedor de módulo | Trilha regras |
| RT-17 | Projeção do read model perder evento, aplicar fora de ordem ou divergir do transacional | Média | Alta | Idempotência por `eventId`, chave natural por passagem de etapa, reconciliação noturna com relatório de divergências (US-171), reconstrução por tenant (ADR-014) | Plataforma |
| RT-18 | Dispensa automática de etapa por regra parecer "pulo" e confundir usuários e auditoria | Média | Média | `ProcessStageStatus` `SKIPPED` e `MovementAction` `SKIP` com registro na timeline e no painel; etapas legais não dispensáveis; simulador mostra o caminho (ADR-015) | Trilha regras + UX |
| RT-19 | Tempestade de notificações por regra mal configurada | Média | Média | Limite por regra (`notificationRules.maxPerRulePerHour`) com desligamento automático `AUTO_DISABLED` e alerta ao administrador; agrupamento; preferências do usuário respeitadas (US-193) | Trilha regras |
| RT-20 | Credenciamento no Login Único atrasar ou mudar o contrato do gov.br | Média | Média | Pedido na Sprint 0; integração isolada na fonte federada do Authentik (ADR-017); IdP fake no CI; login por usuário e senha mantido; homologação no release como contingência | Plataforma |
| RT-21 | Volume de stories novas em módulos novos (oito módulos da DEC-040) diluir a revisão de arquitetura | Média | Média | Níveis de módulo em `tools/module-levels.json` e verificação de fronteiras no CI (DEC-041); revisão obrigatória quando uma story cria fachada nova | Tech Lead |

## 3. Riscos legais e regulatórios

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RL-11 | **Base legal dos novos documentos da fase preparatória** (dotação — art. 18, *caput* e art. 150; minuta do edital — art. 18, V e art. 25; parecer — art. 53; manifestação do controle interno — art. 169, II; PCA — art. 12, VII e § 1º) interpretada de forma diferente por entes e TCEs | Alta | Alta | Templates, checklist, hipóteses de dispensa e regras de saída como **configuração** com base legal citada (princípio 17); biblioteca padrão v2 revisada por consultoria jurídica em contratações públicas antes do release; padrões "a validar com o piloto" ([overview §7](overview.md#7-a-validar-com-o-piloto)) |
| RL-12 | Ordem das etapas (dotação e edital antes do jurídico; controle interno depois) contestada pela Procuradoria ou pelo controle interno do ente (L-04) | Média | Média | DEC-196 fundamenta a ordem no art. 53 e no art. 169, II; ordem configurável por tenant (inverter ou paralelizar); validação com o jurídico do piloto na Sprint 0 |
| RL-13 | Parecer desfavorável ou manifestação `NON_COMPLIANT` ignorados sem motivação (responsabilização da autoridade que decide contra o parecer — art. 53, § 1º) | Média | Alta | Parecer e manifestação não vinculantes, mas seguir adiante exige **motivação registrada** da autoridade na `AUTORIZACAO_LICITACAO` (regra `WARNING` com reconhecimento — ADR-008); ressalvas rastreáveis visíveis à etapa seguinte; auditoria |
| RL-14 | Dispensa de análise jurídica (art. 53, § 5º) aplicada fora das hipóteses do ato da autoridade jurídica máxima | Baixa | Alta | Hipóteses só configuradas por quem tem a permissão (US-151), inativas por padrão; dispensa registrada com hipótese e justificativa; etapa legalmente obrigatória só aceita dispensa prevista na hipótese (POL-26) |
| RL-15 | Documentos do MVP 2 (parecer, manifestação, edital, declaração de dotação) **sem assinatura eletrônica** | Alta | Alta | Mesma mitigação do RL-02 do MVP 1: anexar versão assinada externamente como documento `UPLOADED`, hash SHA-256 no rodapé, comunicação clara; assinatura no MVP 3 |
| RL-16 | **IA no parecer e no edital** induzir conclusão jurídica ou cláusula indevida (responsabilização do procurador e do agente de contratação — agrava o RL-08) | Média | Alta | A IA **nunca propõe a conclusão** do parecer (seção sai como [a confirmar], situação escolhida pelo procurador — DEC-202); nada inventado (`GroundingGuard`); revisão humana obrigatória por seção antes de finalizar (US-122); rastreabilidade em `AiGeneration`; avaliação por procurador e por agente de contratação no `pnpm ai:eval` ([tests.md §6](tests.md#6-ia-do-parecer-e-do-edital)) |
| RL-17 | PCA divulgado fora do prazo ou do formato (art. 12, § 1º) por depender de exportação manual | Média | Média | Exportação para divulgação (US-145) com o formato do sítio oficial; publicação automatizada no MVP 3; aviso visual do calendário do plano |
| RL-18 | LGPD: CPF do gov.br, dados de procuradores e servidores em relatórios por responsável | Média | Média | CPF só em HMAC, mascarado e fora de logs, eventos e auditoria (DEC-207); relatório por responsável com aviso de uso analítico; exportações expiram em 24 h; inventário de dados atualizado |
| RL-19 | Orçamento sigiloso (art. 24) exposto por dotação, edital ou agregação nos indicadores | Baixa | Alta | Mascaramento por linha antes de agregar (ADR-014), POL-09 na dotação e no edital (`estimatedValueDisclosed`), testes específicos na matriz RBAC e no tenant leak |

## 4. Riscos de segurança

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RS-13 | Backoffice da plataforma virar porta de acesso a dados de tenant | Baixa | Alta | Área separada, só operadores (grupo próprio no Authentik, MFA obrigatório), **sem leitura de processos ou documentos** (DEC-208); acesso de suporte só por concessão com chamado, ≤ 72 h, visível e auditado nos dois lados (US-180) |
| RS-14 | Vínculo gov.br com o usuário errado (tomada de conta) | Baixa | Alta | Vínculo só pela própria pessoa autenticada ou por CPF igual ao cadastrado; gov.br autentica, não dá acesso (exige `TenantMembership`); auditoria do vínculo; desvincular em "Meu perfil" (ADR-017) |
| RS-15 | Injeção de instruções nos documentos de entrada dos geradores do parecer e do edital (cadeia mais longa de entradas) | Média | Média | Mesmas defesas do RS-12: contexto restrito ao processo e ao tenant, dados delimitados como material, saída estruturada e sanitizada, aplicação humana; cenário de injeção no pentest ([tests.md §6](tests.md#6-ia-do-parecer-e-do-edital)) |
| RS-16 | Planilhas do PCA e evidências de dotação com malware, fórmulas ou *CSV injection* | Média | Média | Fluxo seguro de upload do MVP 1 (quarentena + ClamAV — DEC-136); fórmulas neutralizadas na importação e na exportação; limites de linhas (`pca.import.maxRows`) |
| RS-17 | Escalonamento de privilégio pelas permissões novas de alto risco (`WORKFLOW_MIGRATE`, regras, SLA) | Baixa | Alta | POL-13 (anti-escalonamento), MFA para permissões `HIGH`, aplicação automática só aos perfis padrão não customizados (sugestão aos customizados), matriz RBAC gerada ([permissions.md §10](permissions.md#10-testes-de-autorização)) |
| RS-18 | Expressões JSON Logic maliciosas ou caras (biblioteca, SLA, notificação) | Baixa | Média | Mesmo executor com *allowlist* de operadores (ADR-008), limite de profundidade e de tempo, validação na publicação |

## 5. Riscos de multi-tenancy

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RM-09 | Tabelas novas (≈ 40, de oito módulos e dos ajustes de plataforma) sem RLS, FK composta ou cobertura no tenant leak | Média | Alta | Toda tabela nova segue DEC-080..083 ([entities.md §10](entities.md#10-migrações-expandcontract)); casos novos na suíte `test/tenant-leak` ([tests.md §5](tests.md#5-tenant-leak-das-entidades-novas)); verificação de RLS `FORCE` no CI de migração |
| RM-10 | Jobs novos (reconciliação do PCA, migração, projeção e reconstrução do read model, regras de notificação, SLA) rodarem sem contexto de tenant | Média | Alta | Classe base de job com `tenantId` obrigatório (DEC-164); reconstrução por tenant; testes de fila |
| RM-11 | Visões materializadas do read model misturarem tenants ou vazarem por `REFRESH` | Baixa | Alta | RLS nas tabelas de fatos; visões com `tenant_id` na chave única e acesso só por função com filtro de tenant (ADR-014); casos de tenant leak dedicados |
| RM-12 | Divergência entre a v2 do workflow padrão, templates e checklists semeados e as customizações do tenant | Alta | Média | Seeds incrementais idempotentes por `TenantSeeder.version`, oferta em vez de imposição (DEC-196), atualização da biblioteca de templates com diferença por `contentHash` (DT-15, US-187) |
| RM-13 | Operador de suporte com concessão ativa em vários tenants misturar dados | Baixa | Alta | Concessão por tenant, um tenant ativo por sessão (DEC-132), encerramento automático no prazo, auditoria `actorType = PLATFORM_OPERATOR` visível ao administrador |

## 6. Riscos de performance

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RP-10 | **Read model**: defasagem do projetor e duração da reconstrução noturna em tenants grandes | Média | Alta | Metas: defasagem ≤ 60 s, `dataAsOf` ≤ 5 min, reconstrução dentro da janela noturna sem degradar comandos além do SLO-05 ([tests.md §7](tests.md#7-testes-não-funcionais)); `REFRESH CONCURRENTLY` fora do pico |
| RP-11 | Caixa de tarefas com ramos e linhas de aprovação passar de p95 500 ms (agrava o DT-01) | Média | Média | View `v_inbox_pending_approvals` v2 e índices parciais por linha `PENDING`; meta mantida (RN-INBOX-12); se estourar, antecipar o read model da caixa (DT-01) |
| RP-12 | Migração de milhares de processos competir com a tramitação | Média | Média | Lotes na fila `maintenance`, transação por processo, trava consultiva por processo; carga com 2.000 processos ([tests.md §7.2](tests.md#72-carga)) |
| RP-13 | Fila jurídica priorizada com muitos critérios e 500 análises abertas | Baixa | Média | Ordenação calculada na gravação (chave de prioridade persistida) e recalculada por evento e por job diário; meta < 1,5 s (US-149) |
| RP-14 | Geradores do parecer e do edital com entradas em cadeia longas (custo e latência) | Média | Média | Resumo das entradas por documento, limite de tokens por pedido calibrado como no EP-020, meta de 90 s do rascunho, limites por órgão (DEC-203) |

## 7. Débitos técnicos assumidos

Os débitos do MVP 1 (DT-01 a DT-20 — [MVP 1 §6](../mvp-01/risks-and-decisions.md#6-débitos-técnicos-assumidos)) continuam valendo; o MVP 2 **paga** DT-02 (US-126..US-128), DT-03 (US-123..US-125, US-132..US-136), DT-07 e DT-18 (US-178..US-181), DT-13 a DT-16 (US-185..US-188, P2) e DT-17 (US-137). Débitos novos:

| ID | Débito | Motivo | Quando pagar |
|---|---|---|---|
| DT-21 | Colunas legadas de aprovador único em `approvals` (`approver_*`, `allow_deputy`) e a view `v_inbox_pending_approvals` v1 mantidas ao lado de `ApprovalApprover` (M2-22) | Expand/contract: leitores do MVP 1 continuam funcionando | MVP 3, depois do teste de contrato que prove que ninguém os lê |
| DT-22 | `Process.currentStageId`, `currentDepartmentId`, `currentResponsibleId` e `currentStageDueAt` desnormalizados com paralelismo (apontam para a ramificação durante os ramos) (M2-23) | Compatibilidade da API e das consultas do MVP 1 (DEC-194) | Avaliar depois do piloto do MVP 2, com nova decisão |
| DT-23 | Um nível de ramificação e um `PARALLEL_JOIN` por `PARALLEL_SPLIT` (sem ramos aninhados nem junção parcial) | Escopo (DEC-194) | Quando um tenant precisar de fluxo mais complexo |
| DT-24 | Sem reversão automática de migração de workflow (voltar = nova migração inversa) | Simplicidade e auditabilidade (DEC-195, ADR-016) | Sob demanda |
| DT-25 | Dotação digitada com evidência, sem integração contábil | Sem integração obrigatória no MVP 2 (DEC-198) | MVP 3 (adapters de sistemas contábeis) |
| DT-26 | Divulgação do PCA por exportação (sem publicação automática no sítio oficial ou no PNCP) | DEC-197; publicação é do MVP 3 | MVP 3 |
| DT-27 | `MINUTA_CONTRATO` como documento `FREE_TEXT`, sem módulo tipado nem relação documento ↔ documento com o edital (US-167, US-168) | Escopo (DEC-201) | MVP 4 (contrato) |
| DT-28 | Read model com consistência eventual (até 5 min) e reconstrução obrigatória a cada mudança de definição de indicador | Trade-off da ADR-014 | Monitorar; rever se houver indicador em tempo real |
| DT-29 | Aprovação do PCA só com política `ANY` e uma linha (o PCA não tem etapa de workflow para configurar política) | Escopo (US-140) | Avaliar após o piloto do MVP 2 |
| DT-30 | Suítes pesadas (`test:integration`, `test:tenant-leak`, `test:e2e`, desempenho) sem gate automático: dependem de cards de endurecimento agendados pelo piloto | Entrega direta na `main` sem CI de PR (DEC-190) | Automatizar uma execução agendada na `main` (noturna) antes do endurecimento M2.1 |
| DT-31 | Sem IA na manifestação do Controle Interno | Não pedida no prd-7 (DEC-200) | MVP 5 (validações e assistente) |

## 8. Pontos ambíguos do pedido e interpretação adotada

| # | Ponto | Interpretação adotada | Onde está |
|---|---|---|---|
| A-38 | Jurídico: "aguardando, em análise, diligência, favorável, favorável com ressalvas, desfavorável" | As seis situações do produto são `LegalReviewStatus` (`PENDING`, `IN_REVIEW`, `DILIGENCE`, `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`), mais `WAIVED` (dispensa do art. 53, § 5º) e `CANCELED` | DEC-199 |
| A-39 | "Edital" no MVP 2 | A **minuta** do edital e do contrato e a sua análise; número do edital, publicação e sessão pública são do MVP 3 | DEC-201 |
| A-40 | "Fase preparatória concluída" × "Planejamento concluído" | O mesmo `COMPLETED`; o rótulo vem do nome da etapa `END` da versão do workflow do processo (v1: planejamento; v2: fase preparatória) | DEC-196 |
| A-41 | "Indicadores" e "Gargalos" como épicos | Um épico (EP-028) com uma feature para cada: mesmo módulo, mesmo read model, mesmas telas | [epics.md](epics.md) |
| A-42 | "SLA" | Evolução do prazo por etapa (DEC-031): `SlaPolicy` substitui `slaDays` quando casa; o prazo do MVP 1 continua a base | DEC-205 |
| A-43 | "Controle Interno" decide? | Manifesta-se (`InternalControlReview` + documento); `NON_COMPLIANT` não bloqueia, exige motivação da autoridade | DEC-200 |
| A-44 | Parecer desfavorável | Não vinculante; seguir adiante exige motivação registrada da autoridade na `AUTORIZACAO_LICITACAO` | DEC-199 |
| A-45 | "Aprovação do PCA" | `Approval` com `ApprovalSubjectType` `PCA` e `processId` nulo, decidida pela autoridade (perfil configurável — `pca.approverRoleKey`) | DEC-197, US-140 |
| A-46 | "Regra que altera o roteamento" (ex.: "acima de X exige Controle Interno") | `WorkflowStage.applicabilityRule` (etapa dispensada quando falsa, com `SKIPPED` na timeline) e condição em `WorkflowTransition`; etapas legalmente obrigatórias não aceitam | DEC-204, US-197 |
| A-47 | "Migração de processos em andamento" | Nunca automática: pedida, simulada e auditada; processos `COMPLETED` na v1 só voltam por migração `NEEDS_DECISION` (não é reabertura genérica — PEND-03) | DEC-195, US-131 |
| A-48 | "Login gov.br" | Autentica a pessoa, não dá acesso: exige vínculo ativo no tenant; nível de confiança registrado, sem bloquear | DEC-207 |
| A-49 | "Backoffice da plataforma" | Operação de tenants (provisionamento, ciclo de vida, suporte, saúde) sem leitura de dados de processos | DEC-208 |
| A-50 | "Execução do PCA" | Valor previsto × processos vinculados por item, secretaria e categoria — não é execução orçamentária nem contratual | DEC-197, US-144 |

## 9. Regras que precisam de decisão de produto

Pendências de [decisions.md §10](../architecture/decisions.md#10-decisões-pendentes) que afetam o MVP 2, com o padrão adotado e o prazo-limite no plano. PEND-13, PEND-18 e PEND-22 foram resolvidas (DEC-193, DEC-207, DEC-203); PEND-12, PEND-16 e PEND-17 têm destino na DEC-210.

| ID | Decisão | Padrão adotado | Decidir até |
|---|---|---|---|
| PEND-21 | Provedor e modelo de IA (ADR-013) | Camada agnóstica + `FakeAiProvider`; recomendação Anthropic Claude via Amazon Bedrock (`sa-east-1`) | Sprint 7 (antes de US-157 e US-169) |
| PEND-03 | Reabertura de processo `COMPLETED`/`CANCELED` | Só a continuação na v2 (US-131), com justificativa | Sprint 8 |
| PEND-07 | Retenção e eliminação | Sem eliminação; exportações de relatório expiram em 24 h (arquivo, não registro) | Antes do MVP 3 |
| PEND-17 | Planos comerciais e limites | Limites técnicos padrão sem cobrança (inclusive IA — DEC-203) | Decisão comercial, fora do MVP 2 |
| L-04 (DEC-196) | Ordem das etapas da v2 | `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO` | Sprint 0 (jurídico do piloto) |
| Definições do piloto | Modelo de parecer, critérios da fila, hipóteses de dispensa, checklist do CI, calendário do PCA, classificação orçamentária | Padrões semeados ([overview §7](overview.md#7-a-validar-com-o-piloto)) | Sprint 0 |
| Dúvidas de produto das stories | Ver §10 | Padrão proposto em cada story | Refinamento da sprint da story |

## 10. Lacunas de especificação abertas

Cada story registra, na coluna "Lacunas" ([acceptance-criteria.md §4](acceptance-criteria.md#4-índice-de-critérios-por-story)), o detalhe fino que as fontes canônicas não fixaram e a proposta adotada — **549 itens em 72 stories**. Nenhum bloqueia critério de aceite ([acceptance-criteria.md §5](acceptance-criteria.md#5-o-que-depende-de-decisão-pendente)); decidem-se no refinamento da sprint e atualizam a story e o `api/*.md` do módulo. As que tocam **catálogos compartilhados** (eventos, erros, entidades, permissões) e merecem decisão antes da sprint:

| Story | Lacuna | Proposta da story | Decidir até |
|---|---|---|---|
| US-137 | Sem evento nem `NotificationType` de aprovação avulsa a vencer/vencida (só `ProcessStageDueSoon`/`ProcessStageOverdue`) | Eventos `ApprovalDueSoon`/`ApprovalOverdue` e tipo de notificação próprio | Sprint 3 |
| US-191, US-159 | Pausa do SLA na devolução pelo Controle Interno: `SlaPauseReason` só tem `LEGAL_DILIGENCE` e não há evento de rodada nova do CI (equivalente a `LegalReviewResumed`) | Eventos `InternalControlReviewDiligenceRequested`/`Resumed` e motivo `INTERNAL_CONTROL_DILIGENCE` | Sprint 5 |
| US-138 | Ação de auditoria `pca.delete` ausente em [events.md §7](events.md#7-catálogo-de-ações-de-auditoria); sem lembrete do prazo de elaboração do PCA | Acrescentar a ação; lembrete é dúvida de produto | Sprint 1 |
| US-147 | Declaração de dotação sem `DocumentType` próprio; exige criação de documento pelo servidor com corpo preenchido | Usar `DECLARACAO` e ampliar o `DocumentFacade` | Sprint 3 |
| US-148 | Dispensa de dotação por processo e aviso quando só o valor estimado muda depois da saída de `DOTACAO` | Rebaixar a regra a `WARNING` por tenant ou dispensar a etapa por `applicabilityRule`; aviso é dúvida de produto | Sprint 3 |
| US-149 | Faixa de valor da fila jurídica para quem não tem a permissão de sigilo | Mascarar a faixa | Sprint 4 |
| US-156 | Schema de `LEGAL_WAIVER_HYPOTHESIS` não diz quais etapas legalmente obrigatórias a hipótese cobre; desfazer a dispensa não existe | Atributo na hipótese; sem reversão | Sprint 7 |
| US-158 | Códigos de erro do checklist (`INTERNAL_CONTROL_CHECKLIST_*`) fora do catálogo de erros | Acrescentar ao [api.md §2.6](api.md#26-controle-interno-ep-026) | Sprint 4 |
| US-163, US-164 | `Tender.executionTermDays` sem tipo de contagem (o TR tem dias úteis ou corridos) | Acrescentar `DayCountType` ao `Tender` | Sprint 4 |
| US-168 | Aplicabilidade de seção do template por modalidade | Atributo opcional `applicableModalities` na `SectionDefinition` | Sprint 6 |
| US-170 | Onde guardar o resultado do refresh das visões (`dataAsOf`) e qual permissão administra o read model | Tabela `analytics_view_refreshes`; `SETTINGS_MANAGE` (alternativa `ANALYTICS_MANAGE`); bloco em SCR-041 | Sprint 2 |
| US-140 | Aprovação múltipla do PCA | Só `ANY` (DT-29) | — |

## 11. Regras configuráveis

Nenhuma regra legal ou administrativa fixa em código (princípio 17). Pontos de configuração **novos** do MVP 2 (os do [MVP 1 §9](../mvp-01/risks-and-decisions.md#9-regras-configuráveis) continuam):

| Mecanismo | O que configura | Quem configura | Referência |
|---|---|---|---|
| Versões de workflow com paralelismo e política de decisão | Ramificação/junção, `decisionPolicy` e aprovadores ordenados por etapa, ordem Jurídico × Controle Interno | Admin (`WORKFLOW_*`) | DEC-193, DEC-194, US-123, US-132 |
| Adoção da v2 e migração | Aceitar a oferta da v2; mapa de etapas, filtro e decisões da migração | Admin (`WORKFLOW_MIGRATE`) | DEC-195, DEC-196 |
| Biblioteca de regras | Validação, roteamento (`applicabilityRule`, condição de transição), alçadas por valor, SLA e notificação; versões, modelos e casos de teste | Admin/gestor | DEC-204, EP-031 |
| Políticas de SLA | Aplicabilidade, prazos por etapa (úteis ou corridos), pausas e degraus de escalonamento | Admin | DEC-205, US-189 |
| Regras de notificação | Evento + condição + destinatários + modelo de mensagem; limite por hora | Admin | DEC-205, US-193 |
| PCA | Calendário de elaboração, perfil aprovador, exigência de vínculo, severidade do saldo, limite da planilha | Admin | [entities.md §8](entities.md#8-novas-chaves-de-configuração-do-tenant) |
| Dotação | Classificação orçamentária (catálogos), severidade da regra de cobertura | Admin | DEC-198 |
| Jurídico | Critérios da fila, hipóteses de dispensa, prazos e lembretes da diligência, template do parecer | Admin (com o ato da autoridade jurídica máxima) | DEC-199, US-151 |
| Controle Interno | Checklists versionados, item padrão, aplicabilidade | Admin | DEC-200, US-158 |
| Edital | Valor a partir do qual a matriz de riscos é obrigatória; templates do edital e do contrato | Admin | DEC-201, US-166 |
| Relatórios | Mês de início do exercício | Admin | DEC-206 |
| gov.br | Habilitação por tenant; nível aceito como segundo fator | Admin | DEC-207, US-184 |
| Caixa de tarefas | Tamanho máximo do lote | Admin | DT-16, US-188 |

## 12. Integrações externas

| Integração | MVP | Finalidade | Protocolo | Risco principal |
|---|---|---|---|---|
| Login Único gov.br (via Authentik) | 2 | Entrada federada de servidores | OIDC (fonte federada no Authentik) | Credenciamento e contrato do Login Único (RT-20, RS-14) |
| Planilhas do PCA (CSV/XLSX) | 2 | Importação do plano | Upload | Formato heterogêneo, malware, fórmulas (RR-02, RS-16) |
| Provedor de IA (ADR-013) | 1 e 2 | Rascunhos do parecer e do edital | API via `AiProvider` | Mesmo do MVP 1 (PEND-21), agravado pelo RL-16 |
| Sistemas contábeis | 3 | Consulta de dotação e reserva | Adapters | Fora do MVP 2 (DT-25) |
| PNCP / sítio oficial | 3 | Publicação do PCA e do edital | API REST | Fora do MVP 2 (DT-26) |

As demais integrações do [MVP 1 §10](../mvp-01/risks-and-decisions.md#10-integrações-externas) continuam sem mudança.

## 13. Decisões de arquitetura do MVP 2

| Decisão | Referência |
|---|---|
| Especificação antes do piloto do MVP 1, versão 1 revisável; implementação começa por DT-02 e DT-03 | DEC-192 |
| Aprovação múltipla `ANY`/`ALL`/`SEQUENTIAL` com `ApprovalApprover` e serialização por trava de linha | DEC-193 |
| Etapas paralelas com `PARALLEL_SPLIT`/`PARALLEL_JOIN`, várias `ProcessStage` ativas, `activeStages[]` aditivo | DEC-194, ADR-005 |
| Migração de processos entre versões de workflow: plano, simulação obrigatória, execução auditada | DEC-195, ADR-016 |
| Workflow padrão v2 da fase preparatória, oferecido e nunca imposto | DEC-196 |
| Módulos `pca`, `budget`, `legal-review`, `internal-control`, `tender` estendendo `Document`, `Approval`, `WorkflowStage`, `CatalogItem` e `Department` | DEC-197 a DEC-201 |
| IA do parecer e do edital na camada do EP-020, sem propor a conclusão; custo incluído no plano | DEC-202, DEC-203 |
| Biblioteca de regras com `RuleContext` v2; SLA e notificação condicional no mesmo executor | DEC-204, DEC-205, ADR-015 |
| Indicadores e gargalos em read model próprio | DEC-206, ADR-014 |
| gov.br federado no Authentik | DEC-207, ADR-017 |
| Backoffice da plataforma sem módulo de domínio novo | DEC-208 |
| Débitos DT-13 a DT-17 e destino das pendências fora do MVP 2 | DEC-209, DEC-210 |

## 14. Validação para iniciar o MVP 3

Checklist a executar **antes** de detalhar o MVP 3 (gate do [roadmap §2](../product/roadmap.md#2-governança-do-roadmap-um-mvp-detalhado-por-vez)). Diferente do MVP 2, recomenda-se **não** antecipar a especificação: o MVP 3 depende de integrações externas cujo contrato só se conhece com o credenciamento.

- [ ] **Dependências:** MVP 2 em produção nos pilotos; v2 do workflow adotada e migração executada em pelo menos um órgão; PCA aprovado e reconciliado; credenciamento no PNCP iniciado durante o MVP 2 ([roadmap §12](../product/roadmap.md#12-riscos-transversais-do-roadmap)); levantamento dos diários oficiais e portais dos pilotos.
- [ ] **Entidades existentes reutilizadas:** `Tender` (número do edital, publicação, `PUBLISHED`), `Pca` (publicação do plano), `Document`/`DocumentVersion` com renderização `SIGNED` (DEC-017) para parecer, manifestação e edital; vínculos `SERVICE` (DEC-012) para a API pública.
- [ ] **Impactos:** `COMPLETED` → `PUBLISHED` (DEC-013, PEND-16); eventos publicáveis como webhook escolhidos entre os do MVP 2 sem payload sensível ([events.md §9](events.md#9-versionamento)); adapters contábeis pagam o DT-25.
- [ ] **Mudanças de arquitetura:** entrada pública da API separada do BFF (DEC-053, DEC-135); fila `webhooks`; módulos `publication`, `signature`, `integration`, `public-api`, `webhook` (DEC-040).
- [ ] **Migrações necessárias:** contract M2-22 (DT-21); colunas desnormalizadas do processo (DT-22) se a decisão vier; PDF/A (PEND-09).
- [ ] **Débitos a pagar antes:** DT-30 (gate automático das suítes pesadas) e os P2 do MVP 2 que não foram ao release (US-185..US-188).
- [ ] **Aprendizado incorporado:** KPIs E3 e Q1 medidos contra as metas do MVP 2; uso real de paralelismo, aprovação múltipla, regras e SLA; relatório de reconciliação do PCA.
