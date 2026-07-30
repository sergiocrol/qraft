import React from 'react';

import { cn } from '@/lib/utils/cn';

interface AlertProps {
  variant?: 'info' | 'success' | 'warning' | 'error';
  children: React.ReactNode;
  className?: string;
  onClose?: () => void;
}

export const Alert: React.FC<AlertProps> = ({ variant = 'info', children, className, onClose }) => {
  const variants = {
    // yellow wash, dashed ink border, italic serif ink text
    warning: 'border border-dashed border-ink bg-yellow/45 font-serif italic text-ink',
    error: 'border-2 border-red bg-paper text-ink',
    success: 'border-2 border-green bg-paper text-ink',
    info: 'border-2 border-blue bg-paper text-ink',
  } as const;

  return (
    <div className={cn('relative flex items-start gap-3 rounded-xl p-4', variants[variant], className)}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button
          onClick={onClose}
          aria-label="Dismiss"
          className="ml-2 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border-2 border-ink font-serif leading-none transition-colors hover:bg-yellow"
        >
          ×
        </button>
      )}
    </div>
  );
};
