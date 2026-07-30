import React from 'react';

interface StatusErrorViewProps {
  onRetry?: () => void;
  error?: string | null;
}

const RECOVERY: { numeral: string; color: string; text: string }[] = [
  { numeral: 'i.', color: 'text-blue', text: 'Check your internet connection.' },
  { numeral: 'ii.', color: 'text-red', text: 'Refresh the page.' },
  { numeral: 'iii.', color: 'text-yellow', text: 'Wait a few moments, then retry.' },
];

const StatusErrorView: React.FC<StatusErrorViewProps> = ({
  onRetry,
  error = 'Unable to connect to the service',
}) => {
  return (
    <div className="mx-auto max-w-lg space-y-6 text-center">
      <div className="flex justify-center">
        <div className="flex h-20 w-20 animate-pulse-dot items-center justify-center rounded-full border-2 border-ink bg-red">
          <span className="font-serif text-4xl leading-none text-paper">!</span>
        </div>
      </div>

      <h2 className="font-serif text-3xl text-ink md:text-4xl">
        Service <span className="italic text-red">unavailable.</span>
      </h2>

      <p className="mx-auto max-w-md leading-relaxed text-muted">
        We&apos;re having trouble reaching the engine right now.
      </p>

      {error && (
        <div className="mx-auto max-w-md rounded-xl border-2 border-ink bg-paper p-4 text-left shadow-card">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-red">Error details</p>
          <p className="mt-1 text-sm text-muted">{error}</p>
        </div>
      )}

      <div className="mx-auto max-w-md rounded-xl border-2 border-dashed border-ink bg-paper p-4 text-left">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
          What you can do
        </p>
        <div className="space-y-1.5">
          {RECOVERY.map((item) => (
            <p key={item.numeral} className="text-sm text-muted">
              <span className={`mr-1.5 font-serif italic ${item.color}`}>{item.numeral}</span>
              {item.text}
            </p>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center justify-center gap-4 pt-2 sm:flex-row">
        {onRetry && (
          <button
            onClick={onRetry}
            className="inline-flex items-center justify-center rounded-xl border-2 border-ink bg-red px-7 py-3 font-serif text-base text-paper shadow-press transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-red-hover hover:shadow-press-sm"
          >
            Try again <span className="ml-2 text-yellow">→</span>
          </button>
        )}

        <button
          onClick={() => window.location.reload()}
          className="font-sans text-sm font-semibold text-ink underline decoration-hairline underline-offset-4 transition-colors hover:text-blue hover:decoration-blue"
        >
          Refresh page
        </button>
      </div>
    </div>
  );
};

export default StatusErrorView;
