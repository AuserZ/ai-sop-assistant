import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";
export type ButtonSize = "default" | "sm" | "compact" | "icon";

const buttonBaseClassName =
  "cp-control inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] py-2 font-medium leading-5 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50";

export const buttonSizeClassNames: Readonly<Record<ButtonSize, string>> = {
  default: "px-4 text-sm",
  sm: "px-3 text-xs",
  compact: "px-2.5 text-xs",
  icon: "min-w-11 px-2 text-xs",
};

export const buttonVariantClassNames: Readonly<Record<ButtonVariant, string>> = {
  primary: `${buttonBaseClassName} border border-transparent bg-[#1d4ed8] text-white hover:bg-[#1e40af]`,
  secondary: `${buttonBaseClassName} border border-[#cbd5e1] bg-white text-[#0f172a] hover:border-[#94a3b8] hover:bg-[#f1f5f9]`,
  destructive: `${buttonBaseClassName} border border-[#991b1b] bg-[#991b1b] text-white hover:bg-[#7f1d1d] focus-visible:outline-[#991b1b]`,
  ghost: `${buttonBaseClassName} border border-transparent bg-transparent text-[#0f172a] hover:bg-[#f1f5f9]`,
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "default",
  extraClassName?: string,
): string {
  const base = `${buttonVariantClassNames[variant]} ${buttonSizeClassNames[size]}`;
  return extraClassName ? `${base} ${extraClassName}` : base;
}

export const inputFieldClassName =
  "cp-control min-h-11 w-full min-w-0 rounded-[var(--radius-md)] border border-[#cbd5e1] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#64748b] hover:border-[#94a3b8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] aria-[invalid=true]:border-[#991b1b] disabled:cursor-not-allowed disabled:bg-[#f1f5f9] disabled:text-[#64748b]";

export const textLinkBaseClassName =
  "cp-control min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium text-[#1d4ed8] underline underline-offset-4 hover:text-[#1e40af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]";

export const textLinkClassName = `inline-flex ${textLinkBaseClassName}`;

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  loadingLabel?: string;
};

export function Button({
  variant = "primary",
  size = "default",
  loading = false,
  loadingLabel,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass(variant, size, className)}
    >
      {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={className ? `${inputFieldClassName} ${className}` : inputFieldClassName} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={className ? `${inputFieldClassName} ${className}` : inputFieldClassName}>
      {children}
    </select>
  );
}

export type StatusTone = "active" | "pending" | "processing" | "danger" | "neutral";

export const statusToneStyles: Readonly<Record<StatusTone, string>> = {
  active: "border-[#a7f3d0] bg-[#ecfdf5] text-[#065f46]",
  pending: "border-[#fde68a] bg-[#fffbeb] text-[#92400e]",
  processing: "border-[#bfdbfe] bg-[#eff6ff] text-[#1e40af]",
  danger: "border-[#fecaca] bg-[#fef2f2] text-[#991b1b]",
  neutral: "border-[#cbd5e1] bg-[#f1f5f9] text-[#0f172a]",
};

export function resolveStatusTone(status: string): StatusTone {
  const normalized = status.trim().toUpperCase();
  if (normalized === "ACTIVE" || normalized === "APPROVED" || normalized === "COMPLETED") {
    return "active";
  }
  if (normalized === "PENDING_VERIFICATION" || normalized === "INVITED" || normalized === "PENDING" || normalized === "WARNING") {
    return "pending";
  }
  if (normalized === "PROCESSING" || normalized === "UPLOADED" || normalized === "QUEUED" || normalized === "RUNNING" || normalized === "INFO") {
    return "processing";
  }
  if (normalized === "FAILED" || normalized === "REJECTED" || normalized === "DELETED" || normalized === "INACTIVE" || normalized === "ERROR") {
    return "danger";
  }
  return "neutral";
}

export type StatusBadgeProps = {
  label: string;
  tone?: StatusTone;
  testId?: string;
  className?: string;
};

export function StatusBadge({ label, tone, testId, className }: StatusBadgeProps) {
  const resolvedLabel = label.trim() || "Unknown";
  const resolvedTone = tone ?? resolveStatusTone(resolvedLabel);
  return (
    <span
      data-testid={testId}
      data-status-tone={resolvedTone}
      className={`inline-flex items-center rounded-[var(--radius-sm)] border px-2 py-0.5 text-xs font-semibold leading-5 ${statusToneStyles[resolvedTone]}${className ? ` ${className}` : ""}`}
    >
      {resolvedLabel}
    </span>
  );
}

export function SurfaceCard({
  children,
  className,
  ariaLabel,
  ariaLabelledBy,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}) {
  return (
    <section
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={`rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-6${className ? ` ${className}` : ""}`}
    >
      {children}
    </section>
  );
}

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[#1d4ed8] text-white"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75">
          <path d="M7 3.75h7.5L19.25 8.5V20.25H7V3.75Z" strokeLinejoin="round" />
          <path d="M14.25 3.75V8.75H19.25" strokeLinejoin="round" />
          <path d="M10 13.75 11.75 15.5 15.75 11.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="min-w-0">
        <span className={`block truncate font-semibold tracking-tight text-[#0f172a] ${compact ? "text-sm" : "text-sm"}`}>
          AI SOP Assistant
        </span>
      </div>
    </div>
  );
}
