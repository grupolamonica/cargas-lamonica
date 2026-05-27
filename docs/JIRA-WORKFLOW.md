# JIRA-WORKFLOW.md — Sincronização commit ↔ Jira

> Doc de automação do fluxo commit→Jira do projeto **Cargas Lamonica**.
> Companheiro operacional da issue **DC-101** ("Convenções DC — guia de uso do board"),
> que é a fonte da verdade das convenções de board. Este doc detalha **como o
> `/jira-sync` opera**: configuração, tabela de mapeamento (seção 2) e formato de
> comentário (seção 6.5). Em caso de divergência, **DC-101 prevalece**.
>
> _Reconstruído em 2026-05-27 a partir do DC-101 (o arquivo original não estava
> versionado e foi perdido). Mantenha-o em sincronia com o DC-101._

---

## 1. Configuração

| Campo | Valor |
| --- | --- |
| **Site** | https://gestaolamonica.atlassian.net |
| **cloudId** | `23340e29-68d0-466b-ac89-d20d51306432` |
| **projectKey** | `DC` — Desenvolvimento CargasLamonica |
| **Link de issue** | `https://gestaolamonica.atlassian.net/browse/<KEY>` |
| **Marker de sync** | `.planning/.jira-sync-state.json` (gitignored) |

**Epics ativos:**

| Epic | Escopo | Phase label |
| --- | --- | --- |
| `DC-58` | v1-refactor-arch-docker-vps + features e correções pós-refactor (DC-59..DC-88) | `phase:v1-refactor` |
| `DC-89` | Phase 8 — Cadastro v2 Hardening (subtasks DC-90/91/92) | `phase:v2-cadastro` |
| `DC-100` | Phase 9 — Tech Debt & Escalabilidade (Sprints 1-4, DC-93..DC-98) | `phase:v3-techdebt` |
| `DC-102` | Phase 10 — Cargas Casadas (subtasks DC-103..DC-107) | — |

> A tarefa-âncora do **Cadastro v2** é `DC-65` (Phase 7, concluída); o trabalho
> contínuo de cadastro vive em `DC-89` (hardening) e tarefas-filhas do `DC-58`.

---

## 2. Mapeamento commit → ação Jira

Decida a ação por **tipo de commit** (Conventional Commits) + **escopo**:

| Tipo / situação | Ação no Jira | Alvo |
| --- | --- | --- |
| `feat(...)` — feature coesa em **>1 commit** sem task | **Criar Tarefa** filha do Epic da phase | Epic da phase (ex.: DC-58) |
| `feat(...)` — incremento de feature já com task | **Comentário** | Task existente da feature |
| `fix(...)` — defeito em comportamento já entregue | **Comentário** (ou **Bug** se ainda sem task) | Task/Bug correspondente |
| `fix(...)` — **hotfix em produção** | **Criar Bug** + label `hotfix` | Filho do Epic da phase atual |
| `refactor(...)` isolado | **Criar Tarefa** com título `Refactor — …` | Epic relevante |
| `perf(...)` / `test(...)` / `build(...)` / `ci(...)` | **Comentário** | Task relacionada |
| `chore(...)` / `docs(...)` | **Comentário** (ou Tarefa `Chore — …` se coeso) | Task relacionada / Epic |
| Commit de **merge** (`Merge pull request …`) | **Skip** — o(s) commit(s) de conteúdo do PR já são sincronizados individualmente | — |

**Escopo → área (label `area:*`):**

| Escopo do commit | Label de área |
| --- | --- |
| `candidatura`, `cadastro`, `cadastro-v2`, `motorista` (wizard) | `area:cadastro` |
| `driver`, `driver-portal` | `area:driver-portal` |
| `operator`, `operador`, `painel` | `area:operator-admin` |
| `backend`, `api` | `area:backend` |
| `deploy`, `ci`, `docker`, `traefik`, `vps` | `area:infra` |
| `angellira`, `aspx`, `supabase`, `infosimples`, `antt` | `area:integration` |
| `auth`, `rls`, `lgpd`, `security` | `area:security` |

> **Regra de mapeamento ambíguo:** se o commit não casar claramente com uma task
> existente, **pergunte ao usuário** (Passo 4 do `/jira-sync`) em vez de adivinhar.
> Nunca crie duplicata — sempre `searchJiraIssuesUsingJql` antes de criar.

---

## 3. Hierarquia e tipos de issue

```
Epic (phase do roadmap / objetivo de longo prazo)
  └─ Tarefa | História | Bug   (entrega rastreável — sempre com parent)
       └─ Subtask              (passo interno de uma entrega)
```

- **Epic** — grande objetivo (ex.: "Phase 8 — Cadastro v2 Hardening").
- **Tarefa** — unidade de trabalho rastreável; sempre tem `parent` (Epic).
- **História** — funcionalidade na ótica do usuário.
- **Bug** — defeito em comportamento já entregue.
- **Subtask** — decomposição interna de uma Tarefa.
- ~~Função~~ — legado v0, não usar (preferir Tarefa).

