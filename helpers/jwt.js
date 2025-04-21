const jwt = require('jsonwebtoken');

module.exports.generateToken = (user) => ({
  token: 'Bearer ' + jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY }),
  user,
});
