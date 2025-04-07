// routes/authRoutes.js

const express = require("express");
const bcrypt = require("bcrypt"); // bcrypt is used implicitly via user model methods
const jwt = require("jsonwebtoken");
const User = require("../models/user"); // Adjust path if your model is elsewhere
require("dotenv").config(); // Ensure JWT_SECRET is loaded from .env

const router = express.Router();

// --- Registration Route ---
router.post("/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    // 1. Basic Server-Side Validation
    if (!username || !password) {
      return res
        .status(400)
        .json({ message: "Username and password are required." });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long." });
    }
    // --- Username Format Validation ---
    const usernameRegex = /^[a-zA-Z0-9_]+$/; // Allow letters, numbers, underscore
    if (
      username.length < 3 ||
      username.length > 20 ||
      !usernameRegex.test(username)
    ) {
      return res
        .status(400)
        .json({
          message:
            "Username must be 3-20 characters using only letters, numbers, or underscores.",
        });
    }
    // --- End Validation ---

    // 2. Check if username exists (Case-insensitive)
    const lowerUsername = username.toLowerCase();
    const existingUser = await User.findOne({ username: lowerUsername });
    if (existingUser) {
      // Log specific reason, send generic message
      console.log(
        `Registration attempt failed: Username '${lowerUsername}' already taken.`
      );
      // Use 400 Bad Request as the user input (username) is the issue from client perspective
      return res
        .status(400)
        .json({
          message: "Registration failed. Please try a different username.",
        });
    }

    // 3. Create and save new user
    // Password hashing happens via the 'pre-save' hook in the User model
    const newUser = new User({
      username: lowerUsername, // Store username consistently lowercase
      passwordHash: password, // Pass the plain password; the model will hash it
    });

    await newUser.save(); // This might throw a ValidationError if schema constraints fail

    console.log(`User registered: ${newUser.username}`);
    // Send clear success message
    res
      .status(201)
      .json({ message: "User registered successfully! Please log in." });
  } catch (error) {
    console.error("Registration Error:", error); // Log the detailed error

    // Check for Mongoose Validation Errors first
    if (error.name === "ValidationError") {
      // Log detailed validation errors for debugging
      console.error("Registration Validation Errors:", error.errors);
      // Send generic validation message
      return res
        .status(400)
        .json({ message: "Registration failed due to invalid input." });
    }

    // Check for potential duplicate key errors during save (if unique index fails despite check)
    // MongoDB duplicate key error code is 11000
    if (error.code === 11000) {
      console.log(
        `Registration attempt failed: Duplicate key error (likely username race condition) for '${username?.toLowerCase()}'.`
      );
      return res
        .status(400)
        .json({
          message: "Registration failed. Please try a different username.",
        }); // Same generic message as initial check
    }

    // Generic message for all other errors (DB connection issues, unexpected errors)
    res
      .status(500)
      .json({ message: "Registration failed due to a server error." });
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

    // 2. Find user by username (Case-insensitive)
    const lowerUsername = username.toLowerCase();
    const user = await User.findOne({ username: lowerUsername });

    // 3. Compare password using the method defined in the User model
    // Use optional chaining and nullish coalescing for a combined check
    const passwordMatch = (await user?.comparePassword(password)) ?? false;

    // --- Combined User Not Found / Invalid Password Check ---
    if (!user || !passwordMatch) {
      // Log specific failure reason internally for debugging
      if (!user) {
        console.log(`Login attempt failed: User not found - ${lowerUsername}`);
      } else {
        // User was found, so password must be wrong
        console.log(
          `Login attempt failed: Invalid password for user - ${lowerUsername}`
        );
      }
      // Send generic message externally (401 Unauthorized)
      return res.status(401).json({ message: "Invalid username or password." });
    }
    // --- End Combined Check ---

    // User found and password matches

    // 4. Generate JWT
    const payload = {
      userId: user._id, // Include user ID in the token
      username: user.username, // Optionally include username
    };

    const secret = process.env.JWT_SECRET;
    // Critical check: Ensure secret is loaded
    if (!secret) {
      console.error(
        "FATAL: JWT_SECRET is not defined in environment variables!"
      );
      // Don't expose this specific error to client, use generic server error
      return res
        .status(500)
        .json({ message: "Login failed due to a server configuration error." });
    }

    const token = jwt.sign(
      payload,
      secret,
      { expiresIn: "1d" } // Token expires in 1 day
    );

    console.log(`User logged in: ${user.username}`);
    // 5. Send token back to client
    res.status(200).json({
      message: "Login successful!",
      token: token,
      userId: user._id, // Optionally send userId too
    });
  } catch (error) {
    console.error("Login Error:", error); // Log detailed error
    // Send generic message for any server error during login
    res.status(500).json({ message: "Login failed due to a server error." });
  }
});

module.exports = router;
