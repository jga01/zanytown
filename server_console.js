"use strict";

const readline = require("readline");
const { SHARED_CONFIG } = require("./lib/config"); // For avatar states, item defs etc.
// Import specific handler if needed for direct calls (like teleport using room change)
const { handleChangeRoom } = require("./server_socket_handlers");

// --- Globals passed from server.js ---
let rooms; // Map<roomId, ServerRoom>
let io;
let clients; // Map: socket.id -> { socket, avatarId }
let shutdownCallback; // Function to call for graceful shutdown

/**
 * Initializes the console command interface.
 * @param {Map<string, ServerRoom>} roomsMap - The map of active room instances.
 * @param {SocketIO.Server} ioInstance - The Socket.IO server instance.
 * @param {object} clientsMap - The map tracking client connections.
 * @param {Function} shutdownFunc - The function to trigger server shutdown.
 */
function initializeConsole(roomsMap, ioInstance, clientsMap, shutdownFunc) {
  rooms = roomsMap;
  io = ioInstance;
  clients = clientsMap;
  shutdownCallback = shutdownFunc;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  console.log("\nServer console ready. Type 'help' for commands.");
  rl.prompt();

  rl.on("line", (input) => {
    handleConsoleInput(input.trim());
    rl.prompt(); // Show prompt again
  }).on("close", () => {
    console.log("Console input closed.");
    // This usually happens during shutdown sequence
  });

  return rl; // Return the readline interface instance
}

/**
 * Helper function to find an avatar globally across all rooms by name.
 * @param {string} name - The avatar name (case-insensitive search).
 * @returns {{avatar: ServerAvatar | null, room: ServerRoom | null}} - The avatar and the room they are in, or nulls if not found.
 */
function findAvatarGlobally(name) {
  if (!name) return { avatar: null, room: null };
  const lowerName = name.toLowerCase();
  for (const [roomId, room] of rooms.entries()) {
    // Search within the room's avatars map
    const avatar = Object.values(room.avatars).find(
      (a) => a.name.toLowerCase() === lowerName
    );
    if (avatar) {
      // Ensure consistency: avatar should know its room ID
      if (avatar.roomId !== roomId) {
        console.warn(
          `Consistency Warning: Avatar ${avatar.name} found in room ${roomId} structure, but avatar.roomId is ${avatar.roomId}. Using ${roomId}.`
        );
        // Optionally correct: avatar.roomId = roomId;
      }
      return { avatar, room }; // Return avatar and the room they are in
    }
  }
  return { avatar: null, room: null }; // Not found in any room
}

/**
 * Processes a command entered into the server console.
 * @param {string} input - The trimmed command line input.
 */
