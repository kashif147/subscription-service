const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  userEmail: { type: String, default: null }, // `emails[0]`
  userFirstName: { type: String, default: null }, // `given_name`
  userLastName: { type: String, default: null }, // `family_name`
  userFullName: { type: String, default: null }, //given_name + family_name
  userMobilePhone: { type: String, default: null }, // `extension_mobilePhone`
  userMemberNumber: { type: String, default: null }, // `extension_MemberNo`
  userMicrosoftId: { type: String, default: null }, // `oid`
  userAuthProvider: { type: String, default: "microsoft" }, // fixed value for tracking auth source
  userSubject: { type: String, default: null }, // `sub`
  userAudience: { type: String, default: null }, // `aud`
  userIssuer: { type: String, default: null }, // `iss`
  userIssuedAt: { type: Number, default: null }, // `iat`
  userAuthTime: { type: Number, default: null }, // `auth_time`
  userTokenVersion: { type: String, default: null }, // `ver`
  userPolicy: { type: String, default: null }, // `tfp`

  userLastLogin: { type: Date, default: Date.now }, // current timestamp

  tokens: {
    id_token: { type: String, default: null }, // full ID token from Microsoft
    refresh_token: { type: String, default: null }, // refresh token
    id_token_expires_in: { type: Number, default: null }, // token expiry time (optional)
    refresh_token_expires_in: { type: Number, default: null }, // refresh token expiry (optional)
  },
});

module.exports = mongoose.model("User", UserSchema);
