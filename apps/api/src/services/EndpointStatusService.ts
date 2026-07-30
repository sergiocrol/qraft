import AWS from "aws-sdk";
import { getConfig } from "../utils/environment";
import {
  AllowedInstanceType,
  AUTOSCALING_MIN_CAPACITY,
  AUTOSCALING_MAX_CAPACITY,
} from "../constants";

interface EndpointStatus {
  endpointName: string;
  status: string;
  currentInstanceCount: number;
  desiredInstanceCount: number;
  instanceType?: string;
  isScaling: boolean;
  isAvailable: boolean;
  lastUpdated: string;
  estimatedStartupTime?: number;
  healthCheck: string;
}

interface ChangeInstanceTypeResult {
  message: string;
  endpointName: string;
  instanceType: string;
  previousInstanceType?: string;
  changed: boolean;
  estimatedTime?: string;
}

interface EndpointMetrics {
  endpointName: string;
  timeRange: {
    start: string;
    end: string;
  };
  invocations: Array<{
    timestamp: string;
    count: number;
  }>;
  latency: Array<{
    timestamp: string;
    averageMs: number;
  }>;
}

export type EndpointEnvironment = "production" | "staging";

export class EndpointStatusService {
  private sagemaker: AWS.SageMaker;
  private cloudwatch: AWS.CloudWatch;
  private autoScaling: AWS.ApplicationAutoScaling;
  private statusCache: Record<
    string,
    { data?: EndpointStatus; timestamp?: number; ttl: number }
  >;
  private scaleInTimeout?: NodeJS.Timeout;

  constructor() {
    const config = getConfig();
    const region = config.aws.region || "eu-west-1";
    const cacheTtl = config.endpointStatusCacheTtlMs;
    this.sagemaker = new AWS.SageMaker({ region });
    this.cloudwatch = new AWS.CloudWatch({ region });
    this.autoScaling = new AWS.ApplicationAutoScaling({ region });
    this.statusCache = {
      production: { ttl: cacheTtl },
      staging: { ttl: cacheTtl },
    };
  }

  private getEndpointName(
    environment: EndpointEnvironment = "production",
  ): string {
    const config = getConfig();
    return environment === "staging"
      ? config.sagemakerStagingEndpointName
      : config.sagemakerEndpointName;
  }

  async getEndpointStatus(
    environment: EndpointEnvironment = "production",
  ): Promise<EndpointStatus> {
    const cache = this.statusCache[environment];
    if (cache?.data && cache?.timestamp) {
      const age = Date.now() - cache.timestamp;
      if (age < cache.ttl) {
        return cache.data;
      }
    }

    try {
      const endpointName = this.getEndpointName(environment);

      const response = await this.sagemaker
        .describeEndpoint({
          EndpointName: endpointName,
        })
        .promise();

      const variant = response.ProductionVariants![0];
      const currentInstances = variant?.CurrentInstanceCount || 0;
      const desiredInstances = variant?.DesiredInstanceCount || 0;

      let instanceType: string | undefined;
      try {
        if (response.EndpointConfigName) {
          const endpointConfig = await this.sagemaker
            .describeEndpointConfig({
              EndpointConfigName: response.EndpointConfigName,
            })
            .promise();
          instanceType = endpointConfig.ProductionVariants?.[0]?.InstanceType;
        }
      } catch (configError) {
        // The status response must not fail because the config lookup did.
        console.warn("Could not resolve endpoint instance type:", configError);
      }

      const isScaling = currentInstances !== desiredInstances;

      let estimatedStartupTime;
      if (currentInstances === 0 && desiredInstances > 0) {
        estimatedStartupTime = 800;
      }

      const status: EndpointStatus = {
        endpointName,
        status: response.EndpointStatus,
        currentInstanceCount: currentInstances,
        desiredInstanceCount: desiredInstances,
        instanceType,
        isScaling,
        isAvailable:
          currentInstances > 0 && response.EndpointStatus === "InService",
        lastUpdated: new Date().toISOString(),
        estimatedStartupTime,
        healthCheck:
          response.EndpointStatus === "InService" ? "healthy" : "unhealthy",
      };

      const cacheTtl = getConfig().endpointStatusCacheTtlMs;
      this.statusCache[environment] = {
        ...this.statusCache[environment],
        data: status,
        timestamp: Date.now(),
        ttl: this.statusCache[environment]?.ttl ?? cacheTtl,
      };

      return status;
    } catch (error: any) {
      console.error(`Failed to get endpoint status (${environment}):`, error);
      throw error;
    }
  }

