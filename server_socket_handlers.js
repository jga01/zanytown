"use strict";

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const { ServerAvatar, ServerFurniture } = require("./lib/game_objects");
const { rotateDirection, escapeHtml } = require("./lib/utils"); // Added escapeHtml
const Furniture = require("./models/furniture"); // Database model
const User = require("./models/user"); // Import User model (needed in handleConnection)
const { findAvatarGlobally } = require("./server_console"); // For admin commands
const RoomState = require("./models/roomState");
const ServerRoom = require("./lib/room");

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
  rooms = roomsMap;
  io = ioInstance;
  clients = clientsMap;
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
function getAvatarAndRoom(socketId) {
  const clientInfo = clients[socketId];
  if (!clientInfo || clientInfo.avatarId == null) {
    return { avatar: null, room: null, socket: clientInfo?.socket };
  }
  const avatarId = clientInfo.avatarId; // Runtime ID

  let avatar = null;
  let roomId = null;
  for (const [id, r] of rooms.entries()) {
    if (r && r.avatars && typeof r.avatars === "object") {
      avatar = Object.values(r.avatars).find((a) => a && a.id === avatarId);
      if (avatar) {
        roomId = id;
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
    return { avatar: null, room: null, socket: clientInfo.socket };
  }

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

  return { avatar, room, socket: clientInfo.socket };
}

// --- NEW: Handler for Room List Request ---
function handleRequestPublicRooms(socket) {
  // No specific permissions needed to request the list
  const roomListData = [];
  const sortedRoomIds = Array.from(rooms.keys()).sort(); // Sort alphabetically

  sortedRoomIds.forEach((roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      // For now, list all rooms. Add filtering logic here later if needed (e.g., public/private flags)
      roomListData.push({
        id: roomId,
        playerCount: room.getUserList().length, // Get current player count
      });
    }
  });

  console.log(
    `Socket ${socket.id} requested room list. Sending ${roomListData.length} rooms.`
  );
  socket.emit("public_rooms_update", roomListData);
}
// --- END NEW HANDLER ---

// --- Event Handler Functions ---

// --- Connection Handler (ASYNC due to DB read) ---
async function handleConnection(socket) {
  console.log(`Client connected: ${socket.id}, UserID: ${socket.userId}`);
  clients[socket.id] = {
    socket: socket,
    avatarId: null,
    userId: socket.userId,
  };
  socket.isAdmin = false;

  let userData;
  try {
    if (!findUserById)
      throw new Error("findUserById DB function not initialized.");
    userData = await findUserById(socket.userId);
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
    if (clients[socket.id]) delete clients[socket.id];
    return;
  }

  let spawnRoomId = userData.lastRoomId || SERVER_CONFIG.DEFAULT_ROOM_ID;
  let room = rooms.get(spawnRoomId);

  if (!room) {
    console.warn(
      `User ${socket.userId}'s target room '${spawnRoomId}' not found! Spawning in default (${SERVER_CONFIG.DEFAULT_ROOM_ID}).`
    );
    spawnRoomId = SERVER_CONFIG.DEFAULT_ROOM_ID;
    room = rooms.get(spawnRoomId);
    if (!room) {
      console.error(
        `FATAL: Default room '${SERVER_CONFIG.DEFAULT_ROOM_ID}' not found! Cannot spawn player ${socket.userId}.`
      );
      socket.emit("auth_error", "Default game room is unavailable.");
      socket.disconnect(true);
      if (clients[socket.id]) delete clients[socket.id];
      return;
    }
  }

  const spawnPoint = room.findSpawnPoint(userData.lastX, userData.lastY);
  console.log(
    `Spawning ${userData.username} in ${room.id} at (${spawnPoint.x}, ${spawnPoint.y}) (Preferred: ${userData.lastX}, ${userData.lastY})`
  );

  if (!ServerAvatar || !ServerFurniture) {
    console.error(
      "FATAL: Server game object classes not loaded. Cannot create avatar."
    );
    socket.emit("auth_error", "Server error during player initialization.");
    socket.disconnect(true);
    if (clients[socket.id]) delete clients[socket.id];
    return;
  }

  const newAvatar = new ServerAvatar(
    spawnPoint.x,
    spawnPoint.y,
    userData.username || `User_${socket.id.substring(0, 4)}`,
    socket.id
  );
  newAvatar.isAdmin = socket.isAdmin;
  newAvatar.currency = userData.currency ?? SHARED_CONFIG.DEFAULT_CURRENCY;
  newAvatar.inventory = new Map(Object.entries(userData.inventory || {}));
  newAvatar.bodyColor = userData.bodyColor || "#6CA0DC";
  newAvatar.z = userData.lastZ ?? SHARED_CONFIG.AVATAR_DEFAULT_Z;
  newAvatar.roomId = room.id;

  clients[socket.id].avatarId = newAvatar.id; // Store runtime ID

  socket.emit("your_persistent_id", String(userData._id));

  socket.join(room.id);
  console.log(`Socket ${socket.id} joined Socket.IO room: ${room.id}`);

  room.addAvatar(newAvatar);
  console.log(
    `Avatar ${newAvatar.name} (RuntimeID:${newAvatar.id}, UserID: ${socket.userId}) added to room ${room.id} state.`
  );

  socket.emit("room_state", room.getStateDTO());
  socket.emit("your_avatar_id", String(newAvatar.id));
  socket.emit("inventory_update", newAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: newAvatar.currency });

  socket.to(room.id).emit("avatar_added", newAvatar.toDTO());
  console.log(
    ` -> Broadcast 'avatar_added' for ${newAvatar.name} to room ${room.id}.`
  );

  io.to(room.id).emit("user_list_update", room.getUserList());

  // Attach Event Listeners
  socket.on("request_move", (data) => handleRequestMove(socket, data));
  socket.on("send_chat", (message) => handleSendChat(socket, message));
  socket.on("request_place_furni", (data) =>
    handleRequestPlaceFurni(socket, data)
  );
  socket.on("request_rotate_furni", (data) =>
    handleRequestRotateFurni(socket, data)
  );
  socket.on("request_pickup_furni", (data) =>
    handleRequestPickupFurni(socket, data)
  );
  socket.on("request_sit", (data) => handleRequestSit(socket, data));
  socket.on("request_stand", () => handleRequestStand(socket));
  socket.on("request_user_list", () => handleRequestUserList(socket));
  socket.on("request_profile", (data) => handleRequestProfile(socket, data));
  socket.on("request_use_furni", (data) => handleRequestUseFurni(socket, data));
  socket.on("request_recolor_furni", (data) =>
    handleRequestRecolorFurni(socket, data)
  );
  socket.on("request_buy_item", (data) => handleRequestBuyItem(socket, data));
  socket.on("request_change_room", (data) => handleChangeRoom(socket, data));
  socket.on("request_create_room", (data) =>
    handleRequestCreateRoom(socket, data)
  );
  socket.on("request_modify_layout", (data) =>
    handleRequestModifyLayout(socket, data)
  );
  socket.on("request_all_room_ids", () => handleRequestAllRoomIds(socket));
  socket.on("request_public_rooms", () => handleRequestPublicRooms(socket)); // Added listener
  socket.on("disconnect", (reason) => handleDisconnect(socket, reason));
  socket.on("connect_error", (err) => handleConnectError(socket, err));
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

  if (!room.isWalkable(endX, endY)) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Cannot walk there.",
    });
    if (avatar.state === SHARED_CONFIG.AVATAR_STATE_WALKING) {
      // Stop path if walking towards invalid target
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

  if (avatar.moveTo(endX, endY, room, null, handleChangeRoom)) {
    // Pass room change handler
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

// --- Send Chat Handler (with Sanitization) ---
function handleSendChat(socket, message) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || typeof message !== "string") {
    console.warn(
      `handleSendChat: Invalid conditions - Avatar: ${!!avatar}, Room: ${!!room}, Message Type: ${typeof message}`
    );
    return;
  }
  const trimmedMessage = message.trim().substring(0, 150);
  const safeMessage = escapeHtml(trimmedMessage);
  if (!safeMessage) return;

  if (safeMessage.startsWith("/")) {
    const commandParts = trimmedMessage.substring(1).split(" ");
    const command = commandParts[0].toLowerCase();
    const rawArgs = commandParts.slice(1);
    console.log(
      `[${room.id}] ${avatar.name} issued command: /${command} ${rawArgs.join(
        " "
      )}`
    );

    let updateNeeded = false;
    let broadcastUpdate = true;
    let isAdminCommand = false;
    const adminCommands = [
      "kick",
      "give",
      "givegold",
      "teleport",
      "announce",
      "admin",
    ];
    if (adminCommands.includes(command)) {
      isAdminCommand = true;
      if (!socket.isAdmin) {
        socket.emit("action_failed", {
          action: "command",
          reason: "Admin permission required for this command.",
        });
        return;
      }
    }

    switch (command) {
      // Emotes
      case "wave":
      case "dance":
      case "happy":
      case "sad":
        if (SHARED_CONFIG.EMOTE_DEFINITIONS[command]) {
          if (avatar.executeEmote(command, io)) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "emote",
              reason: `Cannot ${command} right now`,
            });
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: `Unknown command: /${escapeHtml(command)}`,
          });
          broadcastUpdate = false;
        }
        break;
      case "emote":
        const emoteId = rawArgs[0]?.toLowerCase();
        if (emoteId && SHARED_CONFIG.EMOTE_DEFINITIONS[emoteId]) {
          if (avatar.executeEmote(emoteId, io)) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "emote",
              reason: `Cannot perform emote '${escapeHtml(emoteId)}' right now`,
            });
        } else {
          const validEmotes = escapeHtml(
            Object.keys(SHARED_CONFIG.EMOTE_DEFINITIONS || {}).join(", ")
          );
          socket.emit("action_failed", {
            action: "emote",
            reason: `Usage: /emote <emote_id>. Valid: ${validEmotes}`,
          });
          broadcastUpdate = false;
        }
        break;
      // Appearance
      case "setcolor":
        if (rawArgs.length === 1) {
          if (avatar.setBodyColor(rawArgs[0])) updateNeeded = true;
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
      // Navigation
      case "join":
        if (rawArgs.length === 1) {
          const targetRoomId = rawArgs[0];
          if (typeof handleChangeRoom === "function")
            handleChangeRoom(socket, { targetRoomId });
          else {
            console.error(
              "handleChangeRoom function is not available in socket handlers!"
            );
            socket.emit("action_failed", {
              action: "command",
              reason: "Room changing is currently unavailable.",
            });
          }
          updateNeeded = false;
          broadcastUpdate = false;
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: "Usage: /join <room_id>",
          });
          broadcastUpdate = false;
        }
        break;
      // Debugging
      case "myroom":
        socket.emit("chat_message", {
          avatarId: null,
          avatarName: "Server",
          text: `You are in room: ${escapeHtml(avatar.roomId || "Unknown")}`,
          className: "info-msg",
        });
        updateNeeded = false;
        broadcastUpdate = false;
        break;
      // Admin Commands
      case "admin":
        if (rawArgs.length > 0) {
          const rawAdminMsg = rawArgs.join(" ");
          const safeAdminMsg = escapeHtml(rawAdminMsg.substring(0, 200));
          io.emit("chat_message", {
            avatarId: null,
            avatarName: "Admin",
            text: `[${escapeHtml(avatar.name)}]: ${safeAdminMsg}`,
            className: "admin-msg",
          });
          console.log(`Admin ${avatar.name} broadcast: ${rawAdminMsg}`);
        } else
          socket.emit("action_failed", {
            action: "command",
            reason: "Usage: /admin <message>",
          });
        return; // Exit after handling
      case "announce":
        if (rawArgs.length > 0) {
          const rawAnnounceMsg = rawArgs.join(" ");
          const safeAnnounceMsg = escapeHtml(rawAnnounceMsg.substring(0, 200));
          console.log(
            `ADMIN ACTION: ${avatar.name} announced: ${rawAnnounceMsg}`
          );
          io.emit("chat_message", {
            avatarId: null,
            avatarName: "Announcement",
            text: safeAnnounceMsg,
            className: "announcement-msg",
          });
        } else
          socket.emit("action_failed", {
            action: "announce",
            reason: "Usage: /announce <message>",
          });
        break;
      case "kick":
        if (rawArgs.length === 1) {
          const targetNameKick = rawArgs[0];
          const { avatar: targetAvatarKick } =
            findAvatarGlobally(targetNameKick);
          if (targetAvatarKick && clients[targetAvatarKick.socketId]) {
            console.log(
              `ADMIN ACTION: ${avatar.name} kicking user ${targetAvatarKick.name}...`
            );
            clients[targetAvatarKick.socketId].socket.emit(
              "force_disconnect",
              `Kicked by admin ${escapeHtml(avatar.name)}`
            );
            clients[targetAvatarKick.socketId].socket.disconnect(true);
            io.emit("chat_message", {
              avatarName: "Server",
              text: `${escapeHtml(
                targetAvatarKick.name
              )} was kicked by ${escapeHtml(avatar.name)}.`,
              className: "server-msg",
            });
          } else
            socket.emit("action_failed", {
              action: "kick",
              reason: `User '${escapeHtml(targetNameKick)}' not found online.`,
            });
        } else
          socket.emit("action_failed", {
            action: "kick",
            reason: "Usage: /kick <username>",
          });
        break;
      case "teleport":
        if (rawArgs.length >= 3) {
          const targetNameTp = rawArgs[0];
          let destRoomIdTp = room.id;
          let targetXTp, targetYTp;
          if (rawArgs.length === 3) {
            targetXTp = parseInt(rawArgs[1], 10);
            targetYTp = parseInt(rawArgs[2], 10);
          } else {
            destRoomIdTp = rawArgs[1];
            targetXTp = parseInt(rawArgs[2], 10);
            targetYTp = parseInt(rawArgs[3], 10);
          }
          const { avatar: targetAvatarTp } = findAvatarGlobally(targetNameTp);
          const destRoomTp = rooms.get(destRoomIdTp);
          if (!targetAvatarTp)
            socket.emit("action_failed", {
              action: "teleport",
              reason: `User '${escapeHtml(targetNameTp)}' not found.`,
            });
          else if (!destRoomTp)
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Destination room '${escapeHtml(
                destRoomIdTp
              )}' not found.`,
            });
          else if (isNaN(targetXTp) || isNaN(targetYTp))
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Invalid coordinates.`,
            });
          else if (!destRoomTp.isValidTile(targetXTp, targetYTp))
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Cannot teleport: Target tile (${targetXTp}, ${targetYTp}) in room ${escapeHtml(
                destRoomIdTp
              )} is invalid terrain.`,
            });
          else {
            console.log(
              `ADMIN ACTION: ${avatar.name} teleporting ${targetAvatarTp.name}...`
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
                text: `Teleported ${escapeHtml(
                  targetAvatarTp.name
                )} to ${escapeHtml(destRoomIdTp)}(${targetXTp}, ${targetYTp}).`,
                className: "info-msg",
              });
            } else
              socket.emit("action_failed", {
                action: "teleport",
                reason: `Cannot teleport: Socket for ${escapeHtml(
                  targetNameTp
                )} not found or internal error.`,
              });
          }
        } else
          socket.emit("action_failed", {
            action: "teleport",
            reason: "Usage: /teleport <user> [room] <x> <y>",
          });
        break;
      case "give":
        if (rawArgs.length >= 2) {
          const targetNameGive = rawArgs[0];
          const itemIdGive = rawArgs[1];
          const quantityGive = rawArgs[2] ? parseInt(rawArgs[2], 10) : 1;
          const { avatar: targetAvatarGive } =
            findAvatarGlobally(targetNameGive);
          if (!targetAvatarGive)
            socket.emit("action_failed", {
              action: "give",
              reason: `User '${escapeHtml(targetNameGive)}' not found.`,
            });
          else if (isNaN(quantityGive) || quantityGive <= 0)
            socket.emit("action_failed", {
              action: "give",
              reason: `Invalid quantity.`,
            });
          else {
            const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
              (def) => def.id === itemIdGive
            );
            if (!definition)
              socket.emit("action_failed", {
                action: "give",
                reason: `Invalid item ID '${escapeHtml(itemIdGive)}'.`,
              });
            else if (targetAvatarGive.addItem(itemIdGive, quantityGive)) {
              console.log(
                `ADMIN ACTION: ${avatar.name} gave ${quantityGive}x ${definition.name} to ${targetAvatarGive.name}.`
              );
              socket.emit("chat_message", {
                avatarName: "Server",
                text: `Gave ${quantityGive}x ${escapeHtml(
                  definition.name
                )} to ${escapeHtml(targetAvatarGive.name)}.`,
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
                  text: `Admin ${escapeHtml(
                    avatar.name
                  )} gave you ${quantityGive}x ${escapeHtml(definition.name)}!`,
                  className: "server-msg",
                });
              }
            } else
              socket.emit("action_failed", {
                action: "give",
                reason: `Failed to give item (internal error?).`,
              });
          }
        } else
          socket.emit("action_failed", {
            action: "give",
            reason: "Usage: /give <user> <item_id> [quantity]",
          });
        break;
      case "givegold":
        if (rawArgs.length === 2) {
          const targetNameGold = rawArgs[0];
          const amountGold = parseInt(rawArgs[1], 10);
          const { avatar: targetAvatarGold } =
            findAvatarGlobally(targetNameGold);
          if (!targetAvatarGold)
            socket.emit("action_failed", {
              action: "givegold",
              reason: `User '${escapeHtml(targetNameGold)}' not found.`,
            });
          else if (isNaN(amountGold) || amountGold <= 0)
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Invalid amount.`,
            });
          else if (targetAvatarGold.addCurrency(amountGold)) {
            console.log(
              `ADMIN ACTION: ${avatar.name} gave ${amountGold} Gold to ${targetAvatarGold.name}.`
            );
            socket.emit("chat_message", {
              avatarName: "Server",
              text: `Gave ${amountGold} Gold to ${escapeHtml(
                targetAvatarGold.name
              )}.`,
              className: "info-msg",
            });
            const targetSock = clients[targetAvatarGold.socketId]?.socket;
            if (targetSock) {
              targetSock.emit("currency_update", {
                currency: targetAvatarGold.currency,
              });
              targetSock.emit("chat_message", {
                avatarName: "Server",
                text: `Admin ${escapeHtml(
                  avatar.name
                )} gave you ${amountGold} Gold!`,
                className: "server-msg",
              });
            }
          } else
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Failed to give gold (internal error?).`,
            });
        } else
          socket.emit("action_failed", {
            action: "givegold",
            reason: "Usage: /givegold <user> <amount>",
          });
        break;
      // Default
      default:
        if (!isAdminCommand)
          socket.emit("action_failed", {
            action: "command",
            reason: `Unknown command: /${escapeHtml(command)}`,
          });
        updateNeeded = false;
        broadcastUpdate = false;
    }
    if (updateNeeded && broadcastUpdate) {
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    }
  } else {
    // Regular Chat Message
    console.log(`[${room.id}] Chat from ${avatar.name}: ${trimmedMessage}`);
    io.to(room.id).emit("chat_message", {
      avatarId: String(avatar.id),
      avatarName: escapeHtml(avatar.name),
      text: safeMessage,
      isAdmin: avatar.isAdmin,
      className: avatar.isAdmin ? "admin-msg" : "",
    });
  }
} // --- End handleSendChat ---

