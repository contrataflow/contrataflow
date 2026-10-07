# MVP 1 — Critérios de Aceite

> Três níveis de critérios, todos em **Gherkin** (palavras-chave em inglês, texto em pt-BR):
> 1. **Transversais (CA-T)** — valem para **toda** story e são verificados por suítes genéricas (tenant leak, RBAC, contrato de API, auditoria).
> 2. **Jornadas do MVP (J-01…J-10)** — aceite de ponta a ponta do release; correspondem às jornadas E2E de [tests.md](tests.md).
> 3. **Por story** — critérios específicos em cada card de [`../backlog/`](../backlog/README.md) (8 categorias obrigatórias: sucesso, validação, permissão, tenant incorreto, duplicidade, concorrência, falha de banco, falha de integração). Índice na §3.

---

## 1. Critérios transversais (CA-T)

### CA-T-01 — Isolamento entre tenants
```gherkin
Feature: Isolamento total entre tenants

  Background:
    Given os tenants "Prefeitura A" e "Prefeitura B" com dados equivalentes
    And o usuário "Ana" tem vínculo ativo somente com a "Prefeitura A"

  Scenario: Recurso de outro tenant pelo caminho da URL
    When "Ana" requisitar qualquer recurso da "Prefeitura B" pelo seu id (GET, PATCH, PUT, DELETE ou comando POST)
    Then a API deve responder 404 com código "<RESOURCE>_NOT_FOUND" ou "NOT_FOUND"
    And a resposta não deve indicar que o recurso existe em outro tenant
    And nenhum dado da "Prefeitura B" deve ser lido, alterado, auditado ou publicado como evento

  Scenario: Referência a recurso de outro tenant no corpo da requisição
    When "Ana" enviar um corpo que referencia um id da "Prefeitura B"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo correspondente

  Scenario: Listagens e buscas
    When "Ana" listar, buscar, filtrar ou exportar qualquer coleção
    Then nenhum item da "Prefeitura B" deve aparecer, inclusive em contadores, agregados do dashboard e sugestões de autocomplete

  Scenario: Cabeçalho de tenant sem vínculo
    When a requisição de "Ana" chegar com "X-Tenant-Id" da "Prefeitura B"
    Then a API deve responder 403 com código "MEMBERSHIP_INACTIVE"

  Scenario: Defesa em profundidade no banco
    Given uma consulta executada com "app.tenant_id" da "Prefeitura A"
    When ela tentar ler ou gravar linhas da "Prefeitura B", inclusive via SQL bruto
    Then a política de RLS deve impedir a operação

  Scenario: Cache, storage, filas e auditoria
    Then chaves de cache, chaves de objetos no storage, jobs e registros de auditoria devem conter o tenantId correto
    And um job sem tenantId em fila de tenant deve ser rejeitado
```

### CA-T-02 — Autorização
```gherkin
Feature: Autorização granular

  Scenario: Ação sem permissão
    Given que o usuário vê o processo mas não possui a permissão exigida pela ação
    When executar a ação pela API
    Then a API deve responder 403 com o código da permissão ou da política violada (ex.: "PERMISSION_DENIED", "NOT_PROCESS_CUSTODIAN")
    And deve registrar auditoria "access.denied" com reasonCode
    And a interface deve ter ocultado a ação (se o usuário nunca puder executá-la) ou exibido-a desabilitada com o motivo (se a restrição for contextual)

  Scenario: Recurso não visível
    Given que o processo não é visível ao usuário (permissions.md §5)
    When o usuário acessar o processo ou qualquer recurso filho
    Then a API deve responder 404

  Scenario: Permissão de risco alto com MFA exigido
    Given a política "security.mfaPolicy" igual a "ADMINS" e um usuário com perfil que possui permissão de risco alto
    And a sessão sem MFA
    When executar uma ação de risco alto
    Then a API deve responder 403 com código "MFA_REQUIRED"
    And o BFF deve iniciar o step-up e retornar o usuário à ação após o MFA
```

### CA-T-03 — Validação e mensagens
```gherkin
Feature: Validação consistente

  Scenario: Corpo inválido
    When a API receber um corpo que viola o schema Zod
    Then deve responder 422 "application/problem+json" com "code" igual a "VALIDATION_ERROR", "errors[]" por campo e "correlationId"
    And as mensagens "title", "detail" e "errors[].message" devem estar em pt-BR
    And a interface deve destacar os campos, focar o primeiro erro e anunciá-lo a leitores de tela

  Scenario: Regra de negócio violada
    When uma regra de negócio impedir a operação
    Then a API deve responder com o código de domínio documentado em api.md §2.2 e, quando houver regras, "violations[]" com severidade e mensagem configurada
```