  async getEndpointMetrics(
    environment: EndpointEnvironment = "production",
  ): Promise<EndpointMetrics> {
    try {
      const endpointName = this.getEndpointName(environment);
      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - 60 * 60 * 1000);

      const invocationParams: AWS.CloudWatch.GetMetricStatisticsInput = {
        Namespace: "AWS/SageMaker",
        MetricName: "Invocations",
        Dimensions: [
          { Name: "EndpointName", Value: endpointName },
          { Name: "VariantName", Value: "AllTraffic" },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300,
        Statistics: ["Sum"],
      };

      const invocationResponse = await this.cloudwatch
        .getMetricStatistics(invocationParams)
        .promise();

      const latencyParams: AWS.CloudWatch.GetMetricStatisticsInput = {
        Namespace: "AWS/SageMaker",
        MetricName: "ModelLatency",
        Dimensions: [
          { Name: "EndpointName", Value: endpointName },
          { Name: "VariantName", Value: "AllTraffic" },
        ],
        StartTime: startTime,
        EndTime: endTime,
        Period: 300,
        Statistics: ["Average"],
      };

      const latencyResponse = await this.cloudwatch
        .getMetricStatistics(latencyParams)
        .promise();

      return {
        endpointName,
        timeRange: {
          start: startTime.toISOString(),
          end: endTime.toISOString(),
        },
        invocations: (invocationResponse.Datapoints || [])
          .sort((a, b) => a.Timestamp!.getTime() - b.Timestamp!.getTime())
          .map((point) => ({
            timestamp: point.Timestamp!.toISOString(),
            count: point.Sum || 0,
          })),
        latency: (latencyResponse.Datapoints || [])
          .sort((a, b) => a.Timestamp!.getTime() - b.Timestamp!.getTime())
          .map((point) => ({
            timestamp: point.Timestamp!.toISOString(),
            averageMs: point.Average || 0,
          })),
      };
    } catch (error: any) {
      console.error("Failed to get endpoint metrics:", error);
      throw error;
    }
  }

  private async setScalingSuspension(
    endpointName: string,
    suspend: boolean,
  ): Promise<void> {
    console.log(
      `Setting DynamicScalingInSuspended to ${suspend} for ${endpointName}`,
    );
    await this.autoScaling
      .registerScalableTarget({
        ServiceNamespace: "sagemaker",
        ResourceId: `endpoint/${endpointName}/variant/AllTraffic`,
        ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
        SuspendedState: {
          DynamicScalingInSuspended: suspend,
          DynamicScalingOutSuspended: false,
          ScheduledScalingSuspended: false,
        },
      })
      .promise();
    console.log(`DynamicScalingInSuspended set to ${suspend} successfully`);
  }

  async checkAndReleaseSuspension(
    environment: EndpointEnvironment = "production",
  ): Promise<void> {
    try {
      const endpointName = this.getEndpointName(environment);
      console.log(`Running scheduled scaling check for ${endpointName}`);

      const response = await this.autoScaling
        .describeScalableTargets({
          ServiceNamespace: "sagemaker",
          ResourceIds: [`endpoint/${endpointName}/variant/AllTraffic`],
        })
        .promise();

      const target = response.ScalableTargets?.[0];
      if (!target || !target.SuspendedState?.DynamicScalingInSuspended) {
        console.log("Scaling is not suspended or target not found. Skipping.");
        return;
      }

      const smResponse = await this.sagemaker
        .describeEndpoint({ EndpointName: endpointName })
        .promise();

      const lastModified = smResponse.LastModifiedTime;
      if (!lastModified) {
        console.log("Could not determine LastModifiedTime. Skipping.");
        return;
      }

      const now = new Date();
      const diffMinutes =
        (now.getTime() - lastModified.getTime()) / (1000 * 60);

      console.log(
        `Endpoint last modified ${diffMinutes.toFixed(2)} minutes ago`,
      );

      if (diffMinutes > 60) {
        console.log("Suspension expired (> 60 mins). Re-enabling ScaleIn.");
        await this.setScalingSuspension(endpointName, false);
      } else {
        console.log("Suspension active and within 60 min window. No action.");
      }
    } catch (error: any) {
      console.error("Failed to check/release suspension:", error);
    }
  }

