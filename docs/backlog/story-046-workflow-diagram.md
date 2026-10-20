---
id: US-046
title: "Visualizar diagrama do workflow"
epic: EP-007
feature: FT-030
mvp: 1
priority: P2
estimate: M
status: Especificada
depends_on: [US-043]
modules: [workflow]
screens: [SCR-034]
endpoints: [WF-09, WF-07]
permissions: [WORKFLOW_VIEW]
events: []
---

# US-046 — Visualizar diagrama do workflow

## Título
Visualizar diagrama do workflow

## Descrição
**Como** administrador do órgão ou gestor de contratações, **quero** ver o workflow desenhado como um diagrama de etapas e transições, **para** entender rapidamente o fluxo completo sem ler a lista de etapas e transições uma a uma.

A aba "Diagrama" do editor (SCR-034) renderiza, somente leitura, o grafo da `WorkflowVersion` selecionada — etapas como nós e transições como arestas — num quadro próprio com zoom, pan, seleção e minimapa e com o layout calculado automaticamente por um layout hierárquico em camadas próprio (o React Flow e o elkjs previstos não entraram — dependências novas fora do catálogo, RN-FND-11, decisão de 2026-10-16, a mesma do `ConditionBuilder` da US-044). Nenhuma posição é persistida: o diagrama é recalculado a cada carregamento a partir da estrutura de etapas e transições.

## Contexto
- O editor (US-043) já apresenta etapas e transições em tabela e painel lateral; para workflows com muitas etapas (ex.: o segundo workflow semeado, contratação direta — DEC-015) uma visão gráfica ajuda a entender ciclos de devolução e aprovações mais rápido do que a lista.
- `WorkflowStage`/`WorkflowTransition` (entities.md §4) não têm campos de posição (x/y); por isso o layout é sempre automático, nunca editável manualmente — mantém a story simples e somente leitura, sem risco de desenhos "quebrados" por edição manual.
- Reaproveita a mesma leitura (`WF-09`) já usada pelo editor (US-043) e pela validação (US-045) para montar o grafo.

## Objetivo
Permitir que qualquer usuário com `WORKFLOW_VIEW` visualize o diagrama de qualquer versão do workflow (rascunho, publicada ou aposentada) em até 2 segundos para workflows de até 30 etapas, sem possibilidade de alterar dados a partir da visualização.

## Persona
- **Principal:** Administrador do órgão e Gestor de contratações (`WORKFLOW_VIEW`/`WORKFLOW_MANAGE`).
- **Secundárias:** demais perfis com `WORKFLOW_VIEW` (Planejamento, Compras, Licitações, Controle Interno, Autoridade competente, Auditor).

## Pré-condições
- Existe ao menos uma `WorkflowVersion` com etapas (qualquer status: `DRAFT`, `PUBLISHED` ou `RETIRED`).
- Usuário com `WORKFLOW_VIEW`.

## Fluxo principal
1. No editor do workflow (SCR-034), o usuário abre a aba **"Diagrama"**.
2. O front chama `GET /api/v1/workflow-versions/{versionId}` (`WF-09`), que traz etapas e transições da versão selecionada (a corrente, por padrão).
3. O front monta o grafo (nós = etapas, arestas = transições) e calcula as posições (layout hierárquico em camadas da esquerda para a direita, conforme as transições de avanço; desempate por `displayOrder`; devoluções desenhadas por baixo).
4. O diagrama renderiza os nós (cor de `WorkflowStage.color`, ícone por `StageType`, nome e SLA) e as arestas (rótulo da transição, destaque para `isPrimary`).
5. O usuário pode aplicar zoom, arrastar o canvas (pan) e clicar em um nó/aresta para ver os detalhes (mesmos dados do painel lateral de US-043), sem poder editá-los.
6. Para comparar versões, o usuário troca a versão selecionada (lista de `WF-07`, US-045); o diagrama é recalculado para a versão escolhida.

