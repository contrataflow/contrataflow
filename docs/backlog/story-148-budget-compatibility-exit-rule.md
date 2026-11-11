---
id: US-148
title: "Compatibilidade da dotação com o valor estimado e regra de saída da etapa"
epic: EP-024
feature: FT-072
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-032, US-129, US-147]
modules: [budget, process, workflow, timeline, audit, platform]
screens: [SCR-006, SCR-013, SCR-041]
endpoints: [BUD-20, BUD-01, TSK-01, PRC-08, PRC-09, PRC-19, PRC-20, SET-01, SET-02, WF-19, WF-23, WF-60]
permissions: [PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET, PROCESS_FORWARD, PROCESS_RETURN, SETTINGS_MANAGE, INBOX_VIEW]
events: [ProcessStageChanged, TenantSettingsChanged]
---

# US-148 — Compatibilidade da dotação com o valor estimado e regra de saída da etapa

## Título
Compatibilidade da dotação com o valor estimado e regra de saída da etapa

## Descrição
**Como** responsável pelo processo e como Contabilidade, **quero** que a plataforma compare as dotações confirmadas com o valor estimado vigente do processo, mostre quanto falta, e só deixe o processo sair da etapa `DOTACAO` com cobertura total (ou com aviso reconhecido, se o órgão assim configurar), **para** que nenhum processo avance sem recurso reservado que o cubra e para que, quando a cobertura se perder depois, quem responde pelo processo veja o problema e possa devolvê-lo à dotação.

A story entrega o **cálculo de cobertura** (Σ `reservedAmount` das dotações `CONFIRMED` ÷ `Process.estimatedValue`, tolerância zero), o **provedor do namespace `budget.*`** do `RuleContext` v2 (contrato da US-129), as **regras de saída semeadas** da etapa `DOTACAO` (BLOCKING por padrão; `WARNING` por `budget.coverageRuleSeverity`), o **indicador de cobertura** no detalhe do processo (SCR-006) e na caixa de tarefas (SCR-013), a configuração da severidade (SCR-041) e o apoio à **devolução por insuficiência** (`RETURN` para `DOTACAO`, DEC-196). Nada disso confirma, cancela ou devolve sozinho: o cálculo é leitura e a devolução é decisão humana.

## Contexto
- DEC-198: a compatibilidade é a soma das dotações `CONFIRMED` × o valor estimado do processo (DEC-032); a regra padrão da saída de `DOTACAO` exige cobertura total (BLOCKING), configurável para `WARNING`. DEC-196 fixa a saída da etapa 7 (`DOTACAO`): "`BudgetAllocation` `CONFIRMED` cobrindo o valor estimado (BLOCKING)".
- RN-BUD-07 e RN-BUD-08 da feature: cobertura = Σ `reservedAmount` das `CONFIRMED` ÷ `Process.estimatedValue`; a saída exige `budget.coverageRatio >= 1`; o tenant pode rebaixar para `WARNING` (`budget.coverageRuleSeverity`), com reconhecimento registrado. Entities MVP 2 §7.2 define `budget: { allocationsCount, confirmedCount, confirmedTotal, coverageRatio, fiscalYears[] }` no `RuleContext` v2; §8 define a chave de configuração (padrão `"BLOCKING"`); §9 prevê o modelo de biblioteca `COBERTURA_DOTACAO` (VALIDATION), sem uso até o administrador adotar.
- DEC-032: `Process.estimatedValue` é derivado por precedência (TR aprovado > pesquisa de preços concluída > ETP > DFD > manual); a conclusão da pesquisa de preços (US-032) e o `PATCH` do processo o alteram. Por isso a cobertura **nunca é gravada**: é recalculada a cada leitura sobre o valor vigente.
- US-129 fixa o mecanismo (`RuleContextContributor`, montagem preguiçosa por namespace, falha fechada em 2 s, sigilo `[sigiloso]` em prévia e mensagens) e deixa a cada módulo a publicação do seu provedor; a US-130 só semeia a v2 do workflow padrão quando a definição das regras de saída de `DOTACAO` (esta story) e o provedor `budget` estão registrados (RN-WF2-100).
- DEC-196: o Jurídico e o Controle Interno podem **devolver** (`RETURN`, PRC-20) o processo para qualquer etapa já percorrida, inclusive `DOTACAO`; a US-130 propõe o mesmo para `AUTORIZACAO_LICITACAO`. A epic descarta devolução automática: "sem devolução automática" quando a dotação é cancelada depois da saída.
- Sigilo (DEC-030, POL-09): valores (estimado, confirmado, faltante) e a razão de cobertura são mascarados para quem não pode ver o orçamento; o **estado** (coberta ou não) e o booleano `coverageReached` já circulam nos eventos (events MVP 2 §4.4) e continuam visíveis.
- **Mapeamento das situações do card de origem** (não há enum novo; o status persistido é só `DRAFT`/`CONFIRMED`/`CANCELED`): *aguardando* = a etapa não tem dotação `CONFIRMED`; *reservada* = há dotação `CONFIRMED` (e a soma cobre o valor, estado `COVERED`); *insuficiente* = Σ `CONFIRMED` < valor estimado; *dispensada* = **não existe** como situação (ver RN-BUD-60).

## Objetivo
Garantir que 100% dos encaminhamentos a partir de `DOTACAO` respeitem a cobertura total do valor estimado vigente (bloqueio por padrão, aviso reconhecido quando configurado), que a diferença exata (centavo a centavo) seja mostrada a quem pode vê-la, que o provedor `budget.*` responda dentro de 50 ms no p95 e falhe fechado, que mudanças posteriores do valor estimado ou das dotações reflitam na leitura seguinte sem job nem cópia, e que nenhum valor de orçamento sigiloso apareça a quem não pode vê-lo.

