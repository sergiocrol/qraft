import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import type { ImageScanMetadata } from '@repo/shared-types';

import { Button } from '@/components/shared/Button';
import { Alert } from '@/components/shared/Alert';
import { useClipboard } from '@/lib/utils/useClipboard';
import { ResultDisplay } from './ResultDisplay';
import type { QRAnalysisResult } from './GenerationPage';

interface ResultsViewProps {
  images: string[];
  qrAnalysis: QRAnalysisResult | null;
  onReset: () => void;
  prompt?: string;
  /** Server-side scan verification, parallel to `images` (plan 008). */
  imagesMetadata?: ImageScanMetadata[];
}

const BRAND_CONFETTI = ['#2E49C9', '#E2512B', '#F2B63C', '#3C9E68'];

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
const countWord = (n: number) => COUNT_WORDS[n] ?? String(n);

const TIPS: { numeral: string; color: string; text: string }[] = [
  { numeral: 'i.', color: 'text-blue', text: 'Scan every code with your phone before you print or publish it.' },
  { numeral: 'ii.', color: 'text-red', text: 'Keep strong contrast — dark scene on a light QR reads best.' },
  { numeral: 'iii.', color: 'text-yellow', text: 'Leave the three corner squares clear so scanners can lock on.' },
  { numeral: 'iv.', color: 'text-green', text: 'Print at 2cm or larger for reliable close-range scans.' },
];

export const ResultsView: React.FC<ResultsViewProps> = ({
  images,
  onReset,
  qrAnalysis,
  prompt,
  imagesMetadata,
}) => {
  const { copied, copy } = useClipboard();

  useEffect(() => {
    const duration = 3 * 1000;
    const animationEnd = Date.now() + duration;
    const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 0 };

    function randomInRange(min: number, max: number) {
      return Math.random() * (max - min) + min;
    }

    const interval = setInterval(function () {
      const timeLeft = animationEnd - Date.now();

      if (timeLeft <= 0) {
        return clearInterval(interval);
      }

      const particleCount = 50 * (timeLeft / duration);

      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 },
        colors: BRAND_CONFETTI,
      });
      confetti({
        ...defaults,
        particleCount,
        origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 },
        colors: BRAND_CONFETTI,
      });
    }, 250);

    return () => clearInterval(interval);
  }, []);

  const count = images.length;

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="relative space-y-5 text-center">
        {/* confetti squares */}
        <span aria-hidden="true" className="absolute left-[12%] top-8 hidden h-3 w-3 rotate-12 border-2 border-ink bg-blue sm:block" />
        <span aria-hidden="true" className="absolute right-[14%] top-4 hidden h-2.5 w-2.5 -rotate-12 border-2 border-ink bg-yellow sm:block" />

        <span className="inline-flex items-center gap-2 rounded-full border-2 border-ink bg-green px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-paper">
          Generation complete ✓
        </span>

        <h2 className="font-serif text-4xl leading-tight text-ink md:text-5xl">
          {countWord(count)} {count === 1 ? 'artwork,' : 'artworks,'}{' '}
          <span className="marker">ready to scan.</span>
        </h2>

        <p className="mx-auto max-w-2xl text-base text-muted">
          Ordered by scan confidence — the highlighted one is your safest bet.
        </p>

        <div className="mx-auto max-w-3xl text-left">
          <Alert variant="warning">
            <p className="font-serif text-[15px] italic leading-relaxed text-ink">
              Scan before you print. Artistic transformations can break scannability — test each code
              with your phone, and regenerate any that don&apos;t read.
            </p>
          </Alert>
        </div>
      </div>

      <ResultDisplay
        images={images}
        qrAnalysis={qrAnalysis}
        isLoading={false}
        imagesMetadata={imagesMetadata}
      />

      {prompt && (
        <div className="mx-auto max-w-3xl">
          <div className="relative rounded-2xl border-2 border-ink bg-paper p-5 shadow-card">
            <span className="absolute -top-3 left-5 rounded bg-ink px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-paper">
              Prompt used
            </span>
            <div className="flex items-start justify-between gap-4">
              <p className="flex-1 font-serif text-[15px] italic leading-relaxed text-ink">
                “{prompt}”
              </p>
              <button
                onClick={() => copy(prompt)}
                className="flex-shrink-0 font-sans text-sm font-semibold text-blue underline decoration-hairline underline-offset-4 transition-colors hover:decoration-blue"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
        <Button onClick={onReset} size="lg">
          Create another set <span className="text-yellow">→</span>
        </Button>
        {prompt && (
          <Button variant="ghost" onClick={() => copy(prompt)}>
            Reuse this prompt
          </Button>
        )}
      </div>

      <div className="mx-auto max-w-3xl rounded-2xl border-2 border-ink bg-paper p-6 shadow-card">
        <h3 className="font-serif text-xl text-ink">Tips for better results</h3>
        <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          {TIPS.map((tip) => (
            <div key={tip.numeral} className="flex items-baseline gap-3">
              <span className={`font-serif text-lg italic ${tip.color}`}>{tip.numeral}</span>
              <span className="text-sm leading-relaxed text-muted">{tip.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