### CA-T-04 — Concorrência otimista
```gherkin
Feature: Controle de concorrência

  Scenario: Versão divergente
    Given que o recurso está na versão 7
    When uma alteração for enviada com "If-Match" igual a "6"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e "currentVersion" igual a 7
    And a interface deve oferecer recarregar ou comparar as alterações sem perder o que o usuário digitou

  Scenario: Pré-condição ausente
    When uma alteração em recurso versionado for enviada sem "If-Match"
    Then a API deve responder 428 com código "PRECONDITION_REQUIRED"
```

### CA-T-05 — Idempotência
```gherkin
Feature: Idempotência de criações e comandos

  Scenario: Reenvio idêntico
    Given que uma criação foi processada com "Idempotency-Key" "K1"
    When a mesma requisição for reenviada com "K1" em até 24 horas
    Then a API deve devolver a mesma resposta com "Idempotent-Replayed: true" sem novo efeito

  Scenario: Mesma chave com corpo diferente
    When uma requisição com "K1" e corpo diferente for enviada
    Then a API deve responder 422 com código "IDEMPOTENCY_KEY_REUSED"

  Scenario: Requisição original ainda em processamento
    When a mesma requisição com "K1" chegar enquanto a primeira não terminou
    Then a API deve responder 409 com código "IDEMPOTENCY_IN_PROGRESS"
```

### CA-T-06 — Auditoria e eventos atômicos
```gherkin
Feature: Rastreabilidade

  Scenario: Ação relevante bem-sucedida
    When uma ação mutável for concluída
    Then deve existir um registro de auditoria com ator, ação (events.md §7), entidade, processo, IP, user-agent, correlationId e "changes" com dados sensíveis mascarados
    And os eventos de domínio da ação devem estar no outbox
    And auditoria, outbox, projeções síncronas e a mudança de estado devem ter sido gravados na mesma transação

  Scenario: Ação que falha
    When uma ação mutável falhar em qualquer ponto
    Then nenhuma alteração, auditoria de sucesso, entrada de timeline ou evento deve persistir
```

### CA-T-07 — Falhas de dependências
```gherkin
Feature: Comportamento sob falhas

  Scenario: Dependência crítica indisponível
    Given que o PostgreSQL (ou o Redis de sessões do BFF) está indisponível
    When o usuário executar uma ação
    Then a resposta deve ser 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum estado parcial deve ser persistido
    And a interface deve preservar os dados digitados e exibir mensagem com o correlationId

  Scenario: Dependência não crítica indisponível
    Given que o relay do outbox, a fila, o Gotenberg, o ClamAV, o SMTP ou o cache da API estão indisponíveis
    When o usuário executar uma ação que não depende deles de forma síncrona
    Then a ação principal deve ser concluída
    And o trabalho assíncrono deve ficar pendente e ser processado quando a dependência voltar, sem duplicidade
    And nenhum arquivo deve ser liberado sem verificação antivírus
```

> Observação de arquitetura: sessões do BFF são dependência crítica; recomenda-se Redis em alta disponibilidade (Multi-AZ com failover) e separação lógica entre sessões e cache/filas para que a degradação do cache não derrube sessões.

### CA-T-08 — Orçamento sigiloso
```gherkin
Feature: Mascaramento de valores sigilosos

  Scenario: Usuário sem permissão nem custódia
    Given um processo com "isBudgetConfidential" verdadeiro
    And um usuário sem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" e sem custódia
    When consultar o processo, itens, ETP, pesquisa de preços, TR, dashboard, exportações, PDFs, timeline ou notificações
    Then todo valor estimado deve aparecer como null com o indicador "<campo>Masked" verdadeiro ou estar ausente do artefato
    And documentos com valores devem estar com confidencialidade "RESTRICTED"
```

