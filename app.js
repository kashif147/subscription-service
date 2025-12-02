var path = require("path");
require("dotenv").config();

// Suppress Application Insights warnings if not configured
// Azure App Service auto-injects Application Insights, but warnings appear if key is missing
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING && process.env.APPLICATIONINSIGHTS_CONNECTION_STRING.trim() === "") {
  process.env.APPLICATIONINSIGHTS_CONNECTION_STRING = undefined;
}
if (!process.env.APPINSIGHTS_INSTRUMENTATIONKEY || process.env.APPINSIGHTS_INSTRUMENTATIONKEY.trim() === "") {
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, encoding, callback) {
    const message = chunk.toString();
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
      return true;
    }
    return originalStderrWrite(chunk, encoding, callback);
  };
  
  const originalConsoleWarn = console.warn;
  const originalConsoleError = console.error;
  
  console.warn = function(...args) {
    const message = args.join(" ");
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
      return;
    }
    originalConsoleWarn.apply(console, args);
  };
  
  console.error = function(...args) {
    const message = args.join(" ");
    if (message.includes("ApplicationInsights") && (message.includes("instrumentation key") || message.includes("iKey"))) {
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
const session = require("express-session");

const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");
const {
  corsMiddleware,
  handlePreflight,
  corsErrorHandler,
} = require("./config/cors");
const { initEventSystem, setupConsumers } = require("./rabbitMQ");

var app = express();

app.use(responseMiddleware);

mongooseConnection();

// Initialize RabbitMQ consumers (non-blocking)
(async () => {
	try {
		await initEventSystem();
		await setupConsumers();
		console.log("✅ RabbitMQ consumers initialized (subscription-service)");
	} catch (err) {
		console.error("❌ Failed to initialize RabbitMQ consumers:", err.message);
	}
})();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use(loggerMiddleware);

// CORS middleware with enhanced configuration
app.use(handlePreflight);
app.use(corsMiddleware);
app.use(corsErrorHandler);

app.use(
  session({
    secret: "secret2024",
    resave: false,
    saveUninitialized: false,
  })
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
  })
);

app.get("/", (req, res) => {
  res.render("index", { title: "Subscription Service" });
});

app.use("/api/v1", require("./routes/index"));

app.use(function (req, res, next) {
  next(createError(404));
});

app.use((err, req, res, next) => {
  console.error(err.message || "Page Not Found");
  res.fail("Page Not Found");
});

process.on("SIGINT", async () => {
  process.exit(0);
});

module.exports = app;
