"use strict";

// --- Core Modules ---
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
require("dotenv").config(); // Load environment variables FIRST
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const ServerRoom = require("./lib/room"); // Loads the DB-aware room.js
const SocketHandlers = require("./server_socket_handlers");
const ConsoleCommands = require("./server_console");
// ServerGameObject needed for instanceof checks, ServerAvatar for explicit use
const { ServerGameObject, ServerAvatar } = require("./lib/game_objects");
const connectDB = require("./lib/db");
const authRoutes = require("./routes/authRoutes");
const User = require("./models/user");
const Furniture = require("./models/furniture"); // Load Furniture model (used indirectly via room.js and handlers)

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Middleware ---
app.use(express.json()); // Middleware to parse JSON bodies

// --- Game State ---
const rooms = new Map(); // Map<roomId, ServerRoom>
let gameLoopInterval;
let consoleInterface;
// Map: socket.id -> { socket, avatarId (runtime), userId (persistent User._id) }
const clients = {};

// --- Database Helper Functions ---
async function findUserByIdFromDB(userId) {
  try {
    // Validate if userId is a valid MongoDB ObjectId format
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      // console.log(`DB Helper: Invalid userId format: ${userId}`); // Can be noisy
      return null;
    }
    // Find user by ID and return as a plain JavaScript object
    const user = await User.findById(userId).lean();
    if (!user) {
      // console.log(`DB Helper: User ${userId} not found.`); // Can be noisy
      return null;
    }
    // Ensure inventory is a plain object if it was stored as a Map (lean should handle this)
    if (user.inventory instanceof Map) {
      user.inventory = Object.fromEntries(user.inventory);
    }
    return user;
  } catch (error) {
    console.error(`DB Helper Error finding user ${userId}:`, error);
    throw error; // Re-throw to be caught by caller
  }
}

async function updateUserInDB(userId, updateData) {
  try {
    // Validate userId format
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.error(`DB Helper Update: Invalid userId format: ${userId}`);
      return null;
    }
    // Find user by ID and update using $set operator
    // `new: true` returns the modified document
    // `lean: true` returns a plain JavaScript object
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, lean: true }
    );
    if (!updatedUser) {
      console.error(`DB Helper: Failed to find user ${userId} for update.`);
      return null;
    }
    return updatedUser;
  } catch (error) {
    console.error(`DB Helper Error updating user ${userId}:`, error);
    throw error; // Re-throw
  }
}

