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
	await init({
		url: process.env.RABBIT_URL,
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