// --- Place Furniture Handler (ASYNC with Rollback Logic) ---
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

  // --- Placement Validation ---
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    width: definition.width || 1,
    height: definition.height || 1,
    // Mimic getOccupiedTiles by adding the definition context it needs internally
    definition: definition,
  };

  // Call getOccupiedTiles with the correct context
  const occupiedTiles =
    ServerFurniture.prototype.getOccupiedTiles.call(tempFurniProto);

  const placeZ =
    room.getStackHeightAt(gridX, gridY) + (definition.zOffset || 0); // Calculate Z needed for validation AND saving

  for (const tile of occupiedTiles) {
    if (!room.isValidTile(tile.x, tile.y)) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot place on invalid tile (${tile.x},${tile.y}).`,
      });
      return;
    }
    if (!definition.isFlat) {
      // Check stackability/solids only if placing a non-flat item
      const baseStackTile = room.getFurnitureStackAt(tile.x, tile.y);
      const topItemOnThisTile = baseStackTile.sort((a, b) => b.z - a.z)[0];
      if (topItemOnThisTile && !topItemOnThisTile.stackable) {
        socket.emit("action_failed", {
          action: "place",
          reason: `Cannot stack on '${topItemOnThisTile.name}'.`,
        });
        return;
      }
      if (room.isTileOccupiedBySolid(tile.x, tile.y)) {
        // Check for solid blockers
        const solidBlocker = baseStackTile.find(
          (f) => !f.isWalkable && !f.isFlat && !f.stackable
        );
        if (solidBlocker) {
          socket.emit("action_failed", {
            action: "place",
            reason: `Tile blocked by solid '${solidBlocker.name}'.`,
          });
          return;
        }
      }
    }
  }
  // Check base tile stackability if not flat
  if (!definition.isFlat) {
    const baseStack = room.getFurnitureStackAt(gridX, gridY);
    const topItemOnBase = baseStack.sort((a, b) => b.z - a.z)[0];
    if (topItemOnBase && !topItemOnBase.stackable) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot stack on '${topItemOnBase.name}'.`,
      });
      return;
    }
  }
  // Check height limit
  // Calculate the top surface Z of the new item
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = placeZ + (definition.isFlat ? 0 : itemStackContrib);

  // Compare the *top* of the item against the max stack height
  const epsilon = 0.001;
  if (itemTopZ >= SHARED_CONFIG.MAX_STACK_Z - epsilon) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Stack height limit reached.`,
    });
    return;
  }
  // --- End Validation ---

  // --- Place Item Transaction (Reordered) ---
  let savedDocument;
  try {
    // 1. Create in Database First
    const newFurniData = {
      roomId: room.id,
      definitionId: definition.id,
      x: gridX,
      y: gridY,
      z: placeZ,
      rotation: rotation,
      ownerId: clients[socket.id]?.userId || null,
      state: definition.defaultState,
      colorOverride: null,
    };
    savedDocument = await Furniture.create(newFurniData);
    if (!savedDocument || !savedDocument._id)
      throw new Error("DB create failed or returned invalid doc.");
    console.log(
      `[DB Create OK] Room ${room.id}: ${definition.name} (ID: ${savedDocument._id})`
    );

    // 2. DB Create SUCCEEDED - Now remove from inventory
    if (avatar.removeItem(data.definitionId, 1)) {
      console.log(
        `[Inv Remove OK] User ${avatar.name}: Removed 1x ${data.definitionId}`
      );
      // 3. Inventory Remove SUCCEEDED - Add to Memory & Broadcast
      try {
        const newFurniInstance = new ServerFurniture(
          definition.id,
          gridX,
          gridY,
          placeZ,
          rotation,
          savedDocument._id.toString(),
          savedDocument.ownerId,
          savedDocument.state,
          savedDocument.colorOverride
        );
        room.addFurniture(newFurniInstance);
        console.log(
          `[Mem Add OK] Room ${room.id}: Added ${definition.name} (ID:${newFurniInstance.id})`
        );
        io.to(room.id).emit("furni_added", newFurniInstance.toDTO());
        socket.emit("inventory_update", avatar.getInventoryDTO());
        console.log(
          `[Place Success] Broadcasted furni_added for ${newFurniInstance.id}`
        );
      } catch (memError) {
        console.error(
          `CRITICAL ERROR: Failed to create ServerFurniture instance ${savedDocument._id} AFTER DB create & inventory removal!`,
          memError
        );
        socket.emit("action_failed", {
          action: "place",
          reason: "Critical server error after placement.",
        });
      }
    } else {
      // Inventory Remove FAILED (after DB create succeeded) - CRITICAL!
      console.error(
        `CRITICAL ERROR: Failed to remove item ${data.definitionId} from ${avatar.name}'s inventory AFTER creating DB document ${savedDocument._id}! Attempting DB compensation.`
      );
      try {
        await Furniture.findByIdAndDelete(savedDocument._id);
        console.log(`[COMPENSATION] Deleted DB document ${savedDocument._id}.`);
      } catch (deleteError) {
        console.error(
          `[COMPENSATION FAILED] Could not delete DB document ${savedDocument._id}! Manual cleanup needed.`,
          deleteError
        );
      }
      socket.emit("action_failed", {
        action: "place",
        reason: "Inventory error occurred after saving (Rolled back).",
      });
      socket.emit("inventory_update", avatar.getInventoryDTO()); // Resync client
    }
  } catch (dbError) {
    // DB Create FAILED
    console.error(
      `DB Error placing furniture ${definition.id} for ${avatar.name}:`,
      dbError
    );
    socket.emit("action_failed", {
      action: "place",
      reason: "Server error saving item.",
    });
  }
} // --- End handleRequestPlaceFurni ---

