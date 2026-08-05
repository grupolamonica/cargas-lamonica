#!/usr/bin/env node
// scripts/glpi-worker.mjs
//
// Responde automaticamente os chamados do GLPI cuja correção JÁ ESTÁ EM PRODUÇÃO.
//
// ─── POR QUE RODA NA MÁQUINA DO TIME, E NÃO NA VPS ───────────────────────────
//
// O GLPI vive na rede interna (10.100.100.6). Medido em 05/08/2026:
//   - VPS de produção (76.13.169.177) → GLPI: sem rota (curl http_code=000, timeout).
//   - Runner do GitHub Actions → GLPI: idem, é internet pública para rede privada.
//   - Máquina do time (dentro da rede) → GLPI: responde.
// Ou seja: não é preferência de arquitetura, é o único lugar de onde dá para falar
// com o GLPI. O worker roda aqui, agendado (Agendador de Tarefas do Windows).
//
// ─── O CICLO ─────────────────────────────────────────────────────────────────
//
//   1. Descobre qual commit está em produção (último deploy verde no GitHub).
//   2. Varre os commits ATÉ esse ponto procurando o trailer `Chamado: GLPI #N`.
//      Commits ainda não deployados são ignorados — a correção precisa estar no ar
//      antes de alguém receber "resolvido".
//   3. Para cada chamado declarado, lê a comprovação em `docs/chamados/<N>.md`.
//      Sem esse arquivo, não responde nada.
//   4. Anexa a comprovação, publica a resposta e marca como Solucionado.
//
// Reexecutar é seguro: a idempotência vive no próprio GLPI (marca no histórico do
// chamado), então não há arquivo de estado para corromper ou dessincronizar.
//
// ─── USO ─────────────────────────────────────────────────────────────────────
//
//   node scripts/glpi-worker.mjs               ciclo normal
//   node scripts/glpi-worker.mjs --dry-run     mostra o que faria, sem escrever
//   node scripts/glpi-worker.mjs --dias 60     janela de commits (padrão: 30)
//   node scripts/glpi-worker.mjs --chamado 40  força um chamado específico

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { answerGlpiTicket } from "../backend/src/application/glpi/answer-glpi-ticket.js";
import { chamadosDeclaradosNoCommit, parseTicketProof } from "../backend/src/application/glpi/ticket-proof.js";
import { isGlpiConfigured } from "../backend/src/infrastructure/glpi/glpi-client.js";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIAS_PADRAO = 30;

const modoSeco = process.argv.includes("--dry-run");