### CA-T-09 — Sessão, limites e formatos
```gherkin
Feature: Regras gerais de uso

  Scenario: Sessão expirada
    When a sessão expirar por ociosidade ou duração absoluta
    Then a API deve responder 401 "SESSION_EXPIRED"
    And a interface deve exibir o aviso de sessão expirada, preservar rascunhos locais e retornar ao ponto após novo login

  Scenario: Limite de requisições
    When o usuário exceder o limite da classe da rota (api.md §1.6)
    Then a API deve responder 429 "RATE_LIMITED" com "Retry-After" e cabeçalhos "RateLimit-*"

  Scenario: Formatos
    Then datas devem trafegar em ISO 8601 UTC, datas puras em "YYYY-MM-DD", decimais como string
    And a interface deve exibir datas no fuso do tenant e valores em BRL
```

### CA-T-10 — Acessibilidade e responsividade
```gherkin
Feature: Acessibilidade

  Scenario: Telas do MVP 1
    When qualquer tela do MVP 1 for analisada com axe
    Then não deve haver violações sérias ou críticas
    And todas as ações devem ser executáveis por teclado com foco visível
    And a tela deve ser utilizável em 360 px (consulta, caixa, notificações e aprovações) ou exibir aviso de uso recomendado em desktop (edição de documentos)
```

---

## 2. Jornadas de aceite do MVP 1

Personas e dados: tenant "Prefeitura de São José" com o workflow padrão (DEC-015), feriados nacionais semeados e as unidades "Secretaria de Obras" › "Setor de Manutenção", "Secretaria de Administração" › "Departamento de Compras", "Gabinete do Prefeito".

### J-01 — Implantação do órgão
```gherkin
Feature: Implantação de um novo órgão

  Scenario: Do provisionamento ao primeiro acesso dos usuários
    Given um operador da plataforma com "PLATFORM_TENANT_MANAGE"
    When provisionar o tenant "Prefeitura de São José" com o órgão principal e o e-mail do administrador
    Then o tenant deve ser criado com catálogos, perfis, tipos de documento, templates, workflow padrão, feriados e configurações padrão
    And o administrador deve receber o convite por e-mail
    When o administrador aceitar o convite, definir senha e cadastrar MFA
    And cadastrar a estrutura organizacional com titulares e substitutos
    And convidar usuários com perfis e escopos
    Then cada usuário convidado deve conseguir entrar e ver apenas o que seu perfil permite
    And toda a implantação deve estar registrada na auditoria
```

### J-02 — Abertura e formalização da demanda
```gherkin
Feature: Demanda formalizada e aprovada

  Scenario: Requisitante abre o processo e o DFD é aprovado pelo titular da secretaria
    Given "Ana" (REQUISITANTE, lotada no "Setor de Manutenção") e "Carlos" (titular da "Secretaria de Obras")
    When "Ana" criar o processo "Aquisição de cimento para manutenção de vias"
    Then o processo deve receber número, ficar em "DRAFT" na etapa "ABERTURA" sob sua custódia
    And o painel deve indicar o próximo passo "Elabore o DFD"
    When "Ana" elaborar o DFD no wizard com itens, justificativa e vínculo com o PCA, revisar e clicar em "Concluir e enviar para aprovação"
    Then o DFD deve ficar "IN_REVIEW" com versão e hash
    And o processo deve ficar "AWAITING_APPROVAL" na etapa "APROVACAO_DFD"
    And "Carlos" deve receber a notificação "APPROVAL_REQUESTED" e ver a aprovação na caixa de tarefas
    When "Carlos" aprovar
    Then o DFD deve ficar "APPROVED" com PDF carimbado
    And o processo deve seguir para "ESTUDOS_PRELIMINARES" com status "IN_PROGRESS"
    And a timeline e a auditoria devem registrar cada passo
```

### J-03 — Planejamento completo da contratação (até a aprovação da autoridade)
```gherkin
Feature: Planejamento da contratação concluído

  Scenario: ETP, riscos, pesquisa de preços, TR e aprovação da autoridade
    Given o processo da J-02 na etapa "ESTUDOS_PRELIMINARES" com "Paula" (PLANEJAMENTO) como responsável
    When "Paula" criar o ETP importando o DFD, preencher as seções obrigatórias, registrar duas alternativas e recomendar uma
    And registrar 3 riscos com tratamentos e emitir o mapa de riscos
    And concluir o ETP e encaminhar para "PESQUISA_PRECOS"
    Then o processo deve ir para o "Departamento de Compras"
    When "Rui" (COMPRAS) assumir o processo, criar a pesquisa de preços, registrar 4 fontes com cotações, desconsiderar uma cotação excessiva com justificativa e concluir a pesquisa
    Then o valor estimado do processo deve ser atualizado pela pesquisa
    And o ETP vinculado deve refletir o total da pesquisa
    When o processo for encaminhado para "TERMO_REFERENCIA" e "Paula" criar o TR importando o ETP, especificar itens e condições e concluir o TR
    And encaminhar para "APROVACAO_AUTORIDADE"
    Then ETP, mapa de riscos, pesquisa e TR devem estar cobertos pela aprovação da autoridade
    When a "Autoridade" aprovar
    Then todos os documentos cobertos devem ficar "APPROVED"
    And o processo deve ficar "COMPLETED" na etapa "CONCLUSAO"
    And devem ter sido publicados os eventos "ETPApproved", "PriceResearchCompleted", "TermCompleted" e "ProcessCompleted"
```

