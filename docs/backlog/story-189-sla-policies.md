---
id: US-189
title: "Cadastrar políticas de SLA"
epic: EP-030
feature: FT-086
mvp: 2
priority: P1
estimate: L
status: Especificada
depends_on: [US-055, US-106, US-129]
modules: [sla, workflow, rules, audit, platform]
screens: [SCR-121]
endpoints: [SLA-01, SLA-02, SLA-03, SLA-04, SLA-05, SLA-06, SLA-07]
permissions: [SLA_POLICY_MANAGE, RULE_VIEW]
events: [SlaPolicyChanged]
---

# US-189 — Cadastrar políticas de SLA

## Título
Cadastrar políticas de SLA

## Descrição
**Como** administrador do órgão (ou gestor de contratações com a permissão de prazos), **quero** cadastrar políticas de prazo que se apliquem por tipo de contratação, modalidade ou valor, com prazos por etapa em dias úteis ou corridos, condições de pausa e degraus de escalonamento, **para** que o prazo de cada processo reflita a realidade da contratação, sem depender de alteração de código nem de duplicar workflows.

A story cria o módulo `sla` e a entidade `SlaPolicy` (com `SlaPolicyStage`) e a tela **SCR-121 — Políticas de SLA** (`/admin/prazos`): listar, criar, editar, ativar e desativar políticas. Uma política tem chave imutável, nome, **aplicabilidade** (`RuleRef` sobre o `RuleContext` v2), `priority` (menor vence), restrição opcional a um workflow, **prazos por etapa** identificadas por chave estável (valem entre versões do workflow), prazo por linha de aprovador (`approverDays`), **condições de pausa** (`pauseConditions`) e **degraus de escalonamento** (`escalationSteps`, até 5). O cadastro é só configuração: aplicar a política ao processo é de US-190, pausar e retomar de US-191 e escalonar de US-192.

## Contexto
- No MVP 1 o prazo é um número de dias por etapa (`WorkflowStage.slaDays`/`slaType`, DEC-031), igual para qualquer processo; um pregão de alto valor e uma compra direta pequena têm o mesmo prazo, e a análise jurídica devolvida em diligência "gasta" prazo da etapa. A DEC-205 cria o módulo `sla` e a `SlaPolicy`, que **substitui** `WorkflowStage.slaDays` quando casa e deixa o prazo da DEC-031 como base quando nenhuma política se aplica (o MVP 1 sem política continua funcionando igual).
- ADR-015 fixa o desenho: um só executor JSON Logic com *allowlist* (ADR-008), `RuleRef` (`INLINE` ou `LIBRARY`), uma etapa nunca tem duas políticas (vence a de menor `priority`; empate → `createdAt`), execução assíncrona e idempotente no worker, montagem preguiçosa do contexto.
- `RuleContext` v2 (US-129, entities.md §7.2) é um superset da v1: as expressões de aplicabilidade leem `process.*` (`estimatedValue`, `modalityCode`, `contractingTypeCode`, `priority`, `isPriceRegistration`…), `pca.*`, `budget.*`, `legalReview.*`, `internalControl.*` e `tender.*`. O namespace `sla.*` descreve o resultado da aplicação e **não** pode ser usado para escolher a política (circularidade).
- A semente traz o modelo `PADRAO_FASE_PREPARATORIA` **inativo**, com prazos sugeridos por etapa "a validar com o piloto" (entities.md §9); é uma política comum, editável e ativável.
- `SLA_POLICY_MANAGE` é permissão de risco `H` (MFA conforme `security.mfaPolicy`, POL-14) e a POL-27 determina que ela só altera **efeitos futuros**. `RULE_VIEW` é necessária para escolher uma regra da biblioteca (EP-031) na aplicabilidade ou nas pausas.
- Base legal e de gestão: Lei 14.133/2021, art. 11 (governança) e art. 53, § 1º, I (critérios objetivos de prioridade); cumprimento por etapa sai do read model do EP-028 (DEC-206).

## Objetivo
Permitir que um administrador cadastre, em até 10 minutos e sem apoio técnico, uma política de prazo completa (aplicabilidade, prazos por etapa, pausas e degraus) com validação que impeça configuração inválida, rastro de auditoria de toda alteração e efeito somente sobre entradas futuras em etapa.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`), com `SLA_POLICY_MANAGE`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que também tem `SLA_POLICY_MANAGE` por padrão; Auditor (`AUDITOR`) e responsáveis por etapa, que veem o resultado da política no detalhe do processo (US-190), não esta tela.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`, `SLA_POLICY_MANAGE` e, se a política do tenant exigir (`security.mfaPolicy` `ADMINS` ou `ALL`), sessão com MFA.
- Existe ao menos um workflow do tenant com etapas `TASK`/`APPROVAL` (fonte do catálogo de etapas); sem workflow o editor funciona, mas a aba "Prazos por etapa" fica vazia com orientação.
- `RuleContext` v2 disponível (US-129) para validar os caminhos das expressões.