// --- Graceful Shutdown Function ---
async function shutdown() {
  console.log("\nInitiating graceful shutdown...");

  // 1. Stop game loop
  if (gameLoopInterval) {
    clearInterval(gameLoopInterval);
    console.log("Game loop stopped.");
  }

  // 2. Close console input
  if (consoleInterface) {
    try {
      consoleInterface.close();
    } catch (e) {
      /* Ignore */
    }
  }

  // 3. Save Player State to Database
  console.log("Saving player state before shutdown...");
  const savePromises = [];
  const activeAvatars = [];
  // Collect all active avatars from all rooms
  rooms.forEach((room) => {
    Object.values(room.avatars).forEach((avatar) => {
      if (avatar instanceof ServerAvatar) {
        // Ensure it's an avatar object
        activeAvatars.push(avatar);
      }
    });
  });
  // Create a map from runtime avatarId to persistent userId
  const avatarIdToUserIdMap = {};
  Object.values(clients).forEach((clientInfo) => {
    if (clientInfo && clientInfo.userId && clientInfo.avatarId != null) {
      avatarIdToUserIdMap[clientInfo.avatarId] = clientInfo.userId;
    }
  });

  // Iterate through active avatars and schedule DB updates
  for (const avatar of activeAvatars) {
    const userId = avatarIdToUserIdMap[avatar.id]; // Lookup userId using runtime avatar.id
    if (userId) {
      try {
        const playerState = {
          currency: avatar.currency,
          inventory: Object.fromEntries(avatar.inventory || new Map()), // Convert Map to Object
          bodyColor: avatar.bodyColor,
          lastRoomId: avatar.roomId,
          lastX: Math.round(avatar.x),
          lastY: Math.round(avatar.y),
          lastZ: avatar.z,
        };
        savePromises.push(updateUserInDB(userId, playerState)); // Add promise to array
      } catch (error) {
        console.error(
          `Error preparing save data for avatar ${avatar.id} (User ID: ${userId}):`,
          error
        );
      }
    } else {
      // Should be rare if client mapping is correct
      console.warn(
        `Could not find userId for avatar ${avatar.id} (${avatar.name}) during shutdown save.`
      );
    }
  }

  // Wait for all player saves to complete
  try {
    await Promise.all(savePromises);
    console.log(
      `Player state saving process completed. ${savePromises.length} players processed.`
    );
  } catch (saveError) {
    console.error("Error during bulk player state saving:", saveError);
  }

  // 4. Room state saving is handled transactionally (on placement/pickup etc.)
  // No bulk room save needed here anymore.

  // 5. Global state (e.g., runtime counters) does not need file persistence anymore.
  // REMOVED: Saving of ServerGameObject.nextId to global_state.json

  // 6. Disconnect all clients
  console.log(
    `Disconnecting ${Object.keys(clients).length} remaining clients...`
  );
  io.emit("chat_message", {
    avatarName: "Server",
    text: "Server is shutting down. Goodbye!",
    className: "server-msg",
  });
  io.disconnectSockets(true); // Force disconnect immediately

  // 7. Close Socket.IO server
  io.close((err) => {
    if (err) console.error("Error closing Socket.IO:", err);
    else console.log("Socket.IO server closed.");

    // 8. Close HTTP server
    server.close(() => {
      console.log("HTTP server closed.");
      // 9. Disconnect Database
      mongoose
        .disconnect()
        .then(() => console.log("MongoDB disconnected."))
        .catch((e) => console.error("Error disconnecting MongoDB:", e))
        .finally(() => {
          console.log("Shutdown complete.");
          process.exit(0); // Exit process cleanly
        });
    });
  });

  // 10. Force exit timeout
  setTimeout(() => {
    console.error("Graceful shutdown timed out after 5 seconds. Forcing exit.");
    process.exit(1);
  }, 5000).unref(); // Unref so it doesn't keep the process alive if shutdown is fast
} // --- End shutdown ---

