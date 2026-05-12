# CONTRIBUTING — Lamonica Cargas

> **Este documento é a norma oficial de engenharia do projeto.**
> Toda contribuição (humana ou via Claude Code) deve seguir este fluxo.
> Última atualização: 2026-05-12.

---

## 1. Princípio central

A equipe trabalha com um modelo próximo de **Trunk-Based Development / GitHub Flow profissionalizado**:

- `main` sempre representa código **estável, revisado, testado e potencialmente pronto para produção**.
- Fluxo base: criar branch curta → desenvolver → abrir Pull Request → passar por CI/revisão → merge → liberar via pipeline.
- Evite features grandes abertas por muitos dias. Quebre em entregas pequenas, atrás de **feature flags** quando necessário.

---

## 2. Estrutura oficial de branches

### Branch principal

```
main
```

**Uso:**
- Código estável.
- Base para produção.
- Nunca recebe push direto.
- Toda alteração entra via Pull Request.

**Regras:**
- Protegida.
- Sem push direto.
- Sem force push.
- Sem delete.
- Exigir PR.
- Exigir CI passando.
- Exigir review.
- Exigir histórico linear.
- Exigir resolução de comentários.

### Branches de feature

```
feature/<ticket>-<descricao-curta>
```

**Exemplos:**
```
feature/123-cadastro-motorista
feature/248-integracao-pancary
feature/301-dashboard-operacional
```

**Uso:**
- Nova funcionalidade.
- Alteração incremental.
- Nasce a partir da `main` atualizada.
- Deve durar pouco tempo.

**Criação:**
```bash
git checkout main
git pull origin main
git checkout -b feature/123-cadastro-motorista
```

### Branches de bugfix

```
fix/<ticket>-<descricao-curta>
```

**Exemplos:**
```
fix/411-validacao-cpf
fix/422-timeout-api-rastreador
```

**Uso:** correções de bugs encontrados em desenvolvimento, homologação ou produção.

### Branches de hotfix

```
hotfix/<ticket>-<descricao-curta>
```

**Exemplos:**
```
hotfix/901-corrigir-login-producao
hotfix/902-falha-calculo-frete
```

**Uso:**
- Correção urgente em produção.
- Nasce da `main`.
- Vai para PR com prioridade máxima.
- Depois do merge, gera nova versão/tag.

```bash
git checkout main
git pull origin main
git checkout -b hotfix/901-corrigir-login-producao
```

### Branches de release (opcional)

```
release/v1.4.0
```

Use apenas se a equipe precisar congelar uma versão para QA/homologação antes da produção.

**Aceita:**
- Correções críticas.
- Ajustes de versão.
- Ajustes de changelog.
- Correções de deploy.

**Não aceita:**
- Features novas.
- Refatorações grandes.
- Mudanças arquiteturais.

---

## 3. Padrão de commits — Conventional Commits

Formato oficial:

```
<tipo>[escopo opcional]: <descrição>
```

### Tipos permitidos

| Tipo       | Uso                                              |
|------------|--------------------------------------------------|
| `feat`     | nova funcionalidade                              |
| `fix`      | correção de bug                                  |
| `refactor` | refatoração sem mudar comportamento              |
| `perf`     | melhoria de performance                          |
| `test`     | criação ou ajuste de testes                     |
| `docs`     | documentação                                     |
| `style`    | formatação sem alteração lógica                  |
| `build`    | build, dependências, empacotamento               |
| `ci`       | pipelines, GitHub Actions, automações            |
| `chore`    | tarefas internas sem impacto funcional           |
| `revert`   | reversão de commit                               |

### Exemplos bons

```bash
git commit -m "feat(driver): adicionar cadastro por pendências"
git commit -m "fix(auth): corrigir expiração do token de sessão"
git commit -m "refactor(vehicle): separar validação de placa em service"
git commit -m "test(driver): cobrir fluxo de cadastro incompleto"
git commit -m "ci(release): adicionar deploy automático para staging"
```

### Exemplos ruins (proibidos)

```bash
git commit -m "ajustes"
git commit -m "correção"
git commit -m "subindo coisas"
git commit -m "teste"
git commit -m "final"
```

Esses commits não explicam intenção, não ajudam code review, não ajudam rollback e deixam o histórico inútil.

---

## 4. Como separar commits corretamente

Cada commit deve representar **uma mudança lógica**.

> **Regra sênior:** um commit deve responder *"qual decisão técnica ou mudança funcional foi feita aqui?"*

**Exemplo ruim:**
```
feat: cadastro completo motorista cavalo carreta proprietario layout api testes ajustes finais
```

