// backend/src/application/glpi/ticket-proof.js
//
// Lê o arquivo de comprovação de um chamado (`docs/chamados/<id>.md`) e separa o
// que vai como RESPOSTA ao operador do que vai como ANEXO.
//
// A convenção existe porque a automação é total: quem escreve a correção também
// escreve a comprovação, e o arquivo entra no mesmo PR — revisável antes de
// chegar ao operador. Sem esse arquivo, a automação não responde nada (a trava 1
// de answer-glpi-ticket.js).
//
// Formato esperado:
//
//     # Chamado #40 — status errado na chegada
//
//     ## Resposta ao operador
//
//     O que estava acontecendo, em linguagem de quem abriu o chamado.
//     Como conferir na tela.
//
//     ## Comprovação
//
//     Tabelas, antes/depois, contagens em produção.
//
// A seção "Resposta ao operador" vira o texto publicado; o arquivo INTEIRO vira o
// anexo. É por isso que a comprovação técnica pode ser longa sem poluir a leitura
// de quem abriu o chamado.

const CABECALHO_RESPOSTA = /^##\s+resposta\s+ao\s+operador\s*$/i;
const QUALQUER_CABECALHO_2 = /^##\s+/;
const TITULO_1 = /^#\s+(.+?)\s*$/;

function escapaHtml(texto) {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Converte o markdown simples da resposta em HTML — o GLPI renderiza o conteúdo
 * do chamado como HTML, então markdown cru apareceria com os asteriscos à mostra.
 *
 * Cobre só o que a resposta ao operador usa: parágrafo, negrito e lista. Nada de
 * tabela ou código — isso é comprovação técnica e vive no anexo.
 */
export function respostaParaHtml(markdown) {
  const blocos = String(markdown ?? "")
    .trim()
    .split(/\n\s*\n/)
    .filter((bloco) => bloco.trim());

  return blocos
    .map((bloco) => {
      const linhas = bloco.split("\n").map((linha) => linha.trim());

      if (linhas.every((linha) => /^[-*]\s+/.test(linha))) {
        const itens = linhas
          .map((linha) => `<li>${negrito(escapaHtml(linha.replace(/^[-*]\s+/, "")))}</li>`)
          .join("");
        return `<ul>${itens}</ul>`;
      }

      return `<p>${negrito(escapaHtml(linhas.join(" ")))}</p>`;
    })
    .join("\n");
}

function negrito(texto) {
  return texto.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

/**
 * @param {string} markdown conteúdo bruto de docs/chamados/<id>.md
 * @returns {{ titulo: string|null, resposta: string, respostaHtml: string }}
 * @throws Error("PROVA_SEM_SECAO_RESPOSTA") arquivo sem "## Resposta ao operador"
 * @throws Error("PROVA_RESPOSTA_VAZIA")     seção presente mas sem texto
 */
export function parseTicketProof(markdown) {
  const linhas = String(markdown ?? "").split(/\r?\n/);

  let titulo = null;
  const respostaLinhas = [];
  let dentroDaResposta = false;

  for (const linha of linhas) {
    if (!titulo) {
      const casa = TITULO_1.exec(linha);
      if (casa) {
        titulo = casa[1];
        continue;
      }
    }

    if (CABECALHO_RESPOSTA.test(linha.trim())) {
      dentroDaResposta = true;
      continue;
    }

    // Qualquer outro `##` encerra a seção — a comprovação técnica que vem depois
    // é anexo, não texto para o operador.
    if (dentroDaResposta && QUALQUER_CABECALHO_2.test(linha.trim())) {
      dentroDaResposta = false;
      continue;
    }

    if (dentroDaResposta) respostaLinhas.push(linha);
  }

  if (respostaLinhas.length === 0 && !linhas.some((l) => CABECALHO_RESPOSTA.test(l.trim()))) {
    throw new Error("PROVA_SEM_SECAO_RESPOSTA");
  }

  const resposta = respostaLinhas.join("\n").trim();
  if (!resposta) throw new Error("PROVA_RESPOSTA_VAZIA");

  return { titulo, resposta, respostaHtml: respostaParaHtml(resposta) };
}

/**
 * Extrai os números de chamado declarados na mensagem de um commit.
 *
 * Só o trailer explícito conta — `Chamado: GLPI #40`. Menção solta no corpo do
 * texto ("como no chamado 40") NÃO dispara resposta automática: no modo total, a
 * automação nunca deduz qual chamado alguém quis dizer.
 *
 * @returns {number[]} ids únicos, em ordem de aparição
 */
export function chamadosDeclaradosNoCommit(mensagem) {
  const ids = [];
  const regex = /^\s*Chamado:\s*GLPI\s*#(\d+)\s*$/gim;
  let casa;
  while ((casa = regex.exec(String(mensagem ?? ""))) !== null) {
    const id = Number(casa[1]);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
