---
id: US-004
title: "Visualizar detalhe do processo com painel situacional"
epic: EP-001
feature: FT-003
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-001, US-041]
modules: [process, workflow, document, approval, access, catalog, audit]
screens: [SCR-006]
endpoints: [PRC-04, PRC-07, PRC-08, PRC-09, PRC-10]
permissions: [PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-004 — Visualizar detalhe do processo com painel situacional

## Título
Visualizar o detalhe do processo com painel situacional

## Descrição
**Como** qualquer servidor que acompanha ou conduz um processo, **quero** abrir o processo e entender, sem cliques, onde ele está, com quem, o que falta, qual é o próximo passo, se está atrasado, quais documentos existem e quais aprovações estão pendentes, **para** agir (ou cobrar quem deve agir) sem telefonar para ninguém.

O detalhe do processo (SCR-006) tem: **cabeçalho** (código, título, status, prioridade, etiquetas, badge de sigilo, valor estimado mascarado conforme POL-09), **barra de ações** (uma ação primária + menu "Mais", calculadas por `available-actions`), **painel situacional** com as 7 perguntas de DEC-180 (fonte: `GET /processes/{id}/summary`), **stepper** das etapas do workflow e as **abas** Resumo, Documentos, Itens, Tramitação, Timeline, Comentários e Participantes. Esta story entrega a estrutura da tela, o cabeçalho, a barra de ações, o painel, o stepper e a navegação por abas; o conteúdo de cada aba é entregue pela story dona.

## Contexto
- "Onde está o processo?" é a pergunta mais frequente nos órgãos (personas P02, P03, P14); a resposta hoje depende de telefonemas e planilhas.
- DEC-180 define as 7 perguntas; DEC-181 define ação primária única, ações secundárias em "Mais", skeleton e empty states; DEC-102 cria `summary` e `available-actions` como suporte de UI; o princípio 14 do produto exige que só apareçam ações disponíveis.
- O motor de workflow (US-041) avalia transições e regras (`RuleContext v1`, JSON Logic — DEC-016); esta story compõe o resultado para o usuário.
- Visibilidade (DEC-024: não visível = 404), mascaramento (DEC-030/POL-09) e prazos (DEC-031) valem integralmente; o DTO `deadline` vem de US-002.

## Objetivo
Responder às 7 perguntas de DEC-180 na primeira dobra da tela para 100% dos processos visíveis, com `GET /processes/{id}/summary` em **p95 ≤ 800 ms** (C2; SLO-04), sem nenhuma ação oferecida que a API recusaria por permissão (ações impossíveis ocultas; contextuais desabilitadas com motivo) e sem exposição de valor sigiloso.

## Persona
- **Principal:** Área requisitante (`REQUISITANTE`) — acompanha "seus" processos e precisa saber o próximo passo.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`); Planejamento (`PLANEJAMENTO`) e Compras (`COMPRAS`) — conduzem etapas; Autoridade competente (`AUTORIDADE_COMPETENTE`) — chega pelo link da aprovação; Usuário somente leitura (`SOMENTE_LEITURA`), Controle Interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`) — leitura; Consultoria externa (`CONSULTOR_EXTERNO`) — participante.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Processo existente (US-001) e visível ao usuário (RN-PROC-19).
- Motor de workflow com avaliação de transições e regras disponível (US-041).
- Para os blocos de documentos e aprovações: módulos `document` e `approval` com suas fachadas de consulta (US-065, US-051); sem eles os blocos exibem estado vazio.

## Fluxo principal
1. O usuário abre `/processos/{id}` (lista SCR-004, caixa de tarefas, notificação, dashboard ou link direto).
2. O front exibe o skeleton da tela e dispara em paralelo: `GET /processes/{id}` (PRC-04), `GET /processes/{id}/summary` (PRC-07), `GET /processes/{id}/available-actions` (PRC-08) e `GET /processes/{id}/stages` (PRC-10).
3. A API verifica a visibilidade (RN-PROC-47) e, para o resumo, em uma transação de leitura (RN-PROC-56):
   1. lê o processo, a etapa ativa, a atribuição ativa e a definição da versão do workflow (cache — RN-PROC-58);
   2. monta o `RuleContext v1` e pede ao motor (US-041) a avaliação das regras da etapa e das transições de saída;
   3. consulta documentos não cancelados e aprovações `PENDING` do processo pelas fachadas de `document` e `approval`;
   4. calcula o DTO `deadline` da etapa e a situação do prazo alvo;
   5. aplica o mascaramento (POL-09) e marca documentos restritos (RN-PROC-55).
4. A API responde **200** com o resumo (7 blocos + cabeçalho + contadores das abas).
5. O front renderiza o cabeçalho (RN-PROC-54), a barra de ações com a ação primária (RN-PROC-49) e o menu "Mais" (RN-PROC-50), o painel com as 7 perguntas (RN-PROC-48), os badges de prazo (RN-PROC-53) e o stepper (RN-PROC-52).
6. O usuário lê o bloco **O que falta** e clica em uma pendência (ex.: "O ETP deve estar completo") → é levado ao documento ou à ação de criá-lo; ou abre **Ver checklist completo** (PRC-09).
7. O usuário aciona a ação primária (ex.: "Encaminhar para Pesquisa de preços") → abre o diálogo da story dona (SCR-103/US-047, SCR-115/US-049-050, SCR-116/US-008-010, SCR-015/US-052).
8. Concluído o comando, o front invalida as consultas do processo e o painel é recalculado; o toast da story dona confirma o resultado.
9. O usuário navega pelas abas; a aba ativa fica na URL (`?aba=documentos`) e cada aba carrega seu conteúdo sob demanda (RN-PROC-57).