### J-04 — Devolução e correção
```gherkin
Feature: Devolução para ajustes

  Scenario: Autoridade devolve o TR
    Given o processo na etapa "APROVACAO_AUTORIDADE"
    When a "Autoridade" devolver com o comentário "Ajustar prazo de entrega para 30 dias corridos"
    Then o processo deve voltar à etapa definida pela transição de devolução com status "RETURNED"
    And o responsável anterior deve ser notificado com "PROCESS_RETURNED"
    And o TR deve ficar "RETURNED" e editável
    When o responsável corrigir o TR, concluí-lo e reencaminhar
    Then uma nova aprovação deve ser criada para a nova versão do TR
    And o histórico de tramitação deve mostrar a devolução, o comentário e o reencaminhamento
```

### J-05 — Orçamento sigiloso
```gherkin
Feature: Sigilo do orçamento estimado

  Scenario: Valores visíveis apenas a quem pode vê-los
    Given um processo marcado como orçamento sigiloso pela autoridade
    When "Ana" (REQUISITANTE, sem custódia) abrir o processo, a pesquisa de preços e o dashboard
    Then todos os valores estimados devem estar mascarados
    When "Rui" (COMPRAS, com custódia) abrir a pesquisa
    Then ele deve ver os valores
    And exportações e PDFs gerados para quem não pode ver os valores não devem contê-los
```

### J-06 — Prazos, suspensão e retomada
```gherkin
Feature: Prazos em dias úteis

  Scenario: Prazo com feriado, suspensão e atraso
    Given a etapa "PESQUISA_PRECOS" com SLA de 10 dias úteis e um feriado municipal no período
    When o processo entrar na etapa
    Then o prazo deve desconsiderar fins de semana e o feriado
    And o responsável deve receber "STAGE_DUE_SOON" 2 dias úteis antes do vencimento
    When o gestor suspender o processo por 3 dias úteis e depois retomá-lo
    Then o prazo deve ser estendido em 3 dias úteis
    When o prazo vencer sem tramitação
    Then o processo deve aparecer como atrasado no painel, na lista, na caixa e no dashboard
    And o responsável e o titular da unidade devem receber "STAGE_OVERDUE"
```

### J-07 — Cancelamento
```gherkin
Feature: Cancelamento do processo

  Scenario: Cancelar com aprovação pendente
    Given um processo em "AWAITING_APPROVAL"
    When a "Autoridade" cancelar o processo com justificativa de 30 caracteres
    Then o processo deve ficar "CANCELED" (estado final)
    And a aprovação pendente deve ficar "CANCELED" com motivo "PROCESS_CANCELED"
    And documentos em revisão devem voltar a rascunho com motivo registrado
    And criador, responsável e participantes devem ser notificados
    And nenhuma ação de edição ou tramitação deve estar disponível depois disso
```

### J-08 — Caixa de tarefas e notificações
```gherkin
Feature: O que exige a minha ação

  Scenario: Processo na fila da unidade e aprovação com substituto
    Given o processo encaminhado ao "Departamento de Compras" sem responsável
    Then os membros lotados no departamento com "PROCESS_CLAIM" devem vê-lo em "Na fila da minha unidade" e receber "PROCESS_RECEIVED"
    When "Rui" assumir o processo
    Then o processo deve sair da fila da unidade e aparecer em "Comigo" para "Rui"
    Given uma aprovação para o titular de uma unidade com "allowDeputy" verdadeiro
    Then titular e substituto devem ver a aprovação em "Aprovações pendentes"
    When o substituto decidir
    Then a decisão deve registrar "decidedAsDeputy" verdadeiro e a pendência deve sumir da caixa do titular
```