**Exemplo bom:**
```
feat(driver): criar etapa de dados pessoais
feat(vehicle): adicionar cadastro do cavalo
feat(owner): adicionar cadastro do proprietário do cavalo
feat(trailer): permitir múltiplas carretas
test(driver): adicionar testes do fluxo de pendências
```

**Separe commits por:**
- Domínio
- Intenção
- Tipo de alteração
- Risco
- Facilidade de rollback

---

## 5. Fluxo diário do desenvolvedor

### Antes de começar

```bash
git checkout main
git pull origin main
git checkout -b feature/123-nome-da-feature
```

### Durante o desenvolvimento

```bash
git status
git add caminho/do/arquivo
git commit -m "feat(scope): descrição clara"
```

### Antes de abrir PR

```bash
git checkout main
git pull origin main
git checkout feature/123-nome-da-feature
git rebase main
```

Rodar localmente:

```bash
npm run lint
npm run test
npm run build
```

ou, conforme stack:

```bash
bun run lint
bun test
bun run build
```

### Subir branch

```bash
git push origin feature/123-nome-da-feature
```

Se houve rebase:

```bash
git push --force-with-lease
```

> Use `--force-with-lease`, **nunca** `--force`. Reduz o risco de sobrescrever trabalho remoto de outra pessoa.

---

## 6. Pull Request profissional

Todo PR deve ter **escopo pequeno** e **objetivo claro**.

### Título do PR

Use o mesmo padrão de Conventional Commits:

```
feat(driver): cadastro automático por pendências
fix(auth): corrigir renovação de sessão
refactor(order): separar regras de cálculo do service
```

### Template de PR

O template oficial está em [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) e é aplicado automaticamente.

---

## 7. Política de review

### Regra mínima

- Todo PR precisa de **pelo menos 1 aprovação**.
- PRs críticos precisam de **2 aprovações**.
- PRs de **segurança, pagamento, autenticação, permissões, deploy ou banco** precisam de revisão sênior obrigatória.

### CODEOWNERS

Definidos em [`.github/CODEOWNERS`](.github/CODEOWNERS). Exemplo:

```
# Backend
/backend/src/modules/auth/        @grupolamonica/backend-senior
/backend/src/modules/billing/     @grupolamonica/backend-senior
/backend/src/modules/fiscal/      @grupolamonica/backend-senior

# Frontend
/frontend/src/pages/              @grupolamonica/frontend
/frontend/src/components/         @grupolamonica/frontend

# Infra
/.github/workflows/               @grupolamonica/devops
/docker-compose.yml               @grupolamonica/devops
/traefik/                         @grupolamonica/devops
```

### O que revisar

- Regra de negócio está correta?
- Existe código desnecessário?
- Existe duplicação?
- Existe risco de segurança?
- Existe impacto em performance?
- Existe teste suficiente?
- O nome das funções/classes comunica intenção?
- O PR está pequeno o suficiente?
- Existe risco de quebrar produção?

---

## 8. Estratégia de merge

**Recomendação principal: `Squash and merge`.**

**Vantagens:**
- Histórico da `main` limpo.
- Um PR vira um commit final.
- Reversão fica mais simples.
- Evita poluição com commits intermediários.

**Commit final do squash** (configurado em Conventional Commit):

```
feat(driver): adicionar cadastro automático por pendências (#123)
```

---

## 9. Proteções obrigatórias no GitHub

Configurar em `Settings > Branches` ou via **Rulesets**.

### Para `main`

- Require a pull request before merging
- Require approvals: mínimo 1
- Require review from Code Owners
- Dismiss stale approvals when new commits are pushed
- Require conversation resolution before merging
- Require status checks to pass
- Require branches to be up to date before merging
- Require linear history
- Block force pushes
- Block deletions
- Restrict who can push
- Do not allow bypassing

### Status checks obrigatórios

- lint
- typecheck
- unit tests
- integration tests
- build
- security scan
- dependency audit

> Quando o volume de PRs aumentar, ativar **merge queue** para manter a `main` estável.

---

## 10. Pipeline de CI/CD

### Ambientes

```
development
staging
production
```

### Fluxo ideal

```
feature/*  -> PR -> CI
main       -> deploy automático em staging
tag vX.Y.Z -> deploy em production (com aprovação manual)
```

GitHub Environments é usado para proteger ambientes com regras, secrets específicos e aprovações antes de executar jobs de deploy.

---

## 11. Deploy em produção

### Regra de produção

Produção **nunca** depende de "rodar comando manual na máquina".

**Fluxo:**

1. PR aprovado.
2. Merge na `main`.
3. CI valida.
4. Deploy automático em staging.
5. QA / smoke test.
6. Criar release/tag.
7. Aprovação manual.
8. Deploy em produção.
9. Monitoramento pós-deploy.

### Versionamento — SemVer

```
vMAJOR.MINOR.PATCH
```

