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
      return "Motorista não localizado";
    case "PLATE_MISMATCH":
      return "Placas não validadas";
    case "UNAVAILABLE":
      return "Validação indisponível";
    case "INCOMPLETE":
      return "Cadastro incompleto";
    default:
      return "Validação parcial";
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
      return `Vigência válida até ${vigency.validUntil || "data não informada"}`;
    case "EXPIRING":
      return `Vigência vence em ${vigency.daysUntilExpiry ?? "?"} dia(s)`;
    case "INVALID":
      return "Vigência vencida";
    case "UNAVAILABLE":
      return "Vigência não validada";
    default:
      return "Vigência não encontrada";
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
          ? `${plate.label} não validada`
          : `${plate.label} não encontrada`,
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
          ? "Motorista no Angellira"
          : summary.driver.angelira.status === "UNAVAILABLE"
            ? "Angellira indisponível"
            : "Motorista fora do Angellira",
      tone: getLookupTone(summary.driver.angelira.status),
    },
    {
      key: "driver-aspx",
      label:
        summary.driver.aspx.status === "FOUND"
          ? "Motorista no ASPX"
          : summary.driver.aspx.status === "UNAVAILABLE"
            ? "ASPX indisponível"
            : "Motorista fora do ASPX",
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
