# MVP 2 — Definition of Done, Itens Postergados e Checklist de Release

> Critérios para considerar cards, épicos e o MVP 2 concluídos, e o checklist de liberação para os pilotos — com o que **muda frente ao MVP 1**: migração de workflow dos pilotos, reconciliação do PCA, gov.br e backoffice.
> Plano: [delivery-plan.md](delivery-plan.md) · Riscos: [risks-and-decisions.md](risks-and-decisions.md) · Testes: [tests.md](tests.md) · Critérios: [acceptance-criteria.md](acceptance-criteria.md). Base: [release-checklist do MVP 1](../mvp-01/release-checklist.md), que continua valendo onde este documento não diz o contrário.

---

## 1. Definition of Done

### 1.1 Card (story)

Vale a DoD do card do [MVP 1 §1.1](../mvp-01/release-checklist.md#11-card-story), com a verificação enxuta da DEC-190 (no card, só os testes dos módulos tocados e `pnpm turbo run lint typecheck test`; suítes pesadas nos cards de endurecimento). O MVP 2 acrescenta:

- [ ] Todo cenário Gherkin (8 categorias) automatizado; cenários de **concorrência** com teste real de transações concorrentes nas stories de aprovação múltipla, migração, dotação, decisões do jurídico e do controle interno.
- [ ] Tabelas novas com `tenant_id`, FK composta, RLS `ENABLE`/`FORCE`, *grants* e caso novo em `test/tenant-leak` (só o arquivo criado ou alterado roda no card).
- [ ] Provedor do namespace do módulo no `RuleContext` v2 (`budget.*`, `legalReview.*`, `internalControl.*`, `tender.*`, `pca.*`, `sla.*`) com teste de contrato contra o `ruleContextV2Schema` e meta de montagem registrada como teste de desempenho.
- [ ] Eventos novos com `eventVersion = 1` e, quando o fato entra nos indicadores, **projeção no read model** coberta por teste (idempotência por `eventId`).
- [ ] Migrações expand/contract conforme [entities.md §10](entities.md#10-migrações-expandcontract); migração não reversível (`NR`) explicitada no card e revisada.
- [ ] Contrato do MVP 1 sem quebra: só campos e rotas aditivos (DEC-108); OpenAPI conferido contra [api.md §5](api.md#5-mudanças-em-contratos-do-mvp-1).
- [ ] Orçamento sigiloso mascarado em toda resposta, exportação, agregação e geração de IA que o toque (DEC-030).
- [ ] Padrões "a validar com o piloto" implementados como configuração ou semente, nunca como código fixo.
- [ ] Nota final do card com entregue, decisões e pendências; lacunas resolvidas atualizam a story e o `api/*.md` do módulo.

### 1.2 Feature / épico
- [ ] Todas as stories P0 e P1 concluídas; P2 explicitamente postergadas ou concluídas.
- [ ] Jornada E2E do épico automatizada ([acceptance-criteria.md §2](acceptance-criteria.md#2-jornadas-de-aceite-do-mvp-2)) e rodada no card de endurecimento do marco.
- [ ] KPIs do épico instrumentados e visíveis no read model quando aplicável.
- [ ] Guia do usuário da persona do épico (jurídico, controle interno, contabilidade, licitações, planejamento, gestor, administrador, operador da plataforma) e notas de versão.

### 1.3 MVP 2
- [ ] 100% das stories P0 e P1 concluídas (DoD de card).
- [ ] Jornadas **J-12 a J-20** passando em staging e **regressão J-01 a J-11** do MVP 1 sem falhas (critério de saída do roadmap §4.8).
- [ ] Suíte `test:tenant-leak` 100% verde, inclusive as tabelas novas; matriz RBAC dos perfis ampliados 100% verde ([permissions.md §10](permissions.md#10-testes-de-autorização)).
- [ ] Metas de desempenho de [tests.md §7.1](tests.md#71-desempenho-metas-por-fluxo) atendidas no endurecimento; carga do read model (100 mil processos, 24 meses) e da migração (2.000 processos) dentro das metas, sem degradar os comandos além do SLO-05.
- [ ] `pnpm ai:eval` dos geradores `draft.legal_opinion` e `draft.tender` com nota de procurador e de agente de contratação registrada; provedor (PEND-21) decidido ou release com `FakeAiProvider` e IA desligada por padrão.
- [ ] Pentest dos fluxos novos (backoffice, acesso de suporte, gov.br, upload do PCA, regras JSON Logic, injeção nos geradores) sem achados críticos/altos abertos.
- [ ] Zero defeitos críticos/altos abertos; médios com plano aceito pelo PO.
- [ ] UAT assinado pelo piloto, com o **jurídico** e o **controle interno** do órgão (J-12, J-13, J-16, J-17).
- [ ] KPIs E3 e Q1 medidos contra as metas do MVP 2 ([roadmap §4.8](../product/roadmap.md#48-critérios-de-saída)).
- [ ] Documentação de operação atualizada: runbooks de migração de workflow, reconciliação do PCA, reconstrução do read model, regras de notificação desligadas automaticamente, concessão de acesso de suporte e indisponibilidade do gov.br.

## 2. Itens postergados

Consolidado em [delivery-plan.md §9](delivery-plan.md#9-itens-postergados-do-mvp-2). Resumo:

| Categoria | Itens |
|---|---|
| Stories P2 do MVP 2 | US-185, US-186, US-187, US-188 (DT-13 a DT-16) |
| Débitos novos | DT-21 a DT-31 ([risks-and-decisions.md §7](risks-and-decisions.md#7-débitos-técnicos-assumidos)) |
| Para o MVP 3 | Publicação do PCA e do edital (PNCP, sítio oficial, `PUBLISHED`), número do edital e sessão pública, assinatura eletrônica do parecer, da manifestação e do edital, adapters contábeis, contract das colunas legadas de `approvals` |
| Para o MVP 4 | Contrato tipado a partir da minuta (DT-27), resultado da seleção (L-01) |
| Para o MVP 5 | IA na manifestação do Controle Interno, validações cruzadas, recomendações |
| Avaliar | Ramos aninhados, quórum na aprovação múltipla, reversão automática de migração, edição colaborativa em tempo real (PEND-12) |

## 3. Checklist de release

Itens marcados com **(novo)** não existiam no checklist do MVP 1; os demais repetem o [MVP 1 §3](../mvp-01/release-checklist.md#3-checklist-de-release) com o escopo do MVP 2.

### 3.1 Produto e negócio
- [ ] Escopo do release congelado e comunicado (P0 + P1; P2 e postergados listados).
- [ ] **(novo)** Padrões "a validar com o piloto" confirmados ou ajustados e registrados ([overview §7](overview.md#7-a-validar-com-o-piloto)); ordem das etapas da v2 aceita pelo jurídico do piloto (DEC-196).
- [ ] **(novo)** Desvio consciente do roadmap §4.7 encerrado: stories revisadas com o aprendizado do UAT do MVP 1 (DEC-192) e versão da especificação registrada.
- [ ] Notas de versão em linguagem de usuário (pt-BR), com destaque para a **oferta da v2** do workflow e para o que muda na caixa de tarefas (ramos e linhas de aprovação).
- [ ] Guias por persona nova: jurídico, controle interno, contabilidade, licitações (edital), planejamento (PCA), gestor (SLA, relatórios e gargalos), administrador (regras, SLA, migração), operador da plataforma (backoffice).
- [ ] Biblioteca padrão v2 (parecer, edital, minuta do contrato, manifestação, checklist) revisada por consultoria jurídica em contratações públicas (RL-11).
- [ ] Aviso de que parecer, manifestação e edital não são assinados eletronicamente no MVP 2 (RL-15) e de que o edital é **minuta** (sem publicação).
- [ ] **(novo)** Termos de uso da IA atualizados para os geradores do parecer e do edital (a IA não propõe a conclusão do parecer — DEC-202).

### 3.2 Engenharia e qualidade
- [ ] *Build* verde no commit de release; tag semântica; imagens assinadas e com SBOM.
- [ ] **(novo)** Suítes pesadas rodadas no card de endurecimento final (DEC-190, DT-30): `test:integration`, `test:tenant-leak`, `test:e2e`, desempenho, carga e acessibilidade.
- [ ] Migrações M2-01 a M2-21 aplicadas em staging a partir de cópia anonimizada do piloto, com tempo medido; **M2-01 e M2-21 não reversíveis** conferidas com o Tech Lead; M2-06 (troca de índices) com o *down* testado antes do primeiro ramo.
- [ ] **(novo)** Backfill de `approval_approvers` (M2-03) conferido: uma linha por aprovação existente, caixa de tarefas idêntica antes e depois.
- [ ] **(novo)** Carga inicial do read model (`REBUILD` por tenant) executada fora do horário de uso, com reconciliação sem divergências.
- [ ] Compatibilidade de navegadores (2 últimas versões de Chrome, Edge, Firefox, Safari).
- [ ] Feature flags por tenant piloto (paralelismo, regras de roteamento, gov.br, IA do parecer e do edital).

### 3.3 Segurança e privacidade
- [ ] Pentest concluído (§1.3) e achados críticos/altos corrigidos e revalidados.
- [ ] **(novo)** Backoffice: grupo de operadores no Authentik com MFA obrigatório, rota `/plataforma` separada, nenhum dado de tenant lido sem concessão; concessões de suporte com prazo ≤ 72 h e auditoria visível ao administrador (DEC-208).
- [ ] **(novo)** gov.br: fonte federada revisada (redirect URIs, *scopes*, mapeamento de CPF em HMAC), CPF fora de logs, eventos e auditoria; inventário de dados pessoais e termos atualizados (RL-18).
- [ ] Segredos novos (cliente gov.br, credencial de serviço das rotas `/internal/*`) no Secrets Manager e rotacionados; gitleaks limpo.
- [ ] Permissões novas de alto risco (`WORKFLOW_MIGRATE`, regras, SLA, `LEGAL_REVIEW_WAIVE`) aplicadas só aos perfis padrão não customizados; sugestão aos customizados conferida.
- [ ] Mascaramento do orçamento sigiloso verificado em dotação, edital, relatórios, exportações e geração de IA (RL-19).

### 3.4 Operação
- [ ] **(novo)** Monitoração do read model: defasagem do projetor, duração do `REFRESH` e da reconstrução noturna, divergências da reconciliação — com alertas e runbook.
- [ ] **(novo)** Monitoração das filas novas no backoffice (`maintenance` para migração, reconciliação e reconstrução; regras de notificação; SLA) e alerta de regra `AUTO_DISABLED`.
- [ ] Dashboards técnicos e de negócio atualizados com os módulos novos; alertas roteados para o plantão.
- [ ] Plano de rollback ensaiado, **considerando o que não volta**: valores de enum (M2-01), versões de workflow publicadas pelas sementes (M2-21) e migrações de processos executadas (voltar = migração inversa — ADR-016).
- [ ] Janela de manutenção combinada com cada piloto para a adoção da v2 e a migração dos processos.

### 3.5 Implantação nos pilotos — o que muda frente ao MVP 1

**Migração de workflow dos pilotos (DEC-195, DEC-196)**
- [ ] **(novo)** Oferta da v2 apresentada ao administrador de cada piloto; v2 adotada (publicada automaticamente onde o padrão não foi customizado; adotada como nova versão do workflow do tenant onde foi).
- [ ] **(novo)** Etapas `TASK` provisórias criadas no MVP 1 para dotação ou jurídico incluídas no mapa de etapas; documentos de texto livre mantidos como histórico.
- [ ] **(novo)** Migração dos processos em andamento **simulada** com o administrador, `NEEDS_DECISION` decididos com justificativa, executada na janela combinada e conferida pelo relatório da migração (J-15).
- [ ] **(novo)** Processos concluídos na v1 que seguirão para a fase preparatória escolhidos pelo órgão e migrados para `DOTACAO` (US-131).

**Reconciliação do PCA (DEC-197)**
- [ ] **(novo)** PCA do exercício importado por planilha (ou elaborado) e aprovado pela autoridade; o PCA de 2028 é importado, não elaborado na plataforma ([delivery-plan §8](delivery-plan.md#8-cenários-de-capacidade)).
- [ ] **(novo)** Reconciliação das referências textuais (`pcaYear` + `pcaItemCode`) executada; relatório revisado com o planejamento do órgão; `UNRESOLVED` e `AMBIGUOUS` conciliados manualmente ou aceitos com justificativa (J-16).
- [ ] **(novo)** Exportação para divulgação conferida com o formato do sítio oficial do órgão (art. 12, § 1º).

**gov.br (DEC-207)**
- [ ] **(novo)** Credenciamento da plataforma no Login Único concluído (produção) e homologação com contas bronze, prata e ouro.
- [ ] **(novo)** `auth.govbrEnabled` ligado só nos pilotos que pediram; política de MFA revista (`auth.govbrCountsAsMfa`); usuários orientados a vincular a conta em "Meu perfil" (J-19).

**Backoffice (DEC-208)**
- [ ] **(novo)** Operadores da plataforma cadastrados no grupo próprio do Authentik; provisionamento de novos órgãos pelo backoffice (a CLI continua como contingência); acesso de suporte testado de ponta a ponta com um chamado fictício (J-18).

**Configuração dos módulos novos**
- [ ] Unidades de Contabilidade, Licitações, Procuradoria/assessoria jurídica e Controle Interno cadastradas e configuradas como responsáveis das etapas da v2; perfis `CONTABILIDADE`, `JURIDICO` e `CONTROLE_INTERNO` atribuídos com escopo.
- [ ] Catálogos orçamentários, critérios da fila jurídica, hipóteses de dispensa (com o ato da autoridade jurídica máxima), checklist do Controle Interno e templates v2 revisados com o piloto.
- [ ] Políticas de SLA, regras de notificação e regras da biblioteca adotadas pelo administrador, testadas no simulador (nenhuma ativa por padrão).
- [ ] IA do parecer e do edital ligada só onde o órgão aceitou os termos (opt-in, DEC-037).
- [ ] Treinamento por persona realizado; acompanhamento intensivo nas 2 primeiras semanas, com o jurídico e o controle interno.

### 3.6 Pós-release (primeiras 4 semanas)
- [ ] Monitorar adoção (processos na v2, análises jurídicas, manifestações, dotações, PCA vinculado) e qualidade (5xx, latência, defasagem do read model, falhas de migração e de reconciliação).
- [ ] Comparar KPIs E3 e Q1 com as metas; revisar gargalos reais com o gestor do piloto.
- [ ] Revisar débitos DT-21 a DT-31 e riscos com dados de uso; decidir DT-22 (colunas desnormalizadas) e DT-29 (aprovação múltipla do PCA).
- [ ] Iniciar a validação do MVP 3 ([risks-and-decisions.md §14](risks-and-decisions.md#14-validação-para-iniciar-o-mvp-3)).