  async scaleEndpoint(
    instanceCount: number,
    environment: EndpointEnvironment = "production",
  ): Promise<{
    message: string;
    endpointName: string;
    targetInstanceCount: number;
    estimatedTime: string;
  }> {
    try {
      const endpointName = this.getEndpointName(environment);

      const status = await this.getEndpointStatus(environment);
      if (status.status === "Updating") {
        // An update/scale-out is already in flight — SageMaker rejects
        // UpdateEndpointWeightsAndCapacities while Updating, which would
        // surface as an opaque 500 (2026-07-06 incident).
        return {
          message: "Endpoint update already in progress — try again in a few minutes",
          endpointName,
          targetInstanceCount: instanceCount,
          estimatedTime: "a few minutes",
        };
      }

      if (instanceCount > 0) {
        // When scaling UP, suspend ScaleIn to prevent immediate scale-down
        // The scheduled cron job will clean this up after 60 minutes
        await this.setScalingSuspension(endpointName, true);
      } else {
        // When scaling DOWN to 0, immediately reenable ScaleIn
        await this.setScalingSuspension(endpointName, false);
      }

      await this.sagemaker
        .updateEndpointWeightsAndCapacities({
          EndpointName: endpointName,
          DesiredWeightsAndCapacities: [
            {
              VariantName: "AllTraffic",
              DesiredInstanceCount: instanceCount,
            },
          ],
        })
        .promise();

      this.statusCache[environment] = {
        ...this.statusCache[environment],
        data: undefined,
        ttl: this.statusCache[environment]?.ttl ?? 0,
      };

      return {
        message: `Endpoint scaling to ${instanceCount} instance(s)`,
        endpointName,
        targetInstanceCount: instanceCount,
        estimatedTime: instanceCount > 0 ? "7-10 minutes" : "1 minute",
      };
    } catch (error: any) {
      console.error("Failed to scale endpoint:", error);
      throw error;
    }
  }

  /**
   * Switch the endpoint to a different GPU instance type via a blue/green
   * update: the current fleet keeps serving until the new instance is
   * InService, and SageMaker rolls back automatically if the new type cannot
   * be provisioned (e.g. the recurring ml.g5.xlarge capacity droughts).
   *
   * AWS refuses update-endpoint while the variant is a registered
   * Application Auto Scaling target, so the target is deregistered first —
   * which deletes its scaling policies. restoreAutoscalingIfMissing() (run
   * by the scheduled cron) re-creates target, policies and wake alarm once
   * the endpoint is InService again.
   */
  async changeInstanceType(
    instanceType: AllowedInstanceType,
    environment: EndpointEnvironment = "production",
  ): Promise<ChangeInstanceTypeResult> {
    const endpointName = this.getEndpointName(environment);

    const endpoint = await this.sagemaker
      .describeEndpoint({ EndpointName: endpointName })
      .promise();

    if (endpoint.EndpointStatus === "Updating") {
      return {
        message:
          "Endpoint update already in progress — try again in a few minutes",
        endpointName,
        instanceType,
        changed: false,
      };
    }

    const currentConfig = await this.sagemaker
      .describeEndpointConfig({
        EndpointConfigName: endpoint.EndpointConfigName!,
      })
      .promise();
    const variant = currentConfig.ProductionVariants[0];
    if (!variant) {
      throw new Error(
        `Endpoint config ${endpoint.EndpointConfigName} has no production variants`,
      );
    }

    if (variant.InstanceType === instanceType) {
      return {
        message: `Endpoint already runs on ${instanceType}`,
        endpointName,
        instanceType,
        previousInstanceType: variant.InstanceType,
        changed: false,
      };
    }

    try {
      await this.autoScaling
        .deregisterScalableTarget({
          ServiceNamespace: "sagemaker",
          ResourceId: `endpoint/${endpointName}/variant/${variant.VariantName}`,
          ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
        })
        .promise();
      console.log(`Deregistered scalable target for ${endpointName}`);
    } catch (error: any) {
      // No registered target (e.g. staging) is fine; anything else is not.
      if (error.code !== "ObjectNotFoundException") throw error;
    }

    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[-:]/g, "")
      .replace("T", "-");
    const newConfigName = `${endpointName}-config-${timestamp}-admin`;

    await this.sagemaker
      .createEndpointConfig({
        EndpointConfigName: newConfigName,
        ProductionVariants: [
          {
            VariantName: variant.VariantName,
            ModelName: variant.ModelName,
            // Provision one instance as part of the update — this doubles as
            // the capacity test for the requested type.
            InitialInstanceCount: 1,
            InstanceType: instanceType,
            InitialVariantWeight: variant.InitialVariantWeight,
          },
        ],
        ...(currentConfig.AsyncInferenceConfig
          ? { AsyncInferenceConfig: currentConfig.AsyncInferenceConfig }
          : {}),
      })
      .promise();

    await this.sagemaker
      .updateEndpoint({
        EndpointName: endpointName,
        EndpointConfigName: newConfigName,
      })
      .promise();

    this.statusCache[environment] = {
      ...this.statusCache[environment],
      data: undefined,
      ttl: this.statusCache[environment]?.ttl ?? 0,
    };

    console.log(
      `Endpoint ${endpointName} updating: ${variant.InstanceType} -> ${instanceType} (config ${newConfigName})`,
    );

