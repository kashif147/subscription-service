const {
	init,
	consumer,
	shutdown,
} = require("@projectShell/rabbitmq-middleware");
const { registerSubscriptionUpsertConsumer } = require("./listeners/subscription.upsert.listener");
const {
	handleCrmUserCreated,
	handleCrmUserUpdated,
} = require("./listeners/user.crm.listener");

// Custom logger wrapper to ensure RabbitMQ logs appear in Azure Log Stream
// Maps logger.info() to console.log() so logs are visible
const rabbitMQLogger = {
	info: (...args) => {
		const prefix = "[RabbitMQ]";
		if (args.length === 1 && typeof args[0] === "string") {
			console.log(`${prefix} ${args[0]}`);
		} else if (args.length === 2 && typeof args[0] === "string" && typeof args[1] === "object") {
			console.log(`${prefix} ${args[0]}`, args[1]);
		} else {
			console.log(prefix, ...args);
		}
	},
	warn: (...args) => {
		const prefix = "[RabbitMQ]";
		if (args.length === 1 && typeof args[0] === "string") {
			console.warn(`${prefix} ${args[0]}`);
		} else if (args.length === 2 && typeof args[0] === "string" && typeof args[1] === "object") {
			console.warn(`${prefix} ${args[0]}`, args[1]);
		} else {
			console.warn(prefix, ...args);
		}
	},
	error: (...args) => {
		const prefix = "[RabbitMQ]";
		if (args.length === 1 && typeof args[0] === "string") {
			console.error(`${prefix} ${args[0]}`);
		} else if (args.length === 2 && typeof args[0] === "string" && typeof args[1] === "object") {
			console.error(`${prefix} ${args[0]}`, args[1]);
		} else {
			console.error(prefix, ...args);
		}
	},
};

async function initEventSystem() {
	const rabbitUrl = process.env.RABBIT_URL;
	
	// Trim and validate - check after trimming to catch whitespace-only values
	if (!rabbitUrl || !rabbitUrl.trim()) {
		throw new Error("RABBIT_URL environment variable is not set or is empty");
	}
	
	// Ensure URL has proper protocol prefix
	let url = rabbitUrl.trim();
	if (!url.startsWith("amqp://") && !url.startsWith("amqps://")) {
		// If URL doesn't have protocol, assume amqp://
		if (url.includes("://")) {
			throw new Error(`RABBIT_URL must use amqp:// or amqps:// protocol. Got: ${url.split("://")[0]}://`);
		}
		// Ensure there's content after prepending protocol
		if (!url || url.length === 0) {
			throw new Error("RABBIT_URL is empty or contains only whitespace");
		}
		url = `amqp://${url}`;
		console.warn(`⚠️ RABBIT_URL missing protocol prefix, assuming amqp://. Full URL: ${url.replace(/\/\/.*@/, "//***@")}`);
	}
	
	// Validate that URL is not just the protocol
	if (url === "amqp://" || url === "amqps://") {
		throw new Error("RABBIT_URL must include host information, not just the protocol");
	}
	
	await init({
		url: url,
		logger: rabbitMQLogger,
		prefetch: 10,
		connectionName: "subscription-service",
		serviceName: "subscription-service",
	});
}

async function setupConsumers() {
	await registerSubscriptionUpsertConsumer();

	// CRM user events queue (user.events exchange)
	const USER_QUEUE = "subscription.user.events";
	console.log("🔧 [SETUP] Creating user queue...");
	console.log("   Queue:", USER_QUEUE);
	console.log("   Exchange: user.events");
	console.log(
		"   Routing Keys: user.crm.created.v1, user.crm.updated.v1"
	);

	await consumer.createQueue(USER_QUEUE, {
		durable: true,
		messageTtl: 3600000, // 1 hour
	});

	await consumer.bindQueue(USER_QUEUE, "user.events", [
		"user.crm.created.v1",
		"user.crm.updated.v1",
	]);

	consumer.registerHandler(
		"user.crm.created.v1",
		async (payload, context) => {
			await handleCrmUserCreated(payload);
		}
	);

	consumer.registerHandler(
		"user.crm.updated.v1",
		async (payload, context) => {
			await handleCrmUserUpdated(payload);
		}
	);

	await consumer.consume(USER_QUEUE, { prefetch: 10 });
	console.log("✅ User events consumer ready:", USER_QUEUE);
}

async function shutdownEventSystem() {
	await shutdown();
}

module.exports = {
	initEventSystem,
	setupConsumers,
	shutdownEventSystem,
	consumer,
};


