import React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

interface CheckboxProps {
  label?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  info?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({
  className,
  label,
  checked,
  onChange,
  info,
  disabled = false,
  id,
}) => {
  return (
    <div className={cn('space-y-2', className)}>
      <label
        htmlFor={id}
        className={cn(
          'flex items-center gap-2.5',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
        )}
      >
        <span className="relative inline-flex">
          <input
            id={id}
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
            disabled={disabled}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded-[6px] border-2 border-ink transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-blue peer-focus-visible:ring-offset-2',
              checked ? 'bg-blue' : 'bg-paper'
            )}
          >
            {checked && <Check className="h-3.5 w-3.5 text-paper" strokeWidth={3} />}
          </span>
        </span>

        {label && (
          <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
            {label}
            {info && (
              <span className="group relative inline-flex">
                <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border-2 border-dash font-serif text-[11px] italic text-faint">
                  i
                </span>
                <span className="pointer-events-none absolute bottom-6 left-0 z-10 hidden w-64 rounded-xl border-2 border-ink bg-paper p-3 text-xs leading-relaxed text-muted shadow-card group-hover:block">
                  {info}
                </span>
              </span>
            )}
          </span>
        )}
      </label>
    </div>
  );
};
