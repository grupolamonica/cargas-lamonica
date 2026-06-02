"""Constantes da API SPX extraidas do source map do bundle JS.

Fonte: agencydriver/static/js/749.88ac1de4.chunk.js.map
"""

from __future__ import annotations


# ── Retcodes ──────────────────────────────────────────────────────────────
SUCCESS = 0

# Driver-specific
DRIVER_REPEAT = 271627140        # CPF ja cadastrado
DRIVER_BLOCKED = 271617003       # Motorista bloqueado
VALIDATE_DETAIL_REJECTED = 271626003  # validate/detail rejeitou - dados invalidos (placa/renavam/CRLV/dados conflitantes)
CPF_INVALID = 271605007          # CPF invalido (observado em probe)
DRIVER_IN_REVIEW = 271605008     # Motorista ja tem request em revisao na Shopee — aguarde aprovacao
PHONE_INVALID = 271605009        # Telefone invalido
DRAFT_EXISTS = 271605026         # Ja existe rascunho aberto — editar/complementar em vez de criar novo
REQUEST_IN_PROGRESS = 271605028  # Ja existe solicitacao aberta para esse motorista
DRIVER_REGISTERED_INACTIVE = 271605004  # Driver_profile existe mas esta inativo na agencia — chamar /activation/update
DRIVER_IN_OTHER_AGENCY = 271605035  # Motorista cadastrado em OUTRA agencia Shopee, telefone diverge
LICENSE_ALREADY_REGISTERED = 271605059  # CNH ja registrada em algum motorista (cross-agency forte)
LICENSE_EMPTY = 271605013  # CNH nao pode estar vazia (precheck precisa de placeholder)

# Generic FE-only
ERR_GENERIC_OPS = (991000001, 991000002, 991000003, 991000004)

# OCR / Upload
OCR_FAILED = 991900001           # CRLV: nao extraiu campos
UPLOAD_BACKEND_FAIL = 991900013  # backend retornou nao-zero
UPLOAD_FILE_TYPE = 991900014
UPLOAD_FILE_SIZE = 991900016
UPLOAD_FILE_FORMAT = 991900018

RETCODE_MESSAGES = {
    SUCCESS: "Success",
    DRIVER_REPEAT: "CPF ja cadastrado (DRIVER_REPEAT)",
    DRIVER_BLOCKED: "Motorista bloqueado (DRIVER_BLOCKED)",
    VALIDATE_DETAIL_REJECTED: "validate/detail rejeitou - dados invalidos ou conflitantes (placa em uso por outro motorista, renavam duplicado, CRLV mal lido, etc)",
    CPF_INVALID: "CPF invalido",
    DRIVER_IN_REVIEW: "Motorista em revisao na Shopee — aguarde a aprovacao antes de cadastrar novamente",
    PHONE_INVALID: "Telefone invalido (formato BR esperado: DDD + 9 digitos)",
    DRAFT_EXISTS: "Ja existe rascunho aberto pra esse motorista — edite/complete o rascunho em vez de criar novo",
    REQUEST_IN_PROGRESS: "Ja existe solicitacao em andamento para esse motorista — use withdraw ou edite o request existente",
    DRIVER_REGISTERED_INACTIVE: "Motorista ja registrado mas inativo na agencia — precisa ATIVAR via Agency > Driver Profile (ou /activation/update)",
    DRIVER_IN_OTHER_AGENCY: "Motorista esta cadastrado em OUTRA agencia da Shopee. Confirme o telefone com o motorista ou contate a Shopee.",
    OCR_FAILED: "OCR nao extraiu campos do CRLV",
    UPLOAD_BACKEND_FAIL: "Falha no upload (backend retornou erro)",
    UPLOAD_FILE_TYPE: "Upload: tipo de arquivo invalido",
    UPLOAD_FILE_SIZE: "Upload: arquivo excede limite de tamanho",
    UPLOAD_FILE_FORMAT: "Upload: formato de arquivo invalido",
}


# ── Enums ─────────────────────────────────────────────────────────────────

