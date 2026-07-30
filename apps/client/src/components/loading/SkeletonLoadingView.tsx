import React from 'react';

const SkeletonLoadingView: React.FC = () => {
  return (
    <div className="animate-pulse">
      {/* Header skeleton */}
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 h-8 w-64 rounded-lg bg-hairline"></div>
        <div className="mx-auto mb-3 h-4 w-80 rounded-full bg-hairline"></div>
        <div className="mx-auto h-4 w-72 rounded-full bg-hairline"></div>
      </div>

      {/* Content skeleton */}
      <div className="space-y-8">
        <div className="space-y-6">
          <div className="h-16 w-full rounded-2xl border-2 border-hairline bg-cream"></div>
          <div className="h-40 w-full rounded-2xl border-2 border-hairline bg-cream"></div>
        </div>

        {/* Options grid skeleton */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          {[...Array(6)].map((_, i) => (
            <div
              key={i}
              className="h-20 rounded-xl bg-hairline"
              style={{ animationDelay: `${i * 100}ms` }}
            ></div>
          ))}
        </div>

        {/* Action button skeleton */}
        <div className="flex justify-center pt-4">
          <div className="h-14 w-56 rounded-xl bg-hairline"></div>
        </div>
      </div>

      {/* Loading indicator — three squares */}
      <div className="mt-8 flex items-center justify-center gap-2">
        <div className="h-3 w-3 border-2 border-ink bg-blue [animation-delay:-0.3s]"></div>
        <div className="h-3 w-3 border-2 border-ink bg-red [animation-delay:-0.15s]"></div>
        <div className="h-3 w-3 border-2 border-ink bg-yellow"></div>
      </div>
    </div>
  );
};

export default SkeletonLoadingView;
