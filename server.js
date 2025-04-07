"use strict";

// --- Core Modules ---
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs"); // Note: fs is imported but no longer used for global_state.json
require("dotenv").config(); // Load environment variables FIRST
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit"); // Import rate-limit

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const ServerRoom = require("./lib/room");
const SocketHandlers = require("./server_socket_handlers");
const ConsoleCommands = require("./server_console");
const { ServerGameObject, ServerAvatar } = require("./lib/game_objects"); // Needed for instanceof checks, ServerAvatar for explicit use
const connectDB = require("./lib/db");
const authRoutes = require("./routes/authRoutes");
const User = require("./models/user");
const Furniture = require("./models/furniture"); // Load Furniture model

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Middleware ---
app.use(express.json()); // Middleware to parse JSON bodies

// --- Rate Limiting Setup ---
// Apply a general limiter to all API routes (optional, but good practice)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    message:
      "Too many requests from this IP for general API, please try again after 15 minutes",
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});
// IMPORTANT: Apply general API limiter *before* specific ones if you want it to cover everything under /api
app.use("/api", apiLimiter);

// Apply a stricter limiter specifically for authentication routes
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 15, // Limit each IP to 15 login/register attempts per windowMs (Adjust as needed)
  message: {
    message:
      "Too many login/registration attempts from this IP, please try again after 10 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
// Apply stricter limiter specifically to the auth path
app.use("/api/auth", authLimiter);

// --- Game State ---
const rooms = new Map(); // Map<roomId, ServerRoom>
let gameLoopInterval;
let consoleInterface;
// Map: socket.id -> { socket, avatarId (runtime), userId (persistent User._id) }
const clients = {};

// --- Database Helper Functions ---
async function findUserByIdFromDB(userId) {
  try {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return null;
    }
    const user = await User.findById(userId).lean();
    if (!user) {
      return null;
    }
    // Ensure inventory is a plain object if it was stored as a Map
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
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      console.error(`DB Helper Update: Invalid userId format: ${userId}`);
      return null;
    }
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, lean: true } // Return modified doc as plain object
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
  rooms.forEach((room) => {
    Object.values(room.avatars).forEach((avatar) => {
      if (avatar instanceof ServerAvatar) {
        activeAvatars.push(avatar);
      }
    });
  });
  const avatarIdToUserIdMap = {};
  Object.values(clients).forEach((clientInfo) => {
    if (clientInfo && clientInfo.userId && clientInfo.avatarId != null) {
      avatarIdToUserIdMap[clientInfo.avatarId] = clientInfo.userId;
    }
  });

  for (const avatar of activeAvatars) {
    const userId = avatarIdToUserIdMap[avatar.id];
    if (userId) {
      try {
        const playerState = {
          currency: avatar.currency,
          inventory: Object.fromEntries(avatar.inventory || new Map()),
          bodyColor: avatar.bodyColor,
          lastRoomId: avatar.roomId,
          lastX: Math.round(avatar.x),
          lastY: Math.round(avatar.y),
          lastZ: avatar.z,
        };
        savePromises.push(updateUserInDB(userId, playerState));
      } catch (error) {
        console.error(
          `Error preparing save data for avatar ${avatar.id} (User ID: ${userId}):`,
          error
        );
      }
    } else {
      console.warn(
        `Could not find userId for avatar ${avatar.id} (${avatar.name}) during shutdown save.`
      );
    }
  }

  try {
    await Promise.all(savePromises);
    console.log(
      `Player state saving process completed. ${savePromises.length} players processed.`
    );
  } catch (saveError) {
    console.error("Error during bulk player state saving:", saveError);
  }

  // 4. Room state saving is handled transactionally (on placement/pickup etc.)

  // 5. Disconnect all clients
  console.log(
    `Disconnecting ${Object.keys(clients).length} remaining clients...`
  );
  io.emit("chat_message", {
    avatarName: "Server",
    text: "Server is shutting down. Goodbye!",
    className: "server-msg",
  });
  io.disconnectSockets(true);

  // 6. Close Socket.IO server
  io.close((err) => {
    if (err) console.error("Error closing Socket.IO:", err);
    else console.log("Socket.IO server closed.");

    // 7. Close HTTP server
    server.close(() => {
      console.log("HTTP server closed.");
      // 8. Disconnect Database
      mongoose
        .disconnect()
        .then(() => console.log("MongoDB disconnected."))
        .catch((e) => console.error("Error disconnecting MongoDB:", e))
        .finally(() => {
          console.log("Shutdown complete.");
          process.exit(0);
        });
    });
  });

  // 9. Force exit timeout
  setTimeout(() => {
    console.error("Graceful shutdown timed out after 5 seconds. Forcing exit.");
    process.exit(1);
  }, 5000).unref();
} // --- End shutdown ---