// --- ASYNC STARTUP FUNCTION ---
async function startServer() {
  try {
    // 1. Connect to Database
    await connectDB();

    // 2. Initialization and Room Loading from DB
    console.log("Initializing Server Rooms from Database/Defaults...");

    // Load initial rooms defined in config
    for (const roomId of SERVER_CONFIG.INITIAL_ROOMS) {
      if (!roomId || typeof roomId !== "string") {
        console.warn("Skipping invalid/empty room ID in INITIAL_ROOMS.");
        continue;
      }
      console.log(` - Initializing room: ${roomId}...`);
      try {
        // Create instance (sets default layout)
        const roomInstance = new ServerRoom(roomId);
        // Load layout from RoomState collection and furniture from Furniture collection
        await roomInstance.loadStateFromDB();
        rooms.set(roomId, roomInstance);
        console.log(`   Room '${roomId}' initialized successfully.`);
      } catch (roomLoadError) {
        console.error(`   ERROR initializing room '${roomId}':`, roomLoadError);
        // If default room fails, it's critical
        if (roomId === SERVER_CONFIG.DEFAULT_ROOM_ID) {
          console.error(
            `FATAL: Failed to initialize default room '${roomId}'. Exiting.`
          );
          process.exit(1);
        }
      }
    }
    if (rooms.size === 0) {
      console.error(
        "FATAL: No rooms were loaded/initialized successfully. Check INITIAL_ROOMS and database connection/state. Exiting."
      );
      process.exit(1);
    }
    console.log(`Finished initializing rooms. ${rooms.size} room(s) active.`);

    // 3. Runtime ID counter is reset automatically (part of ServerGameObject class static)
    // REMOVED: Loading/Calculation of persistent nextId

    // 4. Initialize Socket Handlers (pass DB helpers)
    SocketHandlers.initializeHandlers(
      rooms,
      io,
      clients,
      findUserByIdFromDB, // Pass DB function
      updateUserInDB // Pass DB function
    );
    const roomChangeHandler = SocketHandlers.handleChangeRoom; // Get reference for game loop
    if (typeof roomChangeHandler !== "function") {
      throw new Error(
        "Failed to get handleChangeRoom function from SocketHandlers module."
      );
    }

    // 5. API Routes
    app.use("/api/auth", authRoutes);

    // 6. Static Files / Root / Config API
    const publicPath = path.join(__dirname, "public");
    console.log(`Serving static files from: ${publicPath}`);
    app.use(express.static(publicPath));
    // API endpoint to provide shared config to the client
    app.get("/api/config", (req, res) => {
      res.json(SHARED_CONFIG);
    });
    // Serve login page
    app.get("/login", (req, res) => {
      res.sendFile(path.join(publicPath, "login.html"));
    });
    // Serve main game page (index.html)
    app.get("/", (req, res) => {
      // Could add logic here to redirect to /login if no valid token cookie/header,
      // but current flow relies on client-side JS checking localStorage.
      res.sendFile(path.join(publicPath, "index.html"));
    });

    // 7. Socket.IO Authentication Middleware
    io.use(async (socket, next) => {
      const socketIdLog = `[Socket ${socket.id}]`;
      const token = socket.handshake.auth.token; // Get token from client handshake
      if (!token) {
        console.log(`Socket Auth Failed ${socketIdLog}: No token.`);
        return next(new Error("Authentication error: No token provided."));
      }
      try {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          // Should not happen if .env is loaded
          console.error("FATAL: JWT_SECRET is not defined!");
          return next(new Error("Server configuration error."));
        }

        // Verify the token asynchronously
        const decoded = await new Promise((resolve, reject) => {
          jwt.verify(token, secret, (err, decodedPayload) => {
            if (err) return reject(err); // Handles expired, invalid signature etc.
            resolve(decodedPayload);
          });
        });
        const userId = decoded.userId; // Extract userId from token payload

        // Validate userId format (ensure it's a valid ObjectId string)
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
          console.log(
            `Socket Auth Failed ${socketIdLog}: Invalid token payload (userId missing or invalid format).`
          );
          return next(
            new Error("Authentication error: Invalid token payload.")
          );
        }

        // Optional: Check user existence in DB here if desired
        // const userExists = await User.exists({ _id: userId });
        // if (!userExists) { /* ... */ }

        // Handle multiple connections: Disconnect previous socket for the same user
        const existingClient = Object.values(clients).find(
          (c) => c.userId === userId && c.socket.id !== socket.id
        );
        if (existingClient) {
          console.log(
            `Socket Auth ${socketIdLog}: User ${userId} already connected via ${existingClient.socket.id}. Disconnecting previous.`
          );
          existingClient.socket.emit(
            "force_disconnect",
            "Logged in from another location."
          );
          existingClient.socket.disconnect(true);
          // disconnect handler will clean up clients map entry
        }

        // Attach persistent userId to the socket object for use in handlers
        socket.userId = userId;
        // console.log(`Socket Auth Success ${socketIdLog}: UserID ${socket.userId}`); // Success log (can be noisy)
        next(); // Proceed to connection handler
      } catch (err) {
        // Handle JWT verification errors
        let errorMsg = "Authentication error: Invalid token.";
        if (err.name === "TokenExpiredError")
          errorMsg = "Authentication error: Token expired.";
        else if (err.name === "JsonWebTokenError")
          errorMsg = "Authentication error: Malformed token.";
        else
          console.error(
            `${socketIdLog} Unexpected token verification error:`,
            err
          ); // Log unexpected errors
        console.log(
          `Socket Auth Failed ${socketIdLog}: ${err.name || "Error"} - ${
            err.message
          }`
        );
        next(new Error(errorMsg)); // Reject connection
      }
    }); // --- End of io.use Auth Middleware ---

    // 8. Socket.IO Connection Handling (Calls async handler)
    io.on("connection", (socket) => SocketHandlers.handleConnection(socket));

    // 9. Server Game Loop
    let lastTickTime = Date.now();
    function gameTick() {
      const now = Date.now();
      const deltaTimeMs = now - lastTickTime;
      lastTickTime = now;
      // Cap delta time to prevent large jumps if server hangs
      const cappedDeltaTimeMs = Math.min(deltaTimeMs, 100); // e.g., max 100ms step

      // Update each active room
      rooms.forEach((room, roomId) => {
        if (!room) {
          console.error(`Tick skip: Room ${roomId} not found!`);
          return;
        }
        try {
          // update() handles avatar movement and returns DTOs of changed avatars
          const updates = room.update(cappedDeltaTimeMs, io, roomChangeHandler);
          // Broadcast updates for changed avatars TO THEIR CURRENT ROOM
          if (updates.changedAvatars && updates.changedAvatars.length > 0) {
            updates.changedAvatars.forEach((avatarDTO) => {
              const targetRoomId = avatarDTO.roomId || roomId; // Use DTO's room or fallback
              // Ensure the room the avatar is supposed to be in still exists
              if (rooms.has(targetRoomId)) {
                io.to(targetRoomId).emit("avatar_update", avatarDTO);
              } else {
                // Should be rare, but possible if room is removed while update pending
                console.warn(
                  `Tick update: Tried to send update for avatar ${avatarDTO.id} to non-existent room ${targetRoomId}`
                );
              }
            });
          }
          // Note: Furniture updates are broadcast directly by the handlers now
        } catch (roomUpdateError) {
          console.error(
            `Error during update for room ${roomId}:`,
            roomUpdateError
          );
          // Consider how to handle persistent room errors - maybe attempt unload/reload?
        }
      });
    } // --- End gameTick ---

    // 10. Start Server Listening and Game Loop
    server.listen(SERVER_CONFIG.PORT, () => {
      console.log(`Server listening on http://localhost:${SERVER_CONFIG.PORT}`);
      gameLoopInterval = setInterval(gameTick, 1000 / SERVER_CONFIG.TICK_RATE);
      console.log(
        `Game loop started with tick rate: ${SERVER_CONFIG.TICK_RATE}Hz.`
      );
      // Initialize console commands interface
      consoleInterface = ConsoleCommands.initializeConsole(
        rooms,
        io,
        clients,
        shutdown
      );
    });
  } catch (error) {
    // Catch errors during the main async startup sequence
    console.error("FATAL: Failed to initialize server:", error);
    if (server && server.listening) {
      // Close server if it started listening before error
      server.close();
    }
    // Ensure DB connection is closed if opened before error
    if (
      mongoose.connection.readyState === 1 ||
      mongoose.connection.readyState === 2
    ) {
      await mongoose.disconnect();
      console.log("MongoDB disconnected due to startup error.");
    }
    process.exit(1); // Exit with error code
  }
} // --- End startServer async function ---

