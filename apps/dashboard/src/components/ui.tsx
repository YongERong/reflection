import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren } from "react";

type CardProps = PropsWithChildren<HTMLAttributes<HTMLElement>> & {
  as?: "article" | "section";
};

export function Card({ as: Element = "section", className = "", ...props }: CardProps) {
  return <Element className={`ui-card ${className}`.trim()} {...props} />;
}

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-header ${className}`.trim()} {...props} />;
}

export function CardTitle({ className = "", ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={`ui-card-title ${className}`.trim()} {...props} />;
}

export function CardDescription({ className = "", ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={`ui-card-description ${className}`.trim()} {...props} />;
}

export function CardAction({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-action ${className}`.trim()} {...props} />;
}

export function CardContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card-content ${className}`.trim()} {...props} />;
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: "default" | "secondary" | "destructive" | "outline";
};

export function Badge({ className = "", variant = "default", ...props }: BadgeProps) {
  return <span className={`ui-badge ui-badge-${variant} ${className}`.trim()} {...props} />;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "outline";
  size?: "default" | "sm";
};

export function Button({ className = "", size = "default", variant = "default", ...props }: ButtonProps) {
  return <button className={`ui-button ui-button-${variant} ui-button-${size} ${className}`.trim()} {...props} />;
}

export function Empty({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-empty ${className}`.trim()} {...props} />;
}

export function Skeleton({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-skeleton ${className}`.trim()} {...props} />;
}

export function Field({ className = "", ...props }: HTMLAttributes<HTMLLabelElement>) {
  return <label className={`ui-field ${className}`.trim()} {...props} />;
}

export function FieldLabel({ className = "", ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={`ui-field-label ${className}`.trim()} {...props} />;
}
