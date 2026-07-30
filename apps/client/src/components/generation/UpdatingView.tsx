import React from 'react';

interface UpdatingViewProps {
  isScalingUp?: boolean;
}

export const UpdatingView: React.FC<UpdatingViewProps> = ({ isScalingUp = true }) => {
  const squares = isScalingUp
    ? ['bg-blue', 'bg-red', 'bg-yellow']
    : ['bg-dash', 'bg-dash', 'bg-dash'];

  const checklist = isScalingUp
    ? [
        { color: 'bg-green', delay: '0s', text: 'Loading the AI models…' },
        { color: 'bg-blue', delay: '0.4s', text: 'Initializing GPU resources…' },
        { color: 'bg-yellow', delay: '0.8s', text: 'Preparing the generation pipeline…' },
      ]
    : [
        { color: 'bg-red', delay: '0s', text: 'Completing active jobs…' },
        { color: 'bg-dash', delay: '0.4s', text: 'Releasing GPU resources…' },
        { color: 'bg-faint', delay: '0.8s', text: 'Shutting down safely…' },
      ];

  return (
    <div className="mx-auto max-w-lg space-y-6 text-center">
      <div className="flex items-end justify-center gap-2.5">
        {squares.map((color, i) => (
          <span
            key={i}
            className={`h-4 w-4 animate-float-soft border-2 border-ink ${color}`}
            style={{ animationDelay: `${i * 0.4}s` }}
          />
        ))}
      </div>

      <h3 className="font-serif text-3xl text-ink md:text-4xl">
        {isScalingUp ? (
          <>
            Warming up the <span className="marker">studio.</span>
          </>
        ) : (
          <>
            Powering <span className="marker">down.</span>
          </>
        )}
      </h3>

      <span
        className={`inline-flex items-center gap-2 rounded-full border-2 border-ink px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] ${
          isScalingUp ? 'bg-yellow text-ink' : 'bg-paper text-ink'
        }`}
      >
        {isScalingUp ? '7–10 minutes' : '1–2 minutes'}
      </span>

      <p className="mx-auto max-w-md leading-relaxed text-muted">
        {isScalingUp
          ? 'The engine is starting up — loading the models and initializing the system.'
          : 'The engine is scaling down to save resources. This completes safely in a minute or two.'}
      </p>

      <div className="rounded-2xl border-2 border-ink bg-paper p-5 text-left shadow-card">
        <ul className="space-y-3">
          {checklist.map((item) => (
            <li key={item.text} className="flex items-center gap-3">
              <span
                className={`h-2.5 w-2.5 flex-shrink-0 animate-pulse-dot rounded-full ${item.color}`}
                style={{ animationDelay: item.delay }}
              />
              <span className="text-sm text-muted">{item.text}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="font-serif text-[15px] italic text-faint">
        {isScalingUp
          ? 'This page updates itself when the studio opens.'
          : 'The engine will be available again when you request it.'}
      </p>
    </div>
  );
};
