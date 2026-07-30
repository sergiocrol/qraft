import React, { useState } from 'react';

import { Popover } from '@/components/shared/Popover';
import { cn } from '@/lib/utils/cn';
import { useClipboard } from '@/lib/utils/useClipboard';

interface QRExample {
  prompt: string;
  imageUrl: string;
  tip?: string;
}

interface InspirationSectionProps {
  currentExample: QRExample;
  exampleTransition: boolean;
  exampleProgress: number;
}

const ImageSkeleton = ({ className }: { className?: string }) => (
  <div className={cn('animate-pulse rounded-lg border-2 border-hairline bg-hairline', className)} />
);

export const InspirationSection: React.FC<InspirationSectionProps> = ({
  currentExample,
  exampleTransition,
  exampleProgress,
}) => {
  const { copied, copy } = useClipboard();
  const [isImageLoading, setIsImageLoading] = useState(true);
  const [isPopoverImageLoading, setIsPopoverImageLoading] = useState(true);

  const copyPrompt = () => copy(currentExample?.prompt ?? '');

  React.useEffect(() => {
    setIsImageLoading(true);
    setIsPopoverImageLoading(true);
  }, [currentExample.imageUrl]);

  const handleImageLoad = () => setIsImageLoading(false);
  const handlePopoverImageLoad = () => setIsPopoverImageLoading(false);

  return (
    <div className="relative min-h-[300px] overflow-hidden rounded-2xl border-2 border-ink bg-paper shadow-card sm:min-h-60 rotate-[0.5deg]">
      {/* rotation progress — thin blue line */}
      <div className="relative h-1 w-full bg-hairline">
        <div
          className="h-full bg-blue transition-all duration-100 ease-linear"
          style={{ width: `${exampleProgress * 100}%` }}
        />
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <div
          className={`transition-all duration-500 ease-in-out ${
            exampleTransition ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}
        >
          <div className="flex flex-col gap-4 md:flex-row lg:gap-6">
            <div className="flex flex-shrink-0 justify-center lg:justify-start">
              <Popover
                content={
                  <div className="text-center">
                    <div className="relative">
                      {isPopoverImageLoading && (
                        <div className="absolute inset-0 z-10">
                          <ImageSkeleton className="h-80 w-80" />
                        </div>
                      )}
                      <img
                        src={currentExample.imageUrl}
                        alt="Example QR Code (Large)"
                        className={cn(
                          'h-80 w-80 rounded-lg border-2 border-ink object-cover transition-opacity duration-300',
                          isPopoverImageLoading ? 'opacity-0' : 'opacity-100'
                        )}
                        loading="lazy"
                        onLoad={handlePopoverImageLoad}
                        onError={handlePopoverImageLoad}
                      />
                    </div>
                    <p className="mt-3 font-serif text-sm italic text-faint">Full-size preview</p>
                  </div>
                }
                position="right"
                trigger="hover"
              >
                <div className="group relative cursor-pointer">
                  {isImageLoading && (
                    <div className="absolute inset-0 z-10">
                      <ImageSkeleton className="h-40 w-40 sm:h-44 sm:w-44" />
                    </div>
                  )}

                  <img
                    src={currentExample.imageUrl}
                    alt="Example QR"
                    className={cn(
                      'h-40 w-40 rounded-lg border-2 border-ink object-cover transition-transform duration-300 group-hover:-translate-y-0.5 sm:h-44 sm:w-44',
                      isImageLoading ? 'opacity-0' : 'opacity-100'
                    )}
                    loading="eager"
                    onLoad={handleImageLoad}
                    onError={handleImageLoad}
                  />
                </div>
              </Popover>
            </div>

            <div className="w-full space-y-3 sm:space-y-4 lg:flex-1">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-blue">
                From the gallery
              </p>

              <p className="font-serif text-[15px] italic leading-relaxed text-ink line-clamp-4 sm:line-clamp-none">
                “{currentExample.prompt}”
              </p>

              <button
                onClick={copyPrompt}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border-2 border-ink px-3 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] transition-colors',
                  copied ? 'bg-green text-paper' : 'bg-yellow text-ink hover:bg-yellow/80'
                )}
                title="Copy prompt"
              >
                {copied ? 'Copied ✓' : 'Copy prompt'}
              </button>

              {currentExample.tip && (
                <p className="font-serif text-[13px] italic text-faint">
                  <span className="not-italic text-red">Tip</span> — {currentExample.tip}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
