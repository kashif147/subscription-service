const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Subscription Service API",
      version: "1.0.0",
      description: "API documentation for Subscription Service",
    },
    servers: [
      {
        url: "http://localhost:4400",
        description: "Development server",
      },
      {
        url: "https://subscriptionserviceshell-ambyf5dsa8c9dhcg.northeurope-01.azurewebsites.net/",
        description: "Production server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  apis: ["./routes/*.js", "./controllers/*.js"],
};

const specs = swaggerJsdoc(options);

module.exports = specs;