### J-09 — Auditoria e integridade
```gherkin
Feature: Trilha de auditoria confiável

  Scenario: Consulta, exportação e verificação de integridade
    Given um auditor com "AUDIT_VIEW" e "AUDIT_EXPORT" e sessão com MFA
    When consultar as ações do processo da J-03 nos últimos 30 dias
    Then deve ver todas as ações relevantes com ator, data, IP e alterações mascaradas
    When exportar o resultado em CSV
    Then o arquivo deve conter os registros filtrados, protegido contra injeção de fórmulas, e a exportação deve ser auditada
    When verificar os selos do período
    Then a verificação deve confirmar a integridade
    And qualquer alteração direta em um registro selado (simulada em ambiente de teste) deve ser apontada pela verificação
```

### J-10 — Consultoria externa em mais de um órgão
```gherkin
Feature: Consultor externo com acesso restrito e temporário

  Scenario: Colaboração por participação e troca de órgão
    Given "Eva" com vínculos "EXTERNAL" nos tenants "Prefeitura de São José" e "Câmara de Vila Nova", válidos por 60 dias
    And "Eva" adicionada como "CONSULTANT" no processo da J-03 até uma data definida
    When "Eva" entrar e escolher "Prefeitura de São José"
    Then deve ver somente os processos em que participa
    And deve poder editar o ETP em rascunho e comentar
    But não deve poder encaminhar, aprovar ou ver o orçamento sigiloso
    When "Eva" trocar para "Câmara de Vila Nova"
    Then nenhum dado da prefeitura deve aparecer (inclusive em cache do navegador)
    When a participação expirar
    Then "Eva" deve perder o acesso ao processo automaticamente
```

---

## 3. Índice de critérios por story

> Gerado a partir dos cards em `../backlog/` (contagem de cenários por categoria). Será atualizado a cada revisão do backlog.

<!-- INDICE-POR-STORY -->

