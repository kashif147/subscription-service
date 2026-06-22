const mongoose = require("mongoose");

exports.mongooseConnection = async () => {
  try {
    const data = await mongoose.connect(process.env.MONGO_URI);
    console.log(
      `SuccessFully Connected to the MongoDB ===> "${data.connection.name}"`,
    );
    return data;
  } catch (e) {
    console.error("Unable to connect to database:", e);
    throw e;
  }
};