// --- ASYNC STARTUP FUNCTION ---
async function startServer() {
  try {
    // 1. Connect to Database
    await connectDB();

    // 2. Initialization and Room Loading from DB
    console.log("Initializing Server Rooms from Database/Defaults...");
    for (const roomId of SERVER_CONFIG.INITIAL_ROOMS) {
      if (!roomId || typeof roomId !== "string") {
        console.warn("Skipping invalid/empty room ID in INITIAL_ROOMS.");
        continue;
      }
      console.log(` - Initializing room: ${roomId}...`);
      try {
        const roomInstance = new ServerRoom(roomId);
        await roomInstance.loadStateFromDB();
        rooms.set(roomId, roomInstance);
        console.log(`   Room '${roomId}' initialized successfully.`);
      } catch (roomLoadError) {
        console.error(`   ERROR initializing room '${roomId}':`, roomLoadError);
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

    // 3. Initialize Socket Handlers (Pass DB Helpers)
    SocketHandlers.initializeHandlers(
      rooms,
      io,
      clients,
      findUserByIdFromDB, // Pass DB function
      updateUserInDB // Pass DB function
    );
    // Ensure handleChangeRoom is correctly referenced/exported if needed elsewhere
    const handleChangeRoomFunc = SocketHandlers.handleChangeRoom;
    if (typeof handleChangeRoomFunc !== "function") {
      // This check might be better placed inside modules that *use* it, like the console
      console.warn(
        "handleChangeRoom function from SocketHandlers module is not available globally (may affect console)."
      );
    }

    // 4. API Routes (Mounted *after* rate limiters)
    app.use("/api/auth", authRoutes);

    // 5. Static Files / Root / Config API
    const publicPath = path.join(__dirname, "public");
    console.log(`Serving static files from: ${publicPath}`);
    app.use(express.static(publicPath));
    app.get("/api/config", (req, res) => {
      res.json(SHARED_CONFIG);
    });
    app.get("/login", (req, res) => {
      res.sendFile(path.join(publicPath, "login.html"));
    });
    app.get("/", (req, res) => {
      res.sendFile(path.join(publicPath, "index.html"));
    });

    // 6. Socket.IO Authentication Middleware
    io.use(async (socket, next) => {
      const socketIdLog = `[Socket ${socket.id}]`;
      const token = socket.handshake.auth.token;
      if (!token) {
        console.log(`Socket Auth Failed ${socketIdLog}: No token.`);
        return next(new Error("Authentication error: No token provided."));
      }
      try {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          console.error("FATAL: JWT_SECRET is not defined!");
          return next(new Error("Server configuration error."));
        }
        const decoded = await new Promise((resolve, reject) => {
          jwt.verify(token, secret, (err, decodedPayload) => {
            if (err) return reject(err);
            resolve(decodedPayload);
          });
        });
        const userId = decoded.userId;
        if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
          console.log(
            `Socket Auth Failed ${socketIdLog}: Invalid token payload (userId missing or invalid format).`
          );
          return next(
            new Error("Authentication error: Invalid token payload.")
          );
        }

        // Handle multiple connections
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
        }

        socket.userId = userId; // Attach persistent userId
        next();
      } catch (err) {
        let errorMsg = "Authentication error: Invalid token.";
        if (err.name === "TokenExpiredError")
          errorMsg = "Authentication error: Token expired.";
        else if (err.name === "JsonWebTokenError")
          errorMsg = "Authentication error: Malformed token.";
        else
          console.error(
            `${socketIdLog} Unexpected token verification error:`,
            err
          );
        console.log(
          `Socket Auth Failed ${socketIdLog}: ${err.name || "Error"} - ${
            err.message
          }`
        );
        next(new Error(errorMsg));
      }
    }); // --- End of io.use Auth Middleware ---

    // 7. Socket.IO Connection Handling (Calls async handler)
    io.on("connection", (socket) => SocketHandlers.handleConnection(socket));

    // 8. Server Game Loop
    let lastTickTime = Date.now();
    function gameTick() {
      const now = Date.now();
      const deltaTimeMs = now - lastTickTime;
      lastTickTime = now;
      const cappedDeltaTimeMs = Math.min(deltaTimeMs, 100); // Cap delta time

      rooms.forEach((room, roomId) => {
        if (!room) {
          console.error(`Tick skip: Room ${roomId} not found!`);
          return;
        }
        try {
          // Update room state (handles avatar movement, etc.)
          const updates = room.update(
            cappedDeltaTimeMs,
            io,
            handleChangeRoomFunc
          ); // Pass changeRoom handler

          // Broadcast specific updates based on room.update results
          if (updates.changedAvatars && updates.changedAvatars.length > 0) {
            updates.changedAvatars.forEach((avatarDTO) => {
              const targetRoomId = avatarDTO.roomId || roomId; // Use DTO's room or fallback
              if (rooms.has(targetRoomId)) {
                io.to(targetRoomId).emit("avatar_update", avatarDTO);
              } else {
                console.warn(
                  `Tick update: Tried to send update for avatar ${avatarDTO.id} to non-existent room ${targetRoomId}`
                );
              }
            });
          }
          // Furniture/other updates are usually broadcast directly by handlers now
        } catch (roomUpdateError) {
          console.error(
            `Error during update for room ${roomId}:`,
            roomUpdateError
          );
        }
      });
    } // --- End gameTick ---

    // 9. Start Server Listening and Game Loop
    server
      .listen(SERVER_CONFIG.PORT, () => {
        console.log(
          `Server listening on http://localhost:${SERVER_CONFIG.PORT}`
        );
        gameLoopInterval = setInterval(
          gameTick,
          1000 / SERVER_CONFIG.TICK_RATE
        );
        console.log(
          `Game loop started with tick rate: ${SERVER_CONFIG.TICK_RATE}Hz.`
        );
        // Initialize console commands interface
        consoleInterface = ConsoleCommands.initializeConsole(
          rooms,
          io,
          clients,
          shutdown,
          handleChangeRoomFunc // Pass the room change handler
        );
      })
      .on("error", (err) => {
        console.error(
          `FATAL: Server failed to listen on port ${SERVER_CONFIG.PORT}:`,
          err
        );
        // Attempt graceful shutdown if possible, otherwise force exit
        if (typeof shutdown === "function" && !shutdownCalled) {
          shutdownCalled = true;
          console.log("Attempting shutdown due to listen error...");
          shutdown();
          setTimeout(() => {
            console.error(
              "Graceful shutdown timed out after listen error. Forcing exit."
            );
            process.exit(1);
          }, 5000).unref(); // Timeout for shutdown
        } else {
          process.exit(1); // Force exit if shutdown isn't available/already called
        }
      });
  } catch (error) {
    console.error("FATAL: Failed to initialize server:", error);
    if (server && server.listening) {
      server.close();
    }
    if (
      mongoose.connection.readyState === 1 ||
      mongoose.connection.readyState === 2
    ) {
      await mongoose.disconnect();
      console.log("MongoDB disconnected due to startup error.");
    }
    process.exit(1);
  }
} // --- End startServer async function ---

