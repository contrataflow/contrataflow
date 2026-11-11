# MVP 2 — Estratégia e Plano de Testes

> **Objetivo:** levar cada story do MVP 2 à produção com os critérios de aceite automatizados, o isolamento entre tenants comprovado nas entidades novas, a autorização dos perfis ampliados verificada, o read model dentro das metas e a IA do parecer e do edital avaliada — sem regressão no MVP 1.
> Estende o [plano de testes do MVP 1](../mvp-01/tests.md): pirâmide, ferramentas, as nove suítes transversais (CA-T-01 a CA-T-10), gates de CI, dados e ambientes continuam valendo e não são repetidos. Critérios de aceite e jornadas: [acceptance-criteria.md](acceptance-criteria.md). Permissões: [permissions.md](permissions.md) §3 e §10. Contratos: [api.md](api.md). Versão 1, revisável depois do UAT do MVP 1 (DEC-192).

Sumário: [1. Princípios](#1-princípios-e-onde-cada-teste-roda) · [2. Suítes transversais](#2-suítes-transversais-o-que-o-mvp-2-acrescenta) · [3. Jornadas E2E](#3-jornadas-de-aceite-e2e-j-12-a-j-20) · [4. Matriz RBAC](#4-matriz-rbac-dos-perfis-ampliados) · [5. Tenant leak](#5-tenant-leak-das-entidades-novas) · [6. IA](#6-ia-do-parecer-e-do-edital) · [7. Não funcionais](#7-testes-não-funcionais) · [8. Dados de teste](#8-dados-de-teste) · [9. Rastreabilidade](#9-rastreabilidade-e-riscos)

---

## 1. Princípios e onde cada teste roda

- **Toda story** traz Gherkin nas 8 categorias (sucesso, validação, permissão, tenant incorreto, duplicidade, concorrência, falha de banco, falha de integração) e cada cenário vira teste automatizado — unitário, de integração ou E2E — conforme a seção "Testes necessários" da story. `pnpm docs:check` garante as 8 categorias no card.
- **No card** (DoD enxuta, 2026-10-15): testes do módulo tocado e o arquivo de tenant leak criado ou alterado; `pnpm turbo run lint typecheck test` uma vez.
- **No endurecimento** (card próprio, agendado pelo piloto): `test:integration`, `test:tenant-leak`, `test:authz`, `test:e2e` completos e a suíte de performance com as metas do §7 — como no MVP 1 depois da DEC-190 (sem CI de PR por lote, suíte pesada só roda quando agendada).
- **Regressão do MVP 1:** as jornadas J-01 a J-11 continuam obrigatórias no release do MVP 2, rodando sobre tenants que **não** adotaram a v2 do workflow padrão (comportamento idêntico) e sobre tenants que adotaram (o planejamento continua igual até a etapa 6).
- **Contrato:** `pnpm ci:contract` (diff do `api.v1.json`) só pode mostrar adições nas rotas do MVP 1 ([api.md §5](api.md#5-mudanças-em-contratos-do-mvp-1)); remoção ou mudança de tipo bloqueia o release.

## 2. Suítes transversais: o que o MVP 2 acrescenta

| ID | Acréscimo do MVP 2 |
|---|---|
| CA-T-01 Tenant leak | Todas as rotas novas (225 na API pública) classificadas no manifesto; entidades novas no §5; fatos do read model, itens de migração, regras da biblioteca e exportações por tenant; rotas `/platform/*` isentas com motivo (`x-tenant-scope = PLATFORM`, sem dado de tenant) |
| CA-T-02 Autorização | 30 permissões novas × 15 perfis × escopos (matriz gerada de `packages/types`); uma bateria por POL nova (POL-19 a POL-29) e pelas mudanças em POL-01, 02, 03, 09, 17 e 18 ([permissions.md §10](permissions.md#10-testes-de-autorização)); §4 deste documento |
| CA-T-04 Concorrência | `If-Match` em plano e itens do PCA, dotação, análise e parecer, manifestação, minuta e lotes, plano de migração, regras, políticas de SLA e regras de notificação; **`If-Match` por linha** na decisão de aprovação múltipla (dois aprovadores decidindo em paralelo em `ALL` não geram 412 entre si; a mesma linha decidida duas vezes gera `APPROVAL_LINE_NOT_PENDING`) |
| CA-T-05 Idempotência | Envio do PCA, importação e confirmação, confirmação de dotação, conclusão do parecer e da manifestação, dispensa, conclusão da minuta, execução de migração (reexecução não migra duas vezes), exportações, gerações de IA, publicação de regra |
| CA-T-06 Auditoria e outbox | Eventos do [events.md §4](events.md#4-catálogo-de-eventos) na mesma transação da mudança; ações de auditoria do §7; nenhum texto de parecer, manifestação, edital ou CPF em evento, log ou auditoria; projetor do read model idempotente por `eventId` |
| CA-T-07 Falhas de dependências | Banco indisponível (503 `DEPENDENCY_UNAVAILABLE`); fila de jobs parada (importação, migração, exportação, reconciliação, projeção) com retomada; renderização de PDF pendente; provedor de IA indisponível; Authentik/gov.br indisponível no login (volta à entrada com motivo) |
| CA-T-08 Orçamento sigiloso | POL-09 estendida a `BudgetAllocation.reservedAmount`, valores do PCA ligados a processo sigiloso, lotes e itens do edital, simulador de regras; POL-28 nos agregados (somas e médias sem os sigilosos para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`, inclusive por diferença entre recortes) |
| CA-T-09 Sessão, limites e formatos | Limites de tamanho (planilha do PCA, texto de diligência, ementa, mensagens de regra de notificação), `pageSize` ≤ 100, rate limit das exportações; sessão gov.br com nível de confiança; sessão do operador com MFA |
| CA-T-10 Acessibilidade | axe-core nas 13 telas novas e nas mudanças do §3 de [screens.md](screens.md); situação por texto e ícone; gráficos com tabela equivalente; arrastar e soltar com alternativa por teclado |

## 3. Jornadas de aceite (E2E) J-12 a J-20

Mesmo tenant de referência do MVP 1 — **"Prefeitura de São José"** — com a **v2 do workflow padrão adotada** (DEC-196), unidades novas "Contabilidade", "Procuradoria-Geral", "Controladoria" e "Departamento de Licitações", e as personas do MVP 1 acrescidas de Beatriz (CONTABILIDADE), Daniel (JURIDICO), Helena (CONTROLE_INTERNO), Lucas (LICITACOES) e Marta (ADMIN_ORGAO). O Gherkin de cada jornada está em [acceptance-criteria.md §2](acceptance-criteria.md#2-jornadas-de-aceite-do-mvp-2).

| Jornada | Épicos/stories cobertos | Seed necessário | Automação | Ambiente |
|---|---|---|---|---|
| J-12 — Fase preparatória completa até a autorização da licitação | EP-021 (US-130 v2), EP-024 (US-146–148), EP-027 (US-163–168), EP-025 (US-149, 152, 154, 155), EP-026 (US-159–161), EP-022 (US-133–134) | Processo da J-03 aprovado pela autoridade (etapa 6) em tenant com a v2 | E2E (Playwright) | Staging |
| J-13 — Diligência do jurídico e retomada | EP-025 (US-153, 152) + EP-030 (US-191 pausa) | Processo da J-12 em `JURIDICO`, `IN_REVIEW` | E2E com relógio controlado | CI efêmero / Staging |
| J-14 — Aprovação sequencial e por todos | EP-022 (US-132–136) | Etapa `AUTORIZACAO_LICITACAO` com política `SEQUENTIAL` (2 linhas) e tipo de documento avulso com `ALL` | E2E | CI efêmero / Staging |
| J-15 — Migração de processos em andamento para a v2 | EP-021 (US-126–128, 131) | 20 processos na v1 em etapas variadas (inclusive um com etapa provisória "Jurídico" e 2 concluídos) | E2E + verificação do relatório | Staging |
| J-16 — PCA: do plano aprovado à reconciliação e à execução | EP-023 (US-138–145) | Exercício 2027; planilha de 120 linhas com 4 inválidas; 6 processos do MVP 1 com `pcaYear`/`pcaItemCode` textuais | E2E | Staging |
| J-17 — Relatórios, gargalos e exportação | EP-028 (US-170–177) | Read model reconstruído sobre 300 processos sintéticos de 12 meses, 3 sigilosos | E2E + conferência dos números contra consulta de referência | Staging |
| J-18 — Backoffice: provisionamento, suporte e ciclo de vida | EP-029 (US-178–181) | Operador com MFA; tenant novo "Câmara de Vila Nova" | E2E | Staging |
| J-19 — Entrada pelo gov.br e vínculo de identidade | EP-029 (US-182–184) | Authentik com fonte OIDC do gov.br de homologação (ou IdP fake equivalente no CI), `auth.govbrEnabled` no tenant | E2E | CI efêmero (IdP fake) / Staging (homologação gov.br) |
| J-20 — Regras, alçadas e SLA em escalonamento | EP-031 (US-194–200) + EP-030 (US-189–193) | Regra de alçada "valor > R$ 400.000,00 exige autoridade", política de SLA com 2 degraus | E2E com relógio controlado | CI efêmero / Staging |

Como no MVP 1, nenhuma jornada é aprovada só em ambiente efêmero: o DoD do MVP 2 exige J-12 a J-20 **e** J-01 a J-11 passando em staging. Passos que dependem do gov.br real (J-19) rodam na homologação do Login Único; no CI, com o IdP fake (`OIDC_FAKE_SIGNING_KEY`).

## 4. Matriz RBAC dos perfis ampliados

A fonte da verdade é a matriz de [permissions.md §3](permissions.md#3-matriz-perfil--permissão-novas-e-alteradas); o teste *table-driven* (`test:authz`) é **gerado** dela e percorre todas as rotas novas × perfis × escopos. A tabela abaixo fixa os cenários obrigatórios por perfil ampliado — cada linha é um par positivo/negativo da bateria:

| Perfil | Pode (positivo) | Não pode (negativo esperado) |
|---|---|---|
| `CONTABILIDADE` (CTB) | Indicar e **confirmar** dotação com evidência (BUD-02, BUD-10); ver PCA | Confirmar fora da custódia da etapa `DOTACAO` (403 `NOT_PROCESS_CUSTODIAN`); conduzir análise jurídica (403); relatórios (403) |
| `GESTOR_CONTRATACOES` (GES) | Indicar dotação (rascunho); elaborar e enviar PCA; criar e concluir minuta; SLA, regras (sem publicar), notificações; relatórios e exportação | **Confirmar** dotação (403 — só CTB); publicar regra (403 — só ADM); concluir parecer (403) |
| `JURIDICO` (JUR) | Fila, análise, diligência, parecer com IA, ressalvas, concluir com MFA, dispensar | Concluir análise de processo em que é requisitante ou autor de documento analisado (POL-19); ler rascunho de manifestação do CI (POL-24); configurar a fila (403 — só ADM) |
| `CONTROLE_INTERNO` (CI) | Fila própria e jurídica em leitura, checklist, achados, concluir manifestação, checklists, regras em leitura, relatórios, exportação do PCA | Gerar com IA (403 — sem `AI_GENERATE`, DEC-200); ler rascunho de parecer (POL-24); alterar o processo analisado (POL-20) |
| `AUTORIDADE_COMPETENTE` (AUT) | Aprovar o PCA (APV-03 com `subjectType = PCA`) e autorizar a licitação; filas em leitura; relatórios | Decidir aprovação em que é autor do parecer ou da minuta coberta (POL-23, `SELF_APPROVAL_FORBIDDEN`); editar PCA (403) |
| `LICITACOES` (LIC) | Criar, editar e concluir a minuta do edital e do contrato; IA do edital; relatórios | Concluir a minuta sem os bloqueios resolvidos (422 com `violations[]`); analisar juridicamente (403) |
| `ADMIN_ORGAO` (ADM) | Migração de workflow com MFA; publicar regra; políticas de SLA; regras de notificação; critérios da fila e hipóteses de dispensa; checklists | Tramitar processo (403, como no MVP 1); `REPORT_VIEW` (403 por padrão); migrar sem MFA (403 `MFA_REQUIRED` — POL-21) |
| `AUDITOR` (AUD) | Ler PCA, filas, regras, relatórios; exportar PCA e relatórios; receber `AUDIT_SEAL_BROKEN` | Qualquer escrita nos módulos novos (403) |
| `CONSULTOR_EXTERNO` (EXT) | Editar a minuta do edital **só** onde é participante (`TENDER_UPDATE`) | Todo o PCA (403/404 — DEC-197); análises e relatórios (403/404); edital de processo em que não é participante (404) |
| `REQUISITANTE` (REQ) e escopo de secretaria | Ver PCA; IA no DFD como no MVP 1 | Ver ou editar itens do PCA de outra secretaria (escopo); relatórios (403) |
| Operador da plataforma | Rotas `/platform/*` com MFA e a permissão de plataforma da rota | Rota `/platform/*` sem MFA (403 `MFA_REQUIRED`); rota de tenant sem acesso de suporte ativo (403 `MEMBERSHIP_INACTIVE`); qualquer resposta com dado de processo ou documento |

Meta-testes: toda rota nova declara permissão e política ou está na lista de rotas implícitas/internas (GOV-01, GOV-02, GOV-03); toda permissão nova aparece em ao menos uma rota; nenhum perfil padrão ganha permissão de risco `H` sem constar da matriz.

## 5. Tenant leak das entidades novas

Suíte `test/tenant-leak` (CA-T-01), com os tenants "Prefeitura A" e "Prefeitura B" com massa equivalente. Para cada entidade, os casos mínimos — id de outro tenant na URL → 404; no corpo → 422 `REFERENCE_NOT_FOUND`; listas, buscas, agregados e exportações sem dado do outro tenant; RLS como defesa em profundidade:

| Entidade / área | Rotas | Casos específicos |
|---|---|---|
| `Pca`, `PcaItem`, importações, revisões, exportações | PCA-01..36 | Vínculo de DFD/processo a item de outro tenant (PCA-41 → 422); planilha importada nunca grava em outro tenant; exportação só do próprio plano |
| Reconciliação do PCA | PCA-48..57 | Candidatos de conciliação só do tenant do job; execução noturna por tenant |
| `BudgetAllocation` | BUD-01..20 | Catálogos orçamentários de outro tenant (422); evidência (anexo) de outro tenant (422) |
| `LegalReview`, diligências, ressalvas, parecer | LGL-01..24 | Hipótese de dispensa de outro tenant (422); versão analisada de documento de outro tenant (422) |
| `InternalControlReview`, checklists, achados | ICT-01..19 | Checklist publicado de outro tenant nunca fixado; evidência de outro tenant (422) |
| `Tender`, lotes, matriz de riscos | TND-01..14 | Importação de TR de outro tenant (404); risco do mapa de outro tenant (422) |
| `WorkflowMigration` e itens | WF-25..36, PRC-50..52 | Filtro por ids de processo de outro tenant ignora/recusa (422); execução nunca toca processo de outro tenant |
| Ramos, aprovadores por linha | PRC-39, WF-24, WF-65, APV-06, APV-31 | Aprovador (usuário, perfil, unidade) de outro tenant (422) |
| Biblioteca de regras, casos de teste, simulação | RUL-01..16, WF-80..83, PRC-70..71, APV-46 | Simulação com processo real de outro tenant (404); referência a regra de outro tenant (422) |
| `SlaPolicy`, `NotificationRule`, execuções | SLA-01..12, NTR-01..09 | Destinatário de outro tenant (422); pré-visualização com processo de outro tenant (404) |
| Read model (`analytics`) e exportações de relatório | ANL-01..19 | Fatos com `tenant_id`; reconstrução e reconciliação por tenant; arquivo de exportação com chave `tenants/{tenantId}/exports/…` |
| Identidade gov.br | GOV-04..09 | Vínculo de identidade é do usuário (global), mas `auth.govbrEnabled` e a resolução de vínculos são por tenant; resolver nunca revela usuário de outro tenant |
| Acesso de suporte | SPA-01..03, PLT-15..19 | Administrador do tenant A não vê nem encerra acesso ao tenant B (404); `support_access_grants` só escrita por `cf_platform` |
| Biblioteca de templates (DT-15), perfis (DT-13) | TPL-14..17, ROL-13 | Atualização da biblioteca aplicada só ao tenant que adotou |

Toda operação nova precisa estar classificada no manifesto (coberta ou isenta com motivo); operação sem classificação falha o *build* (RN-TEN-36). Teste novo de isolamento entra em `test/tenant-leak` no card da story; a suíte completa roda no endurecimento.

## 6. IA do parecer e do edital

Estende o [MVP 1 §3.10](../mvp-01/tests.md#310-geração-com-ia-ep-020) aos geradores `draft.legal_opinion` (US-157) e `draft.tender` (US-169):

- **CI:** só o `FakeAiProvider` determinístico, com *fixtures* por `promptKey` (`draft.legal_opinion`, `draft.tender`) e por entrada em cadeia (DFD, ETP, mapa de riscos, pesquisa de preços, TR, dotação, minuta do edital). Nenhuma chamada real.
- **`GroundingGuard`:** números, valores, prazos, percentuais, artigos e datas da proposta precisam existir nas entradas; citações legais do catálogo permitido; o que não existe vira `[a confirmar]`. Testes de propriedade com valores inventados × presentes, inclusive a conclusão do parecer (nunca preenchida pela IA — selo "Decisão sua") e a alocação de riscos do edital ("Sugestão — decisão da equipe").
- **`ContextSanitizer`:** CPF, e-mail, telefone e CEP redigidos; valores de orçamento sigiloso fora do contexto (CA-T-08); rascunho restrito de parecer nunca entra no contexto de quem não pode lê-lo (POL-24).
- **Injeção de instruções:** conteúdo de seção ou de documento de entrada com "ignore as instruções…", HTML/script e pedido de dados de outro processo; a resposta continua estruturada e sanitizada.
- **Bloqueios:** `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING` bloqueiam finalizar o parecer, concluir a análise e concluir a minuta.
- **Limites por órgão (DEC-203):** consumo dos geradores novos contabilizado no limite do tenant (AI-06); limite atingido → geração recusada com o motivo, sem afetar a edição manual.
- **`pnpm ai:eval`:** o conjunto de avaliação ganha **10 processos sintéticos × 2 documentos novos** (parecer jurídico e minuta do edital), além dos 4 do MVP 1, com nota de especialista (procurador para o parecer; pregoeiro/agente de contratação para o edital) por critério: aderência às entradas, ausência de invenção, estrutura do documento, marcação `[a confirmar]` e utilidade. Roda a cada nova `promptVersion` e na escolha do provedor (ADR-013, PEND-21); fora do CI.

## 7. Testes não funcionais

### 7.1 Desempenho (metas por fluxo)

Metas das stories, escritas como testes da suíte de performance e **medidas no endurecimento** (nunca no card). Valem também as do [MVP 1 §7.1](../mvp-01/tests.md#71-desempenho-metas-por-fluxo).

| Fluxo | Meta (p95) | Story |
|---|---|---|
| Caixa de tarefas por visão, com ramos e linhas de aprovação | < 500 ms (RN-INBOX-12 mantida) | US-125, US-136 |
| Acréscimo do `RuleContext` v2 e do SLA por entrada em etapa | ≤ 50 ms | US-129, US-190 |
| Painel e ações do processo com 5 ramos ativos | dentro do orçamento do MVP 1 | US-124 |
| Importação do PCA (500 linhas) — prévia e aplicação | ≤ 30 s por fase | US-139 |
| Execução do PCA (500 itens), comparação entre versões | ≤ 2 s | US-141, US-144 |
| Exportação do PCA (500 itens, CSV e PDF) | ≤ 30 s | US-145 |
| Fila jurídica com 500 análises abertas (LGL-01) | < 1,5 s; LGL-02 e LGL-09 < 400 ms | US-149 |
| Gravar resposta ou achado do Controle Interno | < 800 ms | US-160 |
| Edital: criar (TND-01) / prévia do TR (TND-05) / lotes e matriz (TND-07..10) / análise (TND-13) | < 800 ms / < 800 ms / leitura < 300 ms, escrita < 800 ms / ≤ 600 ms | US-163 a US-168 |
| Declaração de dotação (PDF assíncrono) | ≤ 30 s (SLO de `CONTENT`) | US-147 |
| IA do parecer e do edital — pedido (AI-01) / rascunho completo | ≤ 1 s / ≤ 90 s | US-157, US-169 |
| Read model — defasagem do projetor | ≤ 60 s | US-170 |
| Read model — `dataAsOf` até a leitura | ≤ 5 min | US-170 |
| Relatório (`ANL-06`) / detalhamento por processo / primeira página do detalhamento | ≤ 2 s / ≤ 800 ms / ≤ 1,5 s | US-172, US-173 |
| Gargalos, filas e comparação do exercício | ≤ 2 s | US-176, US-177 |
| Migração: tramitação durante a execução | comandos dentro do SLO-05 | US-128 |
| gov.br: resolução (GOV-02) / *callback* sem Authentik / vínculos (GOV-04) | < 100 ms / < 800 ms / < 100 ms | US-182, US-183 |
| Provisionamento de tenant (PLT-01, síncrono) | < 2 min | US-178 |
| Configurações com as chaves novas (`GET /settings`) | < 200 ms | US-184, US-188 |

### 7.2 Carga

- **Read model:** cenário de referência do MVP 1 (100 mil processos no tenant) com 24 meses de histórico de movimentações; mede defasagem do projetor sob 50 eventos/s, reconstrução completa de um tenant (janela noturna) e as consultas `ANL-*` com 20 usuários simultâneos — metas do §7.1. A reconstrução não pode degradar os comandos de tramitação além do SLO-05.
- **Migração:** execução de 2.000 processos em lotes, sem bloquear a tramitação dos demais (US-128).
- **Exportações e importações:** 10 pedidos simultâneos por tenant dentro do rate limit, sem fila de outro tenant atrasar.
- Ferramenta, *smoke* no pós-deploy de staging e carga completa no release: como no [MVP 1 §7.2](../mvp-01/tests.md#72-carga).

### 7.3 Resiliência, segurança e LGPD

- **Resiliência:** fila parada durante importação, migração, reconciliação, exportação e projeção → retomada idempotente sem duplicar efeito; renderização de PDF falha → `RenditionStatusChip` com "Tentar de novo"; gov.br indisponível → entrada por usuário e senha continua.
- **Segurança:** varredura de *upload* da planilha do PCA e das evidências de dotação; planilha com fórmulas e *CSV injection* neutralizadas na importação e na exportação; rotas `/internal/*` só com a credencial de serviço; operador sem acesso de suporte não lê dado do tenant.
- **LGPD:** CPF do gov.br nunca persistido em claro (HMAC), nunca em log, evento ou auditoria; relatório por responsável com aviso de uso analítico; exportações expiram em 24 h.

## 8. Dados de teste

- **Seed do MVP 2** (`tenant:seed`): catálogos novos (`PCA_CATEGORY`, `BUDGET_UNIT`, `BUDGET_ACTION`, `EXPENSE_NATURE`, `FUNDING_SOURCE`, `LEGAL_WAIVER_HYPOTHESIS`), checklist padrão do Controle Interno, modelos de regras, tipos de documento `PARECER_JURIDICO`, `MANIFESTACAO_CONTROLE_INTERNO`, `EDITAL` e `MINUTA_CONTRATO`, a v2 do workflow padrão e as unidades do §3.
- **Massa sintética do read model:** gerador determinístico de processos e movimentações por 12 a 24 meses, com sigilosos, devoluções e diligências, para J-17 e para a carga.
- **Planilhas do PCA:** modelo oficial (PCA-10) e variações inválidas (cabeçalho, tipos, linhas demais, fórmulas).
- **gov.br:** IdP fake no CI; homologação do Login Único em staging, com contas de teste nos níveis bronze, prata e ouro.

## 9. Rastreabilidade e riscos

- **Rastreabilidade:** story → cenários Gherkin (8 categorias) → testes; contagem por story e por épico em [acceptance-criteria.md §3–§4](acceptance-criteria.md#3-consolidação-por-épico). Endpoints e telas citados por story conferidos por `pnpm docs:check`.
- **Riscos de qualidade:** (1) suítes pesadas sem gate automático (DEC-190) — mitigação: endurecimento agendado antes de cada marco do plano de entrega do MVP 2 ([delivery-plan.md §5](delivery-plan.md#5-proposta-de-sequência-por-sprint) e §11; débito DT-30); (2) números do read model divergirem do transacional — mitigação: reconciliação noturna (US-171) e conferência na J-17; (3) migração com efeito irreversível — mitigação: simulação obrigatória e J-15 em staging com cópia de dados do piloto; (4) qualidade da IA sem provedor decidido — mitigação: `ai:eval` como critério da escolha (ADR-013).