// --- Rotate Furniture Handler (ASYNC) ---
async function handleRequestRotateFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId);
  const furni = room.getFurnitureById(furniId);
  if (!furni) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Item not found.",
    });
    return;
  }

  const clientInfo = clients[socket.id]; // Ownership check
  // Allow Admins to rotate any furniture
  if (
    !socket.isAdmin &&
    furni.ownerId !== null &&
    String(furni.ownerId) !== clientInfo?.userId
  ) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "You don't own this.",
    });
    return;
  }

  const oldRotation = furni.rotation;
  const newRotation = rotateDirection(furni.rotation, 2);
  if (oldRotation === newRotation) return;

  try {
    // 1. Update Database First
    const updatedDoc = await Furniture.findByIdAndUpdate(
      furniId,
      { $set: { rotation: newRotation } },
      { new: false }
    );
    if (!updatedDoc) throw new Error("Doc not found in DB during update.");
    // 2. Update In-Memory Instance
    furni.rotation = newRotation;
    // 3. Broadcast and Update Seated Avatars
    console.log(
      `[${room.id}] ${avatar.name} rotated ${furni.name} (ID:${furni.id}) to ${furni.rotation}`
    );
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      rotation: furni.rotation,
    });
    Object.values(room.avatars).forEach((seatedAvatar) => {
      if (String(seatedAvatar.sittingOnFurniId) === furniId) {
        const oldDir = seatedAvatar.direction;
        seatedAvatar.direction = rotateDirection(furni.sitDir, furni.rotation);
        if (oldDir !== seatedAvatar.direction)
          io.to(room.id).emit("avatar_update", {
            id: String(seatedAvatar.id),
            direction: seatedAvatar.direction,
          });
      }
    });
  } catch (dbError) {
    console.error(`DB Error rotating furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Server error rotating.",
    });
  }
}

// --- Pickup Furniture Handler (ASYNC with Rollback Logic) ---
async function handleRequestPickupFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId);
  const furniInstance = room.getFurnitureById(furniId);
  if (!furniInstance) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Item not found.",
    });
    return;
  }

  // Validation: Ownership (Allow Admins)
  const clientInfo = clients[socket.id];
  if (
    !socket.isAdmin && // Admin check
    furniInstance.ownerId !== null &&
    String(furniInstance.ownerId) !== clientInfo?.userId
  ) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "You don't own this.",
    });
    return;
  }
  // Validation: Items on top
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
  // Validation: Seated users
  if (room.isFurnitureOccupied(furniId)) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Someone is using it.",
    });
    return;
  }
  // --- End Validation ---

  const furniDataForRecreation = furniInstance.toDBSaveObject(); // Snapshot before delete
  const definitionIdToRefund = furniInstance.definitionId;

  try {
    // --- Pickup Transaction ---
    // 1. Delete from Database First
    const deleteResult = await Furniture.findByIdAndDelete(furniId);
    if (!deleteResult) {
      // Item wasn't in DB
      console.warn(
        `[DB Delete NF] Pickup requested for ${furniId}, but not found in DB.`
      );
      if (room.getFurnitureById(furniId)) {
        room.removeFurnitureInstance(furniId);
        io.to(room.id).emit("furni_removed", { id: furniId });
        console.warn(` -> Removed dangling instance ${furniId}.`);
      }
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Item already picked up.",
      });
      return;
    }
    console.log(`[DB Delete OK] Room ${room.id}: Deleted furniture ${furniId}`);

    // 2. Remove from Memory
    const removedInstance = room.removeFurnitureInstance(furniId);
    if (!removedInstance)
      console.error(
        `DB/Memory Inconsistency: Deleted ${furniId} but failed remove from room ${room.id}!`
      );
    else
      console.log(
        `[Mem Remove OK] Room ${room.id}: Removed ${furniId} from memory.`
      );

    // 3. Add to Inventory
    if (avatar.addItem(definitionIdToRefund, 1)) {
      console.log(
        `[Inv Add OK] User ${avatar.name}: Added 1x ${definitionIdToRefund}`
      );
      // 4. Broadcast and Notify Client
      io.to(room.id).emit("furni_removed", { id: furniId });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      console.log(`[Pickup Success] Broadcasted furni_removed for ${furniId}`);
    } else {
      // Inventory Add FAILED - CRITICAL!
      console.error(
        `CRITICAL ERROR: Failed to add item ${definitionIdToRefund} (DB ID: ${furniId}) to ${avatar.name} inventory AFTER DB delete! Attempting DB compensation.`
      );
      try {
        // Add ownerId to the data before recreating
        furniDataForRecreation.ownerId = clientInfo?.userId || null;
        await Furniture.create(furniDataForRecreation);
        console.log(`[COMPENSATION] Re-created DB document for ${furniId}.`);
        // TODO: Need to put the item back into the room's memory as well!
        const recreatedInstance = new ServerFurniture(
          furniDataForRecreation.definitionId,
          furniDataForRecreation.x,
          furniDataForRecreation.y,
          furniDataForRecreation.z,
          furniDataForRecreation.rotation,
          furniId, // Use original ID
          furniDataForRecreation.ownerId,
          furniDataForRecreation.state,
          furniDataForRecreation.colorOverride
        );
        room.addFurniture(recreatedInstance);
        io.to(room.id).emit("furni_added", recreatedInstance.toDTO()); // Notify clients it's back
        console.log(
          `[COMPENSATION] Re-added instance ${furniId} to room memory and broadcasted.`
        );
      } catch (recreateError) {
        console.error(
          `[COMPENSATION FAILED] Could not re-create DB document or memory instance for ${furniId}! Manual cleanup required.`,
          recreateError
        );
      }
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Inventory error after pickup (Attempted rollback).",
      });
    }
  } catch (dbError) {
    // DB Delete FAILED
    console.error(`DB Error picking up furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Server error picking up.",
    });
  } // --- End Pickup Transaction ---
} // --- End handleRequestPickupFurni ---

