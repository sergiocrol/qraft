import { createServer } from "http";
import app, { jobManager, config } from "./app";

const server = createServer(app);

server.listen(config.port, config.host, () => {
  console.log(`🚀 QR ControlNet API Server started`);
  console.log(`📍 Server: http://${config.host}:${config.port}`);
  console.log(`📊 Environment: ${config.nodeEnv}`);
  console.log(`📊 Health: http://${config.host}:${config.port}/api/health`);
  console.log(
    `🎨 QR Generation: http://${config.host}:${config.port}/api/qr-generation`
  );

  jobManager.start();
});

const gracefulShutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down gracefully...`);

  server.close(() => {
    console.log("HTTP server closed");
    jobManager.stop();
    console.log("Job manager stopped");
    process.exit(0);
  });

  setTimeout(() => {
    console.error(
      "Could not close connections in time, forcefully shutting down"
    );
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
