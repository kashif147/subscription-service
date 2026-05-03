var path = require("path");
require("dotenv").config();

// Suppress Application Insights warnings if not configured
// Azure App Service auto-injects Application Insights, but warnings appear if key is missing
if (
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING &&
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING.trim() === ""
) {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = undefined;
}
if (
  !process.env.APPINSIGHTS_INSTRUMENTATIONKEY ||
  process.env.APPINSIGHTS_INSTRUMENTATIONKEY.trim() === ""
) {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk, encoding, callback) {
    const message = chunk.toString();
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return true;
    }
    return originalStderrWrite(chunk, encoding, callback);
  };

  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;

  console.warn = function (...args) {
    const message = args.join(" ");
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return;
    }
    originalConsoleWarn.apply(console, args);
  };

  console.error = function (...args) {
    const message = args.join(" ");
    if (
      message.includes("ApplicationInsights") &&
      (message.includes("instrumentation key") || message.includes("iKey"))
    ) {
      return;
    }
    originalConsoleError.apply(console, args);
  };
}

var createError = require("http-errors");
var express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpecs = require("./config/swagger");

const { mongooseConnection } = require("./config/db");
require("./models");
const session = require("express-session");

const bizLogger = require("./config/bizLogger.js");
const {
  correlationIdMiddleware,
  logErrorMiddleware,
  createSystemLogsRouter,
} = require("@projectShell/logging-lib");
const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");
const {
  corsMiddleware,
  handlePreflight,
  corsErrorHandler,
} = require("./config/cors");
const {
  initEventSystem,
  setupConsumers,
  shutdownEventSystem,
} = require("./rabbitMQ");

var app = express();

// Disable Express automatic ETag generation (304 responses)
app.set("etag", false);

app.use(correlationIdMiddleware);
app.use(responseMiddleware);

mongooseConnection();

// Initialize RabbitMQ event system - Now using middleware

if (process.env.RABBIT_URL) {
  console.log("🐰 RabbitMQ URL configured, initializing with middleware...");
  initEventSystem()
    .then(() => {
      console.log("✅ Initializing RabbitMQ consumers...");
      return setupConsumers();
    })
    .then(() => {
      const {
        startCancellationGraceSweep,
      } = require("./jobs/cancellationGraceSweep.js");
      startCancellationGraceSweep();
      console.log(
        "✅ RabbitMQ fully initialized with middleware (subscription-service)",
      );
    })
    .catch((error) => {
      console.error("❌ Failed to initialize RabbitMQ:", error.message);
      console.error("⚠️ App will continue without RabbitMQ (degraded mode)");
    });

  // Graceful shutdown
  process.on("SIGTERM", async () => {
    console.log("⏹️  SIGTERM received, shutting down gracefully...");
    await shutdownEventSystem();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("⏹️  SIGINT received, shutting down gracefully...");
    await shutdownEventSystem();
    process.exit(0);
  });
} else {
  console.warn(
    "⚠️ RABBIT_URL not configured, skipping RabbitMQ initialization",
  );
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use("/api", createSystemLogsRouter(bizLogger));

app.use(loggerMiddleware);

// CORS intentionally disabled at app layer for now.
// Upstream gateway/proxy should be the single source of CORS headers.

app.use(
  session({
    secret: "secret2024",
    resave: false,
    saveUninitialized: false,
  }),
);

app.set("view engine", "ejs");

app.use(express.static("public"));

// Swagger documentation
app.use(
  "/swagger",
  swaggerUi.serve,
  swaggerUi.setup(swaggerSpecs, {
    explorer: true,
    customCss: ".swagger-ui .topbar { display: none }",
    customSiteTitle: "User Service API Documentation",
  }),
);

app.get("/", (req, res) => {
  res.render("index", { title: "Subscription Service" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "UP" });
});

app.use("/api/v1", require("./routes/index"));

app.use(function (req, res, next) {
  next(createError(404));
});

app.use(logErrorMiddleware(bizLogger));

app.use((err, req, res, next) => {
  console.error(err.message || "Page Not Found");
  if (req.correlationId) {
    res.setHeader("x-correlation-id", req.correlationId);
  }
  res.fail("Page Not Found");
});

// SIGINT handler is already set up above if RABBIT_URL is configured
if (!process.env.RABBIT_URL) {
  process.on("SIGINT", async () => {
    process.exit(0);
  });
}

module.exports = app;
