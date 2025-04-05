"use strict";

const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const { ServerAvatar, ServerFurniture } = require("./lib/game_objects");
const { rotateDirection } = require("./lib/utils");
const Furniture = require("./models/furniture");
const { findAvatarGlobally } = require("./server_console");

// --- Globals passed from server.js ---
let rooms; // Map<roomId, ServerRoom>
let io;
let clients; // Map: socket.id -> { socket, avatarId (runtime), userId (persistent) }

// --- Stored DB Helper Functions ---
let findUserById; // Will hold findUserByIdFromDB reference
let updateUser; // Will hold updateUserInDB reference

/**
 * Initialize handlers with dependencies.
 * @param {Map<string, import('./lib/room')>} roomsMap - The map of active room instances.
 * @param {import('socket.io').Server} ioInstance - The Socket.IO server instance.
 * @param {object} clientsMap - The map tracking client connections.
 * @param {Function} findUserFunc - The function to find a user by ID from DB.
 * @param {Function} updateUserFunc - The function to update a user in DB.
 */
function initializeHandlers(
  roomsMap,
  ioInstance,
  clientsMap,
  findUserFunc,
  updateUserFunc
) {
  rooms = roomsMap; // Store the map of rooms
  io = ioInstance;
  clients = clientsMap;
  // --- Store the DB functions ---
  findUserById = findUserFunc;
  updateUser = updateUserFunc;

  if (typeof findUserById !== "function" || typeof updateUser !== "function") {
    console.error(
      "FATAL: DB helper functions not passed correctly to SocketHandlers.initializeHandlers!"
    );
    throw new Error(
      "Socket Handlers initialized without required DB functions."
    );
  }
  console.log("Socket Handlers initialized with DB functions.");
}

// --- Helper function to get avatar and their current room ---
// (Operates on runtime IDs and in-memory room state)
function getAvatarAndRoom(socketId) {
  const clientInfo = clients[socketId];
  if (!clientInfo || clientInfo.avatarId == null) {
    return { avatar: null, room: null, socket: clientInfo?.socket };
  }
  const avatarId = clientInfo.avatarId; // This is the RUNTIME ID

  let avatar = null;
  let roomId = null;
  for (const [id, r] of rooms.entries()) {
    if (r && r.avatars && typeof r.avatars === "object") {
      // Find by runtime ID
      avatar = Object.values(r.avatars).find((a) => a && a.id === avatarId);
      if (avatar) {
        roomId = id;
        // Ensure consistency
        if (avatar.roomId !== roomId) {
          console.warn(
            `Consistency Warning: Avatar ${avatarId}(${avatar.name}) found in room ${roomId} structure, but avatar.roomId is ${avatar.roomId}. Correcting.`
          );
          avatar.roomId = roomId;
        }
        break;
      }
    }
  }

  if (!avatar) {
    // Could happen during disconnect/room change race conditions
    // console.warn(`getAvatarAndRoom: Could not find avatar object for runtime ID ${avatarId} (Socket: ${socketId}) in any room.`);
    return { avatar: null, room: null, socket: clientInfo.socket };
  }

  // Use the confirmed roomId from the avatar object
  const currentRoomId = avatar.roomId;
  if (!currentRoomId) {
    console.warn(
      `getAvatarAndRoom: Avatar ${avatarId} found but has no valid roomId property.`
    );
    return { avatar: avatar, room: null, socket: clientInfo.socket };
  }

  const room = rooms.get(currentRoomId);
  if (!room) {
    console.warn(
      `getAvatarAndRoom: Avatar ${avatarId} has roomId ${currentRoomId}, but room instance not found in map.`
    );
    return { avatar: avatar, room: null, socket: clientInfo.socket };
  }

  // Success
  return { avatar, room, socket: clientInfo.socket };
}

// --- Event Handler Functions ---

// --- Connection Handler (ASYNC due to DB read) ---
async function handleConnection(socket) {
  console.log(`Client connected: ${socket.id}, UserID: ${socket.userId}`); // userId from middleware
  // Initialize client entry
  clients[socket.id] = {
    socket: socket,
    avatarId: null,
    userId: socket.userId,
  };
  socket.isAdmin = false;

  let userData;
  try {
    // Use the stored DB function reference
    if (!findUserById)
      throw new Error("findUserById DB function not initialized.");
    userData = await findUserById(socket.userId); // Fetch user data
    if (!userData)
      throw new Error(`User data not found for ID: ${socket.userId}`);

    socket.isAdmin = userData.isAdmin || false;
    console.log(
      ` -> User ${userData.username} isAdmin status: ${socket.isAdmin}`
    );
  } catch (err) {
    console.error(
      `Failed to load user data for: ${socket.userId}:`,
      err.message
    );
    socket.emit("auth_error", "Failed to load your player data.");
    socket.disconnect(true);
    if (clients[socket.id]) delete clients[socket.id]; // Cleanup
    return;
  }

  // Determine Spawn Location
  let spawnRoomId = userData.lastRoomId || SERVER_CONFIG.DEFAULT_ROOM_ID;
  let room = rooms.get(spawnRoomId); // Get room instance

  // Fallback to default room if needed
  if (!room) {
    console.warn(
      `User ${socket.userId}'s target room '${spawnRoomId}' not found! Spawning in default (${SERVER_CONFIG.DEFAULT_ROOM_ID}).`
    );
    spawnRoomId = SERVER_CONFIG.DEFAULT_ROOM_ID;
    room = rooms.get(spawnRoomId);
    if (!room) {
      // Critical error if default room doesn't exist
      console.error(
        `FATAL: Default room '${SERVER_CONFIG.DEFAULT_ROOM_ID}' not found! Cannot spawn player ${socket.userId}.`
      );
      socket.emit("auth_error", "Default game room is unavailable.");
      socket.disconnect(true);
      if (clients[socket.id]) delete clients[socket.id];
      return;
    }
  }

  // Find spawn point within the room
  const spawnPoint = room.findSpawnPoint(userData.lastX, userData.lastY);
  console.log(
    `Spawning ${userData.username} in ${room.id} at (${spawnPoint.x}, ${spawnPoint.y}) (Preferred: ${userData.lastX}, ${userData.lastY})`
  );

  // Check if game object classes are loaded
  if (!ServerAvatar || !ServerFurniture) {
    console.error(
      "FATAL: Server game object classes not loaded. Cannot create avatar."
    );
    socket.emit("auth_error", "Server error during player initialization.");
    socket.disconnect(true);
    if (clients[socket.id]) delete clients[socket.id];
    return;
  }

  // Create Avatar instance with runtime ID (pass null for persistentId)
  const newAvatar = new ServerAvatar(
    spawnPoint.x,
    spawnPoint.y,
    userData.username || `User_${socket.id.substring(0, 4)}`,
    socket.id
  );
  // Apply loaded data
  newAvatar.isAdmin = socket.isAdmin;
  newAvatar.currency = userData.currency ?? SHARED_CONFIG.DEFAULT_CURRENCY;
  newAvatar.inventory = new Map(Object.entries(userData.inventory || {}));
  newAvatar.bodyColor = userData.bodyColor || "#6CA0DC";
  newAvatar.z = userData.lastZ ?? SHARED_CONFIG.AVATAR_DEFAULT_Z;
  newAvatar.roomId = room.id; // Set initial room

  // Store the generated runtime avatarId in the clients map
  clients[socket.id].avatarId = newAvatar.id;

  // Join Socket.IO room
  socket.join(room.id);
  console.log(`Socket ${socket.id} joined Socket.IO room: ${room.id}`);

  // Add avatar instance to the room's in-memory state
  room.addAvatar(newAvatar);
  console.log(
    `Avatar ${newAvatar.name} (RuntimeID:${newAvatar.id}, UserID: ${socket.userId}) added to room ${room.id} state.`
  );

  // Send full room state (includes the new avatar)
  socket.emit("room_state", room.getStateDTO());

  // Send client-specific initial state
  socket.emit("your_avatar_id", String(newAvatar.id)); // Send runtime ID as string
  socket.emit("inventory_update", newAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: newAvatar.currency });

  // Broadcast new avatar TO OTHERS in the room
  socket.to(room.id).emit("avatar_added", newAvatar.toDTO());
  console.log(
    ` -> Broadcast 'avatar_added' for ${newAvatar.name} to room ${room.id}.`
  );

  // Send user list update TO EVERYONE in the room
  io.to(room.id).emit("user_list_update", room.getUserList());

  // Attach Event Listeners
  socket.on("request_move", (data) => handleRequestMove(socket, data));
  socket.on("send_chat", (message) => handleSendChat(socket, message));
  socket.on("request_place_furni", (data) =>
    handleRequestPlaceFurni(socket, data)
  ); // Now async
  socket.on("request_rotate_furni", (data) =>
    handleRequestRotateFurni(socket, data)
  ); // Now async
  socket.on("request_pickup_furni", (data) =>
    handleRequestPickupFurni(socket, data)
  ); // Now async
  socket.on("request_sit", (data) => handleRequestSit(socket, data));
  socket.on("request_stand", () => handleRequestStand(socket));
  socket.on("request_user_list", () => handleRequestUserList(socket));
  socket.on("request_profile", (data) => handleRequestProfile(socket, data));
  socket.on("request_use_furni", (data) => handleRequestUseFurni(socket, data)); // Now async
  socket.on("request_recolor_furni", (data) =>
    handleRequestRecolorFurni(socket, data)
  ); // Now async
  socket.on("request_buy_item", (data) => handleRequestBuyItem(socket, data));
  socket.on("request_change_room", (data) => handleChangeRoom(socket, data)); // Handles its own logic
  socket.on("disconnect", (reason) => handleDisconnect(socket, reason)); // Async
  socket.on("connect_error", (err) => handleConnectError(socket, err)); // Wrapper for disconnect
}