function argValor(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

function git(...args) {
  return execFileSync("git", args, { cwd: RAIZ, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

/**
 * SHA que está rodando em produção = head do último deploy verde.
 *
 * Cai para `origin/main` se o `gh` não estiver disponível/autenticado. É um
 * fallback OTIMISTA: pode incluir um commit mergeado que ainda não subiu, então o
 * worker avisa alto quando usa esse caminho.
 */
function shaEmProducao() {
  try {
    const saida = execFileSync(
      "gh",
      ["run", "list", "--workflow=deploy.yml", "--branch", "main", "--status", "success",
       "--limit", "1", "--json", "headSha"],
      { cwd: RAIZ, encoding: "utf8" },
    );
    const sha = JSON.parse(saida)?.[0]?.headSha;
    if (sha) return { sha, origem: "último deploy verde" };
  } catch {
    // segue para o fallback
  }
  console.warn("[aviso] não consegui ler o último deploy pelo gh — usando origin/main.");
  console.warn("        Um commit mergeado e ainda não deployado pode ser respondido cedo demais.");
  return { sha: git("rev-parse", "origin/main"), origem: "origin/main (fallback)" };
}

/** Ids de chamado declarados nos commits até `sha`, dentro da janela de dias. */
function chamadosDeclaradosAte(sha, dias) {
  const separador = "@@COMMIT@@";
  const log = git("log", sha, `--since=${dias}.days`, `--format=${separador}%H%n%B`);
  const ids = new Map(); // id → sha do commit que declarou

  for (const bloco of log.split(separador)) {
    if (!bloco.trim()) continue;
    const [linhaSha, ...corpo] = bloco.split("\n");
    for (const id of chamadosDeclaradosNoCommit(corpo.join("\n"))) {
      if (!ids.has(id)) ids.set(id, linhaSha.trim());
    }
  }
  return ids;
}

/** Comprovação como está NO COMMIT DEPLOYADO — não na cópia de trabalho local. */
function leComprovacao(sha, chamadoId) {
  const caminho = `docs/chamados/${chamadoId}.md`;
  try {
    // stdio "pipe" no stderr: arquivo ausente é um caso ESPERADO (correção sem
    // comprovação), e o fatal do git poluiria a saída com um erro que não é erro.
    const conteudo = execFileSync("git", ["show", `${sha}:${caminho}`], {
      cwd: RAIZ,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { caminho, conteudo };
  } catch {
    return { caminho, conteudo: null };
  }
}

async function main() {
  if (!isGlpiConfigured()) {
    console.error("GLPI não configurado: faltam GLPI_APP_TOKEN e/ou GLPI_USER_TOKEN em backend/.env.");
    process.exit(2);
  }

  git("fetch", "origin", "main", "--quiet");

  const { sha, origem } = shaEmProducao();
  const dias = Number(argValor("--dias")) || DIAS_PADRAO;
  console.log(`produção: ${sha.slice(0, 8)} (${origem}) · janela: ${dias} dias${modoSeco ? " · DRY-RUN" : ""}`);

  const forcado = argValor("--chamado");
  const chamados = forcado
    ? new Map([[Number(forcado), sha]])
    : chamadosDeclaradosAte(sha, dias);

  if (chamados.size === 0) {
    console.log("nenhum chamado declarado em commit deployado nesta janela.");
    return;
  }

  const resumo = { respondidos: 0, ignorados: 0, semProva: 0, erros: 0 };

  for (const [chamadoId, commitSha] of chamados) {
    const { caminho, conteudo } = leComprovacao(sha, chamadoId);

    if (!conteudo) {
      // Não é erro do worker: é correção sem comprovação. A trava existe para que
      // ninguém receba "resolvido" sem prova — o autor precisa criar o arquivo.
      console.log(`#${chamadoId}  SEM PROVA — falta ${caminho} no commit deployado. Não respondido.`);
      resumo.semProva += 1;
      continue;
    }

    let prova;
    try {
      prova = parseTicketProof(conteudo);
    } catch (erro) {
      console.log(`#${chamadoId}  PROVA INVÁLIDA (${erro.message}) em ${caminho}. Não respondido.`);
      resumo.semProva += 1;
      continue;
    }

    if (modoSeco) {
      console.log(`#${chamadoId}  [dry-run] responderia a partir de ${commitSha.slice(0, 8)}`);
      console.log(`           anexo: ${caminho}`);
      console.log(`           texto: ${prova.resposta.split("\n")[0].slice(0, 80)}...`);
      continue;
    }

    try {
      const resultado = await answerGlpiTicket({
        ticketId: chamadoId,
        resposta: prova.respostaHtml,
        prova: {
          filename: `chamado-${chamadoId}-comprovacao.md`,
          content: conteudo,
          contentType: "text/markdown",
        },
        correlationId: `glpi-worker-${chamadoId}`,
      });

      if (resultado.acao === "respondido") {
        console.log(`#${chamadoId}  RESPONDIDO e marcado como Solucionado (anexo: ${caminho})`);
        resumo.respondidos += 1;
      } else {
        console.log(`#${chamadoId}  ignorado (${resultado.motivo})`);
        resumo.ignorados += 1;
      }
    } catch (erro) {
      console.error(`#${chamadoId}  ERRO: ${erro instanceof Error ? erro.message : String(erro)}`);
      resumo.erros += 1;
    }
  }

  console.log(
    `\nresumo: ${resumo.respondidos} respondido(s) · ${resumo.ignorados} já tratado(s) · ` +
      `${resumo.semProva} sem comprovação · ${resumo.erros} erro(s)`,
  );
  if (resumo.erros > 0) process.exitCode = 1;
}

main().catch((erro) => {
  console.error(`falha geral: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
});
