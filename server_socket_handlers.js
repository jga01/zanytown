"use strict";

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const {
  ServerAvatar,
  ServerFurniture,
  ServerNPC,
} = require("./lib/game_objects"); // Import ServerNPC
const { rotateDirection, escapeHtml } = require("./lib/utils");
const Furniture = require("./models/furniture"); // Database model
const User = require("./models/user"); // Import User model
const { findAvatarGlobally } = require("./server_console"); // Import console helper
const RoomState = require("./models/roomState");
const ServerRoom = require("./lib/room");
const mongoose = require("mongoose"); // Needed for transactions / ObjectId

// --- Globals passed from server.js ---
let rooms; // Map<roomId, ServerRoom>
let io;
let clients; // Map: socket.id -> { socket, avatarId (runtime), userId (persistent) }

// --- Stored DB Helper Functions ---
let findUserById; // Will hold findUserByIdFromDB reference
let updateUser; // Will hold updateUserInDB reference

// --- Trade State Management ---
const activeTrades = new Map(); // tradeId -> { tradeId, p1: { socketId, userId, avatarId, name, offer: {items, currency}, confirmed }, p2: { ... }, startTime }

/** Generates a unique ID for a trade session. */
function generateTradeId() {
  return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Gets participant info for a trade session.
 * @param {string} socketId - The socket ID of the participant.
 * @returns {object | null} Participant info object or null if not found/valid.
 */
function getParticipantInfo(socketId) {
  const clientInfo = clients[socketId];
  if (!clientInfo) return null;
  const { avatar } = getAvatarAndRoom(socketId); // Use existing helper
  if (!avatar) return null;
  return {
    socketId: socketId,
    userId: clientInfo.userId,
    avatarId: avatar.id,
    name: avatar.name,
    offer: { items: {}, currency: 0 }, // Initial empty offer
    confirmed: false,
  };
}

/**
 * Finds the active trade session a socket is involved in.
 * @param {string} socketId - The socket ID to search for.
 * @returns {object | null} The trade session object or null if not found.
 */
function findTradeBySocketId(socketId) {
  for (const trade of activeTrades.values()) {
    if (trade.p1.socketId === socketId || trade.p2.socketId === socketId) {
      return trade;
    }
  }
  return null;
}

/**
 * Ends a trade session, removes it from the active map, and notifies participants.
 * @param {string} tradeId - The ID of the trade to end.
 * @param {string} reason - The reason for ending the trade (sent to clients).
 * @param {string | null} [notifySocketId=null] - If provided, sends a specific message to the *other* participant indicating who initiated the cancellation.
 */
function endTradeSession(tradeId, reason, notifySocketId = null) {
  const trade = activeTrades.get(tradeId);
  if (!trade) return;

  console.log(`Ending trade ${tradeId}. Reason: ${reason}`);
  activeTrades.delete(tradeId); // Remove from active trades

  // Notify both participants
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;

  let finalReasonP1 = reason;
  let finalReasonP2 = reason;

  // If initiated by one player, customize message for the other
  if (notifySocketId) {
    if (notifySocketId === trade.p1.socketId && p2Socket) {
      // P1 cancelled
      const initiatorName = trade.p1.name || "Player";
      finalReasonP2 = `${escapeHtml(initiatorName)} cancelled the trade.`;
    } else if (notifySocketId === trade.p2.socketId && p1Socket) {
      // P2 cancelled
      const initiatorName = trade.p2.name || "Player";
      finalReasonP1 = `${escapeHtml(initiatorName)} cancelled the trade.`;
    }
  }

  if (p1Socket)
    p1Socket.emit("trade_cancelled", { tradeId, reason: finalReasonP1 });
  if (p2Socket)
    p2Socket.emit("trade_cancelled", { tradeId, reason: finalReasonP2 });
}
// --- End Trade State Management ---

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
/**
 * Retrieves the ServerAvatar instance and its ServerRoom instance based on a socket ID.
 * Also performs consistency checks.
 * @param {string} socketId - The socket ID of the client.
 * @returns {{avatar: ServerAvatar | null, room: ServerRoom | null, socket: import('socket.io').Socket | null}}
 */
function getAvatarAndRoom(socketId) {
  const clientInfo = clients[socketId];
  if (!clientInfo || clientInfo.avatarId == null) {
    // console.warn(`getAvatarAndRoom: No clientInfo or avatarId for socket ${socketId}`);
    return { avatar: null, room: null, socket: clientInfo?.socket };
  }
  const avatarId = clientInfo.avatarId; // Runtime ID

  let avatar = null;
  let foundInRoomId = null;

  // Iterate through rooms to find the avatar instance
  for (const [roomId, roomInstance] of rooms.entries()) {
    if (
      roomInstance &&
      roomInstance.avatars &&
      typeof roomInstance.avatars === "object"
    ) {
      // Check both keys (socketId for players, avatarId for NPCs)
      let potentialAvatar = roomInstance.avatars[socketId]; // Check by socketId first (players)
      if (!potentialAvatar) {
        potentialAvatar = roomInstance.avatars[String(avatarId)]; // Check by avatarId (NPCs, or player fallback)
      }

      // Ensure the found object actually matches the expected avatarId
      if (potentialAvatar && potentialAvatar.id === avatarId) {
        avatar = potentialAvatar;
        foundInRoomId = roomId;
        break; // Found it
      }
    }
  }

  if (!avatar) {
    console.warn(
      `getAvatarAndRoom: Avatar instance for ID ${avatarId} (Socket: ${socketId}) not found in any room's avatar map.`
    );
    return { avatar: null, room: null, socket: clientInfo.socket };
  }

  // Consistency check: Does the avatar's stored room ID match where we found it?
  if (avatar.roomId !== foundInRoomId) {
    console.warn(
      `Consistency Warning: Avatar ${avatar.id}(${avatar.name}) found in room map for '${foundInRoomId}', but avatar.roomId is '${avatar.roomId}'. Correcting avatar.roomId.`
    );
    avatar.roomId = foundInRoomId;
  }

  // Get the room instance using the consistent room ID
  const room = rooms.get(avatar.roomId);
  if (!room) {
    console.warn(
      `getAvatarAndRoom: Avatar ${avatar.id} has roomId ${avatar.roomId}, but room instance not found in global map.`
    );
    return { avatar: avatar, room: null, socket: clientInfo.socket };
  }

  return { avatar, room, socket: clientInfo.socket };
}

// --- Handler for Room List Request ---
function handleRequestPublicRooms(socket) {
  const roomListData = [];
  const sortedRoomIds = Array.from(rooms.keys()).sort();

  sortedRoomIds.forEach((roomId) => {
    const room = rooms.get(roomId);
    if (room) {
      // Use the getUserList method which filters for players only
      roomListData.push({
        id: roomId,
        playerCount: room.getUserList().length,
      });
    }
  });

  console.log(
    `Socket ${socket.id} requested room list. Sending ${roomListData.length} rooms.`
  );
  socket.emit("public_rooms_update", roomListData);
}

// --- Connection Handler (ASYNC due to DB read) ---
async function handleConnection(socket) {
  console.log(`Client connected: ${socket.id}, UserID: ${socket.userId}`);
  clients[socket.id] = {
    socket: socket,
    avatarId: null,
    userId: socket.userId,
  };
  socket.isAdmin = false; // Default admin status

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

  // Ensure the target room exists, fallback to default if necessary
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

  // Use ServerRoom's findSpawnPoint, preferring saved coords
  const spawnPoint = room.findSpawnPoint(userData.lastX, userData.lastY);
  console.log(
    `Spawning ${userData.username} in ${room.id} at (${spawnPoint.x}, ${spawnPoint.y}) (Preferred DB: ${userData.lastX}, ${userData.lastY})`
  );

  if (!ServerAvatar) {
    // Check if ServerAvatar class is loaded
    console.error(
      "FATAL: ServerAvatar class not loaded. Cannot create avatar."
    );
    socket.emit("auth_error", "Server error during player initialization.");
    socket.disconnect(true);
    if (clients[socket.id]) delete clients[socket.id];
    return;
  }

  // Create and configure the new player avatar
  const newAvatar = new ServerAvatar(
    spawnPoint.x,
    spawnPoint.y,
    userData.username || `User_${socket.id.substring(0, 4)}`,
    socket.id // Pass socketId to ServerAvatar constructor
  );
  newAvatar.isAdmin = socket.isAdmin;
  newAvatar.currency = userData.currency ?? SHARED_CONFIG.DEFAULT_CURRENCY;
  newAvatar.inventory = new Map(Object.entries(userData.inventory || {}));
  newAvatar.bodyColor = userData.bodyColor || "#6CA0DC";
  newAvatar.z = userData.lastZ ?? SHARED_CONFIG.AVATAR_DEFAULT_Z;
  newAvatar.roomId = room.id;

  clients[socket.id].avatarId = newAvatar.id; // Store runtime ID

  // --- Add Avatar to Room and Join Socket Room ---
  room.addAvatar(newAvatar); // Uses the updated addAvatar method
  socket.join(room.id);
  console.log(`Socket ${socket.id} joined Socket.IO room: ${room.id}`);
  console.log(
    `Avatar ${newAvatar.name} (RuntimeID:${newAvatar.id}, UserID: ${socket.userId}) added to room ${room.id} state.`
  );

  // Send initial state to the connecting client
  socket.emit("your_persistent_id", String(userData._id));
  socket.emit("room_state", room.getStateDTO()); // Includes players and NPCs
  socket.emit("your_avatar_id", String(newAvatar.id));
  socket.emit("inventory_update", newAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: newAvatar.currency });

  // Broadcast the new avatar's arrival to others in the room
  socket.to(room.id).emit("avatar_added", newAvatar.toDTO());
  console.log(
    ` -> Broadcast 'avatar_added' for ${newAvatar.name} to room ${room.id}.`
  );

  // Send updated user list (only players) to everyone in the room
  io.to(room.id).emit("user_list_update", room.getUserList());

  // --- Attach Event Listeners for this socket ---
  socket.on("request_move", (data) => handleRequestMove(socket, data));
  socket.on("send_chat", (message) => handleSendChat(socket, message));
  socket.on("request_place_furni", (data) =>
    handleRequestPlaceFurni(socket, data)
  ); // Async
  socket.on("request_rotate_furni", (data) =>
    handleRequestRotateFurni(socket, data)
  ); // Async
  socket.on("request_pickup_furni", (data) =>
    handleRequestPickupFurni(socket, data)
  ); // Async
  socket.on("request_sit", (data) => handleRequestSit(socket, data));
  socket.on("request_stand", () => handleRequestStand(socket));
  socket.on("request_user_list", () => handleRequestUserList(socket));
  socket.on("request_profile", (data) => handleRequestProfile(socket, data));
  socket.on("request_use_furni", (data) => handleRequestUseFurni(socket, data)); // Async
  socket.on("request_recolor_furni", (data) =>
    handleRequestRecolorFurni(socket, data)
  ); // Async
  socket.on("request_buy_item", (data) => handleRequestBuyItem(socket, data));
  socket.on("request_change_room", (data) => handleChangeRoom(socket, data));
  socket.on("request_create_room", (data) =>
    handleRequestCreateRoom(socket, data)
  ); // Async
  socket.on("request_modify_layout", (data) =>
    handleRequestModifyLayout(socket, data)
  ); // Async
  socket.on("request_all_room_ids", () => handleRequestAllRoomIds(socket));
  socket.on("request_public_rooms", () => handleRequestPublicRooms(socket));
  socket.on("request_interact", (data) => handleRequestInteract(socket, data));
  // Trade Listeners
  socket.on("request_trade_initiate", (data) =>
    handleRequestTradeInitiate(socket, data)
  );
  socket.on("trade_request_response", (data) =>
    handleTradeRequestResponse(socket, data)
  );
  socket.on("trade_update_offer", (data) =>
    handleTradeUpdateOffer(socket, data)
  );
  socket.on("trade_confirm_offer", (data) =>
    handleTradeConfirmOffer(socket, data)
  ); // Async (due to DB)
  socket.on("trade_cancel", (data) => handleTradeCancel(socket, data));
  // Lifecycle listeners
  socket.on("disconnect", (reason) => handleDisconnect(socket, reason)); // Async
  socket.on("connect_error", (err) => handleConnectError(socket, err));
}