// --- Request Move Handler ---
function handleRequestMove(socket, target) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !room ||
    !target ||
    typeof target.x !== "number" ||
    typeof target.y !== "number"
  ) {
    // console.warn(`[Move Request Invalid] Socket: ${socket.id}, Avatar: ${!!avatar}, Room: ${!!room}, Target: ${JSON.stringify(target)}`);
    return;
  }
  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Cannot move while sitting.",
    });
    return;
  }
  const endX = Math.round(target.x);
  const endY = Math.round(target.y);

  // Use room's in-memory check
  if (!room.isWalkable(endX, endY)) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Cannot walk there.",
    });
    // Stop path if walking towards invalid target
    if (avatar.state === SHARED_CONFIG.AVATAR_STATE_WALKING) {
      const oldState = avatar.state;
      avatar.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
      avatar.path = [];
      avatar.actionAfterPath = null;
      avatar.clearEmote(true);
      if (oldState !== avatar.state)
        io.to(room.id).emit("avatar_update", avatar.toDTO());
    }
    return;
  }

  // Pass the room context and the room change handler to moveTo
  if (avatar.moveTo(endX, endY, room, null, handleChangeRoom)) {
    // Broadcast TO THE ROOM if state/path changed OR emote cleared
    io.to(room.id).emit("avatar_update", avatar.toDTO());
  } else {
    // Ensure idle if pathfinding failed or finished without action
    if (
      avatar.state !== SHARED_CONFIG.AVATAR_STATE_SITTING &&
      avatar.state !== SHARED_CONFIG.AVATAR_STATE_IDLE
    ) {
      const oldState = avatar.state;
      avatar.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
      avatar.path = [];
      avatar.actionAfterPath = null;
      avatar.clearEmote(true);
      if (oldState !== avatar.state)
        io.to(room.id).emit("avatar_update", avatar.toDTO());
    }
  }
}

