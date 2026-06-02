"""Tipos compartilhados entre relatorio_precheck (Selenium) e api_query.precheck (API).

Extraido para um modulo proprio para evitar import ciclico entre os dois:
relatorio_precheck importa api_query.precheck, que por sua vez precisa
retornar a mesma estrutura — entao a dataclass mora aqui.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ConsultaRelatorioResultado:
    """Resultado de um pre-check de cadastro (CPF de motorista / placa de veiculo).

    status:
        ENCONTRADO       — entidade ja existe no portal (CONFORME ou nao).
        NAO_ENCONTRADO   — entidade nao localizada, cadastro pode prosseguir.
        INCONCLUSIVO     — busca nao concluiu (timeout / falha tecnica) —
                            o flow segue normalmente (nao bloqueia).
        ERRO             — falha grave durante a busca (ex: portal nao abriu).

    situacao (so faz sentido quando status=ENCONTRADO):
        CONFORME         — cadastro vigente, dentro da validade.
        NAO_CONFORME     — vencido ou inadequado, deve ser atualizado.
        ""               — situacao nao identificada.

    erro:        mensagem livre quando algo deu errado (vai pro log).
    evidencia:   trecho da linha/resultado que justificou o status (debug).
    """

    status: str
    erro: str = ""
    evidencia: str = ""
    situacao: str = ""
