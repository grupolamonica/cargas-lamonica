import { describe, expect, it } from "vitest";

import { chamadosDeclaradosNoCommit, parseTicketProof, respostaParaHtml } from "./ticket-proof.js";

const PROVA_COMPLETA = `# Chamado #40 — status errado na chegada

## Resposta ao operador

O sistema traduzia a chegada do motorista como chegada no destino.
Por isso escrevia "aguardando descarga".

Agora aparece **aguardando carregamento**, igual à planilha.

## Comprovação

| LH | Antes | Depois |
|---|---|---|
| LT0Q8702CP701 | descarga | carregamento |
`;

describe("parseTicketProof", () => {
  it("separa o texto do operador do resto do arquivo", () => {
    const { titulo, resposta } = parseTicketProof(PROVA_COMPLETA);

    expect(titulo).toBe("Chamado #40 — status errado na chegada");
    expect(resposta).toContain("aguardando descarga");
    expect(resposta).toContain("**aguardando carregamento**");
    // A tabela é comprovação técnica: vai no anexo, não no texto que o operador lê.
    expect(resposta).not.toContain("LT0Q8702CP701");
    expect(resposta).not.toContain("| Antes |");
  });

  it("arquivo sem a seção de resposta é recusado", () => {
    // No modo automático isso barra o envio: melhor não responder do que publicar
    // um despejo técnico para quem abriu o chamado.
    expect(() => parseTicketProof("# Chamado #40\n\n## Comprovação\n\ntabelas")).toThrow(
      "PROVA_SEM_SECAO_RESPOSTA",
    );
  });

  it("seção presente mas vazia também é recusada", () => {
    expect(() => parseTicketProof("# X\n\n## Resposta ao operador\n\n## Comprovação\n\nz")).toThrow(
      "PROVA_RESPOSTA_VAZIA",
    );
  });

  it("aceita a seção como última do arquivo", () => {
    const { resposta } = parseTicketProof("# X\n\n## Resposta ao operador\n\nTudo certo agora.\n");
    expect(resposta).toBe("Tudo certo agora.");
  });

  it("não depende de caixa nem de espaço no cabeçalho", () => {
    const { resposta } = parseTicketProof("# X\n\n##   RESPOSTA AO OPERADOR  \n\nok\n");
    expect(resposta).toBe("ok");
  });
});

describe("respostaParaHtml", () => {
  it("parágrafos separados por linha em branco viram <p>", () => {
    expect(respostaParaHtml("Primeiro.\n\nSegundo.")).toBe("<p>Primeiro.</p>\n<p>Segundo.</p>");
  });

  it("quebra simples dentro do parágrafo não vira parágrafo novo", () => {
    expect(respostaParaHtml("linha um\nlinha dois")).toBe("<p>linha um linha dois</p>");
  });

  it("negrito do markdown vira <strong> — senão o operador veria os asteriscos", () => {
    expect(respostaParaHtml("agora é **carregamento**")).toBe(
      "<p>agora é <strong>carregamento</strong></p>",
    );
  });

  it("lista vira <ul>", () => {
    expect(respostaParaHtml("- um\n- dois")).toBe("<ul><li>um</li><li>dois</li></ul>");
  });

  it("escapa HTML do texto — o conteúdo vai renderizado no GLPI", () => {
    expect(respostaParaHtml("use <script>alert(1)</script>")).toBe(
      "<p>use &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("texto vazio não gera markup", () => {
    expect(respostaParaHtml("   ")).toBe("");
  });
});

describe("chamadosDeclaradosNoCommit", () => {
  it("lê o trailer explícito", () => {
    const mensagem = [
      "fix(monitor): corrige tradução do status",
      "",
      "Corpo do commit explicando a decisão.",
      "",
      "Chamado: GLPI #40",
      "Co-Authored-By: alguém <a@b.c>",
    ].join("\n");

    expect(chamadosDeclaradosNoCommit(mensagem)).toEqual([40]);
  });

  it("aceita mais de um chamado no mesmo commit, sem repetir", () => {
    const mensagem = "fix: x\n\nChamado: GLPI #40\nChamado: GLPI #41\nChamado: GLPI #40";
    expect(chamadosDeclaradosNoCommit(mensagem)).toEqual([40, 41]);
  });

  it("menção solta no texto NÃO dispara resposta automática", () => {
    // A automação responde sozinha e notifica o operador. Deduzir o chamado a
    // partir de prosa ("igual ao chamado 40") responderia o chamado errado.
    const mensagem = "fix: mesma causa do chamado 40, ver GLPI #40 na descrição";
    expect(chamadosDeclaradosNoCommit(mensagem)).toEqual([]);
  });

  it("commit sem trailer não declara nada", () => {
    expect(chamadosDeclaradosNoCommit("chore: bump deps")).toEqual([]);
    expect(chamadosDeclaradosNoCommit("")).toEqual([]);
    expect(chamadosDeclaradosNoCommit(null)).toEqual([]);
  });

  it("tolera espaçamento e caixa do trailer", () => {
    expect(chamadosDeclaradosNoCommit("x\n\nchamado:  glpi  #7  ")).toEqual([7]);
  });
});