// --- Send Chat Handler ---
function handleSendChat(socket, message) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || typeof message !== "string") return;
  const cleanMessage = message.substring(0, 100).trim();
  if (!cleanMessage) return;

  // Command Handling
  if (cleanMessage.startsWith("/")) {
    const parts = cleanMessage.substring(1).split(" ");
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);
    console.log(
      `[${room.id}] ${avatar.name} issued command: /${command} ${args.join(
        " "
      )}`
    );

    let updateNeeded = false; // Did the command change avatar state/appearance?
    let broadcastUpdate = true; // Should the update be broadcast?
    let isAdminCommand = false;

    switch (command) {
      case "kick":
      case "give":
      case "givegold":
      case "teleport":
      case "announce":
        isAdminCommand = true;
        if (!socket.isAdmin) {
          socket.emit("action_failed", {
            action: "command",
            reason: "Admin permission required.",
          });
          return; // Exit early if non admin
        }
        break;
      case "admin": // Example: /admin <message>
        if (!socket.isAdmin) {
          socket.emit("action_failed", {
            action: "command",
            reason: "Admin permission required.",
          });
          return;
        }
        if (args.length > 0) {
          const adminMsg = args.join(" ");
          io.emit("chat_message", {
            avatarId: null,
            avatarName: "Admin", // Special name
            text: `[${avatar.name}]: ${adminMsg}`,
            className: "admin-msg", // Special class for styling
          });
          console.log(`Admin ${avatar.name} broadcast: ${adminMsg}`);
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: "Usage: /admin <message>",
          });
        }
        return;
    }

    switch (command) {
      case "wave":
      case "dance":
      case "happy":
      case "sad":
        if (SHARED_CONFIG.EMOTE_DEFINITIONS[command]) {
          // Pass io instance for emote end broadcast
          if (avatar.executeEmote(command, io)) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "emote",
              reason: `Cannot ${command} right now`,
            });
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: `Unknown command: /${command}`,
          });
          broadcastUpdate = false;
        }
        break;
      case "emote":
        const emoteId = args[0]?.toLowerCase();
        if (emoteId && SHARED_CONFIG.EMOTE_DEFINITIONS[emoteId]) {
          if (avatar.executeEmote(emoteId, io)) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "emote",
              reason: `Cannot perform emote '${emoteId}' right now`,
            });
        } else {
          socket.emit("action_failed", {
            action: "emote",
            reason: `Usage: /emote <emote_id>. Valid: ${Object.keys(
              SHARED_CONFIG.EMOTE_DEFINITIONS
            ).join(", ")}`,
          });
          broadcastUpdate = false;
        }
        break;
      case "setcolor":
        if (args.length === 1) {
          if (avatar.setBodyColor(args[0])) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "setcolor",
              reason: "Invalid color format (#RRGGBB) or no change needed.",
            });
        } else {
          socket.emit("action_failed", {
            action: "setcolor",
            reason: "Usage: /setcolor #RRGGBB",
          });
          broadcastUpdate = false;
        }
        break;
      case "join": // Room Change Command
        if (args.length === 1) {
          const targetRoomId = args[0];
          handleChangeRoom(socket, { targetRoomId }); // Call the handler
          updateNeeded = false; // Room change handles its own broadcasts
          broadcastUpdate = false;
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: "Usage: /join <room_id>",
          });
          broadcastUpdate = false;
        }
        break;
      case "myroom": // Debug command
        socket.emit("chat_message", {
          avatarId: null,
          avatarName: "Server",
          text: `You are in room: ${avatar.roomId || "Unknown"}`,
          className: "info-msg",
        });
        updateNeeded = false;
        broadcastUpdate = false;
        break;
      case "kick":
        if (args.length === 1) {
          const targetNameKick = args[0];
          const { avatar: targetAvatarKick } =
            findAvatarGlobally(targetNameKick); // Use global find
          if (targetAvatarKick && clients[targetAvatarKick.socketId]) {
            if (targetAvatarKick.isAdmin && !socket.isAdmin) {
              // Optional: Prevent non-admins kicking admins
              socket.emit("action_failed", {
                action: "kick",
                reason: "Cannot kick an administrator.",
              });
              break;
            }
            console.log(
              `ADMIN ACTION: ${avatar.name} kicking user ${targetAvatarKick.name} (Room: ${targetAvatarKick.roomId}, Socket: ${targetAvatarKick.socketId})...`
            );
            clients[targetAvatarKick.socketId].socket.emit(
              "force_disconnect",
              `Kicked by admin ${avatar.name}`
            );
            clients[targetAvatarKick.socketId].socket.disconnect(true);
            io.emit("chat_message", {
              avatarName: "Server",
              text: `${targetAvatarKick.name} was kicked by ${avatar.name}.`,
              className: "server-msg",
            });
          } else {
            socket.emit("action_failed", {
              action: "kick",
              reason: `User '${targetNameKick}' not found online.`,
            });
          }
        } else {
          socket.emit("action_failed", {
            action: "kick",
            reason: "Usage: /kick <username>",
          });
        }
        break;
      case "teleport": // ADMIN ONLY (Checked above)
        if (args.length >= 3) {
          // Allow <user> <x> <y> OR <user> <room> <x> <y>
          const targetNameTp = args[0];
          let destRoomIdTp = room.id; // Default to current room
          let targetXTp, targetYTp;

          if (args.length === 3) {
            // <user> <x> <y>
            targetXTp = parseInt(args[1], 10);
            targetYTp = parseInt(args[2], 10);
          } else {
            // <user> <room> <x> <y>
            destRoomIdTp = args[1];
            targetXTp = parseInt(args[2], 10);
            targetYTp = parseInt(args[3], 10);
          }

          const { avatar: targetAvatarTp } = findAvatarGlobally(targetNameTp);
          const destRoomTp = rooms.get(destRoomIdTp);

          if (!targetAvatarTp) {
            socket.emit("action_failed", {
              action: "teleport",
              reason: `User '${targetNameTp}' not found.`,
            });
          } else if (!destRoomTp) {
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Destination room '${destRoomIdTp}' not found.`,
            });
          } else if (isNaN(targetXTp) || isNaN(targetYTp)) {
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Invalid coordinates '${args[args.length - 2]}, ${
                args[args.length - 1]
              }'.`,
            });
          } else {
            // Validate target tile in destination room IS VALID TERRAIN
            if (destRoomTp.isValidTile(targetXTp, targetYTp)) {
              console.log(
                `ADMIN ACTION: ${avatar.name} teleporting ${targetAvatarTp.name} from ${targetAvatarTp.roomId} to ${destRoomIdTp}(${targetXTp}, ${targetYTp})...`
              );
              const targetSocket = clients[targetAvatarTp.socketId]?.socket;
              if (targetSocket && typeof handleChangeRoom === "function") {
                handleChangeRoom(targetSocket, {
                  targetRoomId: destRoomIdTp,
                  targetX: targetXTp,
                  targetY: targetYTp,
                });
                socket.emit("chat_message", {
                  avatarName: "Server",
                  text: `Teleported ${targetAvatarTp.name} to ${destRoomIdTp}(${targetXTp}, ${targetYTp}).`,
                  className: "info-msg",
                });
              } else {
                socket.emit("action_failed", {
                  action: "teleport",
                  reason: `Cannot teleport: Socket for ${targetNameTp} not found or internal error.`,
                });
              }
            } else {
              socket.emit("action_failed", {
                action: "teleport",
                reason: `Cannot teleport: Target tile (${targetXTp}, ${targetYTp}) in room ${destRoomIdTp} is invalid terrain.`,
              });
            }
          }
        } else {
          socket.emit("action_failed", {
            action: "teleport",
            reason: "Usage: /teleport <user> [room] <x> <y>",
          });
        }
        break;
      case "give": // ADMIN ONLY (Checked above)
        if (args.length >= 2) {
          const targetNameGive = args[0];
          const itemIdGive = args[1];
          const quantityGive = args[2] ? parseInt(args[2], 10) : 1;

          const { avatar: targetAvatarGive } =
            findAvatarGlobally(targetNameGive);

          if (!targetAvatarGive) {
            socket.emit("action_failed", {
              action: "give",
              reason: `User '${targetNameGive}' not found.`,
            });
          } else if (isNaN(quantityGive) || quantityGive <= 0) {
            socket.emit("action_failed", {
              action: "give",
              reason: `Invalid quantity '${args[2]}'. Must be positive.`,
            });
          } else {
            const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
              (def) => def.id === itemIdGive
            );
            if (!definition) {
              socket.emit("action_failed", {
                action: "give",
                reason: `Invalid item ID '${itemIdGive}'.`,
              });
            } else if (targetAvatarGive.addItem(itemIdGive, quantityGive)) {
              console.log(
                `ADMIN ACTION: ${avatar.name} gave ${quantityGive}x ${definition.name} to ${targetAvatarGive.name}.`
              );
              socket.emit("chat_message", {
                avatarName: "Server",
                text: `Gave ${quantityGive}x ${definition.name} to ${targetAvatarGive.name}.`,
                className: "info-msg",
              });
              const targetSock = clients[targetAvatarGive.socketId]?.socket;
              if (targetSock) {
                targetSock.emit(
                  "inventory_update",
                  targetAvatarGive.getInventoryDTO()
                );
                targetSock.emit("chat_message", {
                  avatarName: "Server",
                  text: `Admin ${avatar.name} gave you ${quantityGive}x ${definition.name}!`,
                  className: "server-msg",
                });
              }
            } else {
              socket.emit("action_failed", {
                action: "give",
                reason: `Failed to give item (internal error?).`,
              });
            }
          }
        } else {
          socket.emit("action_failed", {
            action: "give",
            reason: "Usage: /give <user> <item_id> [quantity]",
          });
        }
        break;
      case "givegold": // ADMIN ONLY (Checked above)
        if (args.length === 2) {
          const targetNameGold = args[0];
          const amountGold = parseInt(args[1], 10);

          const { avatar: targetAvatarGold } =
            findAvatarGlobally(targetNameGold);

          if (!targetAvatarGold) {
            socket.emit("action_failed", {
              action: "givegold",
              reason: `User '${targetNameGold}' not found.`,
            });
          } else if (isNaN(amountGold) || amountGold <= 0) {
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Invalid amount '${args[1]}'. Must be positive.`,
            });
          } else if (targetAvatarGold.addCurrency(amountGold)) {
            console.log(
              `ADMIN ACTION: ${avatar.name} gave ${amountGold} Gold to ${targetAvatarGold.name}.`
            );
            socket.emit("chat_message", {
              avatarName: "Server",
              text: `Gave ${amountGold} Gold to ${targetAvatarGold.name}.`,
              className: "info-msg",
            });
            const targetSock = clients[targetAvatarGold.socketId]?.socket;
            if (targetSock) {
              targetSock.emit("currency_update", {
                currency: targetAvatarGold.currency,
              });
              targetSock.emit("chat_message", {
                avatarName: "Server",
                text: `Admin ${avatar.name} gave you ${amountGold} Gold!`,
                className: "server-msg",
              });
            }
          } else {
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Failed to give gold (internal error?).`,
            });
          }
        } else {
          socket.emit("action_failed", {
            action: "givegold",
            reason: "Usage: /givegold <user> <amount>",
          });
        }
        break;
      case "announce": // ADMIN ONLY (Checked above)
        if (args.length > 0) {
          const announceMsg = args.join(" ");
          console.log(`ADMIN ACTION: ${avatar.name} announced: ${announceMsg}`);
          io.emit("chat_message", {
            avatarId: null,
            avatarName: "Announcement", // Special name
            text: announceMsg,
            className: "announcement-msg", // Special class for styling
          });
        } else {
          socket.emit("action_failed", {
            action: "announce",
            reason: "Usage: /announce <message>",
          });
        }
        break;
      // --- End admin-checked commands ---

      default: // Command exists but wasn't handled (or requires admin and check failed)
        if (!isAdminCommand) {
          // Only show unknown if it wasn't an admin command they lacked permission for
          socket.emit("action_failed", {
            action: "command",
            reason: `Unknown command: /${command}`,
          });
          broadcastUpdate = false;
        }
    }
    // Broadcast avatar update TO THE ROOM if needed
    if (updateNeeded && broadcastUpdate) {
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    }
  } else {
    // Regular Chat Message - broadcast TO THE ROOM
    console.log(`[${room.id}] Chat from ${avatar.name}: ${cleanMessage}`);
    io.to(room.id).emit("chat_message", {
      avatarId: String(avatar.id), // Send runtime ID as string
      avatarName: avatar.name,
      text: cleanMessage,
    });
  }
}