| Story | Título | Épico | Prior. | Sucesso | Validação | Permissão | Tenant incorreto | Duplicidade | Concorrência | Falha de banco | Falha de integração | Total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [US-001](../backlog/story-001-create-process.md) | Criar processo de contratação | EP-001 | P0 | 2 | 3 | 2 | 2 | 3 | 2 | 1 | 2 | 17 |
| [US-002](../backlog/story-002-list-search-processes.md) | Listar, pesquisar, filtrar e ordenar processos | EP-001 | P0 | 3 | 1 | 4 | 1 | 1 | 2 | 2 | 2 | 16 |
| [US-003](../backlog/story-003-saved-views-export.md) | Visões salvas e exportação CSV da lista de processos | EP-001 | P2 | 3 | 2 | 2 | 1 | 1 | 2 | 1 | 1 | 13 |
| [US-004](../backlog/story-004-process-cockpit.md) | Visualizar detalhe do processo com painel situacional | EP-001 | P0 | 3 | 1 | 2 | 1 | 1 | 1 | 1 | 2 | 12 |
| [US-005](../backlog/story-005-edit-process.md) | Editar dados do processo | EP-001 | P0 | 3 | 3 | 2 | 1 | 1 | 2 | 1 | 1 | 14 |
| [US-006](../backlog/story-006-process-items.md) | Gerenciar itens da contratação | EP-001 | P0 | 2 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-007](../backlog/story-007-process-tags.md) | Gerenciar etiquetas do processo | EP-001 | P2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-008](../backlog/story-008-suspend-resume-process.md) | Suspender e retomar processo | EP-001 | P1 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-009](../backlog/story-009-cancel-discard-process.md) | Cancelar processo ou descartar rascunho | EP-001 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-010](../backlog/story-010-complete-process.md) | Concluir processo (planejamento da contratação) | EP-001 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-011](../backlog/story-011-duplicate-process.md) | Duplicar processo | EP-001 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-012](../backlog/story-012-process-participants.md) | Gerenciar participantes do processo | EP-001 | P1 | 3 | 1 | 1 | 1 | 2 | 1 | 1 | 1 | 11 |
| [US-013](../backlog/story-013-confidential-budget.md) | Sigilo do orçamento estimado | EP-001 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-014](../backlog/story-014-dfd-wizard.md) | Elaborar DFD em wizard a partir de template | EP-002 | P0 | 4 | 2 | 2 | 1 | 2 | 2 | 1 | 2 | 16 |
| [US-015](../backlog/story-015-dfd-autosave.md) | Editar DFD com autosave, retomada e tratamento de conflito | EP-002 | P0 | 3 | 2 | 2 | 1 | 1 | 2 | 1 | 2 | 14 |
| [US-016](../backlog/story-016-dfd-conclude-forward.md) | Revisar, concluir e enviar o DFD para aprovação | EP-002 | P0 | 2 | 2 | 2 | 1 | 2 | 1 | 1 | 2 | 13 |
| [US-017](../backlog/story-017-dfd-decision-effects.md) | Tratar decisão sobre o DFD e propagar dados ao processo | EP-002 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-018](../backlog/story-018-duplicate-dfd.md) | Duplicar DFD | EP-002 | P2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-019](../backlog/story-019-create-etp.md) | Criar ETP a partir de template com importação do DFD | EP-003 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-020](../backlog/story-020-etp-sections.md) | Editar seções do ETP com autosave e \"não se aplica\" justificado | EP-003 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-021](../backlog/story-021-etp-alternatives.md) | Gerenciar alternativas de solução | EP-003 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-022](../backlog/story-022-etp-estimates.md) | Estimar quantidades e vincular valor à pesquisa de preços | EP-003 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-023](../backlog/story-023-etp-validate-conclude.md) | Validar completude do ETP e concluí-lo | EP-003 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-024](../backlog/story-024-create-price-research.md) | Criar pesquisa de preços a partir dos itens do processo | EP-004 | P0 | 2 | 2 | 2 | 2 | 2 | 2 | 1 | 1 | 14 |
| [US-025](../backlog/story-025-suppliers.md) | Cadastrar e manter fornecedores | EP-004 | P0 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-026](../backlog/story-026-price-sources-quotations.md) | Registrar fontes de pesquisa e cotações | EP-004 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-027](../backlog/story-027-exclude-restore-quotation.md) | Desconsiderar e restaurar cotação com justificativa | EP-004 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-028](../backlog/story-028-import-quotations.md) | Importar cotações por planilha | EP-004 | P2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-029](../backlog/story-029-price-statistics.md) | Calcular estatísticas e valor estimado por item | EP-004 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-030](../backlog/story-030-price-outliers-alerts.md) | Sinalizar outliers e alertas de conformidade | EP-004 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-031](../backlog/story-031-comparative-map.md) | Visualizar e exportar o mapa comparativo | EP-004 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-032](../backlog/story-032-conclude-price-research.md) | Concluir a pesquisa de preços | EP-004 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-033](../backlog/story-033-risk-register.md) | Registrar e avaliar riscos | EP-005 | P0 | 2 | 2 | 1 | 1 | 1 | 2 | 1 | 1 | 11 |
| [US-034](../backlog/story-034-risk-treatments.md) | Gerenciar ações de tratamento de riscos | EP-005 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-035](../backlog/story-035-risk-matrix-document.md) | Visualizar matriz de riscos e emitir o Mapa de Riscos | EP-005 | P1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-036](../backlog/story-036-tr-authoring.md) | Criar TR e editar suas seções | EP-006 | P0 | 2 | 3 | 4 | 1 | 2 | 2 | 1 | 2 | 17 |
| [US-037](../backlog/story-037-tr-import-etp.md) | Importar dados do ETP para o TR | EP-006 | P0 | 1 | 2 | 1 | 1 | 1 | 2 | 1 | 1 | 10 |
| [US-038](../backlog/story-038-tr-items-conditions.md) | Especificar itens e condições contratuais do TR | EP-006 | P0 | 2 | 3 | 1 | 1 | 1 | 1 | 1 | 1 | 11 |
| [US-039](../backlog/story-039-tr-validate-conclude.md) | Validar e concluir o TR | EP-006 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-040](../backlog/story-040-workflow-definition-model.md) | Modelo de definição de workflow versionado | EP-007 | P0 | 4 | 3 | 2 | 1 | 1 | 2 | 2 | 1 | 16 |
| [US-041](../backlog/story-041-workflow-engine.md) | Motor de execução: ações disponíveis e avaliação de regras | EP-007 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-042](../backlog/story-042-default-workflow-applicability.md) | Workflow padrão e seleção por aplicabilidade | EP-007 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-043](../backlog/story-043-workflow-editor.md) | Editor de workflow (etapas e transições) | EP-007 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-044](../backlog/story-044-workflow-rules.md) | Regras de etapa e de transição | EP-007 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-045](../backlog/story-045-workflow-publish-versioning.md) | Publicar, versionar e aposentar workflow | EP-007 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-046](../backlog/story-046-workflow-diagram.md) | Visualizar diagrama do workflow | EP-007 | P2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-047](../backlog/story-047-forward-process.md) | Encaminhar processo | EP-008 | P0 | 3 | 5 | 2 | 1 | 1 | 2 | 1 | 2 | 17 |
| [US-048](../backlog/story-048-return-process.md) | Devolver processo | EP-008 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-049](../backlog/story-049-claim-process.md) | Assumir processo recebido pela unidade | EP-008 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-050](../backlog/story-050-assign-process.md) | Atribuir e reatribuir responsável | EP-008 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-051](../backlog/story-051-request-approval.md) | Solicitar aprovação e resolver o aprovador | EP-008 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-052](../backlog/story-052-decide-approval.md) | Decidir aprovação (aprovar, devolver, indeferir) | EP-008 | P0 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-053](../backlog/story-053-withdraw-reassign-approval.md) | Retirar ou redirecionar aprovação pendente | EP-008 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-054](../backlog/story-054-movement-history.md) | Histórico de tramitações | EP-008 | P0 | 1 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-055](../backlog/story-055-deadlines-overdue.md) | Prazos em dias úteis e detecção de atrasos | EP-008 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-056](../backlog/story-056-task-inbox.md) | Caixa de tarefas unificada | EP-009 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-057](../backlog/story-057-approvals-list.md) | Lista de aprovações | EP-009 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-058](../backlog/story-058-inbox-bulk-actions.md) | Ações em lote na caixa de tarefas | EP-009 | P2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-059](../backlog/story-059-timeline-projection.md) | Projetar eventos do processo na timeline | EP-010 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-060](../backlog/story-060-timeline-view.md) | Visualizar timeline com filtros | EP-010 | P0 | 2 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-061](../backlog/story-061-document-types.md) | Gerenciar tipos de documento | EP-011 | P1 | 3 | 4 | 2 | 1 | 1 | 1 | 1 | 1 | 14 |
| [US-062](../backlog/story-062-process-documents-panel.md) | Painel de documentos do processo | EP-011 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-063](../backlog/story-063-free-text-documents.md) | Criar documento livre a partir de template | EP-011 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-064](../backlog/story-064-uploaded-documents.md) | Incluir documento externo (upload) com versões | EP-011 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-065](../backlog/story-065-document-lifecycle.md) | Ciclo de vida do documento | EP-011 | P0 | 2 | 2 | 2 | 1 | 2 | 2 | 1 | 1 | 13 |
| [US-066](../backlog/story-066-document-versioning.md) | Versionamento imutável e comparação de versões | EP-011 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-067](../backlog/story-067-pdf-generation.md) | Gerar PDF de documentos | EP-011 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-068](../backlog/story-068-secure-upload.md) | Upload seguro de anexos | EP-011 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-069](../backlog/story-069-attachment-download.md) | Visualizar e baixar anexos | EP-011 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-070](../backlog/story-070-editing-presence.md) | Indicador de edição concorrente | EP-011 | P2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-071](../backlog/story-071-comments.md) | Comentar no processo e em documentos | EP-012 | P0 | 3 | 3 | 3 | 1 | 1 | 1 | 1 | 1 | 14 |
| [US-072](../backlog/story-072-mentions.md) | Mencionar usuários e unidades | EP-012 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-073](../backlog/story-073-audit-recording.md) | Registrar auditoria transacional | EP-013 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-074](../backlog/story-074-audit-seal.md) | Selagem de integridade da trilha de auditoria | EP-013 | P1 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-075](../backlog/story-075-audit-query-export.md) | Consultar e exportar a trilha de auditoria | EP-013 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-076](../backlog/story-076-operational-dashboard.md) | Dashboard operacional por perfil | EP-014 | P0 | 2 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 11 |
| [US-077](../backlog/story-077-monorepo-setup.md) | Configurar monorepo e padrões de código | EP-015 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-078](../backlog/story-078-local-environment.md) | Ambiente local com Docker Compose | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-079](../backlog/story-079-ci-pipeline.md) | Pipeline de CI com quality gates | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-080](../backlog/story-080-api-foundation.md) | Esqueleto da API modular | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-081](../backlog/story-081-persistence-prisma.md) | Persistência com Prisma e concorrência otimista | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-082](../backlog/story-082-domain-events-outbox.md) | Eventos de domínio com outbox transacional | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-083](../backlog/story-083-worker-queues.md) | Worker com filas, retries e dead letter | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-084](../backlog/story-084-logging-tracing.md) | Logs estruturados, correlationId e tracing | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-085](../backlog/story-085-health-metrics.md) | Health checks, métricas e dashboards técnicos | EP-015 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-086](../backlog/story-086-web-shell-design-system.md) | Shell da aplicação web, design system e cliente de API | EP-015 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-087](../backlog/story-087-oidc-login-bff.md) | Login OIDC com Authentik e sessão segura no BFF | EP-016 | P0 | 3 | 3 | 2 | 2 | 2 | 1 | 1 | 3 | 17 |
| [US-088](../backlog/story-088-logout-session-expiry.md) | Logout, expiração e renovação de sessão | EP-016 | P0 | 3 | 2 | 1 | 1 | 1 | 2 | 1 | 3 | 14 |
| [US-089](../backlog/story-089-password-recovery.md) | Recuperar senha | EP-016 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-090](../backlog/story-090-mfa-policy.md) | Política de MFA por tenant com step-up | EP-016 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-091](../backlog/story-091-invite-user.md) | Convidar usuário e ativar vínculo | EP-016 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-092](../backlog/story-092-manage-users.md) | Gerenciar usuários e lotações | EP-016 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-093](../backlog/story-093-tenant-switch.md) | Selecionar órgão ativo | EP-016 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-094](../backlog/story-094-permission-catalog-default-roles.md) | Catálogo de permissões e perfis padrão | EP-016 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-095](../backlog/story-095-manage-roles.md) | Gerenciar perfis e matriz de permissões | EP-016 | P0 | 2 | 1 | 2 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-096](../backlog/story-096-assign-roles.md) | Atribuir perfis com escopo e vigência | EP-016 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-097](../backlog/story-097-authorization-enforcement.md) | Autorização na API e no frontend | EP-016 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-098](../backlog/story-098-my-profile.md) | Meu perfil e preferências | EP-016 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-099](../backlog/story-099-tenant-provisioning.md) | Provisionar tenant com dados padrão | EP-017 | P0 | 3 | 2 | 2 | 2 | 2 | 2 | 1 | 2 | 16 |
| [US-100](../backlog/story-100-tenant-isolation.md) | Contexto de tenant e isolamento de dados | EP-017 | P0 | 2 | 2 | 2 | 3 | 1 | 1 | 1 | 2 | 14 |
| [US-101](../backlog/story-101-organizations.md) | Gerenciar órgãos/entidades | EP-017 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-102](../backlog/story-102-departments.md) | Gerenciar secretarias e setores | EP-017 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-103](../backlog/story-103-tenant-settings.md) | Configurações gerais do tenant | EP-017 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-104](../backlog/story-104-catalogs.md) | Catálogos parametrizáveis | EP-017 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-105](../backlog/story-105-numbering.md) | Numeração configurável e segura sob concorrência | EP-017 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-106](../backlog/story-106-business-calendar.md) | Calendário de dias úteis e feriados | EP-017 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-107](../backlog/story-107-template-editor.md) | Criar e editar template de documento | EP-018 | P0 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-108](../backlog/story-108-template-publishing.md) | Publicar versão de template e definir padrão do tipo | EP-018 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-109](../backlog/story-109-print-layout.md) | Layout de impressão (timbre, cabeçalho, rodapé) | EP-018 | P1 | 2 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 10 |
| [US-110](../backlog/story-110-default-template-library.md) | Biblioteca de templates padrão | EP-018 | P0 | 2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 9 |
| [US-111](../backlog/story-111-notification-center.md) | Central de notificações in-app | EP-019 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-112](../backlog/story-112-transactional-emails.md) | E-mails transacionais | EP-019 | P0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-113](../backlog/story-113-notification-preferences.md) | Preferências de notificação | EP-019 | P2 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| [US-114](../backlog/story-114-deadline-reminders.md) | Lembretes de prazo e alertas de atraso | EP-019 | P1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 8 |
| **Total** | 114 stories | | | **194** | **156** | **143** | **120** | **124** | **129** | **116** | **128** | **1110** |
