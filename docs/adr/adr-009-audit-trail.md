# ADR-009 — Auditoria transacional append-only com selagem periódica

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto, Controle Interno (consultado) |
| **Decisões relacionadas** | DEC-025, DEC-084, DEC-085, DEC-138, DEC-161 |
| **Documentos** | [security.md](../architecture/security.md) §12–§13 · [events.md](../mvp-01/events.md) §7 · [observability.md](../architecture/observability.md) (A21) · [decisions.md](../architecture/decisions.md) |

## Contexto

- O ContrataFlow opera sob a Lei 14.133/2021, a Lei de Acesso à Informação (Lei 12.527/2011), a Lei de Arquivos Públicos (Lei 8.159/1991) e a LGPD. A auditoria não é um log técnico: é evidência de conformidade e segurança com **valor probatório** (security.md §1) — precisa resistir a questionamento de órgãos de controle.
- A auditoria **não é** a timeline do processo (DEC-025): a timeline é narrativa curada para o usuário; a auditoria cobre **toda** ação relevante, inclusive negadas, acessos, exportações e mudanças de configuração, com ator, IP, user-agent e diff antes/depois.
- Risco central: um registro de auditoria **alterável** (por bug, por privilégio de banco de um operador, ou por ataque) não tem valor probatório. É preciso tornar a adulteração **detectável**, não apenas "improvável por convenção".
- Volume e ruído: todo endpoint mutável precisa de ao menos uma ação de auditoria mapeada (RN-AUD-09), incluindo ações de alta frequência (ex. autosave) e ações potencialmente abusivas (`access.denied` sob força bruta) — sem que o volume torne o armazenamento inviável nem esconda o sinal real.
- A escrita não pode ficar dissociada da ação de negócio: perder um registro de auditoria por falha assíncrona (como o outbox trata eventos de domínio — ADR-004) é inaceitável aqui.

## Decisão

1. **Escrita síncrona na mesma transação:** `AuditService.record` recebe o cliente de transação (`tx`) já aberto pelo caso de uso e grava nele — nunca abre transação própria (DEC-161, RN-AUD-01). Falha na gravação do `AuditLog` desfaz toda a transação de negócio: ação e auditoria são atômicas.
2. **Append-only por trigger:** a tabela `audit_logs` só aceita `INSERT`/`SELECT` — trigger e privilégios de banco bloqueiam `UPDATE`/`DELETE` (security.md §13). Não é uma convenção de aplicação; é imposto pelo banco.
3. **Hash por registro:** `rowHash` = SHA-256 do JSON canonicalizado (RFC 8785/JCS, mesma técnica de DEC-084) de todos os campos do registro exceto o próprio `rowHash`; calculado uma única vez, antes do `INSERT`, nunca recalculado (RN-AUD-08).
4. **Selagem periódica encadeada:** job `audit-seal` gera, por tenant e período (cadência horária), um `AuditSeal` com `digest` = SHA-256 dos `rowHash` ordenados do período e `chainHash` = SHA-256(`chainHash` anterior ∥ `digest`) — cada selo depende do anterior (security.md §12–§13).
5. **Continuidade sem registro vazio:** períodos sem nenhum `AuditLog` não geram selo; o próximo selo não vazio referencia o `chainHash` do último selo existente, preservando a cadeia mesmo com lacunas (RN-AUD-12). Selagem é idempotente por `(tenant_id, period_start)` (RN-AUD-13).
6. **A própria selagem não se autorreferencia:** a ação `audit.seal` é registrada no período **seguinte** ao selado, nunca no período sendo selado — evita mover o alvo do hash depois de calculado (RN-AUD-14).
7. **Verificação:** `POST /audit/seals/verify` (AUD-05) recalcula, selo a selo e em ordem, `digest` a partir dos `rowHash` atuais e `chainHash` a partir do selo anterior; qualquer divergência marca o selo `INVALID` e identifica se a quebra é em `digest` (linha alterada/inserida/removida) ou em `chainHash` (selo anterior alterado/ausente); a primeira quebra é reportada como `brokenAtPeriodStart` (RN-AUD-15, RN-AUD-16).
8. **Catálogo fechado de ações** em [events.md §7](../mvp-01/events.md): toda ação negada por autorização grava `access.denied` (RN-AUD-10); contenção de rajadas limita a até 20 registros por `(tenant, usuário ou IP, ação)` a cada 60 s (parâmetros de **plataforma**, não do tenant), somando o excedente em `metadata.suppressedCount` do próximo registro (RN-AUD-07). Ações de alta frequência mas legítimas (ex. `document.draft_update`) são coalescidas (1 por documento/seção/usuário a cada 10 min).
9. **Mascaramento de conteúdo:** `changes` só registra campos efetivamente alterados; campos sensíveis (`cpf`, tokens, senha) são mascarados/omitidos (DEC-138); texto rico e textos longos são reduzidos a `{ hash, length }` — nunca o conteúdo integral (RN-AUD-03).
10. **Retenção técnica:** partição mensal por `occurred_at` (DEC-085); política de retenção de negócio ainda pendente (PEND-07).
11. **Leitura e exportação são elas próprias auditadas:** `AUDIT_VIEW` (busca, janela máx. 90 dias) e `AUDIT_EXPORT` (CSV/NDJSON, limite 100 mil linhas, escape contra CSV injection) são permissões de risco alto, exigem MFA (POL-14) e geram `audit.search`/`audit.export` no próprio `AuditLog` (RN-AUD-17 a RN-AUD-23).
12. **Observabilidade dedicada:** alerta A21 dispara se não houver selo novo em mais de 3 h (Alto) ou se uma verificação falhar (Crítico).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **Log de aplicação / ELK** como trilha de auditoria | Ferramentas maduras de busca e visualização; operação conhecida | Escrita dissociada da transação de negócio (mesmo problema de escrita dupla do ADR-004); sem atomicidade; mutável, sem selagem nativa | **Rejeitada:** sem valor probatório — perder ou dessincronizar um registro é inaceitável |
| **CDC/Debezium** sobre as tabelas de negócio | Desacoplado da aplicação; captura mudanças mesmo fora dos casos de uso | Não captura ator/intenção/resultado de negócio (ex. motivo de uma negação); granularidade de linha, não de ação de domínio; complexidade operacional adicional | **Rejeitada:** a semântica de auditoria (ator, ação, resultado) só existe na camada de aplicação |
| **Tabela mutável com soft delete** (padrão DEC-083) | Simples; mesmo padrão de outras entidades; permite correção de registros | Qualquer linha "corrigível" por privilégio de banco anula o valor probatório; sem trigger, adulteração não deixa rastro | **Rejeitada:** auditoria exige imutabilidade real, não apenas convenção de aplicação |
| **Hash por registro sem selagem encadeada** | Mais simples; menor custo computacional | Não prova **completude**: não detecta a remoção de uma linha inteira do conjunto, só a alteração de uma linha existente | **Insuficiente:** o `chainHash` por período é o que garante que nada foi removido, não apenas que nada foi alterado |

