import React, { useState, useEffect } from 'react';

import { Button } from '@/components/shared/Button';
import { Input } from '@/components/shared/Input';
import { Alert } from '@/components/shared/Alert';
import { Card, CardContent } from '@/components/shared/Card';
import { LoadingSpinner } from '@/components/shared/LoadingSpinner';

import { cn } from '@/lib/utils/cn';
import { getApiErrorMessage } from '@/lib/api/errors';
import { endpointService } from '@/services/EndpointService';
import type { EndpointEnvironment } from '@/services/EndpointService';

import { useEndpointStatus } from '@/hooks/useEndpointStatus';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { authService } from '@/services/AuthService';
import { ADMIN_TOKEN_STORAGE_KEY, GPU_INSTANCE_OPTIONS } from '@/lib/constants';

type AdminTab = 'production' | 'staging';

export const AdminPanel: React.FC = () => {
  const [password, setPassword] = useState('');
  const [adminToken, setAdminToken] = useLocalStorage<string | null>(
    ADMIN_TOKEN_STORAGE_KEY,
    null
  );
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<AdminTab>('production');

  const isAuthenticated = !!adminToken;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const adminSecret = password;
      const token = await authService.authenticate(adminSecret);
      setAdminToken(token);
      setError('');
    } catch (err: any) {
      setError(err.message || 'Invalid credentials');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = () => {
    setAdminToken(null);
    window.location.reload();
  };

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream p-4">
        <Card className="w-full max-w-md">
          <CardContent className="space-y-5 p-8">
            <h2 className="font-serif text-3xl text-ink">Admin</h2>
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="admin-password"
                  className="block text-[11px] font-bold uppercase tracking-[0.1em] text-ink"
                >
                  Password
                </label>
                <Input
                  id="admin-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  className="tracking-[0.3em]"
                  autoFocus
                />
              </div>
              {error && (
                <Alert variant="error">
                  <p className="text-sm text-ink">{error}</p>
                </Alert>
              )}
              <Button type="submit" variant="solid" className="w-full" loading={isLoading}>
                Log in <span className="ml-1 text-yellow">→</span>
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cream p-6 md:p-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="font-serif text-3xl text-ink md:text-4xl">
            Engine <span className="italic text-blue">dashboard</span>
          </h1>
          <button
            onClick={handleLogout}
            className="font-sans text-sm font-semibold text-ink underline decoration-hairline underline-offset-4 transition-colors hover:text-blue hover:decoration-blue"
          >
            Log out
          </button>
        </div>

        <div className="mb-6 flex gap-2">
          {(['production', 'staging'] as const).map((tab) => {
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border-2 border-ink px-4 py-2 text-[13px] font-semibold capitalize transition-colors',
                  isActive
                    ? 'bg-blue text-paper'
                    : tab === 'staging'
                      ? 'bg-paper text-ink hover:bg-yellow'
                      : 'bg-paper text-ink hover:bg-yellow'
                )}
              >
                {isActive && <span className="h-2 w-2 rounded-full bg-paper" />}
                {tab}
              </button>
            );
          })}
        </div>

        <EndpointPanel
          environment={activeTab}
          adminToken={adminToken}
          onAuthError={() => {
            setError('Session expired. Please login again.');
            setAdminToken(null);
          }}
        />
      </div>
    </div>
  );
};

interface EndpointPanelProps {
  environment: EndpointEnvironment;
  adminToken: string | null;
  onAuthError: () => void;
}