## Fluxo principal
1. O administrador abre **Administração › Prazos** (SCR-121, `/admin/prazos`); o front chama SLA-01 e exibe skeleton até a resposta.
2. A lista mostra as políticas em **ordem de avaliação** (`priority` crescente e, no empate, mais antiga primeiro), com nome e chave, resumo da aplicabilidade, prioridade, workflow, quantidade de etapas com prazo, de pausas e de degraus, e situação (Ativa/Inativa).
3. O administrador aciona **"Nova política"**; o editor abre com quatro abas: **Geral e aplicabilidade**, **Prazos por etapa**, **Pausas** e **Escalonamento**.
4. Em *Geral e aplicabilidade* informa chave (imutável depois), nome, descrição, prioridade (padrão 100), workflow (opcional) e a **aplicabilidade**: regra da biblioteca (exige `RULE_VIEW`) ou condição própria (`INLINE`, editor de expressão com os caminhos do contexto v2 vindos de WF-19); o editor valida a expressão antes de salvar.
5. Em *Prazos por etapa* escolhe etapas do catálogo (SLA-07, por chave estável e nome) e informa dias (1–365), contagem (dias úteis ou corridos) e, para etapas `APPROVAL`, o prazo por linha de aprovador (`approverDays`). Etapa sem linha continua com o `slaDays` do workflow (a UI mostra esse valor como referência).
6. Em *Pausas* vê "Suspensão do processo — sempre pausa o prazo (não configurável)" e pode marcar "Diligência do jurídico" e adicionar condições próprias (`CONDITION`) com uma regra.
7. Em *Escalonamento* adiciona de 0 a 5 degraus: "quando" (dias úteis antes ou depois do vencimento), "quem avisa" (responsável, titular da unidade, substituto da unidade, gestor, titular da secretaria solicitante) e, nos degraus a partir do vencimento, "repetir a cada N dias úteis". A aba mostra a linha do tempo resultante em linguagem natural ("2 dias úteis antes do vencimento → responsável e titular da unidade").
8. O administrador escolhe **"Salvar e ativar"** ou **"Salvar como inativa"** (padrão); o front envia SLA-02 com `Idempotency-Key`.
9. A API valida (Zod e regras de negócio), grava a política e as linhas de prazo, audita `sla_policy.create`, publica `SlaPolicyChanged` (`CREATED`) na mesma transação e responde 201 com `ETag`. A lista é atualizada.
10. Para editar, o administrador abre a política (SLA-03), altera e salva com SLA-04 (`If-Match`); a API aplica a alteração, audita `sla_policy.update` e publica `SlaPolicyChanged` (`UPDATED`). Para ativar/desativar usa SLA-05/SLA-06 (`If-Match`), que auditam `sla_policy.activate`/`sla_policy.deactivate` e publicam `ACTIVATED`/`DEACTIVATED`.
11. A tela exibe, em todas as ações que alteram uma política ativa, o aviso fixo: "A alteração vale para as próximas entradas em etapa. Prazos já calculados não mudam."

## Fluxos alternativos
- **FA-01 — Nenhuma política cadastrada:** estado vazio "Nenhuma política de prazo. Sem política, valem os prazos definidos em cada etapa do workflow." com o atalho "Nova política" (o modelo `PADRAO_FASE_PREPARATORIA`, inativo, aparece na lista como qualquer política).
- **FA-02 — Empate de prioridade:** duas políticas ativas com a mesma `priority` mostram o selo "Empate: vale a mais antiga" e a ordem de avaliação já considera `createdAt`.
- **FA-03 — Sem permissão para a biblioteca:** sem `RULE_VIEW`, a opção "Regra da biblioteca" fica oculta; só a condição própria está disponível.
- **FA-04 — Regra da biblioteca aposentada depois:** a política continua válida e sendo avaliada com a versão fixada, mas a tela exibe "A regra {nome} v{n} foi aposentada" e **bloqueia** a ativação de uma política inativa que a use (`RULE_REF_INVALID`).
- **FA-05 — Política sem degraus:** é válida; a aba mostra "Sem degraus: valem os avisos padrão de vencimento (`deadlines.warnBeforeBusinessDays`)" (comportamento de US-192).
- **FA-06 — Política só de pausas/degraus, sem prazos por etapa:** é válida; os prazos continuam sendo os de `WorkflowStage.slaDays` e a política contribui com pausas e degraus (RN-SLA-06).
- **FA-07 — Edição concorrente:** a segunda gravação com `ETag` antigo recebe `VERSION_CONFLICT`; a tela oferece "Recarregar" mantendo as alterações locais em rascunho.
- **FA-08 — Ativar política já ativa / desativar já inativa:** operação idempotente, resposta 200 sem novo evento nem auditoria.
- **FA-09 — Chave repetida:** `SLA_POLICY_KEY_ALREADY_EXISTS`, com a mensagem apontando o campo.
- **FA-10 — Etapa removida de todos os workflows depois do cadastro:** a linha continua guardada; a tela a marca "Etapa não encontrada em nenhum workflow" e a política passa a ignorá-la na aplicação (sem erro em tempo de execução).
- **FA-11 — MFA exigido:** sem MFA satisfeito a API responde `MFA_REQUIRED` e a UI conduz ao passo de verificação, preservando o formulário.

