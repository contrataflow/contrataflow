# MVP 2 — Critérios de Aceite

> **Documento canônico** dos critérios de aceite do MVP 2 "Governança e Controle": acréscimos aos critérios transversais (CA-T), jornadas de aceite J-12 a J-20, consolidação das 8 categorias por épico e por story, e a lista do que depende de decisão pendente.
> Os critérios transversais e as jornadas J-01 a J-11 do [MVP 1](../mvp-01/acceptance-criteria.md) continuam valendo e entram no aceite do MVP 2 como regressão. Estratégia de testes: [tests.md](tests.md). Versão 1, revisável depois do UAT do MVP 1 (DEC-192).

Sumário: [1. CA-T](#1-critérios-transversais-ca-t-acréscimos-do-mvp-2) · [2. Jornadas](#2-jornadas-de-aceite-do-mvp-2) · [3. Por épico](#3-consolidação-por-épico) · [4. Por story](#4-índice-de-critérios-por-story) · [5. Pendências](#5-o-que-depende-de-decisão-pendente)

---

## 1. Critérios transversais (CA-T): acréscimos do MVP 2

Os dez CA-T do MVP 1 valem para toda rota, tela e job novos. Acréscimos que viram teste obrigatório (detalhe em [tests.md §2](tests.md#2-suítes-transversais-o-que-o-mvp-2-acrescenta)):

```gherkin
Feature: Critérios transversais do MVP 2

  Scenario: [CA-T-01] Entidades novas isoladas por tenant
    Given os tenants "Prefeitura A" e "Prefeitura B" com PCA, dotações, análises, manifestações, minutas, regras, políticas de SLA e planos de migração equivalentes
    When um usuário da "Prefeitura A" pedir qualquer um desses recursos da "Prefeitura B" pelo id
    Then a API deve responder 404 sem indicar que o recurso existe
    And relatórios, exportações e reconstruções do read model da "Prefeitura A" não devem conter dado da "Prefeitura B"

  Scenario: [CA-T-02] Segregação de funções nas análises
    Given "Daniel" (JURIDICO) é autor de uma versão do DFD do processo
    When "Daniel" tentar concluir a análise jurídica desse processo
    Then a API deve responder 403 e registrar "access.denied"

  Scenario: [CA-T-04] Decisões em paralelo na aprovação por todos
    Given uma aprovação com política "ALL" e duas linhas pendentes
    When os dois aprovadores decidirem ao mesmo tempo, cada um com o "If-Match" da sua linha
    Then as duas decisões devem ser registradas sem 412
    And a aprovação deve ser encerrada uma única vez

  Scenario: [CA-T-05] Execução de migração repetida
    Given um plano de migração executado com a chave de idempotência "K1"
    When a execução for pedida de novo com "K1"
    Then a API deve devolver o mesmo resultado e nenhum processo deve ser migrado duas vezes

  Scenario: [CA-T-08] Agregado sem valores sigilosos
    Given 3 processos com orçamento sigiloso no recorte do relatório
    When um gestor sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" abrir o relatório de volume e valor
    Then as somas não devem incluir os valores sigilosos
    And a tela deve indicar que há valores sigilosos não exibidos
    And a diferença entre dois recortes não deve permitir deduzir o valor de um processo sigiloso

  Scenario: [CA-T-06] Nada de texto sensível em evento, log ou auditoria
    When um parecer, uma manifestação ou uma minuta for concluída, ou uma identidade gov.br for vinculada
    Then eventos, logs e auditoria devem trazer apenas ids, versões, hashes, contagens e códigos
    And nenhum texto de documento nem CPF deve aparecer neles
```

## 2. Jornadas de aceite do MVP 2

Personas e dados: tenant "Prefeitura de São José" (o do MVP 1) com a **v2 do workflow padrão** adotada (DEC-196), unidades "Contabilidade", "Procuradoria-Geral", "Controladoria" e "Departamento de Licitações", e as personas Beatriz (CONTABILIDADE), Daniel (JURIDICO), Helena (CONTROLE_INTERNO), Lucas (LICITACOES), Marta (ADMIN_ORGAO), Rui (COMPRAS) e a Autoridade. Seed e automação por jornada: [tests.md §3](tests.md#3-jornadas-de-aceite-e2e-j-12-a-j-20).

### J-12 — Fase preparatória completa até a autorização da licitação
```gherkin
Feature: Fase preparatória concluída na versão 2 do workflow

  Scenario: Da dotação à autorização da licitação
    Given o processo "Aquisição de cimento para manutenção de vias" aprovado pela autoridade na etapa "APROVACAO_AUTORIDADE"
    When o processo for encaminhado para "DOTACAO"
    And "Beatriz" indicar a dotação, anexar a nota de reserva e confirmar a reserva cobrindo o valor estimado
    Then a regra de saída da etapa "DOTACAO" deve ser satisfeita e o processo deve seguir para "MINUTA_EDITAL"
    When "Lucas" criar a minuta do edital, importar itens e critérios do TR, organizar os lotes, preencher a matriz de alocação de riscos e concluir a minuta
    Then as versões do "EDITAL" e da "MINUTA_CONTRATO" devem ficar congeladas e o processo deve seguir para "JURIDICO"
    And a análise jurídica deve entrar na fila priorizada como "PENDING"
    When "Daniel" iniciar a análise, elaborar o parecer, registrar uma ressalva e concluir como "FAVORABLE_WITH_RESERVATIONS"
    Then o parecer deve ficar vinculado às versões exatas analisadas e o processo deve seguir para "CONTROLE_INTERNO"
    When "Helena" responder o checklist, registrar uma recomendação e concluir como "COMPLIANT_WITH_RECOMMENDATIONS"
    Then o processo deve seguir para "AUTORIZACAO_LICITACAO" com aprovação cobrindo edital, minuta do contrato, parecer e manifestação
    When a Autoridade aprovar
    Then o processo deve ficar "COMPLETED" na etapa "Fase preparatória concluída"
    And a timeline, a auditoria e o read model devem registrar cada passo
```

### J-13 — Diligência do jurídico e retomada
```gherkin
Feature: Diligência com pausa de prazo

  Scenario: O jurídico pede diligência e retoma a análise em nova rodada
    Given o processo da J-12 na etapa "JURIDICO" com a análise "IN_REVIEW" e prazo de 5 dias úteis
    When "Daniel" pedir diligência ao "TERMO_REFERENCIA" com prazo de 3 dias úteis
    Then o processo deve ser devolvido ao "TERMO_REFERENCIA" e a análise deve ficar "DILIGENCE"
    And o prazo da análise jurídica deve ficar pausado com o motivo "LEGAL_DILIGENCE"
    And a caixa de tarefas do responsável pelo TR deve mostrar o selo "Diligência do jurídico"
    When o TR for corrigido e o processo voltar a "JURIDICO"
    Then a mesma análise deve ser retomada em "IN_REVIEW" na rodada 2, sobre as versões novas
    And o painel deve mostrar o que mudou desde a rodada anterior
    And o prazo deve voltar a correr com novo vencimento
```

### J-14 — Aprovação sequencial e por todos
```gherkin
Feature: Aprovação com múltiplos aprovadores

  Scenario: Aprovação sequencial na autorização da licitação
    Given a etapa "AUTORIZACAO_LICITACAO" configurada com política "SEQUENTIAL": 1º secretário de administração, 2º Autoridade
    When o processo chegar à etapa
    Then só a 1ª linha deve ficar "PENDING" e a 2ª "WAITING"
    When o secretário aprovar
    Then a 2ª linha deve passar a "PENDING" e a Autoridade deve ser notificada
    When a Autoridade aprovar
    Then a aprovação deve ser encerrada como aprovada e o processo deve avançar

  Scenario: Aprovação por todos com devolução
    Given um tipo de documento avulso com política "ALL" e três aprovadores
    When um dos aprovadores devolver com comentário
    Then a aprovação deve ser encerrada como devolvida e as linhas pendentes devem ser canceladas
    And os demais aprovadores não devem conseguir decidir ("APPROVAL_LINE_NOT_PENDING")
```

### J-15 — Migração de processos em andamento para a v2
```gherkin
Feature: Migração entre versões de workflow

  Scenario: Planejar, simular, decidir e executar
    Given 20 processos na v1, um deles numa etapa provisória "Jurídico" criada pelo órgão no MVP 1
    When "Marta" (ADMIN_ORGAO, com MFA) planejar a migração para a v2 com o mapa sugerido
    And simular
    Then cada processo deve ser classificado como "AUTOMATIC", "NEEDS_DECISION" ou "BLOCKED" com o motivo
    When "Marta" decidir os processos que exigem decisão e executar a migração
    Then os processos migrados devem continuar na etapa equivalente da v2, com o histórico preservado
    And processos alterados depois da simulação devem ficar "STALE", sem migração
    And o relatório deve listar migrados, excluídos, falhos e defasados
    And a tramitação dos demais processos deve continuar durante a execução

  Scenario: Continuação dos processos concluídos na v1
    Given 2 processos "COMPLETED" na v1
    When "Marta" levá-los à fase preparatória da v2 com destino "DOTACAO"
    Then eles devem reabrir na etapa "DOTACAO" da v2 com justificativa registrada
```

### J-16 — PCA: do plano aprovado à reconciliação e à execução
```gherkin
Feature: Plano de Contratações Anual

  Scenario: Elaborar, aprovar, reconciliar e acompanhar o PCA
    Given o exercício 2027 sem plano
    When o planejamento criar o plano e importar a planilha de 120 linhas
    Then a prévia deve mostrar 116 itens a criar e 4 linhas rejeitadas com linha, coluna e motivo
    When confirmar a importação e enviar o plano para aprovação
    And a Autoridade aprovar o plano na tela de aprovações
    Then o plano deve ficar "APPROVED" na versão 1
    When a reconciliação for executada
    Then os processos do MVP 1 com "pcaYear" e "pcaItemCode" correspondentes devem ficar "LINKED"
    And as referências sem item ou com mais de um candidato devem ficar pendentes para conciliação manual
    When um processo vinculado for concluído
    Then a execução do item deve refletir o processo e o valor contratado
    When o plano for exportado para divulgação
    Then o arquivo não deve conter valores de processos sigilosos
```

### J-17 — Relatórios, gargalos e exportação
```gherkin
Feature: Indicadores em read model próprio

  Scenario: Consultar, detalhar e exportar
    Given o read model reconstruído sobre 12 meses de movimentações
    When o gestor abrir o relatório de tempo de ciclo por secretaria
    Then os números devem coincidir com a consulta de referência sobre o transacional
    And a tela deve mostrar a data de atualização dos dados
    When abrir "Ver processos" num número
    Then deve ver só os processos visíveis para ele, com os demais contados como ocultos
    When abrir os gargalos por etapa
    Then deve ver média, mediana e p90 com o tamanho da amostra
    When exportar o relatório em XLSX
    Then o arquivo deve ficar disponível por 24 horas e a exportação deve ser auditada
```

### J-18 — Backoffice: provisionamento, suporte e ciclo de vida
```gherkin
Feature: Backoffice da plataforma

  Scenario: Provisionar, dar suporte e suspender
    Given um operador da plataforma com MFA
    When provisionar a "Câmara de Vila Nova" com um órgão e o e-mail do administrador
    Then o checklist de provisionamento deve ficar completo e o convite deve ser enviado
    When conceder acesso de suporte de 4 horas com chamado e justificativa
    Then o administrador do órgão deve ver o acesso em "Auditoria › Acessos de suporte"
    And a sessão do operador no órgão deve exibir a faixa de acesso de suporte
    When o administrador encerrar o acesso
    Then a sessão do operador no órgão deve terminar imediatamente
    When o operador suspender a instituição informando o identificador
    Then os usuários do órgão devem perder o acesso com a mensagem de instituição suspensa
    And nenhuma tela do backoffice deve ter exibido dado de processo ou documento
```

### J-19 — Entrada pelo gov.br e vínculo de identidade
```gherkin
Feature: Login gov.br via Authentik

  Scenario: Primeiro acesso e vínculo pelo perfil
    Given o órgão com "auth.govbrEnabled" ligado e "security.govbrCountsAsMfa" igual a "SILVER_OR_GOLD"
    When "Rui" entrar pelo gov.br com nível "SILVER" e o CPF já cadastrado no seu usuário, ainda sem vínculo
    Then a identidade deve ser vinculada por "CPF_MATCH" e "Rui" deve entrar no órgão
    And o nível prata deve valer como segundo fator na política de MFA
    When "Marta" (ADMIN_ORGAO) entrar pelo gov.br com nível "BRONZE" e tentar uma ação que exige MFA
    Then a API deve responder "MFA_REQUIRED" e a tela deve conduzir o step-up normal
    When "Rui" desvincular a conta gov.br no perfil
    Then a próxima entrada pelo gov.br não deve reconhecê-lo e ele deve receber o aviso de segurança
```

### J-20 — Regras, alçadas e SLA em escalonamento
```gherkin
Feature: Regras condicionais e prazos

  Scenario: Alçada por valor e escalonamento do prazo
    Given a regra de alçada "valor estimado > R$ 400.000,00 exige a Autoridade" publicada com casos de teste verdes
    And uma política de SLA com dois degraus de escalonamento para a etapa "JURIDICO"
    When um processo de R$ 520.000,00 chegar à etapa de aprovação
    Then a aprovação deve ser endereçada à Autoridade, com a alçada aplicada visível na decisão
    When a análise jurídica passar do prazo
    Then o primeiro degrau deve notificar o responsável e o segundo, a chefia da Procuradoria
    And o bloco "Prazo" do processo deve mostrar o nível de escalonamento atual
    When "Marta" tentar publicar uma nova versão da regra com um caso de teste vermelho
    Then a publicação deve ser recusada com a lista dos casos que falharam
```

## 3. Consolidação por épico

> Gerado a partir dos cards em `../backlog/` (contagem de cenários `Scenario`/`Scenario Outline` por categoria na seção "Critérios de aceite em Gherkin"). Toda story tem ao menos um cenário em cada uma das 8 categorias — conferido por `pnpm docs:check`.

| Épico | Stories | Sucesso | Validação | Permissão | Tenant incorreto | Duplicidade | Concorrência | Falha de banco | Falha de integração | Total |
|---|---|---|---|---|---|---|---|---|---|---|
| EP-021 Workflow v2 | 9 | 31 | 17 | 10 | 9 | 9 | 14 | 9 | 11 | 110 |
| EP-022 Aprovação múltipla | 6 | 26 | 8 | 7 | 6 | 6 | 6 | 6 | 6 | 71 |
| EP-023 PCA | 8 | 38 | 18 | 10 | 9 | 11 | 14 | 12 | 11 | 123 |
| EP-024 Dotação orçamentária | 3 | 16 | 7 | 6 | 3 | 3 | 7 | 3 | 5 | 50 |
| EP-025 Jurídico | 9 | 46 | 14 | 9 | 9 | 10 | 9 | 10 | 11 | 118 |
| EP-026 Controle Interno | 5 | 22 | 8 | 5 | 5 | 5 | 5 | 5 | 6 | 61 |
| EP-027 Edital | 7 | 59 | 23 | 7 | 7 | 7 | 7 | 7 | 8 | 125 |
| EP-028 Indicadores e gargalos | 8 | 94 | 18 | 13 | 11 | 13 | 18 | 12 | 14 | 193 |
| EP-029 Plataforma e backoffice | 11 | 85 | 35 | 31 | 24 | 26 | 28 | 18 | 27 | 274 |
| EP-030 SLA | 5 | 26 | 5 | 5 | 5 | 5 | 5 | 5 | 6 | 62 |
| EP-031 Regras condicionais | 7 | 35 | 12 | 7 | 7 | 7 | 8 | 7 | 8 | 91 |
| **Total MVP 2** | **78** | **478** | **165** | **110** | **95** | **102** | **121** | **94** | **113** | **1278** |

Leitura: "Tenant incorreto", "Concorrência" e "Falha de integração" têm ao menos um cenário por story mesmo quando a story é só de leitura ou não chama serviço externo — nesses casos o cenário verifica o caminho mínimo (404 para id de outro tenant; recarga sem perda em 412; degradação quando a fila, o gerador de PDF ou o provedor de e-mail falham).

## 4. Índice de critérios por story

> Gerado a partir dos cards. "Lacunas" = itens numerados em "Lacunas nas fontes canônicas" da story (decisões finas que as fontes não fixavam, propostas no próprio card — ver §5).

<!-- INDICE-POR-STORY -->

| Story | Título | Épico | Prior. | Est. | Sucesso | Validação | Permissão | Tenant incorreto | Duplicidade | Concorrência | Falha de banco | Falha de integração | Total | Lacunas |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [US-123](../backlog/story-123-parallel-stages-model.md) | Modelar etapas paralelas no workflow (ramificação e junção) | EP-021 | P0 | L | 2 | 3 | 2 | 1 | 1 | 1 | 1 | 1 | 12 | 0 |
| [US-124](../backlog/story-124-parallel-branches-runtime.md) | Executar ramos paralelos no processo | EP-021 | P0 | L | 5 | 3 | 1 | 1 | 1 | 2 | 1 | 2 | 16 | 0 |
| [US-125](../backlog/story-125-parallel-branches-inbox-cockpit.md) | Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos | EP-021 | P0 | M | 4 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 12 | 0 |
| [US-126](../backlog/story-126-workflow-migration-plan.md) | Planejar a migração de processos: mapeamento de etapas e filtro | EP-021 | P0 | M | 3 | 3 | 1 | 1 | 1 | 2 | 1 | 1 | 13 | 0 |
| [US-127](../backlog/story-127-workflow-migration-simulation.md) | Simular a migração e decidir os processos que exigem decisão | EP-021 | P0 | L | 4 | 2 | 1 | 1 | 1 | 2 | 1 | 1 | 13 | 0 |
| [US-128](../backlog/story-128-workflow-migration-execution.md) | Executar a migração de forma assíncrona, idempotente e auditada | EP-021 | P0 | L | 3 | 2 | 1 | 1 | 1 | 2 | 1 | 2 | 13 | 0 |
| [US-129](../backlog/story-129-rule-context-v2.md) | `RuleContext` v2: contrato versionado e provedores por módulo | EP-021 | P0 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 5 |
| [US-130](../backlog/story-130-default-workflow-v2.md) | Workflow padrão v2 da fase preparatória e oferta de adoção | EP-021 | P0 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 6 |
| [US-131](../backlog/story-131-completed-processes-to-v2.md) | Levar à fase preparatória processos concluídos na v1 | EP-021 | P1 | M | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 | 6 |
| [US-132](../backlog/story-132-stage-decision-policy.md) | Configurar política de decisão e aprovadores ordenados na etapa | EP-022 | P0 | M | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 10 | 5 |
| [US-133](../backlog/story-133-multi-approver-request.md) | Solicitar aprovação com múltiplos aprovadores | EP-022 | P0 | L | 5 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 13 | 5 |
| [US-134](../backlog/story-134-multi-approver-decision.md) | Decidir aprovação múltipla: votos, encerramento e concorrência | EP-022 | P0 | L | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 5 |
| [US-135](../backlog/story-135-approval-line-redirect.md) | Redirecionar linha de aprovação e retirar aprovação múltipla | EP-022 | P0 | M | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 6 |
| [US-136](../backlog/story-136-multi-approval-inbox-views.md) | Aprovação múltipla na caixa de tarefas, na lista e no detalhe da aprovação | EP-022 | P0 | M | 5 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 13 | 4 |
| [US-137](../backlog/story-137-approval-due-date-by-document-type.md) | Prazo da aprovação avulsa por tipo de documento (DT-17) | EP-022 | P1 | S | 5 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 5 |
| [US-138](../backlog/story-138-pca-plan-items.md) | Criar o plano anual e manter os itens do PCA | EP-023 | P1 | L | 5 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 14 | 8 |
| [US-139](../backlog/story-139-pca-spreadsheet-import.md) | Importar itens do PCA por planilha | EP-023 | P1 | M | 3 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 9 |
| [US-140](../backlog/story-140-pca-approval.md) | Enviar o PCA para aprovação e decidir | EP-023 | P1 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 9 |
| [US-141](../backlog/story-141-pca-revision.md) | Revisar o PCA aprovado com nova versão | EP-023 | P1 | M | 3 | 4 | 2 | 2 | 2 | 3 | 2 | 2 | 20 | 9 |
| [US-142](../backlog/story-142-pca-item-linking.md) | Vincular DFD e processo a item do PCA | EP-023 | P1 | M | 8 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 16 | 7 |
| [US-143](../backlog/story-143-pca-reconciliation.md) | Reconciliar as referências textuais ao PCA e conciliar manualmente | EP-023 | P1 | L | 6 | 1 | 1 | 1 | 1 | 2 | 2 | 1 | 15 | 8 |
| [US-144](../backlog/story-144-pca-execution-tracking.md) | Acompanhar a execução do PCA | EP-023 | P1 | M | 5 | 3 | 2 | 1 | 2 | 2 | 2 | 1 | 18 | 7 |
| [US-145](../backlog/story-145-pca-disclosure-export.md) | Exportar o PCA para divulgação | EP-023 | P1 | S | 4 | 3 | 1 | 1 | 2 | 2 | 2 | 3 | 18 | 10 |
| [US-146](../backlog/story-146-budget-allocation-entry.md) | Indicar a dotação orçamentária do processo | EP-024 | P0 | M | 4 | 2 | 2 | 1 | 1 | 2 | 1 | 1 | 14 | 8 |
| [US-147](../backlog/story-147-budget-allocation-confirmation.md) | Confirmar a reserva com evidência e cancelar dotação | EP-024 | P0 | M | 5 | 3 | 2 | 1 | 1 | 3 | 1 | 2 | 18 | 9 |
| [US-148](../backlog/story-148-budget-compatibility-exit-rule.md) | Compatibilidade da dotação com o valor estimado e regra de saída da etapa | EP-024 | P0 | M | 7 | 2 | 2 | 1 | 1 | 2 | 1 | 2 | 18 | 11 |
| [US-149](../backlog/story-149-legal-review-queue.md) | Abrir a análise jurídica e fila priorizada | EP-025 | P0 | L | 5 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 8 |
| [US-150](../backlog/story-150-legal-review-distribution.md) | Distribuir análises na assessoria jurídica | EP-025 | P0 | S | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 10 | 6 |
| [US-151](../backlog/story-151-legal-review-settings.md) | Configurar critérios da fila e hipóteses de dispensa | EP-025 | P0 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 7 |
| [US-152](../backlog/story-152-legal-review-analysis.md) | Conduzir a análise jurídica sobre versões exatas | EP-025 | P0 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 5 |
| [US-153](../backlog/story-153-legal-review-diligence.md) | Pedir diligência e retomar a análise | EP-025 | P0 | L | 7 | 2 | 1 | 1 | 2 | 1 | 2 | 2 | 18 | 8 |
| [US-154](../backlog/story-154-legal-opinion-authoring.md) | Elaborar o parecer jurídico e registrar ressalvas | EP-025 | P0 | M | 8 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 16 | 10 |
| [US-155](../backlog/story-155-legal-review-conclusion.md) | Concluir a análise com a situação conclusiva | EP-025 | P0 | M | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 6 |
| [US-156](../backlog/story-156-legal-review-waiver.md) | Dispensar a análise jurídica por hipótese configurada | EP-025 | P0 | M | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 9 |
| [US-157](../backlog/story-157-ai-draft-legal-opinion.md) | Gerar o rascunho do parecer jurídico com IA | EP-025 | P1 | L | 7 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 16 | 9 |
| [US-158](../backlog/story-158-internal-control-checklists.md) | Gerenciar checklists versionados do Controle Interno | EP-026 | P0 | M | 5 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 14 | 10 |
| [US-159](../backlog/story-159-internal-control-panel.md) | Abrir a manifestação e painel do Controle Interno com visão de riscos | EP-026 | P0 | L | 7 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 15 | 7 |
| [US-160](../backlog/story-160-internal-control-checklist-findings.md) | Responder o checklist e registrar achados e recomendações | EP-026 | P0 | M | 6 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 14 | 5 |
| [US-161](../backlog/story-161-internal-control-conclusion.md) | Emitir a manifestação e concluir com a situação | EP-026 | P0 | M | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 | 4 |
| [US-162](../backlog/story-162-internal-control-findings-follow-up.md) | Acompanhar o atendimento dos achados | EP-026 | P1 | S | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 | 4 |
| [US-163](../backlog/story-163-tender-draft-creation.md) | Criar a minuta do edital com cabeçalho tipado | EP-027 | P0 | M | 10 | 5 | 1 | 1 | 1 | 1 | 1 | 1 | 21 | 13 |
| [US-164](../backlog/story-164-tender-tr-import.md) | Importar itens, critérios e condições do TR para o edital | EP-027 | P0 | M | 7 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 16 | 10 |
| [US-165](../backlog/story-165-tender-lots.md) | Organizar os lotes do edital | EP-027 | P0 | M | 9 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 18 | 10 |
| [US-166](../backlog/story-166-tender-risk-allocation.md) | Matriz de alocação de riscos do edital | EP-027 | P1 | M | 8 | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 18 | 10 |
| [US-167](../backlog/story-167-contract-draft.md) | Elaborar a minuta do contrato | EP-027 | P0 | M | 8 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 16 | 7 |
| [US-168](../backlog/story-168-tender-draft-conclusion.md) | Concluir a minuta do edital | EP-027 | P0 | M | 6 | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 16 | 9 |
| [US-169](../backlog/story-169-ai-draft-tender.md) | Gerar o rascunho do edital com IA | EP-027 | P1 | L | 11 | 2 | 1 | 1 | 1 | 1 | 1 | 2 | 20 | 10 |
| [US-170](../backlog/story-170-analytics-event-projection.md) | Alimentar o read model de indicadores pelos eventos | EP-028 | P1 | L | 12 | 1 | 1 | 1 | 2 | 2 | 2 | 1 | 22 | 9 |
| [US-171](../backlog/story-171-analytics-rebuild-reconciliation.md) | Reconstruir e reconciliar o read model | EP-028 | P1 | M | 10 | 2 | 1 | 1 | 1 | 3 | 3 | 2 | 23 | 8 |
| [US-172](../backlog/story-172-indicator-reports.md) | Relatórios de indicadores | EP-028 | P1 | L | 13 | 3 | 1 | 1 | 1 | 2 | 1 | 1 | 23 | 8 |
| [US-173](../backlog/story-173-detailed-report.md) | Relatório detalhado com detalhamento por processo | EP-028 | P1 | M | 11 | 1 | 1 | 1 | 1 | 2 | 1 | 1 | 19 | 7 |
| [US-174](../backlog/story-174-report-export.md) | Exportar relatórios | EP-028 | P1 | M | 8 | 3 | 4 | 2 | 2 | 3 | 2 | 3 | 27 | 8 |
| [US-175](../backlog/story-175-pca-execution-indicators.md) | Indicadores de execução do PCA | EP-028 | P1 | S | 10 | 2 | 1 | 1 | 2 | 2 | 1 | 1 | 20 | 7 |
| [US-176](../backlog/story-176-bottleneck-analysis.md) | Análise de gargalos por etapa, unidade e responsável | EP-028 | P1 | L | 14 | 2 | 2 | 2 | 2 | 2 | 1 | 3 | 28 | 8 |
| [US-177](../backlog/story-177-queues-aging-period-comparison.md) | Filas, envelhecimento e comparação entre períodos | EP-028 | P1 | M | 16 | 4 | 2 | 2 | 2 | 2 | 1 | 2 | 31 | 8 |
| [US-178](../backlog/story-178-backoffice-tenant-provisioning.md) | Acesso ao backoffice e provisionamento de tenant e órgãos | EP-029 | P1 | L | 7 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 25 | 10 |
| [US-179](../backlog/story-179-backoffice-tenant-lifecycle.md) | Ciclo de vida do tenant no backoffice | EP-029 | P1 | M | 9 | 4 | 2 | 2 | 2 | 3 | 2 | 3 | 27 | 10 |
| [US-180](../backlog/story-180-support-access-grants.md) | Conceder e encerrar acesso de suporte | EP-029 | P1 | M | 12 | 5 | 5 | 3 | 4 | 4 | 2 | 3 | 38 | 13 |
| [US-181](../backlog/story-181-platform-health.md) | Saúde operacional por tenant no backoffice | EP-029 | P1 | M | 15 | 2 | 3 | 3 | 2 | 3 | 2 | 3 | 33 | 12 |
| [US-182](../backlog/story-182-govbr-login.md) | Entrar com gov.br via Authentik | EP-029 | P1 | L | 5 | 4 | 4 | 3 | 3 | 3 | 2 | 5 | 29 | 9 |
| [US-183](../backlog/story-183-govbr-identity-link.md) | Vincular e desvincular a identidade gov.br | EP-029 | P1 | M | 7 | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 27 | 7 |
| [US-184](../backlog/story-184-govbr-tenant-settings.md) | Habilitar o gov.br no órgão e nível de confiança na política de MFA | EP-029 | P1 | S | 8 | 3 | 2 | 2 | 2 | 2 | 1 | 2 | 22 | 6 |
| [US-185](../backlog/story-185-role-reactivation.md) | Reativar perfil desativado (DT-13) | EP-029 | P2 | S | 4 | 3 | 3 | 1 | 1 | 2 | 1 | 2 | 17 | 9 |
| [US-186](../backlog/story-186-audit-seal-break-notification.md) | Notificar a quebra do selo de auditoria (DT-14) | EP-029 | P2 | S | 5 | 1 | 2 | 2 | 2 | 1 | 1 | 2 | 16 | 10 |
| [US-187](../backlog/story-187-template-library-update.md) | Atualizar a biblioteca padrão de templates com adoção assistida (DT-15) | EP-029 | P2 | M | 8 | 4 | 2 | 1 | 3 | 2 | 2 | 1 | 23 | 9 |
| [US-188](../backlog/story-188-inbox-bulk-limit-setting.md) | Limite configurável do lote da caixa de tarefas (DT-16) | EP-029 | P2 | XS | 5 | 3 | 2 | 1 | 2 | 2 | 1 | 1 | 17 | 6 |
| [US-189](../backlog/story-189-sla-policies.md) | Cadastrar políticas de SLA | EP-030 | P1 | L | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 2 | 12 | 7 |
| [US-190](../backlog/story-190-sla-policy-application.md) | Aplicar a política de SLA ao processo e calcular prazos | EP-030 | P1 | M | 7 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 14 | 6 |
| [US-191](../backlog/story-191-sla-pauses.md) | Pausar e retomar prazos | EP-030 | P1 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 6 |
| [US-192](../backlog/story-192-sla-escalation.md) | Escalonar prazos em degraus | EP-030 | P1 | M | 4 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 11 | 7 |
| [US-193](../backlog/story-193-notification-rules.md) | Regras de notificação condicional | EP-030 | P1 | M | 7 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 14 | 8 |
| [US-194](../backlog/story-194-rule-library.md) | Biblioteca de regras reutilizáveis com versões | EP-031 | P1 | L | 6 | 2 | 1 | 1 | 1 | 2 | 1 | 2 | 16 | 6 |
| [US-195](../backlog/story-195-library-rules-in-workflows.md) | Usar regras da biblioteca nos workflows por versão fixada | EP-031 | P1 | M | 5 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 13 | 6 |
| [US-196](../backlog/story-196-rule-templates.md) | Modelos prontos de regras | EP-031 | P1 | S | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 5 |
| [US-197](../backlog/story-197-conditional-routing.md) | Roteamento condicional: etapa dispensada e transição condicional | EP-031 | P1 | L | 5 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 7 |
| [US-198](../backlog/story-198-value-thresholds.md) | Alçadas por valor | EP-031 | P1 | M | 6 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 14 | 7 |
| [US-199](../backlog/story-199-rule-simulator.md) | Simular regras com processo hipotético | EP-031 | P1 | M | 5 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 5 |
| [US-200](../backlog/story-200-rule-test-cases.md) | Casos de teste de regra e bloqueio da publicação | EP-031 | P1 | M | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 12 | 6 |

## 5. O que depende de decisão pendente

Nenhum critério de aceite do MVP 2 está bloqueado por pendência; os itens abaixo têm um **padrão especificado** que vale até a decisão e serão revistos quando ela vier. A mudança, se houver, entra como revisão da story citada (versão 1 revisável — DEC-192).

| Pendência | Padrão especificado até a decisão | Stories e critérios afetados | Quem decide |
|---|---|---|---|
| **PEND-21** — provedor e modelo de IA ([ADR-013](../adr/adr-013-ai-provider.md)) | `FakeAiProvider` no CI; geradores `draft.legal_opinion` e `draft.tender` sobre a camada agnóstica do EP-020; qualidade medida no `pnpm ai:eval` | US-157, US-169 (cenários de sucesso com a proposta real só em staging); metas de 90 s do rascunho | Produto + jurídico + segurança |
| **DEC-196 — ordem das etapas (L-04)** a validar com o jurídico do piloto | `DOTACAO` → `MINUTA_EDITAL` → `JURIDICO` → `CONTROLE_INTERNO` → `AUTORIZACAO_LICITACAO`, configurável por tenant | US-130, US-131 e as jornadas J-12, J-13 e J-15 (a ordem dos passos muda, os critérios não) | Jurídico do piloto |
| **Definições do piloto (roadmap §4.7)** — modelo de parecer, critérios da fila, hipóteses de dispensa, checklist do Controle Interno, calendário do PCA, classificação orçamentária | Padrões semeados e configuráveis ([overview.md §7](overview.md#7-a-validar-com-o-piloto)) | US-138, US-146, US-149, US-151, US-154, US-158 (os cenários testam o padrão semeado e a configuração) | Piloto (UAT do MVP 1) |
| **Homologação do gov.br** (credenciamento do ambiente no Login Único) | IdP fake no CI; botão oculto enquanto o ambiente não estiver credenciado (`auth.govbrEnabled` sem efeito) | US-182, US-183, US-184 e a J-19 em staging | Operação + órgão piloto |
| **PEND-07** — retenção e eliminação (LGPD × arquivo público) | Sem eliminação automática; exportações de relatório expiram em 24 h (arquivo gerado, não registro) | US-145, US-174 | Jurídico |
| **PEND-17** — planos comerciais e limites por tenant | Limites técnicos padrão sem cobrança (inclusive o limite de IA por órgão — DEC-203) | US-157, US-169, US-181 (saúde mostra uso × limite) | Comercial |
| **PEND-03** — reabertura de processo `COMPLETED` | Só pela continuação na v2 (US-131), com justificativa; reabertura genérica continua fora | US-131 | Produto |
| **Lacunas nas fontes canônicas** (549 itens em 72 stories, coluna "Lacunas" do §4) | Cada story propõe o detalhe fino (faixas de valores, códigos de erro de campo, nomes de função, caches) e o registra na seção "Dependências" ou "Impacto técnico" | A própria story; decidir no refinamento da sprint e atualizar a story e o `api/*.md` do módulo | Tech lead + produto |

PEND-12 (edição colaborativa em tempo real) e PEND-16 (registro de publicação) estão **fora** do MVP 2 (DEC-210) e não afetam nenhum critério; PEND-13, PEND-18 e PEND-22 foram resolvidas (DEC-193, DEC-207 e DEC-209/DEC-210).
