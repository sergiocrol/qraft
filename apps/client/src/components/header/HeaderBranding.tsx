import React from 'react';
import { Github } from '../shared/icons/Github';
import { Linkedin } from '../shared/icons/Linkedin';

interface HeaderBrandingProps {
  className?: string;
  /** Show a green "Engine ready" pill (fed by the page's endpoint status). */
  engineReady?: boolean;
}

export const HeaderBranding: React.FC<HeaderBrandingProps> = ({
  className = '',
  engineReady,
}) => {
  return (
    <div className={`flex w-full items-center justify-between ${className}`}>
      <div className="flex w-auto items-center gap-3">
        {/* Logo: ink finder square + red core + offset yellow square */}
        <div className="relative h-10 w-10 shrink-0 border-[3px] border-ink bg-paper">
          <div className="absolute left-1/2 top-1/2 h-1/3 w-1/3 -translate-x-1/2 -translate-y-1/2 bg-red" />
          <div className="absolute -bottom-1.5 -right-1.5 h-3 w-3 border-2 border-ink bg-yellow" />
        </div>

        {/* Wordmark */}
        <h1 className="font-serif text-2xl leading-none text-ink">
          Qraft<span className="italic text-red">.ai</span>
        </h1>

        {engineReady && (
          <span className="ml-1 hidden items-center gap-1.5 rounded-full border-2 border-ink bg-paper px-2.5 py-1 text-[11px] font-semibold text-ink sm:inline-flex">
            <span className="h-2 w-2 animate-pulse-dot rounded-full bg-green" />
            Engine ready
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <a
          href="https://www.linkedin.com/in/sergio-cordero-rol/"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ink bg-paper text-ink transition-colors hover:bg-yellow"
          aria-label="View LinkedIn profile"
        >
          <Linkedin className="size-5" />
        </a>
        <a
          href="https://github.com/sergiocrol/qraft"
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-ink bg-paper text-ink transition-colors hover:bg-yellow"
          aria-label="View source on GitHub"
        >
          <Github className="size-5" />
        </a>
      </div>
    </div>
  );
};
