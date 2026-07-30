import React, { useState, useEffect } from 'react';

import { cn } from '@/lib/utils/cn';
import type { QRExample } from '@/lib/api/types';

import { CancelGenerationButton } from '@/components/generation/CancelGenerationButton';
import { FactsSection } from '@/components/generation/Facts';
import { InspirationSection } from '@/components/generation/Inspiration';
import { Card } from '@/components/shared/Card';
import { Divider } from '@/components/shared/Divider';

import { galleryService } from '@/services/GalleryService';
import { GALLERY_EXAMPLES_COUNT } from '@/lib/constants';

import funFacts from 'public/examples/fun-facts.json';
interface ProcessingViewProps {
  prompt: string;
  progress: number;
  message?: string;
  onCancel?: () => void;
}

const STAGES = [
  { label: 'Initialization', end: 35 },
  { label: 'Generation', end: 70 },
  { label: 'Finalization', end: 100 },
] as const;

export const ProcessingView: React.FC<ProcessingViewProps> = ({
  prompt,
  progress,
  message,
  onCancel,
}) => {
  const [maxSeenProgress, setMaxSeenProgress] = useState(0);
  const [smoothProgress, setSmoothProgress] = useState(0);
  const [currentFactIndex, setCurrentFactIndex] = useState(0);
  const [examples, setExamples] = useState<QRExample[]>([]);
  const [currentExampleIndex, setCurrentExampleIndex] = useState(0);
  const [factTransition, setFactTransition] = useState(true);
  const [exampleTransition, setExampleTransition] = useState(true);
  const [exampleProgress, setExampleProgress] = useState(0);

  const facts = funFacts.facts;

  useEffect(() => {
    if (progress > maxSeenProgress) {
      setMaxSeenProgress(progress);
    }
  }, [progress, maxSeenProgress]);

  useEffect(() => {
    const mapProgress = (actual: number): number => {
      if (actual <= 45) {
        return (actual / 45) * 60;
      } else if (actual < 100) {
        return 60 + ((actual - 45) / 55) * 35;
      } else {
        return 100;
      }
    };

    const targetProgress = mapProgress(maxSeenProgress);

    if (targetProgress > smoothProgress) {
      const interval = setInterval(() => {
        setSmoothProgress((prev) => {
          if (prev >= targetProgress) {
            return targetProgress;
          }
          const diff = targetProgress - prev;
          const increment = Math.max(diff * 0.08, 0.3);
          return Math.min(prev + increment, targetProgress);
        });
      }, 50);

      return () => clearInterval(interval);
    }
  }, [maxSeenProgress, smoothProgress]);

  useEffect(() => {
    const factInterval = setInterval(() => {
      setFactTransition(false);
      setTimeout(() => {
        setCurrentFactIndex((prev) => {
          if (facts.length <= 1) return prev;
          let randomIndex;
          do {
            randomIndex = Math.floor(Math.random() * facts.length);
          } while (randomIndex === prev);
          return randomIndex;
        });
        setFactTransition(true);
      }, 200);
    }, 13000);

    return () => clearInterval(factInterval);
  }, []);

  // Real past generations, straight from the S3 records. When the API can't
  // provide any, the inspiration card simply stays hidden.
  useEffect(() => {
    let cancelled = false;

    galleryService
      .getExamples(GALLERY_EXAMPLES_COUNT)
      .then((fetched) => {
        if (!cancelled && fetched.length > 0) {
          setCurrentExampleIndex(Math.floor(Math.random() * fetched.length));
          setExamples(fetched);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (examples.length === 0) return;

    setExampleProgress(0);

    const progressInterval = setInterval(() => {
      setExampleProgress((prev) => {
        const increment = 1 / 200;
        return prev >= 1 ? 0 : prev + increment;
      });
    }, 100);

    const exampleInterval = setInterval(() => {
      setExampleTransition(false);
      setExampleProgress(0);
      setTimeout(() => {
        setCurrentExampleIndex((prev) => {
          if (examples.length <= 1) return prev;
          let randomIndex;
          do {
            randomIndex = Math.floor(Math.random() * examples.length);
          } while (randomIndex === prev);
          return randomIndex;
        });
        setExampleTransition(true);
      }, 200);
    }, 20000);

    return () => {
      clearInterval(exampleInterval);
      clearInterval(progressInterval);
    };
  }, [examples]);

  const currentFact = facts[currentFactIndex];
  const currentExample: QRExample | null = examples[currentExampleIndex] ?? null;

  const getDisplayMessage = (msg: string | undefined): string => {
    if (!msg) return `Processing… ${Math.round(smoothProgress)}%`;

    if (msg.includes('Status check failed') || msg.includes('retrying')) {
      if (smoothProgress < 40) {
        return 'Setting up the canvas…';
      } else if (smoothProgress < 70) {
        return 'Painting your scene around the code…';
      } else {
        return 'Adding the final brushstrokes…';
      }
    }

    if (msg.includes('Processing via API Gateway')) {
      return 'Painting your scene around the code…';
    }

    return msg;
  };

  const displayMessage = getDisplayMessage(message);

  const stageStatus = (index: number): 'done' | 'active' | 'pending' => {
    const start = index === 0 ? 0 : STAGES[index - 1].end;
    if (smoothProgress >= STAGES[index].end) return 'done';
    if (smoothProgress >= start) return 'active';
    return 'pending';
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="flex flex-col items-center space-y-7">
        {/* developing artwork */}
        <div className="relative">
          <div className="rounded-xl border-2 border-ink bg-paper p-3 shadow-hero">
            <div className="grid h-40 w-40 grid-cols-6 gap-1">
              {Array.from({ length: 36 }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-[2px] transition-colors duration-300',
                    Math.random() > 0.4 ? 'animate-pulse-dot bg-ink' : 'bg-hairline'
                  )}
                  style={{ animationDelay: `${i * 80}ms` }}
                />
              ))}
            </div>
          </div>
          <span className="absolute -right-3 -top-3 -rotate-[5deg] border-2 border-ink bg-yellow px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink">
            Developing
          </span>
        </div>

        <div className="space-y-4 text-center">
          <h2 className="font-serif text-4xl leading-tight text-ink md:text-5xl">
            Now <span className="marker">painting</span> your code.
          </h2>
        </div>

        {/* stage pills */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {STAGES.map((stage, i) => {
            const status = stageStatus(i);
            return (
              <span
                key={stage.label}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em]',
                  status === 'done' && 'border-ink bg-green text-paper',
                  status === 'active' && 'animate-float-soft border-ink bg-yellow text-ink',
                  status === 'pending' && 'border-dashed border-dash bg-paper text-faint'
                )}
              >
                <span aria-hidden="true">
                  {status === 'done' ? '✓' : status === 'active' ? '●' : '○'}
                </span>
                {stage.label}
              </span>
            );
          })}
        </div>

        {/* progress bar */}
        <div className="w-full max-w-md space-y-3">
          <div className="flex items-center gap-3">
            <div className="relative h-5 flex-1 overflow-hidden rounded-full border-2 border-ink bg-paper">
              <div
                className="h-full border-r-2 border-ink bg-blue transition-[width] duration-1000 ease-out"
                style={{ width: `${smoothProgress}%` }}
              />
            </div>
            <span className="font-serif text-2xl leading-none text-ink">
              {Math.round(smoothProgress)}
              <span className="text-red">%</span>
            </span>
          </div>
          <p className="text-center font-serif text-[15px] italic text-muted">{displayMessage}</p>
        </div>

        {/* prompt */}
        <Card label="Your prompt" className="w-full max-w-md">
          <p className="px-5 py-4 font-serif text-[15px] italic leading-relaxed text-ink">
            “{prompt}”
          </p>
        </Card>

        {onCancel && <CancelGenerationButton onCancel={onCancel} />}
      </div>

      <Divider text="while you wait" />

      <FactsSection
        currentFact={currentFact}
        factTransition={factTransition}
        factNumber={currentFactIndex + 1}
        factCount={facts.length}
      />

      {currentExample && (
        <InspirationSection
          currentExample={currentExample}
          exampleTransition={exampleTransition}
          exampleProgress={exampleProgress}
        />
      )}
    </div>
  );
};
