import React from 'react';

import { STAGING_BANNER_MESSAGE } from '@/lib/constants';

interface PageLayoutProps {
  children: React.ReactNode;
  staging?: boolean;
  header?: React.ReactNode;
  /** Rendered above the card, e.g. <ErrorBanner message={...} onDismiss={...} /> */
  errorSlot?: React.ReactNode;
}

export const PageLayout: React.FC<PageLayoutProps> = ({
  children,
  staging = false,
  header,
  errorSlot,
}) => {
  return (
    <main className="relative min-h-screen bg-cream">
      <div className="container relative z-10 mx-auto px-4 py-8">
        {staging && (
          <div className="mx-auto mb-4 max-w-4xl rounded-xl border border-dashed border-ink bg-yellow/45 px-4 py-2 text-center">
            <span className="font-serif text-[15px] italic text-ink">{STAGING_BANNER_MESSAGE}</span>
          </div>
        )}

        {header}

        <div className="mx-auto max-w-4xl">
          {errorSlot}
          <div className="rounded-2xl border-2 border-ink bg-paper shadow-card">
            <div className="p-8 md:p-12">{children}</div>
          </div>
        </div>
      </div>
    </main>
  );
};
