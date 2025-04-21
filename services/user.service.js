const User = require('../models/user');

module.exports.readByEmail = (email) =>
  new Promise(async (resolve, reject) => {
    try {
      const user = await User.findOne({ email });
      return resolve(user);
    } catch (error) {
      console.error('UserService [readByEmail] Error:', error);
      return reject(error);
    }
  });

module.exports.addUserBasic = ({ firstname, lastname, email, password }) =>
  new Promise(async (resolve, reject) => {
    try {
      const newUser = new User({
        firstname: firstname.trim(),
        lastname: lastname.trim(),
        email: email.toLowerCase().trim(),
        password: password.trim(),
      });
      await newUser.save();
      console.log(`User Service: Created Local User ===> ${newUser._id}`);
      resolve(newUser);
    } catch (error) {
      console.log('UserService [createUser] Error:', error);
      reject(error);
    }
  });

module.exports.readById = (id) =>
  new Promise(async (resolve, reject) => {
    try {
      const user = await User.findById(id).select('-password');

      return resolve(user);
    } catch (error) {
      console.log('UserService [readById] Error: ', error);
      return reject(error);
    }
  });
module.exports.updateForgotPasswordCode = (userId, data) =>
  new Promise(async (resolve, reject) => {
    try {
      const user = await User.findByIdAndUpdate(
        userId,
        {
          forgotPasswordCode: data.forgotPasswordCode,
          passwordResetCodeExpiry: data.passwordResetCodeExpiry,
        },
        { new: true }
      );
      return resolve(user);
    } catch (error) {
      console.log('UserService [updateForgotPasswordCode] error: ', error);
      return reject(error);
    }
  });
module.exports.updatePassword = (userId, newPassword) =>
  new Promise(async (resolve, reject) => {
    try {
      const user = await User.findByIdAndUpdate(
        userId,
        {
          password: newPassword,
        },
        { new: true }
      );
      return resolve(user);
    } catch (error) {
      console.log('Userservice [updatePassword] error :', error);
      return reject(error);
    }
  });

module.exports.validatePassword = (userId, password) =>
  new Promise(async (resolve, reject) => {
    try {
      const foundUser = await User.findById(userId);
      const validation = await foundUser.isValidPassword(password);
      return resolve(validation);
    } catch (error) {
      console.log('UserService [validatePassword] error: ', error);
      return reject(error);
    }
  });

module.exports.getUserById = (userId) =>
  new Promise(async (resolve, reject) => {
    try {
      const user = await User.findById(userId).lean();
      resolve(user);
    } catch (error) {
      console.log('UserService [getUserById] Error:', error);
      reject(error);
    }
  });

module.exports.getAllUsers = () =>
  new Promise(async (resolve, reject) => {
    try {
      const users = await User.find().lean();
      resolve(users);
    } catch (error) {
      console.error('UserService [getAllUsers] Error:', error);
      reject(error);
    }
  });

module.exports.deleteUser = (userId) =>
  new Promise(async (resolve, reject) => {
    try {
      await User.findByIdAndDelete(userId);
      resolve('User Deleted');
    } catch (error) {
      console.error('UserService [deleteUser] Error:', error);
      reject(error);
    }
  });
