import React from 'react';
import { cn } from '@/lib/utils/cn';

import { type IconProps } from './types';

export const Linkedin: React.FC<IconProps> = ({ className = '', size = 24, ...svgProps }) => {
  const defaultProps = {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2',
  };

  const props = {
    ...defaultProps,
    ...svgProps,
  };

  return (
    <svg {...props} className={cn('size-6 shrink-0', className)}>
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <path d="M2 9h4v12H2z" />
      <path d="M4 4a2 2 0 1 0 0 4 2 2 0 1 0 0-4z" />
    </svg>
  );
};
