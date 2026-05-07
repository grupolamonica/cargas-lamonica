import type { LucideIcon } from "lucide-react";
import {
  Award,
  BarChart3,
  Building2,
  CheckCircle,
  Clock3,
  CreditCard,
  DollarSign,
  Globe,
  Heart,
  IdCard,
  MapPin,
  MessageSquare,
  Navigation,
  Package,
  Phone,
  Search,
  Shield,
  ShieldCheck,
  Star,
  Tag,
  ThumbsUp,
  Timer,
  Trophy,
  Truck,
  Users,
  Zap,
} from "lucide-react";

export const BADGE_ICON_MAP: Record<string, LucideIcon> = {
  Award,
  BarChart3,
  Building2,
  CheckCircle,
  Clock3,
  CreditCard,
  DollarSign,
  Globe,
  Heart,
  IdCard,
  MapPin,
  MessageSquare,
  Navigation,
  Package,
  Phone,
  Search,
  Shield,
  ShieldCheck,
  Star,
  Tag,
  ThumbsUp,
  Timer,
  Trophy,
  Truck,
  Users,
  Zap,
};

export const BADGE_ICON_NAMES = Object.keys(BADGE_ICON_MAP).sort();

export function getBadgeIcon(name: string): LucideIcon {
  return BADGE_ICON_MAP[name] ?? Tag;
}
