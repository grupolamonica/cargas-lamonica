import type {
  PublicLeadValidationOverallStatus,
  PublicLeadValidationPlate,
  PublicLeadValidationSummary,
  PublicLeadValidationVigencyStatus,
} from "@/services/loadClaims";

export type ValidationTone = "success" | "warning" | "danger" | "neutral";

export interface ValidationBadgeModel {
  key: string;
  label: string;
  tone: ValidationTone;
}

function getLookupTone(status: string): ValidationTone {
  if (status === "FOUND") {
    return "success";
  }

  if (status === "UNAVAILABLE") {
    return "neutral";
  }

  return "danger";
}

export function getOverallValidationLabel(status: PublicLeadValidationOverallStatus) {
  switch (status) {
    case "VALID":
      return "Cadastro validado";
    case "EXPIRING":
      return "Cadastro perto de vencer";
    case "INVALID":
      return "Cadastro vencido";
    case "NOT_FOUND":
      return "Motorista nao localizado";
    case "PLATE_MISMATCH":
      return "Placas nao validadas";
    case "UNAVAILABLE":
      return "Validacao indisponivel";
    case "INCOMPLETE":
      return "Cadastro incompleto";
    default:
      return "Validacao parcial";
  }
}

export function getOverallValidationTone(status: PublicLeadValidationOverallStatus): ValidationTone {
  switch (status) {
    case "VALID":
      return "success";
    case "EXPIRING":
      return "warning";
    case "UNAVAILABLE":
      return "neutral";
    default:
      return "danger";
  }
}

export function getVigencyLabel(vigency: PublicLeadValidationSummary["vigency"]) {
  switch (vigency.status as PublicLeadValidationVigencyStatus) {
    case "VALID":
      return `Vigencia valida ate ${vigency.validUntil || "data nao informada"}`;
    case "EXPIRING":
      return `Vigencia vence em ${vigency.daysUntilExpiry ?? "?"} dia(s)`;
    case "INVALID":
      return "Vigencia vencida";
    case "UNAVAILABLE":
      return "Vigencia nao validada";
    default:
      return "Vigencia nao encontrada";
  }
}

export function getVigencyTone(status: PublicLeadValidationVigencyStatus): ValidationTone {
  switch (status) {
    case "VALID":
      return "success";
    case "EXPIRING":
      return "warning";
    case "UNAVAILABLE":
      return "neutral";
    default:
      return "danger";
  }
}

function buildPlateBadge(plate: PublicLeadValidationPlate): ValidationBadgeModel {
  return {
    key: `plate-${plate.field}`,
    label:
      plate.status === "FOUND"
        ? `${plate.label} validada`
        : plate.status === "UNAVAILABLE"
          ? `${plate.label} nao validada`
          : `${plate.label} nao encontrada`,
    tone: getLookupTone(plate.status),
  };
}

export function buildPublicLeadValidationBadges(summary: PublicLeadValidationSummary): ValidationBadgeModel[] {
  const badges: ValidationBadgeModel[] = [
    {
      key: "overall",
      label: getOverallValidationLabel(summary.overallStatus),
      tone: getOverallValidationTone(summary.overallStatus),
    },
    {
      key: "driver-angelira",
      label:
        summary.driver.angelira.status === "FOUND"
          ? "Motorista no Angelira"
          : summary.driver.angelira.status === "UNAVAILABLE"
            ? "Angelira indisponivel"
            : "Motorista fora do Angelira",
      tone: getLookupTone(summary.driver.angelira.status),
    },
    {
      key: "driver-aspx",
      label:
        summary.driver.aspx.status === "FOUND"
          ? "Motorista no ASPx"
          : summary.driver.aspx.status === "UNAVAILABLE"
            ? "ASPx indisponivel"
            : "Motorista fora do ASPx",
      tone: getLookupTone(summary.driver.aspx.status),
    },
    {
      key: "vigency",
      label: getVigencyLabel(summary.vigency),
      tone: getVigencyTone(summary.vigency.status),
    },
  ];

  summary.plates.forEach((plate) => {
    badges.push(buildPlateBadge(plate));
  });

  return badges;
}

export function getPrimaryValidationWarning(summary: PublicLeadValidationSummary | null | undefined) {
  if (!summary) {
    return null;
  }

  return summary.warnings[0] || null;
}

export function shouldPromptValidationSupport(summary: PublicLeadValidationSummary | null | undefined) {
  if (!summary) {
    return false;
  }

  return ["INVALID", "NOT_FOUND", "PLATE_MISMATCH", "PARTIAL", "INCOMPLETE"].includes(summary.overallStatus);
}