## Persona
- **Principal:** Responsável pela etapa `DOTACAO` (Contabilidade, `CONTABILIDADE`) e quem encaminha o processo (`PROCESS_FORWARD`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`) e Planejamento (`PLANEJAMENTO`), que acompanham a cobertura; Jurídico, Controle Interno e Autoridade, que podem devolver o processo à dotação; Auditor (`AUDITOR`); Administrador do órgão (`ADMIN_ORGAO`), que define a severidade da regra (`SETTINGS_MANAGE`).

## Pré-condições
- Workflow com a etapa `DOTACAO` e a regra de saída instalada (v2 semeada, US-130, ou regra equivalente adotada pelo órgão); provedor `budget` registrado no `RuleContext` v2 (US-129).
- Dotações `CONFIRMED` conforme a US-147 e `Process.estimatedValue` definido (DEC-032). Sem valor estimado, a cobertura não é calculável (RN-BUD-51).
- Para encaminhar: `PROCESS_FORWARD` + POL-01 (US-047); para devolver: `PROCESS_RETURN` + POL-01 e transição `RETURN` configurada para `DOTACAO` (US-048); para configurar: `SETTINGS_MANAGE`.

## Fluxo principal
1. O painel "Dotação orçamentária" (SCR-006) carrega a cobertura (BUD-20) e mostra o **indicador**: barra e selo com o estado — "Aguardando dotação confirmada", "Cobertura parcial: 60% — faltam R$ 40.000,00", "Valor estimado coberto (100%)" ou "Sem valor estimado" — junto de valor estimado (com a fonte, ex.: "pesquisa de preços"), total confirmado e total em rascunho (informativo, não conta).
2. A Contabilidade indica e confirma dotações (US-146/US-147); a cada mudança o painel recalcula a cobertura.
3. Quando o responsável aciona **"Encaminhar"** em `DOTACAO`, o painel de encaminhamento (US-047) já consultou `PRC-08`/`PRC-09`: as regras de saída `STAGE_EXIT` da etapa aparecem no checklist. Com cobertura total, a regra de cobertura está satisfeita e a ação fica habilitada.
4. Ao enviar `PRC-19`, a API, dentro da transação do encaminhamento (processo travado com `FOR UPDATE`, DEC-055), monta o `RuleContext` v2 pelo retrato de leitura, chama o provedor `budget` (apenas ele, montagem preguiçosa), avalia as regras e: satisfeitas → segue o encaminhamento (US-047); `BLOCKING` não satisfeita → 422 `TRANSITION_BLOCKED` com a mensagem e o valor que falta; `WARNING` não satisfeita e não reconhecida → 422 `WARNINGS_NOT_ACKNOWLEDGED`.
5. Com severidade `BLOCKING` (padrão) e cobertura insuficiente, a ação "Encaminhar" aparece **desabilitada** com o motivo: "A dotação confirmada não cobre o valor estimado do processo: faltam R$ 40.000,00. Confirme outra dotação ou ajuste o valor estimado." (valor mascarado para quem não pode vê-lo).
6. Com a severidade `WARNING` (configurada pelo órgão), o encaminhamento é permitido **depois do reconhecimento** do aviso (`acknowledgedWarnings`); o reconhecimento é gravado na tramitação e na auditoria (DEC-016, RN-TRAM-06), sem valores.
7. Se o valor estimado mudar depois (nova pesquisa de preços, TR aprovado, edição manual), a próxima leitura já mostra a nova cobertura; em `DOTACAO`, a regra reavalia no encaminhamento; fora dela, o painel marca a perda de cobertura (RN-BUD-64).
8. Quando a cobertura fica insuficiente **depois** da saída da etapa (cancelamento de dotação confirmada, US-147, ou aumento do valor estimado), quem responde pelo processo vê o aviso no painel e, se o fluxo permitir, aciona **"Devolver à Dotação"**: o diálogo de devolução (US-048) abre com o motivo sugerido; a pessoa confirma e o processo volta à etapa `DOTACAO` (PRC-20).
9. O administrador do órgão abre SCR-041 › grupo "Dotação orçamentária" e escolhe a severidade da regra de cobertura: "Bloquear o encaminhamento sem cobertura total (padrão)" ou "Apenas avisar (exige reconhecimento)"; salva por `PATCH /settings` com `expectedVersions` e MFA conforme a política. A mudança vale a partir da próxima avaliação, inclusive para processos já na etapa.

## Fluxos alternativos
- **FA-01 — Cobertura acima do valor estimado:** Σ maior que o estimado é aceita (satisfaz a regra); o painel mostra "Coberto (120%) — excedente de R$ 20.000,00" como informação, sem bloquear.
- **FA-02 — Sem valor estimado (nulo ou zero):** estado `NO_ESTIMATE`; a regra de valor estimado definido bloqueia (ou avisa) com "O valor estimado do processo ainda não foi definido"; a regra de cobertura não duplica a mensagem (RN-BUD-56).
- **FA-03 — Sem nenhuma dotação confirmada:** estado `AWAITING` ("aguardando"); `coverageRatio = 0`; a regra bloqueia/avisa conforme a severidade.
- **FA-04 — Dotações em vários exercícios:** a cobertura soma todos os exercícios das `CONFIRMED`; `budget.fiscalYears[]` lista os anos para as regras de outros módulos.
- **FA-05 — Severidade `WARNING` sem reconhecimento:** `WARNINGS_NOT_ACKNOWLEDGED` até o responsável marcar o aviso; o painel recarrega `PRC-09` e reenvia com nova `Idempotency-Key` (US-047 · FA-05).
- **FA-06 — Orçamento sigiloso, usuário sem permissão de sigilo:** o indicador mostra o estado e o cadeado "Valores sigilosos"; mensagens dizem "A dotação confirmada não cobre o valor estimado" sem valor; a avaliação no servidor usa os valores reais (RN-WF2-85).
- **FA-07 — Processo devolvido à `DOTACAO`:** as dotações `DRAFT` e `CONFIRMED` permanecem; novas dotações registram a nova passagem; a regra de saída é avaliada de novo no próximo encaminhamento.
- **FA-08 — Processo sem a etapa `DOTACAO` (v1) ou etapa dispensada por regra de aplicabilidade:** o provedor continua respondendo (`budget.*` com zeros), mas nenhuma regra de saída existe; o painel de indicação não aparece (US-146 · FA-07).
- **FA-09 — Provedor indisponível:** falha fechada (RN-BUD-55): a regra `BLOCKING` bloqueia com a mensagem de indisponibilidade; a `WARNING` aparece como "não verificada".
- **FA-10 — Regra adotada da biblioteca:** o administrador usa `COBERTURA_DOTACAO` em outro ponto (ex.: transição); a expressão é a mesma da regra semeada (RN-BUD-61).

## Regras de negócio
- **RN-BUD-49** — Fórmula e fonte (RN-BUD-07 da feature): `confirmedTotal` = Σ `reservedAmount` das dotações `CONFIRMED` do processo (todos os exercícios; `DRAFT` e `CANCELED` ficam de fora); `coverageRatio` = `confirmedTotal` ÷ `Process.estimatedValue` **vigente no instante da leitura** (DEC-032). O valor estimado nunca é copiado nem gravado na dotação; a cobertura nunca é persistida. A aritmética usa decimais exatos (centavos inteiros), nunca ponto flutuante.
- **RN-BUD-50** — Cobertura total, tolerância zero: a cobertura está atingida (`coverageReached = true`) se e somente se `confirmedTotal >= estimatedValue`, comparados em centavos, sem arredondamento nem margem (99.999,99 de 100.000,00 **não** cobre). Excedente é permitido; `missingAmount = max(0, estimatedValue − confirmedTotal)` e `excessAmount = max(0, confirmedTotal − estimatedValue)`.
- **RN-BUD-51** — Sem valor estimado: `estimatedValue` nulo ou zero → `coverageRatio = null`, estado `NO_ESTIMATE`, `coverageReached = false`; a regra de saída trata o caso pela regra "valor estimado definido" (RN-BUD-56), não pela de cobertura.
- **RN-BUD-52** — Estados de leitura (derivados, não persistidos, sem enum de banco), exibidos em BUD-20, BUD-01 (`meta.coverage`) e TSK-01: `AWAITING` (nenhuma `CONFIRMED`), `INSUFFICIENT` (ao menos uma `CONFIRMED` e Σ < estimado), `COVERED` (Σ ≥ estimado), `NO_ESTIMATE` (RN-BUD-51). Precedência: `NO_ESTIMATE` > `AWAITING` > `INSUFFICIENT` > `COVERED`. Rótulos: "Aguardando dotação confirmada", "Cobertura insuficiente", "Valor estimado coberto", "Sem valor estimado".
- **RN-BUD-53** — `budget.coverageRatio` é número (JSON Logic): `1` quando coberto; **nunca arredondado para 1** se faltar centavo (o provedor limita o quociente a `0,9999999999999999` quando `Σ < estimado`); excedente é o quociente real (ex.: `1,2`); `null` em `NO_ESTIMATE`. Na tela, o percentual é **truncado** a uma casa ("99,9%", nunca "100%" sem cobertura total).
- **RN-BUD-54** — Recálculo e valor estimado alterado: toda leitura (BUD-20, BUD-01, TSK-01, provedor `budget.*`, `PRC-08`/`PRC-09`) calcula sobre o `Process.estimatedValue` e as dotações atuais; nenhuma tabela de cobertura, *cache* de resultado nem job. Mudança no valor estimado (PRC-05, conclusão da pesquisa de preços US-032, aprovação do TR) aparece na leitura seguinte e muda o resultado da regra no encaminhamento seguinte. **Não há aviso ativo** (notificação ou timeline) quando só o valor estimado muda depois da saída da etapa: a perda de cobertura é sinalizada no painel e em `budget.*` (lacuna 7).
- **RN-BUD-55** — Provedor `budget` (`BudgetRuleContextContributor`, único dono do namespace — RN-WF2-83): atende a versão de contexto 2 e devolve `{ allocationsCount, confirmedCount, confirmedTotal, coverageRatio, fiscalYears[] }` com: `allocationsCount` = dotações `DRAFT` + `CONFIRMED` (exclui `CANCELED`); `confirmedCount` = `CONFIRMED`; `confirmedTotal` = Σ (número; `0` sem confirmadas); `coverageRatio` conforme RN-BUD-53; `fiscalYears[]` = anos distintos das `CONFIRMED`, em ordem crescente. Montagem preguiçosa (só quando uma regra usa `budget.*`), leitura somente leitura em um único retrato com a avaliação (mesma transação do encaminhamento) e resultado reutilizado na requisição. **Falha fechada** (RN-WF2-84): erro ou mais de 2 s → regra não satisfeita com `RULE_CONTEXT_UNAVAILABLE` (log `error`); nunca valores padrão silenciosos. `workflow` não importa `budget` (porta `RuleContextContributor`, regra D9).
- **RN-BUD-56** — Regras de saída semeadas da etapa `DOTACAO` (registradas para o portão da RN-WF2-100 da US-130; escopo `STAGE_EXIT`; tipo `CONDITION`; `contextVersion` 2; ativas): **(R1)** `BUDGET_ESTIMATE_DEFINED` — expressão `{ ">": [ { "var": "process.estimatedValue" }, 0 ] }`, mensagem "O valor estimado do processo ainda não foi definido. Conclua a pesquisa de preços ou informe o valor antes de encaminhar."; **(R2)** `BUDGET_COVERAGE` — expressão `{ "or": [ { "!": [ { "var": "process.estimatedValue" } ] }, { ">=": [ { "var": "budget.coverageRatio" }, 1 ] } ] }` (equivale a RN-BUD-08, `budget.coverageRatio >= 1`, e deixa o caso sem valor estimado para R1), mensagem "A dotação confirmada não cobre o valor estimado do processo: faltam {missingAmount}. Confirme outra dotação ou ajuste o valor estimado.". As duas nascem `BLOCKING` e seguem a severidade configurada (RN-BUD-58). Têm chave estável (`seedRuleKey`), são criadas uma única vez por versão semeada (reexecutar o *seeder* não duplica), passam na validação WF-20 e valem para a v2 de "Fase preparatória" e de "Contratação direta" (RN-WF2-91/92). Nenhuma regra da v1 muda.
- **RN-BUD-57** — Mensagens com a diferença: `{missingAmount}` é resolvido pelo provedor no momento da avaliação (formato `R$ 40.000,00`, pt-BR, em centavos exatos); sem permissão de sigilo, o parâmetro vira `[sigiloso]` (RN-WF2-85) e o texto fica "…faltam [sigiloso]…". A mensagem aparece em `PRC-08` (`reasons[]`), `PRC-09` (checklist), em `TRANSITION_BLOCKED.violations[]` e no painel de dotação. A mensagem gravada em `ProcessMovement.metadata.warningsAcknowledged` e na auditoria usa **sempre** a forma mascarada quando o processo é sigiloso.
- **RN-BUD-58** — Severidade configurável: a chave `budget.coverageRuleSeverity` (`"BLOCKING"` padrão | `"WARNING"`, entities MVP 2 §8) define a severidade **efetiva** de R1 e R2 no momento da avaliação (as regras guardam `config.severitySettingKey = "budget.coverageRuleSeverity"`; sem a chave, valem a severidade gravada). Alterar exige `SETTINGS_MANAGE` (risco `H`, MFA conforme POL-14) e `expectedVersions` (SET-02); a auditoria `settings.update` guarda o valor anterior e o novo; vale na próxima avaliação, inclusive para processos já em `DOTACAO`, e **não** reescreve tramitações passadas. Valor fora do enum → `VALIDATION_ERROR`.
- **RN-BUD-59** — Avaliação na saída: `PRC-08`/`PRC-09` mostram o resultado e o motivo; `PRC-19` reavalia na transação com o processo travado (DEC-055) e com o `RuleContext` lido no mesmo retrato; `BLOCKING` não satisfeita → `TRANSITION_BLOCKED` (422, `violations[]` com `ruleId`, `severity`, `message`); `WARNING` não satisfeita e fora de `acknowledgedWarnings[]` → `WARNINGS_NOT_ACKNOWLEDGED` (422). Por ser reavaliada sob trava, uma dotação cancelada ou um valor estimado alterado entre a carga do painel e o envio produz o resultado correto no servidor (o `If-Match` do processo também falha com `VERSION_CONFLICT` quando o valor estimado muda).
- **RN-BUD-60** — Dispensa: **não há dispensa de dotação por processo** nem estado "dispensada" no MVP 2. As fontes só preveem (a) rebaixar a regra a `WARNING` por tenant, com reconhecimento registrado (RN-BUD-08 da feature) e (b) a dispensa **da etapa inteira** por regra de aplicabilidade do workflow (`applicabilityRule`, DEC-204, evento `ProcessStageSkipped`), configurada pelo órgão no editor de workflow (ex.: não aplicar `DOTACAO` em registro de preços), que **não** é semeada. A justificativa escrita de dispensa por processo fica como dúvida de produto.
- **RN-BUD-61** — Biblioteca: o modelo `COBERTURA_DOTACAO` (`kind = VALIDATION`, entities MVP 2 §9) usa a **mesma expressão** de R2 e a mesma severidade padrão; um teste de equivalência compara as duas definições. Adotar o modelo em outro ponto (transição, regra de notificação) é US-194/US-196.
- **RN-BUD-62** — Sigilo da cobertura (RN-BUD-09 da feature): com `isBudgetConfidential` e sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (nem ser o responsável atual), BUD-20, BUD-01 (`meta.coverage`) e a prévia de regras devolvem `estimatedValue`, `confirmedTotal`, `missingAmount`, `excessAmount` e `coverageRatio` como `null` + `<campo>Masked: true` (`"[sigiloso]"` em `contextUsed`, WF-60); `state` e `coverageReached` permanecem. Eventos, notificações, timeline, logs e auditoria nunca levam esses valores. Os agregados do `analytics` seguem POL-28.
- **RN-BUD-63** — Indicador: `CoverageMeter` em SCR-006 (painel de dotação, na etapa e em leitura depois dela) com barra de proporção, selo do estado (texto + ícone), valores (quando permitido) e a fonte do valor estimado (`estimatedValueSource`); no SCR-013, a linha da tarefa da etapa `DOTACAO` ganha o selo do estado (TSK-01 `budget.coverageState`); o checklist do encaminhamento mostra R1/R2. Mensagens sempre com o próximo passo ("Confirme outra dotação…").
- **RN-BUD-64** — Insuficiência depois da saída e devolução: com o processo fora de `DOTACAO` (a etapa tem passagem concluída e nenhuma ativa) e estado `INSUFFICIENT`, `AWAITING` ou `NO_ESTIMATE`, o painel exibe o aviso "A cobertura da dotação ficou insuficiente depois da saída da etapa" e BUD-20 devolve `returnSuggestion { targetStageKey: "DOTACAO", targetWorkflowStageId, suggestedComment }` **se** a transição `RETURN` da etapa atual para `DOTACAO` existir (DEC-196; US-048 · RN-TRAM-24). O comentário sugerido ("Devolvido à Dotação: a dotação confirmada não cobre o valor estimado do processo (faltam {missingAmount}).", 10–5.000 caracteres, valor omitido para quem não pode vê-lo) pré-preenche o diálogo; **quem devolve é uma pessoa** com `PROCESS_RETURN` + POL-01 pela ação `PRC-20`; não há devolução nem bloqueio automático (epic). O retorno cria nova passagem pela etapa; a unidade segue a RN-TRAM-27 (`CHOSEN_ON_FORWARD` reaproveita a última); as dotações existentes são mantidas.
- **RN-BUD-65** — Leitura: BUD-20 exige `PROCESS_VIEW` e visibilidade do processo (DEC-024; invisível ou de outro tenant → 404). `meta.allowedActions` da cobertura indica "devolver à dotação" quando `PRC-08` o oferece. A resposta de BUD-01 ganha `meta.coverage` com o mesmo corpo resumido (aditivo, DEC-108).
- **RN-BUD-66** — Indicadores de gestão sem valor: o KPI "processos que saem de `DOTACAO` com cobertura total" usa `ProcessStageChanged` (`fromStage.key = DOTACAO`) e `BudgetAllocationConfirmed.coverageReached`; o KPI "devoluções à `DOTACAO` por cobertura insuficiente" usa os movimentos `RETURN` com `toStage.key = DOTACAO` (o motivo é texto livre; não há código estruturado — lacuna 9). Nenhum evento novo é criado.
- **RN-BUD-67** — Consumo por outras etapas: o parecer jurídico (US-155), a manifestação do Controle Interno (US-161) e a minuta do edital (US-168) leem `budget.*` pelo mesmo provedor, somente leitura; mudar o significado de um campo exige nova versão de contexto (RN-WF2-80).
- **RN-BUD-68** — Desempenho e consistência: o provedor faz uma consulta agregada (`count`/`sum` por `status` e `array_agg(DISTINCT fiscal_year)` sobre `(tenant_id, process_id, status)`) e lê `Process.estimatedValue` na mesma consulta do retrato; meta p95 ≤ 50 ms por avaliação, 2 s de teto (RN-BUD-55). BUD-20 e o resumo de TSK-01 (consulta agrupada por página, sem N+1) usam o mesmo `BudgetCoverageCalculator`.
- **RN-BUD-69** — Processos antigos e migrados: processos na v1 do workflow não têm a etapa nem a regra (nenhuma mudança de comportamento); processos migrados para a v2 (DEC-195, US-131) passam a ter a regra a partir da etapa `DOTACAO` mapeada. Etapas `TASK` provisórias do contorno do roadmap §3.2 não ganham cobertura retroativa.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Severidade da regra de cobertura | `budget.coverageRuleSeverity` | enum `"BLOCKING"` \| `"WARNING"` | Sim (configuração) | RN-BUD-58; SCR-041, `SETTINGS_MANAGE`, MFA | `"BLOCKING"` |
| Reconhecimento do aviso | `acknowledgedWarnings[]` | lista de uuid (regras) | Condicional (`WARNING` não satisfeita) | RN-BUD-59; US-047 | — |
| Comentário da devolução | `comment` (corpo de PRC-20) | texto 10–5.000 | Sim (devolver) | RN-BUD-64; sugerido pelo servidor | `returnSuggestion.suggestedComment` |
| *(leitura)* Valor estimado | `estimatedValue` / `estimatedValueMasked` / `estimatedValueSource` | decimal string / booleano / `EstimatedValueSource` | — | RN-BUD-49; mascarado (RN-BUD-62) | `Process` |
| *(leitura)* Total confirmado | `confirmedTotal` / `confirmedTotalMasked` | decimal string / booleano | — | RN-BUD-49 | Σ `CONFIRMED` |
| *(leitura)* Quanto falta | `missingAmount` / `missingAmountMasked` | decimal string / booleano | — | RN-BUD-50 | cálculo |
| *(leitura)* Excedente | `excessAmount` / `excessAmountMasked` | decimal string / booleano | — | RN-BUD-50 | cálculo |
| *(leitura)* Razão de cobertura | `coverageRatio` / `coverageRatioMasked` | número / booleano | — | RN-BUD-53 | cálculo |
| *(leitura)* Cobertura atingida | `coverageReached` | booleano | — | RN-BUD-50; nunca mascarado | cálculo |
| *(leitura)* Estado | `state` | `AWAITING` \| `INSUFFICIENT` \| `COVERED` \| `NO_ESTIMATE` | — | RN-BUD-52; derivado | cálculo |
| *(leitura)* Contagens | `allocationsCount`, `confirmedCount`, `draftCount`, `fiscalYears[]` | inteiros / lista | — | RN-BUD-55 | dotações |
| *(leitura)* Sugestão de devolução | `returnSuggestion { targetStageKey, targetWorkflowStageId, suggestedComment }` | objeto \| `null` | — | RN-BUD-64 | `WorkflowFacade` |

Estados derivados e as situações do card de origem:

| Situação no card de origem | Como é representada | Observação |
|---|---|---|
| Aguardando dotação | `state = AWAITING` (nenhuma `CONFIRMED`) | A etapa `DOTACAO` ativa sem confirmada |
| Reservada | `status = CONFIRMED` na dotação; `state = COVERED` no processo | Só cobertura total é "coberta" |
| Insuficiente | `state = INSUFFICIENT` (Σ `CONFIRMED` < valor estimado) | Regra de saída bloqueia/avisa (RN-BUD-56); após a saída, devolução humana (RN-BUD-64) |
| Dispensada (com justificativa) | **sem representação própria** | Rebaixar a regra a `WARNING` com reconhecimento, ou dispensar a etapa por `applicabilityRule` (RN-BUD-60) |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Cobertura menor que o valor estimado com a regra em `BLOCKING` | API (regra de saída) | "A dotação confirmada não cobre o valor estimado do processo: faltam {valor}. Confirme outra dotação ou ajuste o valor estimado." | `TRANSITION_BLOCKED` |
| V-02 | Valor estimado nulo ou zero | API (regra de saída) | "O valor estimado do processo ainda não foi definido. Conclua a pesquisa de preços ou informe o valor antes de encaminhar." | `TRANSITION_BLOCKED` |
| V-03 | Aviso de cobertura (`WARNING`) não reconhecido | Front + API | "Confirme que está ciente de que a dotação não cobre o valor estimado antes de encaminhar." | `WARNINGS_NOT_ACKNOWLEDGED` |
| V-04 | Provedor `budget` indisponível ou acima de 2 s | API | "Não foi possível verificar a dotação agora. Tente novamente em instantes." | `TRANSITION_BLOCKED` (`RULE_CONTEXT_UNAVAILABLE`) |
| V-05 | Valor da severidade fora de `BLOCKING`/`WARNING` | Front + API (Zod) | "Escolha Bloquear ou Apenas avisar." | `VALIDATION_ERROR` |
| V-06 | Chave de configuração fora do registro | API | "Configuração desconhecida." | `SETTING_KEY_UNKNOWN` |
| V-07 | Versão da configuração desatualizada | API | "Outra pessoa alterou esta configuração. Recarregue e tente de novo." | `VERSION_CONFLICT` |
| V-08 | Devolução à dotação sem transição `RETURN` configurada | API | "Esta etapa não pode devolver o processo à dotação." | `TRANSITION_NOT_AVAILABLE` |
| V-09 | Comentário da devolução ausente ou fora de 10–5.000 caracteres | Front + API | "Informe o motivo da devolução (10 a 5.000 caracteres)." | `VALIDATION_ERROR` |

## Permissões
- **Permissão:** leitura da cobertura: `PROCESS_VIEW` (+ `PROCESS_VIEW_CONFIDENTIAL_BUDGET` para os valores); encaminhar: `PROCESS_FORWARD`; devolver: `PROCESS_RETURN`; configurar a severidade: `SETTINGS_MANAGE` (perfil `ADMIN_ORGAO`). Não há permissão nova nesta story.
- **Políticas:** POL-01 (custódia no encaminhamento e na devolução); POL-09 (valores e razão); DEC-024 (visibilidade); POL-14 (MFA da configuração, risco `H`); US-129 (sigilo no `RuleContext`).
- **MFA:** exigido em `SET-02` conforme `security.mfaPolicy`; não se aplica à leitura nem ao encaminhamento (`PROCESS_FORWARD` não é de risco `H`).
- **Sem permissão:** leitura sem `PROCESS_VIEW` → 404 (invisível) ou 403; "Encaminhar" desabilitado com o motivo da regra; "Devolver à Dotação" oculto sem `PROCESS_RETURN`/custódia; SCR-041 sem o grupo para quem não tem `SETTINGS_MANAGE`; `access.denied` auditado.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — (nenhum evento novo de dotação) | — | — | O cálculo é leitura. `BudgetAllocationConfirmed`/`Canceled` já carregam `coverageReached` (US-147) |
| `ProcessStageChanged` | `process.stage_changed.forward` / `.return` | Commit de PRC-19 / PRC-20 | US-047/US-048; o reconhecimento de aviso vai em `ProcessMovement.metadata.warningsAcknowledged`, não no evento |
| `TenantSettingsChanged` | `tenant.settings_changed` | Commit de SET-02 | `keys[]` com `budget.coverageRuleSeverity` (US-103) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Nenhuma nova | — | A perda de cobertura por cancelamento já notifica (`BUDGET_ALLOCATION_CANCELED`, US-147). Não há notificação quando só o valor estimado muda (RN-BUD-54); alterar a severidade não notifica (visível na tela e na auditoria, US-103). A devolução notifica como a US-048 (`PROCESS_RETURNED`). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Compatibilidade da dotação com o valor estimado e regra de saída da etapa

  Background:
    Given que o tenant "Prefeitura A" está ativo com o workflow padrão v2 publicado
    And o processo "0045/2026" está "IN_PROGRESS" na etapa "DOTACAO" com valor estimado de 100.000,00
    And "Marcos", da Contabilidade, é o responsável pela etapa e tem "PROCESS_FORWARD"
    And "budget.coverageRuleSeverity" do tenant é "BLOCKING"

  Scenario: [Sucesso] Cobertura total libera o encaminhamento
    Given que existem duas dotações "CONFIRMED" de 60.000,00 e 40.000,00
    When "Marcos" consultar a cobertura do processo
    Then "state" deve ser "COVERED", "coverageReached" verdadeiro, "confirmedTotal" "100000.00" e "coverageRatio" 1
    And as regras "BUDGET_ESTIMATE_DEFINED" e "BUDGET_COVERAGE" devem estar satisfeitas
    When "Marcos" encaminhar o processo para "MINUTA_EDITAL"
    Then a API deve responder 200 e o processo deve seguir na v2

  Scenario: [Sucesso] Cobertura parcial bloqueia e mostra quanto falta
    Given que existe apenas uma dotação "CONFIRMED" de 60.000,00 e outra "DRAFT" de 40.000,00
    When "Marcos" consultar a cobertura
    Then "state" deve ser "INSUFFICIENT", "missingAmount" "40000.00" e "coverageRatio" 0,6
    And o rascunho de 40.000,00 não deve entrar na soma
    And a ação "Encaminhar" deve estar desabilitada com o motivo "A dotação confirmada não cobre o valor estimado do processo: faltam R$ 40.000,00."
    When "Marcos" tentar encaminhar mesmo assim
    Then a API deve responder 422 com "TRANSITION_BLOCKED" e a mensagem com "faltam R$ 40.000,00"

  Scenario: [Sucesso] Severidade WARNING exige reconhecimento e o registra
    Given que o administrador configurou "budget.coverageRuleSeverity" como "WARNING" e a cobertura é de 60%
    When "Marcos" encaminhar sem reconhecer o aviso
    Then a API deve responder 422 com "WARNINGS_NOT_ACKNOWLEDGED"
    When "Marcos" encaminhar com o id da regra em "acknowledgedWarnings"
    Then a API deve responder 200
    And "metadata.warningsAcknowledged" da tramitação e da auditoria deve conter o id e a mensagem da regra, sem valores

  Scenario: [Sucesso] Valor estimado muda depois e a cobertura é recalculada
    Given que as dotações "CONFIRMED" somam 100.000,00 e "state" é "COVERED"
    When a pesquisa de preços for concluída e elevar o valor estimado para 130.000,00
    Then a leitura seguinte deve mostrar "state" "INSUFFICIENT" e "missingAmount" "30000.00"
    And a regra de saída deve voltar a bloquear o encaminhamento
    And nenhum registro de cobertura deve ter sido gravado ou atualizado em tabela alguma

  Scenario: [Sucesso] Provedor do namespace budget responde às regras do RuleContext v2
    When "Carla" testar a expressão "budget.coverageRatio >= 1" e ver o contexto do processo "0045/2026"
    Then o contexto deve trazer "budget.allocationsCount", "budget.confirmedCount", "budget.confirmedTotal", "budget.coverageRatio" e "budget.fiscalYears"
    And apenas o provedor do namespace "budget" deve ser consultado

  Scenario: [Sucesso] Cobertura perdida depois da saída leva à devolução humana
    Given que o processo já está na etapa "JURIDICO" e a Contabilidade cancelou uma dotação confirmada
    When "Ana", do Jurídico, abrir o painel de dotação
    Then deve aparecer "A cobertura da dotação ficou insuficiente depois da saída da etapa" e a ação "Devolver à Dotação"
    And o diálogo deve vir com o motivo sugerido sem valor para quem não pode vê-lo
    When "Ana" confirmar a devolução
    Then o processo deve voltar à etapa "DOTACAO" com uma nova passagem
    And as dotações "CONFIRMED" restantes devem ser mantidas
    And o processo não deve ter sido devolvido antes da ação de "Ana"

  Scenario: [Sucesso] Orçamento sigiloso mostra o estado, mas não os valores
    Given que o processo é sigiloso e "Paulo" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET"
    When "Paulo" consultar a cobertura
    Then "state" e "coverageReached" devem aparecer
    And "estimatedValue", "confirmedTotal", "missingAmount" e "coverageRatio" devem vir nulos com os campos "Masked" verdadeiros
    And a mensagem de bloqueio deve dizer "faltam [sigiloso]"
    And a avaliação no servidor deve usar os valores reais

  Scenario: [Validação] Tolerância zero: faltar um centavo não cobre
    Given que as dotações "CONFIRMED" somam 99.999,99 e o valor estimado é 100.000,00
    When "Marcos" consultar a cobertura
    Then "coverageReached" deve ser falso, "missingAmount" "0.01" e "coverageRatio" menor que 1
    And o painel deve mostrar "99,9%" e nunca "100%"
    And a regra "BUDGET_COVERAGE" deve bloquear o encaminhamento

  Scenario: [Validação] Sem valor estimado e valor de configuração inválido
    Given que o processo não tem valor estimado
    When "Marcos" encaminhar o processo
    Then a API deve responder 422 com "TRANSITION_BLOCKED" citando "BUDGET_ESTIMATE_DEFINED" e sem duplicar a mensagem de cobertura
    When o administrador enviar "budget.coverageRuleSeverity" com o valor "OFF"
    Then a API deve responder 422 com "VALIDATION_ERROR"
    And a severidade vigente deve continuar "BLOCKING"

  Scenario: [Permissão] Quem não administra não muda a severidade
    Given que "Bruno" não possui "SETTINGS_MANAGE"
    When "Bruno" tentar alterar "budget.coverageRuleSeverity" para "WARNING"
    Then a API deve responder 403 com "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"
    Given que a política de MFA exige o segundo fator e a sessão do administrador não o tem
    When o administrador tentar alterar a severidade
    Then a API deve responder 403 com "MFA_REQUIRED"

  Scenario: [Permissão] Encaminhar sem permissão ou devolver sem custódia
    Given que "Bruno" não possui "PROCESS_FORWARD"
    When "Bruno" tentar encaminhar o processo
    Then a API deve responder 403 com "PERMISSION_DENIED"
    And a regra de cobertura não deve ser avaliada nem revelar valores a "Bruno"

  Scenario: [Tenant incorreto] Cobertura e configuração de outro tenant
    Given que existe o processo "0031/2026" no tenant "Prefeitura B"
    When "Marcos", no tenant "Prefeitura A", consultar a cobertura desse processo
    Then a API deve responder 404 com "NOT_FOUND" sem revelar dado do tenant "Prefeitura B"
    Given que a "Prefeitura B" configurou a severidade como "WARNING"
    When "Marcos" encaminhar um processo da "Prefeitura A" com cobertura insuficiente
    Then a regra deve continuar "BLOCKING" na "Prefeitura A"
    And as dotações da "Prefeitura B" nunca devem entrar na soma da "Prefeitura A"

  Scenario: [Duplicidade] Semeadura repetida e reenvio do encaminhamento
    Given que o passo de workflows padrão v2 do tenant já registrou as regras "BUDGET_ESTIMATE_DEFINED" e "BUDGET_COVERAGE"
    When o passo for executado de novo
    Then deve continuar existindo uma única regra de cada na etapa "DOTACAO"
    Given que "Marcos" encaminhou com "Idempotency-Key" "k-148" e reconheceu o aviso
    When a mesma requisição for reenviada
    Then a API deve responder com o cabeçalho "Idempotent-Replayed" verdadeiro
    And deve existir uma única tramitação e um único reconhecimento registrado

  Scenario: [Concorrência] Cancelamento da dotação e encaminhamento ao mesmo tempo
    Given que as dotações "CONFIRMED" cobrem 100% do valor estimado
    When "Marcos" encaminhar o processo e "Carla" cancelar uma dotação confirmada ao mesmo tempo
    Then as duas operações devem ser serializadas pela trava do processo
    And se o cancelamento vencer, o encaminhamento deve responder 422 com "TRANSITION_BLOCKED"
    And se o encaminhamento vencer, o cancelamento deve ser tratado como cancelamento depois da saída da etapa e gerar o aviso da US-147

  Scenario: [Concorrência] Valor estimado muda entre a tela e o envio
    Given que "Marcos" carregou o painel com cobertura total sobre o valor estimado de 100.000,00
    When o valor estimado subir para 130.000,00 antes do envio
    And "Marcos" encaminhar com a versão antiga do processo
    Then a API deve responder 412 com "VERSION_CONFLICT"
    And ao recarregar, o painel deve mostrar "Cobertura insuficiente" com "faltam R$ 30.000,00"

  Scenario: [Falha de banco] Banco falha ao ler a cobertura no encaminhamento
    Given que o banco falha ao consultar as dotações durante a avaliação
    When "Marcos" encaminhar o processo
    Then a API deve responder 503 com "DEPENDENCY_UNAVAILABLE"
    And nenhuma tramitação, mudança de etapa, auditoria ou evento deve ser gravado
    And o processo deve continuar na etapa "DOTACAO"

  Scenario: [Falha de integração] Provedor budget excede o tempo e a regra falha fechada
    Given que o provedor do namespace "budget" excede 2 segundos
    When "Marcos" encaminhar o processo
    Then a API deve responder 422 com "TRANSITION_BLOCKED" e "RULE_CONTEXT_UNAVAILABLE"
    And a mensagem deve ser "Não foi possível verificar a dotação agora. Tente novamente em instantes."
    And nenhum valor padrão deve ter sido usado para liberar o processo
    Given que a severidade é "WARNING"
    Then a regra deve aparecer como "não verificada" e exigir reconhecimento

  Scenario: [Falha de integração] Redis indisponível não altera o resultado da regra
    Given que o Redis (cache de permissões e idempotência) está indisponível
    When "Marcos" consultar a cobertura
    Then o cálculo deve ser feito diretamente no banco e a resposta deve ser a mesma
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Cobertura insuficiente (`BLOCKING`) | 422 | `TRANSITION_BLOCKED` | "A dotação confirmada não cobre o valor estimado do processo: faltam {valor}. Confirme outra dotação ou ajuste o valor estimado." | Ação desabilitada com o motivo; link "Ver dotações" |
| Valor estimado não definido | 422 | `TRANSITION_BLOCKED` | "O valor estimado do processo ainda não foi definido. Conclua a pesquisa de preços ou informe o valor antes de encaminhar." | Link para a pesquisa/valor estimado |
| Aviso de cobertura não reconhecido (`WARNING`) | 422 | `WARNINGS_NOT_ACKNOWLEDGED` | "Confirme que está ciente de que a dotação não cobre o valor estimado antes de encaminhar." | Recarrega o checklist; caixa de seleção |
| Provedor `budget` indisponível | 422 | `TRANSITION_BLOCKED` (`RULE_CONTEXT_UNAVAILABLE`) | "Não foi possível verificar a dotação agora. Tente novamente em instantes." | "Tentar novamente"; `WARNING` aparece como "não verificada" |
| Processo/cobertura de outro tenant ou invisível | 404 | `NOT_FOUND` | "Processo não encontrado." | Volta à lista |
| Sem permissão de configurar | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar esta configuração." | Grupo oculto em SCR-041 |
| MFA exigido na configuração | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | *Step-up* e reenvio |
| Valor de configuração inválido | 422 | `VALIDATION_ERROR` | "Escolha Bloquear ou Apenas avisar." | Erro no campo |
| Configuração alterada por outra pessoa | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou esta configuração. Recarregue e tente de novo." | Recarrega a tela |
| Processo alterado desde a carga do painel | 412 | `VERSION_CONFLICT` | "Outra pessoa alterou o processo. Recarregue e tente de novo." | Recarrega e recalcula a cobertura |
| Devolução à dotação não configurada | 422 | `TRANSITION_NOT_AVAILABLE` | "Esta etapa não pode devolver o processo à dotação." | Oculta "Devolver à Dotação" |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível verificar a dotação agora. Tente novamente em instantes." | "Tentar novamente"; processo permanece na etapa |

## Dependências
- **Stories:** US-032 (valor estimado do processo, `estimatedValue` e `estimatedValueSource`), US-129 (`RuleContext` v2: contrato, montagem preguiçosa, falha fechada, sigilo), US-147 (dotações `CONFIRMED`, cancelamento e `coverageReached`). Indiretas: US-146 (indicação), US-041/US-044 (motor e regras `STAGE_EXIT`), US-047/US-048 (encaminhar/devolver), US-103 (configurações), US-130 (semeia a regra na v2 — depende desta story), US-155/US-161/US-168 (leitores de `budget.*`).
- **Decisões/ADRs:** DEC-198, DEC-196, DEC-032, DEC-030, DEC-016, DEC-204, DEC-195, DEC-055, DEC-104, DEC-105, DEC-108; ADR-008, ADR-015.
- **Configurações:** `budget.coverageRuleSeverity` (padrão `"BLOCKING"`).
- **Lacunas nas fontes canônicas:**
  1. **Endpoint novo** `BUD-20` — `GET /processes/{id}/budget-allocations/coverage` (faixa BUD-20..BUD-29 desta story); campos aditivos `meta.coverage` em `BUD-01` e `budget.coverageState` em `TSK-01` (DEC-108). Consolidar no `api.md` do MVP 2.
  2. **Leituras derivadas** `state` ∈ {`AWAITING`, `INSUFFICIENT`, `COVERED`, `NO_ESTIMATE`}, `missingAmount`, `excessAmount`, `coveragePercent` (apresentação), `returnSuggestion`: não são enum de banco nem entidade; são vocabulário de resposta novo.
  3. **Duas regras de saída** (`BUDGET_ESTIMATE_DEFINED` e `BUDGET_COVERAGE`) no lugar da regra única de DEC-196/RN-BUD-08: separam a mensagem de "valor estimado não definido" da de cobertura; a expressão de R2 equivale a `budget.coverageRatio >= 1` quando há valor estimado. Confirmar com a US-130/produto. As definições precisam de **chave estável** (`seedRuleKey`) para o *seeder* idempotente.
  4. **Severidade configurável em tempo de avaliação:** `WorkflowRule` publicada é imutável, mas a severidade deve seguir `budget.coverageRuleSeverity`. Proposta: `config.severitySettingKey` na regra `CONDITION`, resolvido pelo `WorkflowFacade.evaluateRules` (extensão do motor da US-041/US-129). Sem essa extensão, a chave não tem efeito.
  5. **Placeholders de mensagem** (`{missingAmount}`) resolvidos pelo provedor do namespace no momento da avaliação: extensão do contrato `RuleContextContributor` da US-129 (hoje as mensagens de regra são texto fixo de até 500 caracteres).
  6. **Mascaramento de `budget.coverageRatio`:** a RN-WF2-85 (US-129) lista `process.estimatedValue`, `pca.plannedValue` e `budget.confirmedTotal`; a RN-BUD-09 da feature manda mascarar também a cobertura. Incluir `budget.coverageRatio` na lista de campos mascarados em prévia, mensagens e `contextUsed`.
  7. **Aviso proativo quando só o valor estimado muda** depois da saída da etapa: não há evento, tipo de timeline nem notificação nas fontes (o cancelamento tem). Mantido apenas o indicador e o `budget.*`; avaliar se produto quer um consumidor (`process.updated`/`document.finalized.price_research`) que avise o responsável.
  8. **Dispensa de dotação por processo com justificativa**, citada no card de origem, não existe nas fontes: ver RN-BUD-60 (rebaixar a `WARNING` por tenant ou dispensar a etapa por `applicabilityRule`). Dúvida de produto.
  9. **Devolução por insuficiência:** a DEC-196 só prevê `RETURN` para etapas já percorridas a partir de `JURIDICO` e `CONTROLE_INTERNO`; a US-130 propõe `AUTORIZACAO_LICITACAO`. Para a sugestão valer, a v2 precisa de `RETURN` para `DOTACAO` também a partir de `MINUTA_EDITAL`. O KPI "devoluções por cobertura insuficiente" não tem código de motivo estruturado em PRC-20 (só comentário livre).
  10. **Campos do provedor:** `confirmedTotal` é emitido como `0` (e não `null`) sem confirmadas, e `allocationsCount` conta `DRAFT` + `CONFIRMED` (entities §7.2 não define); `coverageRatio` limitado a `0,9999999999999999` quando falta centavo (RN-BUD-53). Confirmar a semântica com a US-129.
  11. **Chave de configuração no registro** de `SETTING_KEY_UNKNOWN` (US-103): o módulo `budget` registra `budget.coverageRuleSeverity` com schema Zod e grupo "Dotação orçamentária" em SCR-041.

## Impacto técnico
- **Cálculo único, vários leitores:** `BudgetCoverageCalculator` (domínio puro, centavos inteiros) é usado por BUD-20, BUD-01, TSK-01, pelo provedor `budget.*` e pelo `coverageReached` da US-147; um conjunto de testes de propriedade garante que todos concordam.
- **Sem estado derivado persistido:** nenhuma coluna ou tabela de cobertura; o risco de divergência some, ao custo de uma agregação por leitura (índice `(tenant_id, process_id, status)`); a caixa de tarefas agrega por página.
- **Motor de regras:** exige duas extensões pequenas e retrocompatíveis (severidade por configuração e parâmetros de mensagem) em `WorkflowFacade` — itens 4 e 5 das lacunas — com regressão das regras do MVP 1 (RN-WF2-81). `workflow` continua sem importar `budget`.
- **Falha fechada e consistência:** a avaliação ocorre dentro da transação de `PRC-19` com o processo travado; o retrato único evita ler dotações e valor estimado em instantes diferentes (US-129 · retrato de leitura).
- **Sigilo:** valores só saem de BUD-20/BUD-01 para quem passa pela política central; mensagens de regra, `contextUsed`, movimentos e auditoria usam `[sigiloso]`; testes de serialização e de vazamento no `RuleContext` (WF-60) fazem parte da suíte `test/tenant-leak`.
- **Semeadura:** as regras entram na definição semeada da v2 (US-130) e passam pelo portão da RN-WF2-100; o *seeder* é idempotente por `seedRuleKey`; tenants com workflow customizado recebem a oferta, nunca a imposição (DEC-196).
- **Compatibilidade:** processos na v1 e regras de `contextVersion = 1` mantêm resultado idêntico (suíte de regressão); respostas novas são aditivas.

## Backend
- **Módulo(s):** `budget` (calculador, provedor do namespace, BUD-20, definição das regras semeadas), `workflow` (motor, regra `STAGE_EXIT`, severidade por configuração), `process` (retrato de leitura, `PRC-08`/`PRC-09`/`PRC-19`/`PRC-20`), `tenancy`/`platform` (registro de configuração), `timeline`, `audit`.
- **Casos de uso:** `GetBudgetCoverageQuery` (BUD-20), `BudgetCoverageCalculator`, `BudgetRuleContextContributor` (US-129), `BudgetTaskCoverageQuery` (lote para TSK-01), `BudgetExitRuleSeedDefinition` (R1/R2 para o *seeder* da US-130), `ResolveCoverageRuleSeverity` (leitura de `budget.coverageRuleSeverity`).
- **Domínio:** `Money` (centavos inteiros); `CoverageResult { state, coverageReached, missing, excess, ratio }`; `CoverageState`; `ReturnSuggestionBuilder`; mascaramento por `ContextMasker` (POL-09).
- **Integrações internas:** `ProcessFacade` (valor estimado e fonte, `isBudgetConfidential`, etapas ativas/concluídas), `WorkflowFacade` (transição `RETURN` para `DOTACAO`, avaliação), `SettingsFacade` (chave e versão), `AuthorizationService`.
- **Transação:** leituras somente leitura em um retrato; o encaminhamento (US-047) avalia dentro da própria transação com o processo travado; SET-02 grava `TenantSetting` + auditoria + `TenantSettingsChanged` na mesma transação.

## Frontend
- **Tela(s):** SCR-006 (`/processos/[id]`) — `CoverageMeter` e avisos no painel de dotação; SCR-013 (`/tarefas`) — selo do estado na linha da tarefa; SCR-041 (`/admin/configuracoes`) — grupo "Dotação orçamentária" com a severidade.
- **Componentes:** `CoverageMeter` (barra, percentual truncado, selo com ícone e texto, valores ou cadeado), `CoverageBanner` (perda de cobertura depois da saída), `ReturnToBudgetButton` (abre o diálogo de devolução da US-048 com o comentário sugerido), `CoverageRuleChecklistItem` (R1/R2 no checklist), `InboxCoverageChip`, `BudgetSettingsSection` (rádio Bloquear/Apenas avisar com o efeito explicado).
- **Estados:** loading (skeleton do indicador); `NO_ESTIMATE` com link ao valor estimado; erro com "Tentar novamente"; valores mascarados com cadeado "Valores sigilosos"; conflito 412 com recarga; configuração salva com toast "Regra de cobertura atualizada".
- **Acessibilidade e responsividade:** a barra é `role="meter"` com `aria-valuenow` truncado e `aria-label` textual (sem depender de cor); selo por texto e ícone; mudanças de estado anunciadas em `aria-live="polite"`; no mobile (< 768 px) o indicador vira cartão em coluna única; seção de configuração com `fieldset`/`legend` e descrição do efeito de cada opção.

## Banco de dados
- **Tabelas:** leitura de `budget_allocations`, `processes`, `process_stages`; `tenant_settings` (chave `budget.coverageRuleSeverity`); `workflow_rules` (regras semeadas R1/R2 com `context_version = 2`); escrita só nas tabelas já existentes de auditoria, outbox e movimentos do encaminhamento.
- **Migrações:** nenhuma tabela ou coluna nova; semeadura incremental do registro de configuração e das regras na definição da v2 (migração de dados do *seeder* da US-130, idempotente por `seedRuleKey`).
- **Índices/constraints relevantes:** reaproveita `(tenant_id, process_id, status)` de `budget_allocations`; sem índice novo. Nenhuma coluna de cobertura persistida (RN-BUD-49).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `BUD-20` | GET | `/processes/{id}/budget-allocations/coverage` | — | `200 { data: Coverage }` (campos abaixo); valores mascarados conforme POL-09 | 200, 401, 403, 404 |
| `BUD-01` | GET | `/processes/{id}/budget-allocations` | como na US-146 | `meta.coverage` (resumo de `Coverage`) — aditivo | 200, 403, 404 |
| `TSK-01` | GET | `/tasks` | como na US-056 | `budget.coverageState` na linha da etapa `DOTACAO` — aditivo | 200 |
| `PRC-08` | GET | `/processes/{id}/available-actions` | — | `reasons[]` com a mensagem da regra de cobertura; ação `RETURN` para `DOTACAO` quando configurada | 200 |
| `PRC-09` | GET | `/processes/{id}/checklist` | — | itens R1/R2 com `severity` efetiva e `satisfied` | 200 |
| `PRC-19` | POST | `/processes/{id}/forward` | como na US-047 (`acknowledgedWarnings[]` para `WARNING`) | `TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED` com `violations[]` da cobertura | 200, 403, 404, 409, 412, 422, 503 |
| `PRC-20` | POST | `/processes/{id}/return` | como na US-048 (`targetStageId` = `DOTACAO`, `comment`) | devolução humana | 200, 403, 404, 409, 412, 422 |
| `SET-01` | GET | `/settings` | — | inclui `budget.coverageRuleSeverity` | 200, 403 |
| `SET-02` | PATCH | `/settings` | `{ values: { "budget.coverageRuleSeverity": "WARNING" }, expectedVersions: { … } }` | `200 { data: { "budget.coverageRuleSeverity": { value, version } } }` | 200, 403, 412, 422, 428 |
| `WF-19` / `WF-23` / `WF-60` | GET / POST / POST | `/rule-context/schema`, `/workflow-versions/{versionId}/rules/test`, prévia do contexto (US-129) | `version=2` / expressão com `budget.*` | namespace `budget` disponível; valores sigilosos como `"[sigiloso]"` | 200, 403, 422 |

Exemplo de resposta de `BUD-20` (processo não sigiloso, cobertura parcial):
```json
{
  "data": {
    "processId": "0192f1b0-1c11-7a52-8e0f-9a3b6c7d2e01",
    "state": "INSUFFICIENT",
    "coverageReached": false,
    "estimatedValue": "100000.00", "estimatedValueMasked": false, "estimatedValueSource": "PRICE_RESEARCH",
    "confirmedTotal": "60000.00", "confirmedTotalMasked": false,
    "missingAmount": "40000.00", "missingAmountMasked": false,
    "excessAmount": "0.00", "excessAmountMasked": false,
    "coverageRatio": 0.6, "coverageRatioMasked": false,
    "allocationsCount": 2, "confirmedCount": 1, "draftCount": 1,
    "fiscalYears": [2026],
    "ruleSeverity": "BLOCKING",
    "stage": { "inBudgetStage": true, "pastBudgetStage": false },
    "returnSuggestion": null
  }
}
```

Exemplo de `TRANSITION_BLOCKED` em `PRC-19`:
```json
{
  "error": {
    "code": "TRANSITION_BLOCKED",
    "message": "O processo não pode ser encaminhado.",
    "violations": [
      { "ruleId": "0192f1d4-…", "ruleKey": "BUDGET_COVERAGE", "severity": "BLOCKING",
        "message": "A dotação confirmada não cobre o valor estimado do processo: faltam R$ 40.000,00. Confirme outra dotação ou ajuste o valor estimado." }
    ]
  }
}
```

## Logs
- `info` `budget.coverage.evaluated` — `processId`, `state`, `coverageReached`, `source` (`API`, `RULE`, `INBOX`), `durationMs` (sem valores).
- `warn` `budget.coverage.rule_blocked` — `processId`, `ruleKey`, `severity`; `warn` `budget.coverage.provider_slow` — `processId`, `durationMs` acima de 500 ms.
- `error` `budget.coverage.provider_failed` — `processId`, `reason` (`TIMEOUT`, `DB_ERROR`), indicando `RULE_CONTEXT_UNAVAILABLE`.
- `info` `budget.coverage.severity_resolved` — `tenantId`, `severity`.
- **Nunca logar:** `estimatedValue`, `confirmedTotal`, `missingAmount`, `coverageRatio` em processo sigiloso (nem fora dele, por padrão), comentário da devolução, mensagens de regra já com valor.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.forward` | `WORKFLOW` | Commit de PRC-19 a partir de `DOTACAO` | `metadata.warningsAcknowledged[]` (id e mensagem **mascarada**) quando `WARNING`; `metadata.budgetCoverage { state, coverageReached, severity }` (sem valores) — acréscimo aditivo à auditoria da US-047 |
| `process.return` | `WORKFLOW` | Commit de PRC-20 para `DOTACAO` | como na US-048; `metadata.suggestedByBudget: true` quando o comentário veio da sugestão |
| `settings.update` | `CONFIGURATION` | Commit de SET-02 | valor anterior/novo de `budget.coverageRuleSeverity` (US-103) |
| `access.denied` | `ACCESS` | Tentativa sem `SETTINGS_MANAGE`/permissão | `reasonCode` |

## Testes necessários
- **Unitários:** `BudgetCoverageCalculator` (soma em centavos, tolerância zero 99.999,99 × 100.000,00, excedente, valor estimado nulo/zero, `coverageRatio` limitado abaixo de 1, truncamento do percentual, vários exercícios); estados e precedência (RN-BUD-52); resolução da severidade efetiva; montagem de `returnSuggestion` (com e sem permissão de sigilo); equivalência de `COBERTURA_DOTACAO` e R2; propriedade: calculador e provedor concordam em 1.000 casos aleatórios.
- **Integração (Testcontainers PostgreSQL + Redis):** provedor `budget` pelo `RuleContextBuilder` (só o namespace pedido é consultado; cache por requisição; falha fechada por timeout e por erro); `PRC-19` bloqueado/liberado/com `WARNING` reconhecido, com cancelamento e alteração do valor estimado sob a trava do processo; agregação de TSK-01 sem N+1; reexecução do *seeder* (regras R1/R2 únicas); `SET-02` aplicando a severidade na avaliação seguinte sem reescrever tramitações; processos na v1 sem mudança.
- **API/contrato:** BUD-20 e os campos aditivos contra o OpenAPI (campos `*Masked` sempre presentes); `violations[]` de `TRANSITION_BLOCKED`; `meta.coverage` em BUD-01; WF-19/WF-23/WF-60 com o namespace `budget`; regressão do contrato do MVP 1 (`contextVersion = 1`).
- **RBAC e multi-tenant:** sigilo (mascaramento em BUD-20, BUD-01, prévia, mensagens, movimentos e auditoria; nenhum valor em evento, notificação, timeline, log); processo e configuração de outro tenant → 404/isolados (suíte `test/tenant-leak`, arquivo `budget-coverage.tenant-leak.test.ts`: o provedor nunca soma dotação de outro tenant, com RLS); `SETTINGS_MANAGE` e MFA na configuração.
- **Concorrência:** cancelar × encaminhar; confirmar a última dotação × encaminhar; alteração do valor estimado × encaminhar (412); duas alterações simultâneas da severidade (412 por chave).
- **E2E (Playwright):** indicar e confirmar até a cobertura total e avançar; cobertura parcial bloqueada com a diferença; severidade `WARNING` com reconhecimento; valor estimado muda e a cobertura cai; cancelar depois da saída e devolver à dotação com o motivo sugerido; processo sigiloso visto por perfil sem permissão.
- **Acessibilidade/performance:** axe no `CoverageMeter`, no checklist e na seção de configuração; leitura por leitor de tela do estado da cobertura; p95 do provedor `budget` ≤ 50 ms e de BUD-20 ≤ 150 ms na suíte de performance (medida no endurecimento).

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
- [ ] Provedor `budget` registrado e coberto pelo teste de contrato dos provedores (US-129)
- [ ] Definição das regras de saída de `DOTACAO` registrada para o portão da RN-WF2-100 (US-130) e validada por WF-20 em CI
- [ ] Teste de regressão das regras do MVP 1 (`contextVersion = 1`) verde após as extensões do motor
- [ ] Teste prova que nenhuma cobertura é persistida e que o valor estimado alterado muda a leitura seguinte

## Estimativa
**M** — calculador de domínio exato, provedor do `RuleContext` v2 com sigilo e falha fechada, duas regras de saída semeadas com severidade por configuração, endpoint e indicador de cobertura em duas telas, configuração em SCR-041 e apoio à devolução; sem tabela nova e sem integração externa.

## Prioridade
**P0** — é a regra que impede o processo de sair da etapa `DOTACAO` sem recurso reservado (DEC-196/DEC-198) e pré-requisito da publicação da v2 do workflow padrão (US-130, RN-WF2-100); também alimenta os pareceres e conferências das etapas seguintes.