// --- Request Move Handler ---
function handleRequestMove(socket, target) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) || // Ensure it's a player avatar
    !room ||
    !target ||
    typeof target.x !== "number" ||
    typeof target.y !== "number"
  )
    return;

  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Cannot move while sitting.",
    });
    return;
  }

  const endX = Math.round(target.x);
  const endY = Math.round(target.y);

  // Use room's isWalkable, which now considers NPCs if configured
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

  // Use the avatar's moveTo method
  if (avatar.moveTo(endX, endY, room, null, handleChangeRoom)) {
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

// --- Send Chat Handler (with Sanitization & Command Parsing) ---
function handleSendChat(socket, message) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    typeof message !== "string"
  )
    return; // Ensure it's a player

  const trimmedMessage = message.trim().substring(0, 150); // Limit length
  const safeMessage = escapeHtml(trimmedMessage); // Sanitize for display
  if (!safeMessage) return;

  // Command Handling
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
          reason: "Admin permission required.",
        });
        return;
      }
    }

    // Command switch (refactored for clarity)
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
              reason: `Cannot ${command} now.`,
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
              reason: `Cannot perform ${escapeHtml(emoteId)} now.`,
            });
        } else {
          const validEmotes = escapeHtml(
            Object.keys(SHARED_CONFIG.EMOTE_DEFINITIONS || {}).join(", ")
          );
          socket.emit("action_failed", {
            action: "emote",
            reason: `Usage: /emote <id>. Valid: ${validEmotes}`,
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
              reason: "Invalid color (#RRGGBB).",
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
            console.error("handleChangeRoom missing!");
            socket.emit("action_failed", {
              action: "command",
              reason: "Room changing unavailable.",
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
          avatarName: "Server",
          text: `You are in: ${escapeHtml(avatar.roomId || "?")}`,
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
        return; // No further processing needed
      case "announce":
        if (rawArgs.length > 0) {
          const rawAnnounceMsg = rawArgs.join(" ");
          const safeAnnounceMsg = escapeHtml(rawAnnounceMsg.substring(0, 200));
          console.log(
            `ADMIN ACTION: ${avatar.name} announced: ${rawAnnounceMsg}`
          );
          io.emit("chat_message", {
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
          if (
            targetAvatarKick &&
            targetAvatarKick instanceof ServerAvatar &&
            clients[targetAvatarKick.socketId]
          ) {
            // Ensure it's a player
            console.log(
              `ADMIN ACTION: ${avatar.name} kicking ${targetAvatarKick.name}...`
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
              )} kicked by ${escapeHtml(avatar.name)}.`,
              className: "server-msg",
            });
          } else
            socket.emit("action_failed", {
              action: "kick",
              reason: `Player '${escapeHtml(targetNameKick)}' not found.`,
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
            // Teleport within current room
            targetXTp = parseInt(rawArgs[1], 10);
            targetYTp = parseInt(rawArgs[2], 10);
          } else {
            // Teleport to another room
            destRoomIdTp = rawArgs[1];
            targetXTp = parseInt(rawArgs[2], 10);
            targetYTp = parseInt(rawArgs[3], 10);
          }
          const { avatar: targetAvatarTp } = findAvatarGlobally(targetNameTp);
          const destRoomTp = rooms.get(destRoomIdTp);

          if (!(targetAvatarTp instanceof ServerAvatar))
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Player '${escapeHtml(targetNameTp)}' not found.`,
            });
          else if (!destRoomTp)
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Room '${escapeHtml(destRoomIdTp)}' not found.`,
            });
          else if (isNaN(targetXTp) || isNaN(targetYTp))
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Invalid coordinates.`,
            });
          else if (!destRoomTp.isValidTile(targetXTp, targetYTp))
            socket.emit("action_failed", {
              action: "teleport",
              reason: `Cannot teleport: Target tile invalid.`,
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
                text: `Teleported ${escapeHtml(targetAvatarTp.name)}.`,
                className: "info-msg",
              });
            } else
              socket.emit("action_failed", {
                action: "teleport",
                reason: `Cannot teleport: Socket not found or internal error.`,
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

          if (!(targetAvatarGive instanceof ServerAvatar))
            socket.emit("action_failed", {
              action: "give",
              reason: `Player '${escapeHtml(targetNameGive)}' not found.`,
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
                text: `Gave item to ${escapeHtml(targetAvatarGive.name)}.`,
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
                  text: `Admin gave you ${quantityGive}x ${escapeHtml(
                    definition.name
                  )}!`,
                  className: "server-msg",
                });
              }
            } else
              socket.emit("action_failed", {
                action: "give",
                reason: `Failed to give (internal?).`,
              });
          }
        } else
          socket.emit("action_failed", {
            action: "give",
            reason: "Usage: /give <user> <item_id> [qty]",
          });
        break;
      case "givegold":
        if (rawArgs.length === 2) {
          const targetNameGold = rawArgs[0];
          const amountGold = parseInt(rawArgs[1], 10);
          const { avatar: targetAvatarGold } =
            findAvatarGlobally(targetNameGold);

          if (!(targetAvatarGold instanceof ServerAvatar))
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Player '${escapeHtml(targetNameGold)}' not found.`,
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
                text: `Admin gave you ${amountGold} Gold!`,
                className: "server-msg",
              });
            }
          } else
            socket.emit("action_failed", {
              action: "givegold",
              reason: `Failed to give (internal?).`,
            });
        } else
          socket.emit("action_failed", {
            action: "givegold",
            reason: "Usage: /givegold <user> <amount>",
          });
        break;
      // Default unknown command
      default:
        if (!isAdminCommand)
          socket.emit("action_failed", {
            action: "command",
            reason: `Unknown command: /${escapeHtml(command)}`,
          });
        updateNeeded = false;
        broadcastUpdate = false;
    } // End command switch

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
}

// --- Place Furniture Handler (ASYNC with improved Rollback Logic) ---
async function handleRequestPlaceFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
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

  // --- Validation Phase ---
  const gridX = Math.round(data.x);
  const gridY = Math.round(data.y);
  const rotation = data.rotation % 8 || 0;
  const placeZ =
    room.getStackHeightAt(gridX, gridY) + (definition.zOffset || 0);
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = placeZ + (definition.isFlat ? 0 : itemStackContrib);
  const epsilon = 0.001;

  if (!avatar.hasItem(data.definitionId, 1)) {
    socket.emit("action_failed", {
      action: "place",
      reason: "You do not have that item.",
    });
    return;
  }
  if (itemTopZ >= SHARED_CONFIG.MAX_STACK_Z - epsilon) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Stack height limit reached.`,
    });
    return;
  }
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    width: definition.width || 1,
    height: definition.height || 1,
    definition: definition,
  };
  const occupiedTiles =
    ServerFurniture.prototype.getOccupiedTiles.call(tempFurniProto);
  for (const tile of occupiedTiles) {
    if (!room.isValidTile(tile.x, tile.y)) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot place on invalid tile (${tile.x},${tile.y}).`,
      });
      return;
    }
    const baseStackTile = room.getFurnitureStackAt(tile.x, tile.y);
    const topItemOnThisTile = baseStackTile.sort((a, b) => b.z - a.z)[0];
    if (
      !definition.isFlat &&
      topItemOnThisTile &&
      !topItemOnThisTile.stackable
    ) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot stack on '${escapeHtml(topItemOnThisTile.name)}'.`,
      });
      return;
    }
    if (room.isTileOccupiedBySolid(tile.x, tile.y)) {
      const solidBlocker = baseStackTile.find(
        (f) => !f.isWalkable && !f.isFlat && !f.stackable
      );
      if (solidBlocker) {
        socket.emit("action_failed", {
          action: "place",
          reason: `Tile blocked by solid '${escapeHtml(solidBlocker.name)}'.`,
        });
        return;
      }
    }
  }
  // Check base tile stackability separately (if not flat)
  if (!definition.isFlat) {
    const baseStack = room.getFurnitureStackAt(gridX, gridY);
    const topItemOnBase = baseStack.sort((a, b) => b.z - a.z)[0];
    if (topItemOnBase && !topItemOnBase.stackable) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot stack on '${escapeHtml(topItemOnBase.name)}'.`,
      });
      return;
    }
  }
  // --- End Validation ---

  // --- Transaction Phase (Inventory -> DB -> Memory) ---
  let savedDocumentId = null;
  try {
    // 1. Remove from inventory FIRST
    if (!avatar.removeItem(data.definitionId, 1)) {
      throw new Error("Inventory removal failed (item likely gone)."); // Treat as error to prevent DB write
    }
    console.log(
      `[Inv Remove OK] User ${avatar.name}: Removed 1x ${data.definitionId}`
    );
    socket.emit("inventory_update", avatar.getInventoryDTO()); // Optimistic inventory update

    try {
      // 2. Create in Database
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
      const savedDocument = await Furniture.create(newFurniData);
      if (!savedDocument || !savedDocument._id)
        throw new Error("DB create failed to return document.");
      savedDocumentId = savedDocument._id; // Store ID for potential rollback
      console.log(
        `[DB Create OK] Room ${room.id}: ${definition.name} (ID: ${savedDocumentId})`
      );

      // 3. Add to Memory & Broadcast
      const newFurniInstance = new ServerFurniture(
        definition.id,
        gridX,
        gridY,
        placeZ,
        rotation,
        savedDocumentId.toString(),
        savedDocument.ownerId,
        savedDocument.state,
        savedDocument.colorOverride
      );
      room.addFurniture(newFurniInstance);
      console.log(
        `[Mem Add OK] Room ${room.id}: Added ${definition.name} (ID:${newFurniInstance.id})`
      );
      io.to(room.id).emit("furni_added", newFurniInstance.toDTO());
      console.log(
        `[Place Success] Broadcasted furni_added for ${newFurniInstance.id}`
      );
    } catch (dbOrMemError) {
      // DB Create or Memory Add FAILED, need to refund inventory
      console.error(
        `DB/Mem Error after inventory removal for ${data.definitionId}:`,
        dbOrMemError
      );
      // Rollback Inventory
      if (avatar.addItem(data.definitionId, 1)) {
        console.log(
          `[COMPENSATION] Refunded 1x ${data.definitionId} to ${avatar.name}.`
        );
        socket.emit("inventory_update", avatar.getInventoryDTO()); // Send corrected inventory
      } else {
        console.error(
          `CRITICAL ERROR: Failed to refund item ${data.definitionId} after place failure! User ${avatar.name} lost item.`
        );
        // Might need manual intervention or logging for support
      }
      // If DB entry was created before memory add failed, try to delete it (best effort)
      if (savedDocumentId) {
        console.warn(
          `Attempting DB delete compensation for failed place: ${savedDocumentId}`
        );
        try {
          await Furniture.findByIdAndDelete(savedDocumentId);
          console.log(`[COMPENSATION] Deleted DB doc ${savedDocumentId}.`);
        } catch (deleteError) {
          console.error(
            `[COMPENSATION FAILED] Could not delete DB doc ${savedDocumentId}! Manual cleanup needed.`,
            deleteError
          );
        }
      }
      socket.emit("action_failed", {
        action: "place",
        reason: "Server error placing item.",
      });
    }
  } catch (inventoryError) {
    // Inventory Remove FAILED (step 1)
    console.error(
      `Inventory Error placing ${data.definitionId} for ${avatar.name}:`,
      inventoryError.message
    );
    socket.emit("action_failed", {
      action: "place",
      reason: inventoryError.message,
    }); // Send specific reason if available
    // Resync inventory just in case client is out of sync
    socket.emit("inventory_update", avatar.getInventoryDTO());
  }
} // --- End handleRequestPlaceFurni ---

// --- Rotate Furniture Handler (ASYNC) ---
async function handleRequestRotateFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    !data ||
    data.furniId == null
  )
    return;
  const furniId = String(data.furniId);
  const furni = room.getFurnitureById(furniId);
  if (!furni) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Item not found.",
    });
    return;
  }
  const clientInfo = clients[socket.id];
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
  const newRotation = rotateDirection(furni.rotation, 2); // Rotate 90 degrees clockwise
  if (oldRotation === newRotation) return; // No change needed

  try {
    // 1. Update DB
    const updatedDoc = await Furniture.findByIdAndUpdate(
      furniId,
      { $set: { rotation: newRotation } },
      { new: false }
    ); // Find original to confirm existence
    if (!updatedDoc) throw new Error("Doc not found during update.");

    // 2. Update Memory
    furni.rotation = newRotation;

    // 3. Broadcast Update & Update Seated Avatar Direction
    console.log(
      `[${room.id}] ${avatar.name} rotated ${furni.name} (ID:${furni.id}) to ${furni.rotation}`
    );
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      rotation: furni.rotation,
    });

    Object.values(room.avatars).forEach((obj) => {
      if (
        obj instanceof ServerAvatar &&
        String(obj.sittingOnFurniId) === furniId
      ) {
        const oldDir = obj.direction;
        obj.direction = rotateDirection(furni.sitDir, furni.rotation);
        if (oldDir !== obj.direction) {
          io.to(room.id).emit("avatar_update", {
            id: String(obj.id),
            direction: obj.direction,
          });
        }
      }
    });
  } catch (dbError) {
    console.error(`DB Error rotating furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Server error rotating.",
    });
    // Rollback memory? Unlikely needed if DB failed, but could: furni.rotation = oldRotation;
  }
}

