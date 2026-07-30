import React, { useState } from 'react';

import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { Alert } from '@/components/shared/Alert';

import { getApiErrorMessage } from '@/lib/api/errors';
import { endpointService, type EndpointEnvironment } from '@/services/EndpointService';

interface WakeEndpointFormProps {
  onActivationRequested: () => void;
  activationRequested: boolean;
  environment?: EndpointEnvironment;
}

const CHECKLIST: { color: string; delay: string; text: string }[] = [
  { color: 'bg-blue', delay: '0s', text: 'The studio manager gets your note by email.' },
  { color: 'bg-red', delay: '0.4s', text: 'They start the engine — usually within 1–2 hours.' },
  { color: 'bg-yellow', delay: '0.8s', text: 'This page unlocks the moment it is ready.' },
];

export const WakeEndpointForm: React.FC<WakeEndpointFormProps> = ({
  onActivationRequested,
  activationRequested,
  environment = 'production',
}) => {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      await endpointService.requestActivation(
        { userEmail: email, reason: reason.trim() || undefined },
        environment,
      );
      setSuccess(true);
      onActivationRequested();
    } catch (err: any) {
      setError(getApiErrorMessage(err.response?.data, 'Failed to send activation request'));
    } finally {
      setIsLoading(false);
    }
  };

  if (success || activationRequested) {
    return (
      <div className="mx-auto max-w-lg space-y-6 text-center">
        <span className="inline-flex animate-float-soft items-center gap-2 rounded-full border-2 border-ink bg-green px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-paper">
          Request sent
        </span>

        <h3 className="font-serif text-3xl text-ink md:text-4xl">
          The manager has been <span className="marker">notified.</span>
        </h3>

        <p className="mx-auto max-w-md leading-relaxed text-muted">
          Your request is on its way — you&apos;ll get a confirmation email, and this page updates
          itself the moment the engine is warm.
        </p>

        <div className="rounded-2xl border-2 border-ink bg-paper p-5 text-left shadow-card">
          <p className="mb-4 text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            What happens next
          </p>
          <ul className="space-y-3">
            {CHECKLIST.map((item) => (
              <li key={item.text} className="flex items-center gap-3">
                <span
                  className={`h-3 w-3 flex-shrink-0 animate-pulse-dot border-2 border-ink ${item.color}`}
                  style={{ animationDelay: item.delay }}
                />
                <span className="text-sm text-muted">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="font-serif text-[15px] italic text-faint">
          Feel free to leave — come back any time.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div className="space-y-3 text-center">
        <h3 className="font-serif text-3xl text-ink md:text-4xl">
          The engine is <span className="italic text-blue">asleep.</span>
        </h3>
        <p className="mx-auto max-w-md leading-relaxed text-muted">
          The generator scales down to zero when it is quiet, to save GPU cost. Leave your email
          and the studio manager will warm it up for you.
        </p>
      </div>

      <details className="group rounded-[10px] border-2 border-ink bg-paper">
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="text-[13px] font-semibold text-ink">Why does it sleep?</span>
          <span className="font-serif text-2xl leading-none text-red group-open:hidden">+</span>
          <span className="hidden font-serif text-2xl leading-none text-red group-open:inline">
            −
          </span>
        </summary>
        <div className="border-t border-hairline px-4 py-3 text-sm leading-relaxed text-muted">
          A GPU instance is expensive to keep idle, so it scales to zero during quiet periods.
          Starting one is a human decision here: the manager reads your request and flips the
          switch — usually within 1–2 hours during business hours.
        </div>
      </details>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5 text-left">
          <label
            htmlFor="wake-email"
            className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink"
          >
            Your email
          </label>
          <Input
            id="wake-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            disabled={isLoading}
          />
        </div>

        <div className="space-y-1.5 text-left">
          <label
            htmlFor="wake-reason"
            className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink"
          >
            What are you making? <span className="font-normal normal-case text-faint">(optional)</span>
          </label>
          <textarea
            id="wake-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="A QR code for my portfolio, a gig poster…"
            rows={3}
            maxLength={500}
            disabled={isLoading}
            className="w-full resize-none rounded-[10px] border-2 border-ink bg-paper px-4 py-3 text-[15px] text-ink transition-colors duration-150 placeholder:text-faint focus:border-blue focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        {error && (
          <Alert variant="error">
            <p className="text-sm text-ink">{error}</p>
          </Alert>
        )}

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={isLoading}
          disabled={isLoading}
        >
          Ask to wake the engine <span className="text-yellow">→</span>
        </Button>
      </form>

      <p className="text-center font-serif text-[15px] italic text-faint">
        Requests are usually answered within 1–2 hours. This page refreshes itself once the engine
        is warm.
      </p>
    </div>
  );
};
