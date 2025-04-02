"use strict";

const readline = require("readline");
const path = require("path"); // Needed for save/load global state
const fs = require("fs"); // Needed for save/load global state
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config"); // For avatar states, item defs etc.
const { ServerGameObject } = require("./lib/game_objects"); // For accessing global nextId

// --- FIX: Correct the path to the User model ---
// Assuming server_console.js is in the project root and models is a subdirectory
const User = require("./models/user");

// Import specific handler if needed for direct calls (like teleport using room change)
// Ensure the path is correct based on your project structure
let handleChangeRoom;
try {
  // Assuming server_socket_handlers is also in the root
  handleChangeRoom = require("./server_socket_handlers").handleChangeRoom;
} catch (e) {
  console.error(
    "Failed to import handleChangeRoom from server_socket_handlers:",
    e
  );
  handleChangeRoom = null; // Set to null if import fails
}

// --- Globals passed from server.js ---
let rooms; // Map<roomId, ServerRoom>
let io;
let clients; // Map: socket.id -> { socket, avatarId, userId }
let shutdownCallback; // Function to call for graceful shutdown

/**
 * Initializes the console command interface.
 * @param {Map<string, import('./lib/room')>} roomsMap - The map of active room instances.
 * @param {import('socket.io').Server} ioInstance - The Socket.IO server instance.
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

  rl.on("line", async (input) => {
    // <-- Make the line handler async
    await handleConsoleInput(input.trim()); // <-- await the async handler
    rl.prompt(); // Show prompt again after command finishes
  }).on("close", () => {
    console.log("Console input closed.");
    // This usually happens during shutdown sequence
  });

  return rl; // Return the readline interface instance
}

/**
 * Helper function to find an avatar globally across all rooms by name.
 * @param {string} name - The avatar name (case-insensitive search).
 * @returns {{avatar: import('./lib/game_objects').ServerAvatar | null, room: import('./lib/room') | null}} - The avatar and the room they are in, or nulls if not found.
 */
