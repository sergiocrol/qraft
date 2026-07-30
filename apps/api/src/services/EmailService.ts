import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { getConfig } from "../utils/environment";

interface ActivationRequestData {
  userEmail: string;
  reason: string;
  requestedAt: string;
  ipAddress: string;
}

/** Minimal HTML escape for visitor-provided strings interpolated into emails. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

class EmailService {
  private sesClient: SESClient;
  private isInitialized: boolean = false;

  constructor() {
    this.sesClient = new SESClient({
      region: getConfig().aws.region || "eu-west-1",
    });

    this.isInitialized = true;
  }

  async sendActivationRequest(data: ActivationRequestData): Promise<void> {
    if (!this.isInitialized) {
      console.error("Email service not initialized");
      throw new Error("Email service not available");
    }

    const config = getConfig();
    const adminEmail = config.adminEmail;
    const fromEmail = config.emailFrom;

    if (!adminEmail) {
      console.error("ADMIN_EMAIL not configured");
      throw new Error("Admin email not configured");
    }

    if (!fromEmail) {
      console.error("EMAIL_FROM not configured");
      throw new Error("Sender email not configured");
    }

    const subject = `🎨 QR Generator - Activation Request from ${data.userEmail}`;

    // Visitor-controlled fields, escaped before entering any HTML body.
    const safeEmail = escapeHtml(data.userEmail);
    const safeReason = escapeHtml(data.reason || "No reason provided");

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 10px 10px 0 0; }
          .content { background: #f7f7f7; padding: 20px; border-radius: 0 0 10px 10px; }
          .info-row { margin: 10px 0; padding: 10px; background: white; border-radius: 5px; }
          .label { font-weight: bold; color: #667eea; }
          .button { display: inline-block; padding: 12px 24px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🚀 New Activation Request</h2>
          </div>
          <div class="content">
            <div class="info-row">
              <span class="label">From:</span> ${safeEmail}
            </div>
            <div class="info-row">
              <span class="label">Reason:</span> ${safeReason}
            </div>
            <div class="info-row">
              <span class="label">Requested at:</span> ${new Date(data.requestedAt).toLocaleString()}
            </div>
            <div class="info-row">
              <span class="label">IP Address:</span> ${data.ipAddress || "Unknown"}
            </div>
            
            <p><strong>To activate the endpoint:</strong></p>
            <ol>
              <li>Go to the admin panel</li>
              <li>Click "Scale to 1"</li>
              <li>Wait 7-10 minutes for the endpoint to start</li>
            </ol>
            
            <a href="${config.clientUrl}/admin" class="button">
              Open Admin Panel
            </a>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
New Activation Request for QR Generator

From: ${data.userEmail}
Reason: ${data.reason || "No reason provided"}
Requested at: ${new Date(data.requestedAt).toLocaleString()}
IP Address: ${data.ipAddress || "Unknown"}

To activate the endpoint:
1. Go to the admin panel
2. Click "Scale to 1"
3. Wait 7-10 minutes for the endpoint to start

Admin Panel: ${config.clientUrl}/admin
    `;

    try {
      const command = new SendEmailCommand({
        Source: fromEmail,
        Destination: {
          ToAddresses: [adminEmail],
        },
        Message: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: textContent },
            Html: { Data: htmlContent },
          },
        },
      });

      const response = await this.sesClient.send(command);

      if (data.userEmail !== adminEmail && data.userEmail.includes("@")) {
        try {
          const userCommand = new SendEmailCommand({
            Source: fromEmail,
            Destination: {
              ToAddresses: [data.userEmail],
            },
            Message: {
              Subject: {
                Data: "🎨 QR Generator - Activation Request Received",
              },
              Body: {
                Text: {
                  Data: `Your activation request has been received. The administrator will review it shortly.\n\nRequest details:\n- Reason: ${data.reason || "No reason provided"}\n- Submitted at: ${new Date(data.requestedAt).toLocaleString()}`,
                },
                Html: {
                  Data: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                      <h2>Activation Request Received</h2>
                      <p>Your activation request has been received. The administrator will review it shortly.</p>
                      <div style="background: #f0f0f0; padding: 15px; border-radius: 5px; margin: 20px 0;">
                        <strong>Request details:</strong><br>
                        - Reason: ${safeReason}<br>
                        - Submitted at: ${new Date(data.requestedAt).toLocaleString()}
                      </div>
                    </div>
                  `,
                },
              },
            },
          });

          await this.sesClient.send(userCommand);
        } catch (err) {
          console.warn("⚠️ Could not send confirmation to requester:", err);
        }
      }
    } catch (error: any) {
      console.error("Failed to send email:", error);

      if (error.name === "MessageRejected") {
        throw new Error("Email rejected: Address may not be verified in SES");
      } else if (error.name === "MailFromDomainNotVerified") {
        throw new Error("Sender email not verified in SES");
      } else if (error.message?.includes("not verified")) {
        throw new Error(
          "Email not verified in SES. In sandbox mode, both sender and recipient must be verified.",
        );
      } else {
        throw new Error(
          `Failed to send email: ${error.message || "Unknown error"}`,
        );
      }
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      return this.isInitialized && !!this.sesClient;
    } catch {
      return false;
    }
  }
}

export const emailService = new EmailService();
