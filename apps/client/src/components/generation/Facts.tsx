import React from 'react';
import {
  Brush,
  Camera,
  Clock,
  Cpu,
  Cross,
  Database,
  Gift,
  Globe,
  Heart,
  History,
  Lightbulb,
  Maximize,
  Palette,
  Rocket,
  Shield,
  UtensilsCrossed,
  Zap,
} from 'lucide-react';

interface Fact {
  title: string;
  content: string;
  icon: string;
}

interface FactsSectionProps {
  currentFact: Fact;
  factTransition: boolean;
  factNumber: number;
  factCount: number;
}

const iconMap = {
  history: History,
  camera: Camera,
  database: Database,
  shield: Shield,
  globe: Globe,
  palette: Palette,
  zap: Zap,
  cpu: Cpu,
  lightbulb: Lightbulb,
  rocket: Rocket,
  heart: Heart,
  utensils: UtensilsCrossed,
  maximize: Maximize,
  gift: Gift,
  brush: Brush,
  cross: Cross,
  clock: Clock,
} as const;

export const FactsSection: React.FC<FactsSectionProps> = ({
  currentFact,
  factTransition,
  factNumber,
  factCount,
}) => {
  const ThemeIcon = iconMap[currentFact.icon as keyof typeof iconMap] || Lightbulb;

  return (
    <div className="relative -rotate-[0.5deg] overflow-hidden rounded-2xl border-2 border-ink bg-paper p-6 shadow-card">
      <div className="flex min-h-[8.5rem] items-center sm:min-h-[7rem]">
        <div
          className={`relative w-full transition-all duration-500 ease-in-out ${
            factTransition ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
          }`}
        >
          {/* theme watermark — bleeds off the card edge, swaps with the fact */}
          <ThemeIcon
            aria-hidden="true"
            strokeWidth={1.25}
            className="pointer-events-none absolute -right-8 -top-10 h-40 w-40 rotate-[9deg] text-ink opacity-[0.06]"
          />

          <div className="relative">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 flex-shrink-0 -rotate-3 items-center justify-center rounded-xl border-2 border-ink bg-cream shadow-press-sm">
                <ThemeIcon className="h-5 w-5 text-ink" strokeWidth={2} aria-hidden="true" />
              </span>
              <span className="inline-block rounded-full border-2 border-ink bg-yellow px-3 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink">
                Did you know
              </span>
              <span className="ml-auto whitespace-nowrap font-serif text-[13px] italic text-faint">
                № {String(factNumber).padStart(2, '0')} / {factCount}
              </span>
            </div>
            <h4 className="mt-3.5 font-serif text-xl leading-snug text-ink">
              {currentFact.title}
            </h4>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">{currentFact.content}</p>
          </div>
        </div>
      </div>
    </div>
  );
};