// --- Pickup Furniture Handler (ASYNC with improved Rollback Logic) ---
async function handleRequestPickupFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    !data ||
    data.furniId == null
  )
    return;
  const furniId = String(data.furniId);
  const furniInstance = room.getFurnitureById(furniId);
  if (!furniInstance) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Item not found.",
    });
    return;
  }

  // --- Validation ---
  const clientInfo = clients[socket.id];
  if (
    !socket.isAdmin &&
    furniInstance.ownerId !== null &&
    String(furniInstance.ownerId) !== clientInfo?.userId
  ) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "You don't own this.",
    });
    return;
  }
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
    itemsOnTop.sort((a, b) => a.z - b.z); // Find lowest item on top
    socket.emit("action_failed", {
      action: "pickup",
      reason: `Cannot pick up, '${escapeHtml(itemsOnTop[0].name)}' is on top.`,
    });
    return;
  }
  if (room.isFurnitureOccupied(furniId)) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Someone is using it.",
    });
    return;
  }
  // --- End Validation ---

  // Store data needed for potential rollback
  const furniDataForRecreation = furniInstance.toDBSaveObject(); // Use existing method
  const definitionIdToRefund = furniInstance.definitionId;

  try {
    // --- Pickup Transaction (DB Delete -> Memory Remove -> Inventory Add) ---
    // 1. Delete from Database
    const deleteResult = await Furniture.findByIdAndDelete(furniId);
    if (!deleteResult) {
      console.warn(
        `[DB Delete NF] Pickup requested for ${furniId}, but not found in DB.`
      );
      // Check if it exists in memory anyway (consistency issue)
      if (room.getFurnitureById(furniId)) {
        room.removeFurnitureInstance(furniId);
        io.to(room.id).emit("furni_removed", { id: furniId });
        console.warn(` -> Removed dangling instance ${furniId} from memory.`);
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
    if (!removedInstance) {
      // This is a server inconsistency, but DB is already deleted. Log error.
      console.error(
        `CRITICAL ERROR: DB/Memory Inconsistency! Deleted ${furniId} from DB but failed remove from room ${room.id} memory! Attempting inventory refund anyway.`
      );
    } else {
      console.log(
        `[Mem Remove OK] Room ${room.id}: Removed ${furniId} from memory.`
      );
    }
    // Broadcast removal REGARDLESS of memory removal success (DB is source of truth)
    io.to(room.id).emit("furni_removed", { id: furniId });

    // 3. Add to Player Inventory
    if (avatar.addItem(definitionIdToRefund, 1)) {
      console.log(
        `[Inv Add OK] User ${avatar.name}: Added 1x ${definitionIdToRefund}`
      );
      socket.emit("inventory_update", avatar.getInventoryDTO());
      console.log(`[Pickup Success] Completed pickup for ${furniId}`);
    } else {
      // Inventory Add FAILED - Rollback Needed!
      console.error(
        `CRITICAL ERROR: Failed add item ${definitionIdToRefund} (DB ID: ${furniId}) AFTER DB delete! Attempting DB re-creation.`
      );
      try {
        // Ensure ownerId is correct for re-creation
        furniDataForRecreation.ownerId = clientInfo?.userId || null;
        // Add _id back for potential recreation with same ID, though create usually generates new
        // Using create is safer than trying to force an ID with insert.
        const recreatedDoc = await Furniture.create(furniDataForRecreation);
        console.log(
          `[COMPENSATION] Re-created DB document for ${furniId} (New ID: ${recreatedDoc._id}).`
        );

        // Add back to memory with NEW ID
        const recreatedInstance = new ServerFurniture(
          recreatedDoc.definitionId,
          recreatedDoc.x,
          recreatedDoc.y,
          recreatedDoc.z,
          recreatedDoc.rotation,
          recreatedDoc._id.toString(), // Use NEW ID
          recreatedDoc.ownerId,
          recreatedDoc.state,
          recreatedDoc.colorOverride
        );
        room.addFurniture(recreatedInstance);
        io.to(room.id).emit("furni_added", recreatedInstance.toDTO()); // Broadcast NEW item
        console.log(
          `[COMPENSATION] Re-added instance ${recreatedInstance.id} to memory.`
        );
      } catch (recreateError) {
        console.error(
          `[COMPENSATION FAILED] Could not re-create DB/memory for ${furniId}! Manual cleanup needed.`,
          recreateError
        );
        // User lost item and it's gone from world. Very bad state.
      }
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Inventory error (Rolled back).",
      });
    }
  } catch (dbError) {
    // DB Delete FAILED (Step 1)
    console.error(`DB Error picking up furniture ${furniId}:`, dbError);
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Server error picking up.",
    });
  }
} // --- End handleRequestPickupFurni ---