## Regras de negócio
- **RN-SLA-01** — `SlaPolicy.key` é única por tenant (`UNIQUE (tenant_id, key)`), **imutável**, 3 a 60 caracteres em `^[A-Z][A-Z0-9_]*$` (ex.: `PREGAO_ALTO_VALOR`); `name` de 3 a 150 caracteres; `description` opcional (até 2.000). Duplicar a chave → `SLA_POLICY_KEY_ALREADY_EXISTS` (409).
- **RN-SLA-02** — `applicabilityRule` é obrigatória e é um `RuleRef`: `INLINE` com `contextVersion = 2` e expressão JSON Logic validada pelo executor da ADR-008 (operadores da *allowlist*, caminhos existentes no `RuleContext` v2), ou `LIBRARY` com `ruleDefinitionId` e `ruleDefinitionVersionId` de uma versão `PUBLISHED` da biblioteca cujo `kind` seja `SLA` (exige `RULE_VIEW`). Falha de caminho ou operador → `VALIDATION_ERROR` (`RULE_PATH_UNKNOWN`/`RULE_OPERATOR_FORBIDDEN`); referência inválida → `RULE_REF_INVALID`.
- **RN-SLA-03** — Caminhos `sla.*` são **proibidos** na aplicabilidade e nas condições de pausa (`pauseConditions[].rule`): o namespace descreve o resultado da aplicação, e usá-lo na escolha da política seria circular.
- **RN-SLA-04** — `priority` é inteiro de 1 a 9999 (padrão 100); **menor vence**; prioridades iguais são permitidas e o empate se resolve por `createdAt` (a mais antiga vence — ADR-015, RN-SLA-02 da feature). A listagem e a tela mostram a ordem de avaliação.
- **RN-SLA-05** — `workflowId` é opcional: preenchido, a política só concorre em etapas desse workflow (ativo, do tenant); nulo vale para todos. O *workflow* referenciado precisa existir no tenant (`REFERENCE_NOT_FOUND`).
- **RN-SLA-06** — Prazos por etapa (`SlaPolicyStage`): `stageKey` é a chave estável da `WorkflowStage` (varchar 60), **única por política**, e deve existir em alguma etapa `TASK` ou `APPROVAL` do tenant (do workflow indicado, quando houver restrição) — SLA-07 lista as chaves válidas; `days` de 1 a 365; `dayCountType` `BUSINESS` ou `CALENDAR`. Etapa sem linha na política → vale `WorkflowStage.slaDays` (DEC-031). A política pode ter zero linhas.
- **RN-SLA-07** — `approverDays` (1 a 365) só é aceito em linha cuja `stageKey` seja de etapa `APPROVAL`; define o prazo por linha de `ApprovalApprover` (calculado em US-190) e usa a contagem `dayCountType` da própria linha.
- **RN-SLA-08** — `pauseConditions`: cada item é `{ reason, rule? }` com `reason` ∈ `PROCESS_SUSPENDED`, `LEGAL_DILIGENCE`, `CONDITION`. `PROCESS_SUSPENDED` está **sempre implícita** (comportamento do MVP 1): a presença no JSON é opcional, sem efeito e armazenada no máximo uma vez. `LEGAL_DILIGENCE` no máximo uma vez, sem `rule`. `CONDITION` exige `rule` (`RuleRef`, mesmas validações de RN-SLA-02 e RN-SLA-03); máximo de 5 condições `CONDITION` por política.
- **RN-SLA-09** — `escalationSteps` tem de 0 a 5 itens `{ level, offsetBusinessDays, notify, repeatEveryBusinessDays? }`: `level` de 1 a 5, único e consecutivo a partir de 1; `offsetBusinessDays` inteiro de −60 a 60 (negativo = antes do vencimento, 0 = no vencimento, positivo = depois) e **estritamente crescente** com o `level`; `notify` com ao menos um valor de `ASSIGNEE`, `DEPARTMENT_HEAD`, `DEPARTMENT_DEPUTY`, `PROCESS_MANAGER_ROLE`, `REQUESTING_SECRETARIAT_HEAD`, sem repetição; `repeatEveryBusinessDays` (1 a 30) só em degrau com `offsetBusinessDays ≥ 0`.
- **RN-SLA-10** — Política sem degraus é válida (FA-05): a tela informa que valem os avisos padrão do MVP 1 (`deadlines.warnBeforeBusinessDays`); o efeito em tempo de execução é de US-192.
- **RN-SLA-11** — A API aceita `isActive` na criação (padrão **`true`**, como em entities.md §4.9); o formulário envia `false` por padrão ("Salvar como inativa") para a pessoa revisar antes de ativar. Ativar exige que a política salva passe de novo todas as validações (inclusive RN-SLA-02) e que nenhuma referência de biblioteca esteja `RETIRED`.
- **RN-SLA-12** — Editar uma política (SLA-04) exige `If-Match`; `key` não pode ser alterada; os arrays `stages`, `pauseConditions` e `escalationSteps`, quando enviados, **substituem** o conteúdo anterior por inteiro (semântica de substituição, validada como um todo). Os **prazos** (`days`, `dayCountType`) só valem para novas entradas em etapa — passagens em curso mantêm o snapshot em `ProcessStage` (POL-27, DEC-205). **Pausas e degraus** editados são lidos da política pelas passagens em curso que a referenciam (`ProcessStage.slaPolicyId`) na próxima reavaliação, disparada por `SlaPolicyChanged` (consumidor `SlaEvaluator`, events.md §3; a decisão é detalhada em US-191/US-192).
- **RN-SLA-13** — Desativar uma política (SLA-06) só a retira da disputa por **novas** entradas em etapa; passagens em curso continuam governadas por ela (prazo, pausas e degraus) até saírem da etapa. Ativar (SLA-05) a coloca de volta na disputa.
- **RN-SLA-14** — Ativar/desativar é idempotente: repetir a ação sobre uma política já no estado pedido responde 200 sem nova auditoria e sem novo `SlaPolicyChanged`.
- **RN-SLA-15** — Toda criação, edição, ativação e desativação grava auditoria (`sla_policy.create`, `sla_policy.update`, `sla_policy.activate`, `sla_policy.deactivate`, categoria `CONFIGURATION`) e publica `SlaPolicyChanged` (`change` = `CREATED`, `UPDATED`, `ACTIVATED`, `DEACTIVATED`) **na mesma transação** (outbox, DEC-161); `changes` traz `{ path, old, new }` dos campos escalares e, para expressões, apenas hash e tamanho.
- **RN-SLA-16** — Autorização: `SLA_POLICY_MANAGE` (risco `H`; MFA conforme `security.mfaPolicy`, POL-14) para todas as rotas SLA-01 a SLA-07; `RULE_VIEW` adicional para referenciar regra da biblioteca; não há permissão de leitura separada (o menu "Administração › Prazos" usa `SLA_POLICY_MANAGE` — permissions.md). Perfis sem a permissão veem o resultado no processo (US-190), não o cadastro.
- **RN-SLA-17** — Idempotência: SLA-02 exige `Idempotency-Key`; o reenvio devolve a mesma resposta com `Idempotent-Replayed: true`; corpo diferente com a mesma chave → `IDEMPOTENCY_KEY_REUSED`.
- **RN-SLA-18** — Listagem (SLA-01): filtros `isActive`, `workflowId`, `q` (nome ou chave, 2..100 caracteres, sem acento nem caixa) e paginação padrão (`pageSize` ≤ 100); `sort` padrão `priority` (crescente, desempate `createdAt`), aceitando `name`, `createdAt` e `updatedAt`; cada item traz `evaluationOrder` (posição entre as ativas, nulo nas inativas).
- **RN-SLA-19** — O catálogo de etapas (SLA-07) devolve, por chave estável, o nome, o tipo e os workflows em que a chave existe (rascunho, publicada ou aposentada), apenas para etapas `TASK` e `APPROVAL`; é a única fonte de `stageKey` do editor (nunca digitação livre).
- **RN-SLA-20** — Todas as entidades do módulo carregam `tenant_id` e RLS; política de outro tenant ou inexistente → 404 `SLA_POLICY_NOT_FOUND`, sem revelar existência.
- **RN-SLA-21** — Limites: o payload de SLA-02/SLA-04 aceita no máximo 50 linhas de `stages`; os limites 1..9999, −60..60, 1..30 e 5 condições `CONDITION` são limites técnicos de validação desta story.
- **RN-SLA-22** — Acessibilidade e responsividade: o editor tem rótulos associados, navegação por teclado entre abas, mensagens de erro por campo anunciadas por `aria-live`, e a lista vira cartões abaixo de 768 px; a linha do tempo dos degraus tem equivalente em texto.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chave | `key` | texto (3–60) | Sim (criação) | `^[A-Z][A-Z0-9_]*$`; imutável (RN-SLA-01) | — |
| Nome | `name` | texto (3–150) | Sim | RN-SLA-01 | — |
| Descrição | `description` | texto longo (≤ 2.000) | Não | — | — |
| Aplicabilidade | `applicabilityRule` | `RuleRef` | Sim | RN-SLA-02, RN-SLA-03 | condição própria vazia (não salva) |
| Prioridade | `priority` | inteiro 1–9999 | Não | menor vence (RN-SLA-04) | `100` |
| Workflow | `workflowId` | uuid | Não | workflow do tenant (RN-SLA-05) | nulo (todos) |
| Etapa | `stages[].stageKey` | texto (≤ 60) | Sim (por linha) | catálogo SLA-07; única por política (RN-SLA-06) | — |
| Dias | `stages[].days` | inteiro 1–365 | Sim (por linha) | RN-SLA-06 | — |
| Contagem | `stages[].dayCountType` | `DayCountType` | Sim (por linha) | `BUSINESS`/`CALENDAR` | `BUSINESS` |
| Prazo por aprovador | `stages[].approverDays` | inteiro 1–365 | Não | só etapa `APPROVAL` (RN-SLA-07) | — |
| Motivo da pausa | `pauseConditions[].reason` | `SlaPauseReason` | Sim (por item) | RN-SLA-08 | — |
| Regra da pausa | `pauseConditions[].rule` | `RuleRef` | Condicional | obrigatória em `CONDITION` | — |
| Nível do degrau | `escalationSteps[].level` | inteiro 1–5 | Sim (por item) | único, consecutivo (RN-SLA-09) | — |
| Quando (dias úteis) | `escalationSteps[].offsetBusinessDays` | inteiro −60..60 | Sim (por item) | crescente com o nível | — |
| Quem avisa | `escalationSteps[].notify` | lista de enum | Sim (por item) | ≥ 1; sem repetição | — |
| Repetir a cada (dias úteis) | `escalationSteps[].repeatEveryBusinessDays` | inteiro 1–30 | Não | só com `offset ≥ 0` | — |
| Ativa | `isActive` | booleano | Não | RN-SLA-11 | API `true`; formulário `false` |
| *(sistema)* Versão | `version` / `ETag` | inteiro | — | `If-Match` em SLA-04/05/06 | gerada |
| *(sistema)* Ordem de avaliação | `evaluationOrder` | inteiro \| nulo | — | RN-SLA-18 | calculada |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `key` fora do formato ou fora de 3–60 caracteres | Front + API (Zod) | "Use de 3 a 60 caracteres: letras maiúsculas, números e _, começando por letra." | `VALIDATION_ERROR` (`INVALID_FORMAT`) |
| V-02 | `key` já existente no tenant | API | "Já existe uma política com esta chave. Escolha outra." | `SLA_POLICY_KEY_ALREADY_EXISTS` |
| V-03 | `name` ausente ou fora de 3–150 | Front + API | "Informe o nome da política (3 a 150 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-04 | Tentativa de alterar `key` na edição | API | "A chave da política não pode ser alterada." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-05 | `applicabilityRule` ausente | Front + API | "Informe quando esta política se aplica." | `VALIDATION_ERROR` (`REQUIRED`) |
| V-06 | Expressão com caminho fora do `RuleContext` v2 (ou `sla.*`) | Front + API | "A condição usa um dado que não existe ({caminho})." | `VALIDATION_ERROR` (`RULE_PATH_UNKNOWN`) |
| V-07 | Expressão com operador fora da *allowlist* | Front + API | "A condição usa um operador não permitido ({operador})." | `VALIDATION_ERROR` (`RULE_OPERATOR_FORBIDDEN`) |
| V-08 | Regra da biblioteca inexistente, não `PUBLISHED`, aposentada ou de `kind` diferente de `SLA` | API | "Escolha uma regra publicada do tipo Prazo (SLA)." | `RULE_REF_INVALID` |
| V-09 | `priority` fora de 1–9999 | Front + API | "A prioridade deve estar entre 1 e 9999." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-10 | `workflowId` inexistente ou de outro tenant | API | "Selecione um workflow válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-11 | `stageKey` fora do catálogo (inexistente ou de etapa que não admite prazo) | Front + API | "Escolha uma etapa da lista." | `VALIDATION_ERROR` (`STAGE_KEY_UNKNOWN`) |
| V-12 | `stageKey` repetido na política | Front + API | "A etapa {nome} já tem prazo nesta política." | `VALIDATION_ERROR` (`DUPLICATE_IN_LIST`) |
| V-13 | `days` ou `approverDays` fora de 1–365 | Front + API | "O prazo deve estar entre 1 e 365 dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-14 | `approverDays` em etapa que não é de aprovação | Front + API | "Prazo por aprovador só vale para etapas de aprovação." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-15 | `CONDITION` sem `rule`; `LEGAL_DILIGENCE` repetida; mais de 5 `CONDITION` | Front + API | "Complete a condição de pausa." / "Cada motivo de pausa só pode aparecer uma vez." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`DUPLICATE_IN_LIST`/`TOO_LONG`) |
| V-16 | Degraus com `level` repetido ou não consecutivo, ou mais de 5 | Front + API | "Os degraus devem ser numerados de 1 a 5, sem pular números." | `VALIDATION_ERROR` (`LEVEL_SEQUENCE_INVALID`) |
| V-17 | `offsetBusinessDays` não crescente com o nível ou fora de −60..60 | Front + API | "Cada degrau deve acontecer depois do anterior." | `VALIDATION_ERROR` (`OFFSET_NOT_ASCENDING`/`OUT_OF_RANGE`) |
| V-18 | `notify` vazio ou com valor repetido/inválido | Front + API | "Escolha quem será avisado em cada degrau." | `VALIDATION_ERROR` (`REQUIRED`/`DUPLICATE_IN_LIST`/`INVALID_ENUM`) |
| V-19 | `repeatEveryBusinessDays` em degrau antes do vencimento ou fora de 1–30 | Front + API | "A repetição só vale a partir do vencimento (1 a 30 dias úteis)." | `VALIDATION_ERROR` (`NOT_ALLOWED`/`OUT_OF_RANGE`) |
| V-20 | `If-Match` ausente ou divergente em SLA-04/05/06 | API | "A política foi alterada por outra pessoa. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-21 | Mais de 50 linhas em `stages` | API (Zod) | "Uma política aceita no máximo 50 etapas." | `VALIDATION_ERROR` (`TOO_LONG`) |

