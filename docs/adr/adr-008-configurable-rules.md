# ADR-008 — Regras parametrizáveis com JSON Logic

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-016, DEC-018 |
| **Documentos** | [entities.md §5.4, §5.5](../mvp-01/entities.md) · [story-041](../backlog/story-041-workflow-engine.md) · [story-044](../backlog/story-044-workflow-rules.md) |

## Contexto
- A Lei 14.133/2021 e a política interna de cada órgão impõem condições para avançar um processo — documento obrigatório num status mínimo, campo obrigatório preenchido, aprovação prévia obrigatória e condições mais específicas (ex.: elementos obrigatórios do ETP, art. 18 §§ 1º e 2º) — e essas condições variam por tenant, por versão de workflow e mudam com o tempo.
- Embutir essas verificações em código exigiria um *deploy* para cada regra nova ou específica de um tenant, e impediria que analistas de processo/jurídico configurassem ou testassem uma regra sem depender de desenvolvimento.
- As regras precisam ser avaliadas com segurança sobre dados reais do processo (documentos, itens, pesquisa de preços, riscos) sem jamais expor acesso direto ao banco ou executar código arbitrário — um motor de condições configurável, não uma sandbox de *script*.
- É preciso distinguir regras que **bloqueiam** uma ação de regras que apenas **avisam** (com reconhecimento explícito, já que a prática do setor público às vezes exige seguir adiante com uma exceção documentada), e tornar o resultado explicável ao usuário (por que a ação está desabilitada) e testável por quem a configura, antes de publicar a versão do workflow.

## Decisão
1. `WorkflowRule` como entidade única de configuração: `type` ∈ {`REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION`}, `severity` ∈ {`BLOCKING`, `WARNING`} (padrão `BLOCKING`), `scope` ∈ {`STAGE_EXIT`, `TRANSITION`} vinculado a exatamente uma etapa ou uma transição de uma única `WorkflowVersion`, mensagem ao usuário (até 500 caracteres), `isActive` e `displayOrder`.
2. `config` tem formato próprio por tipo (entities.md §5.5): `REQUIRED_DOCUMENT` → `{ documentTypeCode, minStatus ∈ EXISTS|COMPLETE|SUBMITTED|FINAL|APPROVED (DEC-018), minCount? }`; `REQUIRED_FIELD` → `{ field: caminho no RuleContext }`; `REQUIRED_APPROVAL` → `{ stageKey }`; `CONDITION` → `{ expression: JSON Logic }`.
3. Condições (`CONDITION` e `Workflow.applicabilityRule`) são expressões **JSON Logic** (`json-logic-js`), avaliadas sobre um `RuleContext` v1 versionado e somente leitura (`process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*`, `items.*`, `now` — entities.md §5.4); só os caminhos declarados nesse schema são válidos; o executor restringe os operadores a uma *allowlist* explícita e nunca avalia código arbitrário nem acessa o banco diretamente.
4. `evaluateRules` (`WorkflowFacade`, US-041) é o único avaliador, somente leitura, para os quatro tipos, usado em `getAvailableActions`: falhas `BLOCKING` desabilitam a ação correspondente e expõem a `message` de cada regra em `reasons[]`; falhas `WARNING` nunca desabilitam a ação, só alimentam um checklist — seguir adiante exige `acknowledgedWarnings[]` explícito no comando, registrado em `ProcessMovement.metadata` e `AuditLog.metadata` como evidência para o Controle Interno.
5. Regras de exigência legal (ex.: elementos obrigatórios do ETP, art. 18 §§ 1º-2º) são **configuração semeada** (linhas de `WorkflowRule` na versão padrão publicada), não código — o mesmo mecanismo que o tenant usa para suas próprias regras.
6. Autoria restrita a uma `WorkflowVersion` em `DRAFT` (criar/editar/excluir regra só nesse estado, reaproveitando o mesmo bloqueio usado para etapas/transições); a publicação valida os caminhos de `REQUIRED_FIELD` contra o schema vigente do `RuleContext` (`WF_RULE_PATH_UNKNOWN` se desconhecido), já que o rascunho pode referenciar caminhos temporariamente inválidos.
7. "Testar regra" (`WF-23`): avalia uma `config` informada (salva ou não) contra o `RuleContext` construído a partir de um processo real e visível (`PROCESS_VIEW`) ao usuário, de forma somente leitura — nunca cria ou altera `WorkflowRule`, `ProcessMovement` ou auditoria de domínio, dando a quem configura um ciclo seguro de teste antes de publicar.