    return {
      message:
        `Switching to ${instanceType}. The current hardware keeps serving until the new instance is ready; ` +
        `if ${instanceType} capacity is unavailable, SageMaker rolls back automatically. ` +
        `Autoscaling is restored automatically within ~10 minutes of completion.`,
      endpointName,
      instanceType,
      previousInstanceType: variant.InstanceType,
      changed: true,
      estimatedTime: "5-15 minutes",
    };
  }

  /**
   * Self-healing counterpart of changeInstanceType, run by the scheduled
   * cron: if the production variant has no Application Auto Scaling target
   * (deregistering it is required before update-endpoint, and deletes its
   * policies), re-create the target, both scaling policies and the
   * wake-from-backlog alarm.
   *
   * Never throws — the cron must carry on with its other duties.
   */
  async restoreAutoscalingIfMissing(
    environment: EndpointEnvironment = "production",
  ): Promise<void> {
    try {
      const endpointName = this.getEndpointName(environment);
      const resourceId = `endpoint/${endpointName}/variant/AllTraffic`;

      const targets = await this.autoScaling
        .describeScalableTargets({
          ServiceNamespace: "sagemaker",
          ResourceIds: [resourceId],
        })
        .promise();
      if (targets.ScalableTargets && targets.ScalableTargets.length > 0) {
        return; // registered — nothing to heal
      }

      const endpoint = await this.sagemaker
        .describeEndpoint({ EndpointName: endpointName })
        .promise();
      if (endpoint.EndpointStatus !== "InService") {
        console.log(
          `Autoscaling missing but ${endpointName} is ${endpoint.EndpointStatus} — will restore once InService`,
        );
        return;
      }

      console.log(
        `No scalable target on ${resourceId} — restoring autoscaling (target + policies + wake alarm)`,
      );

      await this.autoScaling
        .registerScalableTarget({
          ServiceNamespace: "sagemaker",
          ResourceId: resourceId,
          ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
          MinCapacity: AUTOSCALING_MIN_CAPACITY,
          MaxCapacity: AUTOSCALING_MAX_CAPACITY,
          SuspendedState: {
            // The instance the update just provisioned must not be reaped
            // right away — the cron re-enables scale-in 60 min after the
            // endpoint's last modification (checkAndReleaseSuspension).
            DynamicScalingInSuspended: true,
            DynamicScalingOutSuspended: false,
            ScheduledScalingSuspended: false,
          },
        })
        .promise();

      await this.autoScaling
        .putScalingPolicy({
          PolicyName: `${endpointName}-TargetTracking-ExtendedWarmup`,
          ServiceNamespace: "sagemaker",
          ResourceId: resourceId,
          ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
          PolicyType: "TargetTrackingScaling",
          TargetTrackingScalingPolicyConfiguration: {
            TargetValue: 0.3,
            CustomizedMetricSpecification: {
              MetricName: "ApproximateBacklogSizePerInstance",
              Namespace: "AWS/SageMaker",
              Dimensions: [{ Name: "EndpointName", Value: endpointName }],
              Statistic: "Average",
            },
            ScaleOutCooldown: 30,
            ScaleInCooldown: 3600,
          },
        })
        .promise();

      const wakePolicy = await this.autoScaling
        .putScalingPolicy({
          PolicyName: `${endpointName}-WakeFromZero`,
          ServiceNamespace: "sagemaker",
          ResourceId: resourceId,
          ScalableDimension: "sagemaker:variant:DesiredInstanceCount",
          PolicyType: "StepScaling",
          StepScalingPolicyConfiguration: {
            AdjustmentType: "ChangeInCapacity",
            StepAdjustments: [
              { MetricIntervalLowerBound: 0, ScalingAdjustment: 1 },
            ],
            Cooldown: 60,
            MetricAggregationType: "Average",
          },
        })
        .promise();

      // Policy ARNs change on re-creation — the wake alarm must point at the
      // new WakeFromZero ARN or wake-from-backlog silently breaks.
      await this.cloudwatch
        .putMetricAlarm({
          AlarmName: `${endpointName}-HasBacklogWithoutCapacity`,
          Namespace: "AWS/SageMaker",
          MetricName: "HasBacklogWithoutCapacity",
          Dimensions: [{ Name: "EndpointName", Value: endpointName }],
          Statistic: "Average",
          Period: 30,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: "GreaterThanOrEqualToThreshold",
          TreatMissingData: "missing",
          AlarmActions: [wakePolicy.PolicyARN!],
        })
        .promise();

      console.log(`Autoscaling restored for ${endpointName}`);
    } catch (error: any) {
      console.error("Failed to restore autoscaling:", error);
    }
  }
}

export const endpointStatusService = new EndpointStatusService();
