const {
	init,
	consumer,
	shutdown,
} = require("@projectShell/rabbitmq-middleware");
const { registerSubscriptionUpsertConsumer } = require("./listeners/subscription.upsert.listener");

async function initEventSystem() {
	await init({
		url: process.env.RABBIT_URL,
		logger: console,
		prefetch: 10,
	});
}

async function setupConsumers() {
	await registerSubscriptionUpsertConsumer();
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


