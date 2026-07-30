import React from 'react';
import type { ViewState } from '../generation/GenerationPage';

import { HeaderBranding } from './HeaderBranding';

interface SimplifiedHeaderProps {
  viewState: ViewState | null;
  className?: string;
  engineReady?: boolean;
}

export const SimplifiedHeader: React.FC<SimplifiedHeaderProps> = ({
  className = '',
  engineReady,
}) => {
  return (
    <header className={`mb-8 ${className}`}>
      <HeaderBranding engineReady={engineReady} />
    </header>
  );
};