// --- Request Sit Handler ---
function handleRequestSit(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    !data ||
    data.furniId == null
  )
    return;

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

  // Check if the INTERACTION SPOT itself is walkable (not necessarily the furniture spot)
  if (!room.isWalkable(interactionSpot.x, interactionSpot.y)) {
    // Is something solid blocking the interaction spot?
    const blockers = room.furniture.filter((f) => {
      if (!f.isWalkable && !f.isFlat) {
        // Check solid furniture
        return f
          .getOccupiedTiles()
          .some(
            (tile) =>
              tile.x === interactionSpot.x && tile.y === interactionSpot.y
          );
      }
      return false;
    });
    // Check NPCs blocking interaction spot (if configured)
    const npcBlocker = Object.values(room.avatars).find(
      (npc) =>
        npc instanceof ServerNPC &&
        Math.round(npc.x) === interactionSpot.x &&
        Math.round(npc.y) === interactionSpot.y
    );

    let reason = "Cannot reach seat.";
    if (npcBlocker) reason = `${escapeHtml(npcBlocker.name)} is in the way.`;
    else if (blockers.length > 0)
      reason = `${escapeHtml(blockers[0].name)} is in the way.`;

    socket.emit("action_failed", { action: "sit", reason: reason });
    return;
  }

  const currentX = Math.round(avatar.x);
  const currentY = Math.round(avatar.y);
  const sitAction = { type: "sit", targetId: furniId }; // targetId is the furni DB ID

  if (currentX === interactionSpot.x && currentY === interactionSpot.y) {
    // Already at interaction spot, sit immediately
    if (avatar.executeSit(furni, room)) {
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    } else {
      socket.emit("action_failed", { action: "sit", reason: "Failed to sit." });
    }
  } else {
    // Need to walk to interaction spot first
    if (
      avatar.moveTo(
        interactionSpot.x,
        interactionSpot.y,
        room,
        sitAction,
        handleChangeRoom
      )
    ) {
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    } else {
      // Check if path failed because target became unwalkable (e.g. NPC moved)
      if (!room.isWalkable(interactionSpot.x, interactionSpot.y)) {
        socket.emit("action_failed", {
          action: "sit",
          reason: "Seat interaction spot blocked.",
        });
      } else {
        socket.emit("action_failed", {
          action: "sit",
          reason: "Cannot find path to seat.",
        });
      }
    }
  }
}

// --- Request Stand Handler ---
function handleRequestStand(socket) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !(avatar instanceof ServerAvatar) || !room) return;

  if (avatar.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", { action: "stand", reason: "Not sitting." });
    return;
  }

  if (avatar.executeStand(room)) {
    io.to(room.id).emit("avatar_update", avatar.toDTO());
  } else {
    socket.emit("action_failed", {
      action: "stand",
      reason: "Failed to stand.",
    });
  }
}

// --- Request User List Handler ---
function handleRequestUserList(socket) {
  const { room } = getAvatarAndRoom(socket.id);
  if (room) {
    socket.emit("user_list_update", room.getUserList()); // Send player list
  } else {
    socket.emit("user_list_update", []); // Send empty list if no room
  }
}

// --- Request Profile Handler ---
function handleRequestProfile(socket, data) {
  const requesterInfo = getAvatarAndRoom(socket.id);
  if (
    !requesterInfo.avatar ||
    !(requesterInfo.avatar instanceof ServerAvatar) ||
    !data ||
    data.avatarId == null
  )
    return;

  const targetAvatarId = String(data.avatarId);
  // Find avatar globally by runtime ID
  const { avatar: targetAvatar } = findAvatarGlobally(null, targetAvatarId); // Modify helper if needed

  if (targetAvatar instanceof ServerAvatar) {
    // Ensure it's a player avatar
    console.log(
      `${requesterInfo.avatar.name} requested profile for ${targetAvatar.name}`
    );
    socket.emit("show_profile", targetAvatar.toProfileDTO());
  } else {
    socket.emit("action_failed", {
      action: "profile",
      reason: "Player not found online.",
    });
  }
}

// --- Use Furniture Handler (ASYNC) ---
async function handleRequestUseFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  // Allow NPCs to potentially 'use' items if logic requires? For now, require player avatar.
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    !data ||
    data.furniId == null
  )
    return;

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

  // TODO: Add distance check? Player needs to be adjacent?
  // const interactionSpot = furni.getInteractionTile();
  // const playerPos = { x: Math.round(avatar.x), y: Math.round(avatar.y) };
  // if (playerPos.x !== interactionSpot.x || playerPos.y !== interactionSpot.y) {
  //    socket.emit("action_failed", { action: "use", reason: "Too far away." });
  //    // Optionally, make the avatar walk there first?
  //    return;
  // }

  const useResult = furni.use(avatar, room); // Call the furniture's use method

  if (useResult.changed && useResult.updatePayload) {
    try {
      // Update DB
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId,
        { $set: useResult.updatePayload },
        { new: false }
      );
      if (!updatedDoc) throw new Error("Doc not found during 'use' update.");

      // Broadcast update
      console.log(
        `[${room.id}] ${avatar.name} used ${furni.name} (ID:${
          furni.id
        }). New State: ${furni.state}, Z: ${furni.z.toFixed(2)}`
      );
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
      // Rollback memory state?
      // furni.state = oldState; // Need to store old state before calling furni.use
      // furni.z = oldZ;
    }
  } else {
    // No change occurred, maybe send specific feedback?
    // socket.emit("action_failed", { action: "use", reason: "Use had no effect." });
  }
}

