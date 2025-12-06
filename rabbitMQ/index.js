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

async function initEventSystem() {
	const rabbitUrl = process.env.RABBIT_URL;
	
	if (!rabbitUrl) {
		throw new Error("RABBIT_URL environment variable is not set");
	}
	
	// Ensure URL has proper protocol prefix
	let url = rabbitUrl.trim();
	if (!url.startsWith("amqp://") && !url.startsWith("amqps://")) {
		// If URL doesn't have protocol, assume amqp://
		if (url.includes("://")) {
			throw new Error(`RABBIT_URL must use amqp:// or amqps:// protocol. Got: ${url.split("://")[0]}://`);
		}
		url = `amqp://${url}`;
		console.warn(`⚠️ RABBIT_URL missing protocol prefix, assuming amqp://. Full URL: ${url.replace(/\/\/.*@/, "//***@")}`);
	}
	
	await init({
		url: url,
		logger: console,
		prefetch: 10,
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