class TransportType:
    """Tipo de transporte (sub-flow do form)."""
    NORMAL_DRIVER = 0
    WALKER_BIKER = 1


class Gender:
    MALE = 1
    FEMALE = 2
    UNKNOWN = 3


class CountryType:
    BR = 1
    FOREIGNER = 2


class CNHType:
    """Categorias da CNH (id da Shopee). Diferente da letra usual."""
    A = 3
    B = 23
    C = 0
    D = 24
    E = 25
    AB = 26
    AC = 27
    AD = 28
    AE = 29


# Mapeamento letra → id (helper pra OCR/usuario)
CNH_LETRA_PARA_ID = {
    "A": CNHType.A,
    "B": CNHType.B,
    "C": CNHType.C,
    "D": CNHType.D,
    "E": CNHType.E,
    "AB": CNHType.AB,
    "AC": CNHType.AC,
    "AD": CNHType.AD,
    "AE": CNHType.AE,
}

# Remarks validas na CNH
CNH_REMARKS_OPTIONS = [
    "EAR", "CETPP", "CETE", "CETCP", "CETVE", "CETCI", "CMTX", "CMTF",
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
    "N", "O", "P", "Q", "R", "S", "T", "U", "V", "X",
]


class FunctionType:
    """Tipo de funcao do motorista (multi-select).
    Valores vem do system enum 'function_types' no backend.
    """
    DELIVERY = 1
    PICKUP = 2
    LINE_HAUL = 3
    RETURN = 4


class FeederMode:
    DELIVERY_MODE = 0
    FEEDER_MODE = 1


class TransferredStatus:
    NORMAL = 0
    TRANSFERRED = 1


class AtHandover:
    YES = 0
    NO = 1


class RequirePlateInfo:
    YES = 1
    NO = 2


class VehicleTypeStatus:
    AVAILABLE = 1
    UNAVAILABLE = 2


class StationStatus:
    ACTIVE = 0
    INACTIVE = 1


class OCRResult:
    """Codigos do data.ocr_result no vehicle_doc/recognition.

    ATENCAO (2026-05-28): SPX mudou o contrato. Em alguns endpoints novos
    ela retorna `ocr_result: true` (boolean) em vez de `ocr_result: 0` pra
    indicar sucesso. Use `OCRResult.is_success(code)` em vez de comparar
    direto com SUCCESS pra cobrir os dois formatos.
    """
    SUCCESS = 0
    INVALID_PHOTO = 1
    FIELDS_MISMATCH = 2
    UNSUPPORTED_MIME = 3
    FRONT_BLURRY = 4
    INCOMPLETE_PHOTO = 5

    @staticmethod
    def is_success(code) -> bool:
        """Aceita tanto 0 (legado) quanto True (novo formato SPX 2026-05+).

        Observado: SPX agora retorna `ocr_result: true` quando o OCR le todos
        os campos com sucesso; `false` ou um codigo numerico >0 quando ha
        problema. `invalid_ocr_fields: []` complementa o sinal de sucesso.
        """
        if code is True:
            return True
        if code is False:
            return False
        try:
            return int(code) == 0
        except (TypeError, ValueError):
            return False


# ── Limites ─────────────────────────────────────────────────────────────
DRIVER_AGE_LIMIT = 18
VEHICLE_OWNER_NAME_LENGTH_LIMIT = 60
NEIGHBOURHOOD_LENGTH_LIMIT = 30
STREET_LENGTH_LIMIT = 30
ADDRESS_NUMBER_MAX_DIGITS = 10
ZIP_CODE_LENGTH = 8
CPF_LENGTH = 11
CNH_LENGTH = 11
RENAVAM_MIN_DIGITS = 9
RENAVAM_MAX_DIGITS = 11
PHONE_LENGTH = 11


# ── Headers obrigatorios ─────────────────────────────────────────────────
HEADER_APP = "ssc-spx-agency"
HEADER_ACCEPT = "application/json, text/plain, */*"
HEADER_CONTENT_TYPE_JSON = "application/json;charset=UTF-8"