// --- Place Furniture Handler (ASYNC) ---
async function handleRequestPlaceFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  // Basic validation
  if (
    !avatar ||
    !room ||
    !data ||
    !data.definitionId ||
    data.x == null ||
    data.y == null
  ) {
    socket.emit("action_failed", {
      action: "place",
      reason: "Invalid request data.",
    });
    return;
  }
  const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
    (d) => d.id === data.definitionId
  );
  if (!definition) {
    socket.emit("action_failed", {
      action: "place",
      reason: "Invalid item definition.",
    });
    return;
  }
  // Inventory check
  if (!avatar.hasItem(data.definitionId, 1)) {
    socket.emit("action_failed", {
      action: "place",
      reason: "You do not have that item.",
    });
    return;
  }

  const gridX = Math.round(data.x);
  const gridY = Math.round(data.y);
  const rotation = data.rotation % 8 || 0;

  // --- Placement Validation (using room's in-memory state) ---
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    width: definition.width || 1,
    height: definition.height || 1,
  };
  const occupiedTiles =
    ServerFurniture.prototype.getOccupiedTiles.call(tempFurniProto);

  for (const tile of occupiedTiles) {
    // Check bounds and layout type
    if (!room.isValidTile(tile.x, tile.y)) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot place on invalid tile (${tile.x},${tile.y}).`,
      });
      return;
    }
    // Check solid obstructions if placing non-flat item
    if (!definition.isFlat) {
      const stack = room.getFurnitureStackAt(tile.x, tile.y); // In-memory check
      const topItemOnThisTile = stack.sort((a, b) => b.z - a.z)[0];
      if (topItemOnThisTile && !topItemOnThisTile.stackable) {
        socket.emit("action_failed", {
          action: "place",
          reason: `Cannot stack on '${topItemOnThisTile.name}' at (${tile.x},${tile.y}).`,
        });
        return;
      }
      if (room.isTileOccupiedBySolid(tile.x, tile.y)) {
        // In-memory check
        const solidBlocker = stack.find(
          (f) => !f.isWalkable && !f.isFlat && !f.stackable
        );
        if (solidBlocker) {
          socket.emit("action_failed", {
            action: "place",
            reason: `Tile (${tile.x},${tile.y}) blocked by solid non-stackable '${solidBlocker.name}'.`,
          });
          return;
        }
      }
    }
  }
  // Check item directly below base tile
  const baseStack = room.getFurnitureStackAt(gridX, gridY); // In-memory check
  const topItemOnBase = baseStack.sort((a, b) => b.z - a.z)[0];
  if (topItemOnBase && !topItemOnBase.stackable && !definition.isFlat) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Cannot stack on '${topItemOnBase.name}' at (${gridX},${gridY}).`,
    });
    return;
  }
  // Check stack height limit
  const baseZ = room.getStackHeightAt(gridX, gridY); // In-memory check
  const placeZ = baseZ + (definition.zOffset || 0);
  if (placeZ >= SHARED_CONFIG.MAX_STACK_Z) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Stack height limit (${SHARED_CONFIG.MAX_STACK_Z.toFixed(
        1
      )}) reached!`,
    });
    return;
  }
  // --- End Validation ---

  // --- Place Item Transaction ---
  // 1. Remove from inventory first
  if (!avatar.removeItem(data.definitionId, 1)) {
    console.error(
      `Inventory inconsistency: ${avatar.name} failed place, could not remove ${data.definitionId}`
    );
    socket.emit("action_failed", {
      action: "place",
      reason: "Inventory error occurred.",
    });
    socket.emit("inventory_update", avatar.getInventoryDTO()); // Resync client
    return;
  }

  // 2. Create in Database
  let savedDocument;
  try {
    const newFurniData = {
      roomId: room.id,
      definitionId: definition.id,
      x: gridX,
      y: gridY,
      z: placeZ,
      rotation: rotation,
      ownerId: clients[socket.id]?.userId || null, // Store User ObjectId
      state: definition.defaultState,
      colorOverride: null,
    };
    savedDocument = await Furniture.create(newFurniData); // DB operation
    if (!savedDocument || !savedDocument._id) {
      throw new Error(
        "DB create operation failed or returned invalid document."
      );
    }
    console.log(
      `[${room.id}] Saved new ${definition.name} to DB (ID: ${savedDocument._id})`
    );

    // 3. Create In-Memory Instance
    const newFurniInstance = new ServerFurniture(
      definition.id,
      gridX,
      gridY,
      placeZ,
      rotation,
      savedDocument._id.toString(), // Pass DB _id string
      savedDocument.ownerId, // Use ownerId from saved doc
      savedDocument.state,
      savedDocument.colorOverride
    );

    // 4. Add instance to room's memory
    room.addFurniture(newFurniInstance);

    // 5. Broadcast and Update Client
    console.log(
      `[${room.id}] ${avatar.name} placed ${definition.name} (ID:${newFurniInstance.id})`
    );
    io.to(room.id).emit("furni_added", newFurniInstance.toDTO()); // Broadcast TO THE ROOM
    socket.emit("inventory_update", avatar.getInventoryDTO()); // Update placer's inventory
  } catch (dbError) {
    console.error(
      `DB Error placing furniture ${definition.id} for ${avatar.name}:`,
      dbError
    );
    // --- Refund Item ---
    avatar.addItem(data.definitionId, 1); // Add back to inventory
    socket.emit("inventory_update", avatar.getInventoryDTO()); // Update client
    socket.emit("action_failed", {
      action: "place",
      reason: "Server error placing item (refunded).",
    });
  }
  // --- End Place Item Transaction ---
}

// --- Rotate Furniture Handler (ASYNC) ---
async function handleRequestRotateFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId); // Ensure DB ID is string
  const furni = room.getFurnitureById(furniId); // Find in room memory

  if (!furni) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Item not found in room.",
    });
    return;
  }

  // Ownership check using persistent User ID
  const clientInfo = clients[socket.id];
  if (furni.ownerId !== null && String(furni.ownerId) !== clientInfo?.userId) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "You don't own this item.",
    });
    return;
  }

  const oldRotation = furni.rotation;
  const newRotation = rotateDirection(furni.rotation, 2); // 90 deg clockwise

  if (oldRotation === newRotation) return; // No actual change

  // 1. Update Database First
  try {
    const updatedDoc = await Furniture.findByIdAndUpdate(
      furniId, // Use the DB ID string
      { $set: { rotation: newRotation } },
      { new: false } // Don't necessarily need the updated doc back
    );
    if (!updatedDoc) {
      // Check if the document existed before update
      throw new Error("Furniture document not found in DB during update.");
    }

    // 2. Update In-Memory Instance
    furni.rotation = newRotation;

    // 3. Broadcast and Update Seated Avatars
    console.log(
      `[${room.id}] ${avatar.name} rotated ${furni.name} (ID:${furni.id}) to ${furni.rotation}`
    );
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      rotation: furni.rotation,
    }); // Broadcast TO THE ROOM

    Object.values(room.avatars).forEach((seatedAvatar) => {
      // Compare avatar's sittingOnFurniId (string) with the rotated furni's ID (string)
      if (String(seatedAvatar.sittingOnFurniId) === furniId) {
        const oldDir = seatedAvatar.direction;
        seatedAvatar.direction = rotateDirection(furni.sitDir, furni.rotation);
        if (oldDir !== seatedAvatar.direction) {
          // Broadcast update for seated avatar TO THE ROOM
          io.to(room.id).emit("avatar_update", {
            id: String(seatedAvatar.id),
            direction: seatedAvatar.direction,
          });
        }
      }
    });
  } catch (dbError) {
    console.error(`DB Error rotating furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Server error rotating item.",
    });
    // DB update failed, in-memory state was not changed yet.
  }
}