## Fluxos alternativos
- **FA-01 — Processo não visível, descartado, inexistente ou de outro tenant:** 404 `PROCESS_NOT_FOUND` → SCR-111 (404) "Processo não encontrado ou você não tem acesso a ele." com link para a lista.
- **FA-02 — Usuário sem custódia:** a área da ação primária mostra "Com {responsável} — {unidade}" (ou "Na fila de {unidade}") e as ações de custódia aparecem no menu "Mais" desabilitadas com o motivo (`NOT_PROCESS_CUSTODIAN`).
- **FA-03 — Aprovador designado:** com aprovação `PENDING` em que o usuário é aprovador (POL-03), a ação primária é **"Decidir aprovação"** (link para SCR-015) e o bloco de aprovações destaca "Aguardando sua decisão".
- **FA-04 — Processo na fila da unidade:** se o usuário é lotado na unidade atual e não há responsável, a ação primária é **"Assumir"** (POL-04).
- **FA-05 — Pendência bloqueante:** a ação primária aparece desabilitada com "Encaminhar — há 1 pendência obrigatória nesta etapa" e o link "Ver pendências" rola até o bloco **O que falta**. Pendências `WARNING` não desabilitam (serão reconhecidas no diálogo de encaminhamento — US-047).
- **FA-06 — Processo suspenso:** status "Suspenso" com o motivo e a data; badge "Prazo pausado"; ação primária "Retomar" para quem tem `PROCESS_SUSPEND` (US-008); demais ações de tramitação desabilitadas com `INVALID_PROCESS_STATUS`.
- **FA-07 — Processo concluído ou cancelado:** painel em modo leitura: "Planejamento da contratação concluído em DD/MM/AAAA" (nome da etapa `END` — DEC-015) ou "Cancelado em DD/MM/AAAA — motivo: …"; sem badges de prazo; ações restritas a Duplicar, Seguir e Participantes (observador), conforme permissões.
- **FA-08 — Rascunho sem número:** cabeçalho "Rascunho (sem número)" e, no menu "Mais", "Descartar rascunho" para quem pode (US-009).
- **FA-09 — Documento restrito:** documento `RESTRICTED` listado com tipo, código, título e status, com cadeado e o texto "Conteúdo restrito (orçamento sigiloso)", sem link para quem não atende POL-09.
- **FA-10 — Regra que não pôde ser avaliada:** o item do checklist mostra "Não foi possível verificar esta regra. Tente novamente ou fale com o administrador." e é contado como pendência (fail-closed — RN-PROC-51).
- **FA-11 — Dados desatualizados:** se um comando retornar 409 `STAGE_CHANGED` ou 412 `VERSION_CONFLICT`, o painel exibe "Este processo foi atualizado por outra pessoa." e recarrega automaticamente.
- **FA-12 — Mobile:** cabeçalho compacto, painel em cartões empilhados na ordem das 7 perguntas, stepper vertical recolhível e barra de ações fixa no rodapé (ação primária + "Mais").

