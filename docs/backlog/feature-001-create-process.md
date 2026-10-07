---
id: FT-001
title: "Criar processo"
epic: EP-001
mvp: 1
priority: P0
stories: [US-001]
status: Especificada
---

# FT-001 — Criar processo

## Título
Criar processo

## Épico
EP-001 — Processo de contratação

## Descrição
Abertura do processo de contratação por um wizard de três passos (Identificação → Origem e planejamento → Revisão), que cria — em uma única transação — o processo em `DRAFT`, atribui número (conforme a configuração), fixa a versão do workflow aplicável, posiciona a etapa inicial sob custódia do criador, concede a visibilidade inicial e registra tramitação, timeline, auditoria e evento. É a porta de entrada de todo o produto: nenhuma jornada de negócio do MVP 1 existe sem um processo criado.

## Valor para o usuário e para o órgão
- Elimina numeração manual e duplicidade: todo processo nasce com número único (ou assume `assignOn = START`) e passa por verificação de duplicidade.
- Dá, desde o primeiro minuto, responsável claro, workflow definido e orientação do próximo passo.
- Reduz o tempo de abertura de uma demanda para menos de 2 minutos.

## Personas
- Área requisitante (`REQUISITANTE`) — abre a maior parte das demandas.
- Gestor de contratações (`GESTOR_CONTRATACOES`), Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`), Gestor de contrato (`GESTOR_CONTRATO`) — também criam processos, conforme a matriz de permissões.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-001 | Criar processo de contratação | P0 | L | US-042, US-059, US-073, US-082, US-097, US-102, US-104, US-105 |

## Escopo
- Wizard de 3 passos (Identificação → Origem e planejamento → Revisão).
- Numeração transacional, resolução de workflow, verificação de duplicidade, concessões iniciais de acesso.

## Fora de escopo
- Edição posterior dos dados e dos itens — FT-004.
- Duplicação de processo existente — FT-006.
- Definição do workflow em si (EP-007) e dos catálogos/numeração (EP-017) — apenas consumidos aqui.

## Regras de negócio da feature
- RN-PROC-01 a RN-PROC-18 (US-001): obrigatoriedade de campos, subárvore de unidades, numeração (DEC-028), resolução de workflow (DEC-014/DEC-015), heurística de duplicidade, transação única (DEC-161) e ausência de notificação na criação.

## Telas
- SCR-005 — Novo processo, wizard (`/processos/novo`)
- SCR-006 — Detalhe do processo, destino após a criação (`/processos/[id]`)

## Endpoints
- PRC-02 `POST /processes` — cria o processo
- PRC-03 `POST /processes/check-duplicates` — verificação de duplicidade
- WF-06 `POST /workflows/resolve` — resolução do workflow aplicável
- CAT-01, DEP-01, ORG-01, ME-01 — leituras de apoio (catálogos, unidades, órgãos, vínculo do usuário)

## Entidades
- `Process` — agregado criado
- `ProcessStage`, `ProcessAssignment`, `ProcessMovement` — runtime da etapa inicial e tramitação de abertura
- `ProcessAccess` — concessões iniciais de visibilidade

## Eventos
- `ProcessCreated` — ao confirmar a criação, na mesma transação

## Permissões
- `PROCESS_CREATE` — com escopo que cubra a unidade solicitante

## Dependências
- Stories de fundação: US-042 (workflow padrão), US-059 (timeline), US-073 (auditoria), US-082 (outbox), US-097 (autorização), US-102 (unidades), US-104 (catálogos), US-105 (numeração).
- Decisões: DEC-010, DEC-013, DEC-014, DEC-015, DEC-024, DEC-028, DEC-029, DEC-032, DEC-055, DEC-105, DEC-161.

## Critérios de aceite da feature
```gherkin
Feature: Criar processo
  Scenario: Jornada completa de abertura de um processo
    Given que "Ana" está autenticada e tem "PROCESS_CREATE" para o "Setor de Manutenção"
    When ela percorrer o wizard com título, objeto, tipo de contratação, origem e situação no PCA válidos
    And confirmar "Criar processo"
    Then um processo "DRAFT" deve ser criado com número, workflow fixado e etapa inicial sob sua custódia
    And ela deve ser levada ao painel do processo com o próximo passo indicado
```

## Métricas de sucesso
- 100% dos processos criados com número único (quando `assignOn = CREATE`), workflow fixado, etapa inicial e evento publicado.
- Tempo de criação < 2 minutos; p95 do comando < 600 ms.

## Riscos
- Contenção na sequência de numeração sob carga — mitigado por transações curtas e bloqueio de linha (RP-04).
- Falsos positivos na duplicidade — mitigado por limiar e janela configuráveis.

## Definition of Done da feature
- [ ] US-001 concluída e aceita (única story da feature)
- [ ] Jornada E2E (wizard → painel) automatizada
- [ ] Documentação atualizada