// --- Run the startup function ---
startServer();

// --- Signal Handlers & Global Error Catching ---
process.on("SIGINT", shutdown); // Handle Ctrl+C
process.on("SIGTERM", shutdown); // Handle kill signals

let shutdownCalled = false; // Flag to prevent multiple shutdowns
process.on("uncaughtException", (error, origin) => {
  console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  console.error(`UNCAUGHT EXCEPTION (${origin}):`, error);
  console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  if (typeof shutdown === "function" && !shutdownCalled) {
    shutdownCalled = true;
    console.log("Attempting graceful shutdown due to uncaught exception...");
    shutdown(); // Attempt graceful shutdown
    // Force exit after timeout if graceful shutdown hangs
    setTimeout(() => {
      console.error(
        "Graceful shutdown timed out after uncaught exception. Forcing exit."
      );
      process.exit(1);
    }, 7000).unref();
  } else {
    console.error(
      "Shutdown function unavailable or already called. Forcing exit immediately."
    );
    process.exit(1);
  }
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
  console.error("UNHANDLED PROMISE REJECTION:");
  if (reason instanceof Error) {
    console.error("Reason:", reason.message);
    console.error(reason.stack);
  } else {
    console.error("Reason:", reason);
  }
  // console.error('Promise:', promise); // Logging the promise object might be too verbose
  console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  // Consider whether to attempt shutdown here too, depending on severity
});

console.log(
  "Server script finished initial execution. Startup sequence initiated."
);