## Fluxos alternativos
- **FA-01 — Workflow com etapa inalcançável:** etapas sem transição de entrada a partir do `START`, ou sem saída até um `END`, são destacadas com contorno de aviso (mesmo critério de `WF_STAGE_UNREACHABLE`/`WF_END_UNREACHABLE`, US-040/US-045), sem impedir a visualização.
- **FA-02 — Workflow grande:** acima de 20 etapas, o diagrama abre com zoom ajustado ("fit view") e oferece minimapa para navegação.
- **FA-03 — Versão aposentada:** o diagrama é exibido normalmente, com um aviso "Esta versão está aposentada" no topo.
- **FA-04 — Layout automático falha:** se o layout automático não puder ser calculado (grafo malformado — ex.: transição apontando para etapa ausente), o front cai para uma lista simples de etapas e transições com aviso "Não foi possível desenhar o diagrama; veja a lista abaixo", sem travar a tela.

## Regras de negócio
- **RN-WF-70** — O diagrama é somente leitura: nenhuma ação de criar, editar ou excluir etapa, transição ou regra está disponível a partir dele (essas ações continuam exclusivamente em US-043/US-044).
- **RN-WF-71** — O diagrama consome `WF-09` (etapas e transições da versão) e, para trocar de versão, `WF-07`; nenhuma posição x/y é persistida — o layout é recalculado em runtime, no navegador, a cada carregamento.
- **RN-WF-72** — Cada nó representa uma `WorkflowStage` (cor de `color`, ícone de `type`, nome, `groupLabel` quando preenchido); cada aresta representa uma `WorkflowTransition` (rótulo de `name`, destaque visual quando `isPrimary = true`); etapas `APPROVAL` exibem um indicador distinto de `TASK`/`START`/`END`.
- **RN-WF-73** — O diagrama está disponível para `WorkflowVersion` em qualquer `status` (`DRAFT`, `PUBLISHED`, `RETIRED`), respeitando apenas `WORKFLOW_VIEW` — não exige `WORKFLOW_MANAGE`.
- **RN-WF-74** — Etapas inalcançáveis a partir da etapa `START` ou sem transição de saída até uma etapa `END` são destacadas visualmente como aviso (mesma lógica de `WF_STAGE_UNREACHABLE`/`WF_END_UNREACHABLE`), sem bloquear a renderização.
- **RN-WF-75** — Falha do cálculo automático de layout não impede a consulta: o front exibe a lista de etapas/transições como alternativa (FA-04).

## Campos
Nota: esta story não tem formulário de entrada; a tabela documenta os dados exibidos no diagrama.

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nó (etapa) | `key`, `name`, `type`, `color`, `groupLabel` | composto | — | RN-WF-72 | `WorkflowStage` |
| Aresta (transição) | `key`, `name`, `action`, `isPrimary` | composto | — | RN-WF-72 | `WorkflowTransition` |
| Versão exibida | `versionNumber`, `status` | seleção | Sim | RN-WF-73 | corrente por padrão |
| Aviso de etapa inalcançável | — | indicador visual | Não | RN-WF-74 | calculado no front |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Versão inexistente ou de outro tenant | API | — (404 silencioso) | `NOT_FOUND` |
| V-02 | Sem `WORKFLOW_VIEW` | API | "Você não tem permissão para ver este workflow." | `PERMISSION_DENIED` |
| V-03 | Layout automático falha no front | Front | "Não foi possível desenhar o diagrama; veja a lista abaixo." | — (sem código de API; tratamento de UI) |

