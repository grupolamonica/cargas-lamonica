"""Prompts versionados para extração OCR via GPT-4o Vision.

Cada prompt segue o mesmo contrato:

1. ``system``: papel do modelo + restrições de formato.
2. ``user``: instrução específica + lista exata de campos JSON esperados.
3. Retorno: JSON com chaves *snake_case*, ``null`` para campos ausentes.

Bumpar :data:`PROMPT_VERSION` em qualquer mudança que afete o conteúdo de
prompt — preserva rastreabilidade no envelope (``header.prompt_version``).
"""

from dataclasses import dataclass
from typing import Mapping


PROMPT_VERSION = "v1"


@dataclass(frozen=True)
class OcrPrompt:
    """System + user prompt para um tipo de documento."""

    system: str
    user: str


_COMMON_RULES = (
    "Você é um extrator de OCR para documentos brasileiros.\n"
    "REGRAS OBRIGATÓRIAS:\n"
    "1. Responda APENAS com JSON válido. Sem markdown, sem comentários, "
    "sem texto antes/depois.\n"
    "2. Use null para campos não visíveis ou ilegíveis na imagem. "
    "NUNCA invente dados.\n"
    "3. Preserve a grafia exata (mantenha acentos, caixa alta/baixa "
    "como no documento).\n"
    "4. Para CPF/CNPJ/CEP/placas, retorne apenas dígitos quando o "
    "campo pedir 'digits only'; caso contrário, preserve a máscara.\n"
    "5. Se a imagem não for do documento esperado, retorne todos os "
    "campos como null e adicione 'observacoes' explicando."
)


_CNH = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Extraia os dados da CNH (Carteira Nacional de Habilitação) brasileira "
        "visível na imagem.\n\n"
        "Retorne JSON com EXATAMENTE estas chaves (use null se ausente):\n"
        "- nome: nome completo do condutor\n"
        "- cpf: digits only (11 dígitos)\n"
        "- rg: número do RG conforme impresso (pode ter dígito + UF)\n"
        "- data_nascimento: formato DD/MM/AAAA\n"
        "- numero_registro: número de registro da CNH (digits only)\n"
        "- categoria: ex. 'AB', 'D', 'E'\n"
        "- validade: formato DD/MM/AAAA\n"
        "- primeira_habilitacao: formato DD/MM/AAAA\n"
        "- nome_pai: nome do pai\n"
        "- nome_mae: nome da mãe\n"
        "- observacoes: anotações do verso (EAR, exerce ativ. remunerada, "
        "lentes, etc.) ou null se não houver"
    ),
)


_CRLV = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Extraia os dados do CRLV (Certificado de Registro e Licenciamento "
        "de Veículo) brasileiro visível na imagem. Documentos vêm da "
        "concessionária estadual (Detran).\n\n"
        "Retorne JSON com EXATAMENTE estas chaves (use null se ausente):\n"
        "- placa: formato 'ABC1D23' (Mercosul) ou 'ABC1234' (antigo)\n"
        "- renavam: digits only (até 11 dígitos)\n"
        "- chassi: 17 caracteres alfanuméricos\n"
        "- marca_modelo: ex. 'VW/CONSTELLATION 24.280'\n"
        "- ano_fabricacao: AAAA\n"
        "- ano_modelo: AAAA\n"
        "- cor: cor predominante\n"
        "- combustivel: ex. 'DIESEL', 'GASOLINA/ALCOOL'\n"
        "- categoria: ex. 'PARTICULAR', 'ALUGUEL'\n"
        "- especie: ex. 'CARGA', 'TRACAO', 'PASSAGEIRO'\n"
        "- tipo: ex. 'CAMINHAO', 'CAMINHAO TRATOR', 'SEMI-REBOQUE'\n"
        "- carroceria: ex. 'BAU FECHADO', 'GRADE BAIXA'\n"
        "- capacidade_carga: peso bruto total em kg (digits only)\n"
        "- cpf_cnpj_proprietario: digits only (11 ou 14)\n"
        "- nome_proprietario: nome completo ou razão social\n"
        "- uf: 2 letras\n"
        "- municipio: nome do município de emplacamento"
    ),
)