## Permissões
- **Permissão:** `SLA_POLICY_MANAGE` para SLA-01 a SLA-07 (cadastro e consulta); `RULE_VIEW` adicional para referenciar regra da biblioteca (aplicabilidade e pausas `CONDITION`).
- **Políticas:** POL-27 (alterações só valem para efeitos futuros); POL-14 (MFA para permissão `H`); RLS por tenant. Perfis padrão: `ADMIN_ORGAO` e `GESTOR_CONTRATACOES` (permissions.md §5).
- **MFA:** exigido para `SLA_POLICY_MANAGE` (risco `H`) quando `security.mfaPolicy` é `ADMINS` ou `ALL`; sem MFA → 403 `MFA_REQUIRED`.
- **Sem permissão:** o item "Administração › Prazos" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode = SLA_POLICY_MANAGE`); referência a regra da biblioteca sem `RULE_VIEW` → 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `SlaPolicyChanged` | `sla_policy.changed` | Commit de SLA-02 (`CREATED`), SLA-04 (`UPDATED`), SLA-05 (`ACTIVATED`) e SLA-06 (`DEACTIVATED`) | `slaPolicyId`, `key`, `change`; consumidores: `C` (cache de configuração) e `S` (`SlaEvaluator` reavalia pausas e degraus das passagens em curso que usam a política — US-191/US-192). Sem texto de regra no payload |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: o cadastro de política é configuração administrativa; a mudança fica na auditoria e no evento `SlaPolicyChanged`. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Cadastrar políticas de SLA

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina Costa" tem vínculo ativo com o perfil "ADMIN_ORGAO", a permissão "SLA_POLICY_MANAGE" e MFA satisfeito
    And o workflow "Fase preparatória — Lei 14.133/2021" tem as etapas "PLANEJAMENTO" e "JURIDICO" (TASK) e "AUTORIZACAO_LICITACAO" (APPROVAL)

  Scenario: [Sucesso] Criar a política "PREGAO_ALTO_VALOR" inativa
    When "Marina Costa" criar a política com chave "PREGAO_ALTO_VALOR", nome "Pregão de alto valor", prioridade 10
    And aplicabilidade INLINE "process.modalityCode = PREGAO e process.estimatedValue > 1000000"
    And prazo de 15 dias úteis na etapa "JURIDICO" e 3 dias úteis por aprovador na etapa "AUTORIZACAO_LICITACAO"
    And pausa "LEGAL_DILIGENCE" e um degrau 1 em -2 dias úteis avisando "ASSIGNEE" e "DEPARTMENT_HEAD"
    And "isActive" igual a false
    Then a API deve responder 201 com "ETag" e "Location"
    And a política deve ter "isActive" falso e "evaluationOrder" nulo
    And deve gerar registro de auditoria "sla_policy.create"
    And deve gerar o evento "SlaPolicyChanged" com "change" "CREATED"

  Scenario: [Sucesso] Ativar a política e ver a ordem de avaliação
    Given que existe a política ativa "PADRAO_PREGAO" com prioridade 100
    When "Marina Costa" ativar "PREGAO_ALTO_VALOR" com o "If-Match" atual
    Then a API deve responder 200 e a listagem deve mostrar "PREGAO_ALTO_VALOR" em "evaluationOrder" 1 e "PADRAO_PREGAO" em 2
    And deve gerar registro de auditoria "sla_policy.activate"
    And deve gerar o evento "SlaPolicyChanged" com "change" "ACTIVATED"

  Scenario: [Sucesso] Editar o prazo vale só para novas entradas
    Given que o processo "0034/2026" está na etapa "JURIDICO" com "dueAt" calculado em 15 dias úteis pela política
    When "Marina Costa" alterar o prazo de "JURIDICO" para 12 dias úteis com o "If-Match" atual
    Then a API deve responder 200 com "ETag" nova
    And o "dueAt" da etapa em curso do processo "0034/2026" deve permanecer o mesmo
    And deve gerar registro de auditoria "sla_policy.update" com "changes" do campo "stages"
    And deve gerar o evento "SlaPolicyChanged" com "change" "UPDATED"

  Scenario: [Sucesso] Desativar a política mantém as passagens em curso
    When "Marina Costa" desativar "PREGAO_ALTO_VALOR"
    Then a API deve responder 200 e "isActive" deve ser falso
    And as etapas em curso que usam a política devem continuar com "slaPolicyId" preenchido
    And deve gerar registro de auditoria "sla_policy.deactivate"
    And deve gerar o evento "SlaPolicyChanged" com "change" "DEACTIVATED"

  Scenario: [Validação] Configurações inválidas são recusadas
    When "Marina Costa" enviar a chave "pregao alto"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "INVALID_FORMAT" no campo "key"
    When "Marina Costa" enviar a etapa "ARQUIVO_MORTO" que não existe em nenhum workflow
    Then a API deve responder 422 com erro "STAGE_KEY_UNKNOWN" no campo "stages[0].stageKey"
    When "Marina Costa" enviar "approverDays" 3 na etapa "JURIDICO"
    Then a API deve responder 422 com erro "NOT_ALLOWED" no campo "stages[0].approverDays"
    When "Marina Costa" enviar uma pausa "CONDITION" sem regra
    Then a API deve responder 422 com erro "CONDITIONAL_REQUIRED" no campo "pauseConditions[0].rule"
    When "Marina Costa" enviar degraus com níveis 1 e 3
    Then a API deve responder 422 com erro "LEVEL_SEQUENCE_INVALID" no campo "escalationSteps"
    When "Marina Costa" usar o caminho "sla.paused" na aplicabilidade
    Then a API deve responder 422 com erro "RULE_PATH_UNKNOWN" no campo "applicabilityRule"
    And nenhuma política, auditoria ou evento deve ser gravado

  Scenario: [Permissão] Sem permissão, sem MFA e sem acesso à biblioteca
    Given que "Bruno Lopes" não possui "SLA_POLICY_MANAGE"
    When "Bruno Lopes" chamar "GET /sla-policies"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" "SLA_POLICY_MANAGE"
    Given que "Marina Costa" está com a sessão sem MFA e "security.mfaPolicy" igual a "ADMINS"
    When "Marina Costa" chamar "POST /sla-policies"
    Then a API deve responder 403 com código "MFA_REQUIRED"
    Given que "Gilberto Rocha" tem "SLA_POLICY_MANAGE" mas não tem "RULE_VIEW"
    When "Gilberto Rocha" enviar aplicabilidade "LIBRARY" com uma regra publicada do tipo "SLA"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Política e workflow de outro tenant
    Given que existe a política "PREGAO_ALTO_VALOR" no tenant "Prefeitura B"
    When "Marina Costa", no tenant "Prefeitura A", chamar "GET /sla-policies/{id-da-Prefeitura-B}"
    Then a API deve responder 404 com código "SLA_POLICY_NOT_FOUND"
    When "Marina Costa" enviar "workflowId" de um workflow do tenant "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "workflowId"

  Scenario: [Duplicidade] Chave repetida e reenvio idempotente
    Given que já existe a política "PREGAO_ALTO_VALOR"
    When "Marina Costa" criar outra política com a chave "PREGAO_ALTO_VALOR"
    Then a API deve responder 409 com código "SLA_POLICY_KEY_ALREADY_EXISTS"
    Given que "Marina Costa" criou "COMPRA_DIRETA_PEQUENA" com a chave de idempotência "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo corpo e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única política "COMPRA_DIRETA_PEQUENA" e um único evento "SlaPolicyChanged"
    When "Marina Costa" ativar duas vezes a política já ativa
    Then a segunda chamada deve responder 200 sem nova auditoria nem novo evento

  Scenario: [Concorrência] Dois administradores editam a mesma política
    Given que "Marina Costa" e "Gilberto Rocha" abriram a política "PREGAO_ALTO_VALOR" com o mesmo "ETag"
    When "Marina Costa" salvar a alteração e, em seguida, "Gilberto Rocha" salvar com o "ETag" antigo
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    And a política deve conter apenas a alteração de "Marina Costa"

  Scenario: [Falha de banco] Banco indisponível ao gravar a política
    Given que o banco de dados fica indisponível durante a transação de "POST /sla-policies"
    When "Marina Costa" salvar a política
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma política, linha de prazo, auditoria ou evento deve ter sido gravado
    And o formulário deve ser preservado com o botão "Tentar novamente"

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Marina Costa" ativar a política "PREGAO_ALTO_VALOR"
    Then a API deve responder 200
    And o evento "SlaPolicyChanged" deve permanecer "PENDING" no outbox até o relay voltar

  Scenario: [Falha de integração] Redis indisponível no armazenamento de idempotência
    Given que o Redis está indisponível
    When "Marina Costa" criar uma política com "Idempotency-Key"
    Then a API deve responder 201 sem cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (campo, intervalo, lista) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca cada campo e abre a aba com erro |
| Chave já existente | 409 | `SLA_POLICY_KEY_ALREADY_EXISTS` | "Já existe uma política com esta chave. Escolha outra." | Foco no campo "Chave" |
| Regra da biblioteca inválida ou aposentada | 422 | `RULE_REF_INVALID` | "Escolha uma regra publicada do tipo Prazo (SLA)." | Abre o seletor de regras |
| Política inexistente ou de outro tenant | 404 | `SLA_POLICY_NOT_FOUND` | "Política não encontrada." | Volta à lista |
| Sem `SLA_POLICY_MANAGE` ou sem `RULE_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para gerenciar prazos." | Oculta o menu; rota 403 (SCR-111) |
| MFA exigido | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Conduz ao passo de MFA e preserva o formulário |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A política foi alterada por outra pessoa. Recarregue e tente de novo." | Oferece "Recarregar" e mantém o rascunho local |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente novamente." | Recarrega |
| Mesma chave de idempotência com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar a política agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

