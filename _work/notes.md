# Notas de domínio por épico (anexadas aos pacotes por build_packs.py)

## EP-001
- **US-002 Lista/busca:** filtros por status, etapa, unidade atual, secretaria/setor solicitantes, responsável (eu/qualquer/sem), prioridade, tipo, modalidade, origem, ano, etiquetas, atrasado (`overdueSince`), período, prazo alvo, faixa de valor (sigilosos só entram no filtro por valor para quem pode ver — POL-09); atalhos "Comigo", "Da minha unidade", "Atrasados", "Devolvidos"; `q` FTS + trigram; predicado de visibilidade (permissions §5); p95 < 800 ms com 100 mil processos.
- **US-008:** POL-07; pausa de prazos (`pausedAt`/`pausedTotalSeconds`; retomada estende `dueAt` em dias úteis — US-055); aprovações congeladas; `PROCESS_STATUS_CHANGED`.
- **US-009:** POL-06; cancela aprovações pendentes (`ApprovalCanceled` motivo `PROCESS_CANCELED`); encerra etapa (`CANCELED`) e atribuição; documentos `IN_REVIEW` voltam a `DRAFT` (retirada automática "Processo cancelado"); descarte (PRC-06) só de rascunho sem número (`CANNOT_DISCARD_NUMBERED_PROCESS`), exclusão lógica.
- **US-010:** POL-08; transição `COMPLETE` manual ou conclusão automática ao entrar na etapa `END` após aprovação (US-052); etapa final do MVP 1 = **"Planejamento da contratação concluído"** (DEC-015); regras BLOCKING; `completedAt`.
- **US-011:** DEC-033; `copyDocuments` (estruturados como novos rascunhos; na pesquisa copia itens e fontes, **não** cotações) e `copyAttachments` (cópia lógica); novo número; workflow re-resolvido; timeline nos dois processos.
- **US-012:** POL-10; `ParticipantRole`; seguir/deixar de seguir (PRC-31/32); expiração pelo job `maintenance`; `PARTICIPANT_ADDED`; `ProcessAccess`.
- **US-013:** PRC-33; POL-09 em todos os pontos (serializador, renditions `RESTRICTED`, exportações, timeline `BUDGET_RESTRICTED`, notificações); auditoria `process.confidential_view`; art. 24 (sigilo não vale para controle interno/externo — inciso I).

## EP-002
- Wizard SCR-007 em 5 passos (Identificação; Justificativa — seções `JUSTIFICATION`/`EXPECTED_RESULTS`; Planejamento — itens `DocumentItem`, `expectedDate`, `estimatedValue`, PCA; Revisão — DOC-08 + prévia DOC-20; Conclusão — US-016). Anexos via US-068 (`targetType = DOCUMENT`).
- **US-015** criou o autosave genérico (DOC-05 com `If-Match: "s<revision>"`, `useAutosave`, `AutosaveIndicator`, diálogo de conflito, IndexedDB) reutilizado por ETP/TR/documentos livres.
- **US-016:** "Concluir e enviar para aprovação" = PRC-19 para `APROVACAO_DFD` (submete o DFD — DEC-018 — e cria a `Approval` — US-051); sem permissão de encaminhar → "Finalizar DFD" (DOC-10).
- **US-017:** efeitos da decisão (US-052): APPROVED → propaga `estimatedValue` (DEC-032), `ProcessItem.referenceQuantity`, PCA do processo (auditado) e prioridade (regra documentada); RETURNED → DFD `RETURNED`, processo `RETURNED` em `ABERTURA`; REJECTED → DFD `REJECTED`, processo `RETURNED`, sugestão de cancelamento (PEND-02); reabertura DOC-12.
- **US-018 (P2):** duplicar DFD para novo processo (via US-011) ou para processo existente sem DFD em etapa que permita DFD.

