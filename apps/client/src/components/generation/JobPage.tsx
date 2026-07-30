import React, { useState, useEffect, Fragment } from 'react';
import type { QRJobStatusResponse } from '@repo/shared-types';

import { ProcessingView } from '@/components/generation/ProcessingView';
import { ResultsView } from '@/components/generation/ResultsView';
import { ErrorBanner } from '@/components/shared/ErrorBanner';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';
import { PageLayout } from '@/components/layout/PageLayout';
import { SimplifiedHeader } from '@/components/header/SimplifiedHeader';
import { StickyHeader } from '@/components/header/StickyHeader';

import { generationService } from '@/services/GenerationService';
import { getJobIdFromPath, getFormPageUrl, getPipelineFromPath } from '@/lib/utils/jobStore';
import { analyzeAndReorderImages } from '@/lib/qr/analyzer';
import { useScrollHeader } from '@/hooks/useScrollHeader';
import { JOB_POLL_INTERVAL_MS } from '@/lib/constants';

import type { QRAnalysisResult, ViewState } from './GenerationPage';

type JobViewState = 'loading' | 'processing' | 'results' | 'error' | 'not-found' | 'cancelled';

interface JobPageProps {
  environment?: 'production' | 'staging';
}

export const JobPage: React.FC<JobPageProps> = ({ environment = 'production' }) => {
  const [viewState, setViewState] = useState<JobViewState>('loading');
  const [currentJob, setCurrentJob] = useState<QRJobStatusResponse | null>(null);
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [qrAnalysis, setQrAnalysis] = useState<QRAnalysisResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isStaging = environment === 'staging';
  // v2 jobs (p=v2 in the URL) link "generate again" back to /lab, not /staging.
  const formUrl = getFormPageUrl(environment, getPipelineFromPath() ?? undefined);

  const { isHeaderVisible } = useScrollHeader({ shouldShow: true });

  const headerViewState: ViewState | null =
    viewState === 'processing' ? 'processing' : viewState === 'results' ? 'results' : null;

  const processJobStatus = async (
    status: QRJobStatusResponse
  ): Promise<'completed' | 'failed' | 'cancelled' | 'processing'> => {
    setCurrentJob(status);

    if (status.status === 'completed') {
      if (status.result?.images && status.result.images.length > 0) {
        const analysis = await analyzeAndReorderImages(
          status.result.images,
          status.result.imagesMetadata,
        );
        setGeneratedImages(status.result.images);
        setQrAnalysis(analysis);
        return 'completed';
      } else {
        setError('Job completed but no images were generated.');
        return 'failed';
      }
    } else if (status.status === 'failed') {
      setError(status.error?.message || 'Generation failed.');
      return 'failed';
    } else if (status.status === 'cancelled') {
      return 'cancelled';
    }

    return 'processing';
  };

  useEffect(() => {
    const id = getJobIdFromPath();
    if (!id) {
      setViewState('not-found');
      return;
    }

    setJobId(id);

    const fetchInitialStatus = async () => {
      try {
        const status = await generationService.getJobStatus(id);
        const result = await processJobStatus(status);

        if (result === 'completed') {
          setViewState('results');
        } else if (result === 'failed') {
          setViewState('error');
        } else if (result === 'cancelled') {
          setViewState('cancelled');
        } else {
          setViewState('processing');
        }
      } catch (err: any) {
        if (err?.response?.status === 404) {
          setViewState('not-found');
        } else {
          setViewState('processing');
        }
      }
    };

    fetchInitialStatus();
  }, []);

  useEffect(() => {
    if (!jobId || viewState !== 'processing') return;

    let isActive = true;

    const checkStatus = async (): Promise<boolean> => {
      try {
        const status = await generationService.getJobStatus(jobId);
        if (!isActive) return true;

        const result = await processJobStatus(status);

        if (result === 'completed') {
          setViewState('results');
          return true;
        } else if (result === 'failed') {
          setViewState('error');
          return true;
        } else if (result === 'cancelled') {
          setViewState('cancelled');
          return true;
        }

        return false;
      } catch (err: any) {
        if (!isActive) return true;

        return false;
      }
    };

    const pollInterval = setInterval(async () => {
      const done = await checkStatus();
      if (done) clearInterval(pollInterval);
    }, JOB_POLL_INTERVAL_MS);

    return () => {
      isActive = false;
      clearInterval(pollInterval);
    };
  }, [jobId, viewState]);

  const handleCancel = async () => {
    if (!jobId) return;

    try {
      await generationService.cancelJob(jobId);
    } catch (err) {
      console.warn('Failed to cancel job on server:', err);
    }

    window.location.href = formUrl;
  };

  const handleReset = () => {
    window.location.href = formUrl;
  };

  return (
    <Fragment>
      <StickyHeader viewState={headerViewState} isVisible={isHeaderVisible} />
      <PageLayout
        staging={isStaging}
        header={<SimplifiedHeader viewState={headerViewState} />}
        errorSlot={
          error && viewState === 'error' ? (
            <ErrorBanner message={error} />
          ) : undefined
        }
      >
                {viewState === 'loading' && (
                  <div className="flex flex-col items-center justify-center py-16">
                    <LoadingSpinner size="lg" label="Loading your artwork…" />
                  </div>
                )}

                {viewState === 'not-found' && (
                  <div className="mx-auto max-w-md space-y-6 py-12 text-center">
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-xl border-2 border-dashed border-ink bg-paper">
                      <span className="font-serif text-4xl italic text-faint">?</span>
                    </div>
                    <div>
                      <h3 className="font-serif text-3xl text-ink">
                        Nothing <span className="italic text-blue">here.</span>
                      </h3>
                      <p className="mt-2 text-muted">
                        This generation job doesn&apos;t exist or has expired.
                      </p>
                    </div>
                    <a
                      href={formUrl}
                      className="inline-flex items-center justify-center rounded-xl border-2 border-ink bg-ink px-7 py-3 font-serif text-base text-cream shadow-press transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-blue hover:shadow-press-sm"
                    >
                      Generate a new code <span className="ml-2 text-yellow">→</span>
                    </a>
                  </div>
                )}

                {viewState === 'error' && (
                  <div className="py-8 text-center">
                    <a
                      href={formUrl}
                      className="inline-flex items-center justify-center rounded-xl border-2 border-ink bg-red px-7 py-3 font-serif text-base text-paper shadow-press transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-red-hover hover:shadow-press-sm"
                    >
                      Try again <span className="ml-2 text-yellow">→</span>
                    </a>
                  </div>
                )}

                {viewState === 'cancelled' && (
                  <div className="mx-auto max-w-md space-y-6 py-12 text-center">
                    <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-xl border-2 border-ink bg-yellow">
                      <span className="font-serif text-4xl leading-none text-ink">×</span>
                    </div>
                    <div>
                      <h3 className="font-serif text-3xl text-ink">
                        Generation <span className="marker">cancelled.</span>
                      </h3>
                      <p className="mt-2 text-muted">
                        This generation was cancelled before it could finish.
                      </p>
                    </div>
                    <a
                      href={formUrl}
                      className="inline-flex items-center justify-center rounded-xl border-2 border-ink bg-red px-7 py-3 font-serif text-base text-paper shadow-press transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:bg-red-hover hover:shadow-press-sm"
                    >
                      Start fresh <span className="ml-2 text-yellow">→</span>
                    </a>
                  </div>
                )}

                {viewState === 'processing' && (
                  <ProcessingView
                    prompt={currentJob?.prompt || 'Your artistic QR code'}
                    progress={currentJob?.progress || 0}
                    message={currentJob?.message || 'Processing...'}
                    onCancel={handleCancel}
                  />
                )}

                {viewState === 'results' && generatedImages.length > 0 && (
                  <ResultsView
                    images={generatedImages}
                    qrAnalysis={qrAnalysis}
                    onReset={handleReset}
                    prompt={currentJob?.prompt}
                    imagesMetadata={currentJob?.result?.imagesMetadata}
                  />
                )}
      </PageLayout>
    </Fragment>
  );
};

export default JobPage;
