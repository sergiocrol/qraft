import React, { useState, useEffect, Fragment } from 'react';
import type { QRGenerationRequest } from '@repo/shared-types';
import type { SupportedPipeline } from '@repo/qr-constants';

import SkeletonLoadingView from '@/components/loading/SkeletonLoadingView';
import { GenerationForm } from '@/components/generation/GenerationForm';
import { WakeEndpointForm } from '@/components/wake/WakeEndpointForm';
import { UpdatingView } from '@/components/generation/UpdatingView';
import StatusErrorView from '@/components/error/StatusErrorView';
import { ErrorBanner } from '@/components/shared/ErrorBanner';
import { PageLayout } from '@/components/layout/PageLayout';

import { FullHeader } from '@/components/header/FullHeader';
import { SimplifiedHeader } from '@/components/header/SimplifiedHeader';
import { StickyHeader } from '@/components/header/StickyHeader';

import { generationService } from '@/services/GenerationService';
import { useEndpointStatus } from '@/hooks/useEndpointStatus';
import { useScrollHeader } from '@/hooks/useScrollHeader';
import { getApiErrorMessage } from '@/lib/api/errors';
import { getJobPageUrl } from '@/lib/utils/jobStore';
import { ENDPOINT_STATUS_POLL_MS } from '@/lib/constants';

export type ViewState = 'wake' | 'form' | 'processing' | 'results' | 'updating' | 'error';

export interface QRAnalysisResult {
  bestImageUrl: string;
  reorderedImages: string[];
  analysisResults: any[];
  scannableCount: number;
}

interface GenerationPageProps {
  environment?: 'production' | 'staging';
  /**
   * Generation pipeline sent with the request (plan 008). When absent, no
   * `pipeline` field is sent at all and the container's default ("v1")
   * rules — the main page must keep this prop unset.
   */
  pipeline?: SupportedPipeline;
}

export const GenerationPage: React.FC<GenerationPageProps> = ({
  environment = 'production',
  pipeline,
}) => {
  const [viewState, setViewState] = useState<ViewState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activationRequested, setActivationRequested] = useState(false);

  const isStaging = environment === 'staging';

  const { status: endpointStatus, error: endpointStatusError } = useEndpointStatus(
    ENDPOINT_STATUS_POLL_MS,
    environment,
  );

  const isScalingUp =
    endpointStatus?.status === 'Updating' &&
    endpointStatus?.currentInstanceCount === 0 &&
    endpointStatus?.desiredInstanceCount === 1;

  const isAvailable =
    endpointStatus?.status === 'InService' && endpointStatus?.currentInstanceCount > 0;

  const useSimplifiedHeader = viewState === 'form';

  const { isHeaderVisible, fullHeaderRef } = useScrollHeader({
    shouldShow: true,
  });

  useEffect(() => {
    if (!endpointStatus) {
      if (endpointStatusError) {
        setViewState('error');
      }
      return;
    }

    if (endpointStatus.status === 'Updating') {
      setViewState('updating');
      return;
    }

    if (isAvailable) {
      if (viewState === 'wake' || viewState === 'updating' || viewState === null) {
        setViewState('form');
        setActivationRequested(false);
      }
    } else {
      if (viewState === 'form' || viewState === null) {
        setViewState('wake');
      }
    }
  }, [endpointStatus, endpointStatusError, viewState]);

  // The admin answers activation requests on a human timescale (1-2 hours),
  // so the standing ENDPOINT_STATUS_POLL_MS poll is all the refresh we need.
  const handleActivationRequested = () => {
    setActivationRequested(true);
  };

  const handleGenerationSubmit = async (request: QRGenerationRequest) => {
    if (!isAvailable) return;

    if (endpointStatus?.status) setIsLoading(true);
    setError(null);

    try {
      const response = await generationService.generateQR({
        ...request,
        ...(isStaging ? { environment: 'staging' } : {}),
      });

      const jobPageUrl = getJobPageUrl(
        response.jobId,
        isStaging ? 'staging' : 'production',
        pipeline,
      );
      window.location.href = jobPageUrl;
    } catch (error: any) {
      setError(
        getApiErrorMessage(
          error.response?.data,
          error.message || 'Failed to submit generation request',
        ),
      );
      setViewState('form');
    } finally {
      setIsLoading(false);
    }
  };

  const header = useSimplifiedHeader ? (
    <SimplifiedHeader viewState={viewState} engineReady={isAvailable} />
  ) : (
    <FullHeader ref={fullHeaderRef} />
  );

  return (
    <Fragment>
      <StickyHeader viewState={viewState} isVisible={isHeaderVisible} engineReady={isAvailable} />
      <PageLayout
        staging={isStaging}
        header={header}
        errorSlot={
          error ? (
            <ErrorBanner message={error} onDismiss={() => setError(null)} />
          ) : undefined
        }
      >
        {viewState === null && <SkeletonLoadingView />}

        {viewState === 'error' && <StatusErrorView />}

        {viewState === 'wake' && (
          <WakeEndpointForm
            onActivationRequested={handleActivationRequested}
            activationRequested={activationRequested}
            environment={environment}
          />
        )}

        {viewState === 'updating' && <UpdatingView isScalingUp={isScalingUp} />}

        {viewState === 'form' && (
          <GenerationForm
            onSubmit={handleGenerationSubmit}
            isLoading={isLoading}
            isAvailable={true}
            pipeline={pipeline}
          />
        )}
      </PageLayout>
    </Fragment>
  );
};

export default GenerationPage;