## EP-003
- ETP (art. 6º XX; art. 18 §1º I–XIII e §2º; IN SEGES/ME 58/2022): 16 seções; tabela seção × inciso × `requirement`: I (NEED_DESCRIPTION), IV e VI (ESTIMATES), VIII (PARCELING), XIII (CONCLUSION) = `REQUIRED`; II PCA_ALIGNMENT, III REQUIREMENTS, V MARKET_SURVEY/ALTERNATIVES, VII RECOMMENDED_SOLUTION, IX EXPECTED_RESULTS, X PRIOR_MEASURES, XI RELATED_CONTRACTS, XII ENVIRONMENTAL_IMPACTS, RISKS = `REQUIRED_OR_JUSTIFY`; PROBLEM e OBJECTIVE `OPTIONAL` — configuração semeada (DEC-016).
- **US-019:** ETP-02 com `importFromDfd` (objeto/justificativa → NEED_DESCRIPTION; itens → `DocumentItem`; PCA → PCA_ALIGNMENT; `importedFromDfdVersionId`).
- **US-020:** navegação lateral com completude; `NOT_APPLICABLE` com justificativa ≥ 20; seções renderizadas (`ALTERNATIVES_TABLE`, `ITEMS_TABLE`, `RISK_LIST`); comentários ancorados (US-071).
- **US-021:** ETP-05..09; RECOMMENDED/DISCARDED com justificativa; uma recomendada (`RECOMMENDED_ALTERNATIVE_EXISTS`/`replaceRecommended`); quadro comparativo.
- **US-022:** `calculationMemo` por item; valor manual ou vinculado à pesquisa (`priceResearchId`), atualizado na conclusão/recálculo; mascarado se sigiloso.
- **US-023:** completude (template + `conclusion ≠ PENDING`, `parcelingDecision`, uma RECOMMENDED se `VIABLE`, itens > 0, valor presente ou justificado) com códigos `ETP_*` em `violations[]`; finaliza (DOC-10); aprovação formal na etapa da autoridade (US-052); `NOT_VIABLE` → aviso.

## EP-004
- Base: Lei 14.133 art. 23 §1º I–V; art. 24; IN SEGES/ME 65/2021 — prudência nas citações; limiares são configuração (PEND-04).
- **US-029:** sobre cotações `VALID`: n, média, mediana, menor, maior, desvio amostral (n−1), CV; `AUTO_CV` → MEDIAN se CV > limite, senão MEAN; `LOWEST`; `MANUAL` justificado; arredondamento por `unitPriceDecimals`/`roundingMode`; total = round(unit × qtd, 2); `decimal.js`; exemplos numéricos nos cenários.
- **US-030:** cada cotação × mediana das **demais** (≥ 2): abaixo de `outlierLowerPercent` → `LOW`; acima de `outlierUpperPercent` → `HIGH`; só sinaliza; `isExpired` por `maxAgeDays`/`ageReference` vs `referenceDate`; alertas `BELOW_MINIMUM_QUOTES`, `HIGH_CV`, `HAS_OUTLIERS`, `EXPIRED_QUOTES`, `NO_VALID_QUOTES`.
- **US-026:** campos exigidos por tipo de fonte (`QUOTATION_REQUIRED_FIELDS`), anexo (`PRICE_SOURCE`), grade de preços por fonte (PRS-13), fornecedor (US-025).
- **US-027:** `ExclusionReason` + justificativa ≥ 20; restaurar; timeline/auditoria.
- **US-028 (P2):** modelo XLSX, prévia com erros por linha (PRS-18, token 15 min), aplicação (PRS-19).
- **US-031:** matriz itens × fontes; XLSX síncrono até 500 × 50 (`EXPORT_TOO_LARGE`); PDF via rendition `PRICE_SUMMARY`; POL-09.
- **US-032:** `PRICE_RESEARCH_INCOMPLETE` com `violations[]` `PRICE_*`; finaliza (`PriceResearchCompleted`); atualiza `referenceUnitPrice`, `Process.estimatedValue`, valor do ETP vinculado.
- **US-025:** CNPJ alfanumérico (IN RFB 2.229/2024: 12 `[0-9A-Z]` + 2 DV módulo 11 com ASCII − 48) e numérico; CPF criptografado/mascarado; dedup por blind index; exclusão só sem uso.

## EP-005
- Escala/faixas configuráveis (`risk.scale`, `risk.levelThresholds`, padrão 5×5 — PEND-15) com `scaleSnapshot`; `score = P × I`; categorias `RISK_CATEGORY`; `RiskPhase`; residual opcional; códigos R01…; tratamentos (US-034); matriz 5×5 (RSK-09) e documento `RISK_MAP` (RSK-10, `RISK_MAP_SUBMIT`, códigos `RISK_*`); após finalizado, riscos bloqueados até reabertura; seção `RISKS` do ETP usa `RISK_LIST`.