_CARTAO_CNPJ = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Extraia os dados do Comprovante de Inscrição e Situação Cadastral "
        "(Cartão CNPJ) emitido pela Receita Federal.\n\n"
        "Retorne JSON com EXATAMENTE estas chaves (use null se ausente):\n"
        "- cnpj: formato '00.000.000/0000-00'\n"
        "- razao_social: razão social completa\n"
        "- nome_fantasia: nome fantasia (pode estar vazio/null)\n"
        "- cep: formato '00000-000'\n"
        "- logradouro: tipo + nome (ex. 'RUA ALMEIDA TORRES')\n"
        "- numero: número do endereço (apenas o número; null se 'S/N')\n"
        "- complemento: complemento se houver\n"
        "- bairro: bairro\n"
        "- municipio: município\n"
        "- uf: 2 letras\n"
        "- data_abertura: formato DD/MM/AAAA\n"
        "- situacao_cadastral: ex. 'ATIVA', 'BAIXADA', 'SUSPENSA'\n"
        "- cnae_principal: código + descrição (ex. '49.30-2-02 - Transporte "
        "rodoviário de carga')"
    ),
)


_RNTRC = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Extraia os dados do comprovante ANTT/RNTRC (Registro Nacional de "
        "Transportadores Rodoviários de Cargas). O layout varia entre "
        "diferentes consultas/datas — adapte-se.\n\n"
        "Retorne JSON com EXATAMENTE estas chaves (use null se ausente):\n"
        "- rntrc: número do RNTRC (apenas dígitos, 7-12)\n"
        "- documento: CPF (PF) ou CNPJ (PJ) do titular — APENAS DÍGITOS "
        "(11 para CPF, 14 para CNPJ)\n"
        "- tipo: 'PF' se o documento for CPF (11 dígitos), 'PJ' se for "
        "CNPJ (14 dígitos), null se indeterminado\n"
        "- nome: nome do titular (pessoa física ou razão social)"
    ),
)


_COMPROVANTE = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Extraia os dados do comprovante de residência (fatura de "
        "concessionária — luz, água, gás, internet, telefone).\n\n"
        "ATENÇÃO ao campo 'numero':\n"
        "- Retorne SOMENTE o número da casa/apartamento do endereço de "
        "instalação/cobrança.\n"
        "- NÃO confunda com: CPF, CNPJ, código de cliente, número de "
        "medidor, código de barras, valores monetários.\n"
        "- Se o endereço usa 'S/N' (sem número), retorne null.\n\n"
        "Retorne JSON com EXATAMENTE estas chaves (use null se ausente):\n"
        "- titular: nome do titular da fatura\n"
        "- cep: formato '00000-000'\n"
        "- logradouro: tipo + nome (ex. 'AV PAULISTA')\n"
        "- numero: número do endereço (apenas dígitos; null se S/N)\n"
        "- complemento: APTO, BLOCO, etc.\n"
        "- bairro: bairro\n"
        "- municipio: município\n"
        "- uf: 2 letras\n"
        "- concessionaria: ex. 'CPFL', 'ENEL', 'CEMIG', 'SABESP', etc.\n"
        "- mes_referencia: formato 'MM/AAAA' da fatura"
    ),
)


_SELFIE_CNH = OcrPrompt(
    system=_COMMON_RULES,
    user=(
        "Esta imagem é uma SELFIE do motorista segurando a própria CNH. "
        "Sua tarefa é validar anti-fraude.\n\n"
        "Retorne JSON com EXATAMENTE estas chaves:\n"
        "- cnh_visible: 'true' se a CNH (Carteira Nacional de Habilitação) "
        "está claramente visível e legível, senão 'false'\n"
        "- face_visible: 'true' se há um rosto humano visível na selfie, "
        "senão 'false'\n"
        "- match_score: número entre 0.0 e 1.0 indicando similaridade "
        "entre o rosto da selfie e a foto 3x4 da CNH. Use null se uma das "
        "duas faces não estiver visível.\n"
        "- nome_cnh_legivel: nome impresso na CNH (se legível), senão null\n"
        "- observacoes: motivo se cnh_visible=false ou match_score baixo "
        "(<0.5), explicação curta em PT-BR; senão null"
    ),
)


OCR_PROMPTS: Mapping[str, OcrPrompt] = {
    "cnh": _CNH,
    "crlv": _CRLV,
    "cartao_cnpj": _CARTAO_CNPJ,
    "rntrc": _RNTRC,
    "comprovante": _COMPROVANTE,
    "selfie_cnh": _SELFIE_CNH,
}


SUPPORTED_DOC_TYPES = frozenset(OCR_PROMPTS.keys())