// --- Request Sit Handler ---
function handleRequestSit(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", { action: "sit", reason: "Already sitting." });
    return;
  }

  const furniId = String(data.furniId);
  const furni = room.getFurnitureById(furniId);
  if (!furni || !furni.canSit) {
    socket.emit("action_failed", { action: "sit", reason: "Cannot sit here." });
    return;
  }
  if (room.isFurnitureOccupied(furniId)) {
    socket.emit("action_failed", { action: "sit", reason: "Seat occupied." });
    return;
  }

  const interactionSpot = furni.getInteractionTile();
  if (!room.isWalkable(interactionSpot.x, interactionSpot.y)) {
    socket.emit("action_failed", {
      action: "sit",
      reason: `Cannot reach seat.`,
    });
    return;
  }

  const currentX = Math.round(avatar.x);
  const currentY = Math.round(avatar.y);
  const sitAction = { type: "sit", targetId: furniId }; // Action stores DB ID

  if (currentX === interactionSpot.x && currentY === interactionSpot.y) {
    // Already at spot
    if (avatar.executeSit(furni, room))
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    else
      socket.emit("action_failed", {
        action: "sit",
        reason: "Failed to sit (internal error).",
      });
  } else {
    // Need to walk
    if (
      avatar.moveTo(
        interactionSpot.x,
        interactionSpot.y,
        room,
        sitAction,
        handleChangeRoom
      )
    )
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    else
      socket.emit("action_failed", {
        action: "sit",
        reason: "Cannot find path.",
      });
  }
}

