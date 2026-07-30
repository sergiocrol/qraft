import React from 'react';

import { cn } from '@/lib/utils/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  hoverable?: boolean;
  onClick?: () => void;
  /** Ink tab chip overlapping the top border, e.g. "YOUR PROMPT". */
  label?: string;
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  hoverable = false,
  onClick,
  label,
}) => {
  return (
    <div
      className={cn(
        'relative rounded-2xl border-2 border-ink bg-paper shadow-card',
        hoverable && 'cursor-pointer transition-transform duration-200 hover:-translate-y-0.5',
        className
      )}
      onClick={onClick}
    >
      {label && (
        <span className="absolute -top-3 left-5 rounded bg-ink px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-paper">
          {label}
        </span>
      )}
      {children}
    </div>
  );
};

export const CardHeader: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  return <div className={cn('border-b border-hairline px-6 py-4', className)}>{children}</div>;
};

export const CardContent: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  return <div className={cn('px-6 py-4', className)}>{children}</div>;
};

export const CardFooter: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => {
  return <div className={cn('border-t border-hairline px-6 py-4', className)}>{children}</div>;
};
