import React from 'react';

import { Alert } from '@/components/shared/Alert';

interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  title?: string;
}

export const ErrorBanner: React.FC<ErrorBannerProps> = ({
  message,
  onDismiss,
  title = 'Something went wrong',
}) => {
  return (
    <div className="mb-8">
      <Alert variant="error" onClose={onDismiss}>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-red">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{message}</p>
      </Alert>
    </div>
  );
};