Os códigos de campo (`RULE_PATH_UNKNOWN`, `RULE_OPERATOR_FORBIDDEN`, `STAGE_KEY_UNKNOWN`, `LEVEL_SEQUENCE_INVALID`, `OFFSET_NOT_ASCENDING`) são novos em `errors[].code` de `VALIDATION_ERROR` e serão registrados no `api.md` do MVP 2.

## Dependências
- **Stories:** US-055 (prazo por etapa em dias úteis, `slaDays`/`slaType` — a base que a política substitui), US-106 (calendário de dias úteis e feriados), US-129 (`RuleContext` v2 e provedores por módulo — contrato dos caminhos aceitos). Habilita: US-190 (aplicação), US-191 (pausas), US-192 (escalonamento). Indiretas: US-040/US-043 (chaves estáveis de etapa), US-194 (biblioteca de regras `kind = SLA`), US-153 (diligência do jurídico — motivo `LEGAL_DILIGENCE`), US-114 (avisos de prazo do MVP 1).
- **Decisões/ADRs:** DEC-205, DEC-031, DEC-204, DEC-193 (prazo por linha), DEC-206, DEC-161; ADR-015, ADR-008; POL-27, POL-14.
- **Configurações:** `sla.escalationEnabled` (efeito em US-192), `deadlines.warnBeforeBusinessDays`, `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **Padrão de criação:** `entities.md §4.9` dá `isActive = true` por padrão; esta story mantém o padrão na API e envia `false` pelo formulário (RN-SLA-11). Confirmar com o produto se a criação deve nascer inativa também na API.
  2. **Faixas e limites técnicos propostos:** `priority` 1..9999, `offsetBusinessDays` −60..60, `repeatEveryBusinessDays` 1..30, até 5 condições `CONDITION`, até 50 linhas de prazo (RN-SLA-04/09/21) — `entities.md §4.9/§7.8` não define faixas; registrar no `api.md` do MVP 2.
  3. **Códigos de erro de campo novos** (`STAGE_KEY_UNKNOWN`, `LEVEL_SEQUENCE_INVALID`, `OFFSET_NOT_ASCENDING`, `RULE_PATH_UNKNOWN`, `RULE_OPERATOR_FORBIDDEN`) e de negócio (`SLA_POLICY_KEY_ALREADY_EXISTS`, `SLA_POLICY_NOT_FOUND`, `RULE_REF_INVALID`) ausentes de `api.md`; os códigos de `RuleRef` devem ser unificados com o EP-031.
  4. **Escopo das alterações sobre passagens em curso:** `entities.md §4.9` diz que a política vale para novas entradas e que passagens mantêm o snapshot; como `ProcessStage` guarda só `slaPolicyId`, `slaDays`, `slaType` e `dueAt`, esta story interpreta que o snapshot cobre **prazo** e que pausas e degraus são lidos da política na reavaliação (RN-SLA-12). **Dúvida de produto** a confirmar.
  5. **Aplicabilidade do modelo semeado `PADRAO_FASE_PREPARATORIA`:** `entities.md §9` não diz qual `applicabilityRule` ele traz (campo obrigatório); definir no seeder.
  6. **Catálogo de etapas (SLA-07)** e **permissão de leitura:** não há `SLA_POLICY_VIEW`; auditores não veem o cadastro (só o resultado no processo).
  7. **Componente de `RuleRef`** (editor INLINE/seletor LIBRARY) é compartilhado com SCR-034/SCR-035 (US-129/US-194); esta story o consome e, se ainda não existir, entrega a versão mínima INLINE.

## Impacto técnico
- **Novo módulo `sla`** (nível a definir com a arquitetura, dependendo de `workflow`, `rules` e `process` apenas por fachadas): proprietário de `sla_policies` e `sla_policy_stages`; nenhum outro módulo lê as tabelas diretamente (regra D9 e dependency-cruiser).
- **Validação de expressão:** reaproveita o avaliador JSON Logic da ADR-008 em modo de validação estática (caminhos do contexto v2, operadores da *allowlist*), sem executá-lo; a montagem de contexto de amostra é preguiçosa.
- **Substituição de arrays:** `stages`, `pauseConditions` e `escalationSteps` são gravados em uma transação (substituição inteira); `SlaPolicyStage` cai por `CASCADE` e é recriado.
- **Efeito sobre processos em curso:** nenhum dado de `ProcessStage` é alterado por esta story; o consumidor `SlaEvaluator` reage a `SlaPolicyChanged` conforme US-191/US-192.
- **Risco de configuração:** duas políticas casando — mitigado por `priority`, ordem de avaliação visível e pré-visualização em US-190; política com expressão que nunca casa — o preview de US-190 mostra os candidatos avaliados.
- **Performance:** a lista é pequena (dezenas); índice `(tenant_id, is_active, priority)` atende a leitura que US-190 faz a cada entrada em etapa.

## Backend
- **Módulo(s):** `sla` (dono), `workflow` (catálogo de etapas por fachada `WorkflowFacade.listStageKeys`), `rules` (leitura da versão de regra por fachada, quando `LIBRARY`), `audit`, `platform` (`OutboxWriter`, idempotência).
- **Casos de uso:** `ListSlaPoliciesQuery`, `GetSlaPolicyQuery`, `ListSlaStageCatalogQuery`; `CreateSlaPolicyCommand`, `UpdateSlaPolicyCommand`, `ActivateSlaPolicyCommand`, `DeactivateSlaPolicyCommand`.
- **Domínio:** `SlaPolicy` (agregado; invariantes RN-SLA-01..14), `SlaPolicyStage`, value objects `SlaPauseCondition` e `SlaEscalationStep` (schemas `slaPauseConditionSchema` e `slaEscalationStepSchema` em `packages/validation`), `RuleRef`; `SlaPolicyValidator` (expressão, referências, ordem dos degraus).
- **Integrações internas:** `RuleExpressionValidator` (ADR-008, contexto v2), `RuleLibraryFacade.getPublishedVersion`, `WorkflowFacade`, `AuthorizationService.assertCan(SLA_POLICY_MANAGE)` e `MfaGuard`, `AuditService`, `OutboxWriter`.
- **Transação:** em uma transação com `app.tenant_id`: validação → gravação de `sla_policies` e `sla_policy_stages` → auditoria (`sla_policy.*`) → outbox (`SlaPolicyChanged`) → commit.

## Frontend
- **Tela(s):** SCR-121 (`/admin/prazos`), modelo `ListPage` (lista) e `DetailPage` com abas (editor).
- **Componentes:** `SlaPolicyTable` (ordem de avaliação, selo de empate, situação), `SlaPolicyEditor` com abas `ApplicabilityTab`, `StageDeadlinesTab`, `PauseConditionsTab`, `EscalationStepsTab`; `RuleRefField` (INLINE/LIBRARY), `StageKeySelect` (SLA-07), `EscalationTimelinePreview`, `ActivateSwitch`, `ImpactNotice` ("A alteração vale para as próximas entradas em etapa").
- **Estados:** *skeleton* na lista e no editor; vazio (FA-01); erro com `correlationId` e "Tentar novamente"; erros por campo com foco na primeira aba inválida; conflito de versão (FA-07); sucesso com toast "Política salva".
- **Acessibilidade e responsividade:** abas com `role="tablist"` e navegação por teclado; erros anunciados por `aria-live`; linha do tempo dos degraus com texto equivalente; contraste AA; lista em cartões e editor em coluna única abaixo de 768 px (uso administrativo, desktop-first).

## Banco de dados
- **Tabelas:** `sla_policies` (`key`, `name`, `description`, `applicability_rule` jsonb, `priority`, `workflow_id`, `pause_conditions` jsonb, `escalation_steps` jsonb, `is_active`, campos de `Padrão`) e `sla_policy_stages` (`sla_policy_id`, `stage_key`, `days`, `day_count_type`, `approver_days`) — entities.md §4.9; leitura de `workflows`/`workflow_stages` (catálogo) e `rule_definition_versions`; `audit_logs`, `outbox_events`.
- **Migrações:** **M2-10** (`sla_policies`, `sla_policy_stages`; FK `process_stages.sla_policy_id` — reversível), depois de **M2-09** (biblioteca de regras); sementes M2-21 (modelo `PADRAO_FASE_PREPARATORIA` inativo). RLS `ENABLE`/`FORCE`, *grants* de `cf_app` e `cf_worker` e entrada nas suítes de tenant leak e de autorização.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)`; `(tenant_id, is_active, priority)`; `UNIQUE (tenant_id, sla_policy_id, stage_key)`; check `days BETWEEN 1 AND 365` e `approver_days IS NULL OR approver_days BETWEEN 1 AND 365`; FK composta `(tenant_id, workflow_id)` → `workflows`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `SLA-01` | GET | `/api/v1/sla-policies` | `?isActive=&workflowId=&q=&page=&pageSize=&sort=` | `200 { data: [{ id, key, name, description, priority, workflow { id, name } \| null, isActive, applicability { mode, label }, stagesCount, pauseConditionsCount, escalationStepsCount, evaluationOrder, version, createdAt, updatedAt }], meta }` | 200, 401, 403, 422, 429, 503 |
| `SLA-02` | POST | `/api/v1/sla-policies` | `{ key, name, description?, applicabilityRule, priority?, workflowId?, stages?, pauseConditions?, escalationSteps?, isActive? }` + `Idempotency-Key` | `201 { data: SlaPolicy }` + `Location`, `ETag` | 201, 401, 403, 409, 422, 429, 503 |
| `SLA-03` | GET | `/api/v1/sla-policies/{id}` | path `id` | `200 { data: SlaPolicy completa }` + `ETag` | 200, 401, 403, 404, 429, 503 |
| `SLA-04` | PATCH | `/api/v1/sla-policies/{id}` | campos parciais; arrays enviados substituem os anteriores; `If-Match` | `200 { data: SlaPolicy }` + `ETag` nova | 200, 401, 403, 404, 412, 422, 428, 503 |
| `SLA-05` | POST | `/api/v1/sla-policies/{id}/activate` | `If-Match` | `200 { data: SlaPolicy }` | 200, 401, 403, 404, 412, 422, 428, 503 |
| `SLA-06` | POST | `/api/v1/sla-policies/{id}/deactivate` | `If-Match` | `200 { data: SlaPolicy }` | 200, 401, 403, 404, 412, 428, 503 |
| `SLA-07` | GET | `/api/v1/sla-policies/stage-catalog` | `?workflowId=` (opcional) | `200 { data: [{ stageKey, name, type, isApproval, workflows: [{ id, name }] }] }` | 200, 401, 403, 404, 422, 503 |