// --- Recolor Furniture Handler (ASYNC) ---
async function handleRequestRecolorFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
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

  const clientInfo = clients[socket.id];
  if (
    !socket.isAdmin &&
    furni.ownerId !== null &&
    String(furni.ownerId) !== clientInfo?.userId
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "You don't own this.",
    });
    return;
  }
  if (!furni.canRecolor) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "This item cannot be recolored.",
    });
    return;
  }

  const targetColor = data.colorHex;
  const upperTargetColor =
    typeof targetColor === "string" && targetColor !== ""
      ? targetColor.toUpperCase()
      : null;

  // Validate color
  if (
    upperTargetColor !== null &&
    !SHARED_CONFIG.VALID_RECOLOR_HEX.includes(upperTargetColor)
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: `Invalid color: ${escapeHtml(targetColor)}`,
    });
    return;
  }

  // Check if color is actually changing
  if (furni.colorOverride === upperTargetColor) {
    // socket.emit("action_failed", { action: "recolor", reason: "Color is already set to that." });
    return; // No need to update if color is the same
  }

  const recolorResult = furni.setColorOverride(upperTargetColor); // Update memory first

  if (recolorResult.changed && recolorResult.updatePayload) {
    try {
      // Update DB
      const updatedDoc = await Furniture.findByIdAndUpdate(
        furniId,
        { $set: recolorResult.updatePayload },
        { new: false }
      );
      if (!updatedDoc)
        throw new Error("Doc not found during 'recolor' update.");

      // Broadcast update
      const displayColor = furni.colorOverride || "default";
      console.log(
        `[${room.id}] ${avatar.name} recolored ${furni.name} (ID:${furni.id}) to ${displayColor}`
      );
      io.to(room.id).emit("furni_updated", {
        id: furni.id,
        ...recolorResult.updatePayload,
      });
    } catch (dbError) {
      console.error(`DB Error recoloring furniture ${furniId}:`, dbError);
      socket.emit("action_failed", {
        action: "recolor",
        reason: "Server error recoloring.",
      });
      // Rollback memory state?
      // furni.setColorOverride(originalColor); // Need to store original color
    }
  }
  // No need for 'else' - if no change needed, we already returned.
}

// --- Buy Item Handler ---
function handleRequestBuyItem(socket, data) {
  const { avatar } = getAvatarAndRoom(socket.id);
  if (!avatar || !(avatar instanceof ServerAvatar) || !data || !data.itemId) {
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
    console.error(`Shop Error: Item ${itemId} in catalog but not defs!`);
    socket.emit("action_failed", {
      action: "buy",
      reason: "Shop configuration error.",
    });
    return;
  }

  const price = shopEntry.price;
  if (avatar.currency < price) {
    socket.emit("action_failed", {
      action: "buy",
      reason: `Insufficient gold (Need ${price} Coins).`,
    });
    return;
  }

  // --- Transaction: Remove Currency -> Add Item ---
  if (avatar.removeCurrency(price)) {
    if (avatar.addItem(itemId, 1)) {
      // Success Case
      console.log(
        `${avatar.name} bought ${definition.name} for ${price} coins.`
      );
      socket.emit("currency_update", { currency: avatar.currency });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      socket.emit("chat_message", {
        avatarName: "Server",
        text: `You bought 1x ${escapeHtml(definition.name)}!`,
        className: "info-msg",
      });
    } else {
      // Failed inventory add, REFUND currency
      console.error(
        `Buy Error: Failed add item ${itemId} AFTER taking currency. Refunding.`
      );
      avatar.addCurrency(price); // Add currency back
      socket.emit("action_failed", {
        action: "buy",
        reason: "Inventory error (refunded).",
      });
      socket.emit("currency_update", { currency: avatar.currency }); // Send updated (refunded) currency
    }
  } else {
    // Failed currency removal (should be rare if check passed, but handle defensively)
    console.error(`Buy Error: Failed remove currency ${price}.`);
    socket.emit("action_failed", {
      action: "buy",
      reason: "Currency transaction error.",
    });
  }
}

// --- Room Change Handler ---
function handleChangeRoom(socket, data) {
  const { avatar: currentAvatar, room: currentRoom } = getAvatarAndRoom(
    socket.id
  );
  if (
    !currentAvatar ||
    !(currentAvatar instanceof ServerAvatar) ||
    !currentRoom ||
    !data ||
    !data.targetRoomId
  ) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: "Invalid request.",
    });
    return;
  }

  // --- Cancel Active Trade ---
  const ongoingTrade = findTradeBySocketId(socket.id);
  if (ongoingTrade) {
    console.log(
      `Player ${socket.id} (${currentAvatar.name}) changing room during trade ${ongoingTrade.tradeId}. Cancelling.`
    );
    endTradeSession(ongoingTrade.tradeId, "Player left the room.");
  }
  // --- End Trade Cancellation ---

  const targetRoomId = data.targetRoomId;
  const targetRoom = rooms.get(targetRoomId);

  if (!targetRoom) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: `Room '${escapeHtml(targetRoomId)}' does not exist.`,
    });
    return;
  }

  // --- Handle Room Change Logic ---
  const targetX = data.targetX ?? -1; // Use preferred coords or -1 for default spawn
  const targetY = data.targetY ?? -1;
  const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY); // Find valid spawn

  console.log(
    `${currentAvatar.name} changing from room ${currentRoom.id} to ${targetRoomId}`
  );

  // 1. Remove from current room state
  const removed = currentRoom.removeAvatar(socket.id); // Use socket.id to remove player
  if (removed) {
    io.to(currentRoom.id).emit("avatar_removed", {
      id: String(currentAvatar.id),
    });
    io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
  } else {
    console.warn(
      `handleChangeRoom: Failed remove avatar ${currentAvatar.id} from room ${currentRoom.id} state.`
    );
  }

  // 2. Leave old Socket.IO room
  socket.leave(currentRoom.id);
  console.log(` -> Left Socket.IO room: ${currentRoom.id}`);

  // 3. Prepare avatar for new room
  currentAvatar.prepareForRoomChange(targetRoomId, spawnPoint.x, spawnPoint.y);

  // 4. Add to new room state
  targetRoom.addAvatar(currentAvatar); // Add avatar instance to new room

  // 5. Join new Socket.IO room
  socket.join(targetRoomId);
  console.log(` -> Joined Socket.IO room: ${targetRoomId}`);

  // 6. Send new state to client
  socket.emit("room_state", targetRoom.getStateDTO()); // Send full state of new room
  // These might be redundant if room_state includes them, but can ensure sync
  socket.emit("your_avatar_id", String(currentAvatar.id));
  socket.emit("inventory_update", currentAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: currentAvatar.currency });

  // 7. Broadcast arrival to new room
  socket.to(targetRoomId).emit("avatar_added", currentAvatar.toDTO());
  io.to(targetRoomId).emit("user_list_update", targetRoom.getUserList()); // Update user list in new room

  console.log(
    ` -> ${
      currentAvatar.name
    } changed to room ${targetRoomId} at (${currentAvatar.x.toFixed(
      1
    )}, ${currentAvatar.y.toFixed(1)})`
  );
}

