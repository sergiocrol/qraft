import React from 'react';
import type { ViewState } from '../generation/GenerationPage';

import { HeaderBranding } from './HeaderBranding';

interface StickyHeaderProps {
  viewState: ViewState | null;
  isVisible: boolean;
  engineReady?: boolean;
}

export const StickyHeader: React.FC<StickyHeaderProps> = ({ isVisible, engineReady }) => {
  return (
    <div
      className={`fixed left-0 right-0 top-0 z-50 transition-transform duration-300 ease-in-out ${
        isVisible ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="border-b-2 border-ink bg-paper/95">
        <div className="container mx-auto px-4 py-3">
          <HeaderBranding engineReady={engineReady} />
        </div>
      </div>
    </div>
  );
};
