---
id: US-193
title: "Regras de notificação condicional"
epic: EP-030
feature: FT-087
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-083, US-111, US-112, US-129]
modules: [notification, process, rules, audit, platform]
screens: [SCR-122]
endpoints: [NTR-01, NTR-02, NTR-03, NTR-04, NTR-05, NTR-06, NTR-07, NTR-08, NTR-09]
permissions: [NOTIFICATION_RULE_MANAGE, RULE_VIEW, PROCESS_VIEW]
events: [NotificationRuleChanged, NotificationRuleAutoDisabled]
---

# US-193 — Regras de notificação condicional

## Título
Regras de notificação condicional

## Descrição
**Como** administrador do órgão, **quero** definir regras que avisem as pessoas certas quando um fato relevante acontece em um processo — por exemplo, o gestor quando uma etapa é dispensada em processo urgente —, escolhendo o evento, uma condição opcional, os destinatários e o texto da mensagem, **para** que cada órgão decida quem precisa saber de quê, sem pedir alteração de sistema e sem inundar ninguém de avisos.

A story cria a `NotificationRule` e a `NotificationRuleExecution` no módulo `notification` e a tela **SCR-122 — Regras de notificação** (`/admin/notificacoes/regras`): cadastrar, editar, ativar, desativar, pré-visualizar e consultar o histórico de execuções. No worker, o `NotificationRuleDispatcher` consome os eventos marcados como "notificável por regra" (NR), avalia a condição sobre o `RuleContext` v2 do processo do evento, resolve os destinatários, respeita visibilidade e preferências e cria a notificação `RULE_NOTIFICATION`, de forma **assíncrona e idempotente** (chave `eventId` + regra). Há contenção por destinatário (por dia) e por regra (por hora), com **desligamento automático** (`AUTO_DISABLED`) e aviso a quem administra as regras (`NOTIFICATION_RULE_DISABLED`).

## Contexto
- As notificações do MVP 1 são fixas: cada `NotificationType` tem origem e destinatários definidos no registro (events.md §6 do MVP 1) e o usuário só escolhe canais (US-113). A DEC-205 acrescenta a `NotificationRule` — evento de origem + condição JSON Logic + destinatários por papel, unidade ou responsável + modelo de mensagem — entregue pelo módulo `notification` com o tipo `RULE_NOTIFICATION`; as preferências do usuário continuam valendo.
- A ADR-015 manda executar a regra **fora** da transação do comando, no worker, com idempotência por `eventId` + regra e contenção para evitar "tempestade de notificações" por regra mal escrita: limite por regra e por destinatário, agrupamento e desligamento automático com alerta ao administrador.
- Só eventos marcados **NR** em events.md podem ser origem: têm `processId` e não carregam dado sensível no payload. Hoje são `ProcessBranchesOpened`, `ProcessBranchesJoined`, `ProcessStageSkipped`, `ProcessStageEscalated`, `BudgetAllocationConfirmed`, `BudgetAllocationCanceled`, `LegalReviewDiligenceRequested`, `LegalReviewConcluded`, `LegalReviewWaived` e `InternalControlReviewConcluded`.
- `NotificationRule` (entities.md §4.10) tem `eventType`, `condition` (`RuleRef`), `recipients` (`NotificationRecipientSpec`, §7.9), `titleTemplate` (≤ 200), `bodyTemplate` (≤ 1000), `priority`, `sendEmail`, `maxPerRecipientPerDay` (1..200, padrão 20), `status` (`ACTIVE`, `INACTIVE`, `AUTO_DISABLED`) e `autoDisabledAt`/`autoDisabledReason`. `NotificationRuleExecution` guarda `matched`, `recipientsCount` e `suppressedCount` com unicidade `(tenant_id, notification_rule_id, source_event_id)`, retenção de 90 dias e escrita só pelo worker.
- Os modelos de mensagem aceitam apenas as variáveis `{{process.code}}`, `{{process.title}}`, `{{stage.name}}`, `{{department.name}}`, `{{event.label}}`, `{{dueAt}}` e `{{link}}`; nunca valores de orçamento nem conteúdo de documento (DEC-086; POL-09).
- `NOTIFICATION_RULE_MANAGE` é permissão nova (risco `M`, POL-27); `RULE_VIEW` permite escolher a condição na biblioteca de regras (EP-031). A chave `notificationRules.maxPerRulePerHour` (padrão 500, faixa 10..5.000) define o teto por regra por hora.
- A feature fica no EP-030 por decisão da DEC-205, ainda que o contexto venha do `RuleContext` v2 (US-129); a regra de modelo `NOTIFICAR_GESTOR_PRAZO_VENCIDO` (semeada, sem uso até a adoção) é uma condição da biblioteca (EP-031) que pode ser escolhida aqui.

