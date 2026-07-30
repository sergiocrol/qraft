import { Handler } from "aws-lambda";
import { endpointStatusService } from "./services/EndpointStatusService";
import { loadEnvironment } from "./utils/environment";

export const scheduledScaler: Handler = async (event, context) => {
  console.log("Starting scheduled scaling check...");
  loadEnvironment();

  try {
    await endpointStatusService.checkAndReleaseSuspension();
    // Self-heal after an admin instance-type change: deregistering the
    // scalable target is required before update-endpoint and deletes its
    // policies — restore target/policies/wake-alarm once InService again.
    await endpointStatusService.restoreAutoscalingIfMissing();
    return { statusCode: 200, body: "Scaling check complete" };
  } catch (error) {
    console.error("Scheduled scaling check failed:", error);
    return { statusCode: 500, body: "Scaling check failed" };
  }
};
