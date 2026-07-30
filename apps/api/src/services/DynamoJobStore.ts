import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { QRJob, JobStatus } from "@repo/shared-types";

export interface AsyncQRJob extends QRJob {
  apiGatewayRequestId?: string;
  outputLocation?: string;
  lastStatusCheck?: string;
  statusCheckFailCount?: number;
  ttl?: number;
  /**
   * Unguessable per-job secret minted at creation. Returned only in the
   * create response; required (via X-Job-Token header or ?token=) to read
   * status or cancel the job. Never echo it from read endpoints.
   */
  accessToken?: string;
}

interface DynamoJobStoreConfig {
  tableName: string;
  region: string;
  maxJobAgeSec: number;
  completedJobRetentionSec: number;
  failedJobRetentionSec: number;
}

export class DynamoJobStore {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;
  private config: DynamoJobStoreConfig;

  constructor(config: DynamoJobStoreConfig) {
    this.config = config;
    this.tableName = config.tableName;

    const client = new DynamoDBClient({ region: config.region });
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
        convertClassInstanceToMap: true,
      },
    });
  }

  /**
   * Save or update a job in DynamoDB.
   * Automatically sets a TTL based on job status.
   */
  async putJob(job: AsyncQRJob): Promise<void> {
    const ttl = this.calculateTTL(job);

    const item = {
      ...job,
      ttl,
    };

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: item,
      }),
    );
  }

  /**
   * Retrieve a single job by ID.
   */
  async getJob(jobId: string): Promise<AsyncQRJob | undefined> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { id: jobId },
      }),
    );

    return result.Item as AsyncQRJob | undefined;
  }

  /**
   * Delete a job by ID.
   */
  async deleteJob(jobId: string): Promise<void> {
    await this.docClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { id: jobId },
      }),
    );
  }

  /**
   * Get all jobs with optional filters.
   * Uses GSI query when filtering by status, otherwise scans.
   */
  async getAllJobs(filters?: {
    status?: JobStatus;
    limit?: number;
    offset?: number;
  }): Promise<AsyncQRJob[]> {
    let jobs: AsyncQRJob[];

    if (filters?.status) {
      // Use GSI to query by status
      const result = await this.docClient.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: "status-createdAt-index",
          KeyConditionExpression: "#s = :status",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":status": filters.status },
        }),
      );
      jobs = (result.Items as AsyncQRJob[]) || [];
    } else {
      // Full scan (acceptable for low-volume fun project)
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
        }),
      );
      jobs = (result.Items as AsyncQRJob[]) || [];
    }

    // Sort by createdAt descending (newest first)
    jobs.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    // Apply offset
    if (filters?.offset) {
      jobs = jobs.slice(filters.offset);
    }

    // Apply limit
    if (filters?.limit) {
      jobs = jobs.slice(0, filters.limit);
    }

    return jobs;
  }

  // Get jobs with pagination in a single call. Returns both the page slice and total count
  async getJobsPaginated(filters: {
    status?: JobStatus;
    limit: number;
    offset: number;
  }): Promise<{ jobs: AsyncQRJob[]; total: number }> {
    const all = await this.getAllJobs({
      status: filters.status,
      limit: undefined,
      offset: undefined,
    });
    const total = all.length;
    const jobs = all.slice(filters.offset, filters.offset + filters.limit);
    return { jobs, total };
  }

  /**
   * Get aggregated job statistics.
   */
  async getJobStats(): Promise<{
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
  }> {
    const result = await this.docClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ProjectionExpression: "#s",
        ExpressionAttributeNames: { "#s": "status" },
      }),
    );

    const items = result.Items || [];

    return {
      total: items.length,
      pending: items.filter((j) => j.status === "pending").length,
      processing: items.filter((j) => j.status === "processing").length,
      completed: items.filter((j) => j.status === "completed").length,
      failed: items.filter((j) => j.status === "failed").length,
      cancelled: items.filter((j) => j.status === "cancelled").length,
    };
  }

  /**
   * Calculate TTL (epoch seconds) for DynamoDB auto-expiration.
   * Replaces the old in-memory cleanupOldJobs() interval.
   */
  private calculateTTL(job: AsyncQRJob): number {
    const nowSec = Math.floor(Date.now() / 1000);

    switch (job.status) {
      case "completed":
        return nowSec + this.config.completedJobRetentionSec;
      case "failed":
        return nowSec + this.config.failedJobRetentionSec;
      default:
        return nowSec + this.config.maxJobAgeSec;
    }
  }
}
