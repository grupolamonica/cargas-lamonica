import { Badge } from "@/components/ui/badge";
import { buildPublicLeadValidationBadges, type ValidationTone } from "@/lib/publicLeadValidation";
import { cn } from "@/lib/utils";
import type { PublicLeadValidationSummary } from "@/services/loadClaims";

interface LeadValidationBadgeGroupProps {
  summary: PublicLeadValidationSummary | null | undefined;
  className?: string;
}

const toneClassNames: Record<ValidationTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-700",
  neutral: "border-slate-200 bg-slate-50 text-slate-700",
};

export default function LeadValidationBadgeGroup({ summary, className }: LeadValidationBadgeGroupProps) {
  if (!summary) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        <Badge
          variant="outline"
          className={cn("rounded-full px-2.5 py-1 text-[11px]", toneClassNames.warning)}
        >
          Validacao em processamento
        </Badge>
      </div>
    );
  }

  const badges = buildPublicLeadValidationBadges(summary);

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {badges.map((badge) => (
        <Badge key={badge.key} variant="outline" className={cn("rounded-full px-2.5 py-1 text-[11px]", toneClassNames[badge.tone])}>
          {badge.label}
        </Badge>
      ))}
    </div>
  );
}