## Permissões
- **Permissão:** `WORKFLOW_VIEW`.
- **Políticas:** nenhuma política contextual adicional.
- **MFA:** não exigido (`WORKFLOW_VIEW` é risco `L`).
- **Sem permissão:** aba "Diagrama" oculta; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum; consulta somente leitura |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visualizar diagrama do workflow

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o workflow "Fase preparatória — Lei 14.133/2021" com 7 etapas publicadas
    And o usuário "Elisa" possui "WORKFLOW_VIEW"

  Scenario: [Sucesso] Visualizar o diagrama da versão publicada
    When "Elisa" abrir a aba "Diagrama" do workflow
    Then o sistema deve exibir 7 nós e as transições entre eles
    And a etapa "CONCLUSAO" deve aparecer como nó do tipo "END"

  Scenario: [Validação] Workflow sem nenhuma etapa
    Given que a versão "DRAFT" de um novo workflow ainda não tem etapas
    When "Elisa" abrir a aba "Diagrama"
    Then o sistema deve exibir o estado vazio "Nenhuma etapa criada ainda"

  Scenario: [Permissão] Usuário sem WORKFLOW_VIEW
    Given que "Fábio" não possui "WORKFLOW_VIEW"
    When "Fábio" acessar a rota do editor de workflow
    Then a aba "Diagrama" não deve ser exibida
    And a API deve responder 403 com código "PERMISSION_DENIED" se chamada diretamente

  Scenario: [Tenant incorreto] Acessar versão de outro tenant
    When "Elisa", autenticada na "Prefeitura de São José", requisitar o diagrama de uma "workflowVersionId" da "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And a resposta não deve revelar que a versão existe em outro tenant

  Scenario: [Duplicidade] Selecionar a mesma versão duas vezes não duplica nós
    Given que "Elisa" já está vendo o diagrama da versão 1
    When "Elisa" selecionar a versão 1 novamente no seletor de versões
    Then o diagrama deve continuar mostrando exatamente 7 nós, sem duplicar etapas

  Scenario: [Concorrência] Diagrama consultado durante edição simultânea
    Given que "Carla" está salvando uma nova etapa na versão "DRAFT" no momento em que "Elisa" abre o diagrama
    When a consulta de "Elisa" (`WF-09`) for executada
    Then ela deve retornar um snapshot consistente (antes ou depois da etapa de "Carla", nunca parcial)

  Scenario: [Falha de banco] Banco indisponível ao carregar o diagrama
    Given que o banco de dados fica indisponível
    When "Elisa" abrir a aba "Diagrama"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o front deve exibir "Não foi possível carregar o diagrama agora. Tente novamente." com botão de nova tentativa

  Scenario: [Falha de integração] Cálculo automático de layout falha no navegador
    Given que o grafo da versão tem uma estrutura que o layout automático não consegue organizar
    When "Elisa" abrir a aba "Diagrama"
    Then o front deve exibir a lista simples de etapas e transições
    And deve registrar um log de aviso no console sem travar a tela
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Versão inexistente/outro tenant | 404 | `NOT_FOUND` | "Workflow não encontrado." | Volta para a lista |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para ver este workflow." | Aba oculta |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar o diagrama agora. Tente novamente." | Botão "Tentar novamente" |
| Falha de layout no front | — | — | "Não foi possível desenhar o diagrama; veja a lista abaixo." | Alterna para lista (FA-04) |

## Dependências
- **Stories:** US-043 (fonte das etapas/transições exibidas); US-045 (seletor de versões via `WF-07`); US-040 (modelo e critérios de alcançabilidade reaproveitados visualmente).
- **Decisões/ADRs:** DEC-014.
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Sem persistência de posição, qualquer mudança futura para edição visual (arrastar etapas) exigirá nova modelagem (campos x/y) — fora do escopo desta story.
- O layout roda no cliente; grafos muito grandes (> 100 nós, fora do cenário atual do produto) podem exigir mover o cálculo para o servidor — não necessário no MVP 1.
- Reaproveita o mesmo payload de `WF-09` já consumido por US-043/US-045; nenhuma mudança de contrato de API é necessária.
- O cenário de Concorrência exigiu uma correção na leitura do WF-09 (sem mudança de contrato): em `READ COMMITTED` cada SELECT vê o seu instante, então o rascunho é lido conferindo `WorkflowVersion.version` antes e depois da definição e refeito (até 3 vezes) se mudou — ver api/10-workflow.md, WF-09.