## Consequências

**Positivas**
- Evidência com valor probatório real, verificável sob demanda, sem depender de confiança no operador do banco.
- Atomicidade entre ação e auditoria: nunca existe efeito de negócio sem o registro correspondente.
- Adulteração é **detectável e localizável** (período e tipo de quebra), não apenas "improvável".
- Contenção de ruído sem perda de sinal (`suppressedCount` preserva a contagem mesmo sob supressão).
- A própria auditoria é auditável (quem consultou, quem exportou).

**Negativas**
- Escrita extra síncrona em toda transação de negócio: falha do `AuditService` derruba a ação de negócio (acoplamento de disponibilidade).
- Crescimento monotônico de `audit_logs`; partição mensal ajuda, mas a política de retenção ainda não está definida (PEND-07).
- Custo de CPU do job horário de selagem e do recálculo completo em uma verificação de intervalo longo.
- Trigger de bloqueio de `UPDATE`/`DELETE` é mais um objeto de infraestrutura para versionar e migrar com cuidado.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Falha do `AuditService` deriva em indisponibilidade da ação de negócio | Cobertura de teste dedicada; disponibilidade do banco já monitorada (A22) |
| Selagem atrasada ou parada | A21 alerta sem selo novo por > 3 h |
| Selo marcado `INVALID` em produção | Runbook RB-09 (a criar) + resposta a incidentes de security.md |
| Ruído de `access.denied` sob força bruta/varredura | Amostragem por janela (RN-AUD-07) com `suppressedCount` |
| Dado sensível vazando em `changes`/`metadata` | Mascaramento obrigatório (DEC-138); revisão de contrato em PRs que adicionam metadata |
| Retenção indefinida aumenta custo e exposição | Revisar ao fechar PEND-07 |

## Critérios de revisão
- Definição da política de retenção (PEND-07) — pode exigir arquivamento frio com preservação dos selos.
- Volume real exceder a capacidade do job de selagem horário ou do particionamento mensal.
- Exigência de valor probatório mais forte que hash encadeado interno (ex. *timestamping* por terceiro).
- Incidente real de adulteração ou achado de auditoria externa (Controle Interno/TCU) que exija trilha mais rígida (ex. WORM storage).

## Referências
- DEC-025, DEC-084, DEC-085, DEC-138, DEC-161 — [decisions.md](../architecture/decisions.md).
- [security.md](../architecture/security.md) §12 (hash de documentos e integridade) e §13 (auditoria).
- [events.md](../mvp-01/events.md) §7 (catálogo de ações de auditoria).
- [observability.md](../architecture/observability.md) (alerta A21).
- US-073 — `story-073-audit-recording.md` (RN-AUD-01 a RN-AUD-10).
- US-074 — `story-074-audit-seal.md` (RN-AUD-12 a RN-AUD-16).
- US-075 — `story-075-audit-query-export.md` (RN-AUD-17 a RN-AUD-23).