## Objetivo
Permitir que um administrador publique, em até 10 minutos e sem apoio técnico, uma regra de notificação funcional e segura, com garantia de que nenhum evento gera notificação duplicada, nenhum texto traz dado sigiloso, nenhuma pessoa recebe mais que o limite diário da regra e nenhuma regra mal escrita gera mais que o teto por hora sem ser desligada e avisada.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`), com `NOTIFICATION_RULE_MANAGE`.
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`), que também tem a permissão por padrão; destinatários típicos — gestores, titulares de unidade e de secretaria, Controle Interno e Auditoria — que recebem as notificações.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE` e `NOTIFICATION_RULE_MANAGE` (MFA apenas se `security.mfaPolicy = ALL`, por ser permissão de risco `M`).
- `RuleContext` v2 disponível (US-129) e catálogo de eventos notificáveis publicado (events.md).
- Worker, filas `domain-events` e `notifications` e `NotificationDispatcher` (US-111) em operação; e-mail (US-112) opcional.

## Fluxo principal
1. O administrador abre **Administração › Regras de notificação** (SCR-122); o front chama NTR-01 e NTR-09 (catálogo de eventos) em paralelo, com skeleton até a resposta.
2. A lista mostra nome, evento (rótulo), resumo da condição, resumo dos destinatários, e-mail (sim/não), situação (Ativa, Inativa, Desligada automaticamente) e última execução; regras `AUTO_DISABLED` exibem o motivo e a data.
3. O administrador aciona **"Nova regra"**; o editor abre com quatro blocos: **Quando** (evento da lista de NTR-09 e condição opcional — regra da biblioteca com `RULE_VIEW`, ou condição própria sobre o contexto do processo), **Quem recebe** (responsável pela etapa, membros da unidade atual, titular da unidade, titular da secretaria solicitante, criador do processo, participantes, perfis e usuários específicos), **Mensagem** (título e corpo com as variáveis permitidas e prévia ao vivo) e **Limites e canais** (prioridade, e-mail, máximo por destinatário por dia).
4. Ao salvar, o front envia NTR-02 com `Idempotency-Key`; a API valida, grava a regra, audita `notification_rule.create` e publica `NotificationRuleChanged` (`CREATED`) na mesma transação; responde 201 com `ETag`.
5. Antes ou depois de ativar, o administrador usa **"Pré-visualizar"** (NTR-08): escolhe um processo de exemplo (com `PROCESS_VIEW`) ou usa dados de exemplo, e vê o texto renderizado, se a condição seria verdadeira e quantos destinatários seriam alcançados (por categoria, sem nomes).
6. O administrador ativa a regra (NTR-05, `If-Match`); a API audita `notification_rule.activate` e publica `NotificationRuleChanged` (`ACTIVATED`).
7. Quando um evento elegível ocorre (por exemplo, `ProcessStageSkipped` no processo urgente `0040/2026`), o worker recebe o evento na fila `notifications`; o `NotificationRuleDispatcher` busca as regras `ACTIVE` daquele `eventType`, registra a execução (`NotificationRuleExecution`) de forma idempotente, avalia a condição sobre o `RuleContext` v2 do processo, resolve os destinatários, aplica visibilidade, preferências e limites e cria a notificação `RULE_NOTIFICATION` com o título e o corpo renderizados (e e-mail, se a regra e o usuário permitirem).
8. O destinatário vê o aviso no sininho (SCR-036), com o link para o processo; o administrador acompanha o resultado em **"Execuções"** (NTR-07): evento, processo, se casou, quantos receberam e quantos foram barrados pelo limite.
9. Se a regra passar do teto por hora do órgão, o dispatcher a coloca em `AUTO_DISABLED`, registra `notification_rule.auto_disable`, publica `NotificationRuleAutoDisabled` e cria `NOTIFICATION_RULE_DISABLED` para quem tem `NOTIFICATION_RULE_MANAGE`; a lista mostra "Desligada automaticamente: excedeu {limite} disparos em 1 hora".
10. O administrador revisa a condição, reativa (NTR-05) ou desativa (NTR-06); edições (NTR-04, `If-Match`) valem somente para eventos futuros.

## Fluxos alternativos
- **FA-01 — Sem regras cadastradas:** estado vazio "Nenhuma regra de notificação. Crie uma regra para avisar as pessoas certas quando algo importante acontecer."
- **FA-02 — Evento não notificável:** o seletor só oferece os eventos de NTR-09; enviar outro evento é recusado (`EVENT_NOT_NOTIFIABLE`).
- **FA-03 — Sem `RULE_VIEW`:** a opção "Regra da biblioteca" fica oculta; só a condição própria está disponível.
- **FA-04 — Condição nula:** a regra vale para todo evento do tipo ("sempre").
- **FA-05 — Condição com erro na avaliação:** a execução é registrada como `matched = false`, nada é enviado e o erro vai ao log `warn` sem expressão nem valores (RN-SLA-68).
- **FA-06 — Destinatários demais (> 50):** o conjunto resolvido é reduzido a titular e substituto da unidade (regra do MVP 1, events.md §6) e a execução registra o fato em log `warn`.
- **FA-07 — Pessoa sem visibilidade do processo, que já recebeu o aviso antes de perdê-la:** não recebe (DEC-024, RN-NTF-06); a execução não a conta em `recipientsCount`.
- **FA-08 — Duas regras casam com o mesmo evento para a mesma pessoa:** a pessoa recebe **uma** `RULE_NOTIFICATION` por evento; vale a regra de `createdAt` mais antiga e a outra registra o excedente em `suppressedCount` (RN-SLA-77).
- **FA-09 — Limite diário por destinatário atingido:** o excedente é suprimido e contado em `suppressedCount`; quem já recebeu o máximo do dia não recebe mais daquela regra até o dia seguinte (fuso do tenant).
- **FA-10 — Regra `AUTO_DISABLED`:** eventos que ocorrerem enquanto ela estiver desligada não são reprocessados depois da reativação (RN-SLA-76).
- **FA-11 — Edição durante o processamento:** o evento em processamento usa o estado da regra lido no início; a edição vale do evento seguinte em diante.
- **FA-12 — E-mail desligado no órgão ou pela pessoa:** só a notificação in-app é criada (`notifications.emailEnabled`, US-113).
- **FA-13 — Pré-visualização sem processo:** usa dados de exemplo (`sample = true`), sem condição avaliada e sem contagem de destinatários reais.

## Regras de negócio
- **RN-SLA-67** — Eventos elegíveis: só eventos marcados **NR** em events.md (com `processId` e sem dado sensível no payload) podem ser `eventType` de uma regra; NTR-09 devolve o catálogo (`eventType`, `routingKey`, rótulo em pt-BR, grupo e variáveis disponíveis); `eventType` fora dele → `VALIDATION_ERROR` (`EVENT_NOT_NOTIFIABLE`). O catálogo vem do registro de eventos em `packages/types` (marcação `notifiableByRule`).
- **RN-SLA-68** — Condição: `condition` é nula ("sempre") ou um `RuleRef` — `INLINE` com `contextVersion = 2` (expressão validada pelo executor da ADR-008) ou `LIBRARY` com versão `PUBLISHED` de regra de `kind = NOTIFICATION` (exige `RULE_VIEW`). É avaliada pelo worker sobre o `RuleContext` v2 do **processo do evento**, montado de forma preguiçosa **no momento do processamento** (estado atual, não o do instante do evento); os caminhos `sla.*` são permitidos aqui (ex.: `sla.overdue`). Erro de avaliação conta como falsa (*fail-closed*) e é registrado em `warn`.
- **RN-SLA-69** — Destinatários (`NotificationRecipientSpec`): ao menos um seletor entre `assignee`, `currentDepartmentMembers`, `departmentHead`, `requestingSecretariatHead`, `processCreator`, `participants`, `roleKeys[]` (perfis ativos do tenant; recebem os detentores com escopo sobre o processo) e `userIds[]` (vínculos ativos); `roleKeys` e `userIds` aceitam até 50 itens cada; referência inexistente ou de outro tenant → `REFERENCE_NOT_FOUND`; spec vazio → `RECIPIENTS_EMPTY`.
- **RN-SLA-70** — Resolução e filtros de entrega: o dispatcher resolve a união dos seletores sobre o processo do evento, remove repetições e aplica, nesta ordem: visibilidade do processo (DEC-024), exclusão do ator do evento (RN-NTF-02, quando houver), preferências do usuário para `(RULE_NOTIFICATION, canal)` (US-113) e, para e-mail, `sendEmail` da regra **e** `notifications.emailEnabled`; o máximo é de 50 destinatários resolvidos — acima disso, titular e substituto da unidade (regra do MVP 1).
- **RN-SLA-71** — Modelos de mensagem: `titleTemplate` (1..200) e `bodyTemplate` (1..1000) em texto simples; só as variáveis `{{process.code}}`, `{{process.title}}`, `{{stage.name}}`, `{{department.name}}`, `{{event.label}}`, `{{dueAt}}` e `{{link}}` (sintaxe exata `{{nome}}`); variável fora da *allowlist* → `UNKNOWN_VARIABLE`, chaves desbalanceadas → `TEMPLATE_SYNTAX_INVALID`. A renderização ocorre no worker: variável sem valor no evento vira texto vazio, `{{dueAt}}` sai em `dd/mm/aaaa` no fuso do tenant, `{{link}}` é a rota relativa `/processos/{id}` (RN-NTF-08), e o resultado é truncado em 200/1000 caracteres. **Nunca** valores de orçamento, conteúdo de documento, texto de diligência, ressalva ou achado (POL-09, RN-NTF-07).
- **RN-SLA-72** — Idempotência: a execução é registrada antes de tudo com `INSERT … ON CONFLICT DO NOTHING` em `notification_rule_executions (tenant_id, notification_rule_id, source_event_id)`; conflito significa "já processado" e encerra sem efeito; a `Notification` mantém a unicidade `(tenant_id, recipient_id, source_event_id, type)` (RN-NTF-03). Reentrega ou reprocessamento do evento nunca duplica execução nem notificação.
- **RN-SLA-73** — Execução assíncrona: a avaliação só acontece no worker (`NotificationRuleDispatcher`, fila `notifications`), a partir do outbox, **nunca** dentro da transação do comando de origem; a meta é criar a notificação em até 1 minuto do processamento do evento; falhas transitórias seguem o *retry* padrão da fila (5 tentativas, backoff exponencial).
- **RN-SLA-74** — Contenção por destinatário: `maxPerRecipientPerDay` (1..200, padrão 20) limita as `RULE_NOTIFICATION` daquela regra por pessoa por dia local do tenant; o excedente não é entregue e entra em `suppressedCount`. Os contadores ficam em Redis (chave por tenant, regra, pessoa e dia, com expiração); com o Redis indisponível o processamento **falha fechado** (a entrega é adiada para nova tentativa), nunca envia sem checar o limite.
- **RN-SLA-75** — Contenção por regra: `notificationRules.maxPerRulePerHour` (padrão 500, faixa 10..5.000 — entities.md §8) limita as execuções com `matched = true` de uma regra na última hora corrente; ao excedê-lo, a execução excedente é registrada (`matched = true`, `recipientsCount = 0`, `suppressedCount` = resolvidos), nenhuma notificação daquela execução é entregue e a regra vai a `AUTO_DISABLED` com `autoDisabledAt` e `autoDisabledReason` ("Excedeu {limite} disparos em 1 hora"); o `NotificationRuleDispatcher` publica `NotificationRuleAutoDisabled` (`windowCount`, `limit`), grava `notification_rule.auto_disable` (`SYSTEM`) e cria `NOTIFICATION_RULE_DISABLED` para os vínculos com `NOTIFICATION_RULE_MANAGE` (até 50). Regras `AUTO_DISABLED` não são consultadas (índice `(tenant_id, event_type) WHERE status = 'ACTIVE'`).
- **RN-SLA-76** — Estados: `ACTIVE` ↔ `INACTIVE` por ativar/desativar; `AUTO_DISABLED` pode ir a `ACTIVE` (reativar, limpa `autoDisabledAt`/`autoDisabledReason`) ou `INACTIVE`; a regra nunca volta sozinha a `ACTIVE`; eventos ocorridos enquanto ela esteve desligada **não** são reprocessados. Ativar/desativar é idempotente (sem novo evento nem auditoria se o estado já é o pedido).
- **RN-SLA-77** — Notificação e agrupamento: `RULE_NOTIFICATION` usa `priority` da regra, `title`/`body` renderizados, `link` `/processos/{id}`, `processId`, `entityType = NOTIFICATION_RULE` e `entityId` = id da regra (sem coluna nova), `groupKey = rule:{ruleId}:{processId}` (agrupamento de 5 min, RN-NTF-04). Uma pessoa recebe no máximo **uma** `RULE_NOTIFICATION` por evento de origem (unicidade da `Notification`); com várias regras casando, vale a de `createdAt` mais antiga e as demais contam o excedente em `suppressedCount`.
- **RN-SLA-78** — Gestão: `name` único por tenant sem distinguir maiúsculas (`NOTIFICATION_RULE_NAME_ALREADY_EXISTS`); alterar (NTR-04, `If-Match`), ativar ou desativar só afeta eventos **futuros** (POL-27) e emite `NotificationRuleChanged` (`CREATED`, `UPDATED`, `ACTIVATED`, `DEACTIVATED`) e a auditoria `notification_rule.create|update|activate|deactivate` (`CONFIGURATION`) na mesma transação; `Idempotency-Key` obrigatório em NTR-02.
- **RN-SLA-79** — Histórico e pré-visualização: NTR-07 lista as execuções dos últimos 90 dias (retenção do job `maintenance`), com `processCode` apenas para quem tem visibilidade do processo; NTR-08 renderiza título e corpo, avalia a condição e conta destinatários **por categoria, sem nomes**, para um processo real (exige `PROCESS_VIEW`, POL-27; valores sigilosos sempre mascarados) ou dados de exemplo, aceitando `overrides` do formulário não salvo; não grava nem notifica nada.
- **RN-SLA-80** — Segurança e isolamento: `NOTIFICATION_RULE_MANAGE` em NTR-01..NTR-09 (e `RULE_VIEW` para `LIBRARY`); todas as tabelas com `tenant_id` e RLS; o worker define `app.tenant_id` a partir do envelope do evento; regra, execução ou processo de outro tenant → 404, sem revelar existência; o payload dos eventos de origem nunca é copiado para a execução, para os logs ou para a auditoria.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto (3–150) | Sim | único sem distinguir maiúsculas (RN-SLA-78) | — |
| Evento | `eventType` | texto (≤ 80) | Sim | catálogo de NTR-09 (RN-SLA-67) | — |
| Condição | `condition` | `RuleRef` \| nulo | Não | RN-SLA-68 | nulo (sempre) |
| Responsável pela etapa | `recipients.assignee` | booleano | Condicional | RN-SLA-69 | `false` |
| Membros da unidade atual | `recipients.currentDepartmentMembers` | booleano | Condicional | RN-SLA-69 | `false` |
| Titular da unidade | `recipients.departmentHead` | booleano | Condicional | RN-SLA-69 | `false` |
| Titular da secretaria solicitante | `recipients.requestingSecretariatHead` | booleano | Condicional | RN-SLA-69 | `false` |
| Criador do processo | `recipients.processCreator` | booleano | Condicional | RN-SLA-69 | `false` |
| Participantes | `recipients.participants` | booleano | Condicional | RN-SLA-69 | `false` |
| Perfis | `recipients.roleKeys` | lista de chaves (≤ 50) | Condicional | perfis ativos do tenant | `[]` |
| Usuários | `recipients.userIds` | lista de uuid (≤ 50) | Condicional | vínculos ativos | `[]` |
| Título da notificação | `titleTemplate` | texto (1–200) | Sim | variáveis da *allowlist* (RN-SLA-71) | — |
| Corpo da notificação | `bodyTemplate` | texto (1–1.000) | Sim | idem | — |
| Prioridade | `priority` | `NotificationPriority` | Não | `NORMAL`, `HIGH` | `NORMAL` |
| Enviar também por e-mail | `sendEmail` | booleano | Não | respeita preferências e `notifications.emailEnabled` | `false` |
| Máximo por pessoa por dia | `maxPerRecipientPerDay` | inteiro 1–200 | Não | RN-SLA-74 | `20` |
| Situação | `status` | `NotificationRuleStatus` | Não | `ACTIVE` na criação (o formulário oferece "Salvar como inativa"); `AUTO_DISABLED` só pelo sistema | `ACTIVE` |
| *(saída)* Desligada em / motivo | `autoDisabledAt`, `autoDisabledReason` | datetime / texto | — | RN-SLA-75 | sistema |
| *(saída)* Execução | `matched`, `recipientsCount`, `suppressedCount` | booleano / inteiros | — | RN-SLA-72/74/75 | worker |
| Processo de exemplo (pré-visualização) | `processId` (NTR-08) | uuid | Não | `PROCESS_VIEW` | dados de exemplo |
| Alterações não salvas (pré-visualização) | `overrides` (NTR-08) | objeto | Não | mesmos campos de NTR-04 | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `name` ausente ou fora de 3–150 | Front + API (Zod) | "Informe o nome da regra (3 a 150 caracteres)." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_SHORT`/`TOO_LONG`) |
| V-02 | `name` já usado no tenant (sem distinguir maiúsculas) | API | "Já existe uma regra com este nome. Escolha outro." | `NOTIFICATION_RULE_NAME_ALREADY_EXISTS` |
| V-03 | `eventType` ausente ou fora do catálogo de NTR-09 | Front + API | "Escolha um dos eventos da lista." | `VALIDATION_ERROR` (`EVENT_NOT_NOTIFIABLE`) |
| V-04 | `condition` com caminho fora do `RuleContext` v2 ou operador fora da *allowlist* | Front + API | "A condição usa um dado ou operador não permitido ({detalhe})." | `VALIDATION_ERROR` (`RULE_PATH_UNKNOWN`/`RULE_OPERATOR_FORBIDDEN`) |
| V-05 | Regra da biblioteca inexistente, não `PUBLISHED`, aposentada ou de `kind` diferente de `NOTIFICATION` | API | "Escolha uma regra publicada do tipo Notificação." | `RULE_REF_INVALID` |
| V-06 | Nenhum destinatário selecionado | Front + API | "Escolha quem vai receber a notificação." | `VALIDATION_ERROR` (`RECIPIENTS_EMPTY`) |
| V-07 | `roleKeys` ou `userIds` inexistentes, inativos ou de outro tenant; mais de 50 itens | API | "Selecione perfis e pessoas válidos (até 50)." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`TOO_LONG`) |
| V-08 | `titleTemplate`/`bodyTemplate` ausentes ou acima de 200/1.000 caracteres | Front + API | "O título aceita até 200 caracteres e o corpo até 1.000." | `VALIDATION_ERROR` (`REQUIRED`/`TOO_LONG`) |
| V-09 | Variável fora da *allowlist* (ex.: `{{process.estimatedValue}}`) | Front + API | "A variável {{...}} não pode ser usada em mensagens." | `VALIDATION_ERROR` (`UNKNOWN_VARIABLE`) |
| V-10 | Chaves `{{ }}` desbalanceadas ou sintaxe inválida | Front + API | "Confira as chaves {{ }} do modelo." | `VALIDATION_ERROR` (`TEMPLATE_SYNTAX_INVALID`) |
| V-11 | `maxPerRecipientPerDay` fora de 1–200 | Front + API | "O limite diário deve estar entre 1 e 200." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-12 | `priority` fora do enum | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-13 | `If-Match` ausente ou divergente em NTR-04/05/06 | API | "A regra foi alterada por outra pessoa. Recarregue e tente de novo." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-14 | Alterar `status` direto para `AUTO_DISABLED` | API | — | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-15 | NTR-08 com processo inexistente, de outro tenant ou sem `PROCESS_VIEW` | API | "Processo não encontrado." / "Você não tem acesso a este processo." | `PROCESS_NOT_FOUND` / `PERMISSION_DENIED` |
| V-16 | Filtros inválidos em NTR-01/NTR-07 (enum, `from` > `to`) | API (Zod) | "Revise os filtros selecionados." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** `NOTIFICATION_RULE_MANAGE` para NTR-01 a NTR-09 (cadastro, consulta, histórico e pré-visualização); `RULE_VIEW` adicional para referenciar regra da biblioteca na condição; `PROCESS_VIEW` sobre o processo para a pré-visualização com processo real (NTR-08 com `processId`) e para exibir `processCode` no histórico (NTR-07). A execução no worker é do sistema (`SYSTEM`).
- **Políticas:** POL-27 (só efeitos futuros; simulador com processo real exige `PROCESS_VIEW` e mascara valores sigilosos), DEC-024 e RN-NTF-06 (visibilidade do destinatário), POL-09 (sigilo), US-113 (preferências); perfis padrão `ADMIN_ORGAO` e `GESTOR_CONTRATACOES` (permissions.md §5).
- **MFA:** não exigido (`NOTIFICATION_RULE_MANAGE` é de risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o item "Administração › Regras de notificação" não é exibido; a API responde 403 `PERMISSION_DENIED` e registra `access.denied` (`reasonCode = NOTIFICATION_RULE_MANAGE`, ou `RULE_VIEW`); regra, execução ou processo de outro tenant → 404.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `NotificationRuleChanged` | `notification_rule.changed` | Commit de NTR-02 (`CREATED`), NTR-04 (`UPDATED`), NTR-05 (`ACTIVATED`) e NTR-06 (`DEACTIVATED`) | `notificationRuleId`, `eventType`, `change`; consumidor C (cache de configuração); sem texto de modelo nem expressão no payload |
| `NotificationRuleAutoDisabled` | `notification_rule.auto_disabled` | `NotificationRuleDispatcher` ao exceder o teto por hora (RN-SLA-75) | `notificationRuleId`, `eventType`, `windowCount`, `limit`; consumidor N (notificação `NOTIFICATION_RULE_DISABLED`) |
| *Eventos NR de origem* | `process.stage_skipped`, `process.stage_escalated`, `legal_review.concluded` etc. | Consumidos (não produzidos) pelo `NotificationRuleDispatcher` | Sem alteração de contrato (events.md §4) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `RULE_NOTIFICATION` | Conforme `NotificationRecipientSpec` da regra, com visibilidade do processo | in-app + e-mail conforme `sendEmail`, `notifications.emailEnabled` e preferência do usuário; não obrigatória | Evento NR cuja regra `ACTIVE` casa a condição |
| `NOTIFICATION_RULE_DISABLED` | Vínculos com `NOTIFICATION_RULE_MANAGE` (até 50) | in-app + e-mail (padrão sim; não obrigatória) | `NotificationRuleAutoDisabled` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Regras de notificação condicional

  Background:
    Given que o tenant "Prefeitura A" está ativo e "notificationRules.maxPerRulePerHour" é 10
    And "Marina Costa" tem vínculo ativo com o perfil "ADMIN_ORGAO" e a permissão "NOTIFICATION_RULE_MANAGE"
    And "Fernanda Lima" é gestora de contratações com visibilidade dos processos
    And existe o processo urgente "0040/2026" com a etapa "CONTROLE_INTERNO" configurada para ser dispensada por regra

  Scenario: [Sucesso] Criar e ativar a regra "Dispensa em urgente"
    When "Marina Costa" criar a regra "Dispensa em urgente" para o evento "ProcessStageSkipped" com condição "process.priority = URGENT"
    And destinatários "roleKeys" igual a ["GESTOR_CONTRATACOES"], título "Etapa dispensada em processo urgente" e corpo "A etapa {{stage.name}} do processo {{process.code}} foi dispensada. Veja: {{link}}"
    Then a API deve responder 201 com "ETag", "Location" e "status" "ACTIVE"
    And deve gerar registro de auditoria "notification_rule.create"
    And deve gerar o evento "NotificationRuleChanged" com "change" "CREATED"

  Scenario: [Sucesso] Editar, desativar e reativar a regra
    Given que a regra "Dispensa em urgente" está "ACTIVE"
    When "Marina Costa" alterar o título da regra com o "If-Match" atual
    Then a API deve responder 200 com "ETag" nova
    And deve gerar registro de auditoria "notification_rule.update" e o evento "NotificationRuleChanged" com "change" "UPDATED"
    When "Marina Costa" desativar a regra
    Then deve gerar registro de auditoria "notification_rule.deactivate" e o evento "NotificationRuleChanged" com "change" "DEACTIVATED"
    And um evento "ProcessStageSkipped" posterior não deve gerar execução para essa regra
    When "Marina Costa" ativar a regra novamente
    Then deve gerar registro de auditoria "notification_rule.activate" e o evento "NotificationRuleChanged" com "change" "ACTIVATED"

  Scenario: [Sucesso] Evento casa a condição e o gestor é notificado uma vez
    Given que a regra "Dispensa em urgente" está "ACTIVE"
    When a etapa "CONTROLE_INTERNO" do processo "0040/2026" for dispensada e o evento "ProcessStageSkipped" for processado pelo worker
    Then "Fernanda Lima" deve receber a notificação "RULE_NOTIFICATION" com o texto "A etapa Controle Interno do processo 0040/2026 foi dispensada. Veja: /processos/{id}"
    And deve existir uma "NotificationRuleExecution" com "matched" verdadeiro e "recipientsCount" 1
    And o reprocessamento do mesmo evento não deve duplicar a notificação
    And nenhuma auditoria deve ser gerada pela execução, pois o registro fica em "notification_rule_executions"

  Scenario: [Sucesso] Condição falsa não notifica
    Given que o processo "0041/2026" tem prioridade "NORMAL"
    When a etapa do processo "0041/2026" for dispensada e o evento for processado
    Then nenhuma notificação "RULE_NOTIFICATION" deve ser criada
    And a "NotificationRuleExecution" deve ter "matched" falso e "recipientsCount" 0
    And nenhuma auditoria nem novo evento de domínio deve ser gerado

  Scenario: [Sucesso] Pré-visualizar a mensagem sem enviar nada
    Given que "Marina Costa" tem "PROCESS_VIEW" sobre o processo "0040/2026"
    When "Marina Costa" chamar "POST /notification-rules/{id}/preview" com "processId" do processo "0040/2026"
    Then a API deve responder 200 com o texto renderizado, "conditionResult" verdadeiro e a contagem de destinatários por categoria
    And a resposta não deve conter nomes de pessoas nem valores do processo
    And nenhuma notificação, execução ou auditoria deve ser gerada

  Scenario: [Sucesso] Limite por destinatário por dia suprime o excedente
    Given que a regra tem "maxPerRecipientPerDay" 2 e "Fernanda Lima" já recebeu 2 notificações dela hoje
    When um terceiro evento casar a condição
    Then "Fernanda Lima" não deve receber a terceira notificação
    And a execução deve ter "suppressedCount" 1 e "recipientsCount" 0

  Scenario: [Sucesso] Regra que excede o teto por hora é desligada com alerta
    Given que a regra "Toda movimentação" não tem condição e já teve 10 execuções com "matched" verdadeiro na última hora
    When o décimo primeiro evento for processado
    Then a regra deve ficar "AUTO_DISABLED" com "autoDisabledReason" "Excedeu 10 disparos em 1 hora"
    And nenhuma notificação "RULE_NOTIFICATION" deve ser entregue para essa execução
    And deve gerar registro de auditoria "notification_rule.auto_disable" com ator "SYSTEM"
    And deve gerar o evento "NotificationRuleAutoDisabled" com "windowCount" 11 e "limit" 10
    And "Marina Costa" deve receber a notificação "NOTIFICATION_RULE_DISABLED"

  Scenario: [Validação] Regras inválidas são recusadas
    When "Marina Costa" criar uma regra para o evento "ProcessCreated"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "EVENT_NOT_NOTIFIABLE" no campo "eventType"
    When "Marina Costa" usar "{{process.estimatedValue}}" no corpo
    Then a API deve responder 422 com erro "UNKNOWN_VARIABLE" no campo "bodyTemplate"
    When "Marina Costa" enviar destinatários sem nenhum seletor
    Then a API deve responder 422 com erro "RECIPIENTS_EMPTY" no campo "recipients"
    When "Marina Costa" enviar "maxPerRecipientPerDay" 500
    Then a API deve responder 422 com erro "OUT_OF_RANGE" no campo "maxPerRecipientPerDay"
    And nenhuma regra, auditoria ou evento deve ser gravado

  Scenario: [Permissão] Sem permissão e sem visibilidade
    Given que "Bruno Lopes" não possui "NOTIFICATION_RULE_MANAGE"
    When "Bruno Lopes" chamar "GET /notification-rules"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com "reasonCode" "NOTIFICATION_RULE_MANAGE"
    Given que "Gilberto Rocha" tem "NOTIFICATION_RULE_MANAGE" mas não tem "RULE_VIEW"
    When "Gilberto Rocha" enviar condição "LIBRARY" com uma regra publicada do tipo "NOTIFICATION"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    Given que "Fernanda Lima" perdeu a visibilidade do processo "0040/2026"
    When o evento for processado
    Then "Fernanda Lima" não deve receber a notificação

  Scenario: [Tenant incorreto] Regra e evento de outro tenant
    Given que existe a regra "Dispensa em urgente" no tenant "Prefeitura B"
    When "Marina Costa", no tenant "Prefeitura A", chamar "GET /notification-rules/{id-da-Prefeitura-B}"
    Then a API deve responder 404 com código "NOTIFICATION_RULE_NOT_FOUND"
    When um evento "ProcessStageSkipped" da "Prefeitura B" for processado
    Then nenhuma regra da "Prefeitura A" deve ser avaliada e nenhum usuário da "Prefeitura A" deve ser notificado
    When "Marina Costa" enviar "roleKeys" de um perfil da "Prefeitura B"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" no campo "recipients.roleKeys"

  Scenario: [Duplicidade] Nome repetido, reenvio e duas regras para o mesmo evento
    When "Marina Costa" criar outra regra com o nome "dispensa em URGENTE"
    Then a API deve responder 409 com código "NOTIFICATION_RULE_NAME_ALREADY_EXISTS"
    Given que "Marina Costa" criou a regra "Parecer concluído" com a chave de idempotência "K1" e recebeu 201
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 201 com o mesmo corpo e o cabeçalho "Idempotent-Replayed: true"
    Given que duas regras ativas casam com o mesmo evento para "Fernanda Lima"
    When o evento for processado
    Then "Fernanda Lima" deve receber uma única "RULE_NOTIFICATION", da regra mais antiga
    And a regra mais nova deve registrar "suppressedCount" 1

  Scenario: [Concorrência] Edição simultânea e edição durante o processamento
    Given que "Marina Costa" e "Gilberto Rocha" abriram a regra com o mesmo "ETag"
    When "Marina Costa" salvar e, em seguida, "Gilberto Rocha" salvar com o "ETag" antigo
    Then a segunda chamada deve responder 412 com código "VERSION_CONFLICT"
    Given que o worker está processando o evento "ProcessStageSkipped" com o título antigo da regra
    When "Marina Costa" alterar o título no mesmo instante
    Then a notificação desse evento deve usar o título lido no início do processamento
    And o evento seguinte deve usar o título novo

  Scenario: [Falha de banco] Banco indisponível no cadastro e no worker
    Given que o banco de dados fica indisponível durante a transação de "POST /notification-rules"
    When "Marina Costa" salvar a regra
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And nenhuma regra, auditoria ou evento deve ter sido gravado
    Given que o banco fica indisponível durante o processamento do evento "ProcessStageSkipped"
    When o worker tentar criar as notificações
    Then a transação deve ser desfeita sem "NotificationRuleExecution" gravada
    And o evento deve ser reprocessado na nova tentativa e a notificação deve ser criada uma única vez

  Scenario: [Falha de integração] Redis e e-mail indisponíveis
    Given que o Redis dos contadores diários está indisponível
    When o worker processar o evento "ProcessStageSkipped"
    Then nenhuma notificação deve ser entregue sem checar o limite diário
    And o evento deve ser repetido com "backoff" até o Redis voltar, com log "warn" "notification_rule.counter_unavailable"
    Given que o provedor de e-mail (SMTP/SES) está indisponível e a regra tem "sendEmail" verdadeiro
    When a notificação for criada
    Then a notificação in-app deve existir e o e-mail deve ficar "PENDING" para novas tentativas da fila "email"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido (campo, intervalo, lista, variável, sintaxe) | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca cada campo e abre o bloco com erro |
| Nome já existente | 409 | `NOTIFICATION_RULE_NAME_ALREADY_EXISTS` | "Já existe uma regra com este nome. Escolha outro." | Foco no campo "Nome" |
| Regra da biblioteca inválida ou aposentada | 422 | `RULE_REF_INVALID` | "Escolha uma regra publicada do tipo Notificação." | Abre o seletor de regras |
| Regra inexistente ou de outro tenant | 404 | `NOTIFICATION_RULE_NOT_FOUND` | "Regra não encontrada." | Volta à lista |
| Processo inexistente, de outro tenant ou não visível (NTR-08) | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Limpa o processo de exemplo |
| Sem `NOTIFICATION_RULE_MANAGE`, `RULE_VIEW` ou `PROCESS_VIEW` | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta o menu ou a opção |
| MFA exigido (`security.mfaPolicy = ALL`) | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Conduz ao passo de MFA e preserva o formulário |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A regra foi alterada por outra pessoa. Recarregue e tente de novo." | Oferece "Recarregar" e mantém o rascunho local |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Atualize a página e tente novamente." | Recarrega |
| Mesma chave de idempotência com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar a regra agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

A execução da regra é assíncrona e não tem resposta HTTP; falhas transitórias do worker seguem o *retry* da fila `notifications` e, esgotadas, vão à fila de falhas com alerta operacional. Os códigos de campo (`EVENT_NOT_NOTIFIABLE`, `RECIPIENTS_EMPTY`, `UNKNOWN_VARIABLE`, `TEMPLATE_SYNTAX_INVALID`) são novos em `errors[].code` de `VALIDATION_ERROR` e serão registrados no `api.md` do MVP 2.

## Dependências
- **Stories:** US-083 (infraestrutura de filas, worker e outbox), US-111 (central de notificações e `NotificationDispatcher` — unicidade, agrupamento, visibilidade), US-112 (e-mails transacionais), US-129 (`RuleContext` v2). Indiretas: US-113 (preferências do usuário), US-192 (`ProcessStageEscalated` como evento de origem), US-190 (namespace `sla.*`), US-194 (regras da biblioteca de `kind = NOTIFICATION`, incluindo `NOTIFICAR_GESTOR_PRAZO_VENCIDO`), US-124 (`ProcessBranchesOpened`/`Joined`) e as stories dos módulos produtores dos demais eventos NR (dotação, jurídico, Controle Interno), US-103 (configurações do órgão), US-060 (timeline).
- **Decisões/ADRs:** DEC-205, DEC-204, DEC-024, DEC-086, DEC-161; ADR-015, ADR-008; POL-27, POL-09.
- **Configurações:** `notificationRules.maxPerRulePerHour` (padrão 500, 10..5.000), `notifications.emailEnabled`, `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **Evento de origem do modelo `NOTIFICAR_GESTOR_PRAZO_VENCIDO`:** a regra de modelo semeada (entities.md §9) sugere notificar o gestor quando o prazo vence, mas `ProcessStageOverdue` e `ProcessStageDueSoon` **não** estão marcados NR em `events.md §4` (hoje só `ProcessStageEscalated` serve). Marcar `ProcessStageOverdue` como NR ou documentar que o modelo usa `ProcessStageEscalated`.
  2. **Unicidade de `Notification` e várias regras:** `Notification (tenant, recipient, sourceEventId, type)` não inclui a regra; duas regras do mesmo evento para a mesma pessoa colidem. RN-SLA-77 define "vale a regra mais antiga"; confirmar ou incluir a regra na chave (`groupKey`/`entityId`).
  3. **Contagem "por hora" do teto:** `entities.md §8` diz que a regra vai a `AUTO_DISABLED` "acima disso"; RN-SLA-75 interpreta como execuções com `matched = true` na última hora (não como notificações criadas). Confirmar.
  4. **Contador diário por destinatário:** não há tabela; a story usa contadores em Redis com falha fechada (RN-SLA-74). Alternativa: contar `Notification` por `(entityType = NOTIFICATION_RULE, entityId, recipientId, dia)` com índice novo em `notifications` — `entities.md §4.10` não prevê o índice.
  5. **Catálogo de rótulos pt-BR** dos eventos notificáveis (`{{event.label}}` e NTR-09): vive no registro de eventos em `packages/types` e não está em `events.md`; a criar.
  6. **Contratos novos:** NTR-01..NTR-09, `overrides` da pré-visualização e códigos de erro (`EVENT_NOT_NOTIFIABLE`, `RECIPIENTS_EMPTY`, `UNKNOWN_VARIABLE`, `TEMPLATE_SYNTAX_INVALID`, `NOTIFICATION_RULE_*`) a consolidar no `api.md` do MVP 2; códigos de `RuleRef` a unificar com EP-031.
  7. **Valores de `NotificationPriority`** (`NORMAL`, `HIGH`) e **status inicial** (`ACTIVE` por padrão em `entities.md §4.10`; o formulário oferece "Salvar como inativa").
  8. **`{{link}}`** é a rota relativa do processo; não há variável para o link do documento (por desenho: só a rota do processo).

## Impacto técnico
- **Novo consumidor no worker:** `NotificationRuleDispatcher` assina todos os eventos NR; o custo cresce com o número de regras ativas por `eventType` (índice `(tenant_id, event_type) WHERE status = 'ACTIVE'`) e com a montagem do `RuleContext` v2, que é **preguiçosa e com cache por evento** para que várias regras do mesmo evento paguem uma vez. A ADR-015 prevê fila própria se o volume justificar.
- **Segurança do texto:** a *allowlist* de variáveis e o truncamento ocorrem no servidor; o modelo nunca interpola campo do payload fora das variáveis; texto simples (sem HTML), para evitar injeção em e-mail e em UI.
- **Idempotência e ordem:** registrar a execução antes dos efeitos e gravar notificações e atualização da execução na mesma transação garante "no máximo uma vez" mesmo com reentrega e com duas instâncias do worker.
- **Contenção:** dois níveis (por pessoa/dia e por regra/hora) e falha fechada quando o Redis cai; o desligamento automático cria uma notificação para o administrador e **não** reenvia eventos perdidos (decisão consciente: evitar rajada ao reativar).
- **Retenção:** `notification_rule_executions` por 90 dias (job `maintenance`); sem conteúdo de mensagem nem payload; só contagens.
- **Compatibilidade:** nenhum evento ou notificação do MVP 1 muda; `RULE_NOTIFICATION` e `NOTIFICATION_RULE_DISABLED` são tipos novos do registro; preferências do usuário passam a listar o tipo novo (US-113, aditivo).

## Backend
- **Módulo(s):** `notification` (dono: `NotificationRule`, `NotificationRuleExecution`, `NotificationRuleDispatcher`, NTR-01..NTR-09), `process` (montagem do `RuleContext` v2 por fachada), `rules` (leitura da regra da biblioteca), `access` (visibilidade e detentores de perfil), `audit`, `platform` (fila, Redis, outbox).
- **Casos de uso:** `ListNotificationRulesQuery`, `GetNotificationRuleQuery`, `ListNotifiableEventsQuery`, `ListNotificationRuleExecutionsQuery`, `PreviewNotificationRuleQuery`; `CreateNotificationRuleCommand`, `UpdateNotificationRuleCommand`, `ActivateNotificationRuleCommand`, `DeactivateNotificationRuleCommand`; `NotificationRuleDispatcher.onEvent` e `AutoDisableNotificationRuleCommand` (sistema).
- **Domínio:** `NotificationRule` (agregado, estados e invariantes), `NotificationRecipientSpec`, `MessageTemplate` (parser da *allowlist*, renderizador com truncamento), `RecipientResolver` (união, dedupe, visibilidade, preferências, limite de 50), `RuleRateLimiter` (contadores diários e janela horária).
- **Integrações internas:** `RuleExpressionValidator` e `RuleEvaluator` com `RuleContextV2Builder` (ADR-008), `RuleLibraryFacade`, `AccessFacade.canView(processId, userId)`, `DepartmentFacade`, `NotificationPreferenceReader` (US-113), `EmailSender` (US-112), `AuditService`, `OutboxWriter`.
- **Transação:** cadastro — validação → gravação da regra → auditoria → outbox; execução no worker — inserção idempotente da execução → avaliação → resolução e limites → criação das `Notification` e atualização da execução (mesma transação) → eventual `AUTO_DISABLED` (regra + auditoria + outbox na mesma transação).

## Frontend
- **Tela(s):** SCR-122 (`/admin/notificacoes/regras`), modelo `ListPage` (lista) e editor em `DetailPage`/painel lateral; central de notificações (SCR-036) exibe os tipos novos.
- **Componentes:** `NotificationRuleTable` (situação, motivo do desligamento, última execução), `NotificationRuleEditor` com `EventSelect` (NTR-09), `RuleRefField` (INLINE/LIBRARY), `RecipientsBuilder`, `MessageTemplateEditor` (chips de variáveis permitidas, contador de caracteres e prévia ao vivo), `LimitsAndChannelsForm`, `ExecutionsDrawer` (NTR-07), `PreviewDialog` (NTR-08), `AutoDisabledBanner`.
- **Estados:** *skeleton*; vazio (FA-01); erro com `correlationId` e "Tentar novamente"; erros por campo com foco no primeiro bloco inválido; conflito de versão com "Recarregar"; regra desligada automaticamente com banner e botão "Revisar e reativar"; sucesso com toast.
- **Acessibilidade e responsividade:** rótulos associados e erros por campo anunciados em `aria-live`; chips de variáveis operáveis por teclado; situação por texto e ícone; prévia com `aria-live="polite"`; lista em cartões e editor em coluna única abaixo de 768 px (uso administrativo, desktop-first); contraste AA.

## Banco de dados
- **Tabelas:** `notification_rules` e `notification_rule_executions` (entities.md §4.10); leitura de `notifications`, `notification_preferences`, `process_participants`, `departments`; escrita de `notifications` (tipo `RULE_NOTIFICATION`, `entity_type = 'NOTIFICATION_RULE'`, `entity_id` = id da regra); `audit_logs`, `outbox_events`.
- **Migrações:** **M2-18** (`notification_rules`, `notification_rule_executions` — reversível), depois de **M2-09** (referências `RuleRef`); chave `notificationRules.maxPerRulePerHour` e a regra de modelo semeadas em M2-21; `NotificationType` ampliado no registro (sem migração de coluna: `varchar(60)`). RLS `ENABLE`/`FORCE`, *grants* (`cf_app` lê/escreve regras; `cf_worker` escreve execuções) e entrada nas suítes de tenant leak e de autorização.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, lower(name))`; `(tenant_id, event_type) WHERE status = 'ACTIVE'`; `UNIQUE (tenant_id, notification_rule_id, source_event_id)`; `(tenant_id, notification_rule_id, created_at DESC)`; unicidade de `Notification (tenant_id, recipient_id, source_event_id, type)`; FK composta `(tenant_id, notification_rule_id)`; retenção de 90 dias das execuções pelo job `maintenance`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `NTR-01` | GET | `/api/v1/notification-rules` | `?status=&eventType=&q=&page=&pageSize=&sort=` | `200 { data: [{ id, name, eventType, eventLabel, condition { mode, label } \| null, recipientsSummary, priority, sendEmail, maxPerRecipientPerDay, status, autoDisabledAt, autoDisabledReason, lastExecutionAt, version }], meta }` | 200, 401, 403, 422, 429, 503 |
| `NTR-02` | POST | `/api/v1/notification-rules` | `{ name, eventType, condition?, recipients, titleTemplate, bodyTemplate, priority?, sendEmail?, maxPerRecipientPerDay?, status? }` + `Idempotency-Key` | `201 { data: NotificationRule }` + `Location`, `ETag` | 201, 401, 403, 409, 422, 429, 503 |
| `NTR-03` | GET | `/api/v1/notification-rules/{id}` | path `id` | `200 { data: NotificationRule }` + `ETag` | 200, 401, 403, 404, 429, 503 |
| `NTR-04` | PATCH | `/api/v1/notification-rules/{id}` | campos parciais + `If-Match` | `200 { data: NotificationRule }` + `ETag` nova | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `NTR-05` | POST | `/api/v1/notification-rules/{id}/activate` | `If-Match` | `200 { data: NotificationRule }` (de `INACTIVE` ou `AUTO_DISABLED`) | 200, 401, 403, 404, 412, 422, 428, 503 |
| `NTR-06` | POST | `/api/v1/notification-rules/{id}/deactivate` | `If-Match` | `200 { data: NotificationRule }` | 200, 401, 403, 404, 412, 428, 503 |
| `NTR-07` | GET | `/api/v1/notification-rules/{id}/executions` | `?matched=&from=&to=&page=&pageSize=` | `200 { data: [{ id, sourceEventId, processId, processCode \| null, matched, recipientsCount, suppressedCount, createdAt }], meta }` (últimos 90 dias) | 200, 401, 403, 404, 422, 429, 503 |
| `NTR-08` | POST | `/api/v1/notification-rules/{id}/preview` | `{ processId?, overrides? }` (leitura; sem `Idempotency-Key`) | `200 { data: { title, body, truncated, sample, conditionResult, recipients: { count, categories[] } } }` | 200, 401, 403, 404, 422, 429, 503 |
| `NTR-09` | GET | `/api/v1/notification-rules/event-types` | — | `200 { data: [{ eventType, routingKey, label, group, variables[] }] }` | 200, 401, 403, 429, 503 |

`NotificationRule` = `{ id, name, eventType, condition, recipients, titleTemplate, bodyTemplate, priority, sendEmail, maxPerRecipientPerDay, status, autoDisabledAt, autoDisabledReason, version, createdAt, updatedAt }`. Todas as rotas exigem `NOTIFICATION_RULE_MANAGE`.

## Logs
- `info` `notification_rule.created` / `updated` / `activated` / `deactivated` — `notificationRuleId`, `eventType`, `durationMs`, `correlationId`.
- `info` `notification_rule.executed` — `notificationRuleId`, `eventType`, `matched`, `recipientsCount`, `suppressedCount`, `durationMs` (sem nomes nem texto).
- `warn` `notification_rule.condition_failed` — `notificationRuleId`, `errorCode` (sem expressão nem valores); `warn` `notification_rule.recipients_truncated`; `warn` `notification_rule.counter_unavailable`; `warn` `idempotency.store_unavailable`; `warn` `notification_rule.auto_disabled` — `windowCount`, `limit`.
- `error` `notification_rule.dispatch_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** título e corpo renderizados, nomes ou e-mails de destinatários, expressões de regra, payload do evento, valores do processo.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `notification_rule.create` | `CONFIGURATION` | Commit de NTR-02 | `changes`: campos escalares e contagens; condição e modelos como hash e tamanho; `metadata`: `notificationRuleId`, `eventType`, `status` |
| `notification_rule.update` | `CONFIGURATION` | Commit de NTR-04 | `changes`: `{ path, old, new }` por campo alterado (texto dos modelos como hash e tamanho); `metadata`: `fromVersion`, `toVersion` |
| `notification_rule.activate` / `notification_rule.deactivate` | `CONFIGURATION` | Commit de NTR-05/NTR-06 (só quando muda) | `changes`: `status` (de → para) |
| `notification_rule.auto_disable` | `SYSTEM` | Dispatcher ao exceder o teto por hora | `changes`: `status` `ACTIVE` → `AUTO_DISABLED`; `metadata`: `windowCount`, `limit`; `actorType = SYSTEM` |
| `access.denied` | `ACCESS` | 403 em NTR-01..NTR-09 | `reasonCode = NOTIFICATION_RULE_MANAGE` (ou `RULE_VIEW`/`PROCESS_VIEW`) |

## Testes necessários
- **Unitários:** `MessageTemplate` (*allowlist*, sintaxe, truncamento, variáveis vazias, `{{dueAt}}` no fuso do tenant); `RecipientResolver` (cada seletor, união, dedupe, visibilidade, preferências, limite de 50 e *fallback*); `RuleRateLimiter` (diário e horário, falha fechada); máquina de estados da regra; `NotificationRule` (invariantes de nome e destinatários).
- **Integração (Testcontainers PostgreSQL + Redis):** ciclo completo evento → execução → notificação (uma vez); reprocessamento e duas instâncias do worker; condição falsa e com erro; várias regras para a mesma pessoa; limite diário e `AUTO_DISABLED` com notificação ao administrador; edição durante o processamento; e-mail com SMTP indisponível; retenção de 90 dias; migração M2-18.
- **API/contrato:** NTR-01..NTR-09 conforme `api.md` do MVP 2; `ETag`/`If-Match`; `Idempotency-Key` em NTR-02; códigos de campo novos; preview sem nomes nem valores.
- **RBAC e multi-tenant:** `NOTIFICATION_RULE_MANAGE` por rota, `RULE_VIEW` para `LIBRARY`, `PROCESS_VIEW` no preview com processo real; regra, execução e processo de outro tenant → 404 e nunca avaliados (suíte "tenant leak": `notification_rules`, `notification_rule_executions`, notificações `RULE_NOTIFICATION`); destinatário sem visibilidade não recebe.
- **Concorrência:** duas edições com o mesmo `ETag` (uma 200, outra 412); mesma regra, mesmo evento em duas instâncias (uma execução); ativar/desativar durante o processamento.
- **E2E (Playwright):** criar a regra "Dispensa em urgente", ativar, disparar o evento e ver a notificação do gestor no sininho; estourar o limite (teto configurado em 10) e ver a regra desligada, o banner e a notificação ao administrador; pré-visualizar.
- **Acessibilidade/performance:** axe nos quatro blocos do editor, no diálogo de pré-visualização e na gaveta de execuções; processamento de 1.000 eventos NR por minuto com 20 regras ativas dentro da meta de 1 minuto (suíte de performance).

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
- [ ] Teste de idempotência por `eventId` + regra e de reprocessamento sem duplicar notificação
- [ ] Teste de contenção (diária e horária) e de `AUTO_DISABLED` com alerta ao administrador
- [ ] Teste prova que nenhum modelo, log ou auditoria carrega valor de orçamento, conteúdo de documento ou payload do evento
- [ ] Migração M2-18 revisada (reversível) e semente `maxPerRulePerHour` verificada

## Estimativa
**M** — duas tabelas e nove endpoints, mas com a parte difícil concentrada no consumidor do worker: idempotência, resolução de destinatários com visibilidade e preferências, contenção em dois níveis com falha fechada, desligamento automático e editor com prévia segura.

## Prioridade
**P1** — entrega a configuração que o administrador pediu (quem é avisado de quê) com proteção contra tempestade de avisos; depende de `RuleContext` v2 e da central de notificações, e não bloqueia as etapas P0 do DT-02/DT-03.