---

## 4. Status flow + transition IDs

| Status | Quando usar | `transitionId` |
| --- | --- | --- |
| **Backlog** | Ideia capturada, não priorizada | `11` |
| **A fazer** | Priorizada, pronta para pegar | `21` |
| **Fazendo** | Em execução ativa | `31` |
| **Em validação** | Código pronto, aguardando review/QA/deploy | `41` |
| **Concluído** | Mergeado em `main` **+ deploy + smoke test ok em prod** | `51` |

**Regra de ouro:** só transicione para **Concluído** (`51`) após **deploy + smoke
test em produção**. PR mergeado **não** é suficiente. O `/jira-sync` nunca
transiciona para Concluído antes do merge em `main`.

---

## 5. Labels (taxonomia obrigatória)

Toda issue deve ter **≥1 label de área** (`area:*`) **+ exatamente 1 label de phase**
(`phase:*`). Ver seção 2 para o mapeamento escopo→área.

**Phases (mutuamente exclusivas):**

- `phase:v0-mvp` — MVP inicial (DC-1..DC-57, encerrado)
- `phase:v1-refactor` — Refactor + Docker + VPS (DC-58..DC-88, encerrado)
- `phase:v2-cadastro` — Cadastro v2 automático (DC-65, DC-89..DC-92)
- `phase:v3-techdebt` — Tech debt Sprints 1-4 (DC-93..DC-98)

---

## 6. Procedimento de sincronização (`/jira-sync`)

### 6.1 — Descobrir commits não sincronizados

Ler `last_synced_commit` de `.planning/.jira-sync-state.json` e:

```bash
git log <last_synced_commit>..HEAD --pretty=format:"%h|%ad|%an|%s" --date=short
```

### 6.2 — Detectar phase atual

Precedência: branch (`gsd/phase-N-*`) → `.planning/STATE.md` campo `**Phase:**` →
escopo dos commits (ex.: `feat(candidatura|cadastro):` → phase v2-cadastro / DC-89).

### 6.3 — Classificar cada commit

Aplicar a **tabela da seção 2**. Decidir: comentário em task existente (caso comum),
nova Tarefa/Subtask (iniciativa coesa >1 commit) ou novo Bug (hotfix de produção).

### 6.4 — Confirmar plano com o usuário

**ANTES de executar**, apresentar a tabela `Commit | Subject | Ação | Task alvo` e
aguardar confirmação. Ajustar e reconfirmar se pedido.

### 6.5 — Formato de comentário

```markdown
**Commit `<hash-curto>`** (branch `<branch>`)

`<subject>`

<1-2 linhas de resumo técnico — o "porquê", nunca o diff completo>
```

Para múltiplos commits de uma mesma entrega, agrupe num único comentário com uma
linha por commit, mantendo o resumo técnico curto.

### 6.6 — Atualizar o marker

Escrever `.planning/.jira-sync-state.json`:

```json
{
  "last_synced_commit": "<hash HEAD>",
  "last_synced_at": "<ISO timestamp>",
  "last_synced_by": "<git user email>"
}
```

`.planning/` inteiro já está em `.gitignore`.

---

## 7. Anti-padrões

- ❌ Issue sem `parent` (exceto Epics).
- ❌ Status **Concluído** sem PR mergeado em `main` (+ deploy + smoke test).
- ❌ Diff completo no comentário — só resumo técnico (1-2 linhas).
- ❌ Issue sem assignee em "Fazendo" / "Em validação".
- ❌ Duplicatas — sempre `searchJiraIssuesUsingJql` antes de criar.
- ❌ Credenciais, tokens, env vars ou paths sensíveis em descrições/comentários.

---

## 8. Tools MCP (Atlassian)

Prefixo: `mcp__2795e83d-b29f-47fe-8fdc-77495efadd8b__`

| Tool | Uso |
| --- | --- |
| `searchJiraIssuesUsingJql` | Buscar antes de criar (anti-duplicata) |
| `getJiraIssue` | Ler detalhes/estado de uma issue |
| `addCommentToJiraIssue` | Comentar (formato 6.5) |
| `createJiraIssue` | Nova Tarefa/Subtask/Bug (sempre com `parent`) |
| `transitionJiraIssue` | Mover status (`31` Fazendo, `41` Em validação, `51` Concluído) |
| `getTransitionsForJiraIssue` | Confirmar transições disponíveis numa issue |

---

## 9. Referência rápida

- **Convenções de board (fonte da verdade):** issue `DC-101` (pinada).
- **Título de issue:** `<Categoria> — <Resumo curto>` (ex.: `Feature — Cadastro avulso`).
- **Slash command:** `/jira-sync` no Claude Code (`--dry-run`, `--since <hash>`, `--task <KEY>`).

_Última atualização: 2026-05-27 — reconstruído a partir do DC-101._