## Regras de negócio
- **RN-PROC-47** — PRC-04, PRC-07, PRC-08, PRC-09 e PRC-10 exigem que o processo seja visível ao usuário (RN-PROC-19). Processo inexistente, descartado (`deletedAt`), de outro tenant ou não visível → **404** `PROCESS_NOT_FOUND`, com o mesmo corpo e tempo de resposta equivalente (nunca 403).
- **RN-PROC-48** — O resumo (PRC-07) responde às 7 perguntas de DEC-180: (1) **onde está** — etapa atual (nome, tipo, `groupLabel`), unidade atual e status (com `statusBeforeSuspension` e motivo se suspenso); (2) **quem é o responsável** — `currentResponsible` com a data de início da atribuição ativa, ou "Na fila de {unidade}"; em `AWAITING_APPROVAL`, o aprovador designado da aprovação pendente (usuário, perfil no escopo ou titular da unidade, com substituto se `allowDeputy`); (3) **o que falta** — totais de pendências `BLOCKING` e `WARNING` e os itens não satisfeitos do checklist; (4) **próximo passo** — ação primária para o usuário (RN-PROC-49) e `WorkflowStage.instructions` (Markdown sanitizado); (5) **está atrasado** — DTO `deadline` da etapa e situação do prazo alvo; (6) **documentos existentes** — documentos não cancelados com tipo, código, título, status, número da versão atual, indicação de restrição e o selo derivado **"Em aprovação"** sempre que `pendingApprovalId` estiver preenchido, qualquer que seja o status (DEC-018); (7) **aprovações pendentes** — `Approval` `PENDING` do processo com título, aprovador, data da solicitação e prazo.
- **RN-PROC-49** — Ação primária, na ordem: (a) **Decidir aprovação**, se o usuário é aprovador designado de aprovação `PENDING` do processo (POL-03); (b) **Assumir**, se o processo está na fila de unidade em que o usuário é lotado (POL-04); (c) a transição com `isPrimary = true` da etapa atual, se o usuário detém a custódia (POL-01) — inclusive quando bloqueada por regra `BLOCKING` (desabilitada com motivo); (d) **Retomar**, se o processo está `SUSPENDED` e o usuário tem `PROCESS_SUSPEND` cobrindo o processo; (e) nenhuma — a área exibe com quem o processo está.
- **RN-PROC-50** — Ações disponíveis (PRC-08): para cada ação do catálogo (tabela "Campos"), a resposta traz `available` e, se indisponível, `reasons[]` com `code` (códigos canônicos: `PERMISSION_DENIED`, `NOT_PROCESS_CUSTODIAN`, `INVALID_PROCESS_STATUS`, `TRANSITION_BLOCKED`, `PROCESS_ALREADY_ASSIGNED`, `MFA_REQUIRED`, `CANNOT_DISCARD_NUMBERED_PROCESS`, `NOT_DESIGNATED_APPROVER`) e `message` pt-BR. Ações cuja permissão o usuário não tem em nenhum escopo são **omitidas** (ocultar); indisponibilidades contextuais são devolvidas para exibição **desabilitada com explicação** (permissions.md §9). A API continua decidindo em cada comando.
- **RN-PROC-51** — Checklist (PRC-09): regras `STAGE_EXIT` ativas da etapa atual e regras `TRANSITION` das transições de saída disponíveis, avaliadas pelo motor (US-041) sobre `RuleContext v1` montado no servidor; cada item segue o formato de `violations[]` de api.md §2.1.2 (`code = "WORKFLOW_RULE"`, `ruleId`, `severity`, `message` configurada, `params`), acrescido de `name`, `type`, `satisfied` e, para `REQUIRED_DOCUMENT`, o atalho para o documento existente ou para criá-lo. Falha na avaliação de uma regra = **não satisfeita** (fail-closed), com mensagem padrão (FA-10).
- **RN-PROC-52** — Stepper (PRC-10): etapas da versão de workflow fixada no processo (`workflowVersionId`), em `displayOrder` e agrupadas por `groupLabel`; para cada etapa, o status da última passagem (`ProcessStageStatus`, ou nulo = ainda não percorrida) e a lista de passagens (`ProcessStage`) com unidade, responsável, entrada, saída, prazo, sobrescrita de prazo e atraso. Etapas não percorridas mostram o SLA previsto; a etapa `END` aparece concluída somente com o processo `COMPLETED`.
- **RN-PROC-53** — Badges de prazo: etapa conforme o DTO `deadline` (US-002) — "No prazo", "Vence em N dias úteis" (ou "dias"), "Vence hoje", "Atrasado há N dias úteis", "Prazo pausado", "Sem prazo"; prazo alvo — "Prazo alvo: DD/MM/AAAA" ou "Prazo alvo vencido há N dias" (dias corridos, apenas status não final — DEC-031). Processos em status final não exibem badges de prazo. Sempre ícone + texto, nunca apenas cor.
- **RN-PROC-54** — Cabeçalho: código (ou "Rascunho (sem número)"), título, status (rótulo da terminologia), prioridade, etiquetas (até 10), badge "Orçamento sigiloso" quando `isBudgetConfidential` (RN-PROC-33), órgão (se o tenant tiver mais de um) e valor estimado com a origem (`estimatedValueSource`: "Manual", "DFD", "ETP", "Pesquisa de preços", "TR") — mascarado como "Sigiloso" quando `estimatedValueMasked = true`.
- **RN-PROC-55** — O resumo nunca devolve valor sigiloso a quem não atende POL-09. Documentos com `confidentiality = RESTRICTED` aparecem com tipo, código, título e status, mas com `restricted: true` e sem link de conteúdo/PDF para quem não atende POL-09 (permissions.md §5). A entrega de valores desmascarados de processo sigiloso gera `process.confidential_view` (1× por sessão e processo — US-013).
- **RN-PROC-56** — Consistência: o resumo é montado em uma única transação `REPEATABLE READ READ ONLY`, de modo que etapa, responsável, checklist, documentos e aprovações correspondam ao mesmo instante; a resposta inclui `version` do processo. A UI refaz as consultas do processo após qualquer comando, ao focar a janela e a cada 60 s com a aba visível.
- **RN-PROC-57** — Abas do SCR-006: Resumo (padrão), Documentos (US-062), Itens (US-006), Tramitação (US-054), Timeline (US-060), Comentários (US-071) e Participantes (US-012). A aba ativa fica na URL (`?aba=`); os contadores de documentos, itens, comentários e participantes vêm do resumo; o conteúdo de cada aba é carregado somente quando ela é aberta.
- **RN-PROC-58** — Performance: PRC-07 com p95 ≤ 800 ms (C2; SLO-04) para processo com 20 documentos, 10 regras e 15 passagens. Definições de versões de workflow publicadas (imutáveis — DEC-014) são cacheadas por `workflowVersionId` + `definitionHash` em memória e Redis, sem necessidade de invalidação.

## Campos
**Catálogo de ações de PRC-08**

| Ação (`action`) | Rótulo na UI | Permissão + política | Comando (story) |
|---|---|---|---|
| `FORWARD` (uma por transição, com `transitionId`) | `WorkflowTransition.name` (ex.: "Encaminhar para Compras") | `PROCESS_FORWARD` + POL-01 + regras | PRC-19 (US-047) |
| `RETURN` | "Devolver" | `PROCESS_RETURN` + POL-01 | PRC-20 (US-048) |
| `CLAIM` | "Assumir" | `PROCESS_CLAIM` + POL-04 | PRC-21 (US-049) |
| `ASSIGN` | "Atribuir responsável" | `PROCESS_ASSIGN` ou titular/substituto + POL-05 | PRC-22 (US-050) |
| `SUSPEND` / `RESUME` | "Suspender" / "Retomar" | `PROCESS_SUSPEND` + POL-07 | PRC-23/24 (US-008) |
| `CANCEL` | "Cancelar processo" | `PROCESS_CANCEL` + POL-06 | PRC-25 (US-009) |
| `DISCARD` | "Descartar rascunho" | criador com `PROCESS_CREATE` ou `PROCESS_CANCEL` | PRC-06 (US-009) |
| `COMPLETE` | "Concluir" | `PROCESS_COMPLETE` + POL-08 | PRC-26 (US-010) |
| `DECIDE_APPROVAL` (com `approvalId`) | "Decidir aprovação" | `APPROVAL_DECIDE` + POL-03 | APV-03 (US-052) |
| `EDIT` | "Editar dados" | `PROCESS_UPDATE` + POL-01 | PRC-05 (US-005) |
| `MANAGE_ITEMS` / `MANAGE_TAGS` | "Gerenciar itens" / "Etiquetas" | `PROCESS_UPDATE` + POL-01 | PRC-14..18 (US-006, US-007) |
| `DUPLICATE` | "Duplicar" | `PROCESS_DUPLICATE` + `PROCESS_CREATE` | PRC-27 (US-011) |
| `MANAGE_PARTICIPANTS` | "Participantes" | `PROCESS_MANAGE_PARTICIPANTS` + POL-10 | PRC-29/30 (US-012) |
| `FOLLOW` / `UNFOLLOW` | "Seguir" / "Deixar de seguir" | `PROCESS_FOLLOW` | PRC-31/32 (US-012) |
| `SET_CONFIDENTIALITY` | "Sigilo do orçamento" | `PROCESS_SET_CONFIDENTIAL_BUDGET` | PRC-33 (US-013) |