// --- Admin: Create Room Handler (ASYNC) ---
async function handleRequestCreateRoom(socket, data) {
  const { avatar } = getAvatarAndRoom(socket.id);
  if (!avatar || !(avatar instanceof ServerAvatar) || !socket.isAdmin) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Permission denied.",
    });
    return;
  }
  if (!data || typeof data.roomId !== "string" || !data.roomId.trim()) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Invalid room ID.",
    });
    return;
  }
  const newRoomId = data.roomId.trim().toLowerCase().replace(/\s+/g, "_");
  const requestedCols =
    parseInt(data.cols, 10) || SERVER_CONFIG.DEFAULT_ROOM_COLS;
  const requestedRows =
    parseInt(data.rows, 10) || SERVER_CONFIG.DEFAULT_ROOM_ROWS;

  if (
    requestedCols < 5 ||
    requestedCols > 50 ||
    requestedRows < 5 ||
    requestedRows > 50
  ) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: "Dimensions must be 5-50.",
    });
    return;
  }

  console.log(
    `Admin ${avatar.name} requested creation of room: ${newRoomId} (${requestedCols}x${requestedRows})`
  );

  if (rooms.has(newRoomId)) {
    socket.emit("action_failed", {
      action: "create_room",
      reason: `Room '${newRoomId}' already exists in memory.`,
    });
    return;
  }

  try {
    // Check DB first
    const existingRoom = await RoomState.findOne({ roomId: newRoomId }).lean();
    if (existingRoom) {
      socket.emit("action_failed", {
        action: "create_room",
        reason: `Room '${newRoomId}' already exists in DB.`,
      });
      return;
    }

    // Create new layout and save to DB
    const newLayout = Array.from(
      { length: requestedRows },
      (_, y) =>
        Array.from({ length: requestedCols }, (_, x) =>
          y === 0 ||
          y === requestedRows - 1 ||
          x === 0 ||
          x === requestedCols - 1
            ? 1
            : 0
        ) // Basic bordered layout
    );
    const newRoomState = new RoomState({
      roomId: newRoomId,
      layout: newLayout,
    });
    await newRoomState.save();
    console.log(` -> Saved new room state for '${newRoomId}' to DB.`);

    // Create instance and add to memory
    const newRoomInstance = new ServerRoom(newRoomId);
    newRoomInstance.layout = newLayout; // Set layout directly
    newRoomInstance.cols = requestedCols;
    newRoomInstance.rows = requestedRows;
    newRoomInstance.pathfinder = new (require("./lib/pathfinder"))(
      newRoomInstance
    ); // Initialize pathfinder
    // No need to load from DB as we just created it
    rooms.set(newRoomId, newRoomInstance);
    console.log(` -> Added new room '${newRoomId}' to memory.`);

    socket.emit("chat_message", {
      avatarName: "Server",
      text: `Room '${newRoomId}' created!`,
      className: "info-msg",
    });
    // Optionally broadcast update to admin room list
    const allRoomIds = Array.from(rooms.keys()).sort();
    io.to(socket.id).emit("all_room_ids_update", allRoomIds); // Update requesting admin's list
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
  if (
    !avatar ||
    !(avatar instanceof ServerAvatar) ||
    !room ||
    !socket.isAdmin
  ) {
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
  const validTypes = [0, 1, 2, "X"]; // Valid layout tile types

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

  // Prevent modifying under players or non-flat furniture if setting to solid/hole
  if (type === 1 || type === "X") {
    // Only check if setting to wall or hole
    const avatarOnTile = Object.values(room.avatars).find(
      (a) => Math.round(a.x) === x && Math.round(a.y) === y
    );
    if (avatarOnTile) {
      socket.emit("action_failed", {
        action: "modify_layout",
        reason: `Cannot modify under ${escapeHtml(avatarOnTile.name)}.`,
      });
      return;
    }
    const furnitureOnTile = room
      .getFurnitureStackAt(x, y)
      .find((f) => !f.isFlat); // Find any non-flat furni
    if (furnitureOnTile) {
      socket.emit("action_failed", {
        action: "modify_layout",
        reason: `Cannot modify under '${escapeHtml(furnitureOnTile.name)}'.`,
      });
      return;
    }
  }

  let oldType;
  try {
    oldType = room.layout[y]?.[x]; // Get current type
    if (oldType === undefined) throw new Error("Layout array access error.");
    if (oldType === type) return; // No change needed

    // Update Memory First
    room.layout[y][x] = type;
    // Reinitialize pathfinder after layout change
    room.pathfinder = new (require("./lib/pathfinder"))(room);
    console.log(
      `Admin ${avatar.name} modified layout in ${room.id} at (${x},${y}) from ${oldType} to ${type}.`
    );

    // Update DB
    const updatedRoomState = await RoomState.findOneAndUpdate(
      { roomId: room.id },
      { $set: { layout: room.layout } }, // Save the entire layout
      { new: false } // Don't return new doc
    );
    if (!updatedRoomState) {
      throw new Error(`Room ${room.id} not found in DB during layout update!`);
    }
    console.log(` -> Saved updated layout for '${room.id}' to DB.`);

    // Broadcast Update
    io.to(room.id).emit("layout_tile_update", { x, y, type });
  } catch (error) {
    console.error(
      `Error modifying layout for room '${room.id}' at (${x},${y}):`,
      error
    );
    // Rollback Memory if possible
    if (oldType !== undefined) {
      try {
        room.layout[y][x] = oldType;
        // Reinitialize pathfinder again after rollback
        room.pathfinder = new (require("./lib/pathfinder"))(room);
        console.log(` -> Rolled back memory change for layout.`);
      } catch (rollbackError) {
        console.error(` -> Memory rollback failed:`, rollbackError);
      }
    }
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: "Server error saving layout.",
    });
  }
}

// --- Admin: Request All Room IDs Handler ---
function handleRequestAllRoomIds(socket) {
  if (!socket.isAdmin) {
    socket.emit("action_failed", {
      action: "list_rooms",
      reason: "Permission denied.",
    });
    return;
  }
  const roomIds = Array.from(rooms.keys()).sort();
  console.log(
    `Admin ${socket.id} requested room list. Sending ${roomIds.length} IDs.`
  );
  socket.emit("all_room_ids_update", roomIds);
}

// --- NPC Interaction Handler ---
function handleRequestInteract(socket, data) {
  const { avatar: playerAvatar, room } = getAvatarAndRoom(socket.id);
  if (
    !playerAvatar ||
    !(playerAvatar instanceof ServerAvatar) || // Ensure it's a player
    !room ||
    !data ||
    !data.targetId
  ) {
    // console.warn("Invalid interact request:", { socketId: socket.id, data });
    return; // Fail silently if basic conditions aren't met
  }

  const targetId = String(data.targetId);

  // Find the target object within the current room using the runtime ID
  let targetObject = null;
  for (const key in room.avatars) {
    const potentialTarget = room.avatars[key];
    if (potentialTarget && String(potentialTarget.id) === targetId) {
      targetObject = potentialTarget;
      break;
    }
  }

  // Check if the target is specifically an NPC
  if (targetObject instanceof ServerNPC) {
    const npc = targetObject; // Rename for clarity

    // Optional: Distance check (adjust threshold as needed)
    const dx = Math.abs(playerAvatar.x - npc.x);
    const dy = Math.abs(playerAvatar.y - npc.y);
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance > 3) {
      // Allow interaction within ~3 tiles
      socket.emit("action_failed", {
        action: "interact",
        reason: "Too far away.",
      });
      return;
    }

    // Call the NPC's interact method, which now returns results
    const interactionResult = npc.interact(playerAvatar);

    if (interactionResult) {
      // Handle Dialogue
      if (interactionResult.interaction && interactionResult.dialogue) {
        // Send dialogue ONLY to the interacting player's socket
        socket.emit("chat_message", {
          avatarId: String(npc.id), // Send NPC's runtime ID
          avatarName: escapeHtml(npc.name),
          text: interactionResult.dialogue, // Use the returned dialogue
          isNPC: true,
          className: "npc-dialogue", // Add specific class
        });
      } else if (
        !interactionResult.interaction &&
        !interactionResult.directionChanged
      ) {
        // If interact returned a non-null result but interaction is false AND direction didn't change
        // (This case is unlikely with the current interact logic but added for completeness)
        socket.emit("chat_message", {
          avatarName: "Server",
          text: `${escapeHtml(npc.name)} doesn't respond.`,
          className: "info-msg",
        });
      }

      // Handle Direction Change Broadcast
      if (interactionResult.directionChanged) {
        // Broadcast the NPC's updated state (specifically direction) to the room
        io.to(room.id).emit("npc_update", npc.toDTO());
      }
    } else {
      // interact() returned null (no dialogue, no turn)
      socket.emit("chat_message", {
        avatarName: "Server",
        text: `${escapeHtml(npc.name)} doesn't respond.`,
        className: "info-msg",
      });
    }
  } else if (targetObject instanceof ServerAvatar) {
    // Interaction target was another player avatar
    console.log(
      `${playerAvatar.name} tried to interact with player ${targetObject.name}. Sending profile request instead.`
    );
    // Optionally trigger profile view or other player-player interaction
    handleRequestProfile(socket, { avatarId: targetId }); // Reuse profile handler
  } else {
    // Target ID didn't correspond to an NPC or Player Avatar in the room
    // console.log(`Interaction request for unknown/invalid target ${targetId} ignored.`);
    socket.emit("action_failed", {
      action: "interact",
      reason: "Cannot interact with that.",
    });
  }
}

// --- Trade Handlers ---

function handleRequestTradeInitiate(socket, data) {
  const { avatar: requesterAvatar, room: requesterRoom } = getAvatarAndRoom(
    socket.id
  );
  if (
    !requesterAvatar ||
    !(requesterAvatar instanceof ServerAvatar) ||
    !requesterRoom ||
    !data ||
    !data.targetId
  ) {
    socket.emit("trade_error", { reason: "Invalid trade request." });
    return;
  }
  if (findTradeBySocketId(socket.id)) {
    socket.emit("trade_error", { reason: "You are already trading." });
    return;
  }
  const targetAvatarId = String(data.targetId);
  const { avatar: targetAvatar, room: targetRoom } = findAvatarGlobally(
    null,
    targetAvatarId
  ); // Find globally by runtime ID

  if (!targetAvatar || !(targetAvatar instanceof ServerAvatar)) {
    socket.emit("trade_error", { reason: "Target player not found." });
    return;
  }
  if (findTradeBySocketId(targetAvatar.socketId)) {
    socket.emit("trade_error", {
      reason: `${escapeHtml(targetAvatar.name)} is busy.`,
    });
    return;
  }
  if (requesterRoom.id !== targetRoom?.id) {
    // Ensure target is in a room and it matches
    socket.emit("trade_error", { reason: "Must be in the same room." });
    return;
  }
  if (requesterAvatar.id === targetAvatar.id) {
    socket.emit("trade_error", { reason: "Cannot trade yourself." });
    return;
  }

  const tradeId = generateTradeId();
  const p1Info = getParticipantInfo(socket.id);
  const p2Info = getParticipantInfo(targetAvatar.socketId);

  if (!p1Info || !p2Info) {
    console.error(`Failed get participant info for trade ${tradeId}`);
    socket.emit("trade_error", { reason: "Server error initiating trade." });
    return;
  }

  activeTrades.set(tradeId, {
    tradeId: tradeId,
    p1: p1Info,
    p2: p2Info,
    startTime: Date.now(),
  });
  console.log(
    `Trade initiated: ${tradeId} between ${p1Info.name} and ${p2Info.name}`
  );

  const targetSocket = clients[targetAvatar.socketId]?.socket;
  if (targetSocket) {
    targetSocket.emit("trade_request_incoming", {
      tradeId: tradeId,
      requesterId: String(requesterAvatar.id),
      requesterName: requesterAvatar.name,
    });
    socket.emit("chat_message", {
      // Use notification system
      avatarName: "Server",
      text: `Waiting for ${escapeHtml(targetAvatar.name)} to respond...`,
      className: "info-msg",
    });
  } else {
    console.error(
      `Failed find socket ${targetAvatar.socketId} for trade request.`
    );
    activeTrades.delete(tradeId); // Clean up initiated trade
    socket.emit("trade_error", { reason: "Could not send trade request." });
  }
}