// --- Run the startup function ---
startServer();

// --- Signal Handlers & Global Error Catching ---
process.on("SIGINT", shutdown); // Handle Ctrl+C
process.on("SIGTERM", shutdown); // Handle kill signals

// Catch uncaught exceptions to attempt graceful shutdown
process.on("uncaughtException", (error, origin) => {
  console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  console.error(`UNCAUGHT EXCEPTION (${origin}):`, error);
  console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  // Attempt graceful shutdown only once
  if (typeof shutdown === "function" && !shutdown.called) {
    shutdown.called = true; // Flag to prevent recursive shutdown calls
    shutdown();
  } else {
    console.error(
      "Shutdown function unavailable or already called. Forcing exit."
    );
    process.exit(1);
  }
  // Force exit after timeout if graceful shutdown hangs
  setTimeout(() => {
    console.error("Force exiting after uncaught exception timeout.");
    process.exit(1);
  }, 7000).unref();
});

// Catch unhandled promise rejections (good practice, though less critical than exceptions)
process.on("unhandledRejection", (reason, promise) => {
  console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  console.error("UNHANDLED PROMISE REJECTION:");
  if (reason instanceof Error) {
    console.error("Reason:", reason.message);
    console.error(reason.stack);
  } else {
    console.error("Reason:", reason);
  }
  console.error("Promise:", promise);
  console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  // Consider logging more details or exiting depending on severity
});
