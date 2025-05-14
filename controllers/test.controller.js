module.exports.testing = async (req, res) => {
  return res.status(200).json({
    success: true,
    username: req.user.UserInfo.username,
    roles: req.user.UserInfo.roles,
    message: "Testing successful",
  });
};
