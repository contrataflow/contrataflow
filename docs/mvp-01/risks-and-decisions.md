# MVP 1 — Riscos, Débitos Técnicos, Decisões e Pontos em Aberto

> Fechamento do MVP 1 exigido pelo produto: riscos técnicos, legais, de segurança, de multi-tenancy e de performance; débitos técnicos assumidos; decisões de arquitetura; pontos ambíguos; regras configuráveis; regras que precisam de decisão de produto; integrações externas.
> Decisões canônicas: [decisions.md](../architecture/decisions.md). Plano: [delivery-plan.md](delivery-plan.md).

Sumário: [1. Riscos técnicos](#1-riscos-técnicos) · [2. Riscos legais](#2-riscos-legais-e-regulatórios) · [3. Segurança](#3-riscos-de-segurança) · [4. Multi-tenancy](#4-riscos-de-multi-tenancy) · [5. Performance](#5-riscos-de-performance) · [6. Débitos técnicos](#6-débitos-técnicos-assumidos) · [7. Pontos ambíguos](#7-pontos-ambíguos-do-pedido-e-interpretação-adotada) · [8. Decisões de produto](#8-regras-que-precisam-de-decisão-de-produto) · [9. Regras configuráveis](#9-regras-configuráveis) · [10. Integrações externas](#10-integrações-externas) · [11. Decisões de arquitetura](#11-decisões-de-arquitetura-do-mvp-1) · [12. Preparação para o MVP 2](#12-validação-para-iniciar-o-mvp-2)

Escala: **Probabilidade** e **Impacto** em Baixa/Média/Alta.

---

## 1. Riscos técnicos

| ID | Risco | Prob. | Impacto | Mitigação | Dono |
|---|---|---|---|---|---|
| RT-01 | Motor de workflow e regras (US-040/041) ficar complexo demais e atrasar o caminho crítico | Média | Alta | Escopo fechado de tipos de regra (DEC-016); motor puro e testado por propriedades; workflow padrão semeado antes do editor (editor é P1) | Tech Lead |
| RT-02 | RLS + Prisma (contexto por transação) gerar *overhead* ou incompatibilidade com pool de conexões | Média | Alta | Spike na Sprint 0; `set_config(…, true)` em transação; RDS Proxy/PgBouncer em modo transação validado; teste de carga na sprint 4 | Plataforma |
| RT-03 | Geração de PDF fiel (tabelas, quebras de página, fontes) consumir mais esforço que o previsto | Alta | Média | Gotenberg + CSS de impressão padronizado; componentes de seção renderizados no servidor; biblioteca de templates com testes de regressão visual (hash do PDF determinístico) | Documentos |
| RT-04 | Autosave por seção com conflitos frequentes em documentos colaborativos | Média | Média | Revisão por seção (DEC-055), diálogo de conflito, presença (P2); orientação de UX para divisão de trabalho por seção | Front |
| RT-05 | Outbox/relay com atraso ou perda de eventos sob falhas | Baixa | Alta | `FOR UPDATE SKIP LOCKED`, `jobId = eventId`, idempotência dos consumidores, métricas de lag e alertas (observability.md) | Plataforma |
| RT-06 | Cálculos de pesquisa de preços com erros de arredondamento | Média | Alta | `decimal.js`, testes com casos numéricos de referência validados pelo piloto, snapshot de parâmetros por pesquisa | Pesquisa |
| RT-07 | Integração com Authentik (provisionamento por API, MFA, *step-up*) mais trabalhosa que o previsto | Média | Média | *Blueprint* versionado, ambiente local idêntico, spike na Sprint 0; fallback: convite apenas por fluxo de enrollment | Identidade |
| RT-08 | Esforço de UI subestimado (wizards, editor TipTap, tabelas densas) | Alta | Média | Design system cedo (US-086), componentes reutilizáveis (Stepper, DataTable, AutosaveIndicator, DepartmentTreeSelect), protótipos 1–2 sprints à frente | Designer + Front |
| RT-09 | Dependência de versões recentes (Next.js, NestJS, Prisma) com *breaking changes* | Média | Baixa | Versões fixadas em US-077; Renovate com janela de atualização; testes de contrato | Tech Lead |
| RT-10 | Volume de documentação/especificação divergir do código ao longo do tempo | Alta | Média | Fontes canônicas versionadas no repositório; CI valida eventos/permissões/rotas contra registros; DoD exige atualização do card | PO + Tech Lead |

## 2. Riscos legais e regulatórios

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RL-01 | Interpretações divergentes da Lei 14.133/2021 entre entes e Tribunais de Contas (TCEs) | Alta | Alta | Regras e templates **configuráveis** (DEC-016, DEC-027); textos padrão com base legal citada e aviso de revisão pelo jurídico do órgão; consultoria jurídica especializada para a biblioteca padrão |
| RL-02 | Documentos produzidos no MVP 1 **não são assinados eletronicamente** (assinatura chega no MVP 3) | Alta | Alta | Comunicar claramente aos pilotos; permitir anexar a versão assinada externamente como documento `UPLOADED`; hash SHA-256 no rodapé para conferência; priorizar assinatura no MVP 3 (Lei 14.063/2020) |
| RL-03 | Metodologia de pesquisa de preços contestada (IN SEGES/ME 65/2021 × decretos municipais) | Média | Alta | Método, mínimo de cotações, validade e faixas de outlier configuráveis (DEC-020) com snapshot por pesquisa e justificativas obrigatórias auditadas |
| RL-04 | Vazamento de orçamento sigiloso (art. 24) | Baixa | Alta | POL-09 centralizada no serializador, renditions `RESTRICTED`, testes específicos, auditoria `process.confidential_view` |
| RL-05 | LGPD: dados pessoais de servidores, fornecedores pessoa física e conteúdo de comentários | Média | Média | Minimização, criptografia de CPF (DEC-086), logs sem PII (DEC-138), papéis controlador × operador em contrato, canal de titulares, inventário em security.md |
| RL-06 | Retenção e eliminação de documentos públicos (Lei 8.159/1991, tabelas de temporalidade) × LGPD | Média | Média | Nada é excluído fisicamente no MVP 1 (DEC-034); PEND-07 com apoio arquivístico antes do MVP 3 |
| RL-07 | Acessibilidade exigida para serviços públicos (Lei 13.146/2015 — LBI; eMAG) | Média | Média | WCAG 2.1 AA + eMAG 3.1 (DEC-183), axe no CI, testes com leitor de tela por marco |
| RL-08 | Responsabilização do agente público por conteúdo gerado/sugerido pela plataforma | Baixa (MVP 1) | Alta | Plataforma não decide; decisões humanas registradas (aprovações, justificativas); textos padrão como sugestão editável; IA só no MVP 5 e sempre assistiva |
| RL-09 | Prazo de adequação dos municípios até 20 mil habitantes (art. 176, até abr/2027) pressionar o cronograma comercial | Média | Média | Marcos incrementais (M3/M4) já utilizáveis por pilotos; priorização P0 estrita |

## 3. Riscos de segurança

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RS-01 | Acesso indevido a processo (IDOR) por falha de visibilidade | Média | Alta | Predicado único de visibilidade (permissions.md §5) reutilizado; 404 para não visíveis; suíte de autorização gerada da matriz; revisão de segurança por card |
| RS-02 | Escalonamento de privilégio via perfis/atribuições | Baixa | Alta | POL-13 (anti-escalonamento), POL-15 (externos), MFA para permissões `HIGH`, auditoria `SECURITY`, notificação `ROLE_CHANGED` |
| RS-03 | XSS por conteúdo rico (TipTap) ou comentários | Média | Alta | Validação do JSON contra schema permitido, HTML gerado só no servidor e sanitizado, CSP estrita com nonce |
| RS-04 | Upload malicioso (malware, polyglots, arquivos enormes) | Média | Alta | Quarentena + ClamAV + magic bytes + allowlist + limites + download como `attachment` (DEC-136) |
| RS-05 | Sequestro de sessão / CSRF no BFF | Baixa | Alta | Cookie `__Host-` `HttpOnly` `Secure` `SameSite=Lax`, header `X-CF-Request`, verificação de `Origin`, rotação de sessão no login, expiração por ociosidade |
| RS-06 | Configuração incorreta do Authentik (redirect URIs, flows, MFA) | Média | Alta | *Blueprints* versionados e revisados; testes E2E de login/MFA; checklist de hardening do IdP |
| RS-07 | Abuso por endpoints caros (exportações, PDF, recálculo) — negação de serviço | Média | Média | Rate limits por classe (api.md §1.6), limites de tamanho, filas com concorrência controlada |
| RS-08 | SSRF por URLs informadas em fontes de preço | Baixa | Alta | URLs **nunca** são buscadas pelo servidor no MVP 1 (apenas armazenadas e exibidas como link `rel="noopener noreferrer"`) |
| RS-09 | Vazamento de segredos (repositório, logs, imagens) | Baixa | Alta | gitleaks no CI, Secrets Manager, redaction no pino, imagens sem segredos, rotação |
| RS-10 | Insider (administrador do tenant ou operador da plataforma) abusar de acesso | Baixa | Alta | Auditoria append-only com selagem (ADR-009), acesso de suporte temporário e visível ao tenant (DEC-139), separação de papéis de banco |
| RS-11 | Cadeia de suprimentos (dependências npm comprometidas) | Média | Alta | Lockfile, Renovate com revisão, `pnpm audit`, SBOM, scan de imagens, política de novas dependências |

## 4. Riscos de multi-tenancy

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RM-01 | Consulta sem filtro de tenant (SQL bruto, relatório, job) | Média | Alta | Tripla defesa: extensão Prisma + RLS `FORCE` + FKs compostas (ADR-002); revisão obrigatória de SQL bruto; suíte "tenant leak" no CI (US-100) |
| RM-02 | Contexto `app.tenant_id` vazar entre requisições via pool de conexões | Baixa | Alta | `set_config(…, true)` limitado à transação; proibido `SET` de sessão; teste de concorrência com tenants alternados |
| RM-03 | Chaves de cache sem tenant | Média | Alta | Wrapper `TenantCache` obrigatório; lint/regra de arquitetura proibindo uso direto do cliente Redis fora do wrapper |
| RM-04 | Objetos no storage acessíveis entre tenants | Baixa | Alta | Prefixo `tenants/{tenantId}/…` gerado por helper único; URLs pré-assinadas só após autorização; buckets privados |
| RM-05 | Jobs executados sem contexto ou com contexto errado | Média | Alta | Classe base de job que exige `tenantId` (DEC-164); testes de fila |
| RM-06 | *Noisy neighbor* (um tenant degradar os demais) | Média | Média | Rate limit por tenant, concorrência por tenant nas filas, monitoramento por tenant via logs |
| RM-07 | Divergência de catálogos/templates copiados no provisionamento ao evoluir a plataforma | Alta | Média | Códigos estáveis (DEC-027); processo de atualização de biblioteca com adoção opcional (US-110); migrações de seed versionadas |
| RM-08 | Consultor externo com vínculo em vários tenants misturar dados | Baixa | Alta | Um tenant ativo por sessão (DEC-132), reset de cache do front na troca (US-093), auditoria `auth.tenant_switch` |

## 5. Riscos de performance

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| RP-01 | Lista de processos com predicado de visibilidade (EXISTS em `process_access`) lenta em tenants grandes | Média | Alta | Índices dedicados (entities.md), plano de consulta revisado com 100 mil processos/tenant, paginação obrigatória, `EXPLAIN` no CI de performance |
| RP-02 | Caixa de tarefas (UNION) lenta | Média | Média | Índices parciais `WHERE status = 'ACTIVE'`/`PENDING`; read model dedicado como débito monitorado (DEC-026) |
| RP-03 | Volume da auditoria (escritas e consultas) | Alta | Média | Particionamento mensal, filtros obrigatórios por período, coalescência de autosave, exportação em streaming |
| RP-04 | Contenção na sequência de numeração | Baixa | Média | Transações curtas; meta p95 < 600 ms na criação; métrica `numbering.lock_wait` |
| RP-05 | Renderização de PDF em pico (fim de exercício) | Média | Média | Escala horizontal do Gotenberg e do worker por profundidade de fila; prioridade para `CONTENT` sobre `PREVIEW` |
| RP-06 | Documentos grandes (JSONB de rascunho com várias seções de até 1 MB) | Média | Média | Autosave por seção (payload pequeno), limites por seção, compressão TOAST do PostgreSQL, carregamento sob demanda das seções no editor |
| RP-07 | Dashboard com agregações custosas | Média | Média | Cache Redis 60 s por escopo; consultas agregadas com índices; materialized views avaliadas no MVP 2 (Indicadores) |
| RP-08 | Recálculo da pesquisa de preços com muitas cotações | Baixa | Baixa | Recálculo incremental por item; recálculo total em lote assíncrono acima de um limiar |

## 6. Débitos técnicos assumidos

| ID | Débito | Motivo | Quando pagar |
|---|---|---|---|
| DT-01 | Caixa de tarefas como consulta (sem read model) | Simplicidade (DEC-026) | Quando p95 > 500 ms em produção |
| DT-02 | Sem migração de processos em andamento entre versões de workflow | Complexidade/risco (DEC-014) | MVP 2 |
| DT-03 | Uma etapa ativa por processo (sem paralelismo) e aprovação `ANY` | Escopo (PEND-13) | MVP 2 |
| DT-04 | Busca apenas com PostgreSQL FTS + trigram | Suficiente para MVP 1 (DEC-057) | MVP 5 (semântica) |
| DT-05 | Selagem de auditoria sem carimbo de tempo externo (TSA/ICP) | Custo × benefício | MVP 3 (assinatura) |
| DT-06 | PDF comum (não PDF/A) | PEND-09 | MVP 3 |
| DT-07 | Provisionamento de tenant sem UI de backoffice | Pilotos poucos | MVP 2 |
| DT-08 | Tratamento mínimo de *bounces* de e-mail (sem webhook do SES; `emailError` atualizado pelo suporte — US-112) | Volume baixo | Pós-release |
| DT-09 | Sem chave KMS por tenant | Recurso enterprise | Sob demanda comercial |
| DT-10 | Feature flags simples por tenant (sem rollout percentual) | DEC-059 | Quando houver dezenas de tenants |
| DT-11 | Presença de edição e preferências de notificação como P2 | Escopo | Pós-release |
| DT-12 | Sem importação de CATMAT/CATSER (código digitado) | Integração externa | MVP 3/5 |
| DT-13 | Sem reativação de perfil desativado (alternativa: duplicar — ROL-07) | Escopo (US-095) | MVP 2 |
| DT-14 | Quebra do selo de auditoria só por alerta operacional (A21), sem `NotificationType` ao `ADMIN_ORGAO`/`AUDITOR` | Escopo (US-074) | MVP 2 |
| DT-15 | Atualização da biblioteca padrão de templates por adoção manual (sem diff por `contentHash`) | Escopo (US-110) | MVP 2 |
| DT-16 | Lote da caixa de tarefas fixo em 2–50 itens (não configurável por tenant) | Simplicidade (US-058) | Avaliar no MVP 2 |
| DT-17 | `Approval.dueAt` nulo em submissões avulsas de documento | Escopo (US-051) | MVP 2 (prazo por `DocumentType`) |
| DT-18 | Acesso de suporte da plataforma (DEC-139) sem tela no MVP 1 (operação pela CLI/API de plataforma, auditada) | Pilotos poucos (DT-07) | MVP 2 |

## 7. Pontos ambíguos do pedido e interpretação adotada

| # | Ponto | Interpretação adotada | Onde está |
|---|---|---|---|
| A-01 | "Código interno" do processo | Número externo opcional do órgão (protocolo/SEI), único quando preenchido | DEC-028, US-001 |
| A-02 | "Origem" do processo | Origem de negócio (catálogo `PROCESS_ORIGIN`); canal técnico separado em `creationChannel` | PEND-14 |
| A-03 | "Responsável atual" | Usuário (`currentResponsibleId`, pode ser nulo = fila) **e** unidade (`currentDepartmentId`) | entities.md |
| A-04 | "Etapa atual" | Etapa do workflow (`currentWorkflowStageId` + instância `currentStageId`), distinta do status | DEC-013 |
| A-05 | Status "concluído" × "publicado" | Concluído = planejamento da contratação concluído (MVP 1; a fase preparatória completa só no MVP 2 — DEC-015); publicado = após publicação (MVP 3) | DEC-013, PEND-16 |
| A-06 | Ação "rejeitar" × "devolver" | Devolver = corrigir e reenviar; rejeitar = indeferir (documento `REJECTED`, processo volta e sugere cancelamento) | DEC-022, PEND-02 |
| A-07 | Ação "concluir" do workflow | Concluir o processo (fase preparatória) — transição `COMPLETE`/entrada em `END`; concluir documento = "finalizar" | DEC-018, US-010 |
| A-08 | "Assumir" | Membro da unidade toma para si um processo que está na fila da unidade | POL-04 |
| A-09 | "Toda tramitação registra documentos" | Snapshot das versões dos documentos destacados no encaminhamento | `ProcessMovement.documents` |
| A-10 | "IP" da tramitação | IP do cliente obtido do `X-Forwarded-For` confiável (ALB/BFF), nunca do header bruto do usuário | security.md |
| A-11 | "PCA vinculado" no MVP 1 sem módulo PCA | Referência textual + status; FK no MVP 2 | DEC-029 |
| A-12 | DFD "quantidade/unidade" no singular | Itens do DFD (`DocumentItem`), permitindo um ou vários | DEC-019 |
| A-13 | DFD "template" | Template versionado do tipo DFD (seções e textos padrão), não "modelo pré-preenchido" de outro DFD (isso é duplicação) | US-014, US-018 |
| A-14 | DFD "duplicação" | Para novo processo ou para processo existente sem DFD | US-018 |
| A-15 | Pesquisa: "FontePesquisa" | Instância de evidência (`PriceSource`) + tipo em catálogo | DEC-020 |
| A-16 | Pesquisa: "desvio" | Desvio-padrão amostral (n−1) e coeficiente de variação | US-029 |
| A-17 | Pesquisa: "valor recomendado" | Pelo método configurado (`AUTO_CV`, média, mediana, menor) ou manual justificado | DEC-020 |
| A-18 | Pesquisa: "exclusão justificada" | Desconsiderar a cotação no cálculo (mantida no registro), não excluir | US-027 |
| A-19 | Riscos: "prazo", "prevenção", "contingência" | Pertencem às ações de tratamento (`RiskTreatment`) | DEC-021 |
| A-20 | TR: "importar dados do ETP" | Cópia rastreável com prévia (não vínculo vivo), com aviso de ETP alterado | US-037 |
| A-21 | TR: "garantias" | Garantia do objeto (meses) e garantia contratual (%) | entities.md |
| A-22 | "Template" geral | Template versionado por tipo de documento com layout de impressão | EP-018 |
| A-23 | Telas "Login" e "Recuperar senha" | Fluxos do Authentik com identidade visual + página de entrada do ContrataFlow | US-087, US-089 |
| A-24 | "Regras" (tela 35) no MVP 1 | Regras de etapa/transição dentro do editor de workflow; biblioteca de regras no MVP 2 | US-044 |
| A-25 | "Fiscal" e "Gestor de contrato" no MVP 1 | Perfis existem com leitura (e abertura de demandas pelo gestor); ampliados no MVP 4 | permissions.md |
| A-26 | "Auditor" | Perfil interno de leitura + auditoria; auditor externo (TCE) entra como `EXTERNAL` com validade | permissions.md |
| A-27 | "Consultoria externa" | Vínculo `EXTERNAL` com validade + participação `CONSULTANT` por processo | DEC-036 |
| A-28 | "Notificações" — canais | In-app e e-mail no MVP 1; WhatsApp/push avaliados depois | EP-019 |
| A-29 | "Secretaria solicitante" em estruturas não municipais | Rótulo configurável; unidades de tipo `SECRETARIAT`/`BOARD` ou raízes | DEC-011, US-001 |

## 8. Regras que precisam de decisão de produto

Lista viva baseada em [decisions.md §10](../architecture/decisions.md#10-decisões-pendentes), com o prazo-limite em que a decisão precisa ser tomada para não impactar o plano:

| ID | Decisão | Padrão adotado | Decidir até |
|---|---|---|---|
| PEND-02 | Consequência do indeferimento | Volta à etapa anterior com status `RETURNED` | Sprint 8 |
| PEND-03 | Reabertura de processo concluído/cancelado | Não permitida | Sprint 10 |
| PEND-05 | Arredondamento | `HALF_UP` | Sprint 11 |
| PEND-07 | Retenção/temporalidade | Sem eliminação | Antes do MVP 3 |
| PEND-08 | Imagens no editor rico | Não | Sprint 9 |
| PEND-09 | PDF/A | Não no MVP 1 | MVP 3 |
| PEND-11 | Comentários restritos por unidade | Não | Sprint 10 |
| PEND-12 | Edição colaborativa em tempo real | Não | MVP 2 |
| PEND-13 | Múltiplos aprovadores | Não (`ANY`) | MVP 2 |
| PEND-14 | Semântica de origem/código interno | Ver A-01/A-02 | Sprint 5 |
| PEND-16 | Registro manual de publicação | Não | Sprint 14 |
| PEND-17 | Planos comerciais e limites | Limites técnicos padrão | Antes do go-live |
| PEND-18 | Login gov.br | Fora do MVP 1 | MVP 2 |
| PEND-19 | Prioridade do processo após aprovação do DFD | `Dfd.priority` prevalece (RN-DFD-66) | Antes da sprint do EP-002 |
| PEND-20 | Organização e times do GitHub (CODEOWNERS) | Times provisórios de DEC-062 | Antes da US-079 (proteção de branch) |

**Decididas em 2026-10-07 (sprint 0 — padrão confirmado pelo produto):** PEND-01 → DEC-028 · PEND-04 → DEC-020 · PEND-06 → DEC-141 · PEND-10 → DEC-061 · PEND-15 → DEC-021.


Os cards podem registrar decisões adicionais em "Dependências → Lacunas"; elas são consolidadas aqui na revisão de cada sprint.

## 9. Regras configuráveis

Nenhuma regra legal ou administrativa está fixa em código (princípio 17). Pontos de configuração do MVP 1:

| Mecanismo | O que configura | Quem configura | Referência |
|---|---|---|---|
| Workflows versionados | Etapas, transições, responsáveis, aprovadores, SLAs, tipos de documento por etapa, orientações | Admin/gestor (`WORKFLOW_*`) | DEC-014/015, EP-007 |
| Regras de workflow (JSON Logic) | Documentos obrigatórios e status mínimo, campos obrigatórios, aprovações exigidas, condições de valor/tipo/modalidade, severidade | Admin/gestor | DEC-016, US-044 |
| Aplicabilidade de workflow | Qual fluxo vale para cada tipo/modalidade/valor/órgão | Admin | US-042 |
| Templates versionados | Seções, obrigatoriedade (`REQUIRED`/`REQUIRED_OR_JUSTIFY`/`OPTIONAL`), textos padrão, base legal, orientação, layout | Admin/gestor (`TEMPLATE_*`) | EP-018 |
| Tipos de documento | Tipos personalizados, numeração, aprovação avulsa e política | Admin | US-061 |
| Catálogos | Tipos de contratação, modalidades, origens, unidades, categorias de risco, tipos de fonte de preço (com campos exigidos e validade), critérios de julgamento, categorias de anexo | Admin/gestor | DEC-027, US-104 |
| Configurações do tenant | Numeração, segurança (MFA, sessão), segregação de funções, acesso histórico, duplicidade, prazos, calendário, pesquisa de preços, riscos, uploads, notificações, rótulos, feature flags | Admin (`SETTINGS_MANAGE`) | entities.md §6 |
| Perfis e escopos | Permissões por perfil, escopos e vigências | Admin | EP-016 |
| Calendário | Feriados e pontos facultativos | Admin | US-106 |
| Estrutura organizacional | Órgãos, unidades, titulares e substitutos | Admin | EP-017 |

## 10. Integrações externas

| Integração | MVP | Finalidade | Protocolo | Risco principal |
|---|---|---|---|---|
| Authentik | 1 | Autenticação, MFA, recuperação de senha, provisionamento de usuários | OIDC + API REST | Configuração e disponibilidade (RS-06, RT-07) |
| Amazon S3 / MinIO | 1 | Armazenamento de anexos e PDFs | S3 API | Permissões de bucket |
| SMTP / Amazon SES | 1 | E-mails transacionais | SMTP/API | Entregabilidade (SPF/DKIM/DMARC) |
| ClamAV | 1 | Antivírus de uploads | clamd (TCP) | Indisponibilidade bloqueia liberação de arquivos (comportamento seguro) |
| Gotenberg | 1 | HTML → PDF | HTTP | Fidelidade e throughput (RT-03, RP-05) |
| Backend de observabilidade | 1 | Logs, métricas, traces | OTLP | Custo de ingestão |
| PNCP | 3 | Publicação e consulta | API REST | Mudanças de contrato da API pública |
| Diário Oficial / portal municipal | 3 | Publicação | Variável por ente (adapters) | Heterogeneidade |
| Assinatura eletrônica (ICP-Brasil / gov.br) | 3 | Assinatura de documentos | Provedor | Custo e validade jurídica |
| Compras.gov.br (painel de preços, CATMAT/CATSER) | 3/5 | Pesquisa de preços e catálogo | Dados abertos/API | Disponibilidade e formato |
| Receita Federal / bases de CNPJ | 3 | Enriquecimento de fornecedores | API de terceiros | Custo e LGPD |
| Provedores de IA (OpenAI, Anthropic, Azure OpenAI) | 5 | Assistente e validações | API | Privacidade e custo |
| Login gov.br (via Authentik) | 2+ | Federação de identidade | OIDC | Homologação |

## 11. Decisões de arquitetura do MVP 1

Resumo das decisões estruturais (detalhe em [decisions.md](../architecture/decisions.md) e ADRs):

| Decisão | Referência |
|---|---|
| Monólito modular NestJS com DDD pragmático e fronteiras verificadas no CI | DEC-040/041, ADR-001 |
| Multi-tenancy: banco/schema compartilhados + `tenant_id` + RLS + FKs compostas | DEC-080..082, ADR-002 |
| Autenticação Authentik (OIDC + PKCE) com BFF no Next.js; autorização no ContrataFlow | DEC-130..135, ADR-003 |
| Eventos de domínio com outbox transacional + BullMQ; timeline e acesso como projeções síncronas | DEC-160..164, ADR-004 |
| Motor de workflow próprio, declarativo e versionado; regras em JSON Logic | DEC-014..016, ADR-005, ADR-008 |
| Modelo documental híbrido com versões imutáveis e hash | DEC-017..019, ADR-006 |
| PDF via Gotenberg com SHA-256 | DEC-060, ADR-007 |
| Auditoria transacional append-only com selagem periódica | DEC-025, ADR-009 |
| Validação compartilhada com Zod e OpenAPI gerado | DEC-054, ADR-010 |
| UUIDv7 + numeração por sequência transacional | DEC-002, DEC-028, ADR-011 |

## 12. Validação para iniciar o MVP 2

Checklist a executar **antes** de detalhar o MVP 2 (governança da especificação):

- [ ] **Dependências:** MVP 1 em produção nos pilotos; workflow, aprovações, documentos tipados e auditoria estáveis.
- [ ] **Entidades existentes reutilizadas:** `Document`/`DocumentType` para parecer jurídico e edital; `Approval` para manifestações; `WorkflowStage` para Jurídico/Controle Interno/Dotação; `CatalogItem` para categorias do PCA; `Department` para secretarias do PCA.
- [ ] **Impactos:** nova versão do workflow padrão (Dotação, Jurídico, Controle Interno entre as etapas 6 e 7 de DEC-015); novos tipos de regra (SLA, notificação); indicadores sobre `ProcessStage`/`ProcessMovement`.
- [ ] **Mudanças de arquitetura:** read model para indicadores (materialized views ou tabela de fatos); `Approval.decisionPolicy`; possível motor de regras com biblioteca reutilizável.
- [ ] **Migrações necessárias:** entities.md §9 (PCA e `pcaItemId`, `decisionPolicy`, novas permissões e perfis ampliados — `JURIDICO`, `CONTROLE_INTERNO`, `CONTABILIDADE`).
- [ ] **Débitos a pagar antes:** DT-02 (migração de versão de workflow) e DT-03 (aprovação múltipla), pois o MVP 2 depende deles.