// --- Request Stand Handler ---
function handleRequestStand(socket) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room) return;
  if (avatar.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", { action: "stand", reason: "Not sitting." });
    return;
  }
  if (avatar.executeStand(room))
    io.to(room.id).emit("avatar_update", avatar.toDTO());
  else
    socket.emit("action_failed", {
      action: "stand",
      reason: "Failed to stand.",
    });
}

// --- Request User List Handler ---
function handleRequestUserList(socket) {
  const { room } = getAvatarAndRoom(socket.id);
  if (room) socket.emit("user_list_update", room.getUserList());
  else socket.emit("user_list_update", []);
}

// --- Request Profile Handler ---
function handleRequestProfile(socket, data) {
  const requesterInfo = getAvatarAndRoom(socket.id);
  if (!requesterInfo.avatar || !data || data.avatarId == null) return;

  let targetAvatar = null;
  const targetAvatarId = String(data.avatarId); // Runtime ID
  for (const r of rooms.values()) {
    if (r && r.avatars) {
      targetAvatar = Object.values(r.avatars).find(
        (a) => a && String(a.id) === targetAvatarId
      );
      if (targetAvatar) break;
    }
  }

  if (targetAvatar) {
    console.log(
      `${requesterInfo.avatar.name} requested profile for ${targetAvatar.name}`
    );
    socket.emit("show_profile", targetAvatar.toProfileDTO());
  } else
    socket.emit("action_failed", {
      action: "profile",
      reason: "User not found online.",
    });
}

