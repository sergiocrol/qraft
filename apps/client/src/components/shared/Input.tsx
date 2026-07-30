import React from 'react';

import { cn } from '@/lib/utils/cn';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  /** Rendered right-aligned inside the field, e.g. a VALID badge or dice button. */
  rightSlot?: React.ReactNode;
}

export const Input: React.FC<InputProps> = ({ className, error, rightSlot, ...props }) => {
  return (
    <div className="relative">
      <input
        className={cn(
          'w-full rounded-[10px] border-2 border-ink bg-paper px-4 py-3 text-[15px] text-ink',
          'placeholder:text-faint focus:border-blue focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          'transition-colors duration-150',
          error && 'border-red focus:border-red',
          rightSlot && 'pr-20',
          className
        )}
        {...props}
      />
      {rightSlot && (
        <div className="absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {rightSlot}
        </div>
      )}
    </div>
  );
};