**Blocos do painel situacional (PRC-07)**

| Bloco (UI) | Campo técnico | Origem | Regras |
|---|---|---|---|
| Onde está | `where { stage { key, name, type, groupLabel }, department { id, name }, status, statusBeforeSuspension, suspensionReason }` | `Process`, `WorkflowStage` | RN-PROC-48 (1) |
| Responsável | `responsible { user? { id, name, jobTitle }, queueDepartment?, since, approver? }` | `ProcessAssignment`, `Approval` | RN-PROC-48 (2) |
| O que falta | `pending { blockingCount, warningCount, items[] }` | motor (US-041) | RN-PROC-51 |
| Próximo passo | `nextStep { action?, instructions }` | PRC-08 + `WorkflowStage.instructions` | RN-PROC-49 |
| Prazos | `deadline` (DTO de US-002), `target { targetDate, isOverdue, overdueDays }` | `ProcessStage`, `Process.targetDate` | RN-PROC-53 |
| Documentos | `documents[] { id, typeCode, typeName, code, title, status, versionNumber, confidentiality, restricted, inApproval }` (`inApproval` = `pendingApprovalId` preenchido → selo "Em aprovação") | fachada `document` | RN-PROC-48 (6), RN-PROC-55 |
| Aprovações pendentes | `approvals[] { id, title, approverLabel, requestedAt, dueAt, isOverdue, isMine }` | fachada `approval` | RN-PROC-48 (7) |
| Cabeçalho | `header { code, title, status, priority, tags[], isBudgetConfidential, estimatedValue, estimatedValueMasked, estimatedValueSource, organization }` | `Process` | RN-PROC-54 |
| Contadores das abas | `counts { documents, items, comments, participants }` | fachadas | RN-PROC-57 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `id` malformado ou processo não visível/inexistente/de outro tenant | API | "Processo não encontrado ou você não tem acesso a ele." | `PROCESS_NOT_FOUND` |
| V-02 | Regra `BLOCKING` não satisfeita impede a ação primária | API (PRC-08) + Front | "Encaminhar — há {n} pendência(s) obrigatória(s) nesta etapa." | `TRANSITION_BLOCKED` (em `reasons[]`) |
| V-03 | Ação de custódia por quem não está com o processo | API (PRC-08) | "Somente quem está com o processo pode {ação}." | `NOT_PROCESS_CUSTODIAN` (em `reasons[]`) |
| V-04 | Ação incompatível com o status | API (PRC-08) | "Não disponível com o processo {status}." | `INVALID_PROCESS_STATUS` (em `reasons[]`) |
| V-05 | Ação de risco alto sem MFA na sessão | API (PRC-08) | "Confirme sua identidade para {ação}." | `MFA_REQUIRED` (em `reasons[]`) |
| V-06 | Parâmetro `aba` desconhecido na URL | Front | — (abre a aba Resumo) | — |

