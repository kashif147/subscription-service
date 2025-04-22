var path = require("path");
require("dotenv").config();

var createError = require("http-errors");
var express = require("express");
const cors = require("cors");
const swaggerUi = require("swagger-ui-express");
const swaggerSpecs = require("./config/swagger");

const { mongooseConnection } = require("./config/db");
const session = require("express-session");

const loggerMiddleware = require("./middlewares/logger.mw");
const responseMiddleware = require("./middlewares/response.mw");

var app = express();

app.use(responseMiddleware);

mongooseConnection();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "200mb" }));

app.use(loggerMiddleware);

app.use(cors());

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