function findAvatarGlobally(name) {
  if (!name) return { avatar: null, room: null };
  const lowerName = name.toLowerCase();
  for (const [roomId, room] of rooms.entries()) {
    // Search within the room's avatars map
    // Ensure room.avatars exists and is an object/map
    if (room && typeof room.avatars === "object" && room.avatars !== null) {
      const avatar = Object.values(room.avatars).find(
        (a) =>
          a && typeof a.name === "string" && a.name.toLowerCase() === lowerName
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
    } else {
      // console.warn(`Room ${roomId} has invalid 'avatars' property.`); // Can be noisy
    }
  }
  return { avatar: null, room: null }; // Not found in any room
}

/**
 * Processes a command entered into the server console. (Now Async)
 * @param {string} input - The trimmed command line input.
 */
async function handleConsoleInput(input) {
  // <-- Make function async
  if (!input) return;

  // Improved regex to handle quotes better, including empty quotes
  const args = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const command = args[0]?.toLowerCase();
  // Remove surrounding quotes from parameters
  const params = args.slice(1).map((arg) => {
    if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
      return arg.slice(1, -1);
    }
    return arg;
  });

  if (!command) return;

  try {
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
          "  save <room_id|all>           - Save specific room state (DB) or all rooms."
        );
        console.log(
          "  load <room_id|all>           - Load specific room state (DB) or all rooms (Warning: Disruptive)."
        );
        console.log(
          "  setadmin <username>            - Grant admin privileges to a user."
        );
        console.log(
          "  removeadmin <username>         - Revoke admin privileges from a user."
        );
        console.log(
          "  debuguser <username>         - Show DB vs Live state for a user."
        ); // Added help entry
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
            className: "server-msg", // Add class for styling
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
        const targetRoomIdList = params[0];
        if (targetRoomIdList) {
          const room = rooms.get(targetRoomIdList);
          if (room) {
            console.log(`Users in room '${targetRoomIdList}':`);
            const users = room
              .getUserList()
              .sort((a, b) => a.name.localeCompare(b.name)); // Sort list
            if (users.length === 0) {
              console.log("  (Empty)");
            } else {
              users.forEach((u) => {
                const avatar = Object.values(room.avatars).find(
                  (av) => av && av.id === u.id
                );
                console.log(
                  `  - ${u.name} (ID: ${u.id})${
                    avatar ? ` Socket: ${avatar.socketId}` : ""
                  }`
                );
              });
            }
          } else {
            console.log(`Error: Room '${targetRoomIdList}' not found.`);
          }
        } else {
          console.log("Users Online (All Rooms):");
          let totalUsers = 0;
          const roomIds = Array.from(rooms.keys()).sort();
          roomIds.forEach((roomId) => {
            const room = rooms.get(roomId);
            if (room && typeof room.getUserList === "function") {
              const users = room
                .getUserList()
                .sort((a, b) => a.name.localeCompare(b.name));
              if (users.length > 0) {
                console.log(`  --- Room: ${roomId} ---`);
                users.forEach((u) => {
                  const avatar = Object.values(room.avatars).find(
                    (av) => av && av.id === u.id
                  );
                  console.log(
                    `    - ${u.name} (ID: ${u.id})${
                      avatar ? ` Socket: ${avatar.socketId}` : ""
                    }`
                  );
                });
                totalUsers += users.length;
              }
            }
          });
          if (totalUsers === 0) console.log("  (No users connected)");
        }
        break;

      case "kick":
        if (params.length === 1) {
          const targetNameKick = params[0];
          const { avatar: targetAvatarKick } =
            findAvatarGlobally(targetNameKick); // Use global find
          if (targetAvatarKick && clients[targetAvatarKick.socketId]) {
            console.log(
              `Kicking user ${targetAvatarKick.name} (Room: ${targetAvatarKick.roomId}, Socket: ${targetAvatarKick.socketId})...`
            );
            // Force disconnect the client's socket
            clients[targetAvatarKick.socketId].socket.disconnect(true);
            // The 'disconnect' event handler will manage cleanup in room.avatars and clients map
          } else {
            console.log(
              `User '${targetNameKick}' not found or associated socket missing.`
            );
          }
        } else {
          console.log("Usage: kick <username>");
        }
        break;

      case "teleport":
        if (params.length === 4) {
          const targetNameTp = params[0];
          const destRoomId = params[1];
          const targetX = parseInt(params[2], 10);
          const targetY = parseInt(params[3], 10);

          const { avatar: targetAvatarTp } = findAvatarGlobally(targetNameTp); // Find user globally
          const destRoom = rooms.get(destRoomId); // Find destination room

          if (!targetAvatarTp) {
            console.log(`Error: User '${targetNameTp}' not found.`);
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
                `Teleporting ${targetAvatarTp.name} from ${targetAvatarTp.roomId} to ${destRoomId}(${targetX}, ${targetY})...`
              );

              // Use the room change logic, even if staying in the same room (ensures state reset)
              const socket = clients[targetAvatarTp.socketId]?.socket;
              if (socket && typeof handleChangeRoom === "function") {
                // Pass target coords directly to room change handler
                handleChangeRoom(socket, {
                  targetRoomId: destRoomId,
                  targetX: targetX,
                  targetY: targetY,
                });
                console.log(` -> Teleport requested via room change handler.`);
              } else {
                console.error(
                  ` -> Cannot teleport: Socket for ${targetNameTp} not found or handleChangeRoom handler is missing/failed to import.`
                );
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
            try {
              const validIds = SHARED_CONFIG.FURNITURE_DEFINITIONS.map(
                (d) => d.id
              ).join(", ");
              console.log(`Valid Item IDs: ${validIds}`);
            } catch (e) {
              console.error(
                "Could not list item IDs - SHARED_CONFIG error?",
                e
              );
            }
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

      // --- SAVE COMMAND (Updated for Async DB) ---
      case "save":
        const saveTarget = params[0];
        if (!saveTarget) {
          console.log("Usage: save <room_id|all>");
          break;
        }

        if (saveTarget.toLowerCase() === "all") {
          console.log("Saving all rooms to DB...");
          let successCount = 0;
          let failCount = 0;
          const allRoomSaves = [];
          rooms.forEach((room, roomId) => {
            if (room && typeof room.saveStateToDB === "function") {
              // Add the promise to the array, handle individual errors
              allRoomSaves.push(
                room
                  .saveStateToDB()
                  .then((ok) => {
                    if (ok) successCount++;
                    else failCount++;
                  })
                  .catch((e) => {
                    console.error(`Error saving room ${roomId} to DB:`, e);
                    failCount++;
                  })
              );
            } else {
              console.warn(
                `Room ${roomId} cannot be saved (invalid instance or method missing).`
              );
              failCount++;
            }
          });
          await Promise.all(allRoomSaves); // Wait for all save attempts
          console.log(
            `DB Save complete. ${successCount} succeeded, ${failCount} failed.`
          );
        } else {
          const roomToSave = rooms.get(saveTarget);
          if (roomToSave && typeof roomToSave.saveStateToDB === "function") {
            console.log(`Saving room '${saveTarget}' to DB...`);
            if (!(await roomToSave.saveStateToDB())) {
              // await the save
              console.log(
                `DB Save failed for room '${saveTarget}'. Check logs.`
              );
            } else {
              console.log(`Room '${saveTarget}' saved to DB successfully.`);
            }
          } else {
            console.log(
              `Error: Room '${saveTarget}' not found or cannot be saved.`
            );
          }
        }
        break;

      // --- LOAD COMMAND (Updated for Async DB) ---
      case "load":
        const loadTarget = params[0];
        if (!loadTarget) {
          console.log("Usage: load <room_id|all>");
          break;
        }

        console.warn(
          "Warning: Loading rooms from DB while server runs can disrupt players."
        );

        if (loadTarget.toLowerCase() === "all") {
          console.log("Reloading state for all loaded rooms from DB...");
          let successCount = 0;
          let failCount = 0;
          // Use for...of to allow await inside the loop
          for (const [roomId, room] of rooms.entries()) {
            if (room && typeof room.loadStateFromDB === "function") {
              console.log(`Reloading state for room: ${roomId}...`);
              try {
                if (await room.loadStateFromDB()) {
                  // await the load
                  // Force clients in that room to get the new state
                  io.to(roomId).emit("room_state", room.getStateDTO());
                  io.to(roomId).emit("user_list_update", room.getUserList());
                  successCount++;
                } else {
                  console.log(
                    `DB Load returned false (used defaults or failed) for room '${roomId}'.`
                  );
                  failCount++; // Count as failed if it didn't load existing state
                }
              } catch (loadErr) {
                console.error(
                  `Error during DB Load for room ${roomId}:`,
                  loadErr
                );
                failCount++;
              }
            } else {
              console.warn(
                `Room ${roomId} cannot be loaded (invalid instance or method missing).`
              );
              failCount++;
            }
          }
          console.log(
            `DB Reload complete. ${successCount} succeeded, ${failCount} failed.`
          );
        } else {
          const roomToLoad = rooms.get(loadTarget);
          if (roomToLoad && typeof roomToLoad.loadStateFromDB === "function") {
            console.log(`Reloading state for room: ${loadTarget}...`);
            try {
              if (await roomToLoad.loadStateFromDB()) {
                // await the load
                io.to(loadTarget).emit("room_state", roomToLoad.getStateDTO());
                io.to(loadTarget).emit(
                  "user_list_update",
                  roomToLoad.getUserList()
                );
                console.log(
                  `Room '${loadTarget}' reloaded from DB successfully.`
                );
              } else {
                console.log(
                  `DB Load returned false (used defaults or failed) for room '${loadTarget}'.`
                );
              }
            } catch (loadErr) {
              console.error(
                `Error during DB Load for room ${loadTarget}:`,
                loadErr
              );
            }
          } else {
            console.log(
              `Error: Room '${loadTarget}' not found or cannot be loaded.`
            );
          }
        }
        break;

      case "setadmin":
        if (params.length === 1) {
          const usernameToAdmin = params[0].toLowerCase();
          try {
            const result = await User.updateOne(
              { username: usernameToAdmin },
              { $set: { isAdmin: true } }
            );
            if (result.matchedCount === 0) {
              console.log(`Error: User '${params[0]}' not found in database.`);
            } else if (result.modifiedCount === 0) {
              console.log(`User '${params[0]}' is already an admin.`);
            } else {
              console.log(
                `Success: Granted admin privileges to '${params[0]}'.`
              );
              // --- Update live status if user is online ---
              const { avatar: liveAdminAvatar } = findAvatarGlobally(params[0]);
              if (liveAdminAvatar && clients[liveAdminAvatar.socketId]) {
                const adminSocket = clients[liveAdminAvatar.socketId].socket;
                adminSocket.isAdmin = true; // Update live socket status
                liveAdminAvatar.isAdmin = true; // Update live avatar status
                // Notify the user and broadcast potential visual update
                adminSocket.emit("chat_message", {
                  avatarName: "Server",
                  text: "You have been granted admin privileges.",
                  className: "server-msg",
                });
                io.to(liveAdminAvatar.roomId).emit(
                  "avatar_update",
                  liveAdminAvatar.toDTO()
                ); // Send updated DTO
                console.log(
                  ` -> Updated live admin status for ${liveAdminAvatar.name}.`
                );
              }
              // --- End Live Update ---
            }
          } catch (dbError) {
            console.error(
              `Database error setting admin for '${params[0]}':`,
              dbError
            );
          }
        } else {
          console.log("Usage: setadmin <username>");
        }
        break;

      case "removeadmin":
        if (params.length === 1) {
          const usernameToRemoveAdmin = params[0].toLowerCase();
          try {
            const result = await User.updateOne(
              { username: usernameToRemoveAdmin },
              { $set: { isAdmin: false } }
            );
            if (result.matchedCount === 0) {
              console.log(`Error: User '${params[0]}' not found in database.`);
            } else if (result.modifiedCount === 0) {
              console.log(`User '${params[0]}' is not currently an admin.`);
            } else {
              console.log(
                `Success: Revoked admin privileges from '${params[0]}'.`
              );
              // --- Update live status if user is online ---
              const { avatar: liveNonAdminAvatar } = findAvatarGlobally(
                params[0]
              );
              if (liveNonAdminAvatar && clients[liveNonAdminAvatar.socketId]) {
                const nonAdminSocket =
                  clients[liveNonAdminAvatar.socketId].socket;
                nonAdminSocket.isAdmin = false; // Update live socket status
                liveNonAdminAvatar.isAdmin = false; // Update live avatar status
                nonAdminSocket.emit("chat_message", {
                  avatarName: "Server",
                  text: "Your admin privileges have been revoked.",
                  className: "server-msg",
                });
                io.to(liveNonAdminAvatar.roomId).emit(
                  "avatar_update",
                  liveNonAdminAvatar.toDTO()
                ); // Send updated DTO
                console.log(
                  ` -> Updated live admin status for ${liveNonAdminAvatar.name}.`
                );
              }
              // --- End Live Update ---
            }
          } catch (dbError) {
            console.error(
              `Database error removing admin for '${params[0]}':`,
              dbError
            );
          }
        } else {
          console.log("Usage: removeadmin <username>");
        }
        break;

      // --- NEW DEBUG COMMAND ---
      case "debuguser":
        if (params.length !== 1) {
          console.log("Usage: debuguser <username>");
          break;
        }
        const targetUsername = params[0];
        const lowerTargetUsername = targetUsername.toLowerCase();

        console.log(`--- Debugging User: ${targetUsername} ---`);

        // --- 1. Fetch from Database ---
        let dbUserData = null;
        try {
          // Use the correctly imported User model
          dbUserData = await User.findOne({
            username: lowerTargetUsername,
          }).lean(); // Use lean for plain object
          if (dbUserData) {
            console.log("  Database State:");
            console.log(`    _id: ${dbUserData._id}`);
            console.log(`    Username: ${dbUserData.username}`);
            console.log(`    Last Room: ${dbUserData.lastRoomId}`);
            console.log(
              `    Last Coords: (${dbUserData.lastX}, ${
                dbUserData.lastY
              }, Z:${dbUserData.lastZ?.toFixed(2)})`
            );
            console.log(`    Currency: ${dbUserData.currency}`);
            console.log(`    Body Color: ${dbUserData.bodyColor}`);
            // Check walkability of DB coords in the DB lastRoomId
            const dbLastRoom = rooms.get(dbUserData.lastRoomId);
            if (dbLastRoom) {
              const isDbCoordsWalkable = dbLastRoom.isWalkable(
                dbUserData.lastX,
                dbUserData.lastY
              );
              console.log(
                `    DB Coords Walkable in '${dbUserData.lastRoomId}': ${
                  isDbCoordsWalkable ? "Yes" : "No"
                }`
              );
            } else {
              console.log(
                `    Cannot check walkability: Room '${dbUserData.lastRoomId}' not currently loaded.`
              );
            }
          } else {
            console.log(
              `  Database State: User '${targetUsername}' not found in DB.`
            );
          }
        } catch (dbError) {
          console.error(
            `  Database Error fetching user '${targetUsername}':`,
            dbError
          );
        }

        // --- 2. Fetch from Live Game State ---
        const { avatar: liveAvatar, room: liveRoom } =
          findAvatarGlobally(targetUsername);

        if (liveAvatar && liveRoom) {
          console.log("  Live Game State:");
          console.log(`    Avatar ID: ${liveAvatar.id}`);
          console.log(`    Socket ID: ${liveAvatar.socketId}`);
          console.log(
            `    Current Room: ${liveAvatar.roomId} (Instance: ${liveRoom.id})`
          ); // Show both for consistency check
          console.log(
            `    Current Coords: (${liveAvatar.x.toFixed(
              2
            )}, ${liveAvatar.y.toFixed(2)}, Z:${liveAvatar.z.toFixed(2)})`
          );
          console.log(`    State: ${liveAvatar.state}`);
          console.log(`    Direction: ${liveAvatar.direction}`);
          console.log(`    Currency: ${liveAvatar.currency}`);
          console.log(`    Body Color: ${liveAvatar.bodyColor}`);
          console.log(
            `    Sitting On: ${liveAvatar.sittingOnFurniId || "None"}`
          );
          console.log(`    Path Length: ${liveAvatar.path?.length || 0}`);
          console.log(
            `    Action After Path: ${
              liveAvatar.actionAfterPath
                ? JSON.stringify(liveAvatar.actionAfterPath)
                : "None"
            }`
          );
        } else {
          console.log(
            `  Live Game State: Avatar '${targetUsername}' not currently online.`
          );
        }

        // --- 3. Comparison (if both found) ---
        if (dbUserData && liveAvatar) {
          console.log("  Comparison:");
          if (dbUserData.lastRoomId !== liveAvatar.roomId) {
            console.warn(
              `    ROOM MISMATCH: DB (${dbUserData.lastRoomId}) vs Live (${liveAvatar.roomId})`
            );
          }
          const dbX = dbUserData.lastX;
          const dbY = dbUserData.lastY;
          const liveX = Math.round(liveAvatar.x); // Compare rounded live coords
          const liveY = Math.round(liveAvatar.y);
          if (dbX !== liveX || dbY !== liveY) {
            console.warn(
              `    COORDS MISMATCH: DB (${dbX},${dbY}) vs Live (~${liveX},${liveY})`
            );
          } else {
            console.log(
              `    Coords Match (Rounded): DB (${dbX},${dbY}) vs Live (~${liveX},${liveY})`
            );
          }
          if (dbUserData.currency !== liveAvatar.currency) {
            console.warn(
              `    CURRENCY MISMATCH: DB (${dbUserData.currency}) vs Live (${liveAvatar.currency})`
            );
          }
        }
        console.log(`--- End Debug User: ${targetUsername} ---`);
        break;
      // --- END DEBUG COMMAND ---

      case "stop":
      case "exit":
        console.log("Initiating server shutdown via console command...");
        if (shutdownCallback) {
          // No await needed here, shutdown handles its own process exit
          shutdownCallback();
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
    console.error(`Error executing command '${command}':`, cmdError.message);
    // console.error(cmdError.stack); // Optional: log full stack
  }
} // End handleConsoleInput

module.exports = { initializeConsole, findAvatarGlobally };