## Backend
- **Módulo(s):** `workflow` (reaproveita `WF-07`/`WF-09` existentes; só a leitura consistente do WF-09 — Impacto técnico).
- **Casos de uso:** nenhum novo (reaproveita `GetWorkflowVersionQuery`, `ListWorkflowVersionsQuery`).
- **Domínio:** nenhuma mudança de domínio.
- **Integrações internas:** nenhuma.
- **Transação:** nenhuma (somente leitura).

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`), aba "Diagrama".
- **Componentes:** `WorkflowDiagram` (quadro com zoom/pan/minimapa), `useDiagramLayout` (hook do layout em camadas), `StageNode`, `TransitionEdge`, `VersionSwitcher` (reaproveita `WF-07`), `DiagramFallbackList`.
- **Estados:** skeleton enquanto `WF-09` carrega; vazio ("Nenhuma etapa criada ainda"); erro com "Tentar novamente"; fallback de lista (FA-04).
- **Acessibilidade e responsividade:** nós e arestas com `aria-label` descritivo; navegação por teclado entre nós (tab); em telas < 768 px, zoom inicial ajustado e minimapa oculto por padrão.

## Banco de dados
- **Tabelas:** nenhuma nova; leitura de `workflow_versions`, `workflow_stages`, `workflow_transitions` (já usadas por `WF-09`).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita os de US-040.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-09 | GET | `/api/v1/workflow-versions/{versionId}` | — | `200 { data: WorkflowVersion }` com `stages[]`/`transitions[]` | 200, 403, 404 |
| WF-07 | GET | `/api/v1/workflows/{id}/versions` | — | `200 { data: WorkflowVersion[] }` (para o seletor) | 200, 403, 404 |

## Logs
- `info` `workflow.diagram_viewed` — `workflowVersionId`, quantidade de nós/arestas, `durationMs`.
- `warn` `workflow.diagram_layout_failed` — quando o layout falha no cliente (log de front no console — sem instrumentação de browser no MVP 1, observability.md §4; `apps/web/src/lib/client-log.ts` é o ponto único a trocar quando houver coletor).
- **Nunca logar:** nenhum dado sensível (story somente leitura de estrutura de workflow).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Nenhuma: visualização não gera auditoria (mesmo padrão de leituras simples, ex.: US-041) |

## Testes necessários
- **Unitários:** mapeamento de `WorkflowStage`/`WorkflowTransition` para nós/arestas; detecção de etapa inalcançável (RN-WF-74) no front.
- **Integração (Testcontainers):** `WF-09` retorna snapshot consistente mesmo com escrita concorrente (teste de isolamento de transação).
- **Concorrência:** leitura durante escrita simultânea não retorna estado parcial.
- **API/contrato:** nenhuma mudança de contrato (reaproveita `WF-07`/`WF-09`); teste de regressão garante compatibilidade.
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` ausente → 403; versão de outro tenant → 404.
- **E2E (Playwright):** abrir diagrama, trocar de versão, abrir detalhe de um nó, confirmar ausência de ações de edição.
- **Acessibilidade/performance:** axe no canvas (labels/`aria`); diagrama de 30 etapas renderiza em < 2 s (p95).

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste (confirmando ausência deles, conforme esperado)
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI inalterado e compatível com api.md (nenhum endpoint novo)
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — sem mudanças de backend (reaproveita `WF-07`/`WF-09`), mas o layout automático, a interação do quadro (zoom, pan, minimapa) e os estados de fallback exigem trabalho de frontend não trivial.

## Prioridade
**P2** — melhora o entendimento do fluxo, mas o editor em tabela (US-043) já é suficiente para configurar e operar o workflow sem o diagrama.
