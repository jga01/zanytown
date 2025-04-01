const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/user"); // Adjust path if your model is elsewhere
require("dotenv").config(); // Ensure JWT_SECRET is loaded

const router = express.Router();

// --- Registration Route ---
router.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    // 1. Basic Validation
    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required." });
    }
    if (password.length < 6) {
      // Example minimum length
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long." });
    }
    // Add more validation as needed (e.g., username format)

    // 2. Check if username exists
    const existingUser = await User.findOne({
      username: username.toLowerCase(),
    }); // Case-insensitive check recommended
    if (existingUser) {
      return res.status(409).json({ message: "Username already taken." }); // 409 Conflict
    }

    // 3. Create and save new user
    // Note: Password hashing happens via the 'pre-save' hook in the User model
    const newUser = new User({
      username: username.toLowerCase(), // Store username consistently
      passwordHash: password, // Pass the plain password; the model will hash it before saving
      // Defaults for game state fields (currency, inventory, etc.) are set by the schema
    });

    await newUser.save();

    console.log(`User registered: ${newUser.username}`);
    // Don't send password hash back!
    res.status(201).json({ message: "User registered successfully!" });
  } catch (error) {
    console.error("Registration Error:", error);
    // Distinguish potential validation errors from server errors
    if (error.name === "ValidationError") {
      return res.status(400).json({
        message: "Registration validation failed.",
        errors: error.errors,
      });
    }
    res.status(500).json({ message: "Server error during registration." });
  }
});

// --- Login Route ---
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // 1. Basic Validation
    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required." });
    }

    // 2. Find user by username (case-insensitive recommended)
    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      console.log(`Login attempt failed: User not found - ${username}`);
      return res.status(401).json({ message: "Invalid username or password." }); // Generic message for security
    }

    // 3. Compare password using the method defined in the User model
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log(
        `Login attempt failed: Invalid password for user - ${username}`
      );
      return res.status(401).json({ message: "Invalid username or password." }); // Generic message
    }

    // 4. Generate JWT
    const payload = {
      userId: user._id, // Include user ID in the token
      username: user.username, // Optionally include username
      // Add other non-sensitive data if needed (e.g., roles)
    };

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error(
        "FATAL: JWT_SECRET is not defined in environment variables!"
      );
      return res.status(500).json({ message: "Server configuration error." });
    }

    const token = jwt.sign(
      payload,
      secret,
      { expiresIn: "1d" } // Token expires in 1 day (adjust as needed)
    );

    console.log(`User logged in: ${user.username}`);
    // 5. Send token back to client
    res.status(200).json({
      message: "Login successful!",
      token: token,
      userId: user._id, // Optionally send userId too for convenience client-side
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error during login." });
  }
});

module.exports = router;
