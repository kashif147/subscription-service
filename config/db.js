const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI).then((data) => {
      console.log(`SuccessFully Connected to the MongoDB ===> "${data.connection.name}"`);
    });
  } catch (e) {
    console.error("Unable to connect to database:", e);
  }
};
