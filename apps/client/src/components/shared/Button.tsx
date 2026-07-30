import React from 'react';

import { cn } from '@/lib/utils/cn';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * primary — red act button (serif label, offset press shadow)
   * solid   — ink button, hover fills blue
   * outline — paper bordered button, hover fills yellow
   * ghost   — text link, hairline underline → blue on hover
   * danger  — red like primary, smaller shadow (use size="sm")
   */
  variant?: 'primary' | 'solid' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  ...props
}) => {
  const base =
    'inline-flex items-center justify-center gap-2 transition-all duration-150 focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none';

  const variants = {
    primary:
      'border-2 border-ink bg-red text-paper font-serif rounded-xl shadow-press hover:bg-red-hover hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-press-sm active:translate-x-[3px] active:translate-y-[3px] active:shadow-none',
    danger:
      'border-2 border-ink bg-red text-paper font-serif rounded-xl shadow-press-sm hover:bg-red-hover hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none',
    solid:
      'border-2 border-ink bg-ink text-cream font-serif rounded-xl shadow-press hover:bg-blue hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-press-sm',
    outline:
      'border-2 border-ink bg-paper text-ink font-sans font-semibold rounded-xl hover:bg-yellow',
    ghost:
      'bg-transparent text-ink font-sans font-semibold underline decoration-hairline underline-offset-4 hover:text-blue hover:decoration-blue',
  } as const;

  const sizes = {
    sm: 'px-4 py-2 text-[13px]',
    md: 'px-5 py-2.5 text-[15px]',
    lg: 'px-7 py-3.5 text-base',
  } as const;

  const isGhost = variant === 'ghost';

  return (
    <button
      className={cn(base, variants[variant], !isGhost && sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && (
        <span
          className="h-4 w-4 animate-spin border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
};