## Permissões
- **Permissão:** `PROCESS_VIEW` com visibilidade sobre o processo (escopo, concessão `USER` ou participação ativa — §4 e §5 de permissions.md).
- **Orçamento sigiloso:** `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou custódia atual (POL-09) para ver valores e documentos `RESTRICTED`.
- **Políticas:** POL-01, POL-03, POL-04, POL-05, POL-06, POL-07, POL-08, POL-09, POL-10 e POL-14 são **avaliadas** por PRC-08 para compor as ações (sem executá-las).
- **MFA:** leitura não exige; ações `H` (ex.: `PROCESS_CANCEL`, `APPROVAL_DECIDE`) aparecem com motivo `MFA_REQUIRED` quando a sessão não tiver MFA exigido pela política, e o diálogo oferece o step-up.
- **Sem permissão:** processo não visível → 404 (FA-01); visível sem ações → painel em modo leitura, sem barra de ações.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Consultas somente leitura: nenhum evento de domínio. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. O painel é o destino dos links das notificações de outras stories. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Painel situacional do processo

  Background:
    Given que o tenant "Prefeitura de São José" está ativo e hoje é "2026-10-05"
    And o processo "0012/2026" está "IN_PROGRESS" na etapa "ESTUDOS_PRELIMINARES" do "Setor de Planejamento", com "Marcos" como responsável desde "2026-10-01"
    And a etapa tem prazo "2026-10-07" em dias úteis e "deadlines.warnBeforeBusinessDays" igual a 2
    And a etapa tem a regra "O ETP deve estar completo." (BLOCKING, não satisfeita) e a regra "Recomenda-se elaborar o mapa de riscos." (WARNING, não satisfeita)
    And o processo tem o documento "DFD 0005/2026" aprovado na versão 2 e o documento "ETP 0003/2026" em rascunho
    And a transição primária da etapa é "Encaminhar para Pesquisa de preços"

  Scenario: [Sucesso] Painel responde às 7 perguntas sem cliques
    When "Marcos" abrir o processo "0012/2026"
    Then o bloco "Onde está" deve mostrar "ETP e mapa de riscos — Setor de Planejamento — Em andamento"
    And o bloco "Responsável" deve mostrar "Marcos" desde "01/10/2026"
    And o bloco "O que falta" deve mostrar 1 pendência obrigatória e 1 recomendação, com os textos das regras
    And o bloco "Próximo passo" deve mostrar a ação "Encaminhar para Pesquisa de preços" e as instruções da etapa
    And o bloco "Prazos" deve mostrar o badge "Vence em 2 dias úteis"
    And o bloco "Documentos" deve listar "DFD 0005/2026 — Aprovado — v2" e "ETP 0003/2026 — Rascunho"
    And o bloco "Aprovações pendentes" deve mostrar "Nenhuma aprovação pendente"
    And "GET /api/v1/processes/{id}/summary" deve responder 200

  Scenario: [Sucesso] Aprovador designado vê "Decidir aprovação" como ação primária
    Given que o processo "0031/2026" está "AWAITING_APPROVAL" na etapa "APROVACAO_AUTORIDADE" com aprovação pendente designada a "Roberto"
    When "Roberto" abrir o processo "0031/2026"
    Then a ação primária deve ser "Decidir aprovação" com link para a tela de aprovação
    And o bloco "Responsável" deve mostrar "Aguardando decisão de Roberto Siqueira"

  Scenario: [Sucesso] Stepper mostra etapas percorridas e devolução
    Given que o processo "0012/2026" foi devolvido uma vez de "APROVACAO_DFD" para "ABERTURA" e depois aprovado
    When "Marcos" abrir o stepper
    Then as etapas devem aparecer agrupadas por "groupLabel" na ordem do workflow
    And a etapa "ABERTURA" deve ter 2 passagens, a primeira com status "RETURNED"
    And a etapa "ESTUDOS_PRELIMINARES" deve estar destacada como atual
    And a etapa "CONCLUSAO" deve aparecer como não percorrida

  Scenario: [Validação] Pendência bloqueante desabilita a ação primária com explicação
    When "Marcos" abrir o processo "0012/2026"
    Then o botão "Encaminhar para Pesquisa de preços" deve estar desabilitado com o texto "Encaminhar — há 1 pendência obrigatória nesta etapa."
    And "available-actions" deve trazer a ação "FORWARD" com "available" falso e motivo "TRANSITION_BLOCKED"
    When "Marcos" clicar na pendência "O ETP deve estar completo."
    Then deve ser levado ao documento "ETP 0003/2026"

  Scenario: [Permissão] Leitura sem ações e valor sigiloso mascarado
    Given que o processo "0031/2026" tem orçamento sigiloso e o documento "PP 0002/2026" restrito
    And "Tatiane" possui o perfil "SOMENTE_LEITURA" com escopo "ORGANIZATION"
    When "Tatiane" abrir o processo "0031/2026"
    Then o cabeçalho deve exibir "Orçamento sigiloso" e o valor estimado como "Sigiloso"
    And a resposta do resumo deve ter "estimatedValue" nulo e "estimatedValueMasked" verdadeiro
    And o documento "PP 0002/2026" deve aparecer com o cadeado e sem link de conteúdo
    And nenhuma ação de tramitação deve ser exibida

  Scenario: [Permissão] Usuário com permissão, mas sem custódia
    Given que "Juliana" possui o perfil "COMPRAS" com escopo "TENANT" e não está com o processo "0012/2026"
    When "Juliana" abrir o processo "0012/2026"
    Then a área da ação primária deve mostrar "Com Marcos — Setor de Planejamento"
    And a ação "Encaminhar para Pesquisa de preços" deve aparecer no menu "Mais" desabilitada com o motivo "Somente quem está com o processo pode encaminhá-lo."

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que existe o processo "0099/2026" no tenant "Prefeitura B"
    When "Marcos", no tenant "Prefeitura de São José", abrir "/processos/{id do 0099/2026}"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND" em PRC-04, PRC-07, PRC-08, PRC-09 e PRC-10
    And o corpo deve ser idêntico ao de um processo inexistente
    And a tela deve exibir "Processo não encontrado ou você não tem acesso a ele."

  Scenario: [Duplicidade] Acesso repetido a valores sigilosos é auditado uma vez por sessão
    Given que "Luciana" possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET" com escopo "TENANT"
    When "Luciana" abrir o processo sigiloso "0031/2026" em duas abas e recarregar a página três vezes na mesma sessão
    Then deve existir exatamente um registro de auditoria "process.confidential_view" para "0031/2026" nessa sessão

  Scenario: [Concorrência] Processo tramitado por outra pessoa enquanto o painel está aberto
    Given que "Marcos" está com o painel do processo "0012/2026" aberto
    When "Patrícia" reatribuir o processo para "Carla" e "Marcos" clicar em "Encaminhar para Pesquisa de preços"
    Then o comando deve ser recusado com 403 "NOT_PROCESS_CUSTODIAN" ou 412 "VERSION_CONFLICT"
    And o painel deve exibir "Este processo foi atualizado por outra pessoa." e recarregar mostrando "Carla" como responsável

  Scenario: [Falha de banco] Banco indisponível ao abrir o processo
    Given que o banco de dados está indisponível
    When "Marcos" abrir o processo "0012/2026" sem dados em cache no navegador
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a tela deve exibir "Não foi possível carregar o processo agora." com o correlationId e o botão "Tentar novamente"
    Given que havia dados do processo em cache no navegador
    Then a tela deve exibir os dados em cache com o aviso "Exibindo dados de {hora}. Não foi possível atualizar." e desabilitar as ações

  Scenario: [Falha de integração] Redis indisponível para o cache de definições de workflow
    Given que o Redis está indisponível
    When "Marcos" abrir o processo "0012/2026"
    Then a definição da versão do workflow deve ser lida do banco e o resumo deve responder 200
    And deve ser registrado log "warn" "workflow.definition_cache_unavailable"

  Scenario: [Falha de integração] Regra com expressão que não pode ser avaliada
    Given que a regra "Valor compatível" da etapa tem uma expressão JSON Logic que falha na avaliação
    When "Marcos" abrir o processo "0012/2026"
    Then o checklist deve exibir "Não foi possível verificar esta regra. Tente novamente ou fale com o administrador."
    And a regra deve ser contada como pendência
    And deve ser registrado log "error" "workflow.rule_evaluation_failed" com "ruleId" e "workflowVersionId"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Processo inexistente, descartado, não visível ou de outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado ou você não tem acesso a ele." | SCR-111 (404) com link "Voltar para Processos" |
| Vínculo inativo / tenant suspenso | 403 | `MEMBERSHIP_INACTIVE` / `TENANT_SUSPENDED` | "Seu acesso a este órgão não está ativo." | SCR-111 |
| Sessão expirada | 401 | `SESSION_EXPIRED` | "Sua sessão expirou. Entre novamente para continuar." | Login e retorno ao processo e à aba |
| Comando sobre dado desatualizado (vindo das stories donas) | 409 / 412 | `STAGE_CHANGED` / `VERSION_CONFLICT` | "Este processo foi atualizado por outra pessoa." | Recarrega o painel (FA-11) |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas atualizações seguidas. Aguarde alguns segundos." | Suspende o refetch automático até `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar o processo agora." | Dados em cache com aviso, ou erro com "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-001 (processo e runtime da etapa), US-041 (motor: transições disponíveis e avaliação de regras). Relacionadas: US-002 (DTO `deadline` e visibilidade), US-013 (mascaramento e `process.confidential_view`), US-047/US-048/US-049/US-050 (diálogos das ações), US-051/US-052 (aprovações), US-054 (passagens no stepper e aba Tramitação), US-055 (prazos), US-062 (aba Documentos), US-060 (aba Timeline), US-071 (aba Comentários), US-012 (aba Participantes), US-006 (aba Itens).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-016, DEC-023, DEC-024, DEC-030, DEC-031, DEC-102, DEC-134, DEC-180, DEC-181, DEC-183, DEC-184; ADR-005, ADR-008.
- **Configurações:** `deadlines.warnBeforeBusinessDays`, `access.historicalDepartmentsCanView`, `security.mfaPolicy`, `labels.secretariat`, `labels.department`.
- **Lacunas nas fontes canônicas:**
  1. **Chaves de ação de PRC-08:** além de `MovementAction`, o catálogo usa `DECIDE_APPROVAL`, `DISCARD`, `EDIT`, `MANAGE_ITEMS`, `MANAGE_TAGS`, `DUPLICATE`, `MANAGE_PARTICIPANTS`, `FOLLOW`, `UNFOLLOW` e `SET_CONFIDENTIALITY`, que não existem nas fontes canônicas. Proposta: registro `ProcessActionKey` em `packages/types` e em api.md §4.
  2. **Contratos de resposta** de PRC-04 (`meta.allowedActions`), PRC-07, PRC-08, PRC-09 e PRC-10 a registrar em api.md §4.
  3. ~~Meta de latência do painel~~ — resolvida: p95 ≤ 800 ms (product-overview C2, observability SLO-04), alinhada em architecture.md e release-checklist.md.

