// models/user.js
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
// REMOVE the attempt to require config here during definition
// let SHARED_CONFIG = {}; try { SHARED_CONFIG = require('../lib/config').SHARED_CONFIG; } catch(e) {}

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 20,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    // Game State Fields
    currency: {
      type: Number,
      // Use a simple, hardcoded default value here
      default: 10, // <-- CHANGE: Use static default
    },
    inventory: {
      type: Map,
      of: Number,
      default: {},
    },
    bodyColor: {
      type: String,
      default: "#6CA0DC", // Static default
    },
    lastRoomId: {
      type: String,
      // Use a simple, hardcoded default value here
      default: "main_lobby", // <-- CHANGE: Use static default (make sure this ID is valid)
    },
    lastX: { type: Number, default: null }, // Default spawn coords handled on load
    lastY: { type: Number, default: null },
    lastZ: { type: Number, default: 0.0 },
  },
  { timestamps: true }
);

// --- Password Hashing Middleware (Before Saving) ---
userSchema.pre("save", async function (next) {
  if (!this.isModified("passwordHash")) return next();
  try {
    const saltRounds = parseInt(process.env.BCRYPT_SALT_ROUNDS || "10", 10);
    this.passwordHash = await bcrypt.hash(this.passwordHash, saltRounds);
    next();
  } catch (error) {
    next(error);
  }
});

// --- Password Comparison Method ---
userSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  } catch (error) {
    console.error("Error comparing password:", error);
    return false;
  }
};

// REMOVE the second attempt to load config here as well
// try { ... } catch (e) { ... }

module.exports = mongoose.model("User", userSchema);