function handleConsoleInput(input) {
  if (!input) return;

  // Basic split, consider quotes later if needed
  const args = input.match(/(?:[^\s"]+|"[^"]*")+/g) || []; // Handles quoted strings somewhat
  const command = args[0]?.toLowerCase();
  const params = args
    .slice(1)
    .map((arg) =>
      arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg
    ); // Remove quotes from params

  if (!command) return;

  try {
    // Wrap command execution in try/catch for safety
    switch (command) {
      case "help":
        console.log("Available commands:");
        console.log(
          "  say <message>                - Broadcast a message as 'Server'."
        );
        console.log(
          "  listrooms                    - List IDs of all loaded rooms."
        );
        console.log(
          "  listusers [room_id]          - List users (all rooms or specific)."
        );
        console.log(
          "  kick <username>              - Disconnect user (searches all rooms)."
        );
        console.log(
          "  teleport <user> <room> <x> <y> - Teleport user to a room/coords."
        );
        console.log(
          "  give <user> <item> <qty>     - Give item (searches all rooms)."
        );
        console.log(
          "  givegold <user> <amount>     - Give gold (searches all rooms)."
        );
        console.log(
          "  save <room_id|all>           - Save specific room state or all rooms."
        );
        console.log(
          "  load <room_id|all>           - Load specific room state or all rooms (Warning: Disruptive)."
        );
        console.log(
          "  stop / exit                  - Shut down the server gracefully."
        );
        console.log("  help                         - Show this help message.");
        break;

      case "say":
        if (params.length > 0) {
          const message = params.join(" "); // Re-join potentially split quoted message
          console.log(`Broadcasting server message: ${message}`);
          // Send chat message with null avatarId and "Server" name (global)
          io.emit("chat_message", {
            avatarId: null,
            avatarName: "Server",
            text: message,
          });
        } else {
          console.log("Usage: say <message>");
        }
        break;

      case "listrooms":
        console.log("Loaded Rooms:");
        if (rooms.size === 0) {
          console.log(" (None)");
        } else {
          const roomIds = Array.from(rooms.keys()).sort();
          roomIds.forEach((roomId) => console.log(` - ${roomId}`));
        }
        break;

      case "listusers":
        const targetRoomId = params[0];
        if (targetRoomId) {
          const room = rooms.get(targetRoomId);
          if (room) {
            console.log(`Users in room '${targetRoomId}':`);
            const users = room
              .getUserList()
              .sort((a, b) => a.name.localeCompare(b.name)); // Sort list
            if (users.length === 0) console.log("  (Empty)");
            else
              users.forEach((u) => {
                const avatar =
                  room.avatars[
                    Object.keys(room.avatars).find(
                      (sid) => room.avatars[sid]?.id === u.id
                    )
                  ]; // Find avatar by ID in room
                console.log(
                  `  - ${u.name} (ID: ${u.id})${
                    avatar ? ` Socket: ${avatar.socketId}` : ""
                  }`
                );
              });
          } else {
            console.log(`Error: Room '${targetRoomId}' not found.`);
          }
        } else {
          console.log("Users Online (All Rooms):");
          let totalUsers = 0;
          const roomIds = Array.from(rooms.keys()).sort();
          roomIds.forEach((roomId) => {
            const room = rooms.get(roomId);
            const users = room
              .getUserList()
              .sort((a, b) => a.name.localeCompare(b.name));
            if (users.length > 0) {
              console.log(`  --- Room: ${roomId} ---`);
              users.forEach((u) => {
                const avatar =
                  room.avatars[
                    Object.keys(room.avatars).find(
                      (sid) => room.avatars[sid]?.id === u.id
                    )
                  ];
                console.log(
                  `    - ${u.name} (ID: ${u.id})${
                    avatar ? ` Socket: ${avatar.socketId}` : ""
                  }`
                );
              });
              totalUsers += users.length;
            }
          });
          if (totalUsers === 0) console.log("  (No users connected)");
        }
        break;

      case "kick":
        if (params.length === 1) {
          const targetName = params[0];
          const { avatar: targetAvatar } = findAvatarGlobally(targetName); // Use global find
          if (targetAvatar && clients[targetAvatar.socketId]) {
            console.log(
              `Kicking user ${targetAvatar.name} (Room: ${targetAvatar.roomId}, Socket: ${targetAvatar.socketId})...`
            );
            // Force disconnect the client's socket
            clients[targetAvatar.socketId].socket.disconnect(true);
            // The 'disconnect' event handler will manage cleanup in room.avatars and clients map
          } else {
            console.log(
              `User '${targetName}' not found or associated socket missing.`
            );
          }
        } else {
          console.log("Usage: kick <username>");
        }
        break;

      case "teleport":
        if (params.length === 4) {
          const targetName = params[0];
          const destRoomId = params[1];
          const targetX = parseInt(params[2], 10);
          const targetY = parseInt(params[3], 10);

          const { avatar: targetAvatar } = findAvatarGlobally(targetName); // Find user globally
          const destRoom = rooms.get(destRoomId); // Find destination room

          if (!targetAvatar) {
            console.log(`Error: User '${targetName}' not found.`);
          } else if (!destRoom) {
            console.log(`Error: Destination room '${destRoomId}' not found.`);
          } else if (isNaN(targetX) || isNaN(targetY)) {
            console.log(
              `Error: Invalid coordinates '${params[2]}, ${params[3]}'.`
            );
          } else {
            // Validate target tile in destination room IS VALID TERRAIN
            if (destRoom.isValidTile(targetX, targetY)) {
              console.log(
                `Teleporting ${targetAvatar.name} from ${targetAvatar.roomId} to ${destRoomId}(${targetX}, ${targetY})...`
              );

              // Use the room change logic, even if staying in the same room (ensures state reset)
              const socket = clients[targetAvatar.socketId]?.socket;
              if (socket) {
                // Pass target coords directly to room change handler
                // Ensure the handler is imported or available in this scope
                handleChangeRoom(socket, {
                  targetRoomId: destRoomId,
                  targetX: targetX,
                  targetY: targetY,
                });
                console.log(` -> Teleport requested via room change handler.`);
              } else {
                console.error(
                  ` -> Cannot teleport: Socket for ${targetName} not found in clients map.`
                );
                // Manual teleport attempt if socket handler isn't callable? Less safe.
                // console.log(" -> Attempting manual teleport (less safe)...");
                // targetAvatar.prepareForRoomChange(destRoomId, targetX, targetY);
                // destRoom.addAvatar(targetAvatar); // This is risky without socket sync
              }
            } else {
              console.log(
                `Cannot teleport: Target tile (${targetX}, ${targetY}) in room ${destRoomId} is invalid (wall/hole/out of bounds).`
              );
            }
          }
        } else {
          console.log("Usage: teleport <username> <room_id> <x> <y>");
        }
        break;

      case "give":
      case "givegold":
        const isGold = command.includes("gold");
        const usage = isGold
          ? "Usage: givegold <username> <amount>"
          : "Usage: give <username> <item_definition_id> [quantity=1]";
        const numParamsRequired = isGold ? 2 : 2; // User + value/item
        const numParamsOptional = isGold ? 0 : 1; // Quantity for items

        if (
          params.length < numParamsRequired ||
          params.length > numParamsRequired + numParamsOptional
        ) {
          console.log(usage);
          if (!isGold) {
            const validIds = SHARED_CONFIG.FURNITURE_DEFINITIONS.map(
              (d) => d.id
            ).join(", ");
            console.log(`Valid Item IDs: ${validIds}`);
          }
          break;
        }

        const targetNameGive = params[0];
        const valueGive = params[1]; // Item ID or Gold Amount (string initially)
        const quantityGive = isGold
          ? 1
          : params[2]
          ? parseInt(params[2], 10)
          : 1; // Qty=1 for gold, parse for items

        const { avatar: targetAvatarGive } = findAvatarGlobally(targetNameGive); // Find globally

        if (!targetAvatarGive) {
          console.log(`Error: User '${targetNameGive}' not found.`);
        } else if (!isGold && (isNaN(quantityGive) || quantityGive <= 0)) {
          console.log(
            `Error: Invalid quantity '${params[2]}'. Must be a positive number.`
          );
        } else if (isGold) {
          // Give Gold
          const amountGold = parseInt(valueGive, 10);
          if (isNaN(amountGold) || amountGold <= 0) {
            console.log(
              `Error: Invalid gold amount '${valueGive}'. Must be a positive number.`
            );
          } else if (targetAvatarGive.addCurrency(amountGold)) {
            console.log(
              `Success: Gave ${amountGold} Gold to ${targetAvatarGive.name}.`
            );
            const sock = clients[targetAvatarGive.socketId]?.socket;
            if (sock) {
              sock.emit("currency_update", {
                currency: targetAvatarGive.currency,
              });
              sock.emit("chat_message", {
                avatarId: null,
                avatarName: "Server",
                text: `You received ${amountGold} Gold!`,
                className: "server-msg",
              });
              console.log(` -> Notified client ${targetAvatarGive.socketId}.`);
            } else {
              console.log(
                ` -> Warning: Could not find socket for ${targetAvatarGive.name} to notify.`
              );
            }
          } else console.log(`Error adding gold (internal error?).`);
        } else {
          // Give Item
          const itemIdGive = valueGive; // Item ID is param[1]
          const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
            (def) => def.id === itemIdGive
          );
          if (!definition) {
            console.log(
              `Error: Invalid item ID '${itemIdGive}'. Check lib/config.js.`
            );
            const validIds = SHARED_CONFIG.FURNITURE_DEFINITIONS.map(
              (d) => d.id
            ).join(", ");
            console.log(`Valid Item IDs: ${validIds}`);
          } else if (targetAvatarGive.addItem(itemIdGive, quantityGive)) {
            console.log(
              `Success: Gave ${quantityGive}x ${definition.name} (${itemIdGive}) to ${targetAvatarGive.name}.`
            );
            const sock = clients[targetAvatarGive.socketId]?.socket;
            if (sock) {
              sock.emit("inventory_update", targetAvatarGive.getInventoryDTO());
              sock.emit("chat_message", {
                avatarId: null,
                avatarName: "Server",
                text: `You received ${quantityGive}x ${definition.name}!`,
                className: "server-msg",
              });
              console.log(` -> Notified client ${targetAvatarGive.socketId}.`);
            } else {
              console.log(
                ` -> Warning: Could not find socket for ${targetAvatarGive.name} to notify.`
              );
            }
          } else
            console.log(`Error adding item ${itemIdGive} (internal error?).`);
        }
        break;

      case "save":
        const saveTarget = params[0];
        if (!saveTarget) {
          console.log("Usage: save <room_id|all>");
          break;
        }

        if (saveTarget.toLowerCase() === "all") {
          console.log("Saving all rooms...");
          let successCount = 0;
          let failCount = 0;
          rooms.forEach((room) => {
            if (room.saveStateToFile()) successCount++;
            else failCount++;
          });
          console.log(
            `Save complete. ${successCount} succeeded, ${failCount} failed.`
          );
          // Also save global state like nextId
          const saveDir = require("path").resolve(
            __dirname,
            "..",
            require("./lib/config").SERVER_CONFIG.DEFAULT_SAVE_DIR
          );
          const globalState = {
            nextId: require("./lib/game_objects").ServerGameObject.nextId,
          };
          try {
            require("fs").writeFileSync(
              require("path").join(saveDir, "global_state.json"),
              JSON.stringify(globalState)
            );
            console.log(`Global state (nextId: ${globalState.nextId}) saved.`);
          } catch (e) {
            console.error("Error saving global state:", e);
          }
        } else {
          const roomToSave = rooms.get(saveTarget);
          if (roomToSave) {
            if (!roomToSave.saveStateToFile()) {
              console.log(
                `Save failed for room '${saveTarget}'. Check permissions or disk space.`
              );
            }
          } else {
            console.log(`Error: Room '${saveTarget}' not found.`);
          }
        }
        break;

      case "load": // Loading requires careful thought about active players
        const loadTarget = params[0];
        if (!loadTarget) {
          console.log("Usage: load <room_id|all>");
          break;
        }

        console.log(
          "Warning: Loading rooms while server is running can disrupt players in those rooms."
        );

        if (loadTarget.toLowerCase() === "all") {
          console.log(
            "Reloading state for all currently loaded rooms from files..."
          );
          let successCount = 0;
          let failCount = 0;
          // This reloads furniture data for existing room instances.
          // It does NOT dynamically load rooms not present at server start.
          rooms.forEach((room, roomId) => {
            console.log(`Reloading state for room: ${roomId}...`);
            if (room.loadStateFromFile()) {
              // Force clients in that room to get the new state
              io.to(roomId).emit("room_state", room.getStateDTO());
              // Also update the user list in case furniture changes affect walkability/standing
              io.to(roomId).emit("user_list_update", room.getUserList());
              successCount++;
            } else {
              failCount++;
            }
          });
          console.log(
            `Reload complete. ${successCount} succeeded, ${failCount} failed.`
          );
          // Reload global state? Be careful with nextId
          try {
            const saveDir = require("path").resolve(
              __dirname,
              "..",
              require("./lib/config").SERVER_CONFIG.DEFAULT_SAVE_DIR
            );
            const globalStateData = require("fs").readFileSync(
              require("path").join(saveDir, "global_state.json"),
              "utf8"
            );
            const globalState = JSON.parse(globalStateData);
            // Careful: Only update nextId if it makes sense (e.g., higher than current)
            const currentNextId =
              require("./lib/game_objects").ServerGameObject.nextId;
            const loadedNextId = globalState.nextId || 0;
            if (loadedNextId > currentNextId) {
              console.log(
                `Updating global nextId from ${currentNextId} to loaded value ${loadedNextId}.`
              );
              require("./lib/game_objects").ServerGameObject.nextId =
                loadedNextId;
            } else {
              console.log(
                `Loaded nextId (${loadedNextId}) is not greater than current (${currentNextId}). Keeping current.`
              );
            }
          } catch (e) {
            console.warn(
              "Could not load or parse global_state.json for nextId."
            );
          }
        } else {
          const roomToLoad = rooms.get(loadTarget);
          if (roomToLoad) {
            console.log(`Reloading state for room: ${loadTarget}...`);
            if (roomToLoad.loadStateFromFile()) {
              // Force clients in that room to get the new state
              io.to(loadTarget).emit("room_state", roomToLoad.getStateDTO());
              io.to(loadTarget).emit(
                "user_list_update",
                roomToLoad.getUserList()
              );
            } else {
              console.log(`Load failed for room '${loadTarget}'.`);
            }
          } else {
            console.log(`Error: Room '${loadTarget}' not found.`);
          }
        }
        break;

      case "stop":
      case "exit":
        console.log("Initiating server shutdown via console command...");
        if (shutdownCallback) {
          shutdownCallback(); // Call the shutdown function passed during init
        } else {
          console.error(
            "Shutdown callback not configured. Cannot shut down gracefully."
          );
        }
        break;

      default:
        console.log(
          `Unknown command: '${command}'. Type 'help' for available commands.`
        );
    }
  } catch (cmdError) {
    // Catch errors during command processing to prevent crashing the console
    console.error(`Error executing command '${command}':`, cmdError.message);
    console.error(cmdError.stack); // Log stack for debugging
  }
}

module.exports = { initializeConsole };
