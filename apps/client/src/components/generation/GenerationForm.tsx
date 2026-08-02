import React, { useEffect } from 'react';
import { Dices } from 'lucide-react';

import {
  SUPPORTED_MODELS,
  SUPPORTED_SAMPLERS,
  MODEL_CONFIG,
  IMAGE_CONSTRAINTS,
  SEED_CONSTRAINTS,
  GUIDANCE_RANGE,
  QR_CONTENT_MAX_LENGTH,
} from '@repo/qr-constants';
import type { SupportedPipeline } from '@repo/qr-constants';

import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { Slider } from '@/components/shared/Slider';
import { Checkbox } from '@/components/shared/Checkbox';
import { Alert } from '@/components/shared/Alert';

import { cn } from '@/lib/utils/cn';
import type { QRGenerationRequest } from '@/lib/api/types';
import { generationService } from '@/services/GenerationService';

import { PROMPT_MIN_LENGTH, STYLE_PRESET_OPTIONS } from '@/lib/constants';
import { QR_VARIATION_CONFIGS } from '@/lib/qr/variationConfig';
import type { QRVariation } from '@/lib/qr/types';
import { useGenerationForm } from '@/hooks/useGenerationForm';

export interface GenerationFormProps {
  onSubmit: (request: QRGenerationRequest) => void;
  isLoading: boolean;
  isAvailable: boolean;
  /**
   * Generation pipeline (plan 008). When absent the request body carries no
   * `pipeline`/`qrContent` fields at all (byte-identical to today's main
   * page); "v2" additionally sends the QR's URL text as `qrContent`.
   */
  pipeline?: SupportedPipeline;
}

export type { QRVariation } from '@/lib/qr/types';

/** Uppercase form label per DS §2. */
const FieldLabel: React.FC<{ children: React.ReactNode; htmlFor?: string; className?: string }> = ({
  children,
  htmlFor,
  className,
}) => (
  <label
    htmlFor={htmlFor}
    className={cn(
      'block text-[11px] font-bold uppercase tracking-[0.1em] text-ink',
      className
    )}
  >
    {children}
  </label>
);

/** Small section heading inside the advanced panel: square bullet + uppercase label. */
const SectionHeading: React.FC<{ color: string; children: React.ReactNode }> = ({
  color,
  children,
}) => (
  <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
    <span className={cn('h-2.5 w-2.5 border-2 border-ink', color)} />
    {children}
  </h3>
);