## Impacto técnico
- `ProcessSummaryService` agrega dados de quatro módulos **somente por fachadas** (`WorkflowFacade.evaluateStage`, `DocumentFacade.listForSummary`, `ApprovalFacade.listPendingForProcess`, `ProcessQueries`), respeitando DEC-041; a composição acontece em uma transação de leitura para consistência (RN-PROC-56).
- Definições publicadas de workflow são imutáveis: cache em memória (LRU) + Redis por `workflowVersionId`/`definitionHash`, sem invalidação; o `RuleContext` é montado uma única vez por requisição e compartilhado entre PRC-07, PRC-08 e PRC-09 quando chamados juntos (memoização por `correlationId`).
- PRC-08 é a mesma engine de autorização dos comandos (`AuthorizationService.explain(action, process)`), evitando divergência entre o que a UI oferece e o que a API aceita; teste de contrato garante que toda ação `available = true` seja aceita pelo comando correspondente em estado idêntico.
- O conteúdo de `instructions` é Markdown renderizado com sanitização (sem HTML bruto) no front.
- Sem cache de resposta no servidor (personalizada e mutável): `Cache-Control: no-store`.

## Backend
- **Módulo(s):** `process` (dono da tela e das consultas); `workflow`, `document`, `approval`, `access`, `catalog`, `audit` via fachadas.
- **Casos de uso:** `GetProcessQuery` (PRC-04), `GetProcessSummaryQuery` (PRC-07), `GetAvailableActionsQuery` (PRC-08), `GetProcessChecklistQuery` (PRC-09), `ListProcessStagesQuery` (PRC-10).
- **Domínio/serviços:** `ProcessSummaryService`, `PrimaryActionSelector` (RN-PROC-49), `AvailableActionsService` (catálogo de ações + `AuthorizationService.explain`), `StageDeadlineCalculator` (US-002), `ProcessPresenter` com `ConfidentialFieldsInterceptor`.
- **Integrações internas:** `WorkflowFacade.getVersionDefinition`, `WorkflowFacade.evaluateStage(ruleContext)`, `WorkflowFacade.listAvailableTransitions`, `RuleContextBuilder` (US-041), `DocumentFacade.listForSummary`, `ApprovalFacade.listPendingForProcess`, `AccessFacade`, `AuditService` (`process.confidential_view`, regra de US-013).
- **Transação:** leitura `REPEATABLE READ READ ONLY` com `app.tenant_id`; a única escrita possível é a auditoria de acesso a valor sigiloso (transação curta separada, deduplicada).

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`, `?aba=resumo|documentos|itens|tramitacao|timeline|comentarios|participantes`).
- **Componentes:** `ProcessHeader` (código, título, `StatusBadge`, `PriorityBadge`, `TagChips`, `ConfidentialBadge`, `ConfidentialValue`), `ProcessActionBar` (`PrimaryActionButton` com estado desabilitado + motivo, `MoreActionsMenu`, `FollowToggle`), `SituationalPanel` com os cartões `WhereCard`, `ResponsibleCard`, `PendingCard` (link "Ver checklist completo" → `ChecklistDrawer`), `NextStepCard` (Markdown sanitizado), `DeadlinesCard` (`DueDateBadge` de US-002 + prazo alvo), `DocumentsCard`, `PendingApprovalsCard`; `StageStepper` (horizontal no desktop, vertical no mobile, passagens em popover); `ProcessTabs` com carregamento sob demanda.
- **Dados:** TanStack Query `['t', tenantId, 'processes', id, 'detail' | 'summary' | 'actions' | 'stages' | 'checklist']`; invalidação de todas após comandos; `refetchOnWindowFocus` e `refetchInterval` de 60 s com a aba visível; dados anteriores mantidos durante o refetch.
- **Estados:** skeleton por bloco (o painel aparece progressivamente); empty states por bloco ("Nenhum documento ainda — Criar DFD", "Nenhuma aprovação pendente"); erro por bloco com "Tentar novamente" sem derrubar a tela; modo leitura para processos finais.
- **Acessibilidade:** cada pergunta é uma seção com título (`h2`) navegável por leitor de tela; ação primária com `aria-describedby` apontando o motivo quando desabilitada; stepper como lista ordenada com `aria-current="step"`; badges com texto; foco no título do processo ao carregar.
- **Responsivo:** FA-12; abas roláveis horizontalmente; leitura plena em 360 px (DEC-183).

## Banco de dados
- **Tabelas lidas:** `processes`, `process_stages`, `process_assignments`, `workflow_versions`, `workflow_stages`, `workflow_transitions`, `workflow_rules`, `documents`, `document_types`, `approvals`, `process_items`, `comments`, `process_participants`, `process_tags`, `tags`, `departments`, `users`; escrita eventual em `audit_logs`.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** `process_stages (tenant_id, process_id) WHERE status = 'ACTIVE'`; `process_assignments (tenant_id, process_id) WHERE is_active`; `documents (tenant_id, process_id, document_type_id)`; `approvals (tenant_id, process_id, created_at DESC)`; `process_stages (tenant_id, process_id, sequence)` para o stepper.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-04 | GET | `/api/v1/processes/{id}` | — | `200 { data: Process (campos de entities.md, com mascaramento), meta: { allowedActions: string[] } }` + `ETag` | 200, 401, 403, 404, 503 |
| PRC-07 | GET | `/api/v1/processes/{id}/summary` | — | `200 { data: { header, where, responsible, pending, nextStep, deadline, target, documents[], approvals[], counts, version } }` | 200, 404, 503 |
| PRC-08 | GET | `/api/v1/processes/{id}/available-actions` | — | `200 { data: [{ action, label, available, primary, transitionId?, approvalId?, reasons: [{ code, message }] }] }` | 200, 404 |
| PRC-09 | GET | `/api/v1/processes/{id}/checklist` | — | `200 { data: [{ code: "WORKFLOW_RULE", ruleId, severity, message, params, name, type, satisfied, scope, transitionId?, link? }] }` (formato de api.md §2.1.2) | 200, 404 |
| PRC-10 | GET | `/api/v1/processes/{id}/stages` | — | `200 { data: [{ workflowStageId, key, name, type, groupLabel, displayOrder, slaDays, slaType, lastPassStatus, passes: [{ processStageId, sequence, status, department, assignee, enteredAt, exitedAt, dueAt, dueDateOverridden, overdueSince }] }] }` | 200, 404 |

Exemplo de resposta de PRC-07 (abreviado):
```json
{
  "data": {
    "header": { "code": "0012/2026", "title": "Aquisição de cimento para manutenção de vias", "status": "IN_PROGRESS", "priority": "HIGH", "tags": [], "isBudgetConfidential": false, "estimatedValue": "85000.00", "estimatedValueMasked": false, "estimatedValueSource": "DFD" },
    "where": { "stage": { "key": "ESTUDOS_PRELIMINARES", "name": "ETP e mapa de riscos", "type": "TASK", "groupLabel": "Planejamento" }, "department": { "id": "…", "name": "Setor de Planejamento" }, "status": "IN_PROGRESS", "statusBeforeSuspension": null },
    "responsible": { "user": { "id": "…", "name": "Marcos Vinícius Rocha", "jobTitle": "Analista de Planejamento" }, "queueDepartment": null, "since": "2026-10-01T12:10:00Z", "approver": null },
    "pending": { "blockingCount": 1, "warningCount": 1, "items": [
      { "ruleId": "…", "severity": "BLOCKING", "message": "O ETP deve estar completo.", "link": { "documentId": "…" } },
      { "ruleId": "…", "severity": "WARNING", "message": "Recomenda-se elaborar o mapa de riscos.", "link": { "createDocumentTypeCode": "RISK_MAP" } } ] },
    "nextStep": { "action": { "action": "FORWARD", "transitionId": "…", "label": "Encaminhar para Pesquisa de preços", "available": false, "reasons": [{ "code": "TRANSITION_BLOCKED", "message": "Há 1 pendência obrigatória nesta etapa." }] }, "instructions": "Elabore o ETP e o mapa de riscos…" },
    "deadline": { "dueAt": "2026-10-08T02:59:59Z", "slaType": "BUSINESS", "daysLeft": 2, "overdueDays": null, "isDueSoon": true, "isOverdue": false, "isPaused": false },
    "target": { "targetDate": "2026-11-30", "isOverdue": false, "overdueDays": null },
    "documents": [
      { "id": "…", "typeCode": "DFD", "typeName": "DFD", "code": "DFD 0005/2026", "title": "DFD — cimento", "status": "APPROVED", "versionNumber": 2, "confidentiality": "INTERNAL", "restricted": false },
      { "id": "…", "typeCode": "ETP", "typeName": "ETP", "code": "ETP 0003/2026", "title": "ETP — cimento", "status": "DRAFT", "versionNumber": null, "confidentiality": "INTERNAL", "restricted": false } ],
    "approvals": [],
    "counts": { "documents": 2, "items": 3, "comments": 5, "participants": 1 },
    "version": 9
  }
}
```

## Logs
- `info` `process.summary` — `processId`, `durationMs`, `rulesEvaluated`, `documentsCount`, `pendingApprovalsCount`, `cacheHit` (definição do workflow).
- `warn` `process.summary_slow` — acima de 800 ms, com a duração por etapa interna (processo, regras, documentos, aprovações).
- `warn` `workflow.definition_cache_unavailable` — leitura da definição sem Redis.
- `error` `workflow.rule_evaluation_failed` — `ruleId`, `workflowVersionId`, tipo do erro (sem o contexto avaliado).
- **Nunca logar:** título, objeto, valores estimados, conteúdo do `RuleContext`, instruções da etapa.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.confidential_view` | `ACCESS` | Entrega de valores desmascarados de processo sigiloso (1× por sessão e processo — US-013) | `metadata`: `processCode`, `source` (`PRC-04`/`PRC-07`) |