`SlaPolicy` = `{ id, key, name, description, applicabilityRule, priority, workflowId, stages: [{ stageKey, days, dayCountType, approverDays }], pauseConditions, escalationSteps, isActive, version, createdAt, updatedAt }`. Todas as rotas exigem `SLA_POLICY_MANAGE` (e MFA conforme POL-14).

## Logs
- `info` `sla.policy_created` / `sla.policy_updated` / `sla.policy_activated` / `sla.policy_deactivated` — `slaPolicyId`, `key`, `stagesCount`, `stepsCount`, `durationMs`, `correlationId`.
- `warn` `sla.policy_validation_failed` — `errorCodes` por campo (sem a expressão); `warn` `idempotency.store_unavailable`.
- `error` `sla.policy_save_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o conteúdo das expressões de regra (apenas hash e tamanho), descrições livres, dados de processos.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `sla_policy.create` | `CONFIGURATION` | Commit de SLA-02 | `changes`: campos escalares e contagens; expressões como hash e tamanho; `metadata`: `slaPolicyId`, `key`, `isActive` |
| `sla_policy.update` | `CONFIGURATION` | Commit de SLA-04 | `changes`: `{ path, old, new }` por campo alterado (linhas de prazo, pausas e degraus em diff estruturado); `metadata`: `key`, `fromVersion`, `toVersion` |
| `sla_policy.activate` | `CONFIGURATION` | Commit de SLA-05 (só quando muda) | `changes`: `isActive` falso → verdadeiro |
| `sla_policy.deactivate` | `CONFIGURATION` | Commit de SLA-06 (só quando muda) | `changes`: `isActive` verdadeiro → falso |
| `access.denied` | `ACCESS` | 403 em SLA-01..SLA-07 | `reasonCode = SLA_POLICY_MANAGE` (ou `RULE_VIEW`), `slaPolicyId?` |

## Testes necessários
- **Unitários:** `SlaPolicyValidator` (chave, intervalos, estágios únicos, `approverDays` só em `APPROVAL`, degraus consecutivos e crescentes, `repeat` só com `offset ≥ 0`, `CONDITION` com regra, `sla.*` proibido); ordenação por `priority`/`createdAt`; semântica de substituição dos arrays; idempotência de ativar/desativar.
- **Integração (Testcontainers PostgreSQL):** criar/editar/ativar/desativar com auditoria e outbox atômicos; `UNIQUE (tenant_id, key)`; RLS; catálogo de etapas por workflow e por versão; política com `LIBRARY` aposentada; migração M2-10 e semente `PADRAO_FASE_PREPARATORIA`.
- **API/contrato:** SLA-01..SLA-07 conforme `api.md` do MVP 2; `ETag`/`If-Match`; `Idempotency-Key`; códigos de campo novos.
- **RBAC e multi-tenant:** `SLA_POLICY_MANAGE` por rota, `RULE_VIEW` para `LIBRARY`, MFA (`MFA_REQUIRED`); política e workflow de outro tenant → 404/422 (suíte "tenant leak": `sla_policies`, `sla_policy_stages`).
- **Concorrência:** duas edições com o mesmo `ETag` (uma 200, outra 412); criação simultânea da mesma chave (uma 201, outra 409).
- **E2E (Playwright):** criar política do pregão de alto valor com prazo, pausa e degrau → salvar inativa → ativar → editar prazo → desativar; ver a ordem de avaliação e o aviso de impacto.
- **Acessibilidade/performance:** axe nas quatro abas e na lista; navegação por teclado; lista com 200 políticas fora de cenário real (p95 < 300 ms) apenas como teste de sanidade.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Migração M2-10 revisada (reversível) e semente do modelo inativo verificada
- [ ] Validação estática de expressão cobre caminhos do contexto v2 e proíbe `sla.*`
- [ ] Teste prova que alterar/desativar política não muda `dueAt` de passagens em curso

## Estimativa
**L** — módulo novo com duas tabelas, sete endpoints, validações densas (expressão, referências, ordem de degraus), editor de quatro abas com componente de regra, auditoria e evento atômicos e suíte de isolamento.

## Prioridade
**P1** — evolui o prazo por etapa do MVP 1 (que continua sendo a base) e habilita US-190 a US-192 e as regras do EP-031; não bloqueia o DT-02/DT-03 nem a fase preparatória, por isso fica abaixo das stories P0.