// --- Use Furniture Handler (ASYNC) ---
async function handleRequestUseFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furniId = String(data.furniId);
  const furni = room.getFurnitureById(furniId);
  if (!furni) {
    socket.emit("action_failed", { action: "use", reason: "Item not found." });
    return;
  }
  if (!furni.canUse) {
    socket.emit("action_failed", { action: "use", reason: "Cannot use this." });
    return;
  }

  // Optional distance check here if needed

  const useResult = furni.use(avatar, room); // Update memory, get changes

  if (useResult.changed && useResult.updatePayload) {
    try {
      // Update Database
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId,
        { $set: useResult.updatePayload },
        { new: false }
      );
      if (!updatedDoc) throw new Error("Doc not found during 'use' update.");
      console.log(
        `[${room.id}] ${avatar.name} used ${furni.name} (ID:${
          furni.id
        }). New State: ${furni.state}, Z: ${furni.z.toFixed(2)}`
      );
      // Broadcast update payload
      io.to(room.id).emit("furni_updated", {
        id: furni.id,
        ...useResult.updatePayload,
      });
    } catch (dbError) {
      console.error(`DB Error using furniture ${furniId}:`, dbError);
      socket.emit("action_failed", {
        action: "use",
        reason: "Server error using.",
      });
      // Potential rollback needed? Log for now.
    }
  } else {
    /* No state change, no DB update or broadcast needed */
  }
}

// --- Recolor Furniture Handler (ASYNC) ---
async function handleRequestRecolorFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !room ||
    !data ||
    data.furniId == null ||
    data.colorHex === undefined
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Invalid request.",
    });
    return;
  }
  const furniId = String(data.furniId);
  const furni = room.getFurnitureById(furniId);
  if (!furni) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Item not found.",
    });
    return;
  }
  // Ownership check (Allow Admins)
  const clientInfo = clients[socket.id];
  if (
    !socket.isAdmin &&
    furni.ownerId !== null &&
    String(furni.ownerId) !== clientInfo?.userId
  ) {
    socket.emit("action_failed", { action: "recolor", reason: "Not owner." });
    return;
  }
  if (!furni.canRecolor) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Cannot recolor.",
    });
    return;
  }
  // Color validation
  const targetColor = data.colorHex;
  // Allow null/empty string for resetting
  if (
    targetColor !== null &&
    targetColor !== "" &&
    typeof targetColor === "string" &&
    !SHARED_CONFIG.VALID_RECOLOR_HEX.includes(targetColor.toUpperCase())
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: `Invalid color: ${escapeHtml(targetColor)}`,
    });
    return;
  }

  // TODO: Add cost check/consumption if using dye items

  const recolorResult = furni.setColorOverride(targetColor); // Update memory

  if (recolorResult.changed && recolorResult.updatePayload) {
    try {
      // Update Database
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId,
        { $set: recolorResult.updatePayload },
        { new: false }
      );
      if (!updatedDoc)
        throw new Error("Doc not found during 'recolor' update.");
      const displayColor = furni.colorOverride || "default";
      console.log(
        `[${room.id}] ${avatar.name} recolored ${furni.name} (ID:${furni.id}) to ${displayColor}`
      );
      // Broadcast update payload
      io.to(room.id).emit("furni_updated", {
        id: furni.id,
        ...recolorResult.updatePayload,
      });
      // If dyes were used: socket.emit('inventory_update', avatar.getInventoryDTO());
    } catch (dbError) {
      console.error(`DB Error recoloring furniture ${furniId}:`, dbError);
      socket.emit("action_failed", {
        action: "recolor",
        reason: "Server error recoloring.",
      });
    }
  } else {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "No color change needed.",
    });
  }
}

// --- Buy Item Handler ---
function handleRequestBuyItem(socket, data) {
  const { avatar } = getAvatarAndRoom(socket.id);
  if (!avatar || !data || !data.itemId) {
    socket.emit("action_failed", { action: "buy", reason: "Invalid request." });
    return;
  }
  const itemId = data.itemId;
  const shopEntry = SHARED_CONFIG.SHOP_CATALOG.find(
    (entry) => entry.itemId === itemId
  );
  if (!shopEntry) {
    socket.emit("action_failed", {
      action: "buy",
      reason: "Item not for sale.",
    });
    return;
  }
  const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
    (def) => def.id === itemId
  );
  if (!definition) {
    console.error(`Shop Error: Item ${itemId} in catalog but not in defs!`);
    socket.emit("action_failed", {
      action: "buy",
      reason: "Shop config error.",
    });
    return;
  }
  const price = shopEntry.price;
  if (avatar.currency < price) {
    socket.emit("action_failed", {
      action: "buy",
      reason: `Insufficient gold (Need ${price} G).`,
    });
    return;
  }

  if (avatar.removeCurrency(price)) {
    // Transaction (memory)
    if (avatar.addItem(itemId, 1)) {
      // Success
      console.log(
        `${avatar.name} bought ${definition.name} for ${price} gold.`
      );
      socket.emit("currency_update", { currency: avatar.currency });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      socket.emit("chat_message", {
        avatarId: null,
        avatarName: "Server",
        text: `You bought 1x ${escapeHtml(definition.name)}!`,
        className: "info-msg",
      });
    } else {
      // Failed inventory add, refund currency
      console.error(
        `Buy Error: Failed add item ${itemId} to ${avatar.name} after taking currency. Refunding.`
      );
      avatar.addCurrency(price);
      socket.emit("action_failed", {
        action: "buy",
        reason: "Inventory error (refunded).",
      });
      socket.emit("currency_update", { currency: avatar.currency });
    }
  } else {
    // Failed currency removal
    console.error(
      `Buy Error: Failed remove currency ${price} from ${avatar.name}.`
    );
    socket.emit("action_failed", {
      action: "buy",
      reason: "Currency transaction error.",
    });
  }
  // Player state saved on disconnect/shutdown
}