function handleTradeRequestResponse(socket, data) {
  const { avatar: responderAvatar } = getAvatarAndRoom(socket.id);
  if (
    !responderAvatar ||
    !(responderAvatar instanceof ServerAvatar) ||
    !data ||
    !data.tradeId
  )
    return;

  const tradeId = data.tradeId;
  const trade = activeTrades.get(tradeId);

  // Ensure the responder is actually P2 of this trade
  if (!trade || trade.p2.socketId !== socket.id) {
    console.warn(
      `Received trade response from invalid socket ${socket.id} for trade ${tradeId}`
    );
    return;
  }

  const requesterSocket = clients[trade.p1.socketId]?.socket;

  if (data.accepted) {
    console.log(`Trade ${tradeId} accepted by ${responderAvatar.name}.`);
    // Notify both clients to start the trade UI
    if (requesterSocket) {
      requesterSocket.emit("trade_start", {
        tradeId: trade.tradeId,
        partnerId: String(trade.p2.avatarId),
        partnerName: trade.p2.name,
      });
    }
    socket.emit("trade_start", {
      // Notify responder too
      tradeId: trade.tradeId,
      partnerId: String(trade.p1.avatarId),
      partnerName: trade.p1.name,
    });
  } else {
    console.log(`Trade ${tradeId} declined by ${responderAvatar.name}.`);
    activeTrades.delete(tradeId); // Remove declined trade
    if (requesterSocket) {
      requesterSocket.emit("trade_cancelled", {
        tradeId: tradeId,
        reason: `${escapeHtml(responderAvatar.name)} declined the trade.`,
      });
    }
    // No notification needed for the decliner usually
  }
}

function handleTradeUpdateOffer(socket, data) {
  const trade = findTradeBySocketId(socket.id);
  if (
    !trade ||
    !data ||
    data.tradeId !== trade.tradeId ||
    !data.items ||
    data.currency == null
  ) {
    console.warn(`Invalid trade_update_offer from ${socket.id}`);
    return; // Ignore invalid updates
  }

  const isP1 = trade.p1.socketId === socket.id;
  const playerState = isP1 ? trade.p1 : trade.p2;
  const { avatar: playerAvatar } = getAvatarAndRoom(socket.id);
  if (!playerAvatar) {
    endTradeSession(trade.tradeId, "Player data lost during offer update.");
    return;
  }

  // --- Server-Side Validation of Offer ---
  const newItems = data.items;
  const newCurrency = Math.max(0, parseInt(data.currency, 10) || 0);
  let validationError = null;

  if (newCurrency > playerAvatar.currency) {
    validationError = "Insufficient coins.";
  } else {
    for (const itemId in newItems) {
      const offeredQty = parseInt(newItems[itemId], 10);
      if (isNaN(offeredQty) || offeredQty <= 0) {
        delete newItems[itemId]; // Clean up invalid entries
        continue;
      }
      if (!playerAvatar.hasItem(itemId, offeredQty)) {
        const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === itemId
        );
        validationError = `Insufficient quantity of ${escapeHtml(
          def?.name || itemId
        )}.`;
        break;
      }
    }
  }

  if (validationError) {
    socket.emit("trade_error", { reason: validationError });
    // Optionally reset the offer on server/client? For now, just reject the update.
    return;
  }
  // --- End Validation ---

  // Update the offer and reset confirmations
  playerState.offer.items = newItems; // Use validated items
  playerState.offer.currency = newCurrency; // Use validated currency
  trade.p1.confirmed = false;
  trade.p2.confirmed = false;

  console.log(
    `Trade ${trade.tradeId}: ${playerState.name} updated offer. Reset confirmations.`
  );

  // Notify both clients about the offer update AND the confirmation reset
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;

  // Payload for updating the specific offer (send the correct offer to each)
  const p1OfferPayload = {
    tradeId: trade.tradeId,
    isMyOffer: true,
    offer: trade.p1.offer,
  };
  const p2OfferPayload = {
    tradeId: trade.tradeId,
    isMyOffer: true,
    offer: trade.p2.offer,
  }; // isMyOffer is true for P2's perspective
  const partnerOfferForP1 = {
    tradeId: trade.tradeId,
    isMyOffer: false,
    offer: trade.p2.offer,
  };
  const partnerOfferForP2 = {
    tradeId: trade.tradeId,
    isMyOffer: false,
    offer: trade.p1.offer,
  };

  // Payload for resetting confirmations (same for both)
  const confirmResetPayload = {
    tradeId: trade.tradeId,
    myConfirmed: false,
    partnerConfirmed: false,
  };

  if (p1Socket) {
    if (isP1) p1Socket.emit("trade_offer_update", p1OfferPayload);
    // P1 updated their own offer
    else p1Socket.emit("trade_offer_update", partnerOfferForP1); // P1 sees P2's updated offer
    p1Socket.emit("trade_confirm_update", confirmResetPayload); // Reset confirm status
  }
  if (p2Socket) {
    if (!isP1) p2Socket.emit("trade_offer_update", p2OfferPayload);
    // P2 updated their own offer
    else p2Socket.emit("trade_offer_update", partnerOfferForP2); // P2 sees P1's updated offer
    p2Socket.emit("trade_confirm_update", confirmResetPayload); // Reset confirm status
  }
}