| Bump   | Critério                                |
|--------|-----------------------------------------|
| PATCH  | correção de bug                         |
| MINOR  | nova funcionalidade compatível          |
| MAJOR  | breaking change                         |

---

## 12. Fluxo de release

### Criar tag

```bash
git checkout main
git pull origin main
git tag -a v1.4.0 -m "release: v1.4.0"
git push origin v1.4.0
```

### Release notes — obrigatório conter

- Features entregues
- Bugs corrigidos
- Alterações técnicas relevantes
- Migrações de banco
- Riscos conhecidos
- Instruções de rollback

> Usar release notes automáticas do GitHub baseadas em PRs mesclados como ponto de partida, complementando manualmente os itens acima.

---

## 13. Hotfix em produção

Quando produção quebra:

1. Criar branch hotfix a partir da `main`.
2. Corrigir o mínimo necessário.
3. Abrir PR urgente.
4. Rodar CI.
5. Review sênior obrigatório.
6. Merge.
7. Gerar tag PATCH.
8. Deploy em produção.
9. Registrar post-mortem se foi incidente.

**Exemplo:**

```bash
git checkout main
git pull origin main
git checkout -b hotfix/902-corrigir-calculo-frete

git add .
git commit -m "fix(freight): corrigir cálculo com peso fracionado"
git push origin hotfix/902-corrigir-calculo-frete
```

Depois do merge:

```bash
git tag -a v1.4.1 -m "release: v1.4.1"
git push origin v1.4.1
```

---

## 14. Regra para subir código

Ordem obrigatória:

1. Criar branch a partir da `main`.
2. Fazer commits pequenos e claros.
3. Rodar testes localmente.
4. Abrir PR.
5. Esperar CI.
6. Corrigir problemas.
7. Passar por review.
8. Fazer **squash merge**.
9. Deletar branch.
10. Deploy via pipeline.

### Não permitido

- Push direto na `main`.
- Commit "ajustes", "teste", "final".
- PR gigante sem contexto.
- Merge com teste quebrado.
- Deploy manual sem rastreabilidade.
- Secret/token no repositório.
- Feature incompleta visível em produção sem feature flag.

---

## 15. Política de tamanho de PR

| Faixa                | Status      |
|----------------------|-------------|
| Até 300 linhas       | Ideal       |
| Até 600 linhas       | Aceitável (se bem separado e documentado) |
| Mais de 1.000 linhas | Evitar      |

**Não misturar** feature + refactor + bugfix + formatação no mesmo PR.

**Quebrando uma feature grande:**
```
PR 1: estrutura base
PR 2: regra de negócio
PR 3: integração
PR 4: interface
PR 5: testes
PR 6: ativação por feature flag
```

---

## 16. Exemplo de fluxo completo

**Cenário:** implementar cadastro automático por pendências.

```bash
# Criar branch
git checkout main
git pull origin main
git checkout -b feature/123-cadastro-pendencias

# Commits
git commit -m "feat(driver): criar modelo de pendência cadastral"
git commit -m "feat(driver): adicionar verificação de vigência documental"
git commit -m "feat(vehicle): adicionar etapa de cadastro de cavalo"
git commit -m "feat(trailer): permitir cadastro de múltiplas carretas"
git commit -m "test(driver): cobrir fluxo de pendências documentais"

# Push
git push origin feature/123-cadastro-pendencias
```

**PR:** `feat(driver): cadastro automático por pendências`

**Merge:** Squash and merge → commit final na `main`:
```
feat(driver): adicionar cadastro automático por pendências (#123)
```

**Deploy:**
```
main -> staging
tag v1.5.0 -> production
```

---

## 17. GitHub Actions — estrutura recomendada

```yaml
name: CI

on:
  pull_request:
    branches:
      - main
  merge_group:
  push:
    branches:
      - main

jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm run test

      - name: Build
        run: npm run build
```

> O evento `merge_group` é necessário quando se usa merge queue.

---

## 18. Política final

Regras oficiais e inegociáveis:

1. `main` é sagrada.
2. Tudo entra por Pull Request.
3. Todo PR precisa passar CI.
4. Todo PR precisa de revisão.
5. Commits seguem **Conventional Commits**.
6. Branches são curtas e objetivas.
7. PRs são pequenos e testáveis.
8. Deploy é automatizado.
9. Produção só recebe código versionado.
10. Hotfix é exceção, não rotina.

---

## Referências

- [GitHub Flow](https://docs.github.com/get-started/quickstart/github-flow)
- [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)
- [Branch protection rules](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
- [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
- [Merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
- [GitHub Environments](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
- [Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
- [Auto-generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)

---

*Norma oficial de engenharia — Lamonica Cargas. Aplicável a humanos e a agentes (Claude Code/GSD).*