## Alternativas consideradas
| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **Regras embutidas em código** (uma condição por regra na aplicação) | Poder total da linguagem; fácil testar isoladamente; sem interpretador para proteger | Toda regra nova ou específica de tenant exige mudança de código, revisão e *deploy*; sem autoatendimento de autoria nem "testar regra" para quem não desenvolve | **Rejeitada:** incompatível com workflow configurável e autoria *self-service*, propósito central da DEC-016 |
| **DSL própria** (gramática/parser customizado para condições) | Pode ser talhada exatamente ao formato do `RuleContext` | A equipe passaria a manter parser, avaliador, mensagens de erro e modelo de segurança do zero, sem ecossistema de ferramentas | **Rejeitada:** reinventa o que o JSON Logic já oferece como formato de expressão compacto, nativo em JSON e fácil de restringir |
| **CEL ou Rego** (Common Expression Language / Open Policy Agent) | Mais expressivos (laços/agregações no CEL; linguagem de política completa no Rego); usados em infraestrutura de ponta | *Runtimes* mais pesados para embarcar numa stack Node/NestJS (*bindings* WASM/CGO) para uma necessidade de "condições booleanas simples sobre um contexto plano"; curva de aprendizado maior para quem configura/lê as regras | **Rejeitada no MVP 1:** expressões JSON Logic são mais simples de armazenar, versionar, exibir e restringir do que embarcar um *runtime* CEL/Rego; revisitar só se a expressividade necessária superar o JSON Logic |

## Consequências
**Positivas**
- Condição nova ou específica de tenant é configuração pura (semeada ou autorada pela UI), sem *deploy* — inclusive as regras de exigência legal do ETP.
- "Testar regra" dá retorno imediato e seguro contra dados reais do processo antes de publicar, reduzindo erro de configuração chegando a workflows em produção.
- Um único avaliador (`evaluateRules`) e um único contexto versionado (`RuleContextV1`) sustentam os quatro tipos de regra e a aplicabilidade de workflow, mantendo o modelo mental pequeno.
- `WARNING` + `acknowledgedWarnings[]` dá ao responsável do processo uma válvula de escape documentada e auditada, em vez de um bloqueio rígido para regras mais leves.

**Negativas**
- `RuleContext` v1 é uma superfície fechada e versionada — qualquer campo que uma regra precise e o contexto não exponha exige nova versão de contexto (schema + migração das `config` existentes), não só um ajuste pontual.
- A *allowlist* de operadores do JSON Logic é deliberadamente limitada — lógica de negócio genuinamente complexa e multietapas não é expressável e exige um novo `type` nativo (código), não uma expressão `CONDITION`.
- É possível salvar uma regra `DRAFT` referenciando um caminho inexistente no `RuleContext` (só detectado na publicação, `WF_RULE_PATH_UNKNOWN`) — o erro aparece mais tarde do que na edição.
- Testar uma regra (`WF-23`) ainda depende de `PROCESS_VIEW` sobre um processo real; quem configura sem um processo representativo à mão precisa localizar um para validar.

## Riscos e mitigação
| Risco | Mitigação |
|---|---|
| Brecha na *allowlist* de operadores permitindo uma expressão JSON Logic cara ou insegura | *Allowlist* fixa revisada em *code review* a cada adição; mesmo executor reaproveitado pela avaliação em runtime e pelo *dry-run* de "testar regra" |
| Deriva de versão do `RuleContext` (regra escrita contra caminhos da v1 após uma v2 entrar) | Versões antigas de contexto seguem legíveis; validação de publicação fixada à versão de contexto da `WorkflowVersion`; passo de migração explícito para a próxima versão |
| Regra `BLOCKING` mal configurada contra um documento legalmente exigido, bloqueando processos do tenant inteiro | Prévia de impacto antes de desativar/alterar um tipo (RN-DOC-09) e validação `WF_RULE_PATH_UNKNOWN` na publicação capturam a maioria dos casos antes de `PUBLISHED` |
| Crescimento silencioso de reconhecimentos de `WARNING` mascarando uma lacuna sistêmica de conformidade | `acknowledgedWarnings[]` registrado em `AuditLog.metadata` dá ao Controle Interno uma trilha consultável para revisar padrões |

## Critérios de revisão
- Necessidade real de lógica multietapas/iterativa (laços, agregações sobre muitos documentos) que a *allowlist* do JSON Logic não expresse → avaliar um `RuleType` nativo (código) ou revisitar CEL/Rego para essa classe específica de regra.
- `RuleContext` crescer o suficiente (campos de vários MVPs) para um schema plano versionado se tornar difícil de manter → revisitar sua estrutura/estratégia de versionamento.
- Tenants demandarem autoria além dos quatro tipos fixos (ex.: severidade condicional, grupos de condições) → revisitar o formato de `WorkflowRule` antes de estender `config` por tipo.
- Desempenho de `evaluateRules` degradar com o crescimento de `RuleContext`/volume de documentos → revisitar o custo de montagem do contexto (*cache*, avaliação parcial) antes do motor em si.

## Referências
- DEC-016, DEC-018 — [decisions.md](../architecture/decisions.md).
- [entities.md](../mvp-01/entities.md) §5.4 (`RuleContext` v1), §5.5 (`WorkflowRule.config` por tipo).
- Stories: [US-041](../backlog/story-041-workflow-engine.md) (RN-WF-23…33, motor `evaluateRules`), [US-044](../backlog/story-044-workflow-rules.md) (RN-WF-53…60, CRUD de regra e `WF-23` "Testar regra").
