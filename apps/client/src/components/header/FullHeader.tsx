import { forwardRef } from 'react';

export const FullHeader = forwardRef<HTMLElement>((_props, ref) => {
  return (
    <header ref={ref} className="relative mb-14 text-center">
      {/* confetti squares near the display heading */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-[14%] top-2 hidden h-3 w-3 rotate-12 bg-blue sm:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-[16%] top-0 hidden h-2.5 w-2.5 -rotate-12 bg-red sm:block"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-[22%] top-16 hidden h-2 w-2 rotate-6 bg-yellow md:block"
      />

      <p className="mb-4 font-sans text-[11px] font-bold uppercase tracking-[0.16em] text-faint">
        Scannable art, on demand
      </p>

      <h1 className="mx-auto max-w-3xl font-serif text-5xl leading-[1.08] text-ink md:text-[58px]">
        Make a code worth <span className="marker">staring at.</span>
      </h1>

      <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-muted">
        A URL in, a scene described — and out comes scannable art, painted around your QR code by a
        diffusion model.
      </p>
    </header>
  );
});

FullHeader.displayName = 'FullHeader';
