import React, { useState } from 'react';

interface CancelGenerationButtonProps {
  onCancel: () => void | Promise<void>;
}

export const CancelGenerationButton: React.FC<CancelGenerationButtonProps> = ({ onCancel }) => {
  const [isCancelling, setIsCancelling] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleConfirmCancel = async () => {
    setIsCancelling(true);
    await onCancel();
  };

  return (
    <div className="flex w-full justify-center pt-2">
      {isCancelling ? (
        <div className="flex items-center justify-center gap-3 px-6 py-4">
          <span
            className="h-4 w-4 animate-spin border-2 border-red border-t-transparent"
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-red">Stopping the generation…</span>
        </div>
      ) : !showConfirm ? (
        <button
          onClick={() => setShowConfirm(true)}
          className="group inline-flex items-center gap-2 font-sans text-sm font-semibold text-muted underline decoration-hairline underline-offset-4 transition-colors hover:text-red hover:decoration-red"
        >
          <span
            aria-hidden="true"
            className="h-3 w-3 border-2 border-current transition-colors"
          />
          Stop this generation?
        </button>
      ) : (
        <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-red bg-paper p-5 shadow-card sm:flex-row sm:justify-between">
          <div>
            <p className="font-serif text-lg text-ink">Stop this generation?</p>
            <p className="text-sm text-muted">You&apos;ll be able to start a new one right away.</p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-3">
            <button
              onClick={() => setShowConfirm(false)}
              className="font-sans text-sm font-semibold text-ink underline decoration-hairline underline-offset-4 transition-colors hover:text-blue hover:decoration-blue"
            >
              Keep going
            </button>
            <button
              onClick={handleConfirmCancel}
              className="inline-flex items-center justify-center rounded-xl border-2 border-ink bg-red px-5 py-2 font-serif text-[15px] text-paper shadow-press-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-red-hover hover:shadow-none"
            >
              Stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
