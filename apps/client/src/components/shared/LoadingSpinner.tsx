import React from 'react';

import { cn } from '@/lib/utils/cn';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  label?: string;
}

// Three floating squares (blue / red / yellow) with staggered floatSoft.
export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  size = 'md',
  className,
  label,
}) => {
  const sizes = {
    sm: 'h-2.5 w-2.5',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
    xl: 'h-6 w-6',
  };

  const square = sizes[size];

  return (
    <div className={cn('flex flex-col items-center justify-center gap-4', className)}>
      <div className="flex items-end gap-2">
        <span className={cn(square, 'animate-float-soft border-2 border-ink bg-blue')} />
        <span
          className={cn(square, 'animate-float-soft border-2 border-ink bg-red')}
          style={{ animationDelay: '0.4s' }}
        />
        <span
          className={cn(square, 'animate-float-soft border-2 border-ink bg-yellow')}
          style={{ animationDelay: '0.8s' }}
        />
      </div>
      {label && <p className="font-serif text-[15px] italic text-faint">{label}</p>}
    </div>
  );
};