// --- Trade Confirm Handler (ASYNC - Requires DB Transaction Logic) ---
async function handleTradeConfirmOffer(socket, data) {
  const trade = findTradeBySocketId(socket.id);
  if (!trade || !data || data.tradeId !== trade.tradeId) return;

  const isP1 = trade.p1.socketId === socket.id;
  const playerState = isP1 ? trade.p1 : trade.p2;

  if (playerState.confirmed) {
    console.log(
      `Trade ${trade.tradeId}: ${playerState.name} tried to re-confirm.`
    );
    return; // Ignore re-confirmation
  }

  playerState.confirmed = true;
  console.log(`Trade ${trade.tradeId}: ${playerState.name} confirmed.`);

  // --- Notify both clients about confirmation status ---
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;
  const p1ConfirmPayload = {
    tradeId: trade.tradeId,
    myConfirmed: trade.p1.confirmed,
    partnerConfirmed: trade.p2.confirmed,
  };
  const p2ConfirmPayload = {
    tradeId: trade.tradeId,
    myConfirmed: trade.p2.confirmed,
    partnerConfirmed: trade.p1.confirmed,
  };
  if (p1Socket) p1Socket.emit("trade_confirm_update", p1ConfirmPayload);
  if (p2Socket) p2Socket.emit("trade_confirm_update", p2ConfirmPayload);

  // --- Execute Trade if Both Confirmed ---
  if (trade.p1.confirmed && trade.p2.confirmed) {
    console.log(`Trade ${trade.tradeId}: Both confirmed. Executing...`);
    const { avatar: p1Avatar } = getAvatarAndRoom(trade.p1.socketId);
    const { avatar: p2Avatar } = getAvatarAndRoom(trade.p2.socketId);

    // --- Final Validation ---
    let errorReason = null;
    if (!p1Avatar || !p2Avatar)
      errorReason = "One or both players disconnected.";
    else if (p1Avatar.currency < trade.p1.offer.currency)
      errorReason = `${escapeHtml(p1Avatar.name)} has insufficient coins.`;
    else if (p2Avatar.currency < trade.p2.offer.currency)
      errorReason = `${escapeHtml(p2Avatar.name)} has insufficient coins.`;
    else {
      // Validate P1 items
      for (const itemId in trade.p1.offer.items) {
        if (!p1Avatar.hasItem(itemId, trade.p1.offer.items[itemId])) {
          const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
            (d) => d.id === itemId
          );
          errorReason = `${escapeHtml(
            p1Avatar.name
          )} no longer has sufficient ${escapeHtml(def?.name || itemId)}.`;
          break;
        }
      }
      // Validate P2 items
      if (!errorReason) {
        for (const itemId in trade.p2.offer.items) {
          if (!p2Avatar.hasItem(itemId, trade.p2.offer.items[itemId])) {
            const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
              (d) => d.id === itemId
            );
            errorReason = `${escapeHtml(
              p2Avatar.name
            )} no longer has sufficient ${escapeHtml(def?.name || itemId)}.`;
            break;
          }
        }
      }
    }

    if (errorReason) {
      console.error(
        `Trade ${trade.tradeId} failed final validation: ${errorReason}`
      );
      endTradeSession(trade.tradeId, `Trade failed: ${errorReason}`);
      return;
    }
    // --- End Final Validation ---

    // --- Perform Exchange using Mongoose Transaction ---
    const session = await mongoose.startSession();
    session.startTransaction();
    console.log(`Trade ${trade.tradeId}: Started DB transaction.`);

    try {
      // Prepare update operations within the transaction context
      const p1CurrencyChange =
        trade.p2.offer.currency - trade.p1.offer.currency;
      const p2CurrencyChange =
        trade.p1.offer.currency - trade.p2.offer.currency;

      const p1InvUpdates = {};
      const p2InvUpdates = {};
      for (const itemId in trade.p1.offer.items)
        p1InvUpdates[`inventory.${itemId}`] = -trade.p1.offer.items[itemId];
      for (const itemId in trade.p2.offer.items)
        p1InvUpdates[`inventory.${itemId}`] =
          (p1InvUpdates[`inventory.${itemId}`] || 0) +
          trade.p2.offer.items[itemId];
      for (const itemId in trade.p2.offer.items)
        p2InvUpdates[`inventory.${itemId}`] = -trade.p2.offer.items[itemId];
      for (const itemId in trade.p1.offer.items)
        p2InvUpdates[`inventory.${itemId}`] =
          (p2InvUpdates[`inventory.${itemId}`] || 0) +
          trade.p1.offer.items[itemId];

      const p1Ops = { $inc: { currency: p1CurrencyChange, ...p1InvUpdates } };
      const p2Ops = { $inc: { currency: p2CurrencyChange, ...p2InvUpdates } };

      // Execute updates within the session
      await User.findByIdAndUpdate(trade.p1.userId, p1Ops, { session });
      console.log(
        `Trade ${trade.tradeId}: Updated P1 (${trade.p1.userId}) within transaction.`
      );
      await User.findByIdAndUpdate(trade.p2.userId, p2Ops, { session });
      console.log(
        `Trade ${trade.tradeId}: Updated P2 (${trade.p2.userId}) within transaction.`
      );

      // Prune zero/negative items after increments (still within transaction)
      const finalP1 = await User.findById(trade.p1.userId).session(session);
      const finalP2 = await User.findById(trade.p2.userId).session(session);
      const p1Unsets = {};
      const p2Unsets = {};
      if (finalP1?.inventory)
        finalP1.inventory.forEach((v, k) => {
          if (v <= 0) p1Unsets[`inventory.${k}`] = "";
        });
      if (finalP2?.inventory)
        finalP2.inventory.forEach((v, k) => {
          if (v <= 0) p2Unsets[`inventory.${k}`] = "";
        });

      if (Object.keys(p1Unsets).length > 0)
        await User.findByIdAndUpdate(
          trade.p1.userId,
          { $unset: p1Unsets },
          { session }
        );
      if (Object.keys(p2Unsets).length > 0)
        await User.findByIdAndUpdate(
          trade.p2.userId,
          { $unset: p2Unsets },
          { session }
        );
      console.log(
        `Trade ${trade.tradeId}: Pruned zero items within transaction (if any).`
      );

      // If all DB operations succeed, commit the transaction
      await session.commitTransaction();
      console.log(`Trade ${trade.tradeId}: DB transaction committed.`);

      // --- Update In-Memory State AFTER successful DB commit ---
      p1Avatar.currency += p1CurrencyChange;
      p2Avatar.currency += p2CurrencyChange;
      for (const itemId in trade.p1.offer.items) {
        p1Avatar.removeItem(itemId, trade.p1.offer.items[itemId]);
        p2Avatar.addItem(itemId, trade.p1.offer.items[itemId]);
      }
      for (const itemId in trade.p2.offer.items) {
        p2Avatar.removeItem(itemId, trade.p2.offer.items[itemId]);
        p1Avatar.addItem(itemId, trade.p2.offer.items[itemId]);
      }
      console.log(`Trade ${trade.tradeId}: Updated in-memory avatar states.`);

      // --- Notify Clients of Success ---
      const completeMsg = {
        tradeId: trade.tradeId,
        message: "Trade completed successfully!",
      };
      if (p1Socket) {
        p1Socket.emit("trade_complete", completeMsg);
        p1Socket.emit("currency_update", { currency: p1Avatar.currency });
        p1Socket.emit("inventory_update", p1Avatar.getInventoryDTO());
      }
      if (p2Socket) {
        p2Socket.emit("trade_complete", completeMsg);
        p2Socket.emit("currency_update", { currency: p2Avatar.currency });
        p2Socket.emit("inventory_update", p2Avatar.getInventoryDTO());
      }

      // Clean up trade session
      activeTrades.delete(trade.tradeId);
      console.log(`Trade ${trade.tradeId}: Completed and cleaned up.`);
    } catch (error) {
      // If any error occurs during the transaction, abort it
      console.error(
        `Trade ${trade.tradeId}: Transaction Error - Aborting.`,
        error
      );
      await session.abortTransaction();
      console.log(`Trade ${trade.tradeId}: DB transaction aborted.`);
      // Notify users the trade failed
      endTradeSession(trade.tradeId, "Server error during finalization.");
    } finally {
      // End the session regardless of success or failure
      await session.endSession();
      console.log(`Trade ${trade.tradeId}: DB session ended.`);
    }
  } // End if (both confirmed)
} // --- End handleTradeConfirmOffer ---

function handleTradeCancel(socket, data) {
  const trade = findTradeBySocketId(socket.id);
  if (!trade || !data || data.tradeId !== trade.tradeId) return; // Ignore if trade not found or ID mismatch

  const cancellerName =
    (trade.p1.socketId === socket.id ? trade.p1.name : trade.p2.name) ||
    "Player";
  console.log(`Trade ${trade.tradeId} cancelled by ${cancellerName}.`);

  // End the session, notifying the other player who cancelled
  endTradeSession(trade.tradeId, "Trade cancelled.", socket.id);
}

// --- Disconnect Handler (ASYNC) ---
async function handleDisconnect(socket, reason) {
  // --- Cancel Active Trade ---
  const ongoingTrade = findTradeBySocketId(socket.id);
  if (ongoingTrade) {
    console.log(
      `Player ${socket.id} disconnected during trade ${ongoingTrade.tradeId}. Cancelling trade.`
    );
    endTradeSession(ongoingTrade.tradeId, "Player disconnected.");
  }
  // --- End Trade Cancellation ---

  console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
  const clientInfo = clients[socket.id];
  let avatar = null,
    currentRoom = null,
    userIdToSave = null;

  if (clientInfo && clientInfo.userId) {
    userIdToSave = clientInfo.userId;
    // Try to get avatar/room info even if avatarId is null temporarily
    try {
      const findResult = getAvatarAndRoom(socket.id);
      avatar = findResult.avatar;
      currentRoom = findResult.room;
    } catch (e) {
      console.error(
        `Error finding avatar/room during disconnect for ${socket.id}: ${e.message}`
      );
    }
    if (!avatar && clientInfo.avatarId !== null) {
      console.warn(
        `Disconnect: Avatar instance for ID ${clientInfo.avatarId} not found, but was expected for User ${userIdToSave}.`
      );
    }
  } else {
    console.log(
      `Disconnect: Socket ${socket.id} had no clientInfo or userId. Cannot save state.`
    );
  }

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
      console.log(`Saving data for user ${userIdToSave} (${avatar.name})...`);
      await updateUser(userIdToSave, playerState);
      console.log(` -> Data saved successfully for user ${userIdToSave}.`);
    } catch (error) {
      console.error(
        `Error saving data for user ${userIdToSave} on disconnect:`,
        error
      );
    }
  } else if (userIdToSave) {
    console.warn(
      `Disconnect: Could not save state for user ${userIdToSave}, avatar instance unavailable.`
    );
  }
  // --- End Save Player Data ---

  // --- Remove from Room State & Broadcast ---
  if (avatar && currentRoom) {
    const removed = currentRoom.removeAvatar(socket.id); // Use socketId for players
    if (removed) {
      io.to(currentRoom.id).emit("avatar_removed", { id: String(avatar.id) });
      console.log(
        `Avatar ${avatar.name} (ID:${avatar.id}) removed from room ${currentRoom.id}.`
      );
      io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList()); // Update user list in the room they left
    } else {
      console.warn(
        `Disconnect: Avatar ${avatar.id} not found in room ${currentRoom.id} map during removal.`
      );
    }
  }

  // --- Clean up client tracking ---
  if (clients[socket.id]) {
    delete clients[socket.id];
  }
}

// --- Connect Error Handler ---
function handleConnectError(socket, err) {
  console.error(
    `Socket connect_error for ${socket?.id || "unknown"}: ${err.message}`
  );
  // Ensure disconnect logic runs even if socket object is partially formed
  handleDisconnect(
    socket || { id: `error_${Date.now()}` },
    `Connection error: ${err.message}`
  ); // Async
}

module.exports = {
  initializeHandlers,
  handleConnection, // Async
  handleChangeRoom,
};
