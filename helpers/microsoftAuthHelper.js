const axios = require("axios");
const B2CUser = require("../models/user");
const jwt = require("jsonwebtoken");

const TENANT_NAME = process.env.MS_TENANT_NAME;
const POLICY = process.env.MS_POLICY;
const CLIENT_ID = process.env.MS_CLIENT_ID;
const REDIRECT_URI = process.env.MS_REDIRECT_URI;

const TOKEN_ENDPOINT = `https://${TENANT_NAME}.b2clogin.com/${TENANT_NAME}.onmicrosoft.com/${POLICY}/oauth2/v2.0/token`;

class MicrosoftAuthHelper {
  static async exchangeCodeForTokens(code, codeVerifier) {
    console.log("Starting token exchange with Microsoft");
    console.log("Code received:", code ? "Present" : "Missing");

    const data = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
      scope: "openid profile offline_access",
    });

    try {
      const response = await axios.post(TOKEN_ENDPOINT, data.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      console.log("Token exchange successful");
      console.log("Tokens received:", {
        id_token: response.data.id_token ? "Present" : "Missing",
        refresh_token: response.data.refresh_token ? "Present" : "Missing",
      });

      return response.data;
    } catch (error) {
      console.log("Token exchange failed:", error.message);
      console.log("Error details:", error.response?.data);
      throw error;
    }
  }

  static decodeIdToken(idToken) {
    console.log("Decoding ID token");
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    console.log("Decoded token payload:", payload);

    return {
      userEmail: payload.emails?.[0] || null,
      userFirstName: payload.given_name || null,
      userLastName: payload.family_name || null,
      userFullName: `${payload.given_name || ""} ${payload.family_name || ""}`.trim(),
      userMobilePhone: payload.extension_mobilePhone || null,
      userMemberNumber: payload.extension_MemberNo || null,
      userMicrosoftId: payload.oid || null,
      userSubject: payload.sub || null,
      userAudience: payload.aud || null,
      userIssuer: payload.iss || null,
      userIssuedAt: payload.iat || null,
      userAuthTime: payload.auth_time || null,
      userTokenVersion: payload.ver || null,
      userPolicy: payload.tfp || null,
    };
  }

  static async findOrCreateUser(profile, tokens) {
    console.log("Finding or creating user");
    console.log("User profile:", profile);

    const email = profile.userEmail;
    if (!email) {
      console.log("Email not found in profile");
      throw new Error("Email not found in Microsoft token");
    }

    const update = {
      ...profile,
      userAuthProvider: "microsoft",
      userLastLogin: new Date(),
      tokens: {
        id_token: tokens.id_token || null,
        refresh_token: tokens.refresh_token || null,
        id_token_expires_in: tokens.expires_in || null,
        refresh_token_expires_in: tokens.refresh_token_expires_in || null,
      },
    };

    try {
      let user = await B2CUser.findOne({ userEmail: email });

      console.log(user ? "Updating existing user" : "Creating new user");

      if (user) {
        user.set(update);
      } else {
        user = new B2CUser(update);
      }

      await user.save();
      console.log("User saved successfully");
      return user;
    } catch (error) {
      console.log("Error saving user:", error.message);
      throw error;
    }
  }

  static async handleMicrosoftAuth(code, codeVerifier) {
    const tokens = await this.exchangeCodeForTokens(code, codeVerifier);
    const profile = this.decodeIdToken(tokens.id_token);
    const user = await this.findOrCreateUser(profile, tokens);
    return { user, tokens };
  }
}

module.exports = MicrosoftAuthHelper;