Processos não visíveis respondem 404 sem `access.denied` (não há ação negada a registrar — a existência não é revelada).

## Testes necessários
- **Unitários:** `PrimaryActionSelector` (ordem a–e de RN-PROC-49 em cada status); `AvailableActionsService` (ocultar × desabilitar, motivos por política); badges de prazo (vence hoje, atrasado, pausado, `CALENDAR`, prazo alvo vencido); sanitização do Markdown de instruções.
- **Integração (Testcontainers):** resumo em snapshot único (tramitação concorrente não produz combinação parcial); avaliação de regras com `RuleContext` real e regra inválida (fail-closed); documentos `RESTRICTED` sem link para quem não atende POL-09; cache de definição com e sem Redis.
- **API/contrato:** schemas de PRC-04/07/08/09/10; teste de coerência "ação disponível ⇒ comando aceito" para FORWARD, CLAIM, SUSPEND, CANCEL e COMPLETE em estados idênticos.
- **RBAC e multi-tenant:** matriz table-driven perfil × custódia × status × ação contra permissions.md; 404 idêntico para inexistente, descartado, não visível e outro tenant (suíte "tenant leak").
- **Concorrência:** reatribuição durante a leitura; refetch após 409/412 vindos das stories donas.
- **E2E (Playwright):** painel completo das 7 perguntas, clique em pendência leva ao documento, ação primária abre o diálogo correto, deep link de aba, processo suspenso e concluído em modo leitura, layout em 360 px.
- **Acessibilidade/performance:** axe sem violações sérias; navegação por leitor de tela pelas 7 seções; k6 com 50 usuários virtuais em processos de 20 documentos/10 regras/15 passagens → p95 < 500 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] As 7 perguntas de DEC-180 respondidas na primeira dobra em desktop e mobile
- [ ] Ações impossíveis ocultas e contextuais desabilitadas com motivo, com teste de coerência com os comandos
- [ ] Mascaramento e documentos restritos verificados por teste; `process.confidential_view` deduplicado
- [ ] Teste de isolamento (404) incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-04, PRC-07, PRC-08, PRC-09 e PRC-10 compatível com api.md
- [ ] p95 ≤ 800 ms comprovado em k6; logs sem dados sensíveis; trace com spans por bloco
- [ ] Tela acessível (axe, teclado, leitor de tela) e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — agrega dados de quatro módulos com consistência de snapshot e meta de latência agressiva, compõe ações disponíveis coerentes com todas as políticas contextuais, integra a avaliação de regras do motor e entrega a tela central do produto (cabeçalho, barra de ações, painel de 7 blocos, stepper e abas) com versões desktop e mobile acessíveis.

## Prioridade
**P0** — o painel situacional é o hub do produto (princípio 1 e 13) e o ponto de partida de todas as ações de tramitação; sem ele nenhuma jornada do MVP 1 é utilizável.
