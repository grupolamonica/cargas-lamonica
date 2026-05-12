# GitHub Rulesets — Lamonica Cargas

Rulesets declarativos que implementam as proteções da [§9 do CONTRIBUTING.md](../../CONTRIBUTING.md#9-proteções-obrigatórias-no-github).

## Arquivos

| Arquivo                  | Cobertura                                                    |
|--------------------------|--------------------------------------------------------------|
| `main-protection.json`   | Regras de proteção da branch `main` (default branch)          |

## Aplicar via `gh api`

> **Pré-requisitos:**
> 1. `gh auth status` autenticado com permissão **admin** no repo.
> 2. PAT vazado em `git remote -v` **já revogado** e remote refeito sem token.
> 3. Workflow CI (`.github/workflows/ci.yml`) já mergeado em `main` — o status check `Lint + Typecheck + Test + Build` precisa existir antes de virar required check, caso contrário PRs ficam bloqueados indefinidamente.

### Criar (primeira vez)

```bash
gh api \
  --method POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  /repos/antoniocesar-dev/cargas-lamonica/rulesets \
  --input .github/rulesets/main-protection.json
```

### Listar rulesets existentes

```bash
gh api /repos/antoniocesar-dev/cargas-lamonica/rulesets
```

### Atualizar (após editar o JSON)

```bash
# 1. Pegar o ID do ruleset
RULESET_ID=$(gh api /repos/antoniocesar-dev/cargas-lamonica/rulesets \
  --jq '.[] | select(.name=="main-protection") | .id')

# 2. Atualizar
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/antoniocesar-dev/cargas-lamonica/rulesets/${RULESET_ID}" \
  --input .github/rulesets/main-protection.json
```

### Remover

```bash
RULESET_ID=$(gh api /repos/antoniocesar-dev/cargas-lamonica/rulesets \
  --jq '.[] | select(.name=="main-protection") | .id')

gh api \
  --method DELETE \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "/repos/antoniocesar-dev/cargas-lamonica/rulesets/${RULESET_ID}"
```

## Cobertura do `main-protection.json` vs. CONTRIBUTING §9

| Item §9                                          | Coberto |
|--------------------------------------------------|---------|
| Require pull request before merging              | ✅ (rule `pull_request`)        |
| Require approvals (min 1)                        | ✅ (`required_approving_review_count: 1`) |
| Require review from Code Owners                  | ✅ (`require_code_owner_review: true`)    |
| Dismiss stale approvals on new commits           | ✅ (`dismiss_stale_reviews_on_push: true`) |
| Require conversation resolution                  | ✅ (`required_review_thread_resolution: true`) |
| Require status checks                            | ✅ (rule `required_status_checks`)        |
| Require branches up to date before merging       | ✅ (`strict_required_status_checks_policy: true`) |
| Require linear history                           | ✅ (rule `required_linear_history`)       |
| Block force pushes                               | ✅ (rule `non_fast_forward`)              |
| Block deletions                                  | ✅ (rule `deletion`)                      |
| Squash-only merge (mantém histórico limpo)       | ✅ (`allowed_merge_methods: ["squash"]`)  |

## Mudanças futuras

Para mais checks obrigatórios (ex.: security scan, dependency audit), adicionar entradas em `required_status_checks` no JSON e rodar o `gh api ... PUT` acima.

## Caveats

- **GitHub Free** suporta rulesets em repos públicos e (com limites) em privados pessoais. Em alguns planos, certos campos (`bypass_actors`, etc.) podem ser ignorados.
- O `context` do status check **deve casar exatamente** com o nome do job no workflow (`Lint + Typecheck + Test + Build` em `.github/workflows/ci.yml`). Se renomear o job, atualizar este JSON.
- Após aplicar, **abra um PR de teste** para validar que o gate funciona antes de confiar nele em produção.
