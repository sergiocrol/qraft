import React from 'react';

import { cn } from '@/lib/utils/cn';
import '@/styles/slider.css';

interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  info?: string;
  variant?: 'default' | 'compact';
}

export const Slider: React.FC<SliderProps> = ({
  className,
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  showValue = true,
  info,
  variant = 'default',
  disabled = false,
  ...props
}) => {
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className={cn('space-y-2', className)}>
      {(label || showValue) && (
        <div className="flex items-center justify-between">
          {label && (
            <label className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
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
            </label>
          )}
          {showValue && (
            <span className="font-sans text-[13px] font-semibold tabular-nums text-blue">
              {value}
            </span>
          )}
        </div>
      )}

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className={cn('slider-input h-1.5 w-full cursor-pointer rounded-full border-2 border-ink', disabled && 'cursor-not-allowed opacity-50')}
        style={{
          background: disabled
            ? '#E3D9C4'
            : `linear-gradient(to right, #2E49C9 0%, #2E49C9 ${percentage}%, #FFFCF4 ${percentage}%, #FFFCF4 100%)`,
        }}
        {...props}
      />

      {variant === 'default' && (
        <div className="flex justify-between text-[11px] text-faint">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      )}
    </div>
  );
};