const EndpointPanel: React.FC<EndpointPanelProps> = ({ environment, adminToken, onAuthError }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [isChangingType, setIsChangingType] = useState(false);

  useEffect(() => {
    setSelectedType(null);
  }, [environment]);

  const {
    status: endpointStatus,
    isLoading: isLoadingStatus,
    error: statusError,
    refetch: refetchStatus,
  } = useEndpointStatus(10000, environment);

  const isStaging = environment === 'staging';

  const handleScale = async (instanceCount: number) => {
    if (!adminToken) return;

    if (!authService.validateToken(adminToken)) {
      onAuthError();
      return;
    }

    setIsLoading(true);
    setError('');
    setSuccessMessage('');

    try {
      await endpointService.scaleEndpoint(instanceCount, adminToken, environment);
      setSuccessMessage(
        `Scaling ${environment} endpoint to ${instanceCount} instance(s). This will take 7-10 minutes.`
      );

      setTimeout(() => {
        refetchStatus();
        setSuccessMessage('');
      }, 5000);
    } catch (err: any) {
      if (err.response?.status === 401) {
        onAuthError();
      } else {
        setError(getApiErrorMessage(err.response?.data, `Failed to scale ${environment} endpoint`));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangeInstanceType = async () => {
    if (!adminToken || !selectedType) return;

    if (!authService.validateToken(adminToken)) {
      onAuthError();
      return;
    }

    setIsChangingType(true);
    setError('');
    setSuccessMessage('');

    try {
      const result = await endpointService.changeInstanceType(
        selectedType,
        adminToken,
        environment
      );
      setSuccessMessage(result.message);
      setTimeout(() => {
        refetchStatus();
      }, 5000);
    } catch (err: any) {
      if (err.response?.status === 401) {
        onAuthError();
      } else {
        setError(getApiErrorMessage(err.response?.data, 'Failed to switch hardware'));
      }
    } finally {
      setIsChangingType(false);
    }
  };

  return (
    <>
      {isStaging && (
        <div className="mb-4 rounded-xl border border-dashed border-ink bg-yellow/45 p-3">
          <p className="font-serif text-[15px] italic text-ink">
            Staging environment — changes here only affect the staging SageMaker
            endpoint. Production is unaffected.
          </p>
        </div>
      )}

      <Card className="mb-6">
        <CardContent className="p-6">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="font-serif text-2xl text-ink">Endpoint status</h2>
            <span
              className={cn(
                'rounded-full border-2 border-ink px-2.5 py-0.5 text-[11px] font-semibold capitalize text-paper',
                isStaging ? 'bg-yellow text-ink' : 'bg-blue'
              )}
            >
              {environment}
            </span>
          </div>

          {isLoadingStatus && !endpointStatus ? (
            <LoadingSpinner label={`Loading ${environment} endpoint status…`} />
          ) : statusError ? (
            <Alert variant="error">
              <p className="text-sm text-ink">{statusError}</p>
              {isStaging && (
                <span className="mt-1 block text-xs text-muted">
                  The staging endpoint may not exist yet. Deploy it first with{' '}
                  <code>make deploy-sagemaker-staging</code>
                </span>
              )}
            </Alert>
          ) : endpointStatus ? (
            <div>
              <StatusRow
                label="Status"
                value={
                  <span
                    className={cn(
                      'rounded-full border-2 border-ink px-3 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em]',
                      endpointStatus.status === 'InService'
                        ? 'bg-green text-paper'
                        : 'bg-yellow text-ink'
                    )}
                  >
                    {endpointStatus.status === 'InService' ? 'In service' : endpointStatus.status}
                  </span>
                }
              />

              <StatusRow
                label="Current instances"
                value={
                  <span className="font-serif text-2xl leading-none text-ink">
                    {endpointStatus.currentInstanceCount}
                  </span>
                }
              />

              <StatusRow
                label="Desired instances"
                value={
                  <span className="font-serif text-2xl leading-none text-ink">
                    {endpointStatus.desiredInstanceCount}
                  </span>
                }
              />

              {endpointStatus.instanceType && (
                <StatusRow
                  label="GPU"
                  value={
                    <span className="font-serif text-lg leading-none text-ink">
                      {endpointStatus.instanceType}
                      <span className="ml-2 text-sm not-italic text-muted">
                        {GPU_INSTANCE_OPTIONS.find(
                          (o) => o.value === endpointStatus.instanceType
                        )?.gpu ?? ''}
                      </span>
                    </span>
                  }
                />
              )}

              <StatusRow
                label="Scaling"
                value={
                  <span className="rounded-full border-2 border-ink bg-paper px-3 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-ink">
                    {endpointStatus.isScaling ? 'Scaling' : 'Stable'}
                  </span>
                }
              />

              <StatusRow
                label="Last updated"
                value={
                  <span className="text-sm text-faint">
                    {new Date(endpointStatus.lastUpdated).toLocaleString()}
                  </span>
                }
              />

              {endpointStatus.estimatedStartupTime && (
                <StatusRow
                  label="Estimated startup"
                  value={
                    <span className="text-sm text-muted">
                      {Math.round(endpointStatus.estimatedStartupTime / 60)} minutes
                    </span>
                  }
                />
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="error" className="mb-4" onClose={() => setError('')}>
          <p className="text-sm text-ink">{error}</p>
        </Alert>
      )}
      {successMessage && (
        <Alert variant="success" className="mb-4" onClose={() => setSuccessMessage('')}>
          <p className="text-sm text-ink">{successMessage}</p>
        </Alert>
      )}

      <Card className="mb-6">
        <CardContent className="p-6">
          <h2 className="mb-1 font-serif text-2xl text-ink">Hardware</h2>
          <p className="mb-4 text-sm text-muted">
            Blue/green switch — the current GPU keeps serving until the new one is ready. If the
            requested type has no capacity, SageMaker rolls back on its own and nothing breaks.
          </p>

          <div className="flex flex-col gap-3">
            {GPU_INSTANCE_OPTIONS.map((option) => {
              const isCurrent = endpointStatus?.instanceType === option.value;
              const isSelected =
                (selectedType ?? endpointStatus?.instanceType) === option.value;
              return (
                <button
                  key={option.value}
                  onClick={() => setSelectedType(option.value)}
                  disabled={isChangingType}
                  className={cn(
                    'flex items-start justify-between gap-4 rounded-xl border-2 p-4 text-left transition-all',
                    isSelected
                      ? 'border-ink bg-yellow/45 shadow-press'
                      : 'border-hairline bg-paper hover:border-ink'
                  )}
                >
                  <span>
                    <span className="flex items-center gap-2">
                      <span className="font-serif text-lg text-ink">{option.value}</span>
                      {isCurrent && (
                        <span className="rounded-full border-2 border-ink bg-green px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-paper">
                          Current
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[13px] text-muted">
                      {option.gpu} — {option.note}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'mt-1 h-4 w-4 flex-shrink-0 rounded-full border-2 border-ink',
                      isSelected ? 'bg-blue' : 'bg-paper'
                    )}
                  />
                </button>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-4">
            <Button
              onClick={handleChangeInstanceType}
              variant="solid"
              disabled={
                isChangingType ||
                !selectedType ||
                selectedType === endpointStatus?.instanceType ||
                endpointStatus?.status === 'Updating'
              }
              loading={isChangingType}
            >
              Switch hardware <span className="ml-1 text-yellow">→</span>
            </Button>
            <p className="font-serif text-[15px] italic text-muted">
              {endpointStatus?.status === 'Updating'
                ? 'An update is already in progress — wait for it to finish.'
                : 'Takes 5–15 minutes. Autoscaling is restored automatically afterwards.'}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-6">
          <h2 className="mb-4 font-serif text-2xl text-ink">Scaling controls</h2>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Button
              onClick={() => handleScale(0)}
              variant="outline"
              className="flex-1"
              disabled={
                isLoading ||
                endpointStatus?.currentInstanceCount === 0 ||
                endpointStatus?.status === 'Updating'
              }
              loading={isLoading}
            >
              Scale to 0 · save costs
            </Button>

            <Button
              onClick={() => handleScale(1)}
              variant="solid"
              className={cn(
                'flex-1',
                isStaging
                  ? 'bg-yellow text-ink hover:bg-yellow/80'
                  : 'bg-blue text-paper hover:bg-blue-hover'
              )}
              disabled={
                isLoading ||
                endpointStatus?.currentInstanceCount === 1 ||
                endpointStatus?.status === 'Updating'
              }
              loading={isLoading}
            >
              Scale to 1 · activate
            </Button>
          </div>

          <p className="mt-5 font-serif text-[15px] italic text-muted">
            Scaling takes 7–10 minutes to complete.
            {isStaging
              ? ' The staging endpoint is for testing optimization changes before promoting to production.'
              : ' The endpoint scales down automatically after 1 hour of inactivity to save costs.'}
          </p>
        </CardContent>
      </Card>
    </>
  );
};

const StatusRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between border-b border-hairline py-3 last:border-b-0">
    <span className="text-[13px] font-semibold text-ink">{label}</span>
    {value}
  </div>
);

export default AdminPanel;
