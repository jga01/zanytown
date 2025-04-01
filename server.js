"use strict";

// --- Core Modules ---
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs"); // Needed for directory/file operations

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const ServerRoom = require("./lib/room");
const SocketHandlers = require("./server_socket_handlers");
const ConsoleCommands = require("./server_console");
const { ServerGameObject } = require("./lib/game_objects"); // For global nextId management

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server); // Attach Socket.IO

// --- Game State ---
const rooms = new Map(); // Map<roomId, ServerRoom> - Manages all active rooms
let gameLoopInterval;
let consoleInterface; // Stores the readline interface instance
const clients = {}; // Map: socket.id -> { socket, avatarId } - Tracks connected clients globally

// --- Initialization and Room Loading ---
try {
  // 1. Ensure Save Directory Exists
  const saveDir = path.resolve(__dirname, SERVER_CONFIG.DEFAULT_SAVE_DIR);
  if (!fs.existsSync(saveDir)) {
    console.log(`Creating save directory: ${saveDir}`);
    fs.mkdirSync(saveDir, { recursive: true });
  }

  // 2. Reset Global ID Counter before loading any rooms/items
  ServerGameObject.nextId = 0;
  console.log("Initializing Server Rooms...");

  // 3. Load Initial Rooms specified in config
  SERVER_CONFIG.INITIAL_ROOMS.forEach((roomId) => {
    if (!roomId) {
      console.warn("Skipping invalid room ID found in INITIAL_ROOMS config.");
      return;
    }
    console.log(` - Loading room: ${roomId}...`);
    try {
      const roomInstance = new ServerRoom(roomId); // Constructor now loads state from file if exists
      rooms.set(roomId, roomInstance);
      console.log(`   Room '${roomId}' loaded successfully.`);
    } catch (roomLoadError) {
      console.error(`   ERROR loading room '${roomId}':`, roomLoadError);
      // Decide if server should continue without this room or stop
    }
  });
  console.log(`Finished loading initial rooms. ${rooms.size} rooms active.`);

  // 4. Determine the highest nextId needed based on loaded items across ALL rooms
  let maxLoadedItemId = 0;
  rooms.forEach((room) => {
    room.furniture.forEach((f) => {
      maxLoadedItemId = Math.max(maxLoadedItemId, f.id);
    });
    // Consider avatars if they were persisted across restarts (not currently implemented)
  });

  // 5. Load Global State (e.g., nextId) if it exists
  const globalStatePath = path.join(saveDir, "global_state.json");
  let loadedNextId = 0;
  try {
    if (fs.existsSync(globalStatePath)) {
      const globalStateData = fs.readFileSync(globalStatePath, "utf8");
      const globalState = JSON.parse(globalStateData);
      loadedNextId = globalState.nextId || 0;
      console.log(`Loaded global nextId from file: ${loadedNextId}`);
    } else {
      console.log(
        "Global state file not found, using ID calculated from loaded items."
      );
    }
  } catch (e) {
    console.error("Error loading or parsing global_state.json:", e);
  }

  // 6. Set the global nextId to be safely ahead of any loaded ID or saved global ID
  ServerGameObject.nextId = Math.max(maxLoadedItemId + 1, loadedNextId);
  console.log(
    `Global ServerGameObject.nextId set to: ${ServerGameObject.nextId}`
  );

  // 7. Initialize Socket Handlers with dependencies (pass rooms map)
  SocketHandlers.initializeHandlers(rooms, io, clients);

  // --- Get the specific room change handler ---
  // This assumes initializeHandlers has run and SocketHandlers is fully loaded
  const roomChangeHandler = SocketHandlers.handleChangeRoom;
  if (typeof roomChangeHandler !== "function") {
    throw new Error(
      "Failed to get handleChangeRoom function from SocketHandlers module."
    );
  }

  // 8. Setup Express Static Files and API Routes
  const publicPath = path.join(__dirname, "public");
  console.log(`Serving static files from: ${publicPath}`);
  app.use(express.static(publicPath));

  // API endpoint to serve the shared configuration
  app.get("/api/config", (req, res) => {
    console.log("GET /api/config requested");
    try {
      // Send the SHARED_CONFIG object as JSON
      res.json(SHARED_CONFIG);
    } catch (error) {
      console.error("Error sending SHARED_CONFIG via API:", error);
      res.status(500).send("Error retrieving server configuration.");
    }
  });

  // Serve the main HTML file for the root path
  app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
  });

  // --- Socket.IO Connection Handling ---
  // Delegate connection handling to the dedicated module
  io.on("connection", SocketHandlers.handleConnection);

  // --- Server Game Loop (Iterates Active Rooms) ---
  let lastTickTime = Date.now();
  function gameTick() {
    const now = Date.now();
    const deltaTimeMs = now - lastTickTime;
    lastTickTime = now;

    // Update each active room instance
    rooms.forEach((room, roomId) => {
      if (!room) {
        console.error(
          `Game tick skipped for room ${roomId}: Room instance not found!`
        );
        return; // Skip this room if somehow null/undefined
      }
      try {
        // Pass io instance for potential broadcasts needed during update (like emote ends)
        const updates = room.update(deltaTimeMs, io, roomChangeHandler);

        // Broadcast any changes that occurred during the tick TO THE RELEVANT ROOM
        if (updates.changedAvatars && updates.changedAvatars.length > 0) {
          updates.changedAvatars.forEach((avatarDTO) => {
            // Ensure broadcast goes to the avatar's *current* room
            const targetRoomId = avatarDTO.roomId || roomId; // Use DTO's roomId if present, else assume current tick's room
            io.to(targetRoomId).emit("avatar_update", avatarDTO);
          });
        }
        // Add other room-specific update broadcasts here if needed (e.g., furniture animations)
      } catch (roomUpdateError) {
        console.error(`Error updating room ${roomId}:`, roomUpdateError);
        // Consider adding logic to handle persistent room errors (e.g., disable updates)
      }
    });
  }

  // --- Start Server ---
  server.listen(SERVER_CONFIG.PORT, () => {
    console.log(`Server listening on http://localhost:${SERVER_CONFIG.PORT}`);
    // Start game loop *after* server is listening
    gameLoopInterval = setInterval(gameTick, 1000 / SERVER_CONFIG.TICK_RATE);
    console.log(
      `Game loop started with tick rate: ${SERVER_CONFIG.TICK_RATE}Hz.`
    );
    // Initialize console commands *after* server is up (pass rooms map)
    consoleInterface = ConsoleCommands.initializeConsole(
      rooms,
      io,
      clients,
      shutdown
    );
  });
} catch (error) {
  console.error("FATAL: Failed to initialize server components:", error);
  // Attempt to clean up if partial initialization happened (e.g., close server if listening)
  if (server && server.listening) {
    server.close();
  }
  process.exit(1); // Exit if core initialization fails
}