## EP-006
- TR (art. 6º XXIII a–j; IN SEGES/ME 81/2022): 14 seções; tabela seção × alínea × `requirement`; campos tipados (vigência, prazo e tipo, local, pagamento, garantia do objeto, garantia contratual ≤ 10% — arts. 96–98 —, subcontratação, `JUDGMENT_CRITERION` — art. 33 —, adjudicação, valor estimado).
- **US-037:** `importMappings` (§5.8), prévia por seção REPLACE/APPEND (TRM-05), aplicação (TRM-06) rastreável, `TermImportedFromEtp`, aviso quando o ETP mudar após a importação.
- **US-039:** completude + **avisos determinísticos de consistência com o ETP** (`TR_*` WARNING: quantidade por item, garantia); IA só no MVP 5; finaliza → `TermCompleted`.

## EP-007
- **US-041:** motor puro — `getAvailableActions` (FORWARD/COMPLETE com destinos e unidades; RETURN para etapas percorridas; ações de ciclo de vida com `enabled`/`reasons[]`) e `evaluateRules` (RuleContext v1; `REQUIRED_DOCUMENT` com `minStatus`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION` via json-logic-js whitelisted); PRC-08/PRC-09; `DepartmentResolution`; `StageAssignmentPolicy`; fachada `WorkflowFacade` consumida pela tramitação; fast-check.
- **US-042:** semeia **dois** workflows (DEC-015): padrão (7 etapas, etapa final "Planejamento da contratação concluído") e **contratação direta art. 72** (ABERTURA → APROVACAO_DFD → INSTRUCAO → AUTORIZACAO → CONCLUSAO; DISPENSA/INEXIGIBILIDADE); SLAs sugeridos (ABERTURA 5, APROVACAO_DFD 3, ESTUDOS 15, PESQUISA 10, TR 10, AUTORIDADE 5 dias úteis); `instructions` pt-BR por etapa; WF-05/WF-06; seeder no provisionamento.
- **US-043 (P1):** SCR-034 — tabela de etapas + painel lateral; transições; salvar com `If-Match`; cópia da publicada (`WORKFLOW_DRAFT_EXISTS`).
- **US-044 (P1):** SCR-035 — construtor por tipo, campo via WF-19, condição com react-querybuilder → JSON Logic; "Testar regra" (dry-run) contra processo existente.
- **US-045 (P1):** WF-20/21/22; `WF_*` (api §2.3); processos ficam na versão fixada; `WORKFLOW_IN_USE`.
- **US-046 (P2):** diagrama somente leitura (React Flow + elkjs).

## EP-008
- **US-048:** `{ targetStageId, comment ≥ 10, dueAt? }`; status RETURNED; `PREVIOUS_ASSIGNEE`; documentos não mudam sozinhos (POL-11); em AWAITING_APPROVAL a devolução é pela decisão RETURN ou pela retirada (US-053).
- **US-049** CLAIM (POL-04); **US-050** atribuir `{ assigneeId | null, reason }` (POL-05: gestor ou titular/substituto).
- **US-051:** `Approval` na entrada de etapa APPROVAL e na submissão avulsa (DOC-09); resolução: USER; ROLE = atribuição que cubra a **unidade solicitante** (DEC-022/POL-03 — não CURRENT/HISTORICAL); DEPARTMENT_HEAD (+ substituto); `APPROVER_UNRESOLVED` desfaz o encaminhamento; `ApprovalDocument` com versões exatas; `ProcessAccess` APPROVER.
- **US-052:** APV-03 com `If-Match`; POL-03 (designação, segregação, processo não suspenso); efeitos atômicos (documentos conforme DEC-018 inclusive FINALIZED/APPROVED; rendition `APPROVAL_STAMPED`; transição; COMPLETED se END; nova aprovação se próxima etapa for APPROVAL; ganchos `onDocumentApproved`); SCR-015 utilizável em mobile; decisões simultâneas → `APPROVAL_NOT_PENDING`/412.
- **US-053 (P1):** retirada (DOC-11; APV-04 → movimento RETURN com `metadata.withdrawn`); redirecionamento APV-05.
- **US-054:** PRC-11; IP visível só com `AUDIT_VIEW`. **US-055:** `dueAt` fim do dia útil (CAL-06); job `deadlines` 15 min; `ProcessStageDueSoon`/`ProcessStageOverdue`; `overdueSince`; pausa/retomada.

## EP-009
- **US-056 (TSK-01/02):** visões "Comigo", "Na fila da minha unidade" (titulares veem a fila da unidade), "Aprovações pendentes" (direto, perfil cobrindo a unidade solicitante, titular, substituto), "Devolvidos", "Atrasados", "Acompanhando"; contadores; ordenação; ações rápidas; UNION com índices (DEC-026) p95 < 500 ms; polling 60 s. **US-057** APV-01 com filtros. **US-058 (P2)** lote TSK-03/04, máx. 50.

## EP-010
- **US-059:** `TimelineProjector` síncrono (events §5), idempotente por `sourceEventId`, nomes congelados, `BUDGET_RESTRICTED`, registro `TimelineEntryType`; não é auditoria (DEC-025). **US-060:** PRC-12 por cursor, filtros por grupo/ator/período, agrupamento por dia, p95 < 300 ms.

## EP-011
- **US-062:** painel por tipo, selo **"Em aprovação"** quando `pendingApprovalId` (DEC-018), menu "Criar documento" pelos tipos da etapa, `RESTRICTED` mascarado.
- **US-063 (P1):** `FREE_TEXT` com numeração e autosave (US-015). **US-064 (P1):** `UPLOADED` com versões (DOC-19), prévia inline; DOCX→PDF via Gotenberg como P2.
- **US-065:** `DocumentLifecycleService` (DEC-018) + interface `DocumentValidator` dos módulos tipados (DOC-08, `violations[]` api §2.1.2); POL-02/POL-11; `singletonKey`; numeração; `typedSummary`; auditoria coalescida.
- **US-066:** snapshot JCS + SHA-256, imutabilidade, "Salvar versão", comparação (SCR-106). **US-067:** fila `document-render`, renderizadores de seção, Gotenberg, `PREVIEW` 24 h com marca d'água, `APPROVAL_STAMPED`, rodapé com hash, p95 < 30 s.
- **US-068/069:** fluxo DEC-136 completo (storage.md), CORS do bucket para o visualizador, auditoria de download; ClamAV fora → nunca libera sem scan. **US-070 (P2):** presença Redis TTL 60 s/heartbeat 20 s.

## EP-012
- **US-072 (P1):** autocomplete `@` (CMT-05) só com quem tem visibilidade; unidades (máx. 50 membros); `MENTIONED`; sugerir adicionar participante.

## EP-013
- **US-073:** `AuditService` na transação; mascaramento; rich text como hash + tamanho; contexto da requisição; coalescência de `document.draft_update`; amostragem de `access.denied`; partições mensais; `rowHash`; meta-teste de rotas mutáveis. **US-074 (P1):** selagem horária por tenant (`digest`, `chainHash`), AUD-05 verifica. **US-075:** filtros com período ≤ 90 dias, cursor, diff, exportação CSV/NDJSON até 100 mil (`EXPORT_TOO_LARGE`), anti CSV injection, `audit.search`/`audit.export`, MFA; tenant `OFFBOARDING` = leitura/exportação (DEC-132).

## EP-014
- **US-076:** widgets por perfil (pendências, por status, por etapa, atrasados, próximos do prazo, tempo médio por etapa 90 dias, abertos por mês, valor por secretaria respeitando POL-09, atividade recente); filtros; visibilidade §5; cache 60 s; paleta acessível; p95 < 1 s.

## EP-015
- **US-078:** Compose com PostgreSQL 17 + pgvector (bancos `contrataflow` e `authentik`), **dois Redis lógicos** (sessões × cache/filas — DEC-131), MinIO + bootstrap, Authentik (server+worker, blueprint com provider/flows/usuários por persona), Mailpit, Gotenberg, ClamAV, perfil `observability`; seeds de "Prefeitura A" e "Prefeitura B".
- **US-079:** GitHub Actions (PEND-10): lint, typecheck, unit, integração, E2E, build, drift de migração, diff de OpenAPI, dependency-cruiser, gitleaks, CodeQL/Semgrep, audit, SBOM, trivy, cobertura.
- **US-080:** módulos (DEC-041), config Zod, filtro RFC 9457 com §2.1.1/§2.1.2/§2.3, guards, OpenAPI interno, throttler Redis, idempotência, paginação, AsyncLocalStorage.
- **US-081:** Prisma (`@map`), UUIDv7, decimais, concorrência otimista, `TenantTransaction`, SQL bruto (RLS, triggers, partições), papéis `cf_owner/cf_app/cf_relay/cf_readonly_report`, pool compatível com `set_config` local.
- **US-082:** `OutboxWriter`, registro de eventos, handlers síncronos, relay `SKIP LOCKED` + `LISTEN/NOTIFY`, `jobId = eventId`, fan-out por routing key, purga.
- **US-083:** worker standalone, filas DEC-163, job base com contexto (DEC-164), retries/jitter, `dead-letter`, schedulers únicos, Bull Board (`PLATFORM_QUEUE_ADMIN`).
- **US-084:** pino + redact, `X-Correlation-Id`, OpenTelemetry. **US-085 (P1):** health/metrics/dashboards/alertas (observability.md). **US-086:** App Router, layout, `packages/ui`, Storybook, next-intl, cliente de API, query keys `['t', tenantId, …]`, `<Can>`, SCR-111, CSP.

## EP-016
- **US-089:** fluxo de recuperação do Authentik, mensagens que não revelam conta, senha ≥ 12 + vazadas.
- **US-090 (P1):** `security.mfaPolicy`; TOTP/WebAuthn; `amr`/claim; `MFA_REQUIRED` → `/api/auth/step-up`; recuperação; reset pelo admin via API do Authentik.
- **US-091:** USR-03..06 (convite, `User` global + usuário Authentik, token 7 dias, aceite, `MEMBERSHIP_ALREADY_EXISTS`, `INVITATION_EXPIRED`). **US-092:** USR-01/07..12 (efeito imediato em sessões/cache; POL-12/16; nome/e-mail são globais).
- **US-093 (P1):** SCR-101 — troca do **tenant ativo** ("instituição contratante" — DEC-012) via `/api/auth/switch-tenant`, reset do cache do front, `auth.tenant_switch`.
- **US-094:** `permissions.ts` + migração; seeder dos 15 perfis (matriz §3.2) incl. `allowExternalAssignment` em AUDITOR/CONSULTOR_EXTERNO. **US-095:** ROL-02..08 (POL-12/13). **US-096:** ROL-09..12 (POL-12/13/15/16, `ROLE_CHANGED`, `EXTERNAL_HIGH_RISK_ROLE`). **US-097:** `AuthorizationService`, cache, decorators, POL-01..16, predicado de visibilidade reutilizável, ME-03, hooks do front, meta-teste, overhead p95 < 5 ms. **US-098 (P1):** ME-01/02, atalhos Authentik, sessões ativas como P2.

## EP-017
- **US-101:** ORG-01..04 (CNPJ alfanumérico, sigla única, logotipo `TENANT_ASSET`). **US-102:** DEP-01..09 (árvore, mover recalcula `path`, `DEPARTMENT_CYCLE`, titular/substituto, ativar/desativar, `DEPARTMENT_HAS_REFERENCES`, "Secretaria" = `SECRETARIAT`/`BOARD`/raízes).
- **US-103:** registro tipado §6 com Zod; grupos na SCR-041; `SETTING_KEY_UNKNOWN`; `If-Match` por chave; auditoria anterior/novo; SET-03 público. **US-104:** CAT-01..06, itens de sistema imutáveis (`CATALOG_ITEM_SYSTEM`), `metadata` validada (§5.9). **US-105:** `NumberingFacade`, tokens, prévia SET-04, CREATE/START, virada de ano no fuso, mudança de escopo (exige `{org}` em `ORGANIZATION`; efeito no exercício seguinte), concorrência, `NUMBERING_MASK_INVALID`. **US-106 (P1):** feriados, recorrentes, Páscoa (Meeus/Butcher), `BusinessCalendarFacade`, sem recálculo retroativo (ação P2).

## EP-018
- **US-107:** editor SCR-033/SCR-114 (`SectionDefinition` completo, variáveis, `fieldConfig`, `TEMPLATE_INVALID`, `TEMPLATE_DRAFT_EXISTS`). **US-108:** publicar/aposentar (TPL-10/11), imutável com `contentHash`, padrão do tipo (DTY-04), sem efeito retroativo. **US-109 (P1):** `LayoutDefinition` + prévia TPL-09. **US-110:** biblioteca semeada (DFD, ETP com incisos do art. 18, TR com alíneas do art. 6º XXIII, RISK_MAP, PRICE_RESEARCH, DESPACHO, OFICIO, **NOTA_TECNICA adequada à justificativa de escolha do fornecedor/preço da contratação direta**, AUTORIZACAO, DECLARACAO) e atualização da biblioteca pela plataforma (adoção opcional).

## EP-019
- **US-111:** NTF-01..05; `NotificationDispatcher` (events §6: destinatários, nunca o ator, visibilidade, preferências, `groupKey` 5 min, idempotência). **US-112:** `EmailSender` (SMTP/SES), templates pt-BR + texto, retentativas, bounces registrados, convite e `ROLE_CHANGED`, sem dados sigilosos, SPF/DKIM/DMARC. **US-113 (P2):** ME-05/06. **US-114 (P1):** `STAGE_DUE_SOON`/`STAGE_OVERDUE` sem duplicidade, escalonamento ao titular.