// --- Room Change Handler ---
function handleChangeRoom(socket, data) {
  const { avatar: currentAvatar, room: currentRoom } = getAvatarAndRoom(
    socket.id
  );
  if (!currentAvatar || !currentRoom || !data || !data.targetRoomId) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: "Invalid request.",
    });
    return;
  }

  const targetRoomId = data.targetRoomId;
  const targetRoom = rooms.get(targetRoomId);
  if (!targetRoom) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: `Room '${escapeHtml(targetRoomId)}' does not exist.`,
    });
    return;
  }

  if (currentRoom.id === targetRoomId) {
    // Handle teleport within same room
    console.log(
      `handleChangeRoom: Teleporting ${currentAvatar.name} within room ${targetRoomId}.`
    );
    const targetX = data.targetX ?? -1;
    const targetY = data.targetY ?? -1;
    const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);
    currentAvatar.prepareForRoomChange(
      targetRoomId,
      spawnPoint.x,
      spawnPoint.y
    ); // Reset state but keep roomId
    io.to(targetRoomId).emit("avatar_update", currentAvatar.toDTO()); // Update everyone
    console.log(
      ` -> ${
        currentAvatar.name
      } teleported within ${targetRoomId} to (${currentAvatar.x.toFixed(
        1
      )}, ${currentAvatar.y.toFixed(1)})`
    );
    return;
  }

  console.log(
    `${currentAvatar.name} changing from room ${currentRoom.id} to ${targetRoomId}`
  );
  // 1. Remove from current room & notify
  const removed = currentRoom.removeAvatar(socket.id);
  if (removed) {
    io.to(currentRoom.id).emit("avatar_removed", {
      id: String(currentAvatar.id),
    });
    io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
  } else
    console.warn(
      `handleChangeRoom: Failed remove avatar ${currentAvatar.id} from room ${currentRoom.id}`
    );
  socket.leave(currentRoom.id);
  console.log(` -> Left Socket.IO room: ${currentRoom.id}`);

  // 2. Find spawn point in target room
  const targetX = data.targetX ?? -1;
  const targetY = data.targetY ?? -1;
  const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);

  // 3. Prepare avatar state for new room
  currentAvatar.prepareForRoomChange(targetRoomId, spawnPoint.x, spawnPoint.y);

  // 4. Add to new room & join Socket.IO room
  targetRoom.addAvatar(currentAvatar);
  socket.join(targetRoomId);
  console.log(` -> Joined Socket.IO room: ${targetRoomId}`);

  // 5. Send new state to client
  socket.emit("room_state", targetRoom.getStateDTO());
  socket.emit("your_avatar_id", String(currentAvatar.id));
  socket.emit("inventory_update", currentAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: currentAvatar.currency });

  // 6. Broadcast arrival & user list
  socket.to(targetRoomId).emit("avatar_added", currentAvatar.toDTO());
  io.to(targetRoomId).emit("user_list_update", targetRoom.getUserList());

  console.log(
    ` -> ${
      currentAvatar.name
    } successfully changed to room ${targetRoomId} at (${currentAvatar.x.toFixed(
      1
    )}, ${currentAvatar.y.toFixed(1)})`
  );
}

// --- Admin: Create Room Handler (ASYNC) ---
async function handleRequestCreateRoom(socket, data) {
  const { avatar } = getAvatarAndRoom(socket.id); // Get avatar for permission check
  if (!avatar || !socket.isAdmin) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Permission denied.",
    });
    return;
  }
  if (!data || typeof data.roomId !== "string" || !data.roomId.trim()) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Invalid room ID provided.",
    });
    return;
  }

  const newRoomId = data.roomId.trim().toLowerCase().replace(/\s+/g, "_"); // Sanitize ID
  const requestedCols =
    parseInt(data.cols, 10) || SERVER_CONFIG.DEFAULT_ROOM_COLS;
  const requestedRows =
    parseInt(data.rows, 10) || SERVER_CONFIG.DEFAULT_ROOM_ROWS;
  // Basic dimension validation
  if (
    requestedCols < 5 ||
    requestedCols > 50 ||
    requestedRows < 5 ||
    requestedRows > 50
  ) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Dimensions must be between 5 and 50.",
    });
    return;
  }

  console.log(
    `Admin ${avatar.name} requested creation of room: ${newRoomId} (${requestedCols}x${requestedRows})`
  );

  // Check if room already exists (memory and DB)
  if (rooms.has(newRoomId)) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: `Room '${newRoomId}' already exists in memory.`,
    });
    return;
  }
  try {
    const existingRoom = await RoomState.findOne({ roomId: newRoomId });
    if (existingRoom) {
      socket.emit("action_failed", {
        action: "create_room",
        reason: `Room '${newRoomId}' already exists in database.`,
      });
      return;
    }

    // Create default empty layout (walls around, floor inside)
    const newLayout = Array.from({ length: requestedRows }, (_, y) =>
      Array.from(
        { length: requestedCols },
        (_, x) =>
          y === 0 ||
          y === requestedRows - 1 ||
          x === 0 ||
          x === requestedCols - 1
            ? 1
            : 0 // Wall=1, Floor=0
      )
    );

    // Save to Database
    const newRoomState = new RoomState({
      roomId: newRoomId,
      layout: newLayout,
    });
    await newRoomState.save();
    console.log(` -> Saved new room state for '${newRoomId}' to DB.`);

    // Create and add ServerRoom instance to memory
    const newRoomInstance = new ServerRoom(newRoomId); // Constructor loads default/fallback
    newRoomInstance.layout = newLayout; // Override with the generated layout
    newRoomInstance.cols = requestedCols;
    newRoomInstance.rows = requestedRows;
    newRoomInstance.pathfinder = new (require("./lib/pathfinder"))(
      newRoomInstance
    ); // Re-init pathfinder
    rooms.set(newRoomId, newRoomInstance);
    console.log(` -> Added new room '${newRoomId}' to server memory.`);

    // Send success feedback
    socket.emit("chat_message", {
      avatarName: "Server",
      text: `Room '${newRoomId}' created successfully!`,
      className: "info-msg",
    });

    // Optional: Announce globally?
    // io.emit('chat_message', { avatarName: 'Server', text: `Admin ${avatar.name} created a new room: ${newRoomId}!`, className: 'server-msg' });
  } catch (error) {
    console.error(`Error creating room '${newRoomId}':`, error);
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Server error creating room.",
    });
  }
}