// --- Pickup Furniture Handler (ASYNC) ---
async function handleRequestPickupFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId); // Ensure DB ID is string
  const furniInstance = room.getFurnitureById(furniId); // Get in-memory instance

  if (!furniInstance) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Item not found in room.",
    });
    return;
  }

  // Ownership check using persistent User ID
  const clientInfo = clients[socket.id];
  if (
    furniInstance.ownerId === null ||
    (furniInstance.ownerId !== null &&
      String(furniInstance.ownerId) !== clientInfo?.userId)
  ) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "You don't own this item.",
    });
    return;
  }

  // Validation: Check items ON TOP (using in-memory state)
  const furniTiles = furniInstance.getOccupiedTiles();
  const itemsOnTop = room.furniture.filter((f) => {
    if (String(f.id) === furniId || f.isFlat || f.z <= furniInstance.z)
      return false;
    const fTiles = f.getOccupiedTiles();
    return furniTiles.some((ft) =>
      fTiles.some((fft) => ft.x === fft.x && ft.y === fft.y)
    );
  });
  if (itemsOnTop.length > 0) {
    itemsOnTop.sort((a, b) => a.z - b.z);
    socket.emit("action_failed", {
      action: "pickup",
      reason: `Cannot pick up, '${itemsOnTop[0].name}' is on top.`,
    });
    return;
  }

  // Validation: Check if anyone sitting (using in-memory state)
  if (room.isFurnitureOccupied(furniId)) {
    // Checks room memory
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Cannot pick up, someone is using it.",
    });
    return;
  }

  // --- Pickup Transaction ---
  try {
    // 1. Delete from Database First
    const deleteResult = await Furniture.findByIdAndDelete(furniId);
    if (!deleteResult) {
      // Item wasn't in DB (maybe already picked up?)
      console.warn(
        `[${room.id}] Pickup requested for ${furniId}, but not found in DB.`
      );
      const instanceInMemory = room.getFurnitureById(furniId); // Check memory again
      if (instanceInMemory) {
        room.removeFurnitureInstance(furniId); // Remove dangling instance from memory
        console.warn(` -> Removed dangling instance ${furniId} from memory.`);
        io.to(room.id).emit("furni_removed", { id: furniId }); // Notify clients
        // DO NOT add to inventory if DB delete failed/not found
        socket.emit("action_failed", {
          action: "pickup",
          reason: "Item state inconsistency (removed from view).",
        });
        return;
      } else {
        socket.emit("action_failed", {
          action: "pickup",
          reason: "Item already picked up.",
        });
        return;
      }
    }
    console.log(`[${room.id}] Deleted furniture ${furniId} from DB.`);

    // 2. Remove from In-Memory Room
    const removedInstance = room.removeFurnitureInstance(furniId);
    if (!removedInstance) {
      // Should be rare if DB delete succeeded and instance was fetched
      console.error(
        `DB/Memory Inconsistency: Deleted ${furniId} from DB but not found in room memory!`
      );
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Server state inconsistency.",
      });
      // Still broadcast removal based on DB success
      io.to(room.id).emit("furni_removed", { id: furniId });
      return; // Don't proceed to inventory add
    }

    // 3. Add to Avatar Inventory
    if (avatar.addItem(removedInstance.definitionId, 1)) {
      // 4. Broadcast and Update Client
      console.log(
        `[${room.id}] ${avatar.name} picked up ${removedInstance.name} (ID:${removedInstance.id})`
      );
      io.to(room.id).emit("furni_removed", { id: removedInstance.id }); // Broadcast TO THE ROOM
      socket.emit("inventory_update", avatar.getInventoryDTO()); // Update picker's inventory
    } else {
      // Critical Error: Deleted from DB, removed from memory, failed inventory add
      console.error(
        `FATAL Inventory Error: Failed to add picked up item ${removedInstance.definitionId} (DB ID: ${furniId}) to ${avatar.name}. Item potentially lost!`
      );
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Critical inventory error after pickup.",
      });
      // What to do here? Maybe try to re-create in DB? Very difficult state to recover.
    }
  } catch (dbError) {
    console.error(`DB Error picking up furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Server error picking up item.",
    });
    // DB operation failed, no state change occurred yet.
  }
  // --- End Pickup Transaction ---
}

// --- Request Sit Handler ---
function handleRequestSit(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;

  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", { action: "sit", reason: "Already sitting." });
    return;
  }
  const furniId = String(data.furniId); // Ensure string ID for lookup
  const furni = room.getFurnitureById(furniId); // Find in room memory

  if (!furni || !furni.canSit) {
    socket.emit("action_failed", {
      action: "sit",
      reason: "Cannot sit on this item.",
    });
    return;
  }
  // Checks room memory for occupation
  if (room.isFurnitureOccupied(furniId)) {
    socket.emit("action_failed", {
      action: "sit",
      reason: "This seat is occupied.",
    });
    return;
  }

  // Pathfinding/Interaction Check (uses in-memory state)
  const interactionSpot = furni.getInteractionTile();
  if (!room.isWalkable(interactionSpot.x, interactionSpot.y)) {
    const blockingFurni = room
      .getFurnitureStackAt(interactionSpot.x, interactionSpot.y)
      .find((f) => !f.isWalkable && !f.isFlat);
    const reason = blockingFurni
      ? `Cannot reach seat (blocked by ${blockingFurni.name}).`
      : `Cannot reach seat (blocked).`;
    socket.emit("action_failed", { action: "sit", reason: reason });
    return;
  }

  const currentX = Math.round(avatar.x);
  const currentY = Math.round(avatar.y);
  // Action stores the furniture's persistent DB ID (_id string)
  const sitAction = { type: "sit", targetId: furniId };

  if (currentX === interactionSpot.x && currentY === interactionSpot.y) {
    // Already at the spot, execute sit using the in-memory instance
    if (avatar.executeSit(furni, room)) {
      // executeSit stores the furniId string
      io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM
    } else {
      socket.emit("action_failed", {
        action: "sit",
        reason: "Failed to sit (internal error).",
      });
    }
  } else {
    // Need to walk, defer action (which contains the DB ID)
    if (
      avatar.moveTo(
        interactionSpot.x,
        interactionSpot.y,
        room,
        sitAction,
        handleChangeRoom
      )
    ) {
      io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast walk start TO THE ROOM
    } else {
      socket.emit("action_failed", {
        action: "sit",
        reason: "Cannot find path to seat.",
      });
    }
  }
}

// --- Request Stand Handler ---
function handleRequestStand(socket) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room) return;

  if (avatar.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", {
      action: "stand",
      reason: "You are not sitting.",
    });
    return;
  }

  // executeStand uses room's in-memory state to find walkable spot
  // It uses the stored furniId (DB ID string) to find the chair instance
  if (avatar.executeStand(room)) {
    io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM
  } else {
    socket.emit("action_failed", {
      action: "stand",
      reason: "Failed to stand (internal error).",
    });
  }
}

// --- Request User List Handler ---
function handleRequestUserList(socket) {
  const { room } = getAvatarAndRoom(socket.id);
  if (room) {
    // Send list for the user's current room
    socket.emit("user_list_update", room.getUserList());
  } else {
    // User not properly associated with a room
    console.warn(
      `Cannot send user list: Socket ${socket.id} not associated with a room.`
    );
    socket.emit("user_list_update", []); // Send empty list
  }
}

// --- Request Profile Handler ---
function handleRequestProfile(socket, data) {
  // Profile is global, find user across rooms using runtime ID
  const requesterInfo = getAvatarAndRoom(socket.id);
  if (!requesterInfo.avatar || !data || data.avatarId == null) return;

  let targetAvatar = null;
  const targetAvatarId = String(data.avatarId); // Target is runtime ID string

  // Find the target avatar across all rooms by runtime ID
  for (const r of rooms.values()) {
    if (r && r.avatars && typeof r.avatars === "object") {
      targetAvatar = Object.values(r.avatars).find(
        (a) => a && String(a.id) === targetAvatarId
      );
      if (targetAvatar) break;
    }
  }

  if (targetAvatar) {
    console.log(
      `${requesterInfo.avatar.name} requested profile for ${
        targetAvatar.name
      } (in room ${targetAvatar.roomId || "unknown"})`
    );
    socket.emit("show_profile", targetAvatar.toProfileDTO()); // Send profile DTO
  } else {
    socket.emit("action_failed", {
      action: "profile",
      reason: "User not found online.",
    });
  }
}

// --- Use Furniture Handler (ASYNC) ---
async function handleRequestUseFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId); // Ensure DB ID is string
  const furni = room.getFurnitureById(furniId); // Find in room memory

  if (!furni) {
    socket.emit("action_failed", {
      action: "use",
      reason: "Item not found in room.",
    });
    return;
  }
  if (!furni.canUse) {
    socket.emit("action_failed", {
      action: "use",
      reason: "Cannot use this item.",
    });
    return;
  }

  // Optional distance check (using in-memory positions)
  // const interactionTile = furni.getInteractionTile();
  // const distSq = (avatar.x - interactionTile.x)**2 + (avatar.y - interactionTile.y)**2;
  // if (distSq > 4) { ... return; }

  // 1. Perform Use Action (updates in-memory state, returns changes)
  const useResult = furni.use(avatar, room); // Gets { changed, updatePayload }

  // 2. If state changed, update Database
  if (useResult.changed && useResult.updatePayload) {
    try {
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId, // DB ID string
        { $set: useResult.updatePayload }, // Apply changes (state, z)
        { new: false } // Don't need doc back
      );
      if (!updatedDoc) {
        throw new Error(
          "Furniture document not found in DB during 'use' update."
        );
      }
      console.log(
        `[${room.id}] ${avatar.name} used ${furni.name} (ID:${
          furni.id
        }). New State: ${furni.state}, Z: ${furni.z.toFixed(2)}`
      );

      // 3. Broadcast the update payload TO THE ROOM
      io.to(room.id).emit("furni_updated", {
        id: furni.id,
        ...useResult.updatePayload,
      });
    } catch (dbError) {
      console.error(`DB Error using furniture ${furniId}:`, dbError);
      socket.emit("action_failed", {
        action: "use",
        reason: "Server error using item.",
      });
      // Attempt to rollback in-memory change? Or log and leave inconsistent?
      // For simplicity, log error. State might be temporarily out of sync if DB fails.
    }
  } else {
    // No state change occurred in memory
    console.log(
      `[${room.id}] ${avatar.name} used ${furni.name} (ID:${furni.id}), but state/Z did not change.`
    );
  }
}

// --- Recolor Furniture Handler (ASYNC) ---
async function handleRequestRecolorFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  // Validate request
  if (
    !avatar ||
    !room ||
    !data ||
    data.furniId == null ||
    data.colorHex === undefined
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Invalid request data.",
    });
    return;
  }
  const furniId = String(data.furniId); // Ensure DB ID is string
  const furni = room.getFurnitureById(furniId); // Find in room memory

  if (!furni) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Item not found in room.",
    });
    return;
  }
  // Ownership check
  const clientInfo = clients[socket.id];
  if (furni.ownerId !== null && String(furni.ownerId) !== clientInfo?.userId) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "You don't own this item.",
    });
    return;
  }
  // Capability check
  if (!furni.canRecolor) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "This item cannot be recolored.",
    });
    return;
  }
  // Color validation
  const targetColor = data.colorHex; // Can be string, null, or ""
  if (
    targetColor &&
    typeof targetColor === "string" &&
    !SHARED_CONFIG.VALID_RECOLOR_HEX.includes(targetColor.toUpperCase())
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: `Invalid color: ${targetColor}`,
    });
    return;
  }

  // TODO: Add cost check/consumption if using dye items

  // 1. Perform Recolor Action (updates in-memory state, returns changes)
  const recolorResult = furni.setColorOverride(targetColor); // Gets { changed, updatePayload }

  // 2. If color changed, update Database
  if (recolorResult.changed && recolorResult.updatePayload) {
    try {
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId, // DB ID string
        { $set: recolorResult.updatePayload }, // Apply change (colorOverride)
        { new: false }
      );
      if (!updatedDoc) {
        throw new Error(
          "Furniture document not found in DB during 'recolor' update."
        );
      }
      const displayColor = furni.colorOverride || "default";
      console.log(
        `[${room.id}] ${avatar.name} recolored ${furni.name} (ID:${furni.id}) to ${displayColor}`
      );

      // 3. Broadcast the update payload TO THE ROOM
      io.to(room.id).emit("furni_updated", {
        id: furni.id,
        ...recolorResult.updatePayload,
      });
      // If dyes were used: socket.emit('inventory_update', avatar.getInventoryDTO());
    } catch (dbError) {
      console.error(`DB Error recoloring furniture ${furniId}:`, dbError);
      socket.emit("action_failed", {
        action: "recolor",
        reason: "Server error recoloring item.",
      });
      // Potential rollback? Log error for now.
    }
  } else {
    // No change was made in memory
    socket.emit("action_failed", {
      action: "recolor",
      reason: "No color change needed.",
    });
  }
}

// --- Buy Item Handler ---
function handleRequestBuyItem(socket, data) {
  // Buying operates on avatar's in-memory state (currency, inventory)
  const { avatar } = getAvatarAndRoom(socket.id);
  if (!avatar || !data || !data.itemId) {
    socket.emit("action_failed", {
      action: "buy",
      reason: "Invalid buy request.",
    });
    return;
  }
  const itemId = data.itemId;

  // 1. Find item in shop catalog
  const shopEntry = SHARED_CONFIG.SHOP_CATALOG.find(
    (entry) => entry.itemId === itemId
  );
  if (!shopEntry) {
    socket.emit("action_failed", {
      action: "buy",
      reason: "Item not available for sale.",
    });
    return;
  }
  // 2. Get furniture definition
  const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
    (def) => def.id === itemId
  );
  if (!definition) {
    console.error(
      `Shop Error: Item ${itemId} in catalog but not in definitions!`
    );
    socket.emit("action_failed", {
      action: "buy",
      reason: "Shop configuration error.",
    });
    return;
  }
  const price = shopEntry.price;
  // 3. Check currency
  if (avatar.currency < price) {
    socket.emit("action_failed", {
      action: "buy",
      reason: `Insufficient gold (Need ${price} G).`,
    });
    return;
  }

  // 4. Perform transaction (operates on avatar's memory)
  if (avatar.removeCurrency(price)) {
    if (avatar.addItem(itemId, 1)) {
      // Success! Notify client
      console.log(
        `${avatar.name} bought ${definition.name} for ${price} gold.`
      );
      socket.emit("currency_update", { currency: avatar.currency });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      socket.emit("chat_message", {
        avatarId: null,
        avatarName: "Server",
        text: `You bought 1x ${definition.name}!`,
        className: "info-msg",
      });
    } else {
      // Failed inventory add, refund currency
      console.error(
        `Buy Error: Failed to add item ${itemId} to ${avatar.name} after taking currency. Refunding.`
      );
      avatar.addCurrency(price); // Refund
      socket.emit("action_failed", {
        action: "buy",
        reason: "Inventory error after purchase (refunded).",
      });
      socket.emit("currency_update", { currency: avatar.currency }); // Send refund update
    }
  } else {
    // Failed currency removal (should be rare after check)
    console.error(
      `Buy Error: Failed to remove currency ${price} from ${avatar.name} even after check.`
    );
    socket.emit("action_failed", {
      action: "buy",
      reason: "Currency transaction error.",
    });
  }
  // Note: Player state (currency/inventory) will be saved on next disconnect or shutdown
}

// --- Room Change Handler ---
// (Operates on in-memory room/avatar state)
function handleChangeRoom(socket, data) {
  const { avatar: currentAvatar, room: currentRoom } = getAvatarAndRoom(
    socket.id
  );
  if (!currentAvatar || !currentRoom || !data || !data.targetRoomId) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: "Invalid request or current state.",
    });
    return;
  }
  const targetRoomId = data.targetRoomId;
  const targetRoom = rooms.get(targetRoomId);

  if (!targetRoom) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: `Room '${targetRoomId}' does not exist.`,
    });
    return;
  }

  // Handle "teleporting" within the same room if IDs match
  if (currentRoom.id === targetRoomId) {
    console.log(
      `handleChangeRoom called for same room (${targetRoomId}) by ${currentAvatar.name}. Teleporting within room.`
    );
    const targetX = data.targetX ?? -1;
    const targetY = data.targetY ?? -1;
    const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);
    // Prepare avatar state (resets path, state, etc.) but keeps same roomId
    currentAvatar.prepareForRoomChange(
      targetRoomId,
      spawnPoint.x,
      spawnPoint.y
    );
    // Update everyone in the room
    io.to(targetRoomId).emit("avatar_update", currentAvatar.toDTO());
    console.log(
      ` -> ${
        currentAvatar.name
      } teleported within room ${targetRoomId} to (${currentAvatar.x.toFixed(
        1
      )}, ${currentAvatar.y.toFixed(1)})`
    );
    return; // Skip full room change logic
  }

  console.log(
    `${currentAvatar.name} attempting to change from room ${currentRoom.id} to ${targetRoomId}`
  );

  // 1. Remove from current room & notify others
  const removed = currentRoom.removeAvatar(socket.id); // Remove from memory map
  if (removed) {
    // Broadcast removal TO OLD ROOM using runtime avatar ID
    io.to(currentRoom.id).emit("avatar_removed", {
      id: String(currentAvatar.id),
    });
    io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
  } else {
    console.warn(
      `handleChangeRoom: Failed to remove avatar ${currentAvatar.id} from room ${currentRoom.id} map.`
    );
  }
  socket.leave(currentRoom.id); // Leave Socket.IO room
  console.log(` -> Left Socket.IO room: ${currentRoom.id}`);

  // 2. Find spawn point in target room
  const targetX = data.targetX ?? -1;
  const targetY = data.targetY ?? -1;
  const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);

  // 3. Prepare avatar state for new room (updates roomId, pos, state)
  currentAvatar.prepareForRoomChange(targetRoomId, spawnPoint.x, spawnPoint.y);

  // 4. Add to new room's memory & join Socket.IO room
  targetRoom.addAvatar(currentAvatar);
  socket.join(targetRoomId);
  console.log(` -> Joined Socket.IO room: ${targetRoomId}`);

  // 5. Send new room state to the client who moved
  socket.emit("room_state", targetRoom.getStateDTO());
  // Re-send client-specific info
  socket.emit("your_avatar_id", String(currentAvatar.id)); // Runtime ID string
  socket.emit("inventory_update", currentAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: currentAvatar.currency });

  // 6. Broadcast arrival TO OTHERS in the new room
  socket.to(targetRoomId).emit("avatar_added", currentAvatar.toDTO());
  // Send user list update TO EVERYONE in the new room
  io.to(targetRoomId).emit("user_list_update", targetRoom.getUserList());

  console.log(
    ` -> ${
      currentAvatar.name
    } successfully changed to room ${targetRoomId} at (${currentAvatar.x.toFixed(
      1
    )}, ${currentAvatar.y.toFixed(1)})`
  );
}

// --- Disconnect Handler (ASYNC) ---
async function handleDisconnect(socket, reason) {
  console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
  const clientInfo = clients[socket.id]; // Get client info before deleting

  // Find avatar and room (using runtime ID)
  let avatar = null;
  let currentRoom = null;
  let userIdToSave = null; // Persistent User ID

  if (clientInfo && clientInfo.userId) {
    userIdToSave = clientInfo.userId;
    if (clientInfo.avatarId !== null) {
      // Check if avatar was ever assigned
      try {
        const findResult = getAvatarAndRoom(socket.id); // Uses runtime ID
        avatar = findResult.avatar;
        currentRoom = findResult.room;
      } catch (e) {
        console.error(
          `Error finding avatar/room during disconnect for ${socket.id}: ${e.message}`
        );
      }
    } else {
      console.log(
        `Disconnect: Socket ${socket.id} (User ${userIdToSave}) had no associated avatarId.`
      );
    }
  } else {
    console.log(
      `Disconnect: Socket ${socket.id} had no associated clientInfo or userId.`
    );
  }

  // --- Save Player Data to User document ---
  if (userIdToSave && avatar && typeof updateUser === "function") {
    try {
      const playerState = {
        currency: avatar.currency,
        inventory: Object.fromEntries(avatar.inventory || new Map()),
        bodyColor: avatar.bodyColor,
        lastRoomId: avatar.roomId, // Current room
        lastX: Math.round(avatar.x), // Current position
        lastY: Math.round(avatar.y),
        lastZ: avatar.z,
      };
      console.log(
        `Saving data for disconnecting user ${userIdToSave} (Avatar ${avatar.id}, Pos: ${playerState.lastX},${playerState.lastY} in ${playerState.lastRoomId})...`
      );
      await updateUser(userIdToSave, playerState); // Await the DB save
      console.log(` -> Data saved successfully for user ${userIdToSave}.`);
    } catch (error) {
      console.error(
        `Error saving data for user ${userIdToSave} on disconnect:`,
        error
      );
    }
  } else if (userIdToSave) {
    console.warn(
      `Disconnect: Could not save state for user ${userIdToSave}, avatar object unavailable.`
    );
  }
  // --- End Save Player Data ---

  // Remove avatar from the in-memory game world
  if (avatar && currentRoom) {
    const removed = currentRoom.removeAvatar(socket.id); // Remove from room memory map
    if (removed) {
      // Broadcast removal TO THAT ROOM using runtime avatar ID
      io.to(currentRoom.id).emit("avatar_removed", { id: String(avatar.id) });
      console.log(
        `Avatar ${avatar.name} (ID:${avatar.id}) removed from room ${currentRoom.id}.`
      );
      // Update user list FOR THAT ROOM
      io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
    } else {
      console.warn(
        `Disconnect: Avatar ${avatar.id} not found in room ${currentRoom.id} map during removal.`
      );
    }
  }

  // Socket.IO automatically handles leaving rooms on disconnect.

  // Finally, remove from the global client tracking map
  if (clients[socket.id]) {
    delete clients[socket.id];
  }
}

// --- Connect Error Handler ---
// Simple wrapper around disconnect
function handleConnectError(socket, err) {
  console.error(
    `Socket connect_error for ${socket?.id || "unknown"}: ${err.message}`
  );
  const socketId = socket?.id || `unknown_error_${Date.now()}`;
  // Call the async disconnect handler (fire and forget, no await needed here)
  handleDisconnect(
    socket || { id: socketId },
    `Connection error: ${err.message}`
  );
}

// --- Export handlers ---
module.exports = {
  initializeHandlers,
  handleConnection, // Async
  // Expose room change handler for console commands or other modules
  handleChangeRoom,
};