export const GenerationForm: React.FC<GenerationFormProps> = ({
  onSubmit,
  isLoading,
  isAvailable,
  pipeline,
}) => {
  const { state, updateField, setQRVariations, setUploading, setError, toggleAdvanced } =
    useGenerationForm();

  const {
    qrUrl,
    qrVariations,
    numImagesPerPrompt,
    numInferenceSteps,
    controlnetScale1,
    controlnetScale2,
    guidanceEnd1,
    guidanceEnd2,
    guidanceScale,
    guidanceStart1,
    guidanceStart2,
    model,
    negativePrompt,
    prompt,
    promptEnhancement,
    sampler,
    seed,
    showAdvanced,
    stylePreset,
    uploadError,
    uploadingQR,
  } = state;

  const samplers = SUPPORTED_SAMPLERS;
  const models = SUPPORTED_MODELS;

  useEffect(() => {
    generateQRVariations(qrUrl);
  }, [qrUrl]);

  const generateQRVariations = async (text: string) => {
    try {
      const variations: QRVariation[] = await Promise.all(
        QR_VARIATION_CONFIGS.map((config) => config.generator(text, config.options))
      );
      setQRVariations(variations);
      setError(null);
    } catch (err) {
      console.error('Error generating QR code:', err);
      setError('Failed to generate QR code');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (prompt.length < PROMPT_MIN_LENGTH) {
      return;
    }

    if (qrVariations.length === 0) {
      setError('Please enter a valid URL to generate a QR code');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const uploadPromises = qrVariations
        .slice(0, numImagesPerPrompt)
        .map((variation) => generationService.uploadQR(variation.dataUrl, numImagesPerPrompt));

      const s3QrUrls = await Promise.all(uploadPromises);

      const request: QRGenerationRequest = {
        prompt,
        baseQrCode: s3QrUrls,
        numImagesPerPrompt,
        negativePrompt,
        numInferenceSteps,
        guidanceScale,
        sampler,
        model,
        controlnetConditioningScale: [controlnetScale1, controlnetScale2],
        controlGuidanceStart: [guidanceStart1, guidanceStart2],
        controlGuidanceEnd: [guidanceEnd1, guidanceEnd2],
        height: 1024,
        width: 1024,
        promptEnhancement,
        ...(seed !== null ? { seed } : {}),
        // Plan 008: only when the page sets a pipeline. For v2, also send the
        // exact text the QR variations encode (qrUrl) as qrContent so the
        // container can render its canonical QR; when the text exceeds the
        // schema bound, omit it and let the container fall back to decoding
        // baseQrCode[0].
        ...(pipeline ? { pipeline } : {}),
        // Only meaningful on v2 — the v1 lane has no notion of presets.
        ...(pipeline === 'v2' && stylePreset ? { stylePreset } : {}),
        ...(pipeline === 'v2' && qrUrl.length > 0 && qrUrl.length <= QR_CONTENT_MAX_LENGTH
          ? { qrContent: qrUrl }
          : {}),
      };

      onSubmit(request);
    } catch (error) {
      console.error('Failed to upload QR code:', error);
      setError('Failed to upload QR code. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const isSubmitDisabled =
    prompt.length < PROMPT_MIN_LENGTH ||
    isLoading ||
    uploadingQR ||
    qrVariations.length === 0 ||
    !isAvailable;

  const promptMet = prompt.length >= PROMPT_MIN_LENGTH;
  const hasQr = qrVariations.length > 0;
  const disabledInputs = isLoading || uploadingQR;

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      <div className="space-y-2.5">
        <FieldLabel htmlFor="qr-url">QR code URL</FieldLabel>
        <Input
          id="qr-url"
          type="text"
          value={qrUrl}
          onChange={(e) => updateField('qrUrl', e.target.value)}
          placeholder="https://your-link.com"
          disabled={disabledInputs}
          rightSlot={
            hasQr ? (
              <span className="rounded bg-green px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-paper">
                Valid
              </span>
            ) : null
          }
        />
      </div>

      <div className="flex flex-col items-stretch gap-8 lg:flex-row">
        <div className="flex w-full flex-shrink-0 flex-col space-y-3 lg:w-52">
          <FieldLabel>QR preview</FieldLabel>
          <div className="relative w-52 self-center lg:self-start">
            <div className="rounded-xl border-2 border-ink bg-paper p-3 shadow-card">
              <div className="aspect-square overflow-hidden rounded-lg bg-paper">
                {qrVariations[0]?.dataUrl ? (
                  <img
                    src={qrVariations[0].dataUrl}
                    alt="Standard QR preview"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center px-4 text-center font-serif text-sm italic text-faint">
                    Enter a URL to preview
                  </div>
                )}
              </div>
            </div>
            {/* confetti square */}
            <span
              aria-hidden="true"
              className="absolute -right-2 -top-2 h-3.5 w-3.5 rotate-12 border-2 border-ink bg-red"
            />
          </div>
          <div>
            <p className="text-center font-serif text-[14px] italic text-blue">
              {hasQr ? 'Standard QR — ready' : 'Waiting for a URL'}
            </p>
            <p className="mt-1 text-center text-xs text-faint">
              {numImagesPerPrompt} variations will be generated
            </p>
          </div>
        </div>

        <div className="flex flex-grow flex-col space-y-3">
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="prompt">Your prompt</FieldLabel>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border-2 border-ink px-2.5 py-0.5 text-[11px] font-semibold tabular-nums',
                promptMet ? 'bg-yellow text-ink' : 'bg-paper text-faint'
              )}
            >
              {prompt.length} / {PROMPT_MIN_LENGTH}
              {promptMet && ' ✓'}
            </span>
          </div>
          <div className="flex flex-grow flex-col">
            <textarea
              id="prompt"
              value={prompt}
              onChange={(e) => updateField('prompt', e.target.value)}
              maxLength={IMAGE_CONSTRAINTS.MAX_PROMPT_LENGTH}
              placeholder="Describe the scene… e.g. 'a misty pine forest at dawn, soft volumetric light, painterly'"
              className={cn(
                'min-h-[190px] w-full flex-grow resize-none rounded-[10px] border-2 border-ink bg-paper px-4 py-3 text-[15px] text-ink placeholder:text-faint focus:border-blue focus:outline-none',
                !promptMet && prompt.length > 0 && 'border-red focus:border-red'
              )}
              disabled={disabledInputs}
            />
            <p className="mt-2 font-serif text-[13px] italic text-faint">
              {promptMet
                ? 'Looks good — describe colour, mood and composition for best results.'
                : `At least ${PROMPT_MIN_LENGTH} characters, so the model has a scene to paint.`}
            </p>
          </div>
        </div>
      </div>

      {uploadError && (
        <Alert variant="error">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-red">Upload failed</p>
          <p className="mt-1 text-sm text-muted">{uploadError}</p>
        </Alert>
      )}

      <button
        type="button"
        onClick={() => !disabledInputs && toggleAdvanced()}
        className="flex w-full items-center justify-between rounded-[10px] border-2 border-ink bg-cream px-4 py-3.5 text-left transition-colors hover:bg-[#EFE5D0]"
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-ink">
            Advanced settings
          </span>
          <span className="font-serif text-[13px] italic text-faint">fine-tune the model</span>
        </span>
        <span className="font-serif text-2xl leading-none text-red">
          {showAdvanced ? '−' : '+'}
        </span>
      </button>

      {showAdvanced && (
        <div className="space-y-8 rounded-[10px] border-2 border-ink bg-paper p-6">
          <div className="space-y-4">
            <SectionHeading color="bg-blue">Generation</SectionHeading>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Slider
                label="Images per prompt"
                value={numImagesPerPrompt}
                onChange={(e) => updateField('numImagesPerPrompt', e)}
                min={1}
                max={3}
                info="Number of images to generate from the prompt"
                disabled={disabledInputs}
              />

              <Slider
                label="Inference steps"
                value={numInferenceSteps}
                onChange={(e) => updateField('numInferenceSteps', e)}
                min={10}
                max={40}
                info="More steps = better quality but slower generation"
                disabled={disabledInputs}
              />

              <Slider
                label="Guidance scale"
                value={guidanceScale}
                onChange={(e) => updateField('guidanceScale', e)}
                min={1}
                max={20}
                step={0.5}
                info="How closely to follow the prompt (7–12 recommended)"
                disabled={disabledInputs}
              />

              <div className="space-y-2">
                <FieldLabel htmlFor="seed" className="normal-case tracking-normal">
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold normal-case tracking-normal">
                    Seed
                    <span className="group relative inline-flex">
                      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border-2 border-dash font-serif text-[11px] italic text-faint">
                        i
                      </span>
                      <span className="pointer-events-none absolute bottom-6 left-0 z-10 hidden w-64 rounded-xl border-2 border-ink bg-paper p-3 text-xs leading-relaxed text-muted shadow-card group-hover:block">
                        Fixed seed = reproducible results. Leave empty for random.
                      </span>
                    </span>
                  </span>
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="seed"
                    type="number"
                    value={seed !== null ? seed : ''}
                    min={SEED_CONSTRAINTS.MIN_SEED}
                    max={SEED_CONSTRAINTS.MAX_SEED}
                    onChange={(e) => {
                      const val = e.target.value;
                      const parsed = parseInt(val, 10);
                      if (val === '' || Number.isNaN(parsed)) {
                        updateField('seed', null);
                        return;
                      }
                      updateField(
                        'seed',
                        Math.min(
                          Math.max(parsed, SEED_CONSTRAINTS.MIN_SEED),
                          SEED_CONSTRAINTS.MAX_SEED
                        )
                      );
                    }}
                    placeholder="Random"
                    disabled={disabledInputs}
                  />
                  <button
                    type="button"
                    onClick={() => updateField('seed', Math.floor(Math.random() * 2147483647))}
                    disabled={disabledInputs}
                    className="flex-shrink-0 rounded-[10px] border-2 border-ink bg-paper px-3 text-ink transition-colors hover:bg-yellow disabled:opacity-50"
                    title="Roll a random seed"
                    aria-label="Roll a random seed"
                  >
                    <Dices className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <Checkbox
                id="prompt-enhancement"
                label="Prompt enhancement"
                checked={promptEnhancement}
                onChange={(checked) => updateField('promptEnhancement', checked)}
                info="Automatically refines your prompt behind the scenes for better QR blending. Your subject and message are preserved."
                disabled={disabledInputs}
              />
            </div>
          </div>

          <div className="space-y-4">
            <SectionHeading color="bg-red">Style, model &amp; sampler</SectionHeading>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              {/* v2 only: the v1 lane ignores presets entirely, so offering
                  them there would be a control that silently does nothing. */}
              {pipeline === 'v2' && (
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel htmlFor="style-preset">Style</FieldLabel>
                  <select
                    id="style-preset"
                    value={stylePreset}
                    onChange={(e) =>
                      updateField(
                        'stylePreset',
                        e.target.value as QRGenerationRequest['stylePreset']
                      )
                    }
                    className="w-full rounded-[10px] border-2 border-ink bg-paper px-3 py-3 text-[15px] text-ink focus:border-blue focus:outline-none"
                    disabled={disabledInputs}
                  >
                    {STYLE_PRESET_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label} — {option.hint}
                      </option>
                    ))}
                  </select>
                  {/* Says what the choice costs, not just what it looks like:
                      every preset but "none" rewrites the prompt and takes
                      over the model and the conditioning knobs below. */}
                  <p className="font-serif text-[13px] italic text-faint">
                    {stylePreset === 'none'
                      ? 'Your prompt is sent exactly as written, and the settings below apply.'
                      : 'Adds styling words to your prompt, and picks its own model, steps, guidance and conditioning — the fields below are ignored.'}
                  </p>
                </div>
              )}

              <div className="space-y-2">
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <select
                  id="model"
                  value={model}
                  onChange={(e) =>
                    updateField('model', e.target.value as QRGenerationRequest['model'])
                  }
                  className="w-full rounded-[10px] border-2 border-ink bg-paper px-3 py-3 text-[15px] text-ink focus:border-blue focus:outline-none"
                  disabled={disabledInputs}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {MODEL_CONFIG[m]?.name ?? m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-2">
                <FieldLabel htmlFor="sampler">Sampler</FieldLabel>
                <select
                  id="sampler"
                  value={sampler}
                  onChange={(e) =>
                    updateField('sampler', e.target.value as QRGenerationRequest['sampler'])
                  }
                  className="w-full rounded-[10px] border-2 border-ink bg-paper px-3 py-3 text-[15px] text-ink focus:border-blue focus:outline-none"
                  disabled={disabledInputs}
                >
                  {samplers.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <SectionHeading color="bg-green">ControlNet conditioning</SectionHeading>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Slider
                label="Conditioning scale 1"
                value={controlnetScale1}
                onChange={(e) => updateField('controlnetScale1', e)}
                min={0}
                max={2}
                step={0.05}
                info="Primary control strength for QR structure"
                disabled={disabledInputs}
              />

              <Slider
                label="Conditioning scale 2"
                value={controlnetScale2}
                onChange={(e) => updateField('controlnetScale2', e)}
                min={0}
                max={2}
                step={0.05}
                info="Secondary control strength"
                disabled={disabledInputs}
              />
            </div>
          </div>

          <div className="space-y-4">
            <SectionHeading color="bg-yellow">Control guidance</SectionHeading>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <Slider
                label="Guidance start 1"
                value={guidanceStart1}
                onChange={(e) => updateField('guidanceStart1', e)}
                min={0}
                max={GUIDANCE_RANGE.MAX}
                step={0.05}
                info="When to start applying control (0 = beginning)"
                disabled={disabledInputs}
              />

              <Slider
                label="Guidance start 2"
                value={guidanceStart2}
                onChange={(e) => updateField('guidanceStart2', e)}
                min={0}
                max={GUIDANCE_RANGE.MAX}
                step={0.05}
                info="Secondary guidance start point"
                disabled={disabledInputs}
              />

              <Slider
                label="Guidance end 1"
                value={guidanceEnd1}
                onChange={(e) => updateField('guidanceEnd1', e)}
                min={0}
                max={GUIDANCE_RANGE.MAX}
                step={0.05}
                info="When to stop applying control (1 = end)"
                disabled={disabledInputs}
              />

              <Slider
                label="Guidance end 2"
                value={guidanceEnd2}
                onChange={(e) => updateField('guidanceEnd2', e)}
                min={0}
                max={GUIDANCE_RANGE.MAX}
                step={0.05}
                info="Secondary guidance end point"
                disabled={disabledInputs}
              />
            </div>
          </div>

          <div className="space-y-2">
            <FieldLabel htmlFor="negative-prompt">Negative prompt</FieldLabel>
            <Input
              id="negative-prompt"
              type="text"
              value={negativePrompt}
              onChange={(e) => updateField('negativePrompt', e.target.value)}
              placeholder="Things to avoid in the generation…"
              disabled={disabledInputs}
            />
          </div>
        </div>
      )}

      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={isSubmitDisabled}
        loading={isLoading || uploadingQR}
      >
        Generate artwork <span className="text-yellow">→</span>
      </Button>

      <p className="text-center font-serif text-[15px] italic text-muted">
        <span className="not-italic text-red">Tip</span> — geometric patterns, architecture and
        high-contrast scenes stay the most scannable.
      </p>
    </form>
  );
};