// --- Graceful Shutdown ---
function shutdown() {
  console.log("\nInitiating graceful shutdown...");

  // 1. Stop accepting new connections (implicit via server.close)
  // 2. Stop game loop
  if (gameLoopInterval) {
    clearInterval(gameLoopInterval);
    console.log("Game loop stopped.");
  }

  // 3. Close console input
  if (consoleInterface) {
    consoleInterface.close(); // Closes readline interface
  }

  // 4. Save final state (Global and Per-Room)
  console.log("Attempting final state save for all rooms...");
  // Save global state (e.g., nextId)
  const saveDir = path.resolve(__dirname, SERVER_CONFIG.DEFAULT_SAVE_DIR); // Recalculate just in case
  const globalStatePath = path.join(saveDir, "global_state.json");
  const globalState = { nextId: ServerGameObject.nextId };
  try {
    fs.writeFileSync(globalStatePath, JSON.stringify(globalState, null, 2));
    console.log(
      `Global state (nextId: ${globalState.nextId}) saved to ${globalStatePath}.`
    );
  } catch (e) {
    console.error("Error saving global state during shutdown:", e);
  }
  // Save state for each individual room
  rooms.forEach((room, roomId) => {
    try {
      if (room) {
        room.saveStateToFile(); // Saves to its specific file (e.g., room_state_main_lobby.json)
      } else {
        console.warn(`Cannot save room ${roomId}, instance not found.`);
      }
    } catch (e) {
      console.error(
        `Error saving state for room ${roomId} during shutdown:`,
        e
      );
    }
  });

  // 5. Disconnect all clients gracefully
  console.log(`Disconnecting ${Object.keys(clients).length} clients...`);
  io.disconnectSockets(true); // true = close underlying connection

  // 6. Close Socket.IO server
  io.close((err) => {
    if (err) console.error("Error closing Socket.IO:", err);
    else console.log("Socket.IO server closed.");

    // 7. Close HTTP server
    server.close(() => {
      console.log("HTTP server closed.");
      console.log("Shutdown complete.");
      process.exit(0); // Exit process cleanly
    });
  });

  // Force exit after a timeout if shutdown hangs
  setTimeout(() => {
    console.error("Graceful shutdown timed out after 5 seconds. Forcing exit.");
    process.exit(1);
  }, 5000);
}

// Listen for termination signals
process.on("SIGINT", shutdown); // Ctrl+C
process.on("SIGTERM", shutdown); // `kill` command (standard termination)

// Optional: Catch unhandled exceptions to prevent abrupt crashes
process.on("uncaughtException", (error) => {
  console.error("UNCAUGHT EXCEPTION:", error);
  // Attempt a graceful shutdown on critical errors
  shutdown();
  // Give shutdown a moment, then force exit if it hangs
  setTimeout(() => process.exit(1), 7000);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
  // Optional: Treat unhandled promise rejections as critical errors too
  // shutdown();
  // setTimeout(() => process.exit(1), 7000);
});
