const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

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
    isAdmin: {
      type: Boolean,
      default: false,
    },
    // Game State Fields
    currency: {
      type: Number,
      default: 10,
    },
    inventory: {
      type: Map,
      of: Number,
      default: {},
    },
    bodyColor: {
      type: String,
      default: "#6CA0DC",
    },
    lastRoomId: {
      type: String,
      default: "main_lobby",
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

module.exports = mongoose.model("User", userSchema);