// --- Admin: Modify Layout Handler (ASYNC) ---
async function handleRequestModifyLayout(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !socket.isAdmin) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: "Permission denied.",
    });
    return;
  }
  if (!data || data.x == null || data.y == null || data.type == null) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: "Invalid request data.",
    });
    return;
  }

  const { x, y, type } = data;
  const validTypes = [0, 1, 2, "X"]; // Floor, Wall, AltFloor, Hole

  // Validate coordinates and type
  if (x < 0 || x >= room.cols || y < 0 || y >= room.rows) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: "Coordinates out of bounds.",
    });
    return;
  }
  if (!validTypes.includes(type)) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: `Invalid tile type: ${type}.`,
    });
    return;
  }

  // Prevent modifying tile if an avatar is standing exactly on it? (Optional, can be complex)
  const avatarOnTile = Object.values(room.avatars).find(
    (a) => Math.round(a.x) === x && Math.round(a.y) === y
  );
  if (avatarOnTile && type !== 0 && type !== 2) {
    // If trying to change to non-walkable type under avatar
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: `Cannot modify tile under ${avatarOnTile.name}.`,
    });
    return;
  }
  // Prevent modifying tile if non-flat furniture is based there? (More complex check)
  const furnitureOnTile = room.getFurnitureStackAt(x, y).find((f) => !f.isFlat);
  if (furnitureOnTile && type !== 0 && type !== 2) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: `Cannot modify tile under '${furnitureOnTile.name}'.`,
    });
    return;
  }

  // --- Update Layout ---
  let oldType; // Declare here to be accessible in catch block
  try {
    // 1. Update In-Memory Layout
    oldType = room.layout[y][x];
    if (oldType === type) return; // No change needed

    room.layout[y][x] = type;
    console.log(
      `Admin ${avatar.name} modified layout in ${room.id} at (${x},${y}) from ${oldType} to ${type}.`
    );
    // NOTE: Pathfinder should automatically use the updated layout via its room reference.

    // 2. Update Database (Save the entire layout)
    // Use findOneAndUpdate which is slightly more robust than save() if doc might not exist
    const updatedRoomState = await RoomState.findOneAndUpdate(
      { roomId: room.id },
      { $set: { layout: room.layout } },
      { new: false } // Don't need the updated doc back here
    );
    if (!updatedRoomState) {
      // This case shouldn't happen if the room exists in memory, but handle defensively
      console.error(
        `Consistency Error: Room ${room.id} modified in memory, but not found in RoomState DB for saving!`
      );
      // Attempt to rollback memory change
      room.layout[y][x] = oldType;
      socket.emit("action_failed", {
        action: "modify_layout",
        reason: "Server consistency error saving layout.",
      });
      return;
    }
    console.log(` -> Saved updated layout for '${room.id}' to DB.`);

    // 3. Broadcast Specific Tile Update
    io.to(room.id).emit("layout_tile_update", { x, y, type });

    // Optional: Check if any avatars are now "stuck" on a non-walkable tile
    // and maybe nudge them? (Adds complexity)
    // checkAndNudgeStuckAvatars(room, x, y, type);
  } catch (error) {
    console.error(
      `Error modifying layout for room '${room.id}' at (${x},${y}):`,
      error
    );
    // Attempt rollback in memory if DB failed and oldType was captured
    try {
      if (oldType !== undefined) {
        // Check if oldType was set before error
        room.layout[y][x] = oldType;
        console.log(
          ` -> Rolled back memory change for tile (${x},${y}) in room ${room.id}.`
        );
      }
    } catch (rollbackError) {
      console.error(
        ` -> Failed to rollback memory layout change for tile (${x},${y}) in room ${room.id}:`,
        rollbackError
      );
    }
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: "Server error saving layout change.",
    });
  }
}

// --- Admin: Request All Room IDs Handler ---
function handleRequestAllRoomIds(socket) {
  // Check if user is admin (using the flag set during connection)
  if (!socket.isAdmin) {
    console.warn(
      `Socket ${socket.id} attempted to request room IDs without admin privileges.`
    );
    socket.emit("action_failed", {
      action: "list_rooms",
      reason: "Permission denied.",
    });
    return;
  }

  // Get room IDs from the global 'rooms' map
  const roomIds = Array.from(rooms.keys()).sort(); // Get keys (IDs) and sort them

  console.log(
    `Admin ${socket.id} requested room list. Sending ${roomIds.length} IDs.`
  );

  // Emit the list back to the requesting client ONLY
  socket.emit("all_room_ids_update", roomIds);
}

// --- Disconnect Handler (ASYNC) ---
async function handleDisconnect(socket, reason) {
  console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
  const clientInfo = clients[socket.id];
  let avatar = null,
    currentRoom = null,
    userIdToSave = null;

  if (clientInfo && clientInfo.userId) {
    userIdToSave = clientInfo.userId;
    if (clientInfo.avatarId !== null) {
      try {
        const findResult = getAvatarAndRoom(socket.id);
        avatar = findResult.avatar;
        currentRoom = findResult.room;
      } catch (e) {
        console.error(
          `Error finding avatar/room during disconnect for ${socket.id}: ${e.message}`
        );
      }
    } else
      console.log(
        `Disconnect: Socket ${socket.id} (User ${userIdToSave}) had no avatarId.`
      );
  } else
    console.log(`Disconnect: Socket ${socket.id} had no clientInfo or userId.`);

  // --- Save Player Data ---
  if (userIdToSave && avatar && typeof updateUser === "function") {
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
      console.log(
        `Saving data for user ${userIdToSave} (Avatar ${avatar.id}, Pos: ${playerState.lastX},${playerState.lastY} in ${playerState.lastRoomId})...`
      );
      await updateUser(userIdToSave, playerState);
      console.log(` -> Data saved successfully for user ${userIdToSave}.`);
    } catch (error) {
      console.error(
        `Error saving data for user ${userIdToSave} on disconnect:`,
        error
      );
    }
  } else if (userIdToSave)
    console.warn(
      `Disconnect: Could not save state for user ${userIdToSave}, avatar unavailable.`
    );
  // --- End Save Player Data ---

  // Remove avatar from the in-memory game world
  if (avatar && currentRoom) {
    const removed = currentRoom.removeAvatar(socket.id);
    if (removed) {
      io.to(currentRoom.id).emit("avatar_removed", { id: String(avatar.id) });
      console.log(
        `Avatar ${avatar.name} (ID:${avatar.id}) removed from room ${currentRoom.id}.`
      );
      io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
    } else
      console.warn(
        `Disconnect: Avatar ${avatar.id} not found in room ${currentRoom.id} map during removal.`
      );
  }

  // Remove from global client tracking map
  if (clients[socket.id]) delete clients[socket.id];
}

// --- Connect Error Handler ---
function handleConnectError(socket, err) {
  console.error(
    `Socket connect_error for ${socket?.id || "unknown"}: ${err.message}`
  );
  // Call disconnect handler to ensure cleanup even on connection failure
  handleDisconnect(
    socket || { id: `error_${Date.now()}` }, // Provide a dummy socket if needed
    `Connection error: ${err.message}`
  );
}

module.exports = {
  initializeHandlers,
  handleConnection, // Async
  handleChangeRoom, // Exported for use by console/commands etc.
};
