"use strict";

// --- Application Modules ---
const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const { ServerAvatar, ServerFurniture } = require("./lib/game_objects");
const { rotateDirection, escapeHtml } = require("./lib/utils");
const Furniture = require("./models/furniture"); // Database model
const User = require("./models/user"); // Import User model
const { findAvatarGlobally } = require("./server_console");
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

// --- NEW Trade State Management ---
const activeTrades = new Map(); // tradeId -> { tradeId, p1: { socketId, userId, avatarId, name, offer: {items, currency}, confirmed }, p2: { ... }, startTime }

function generateTradeId() {
  return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Helper to get trade participant info
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

// Helper to find which trade a socket is involved in
function findTradeBySocketId(socketId) {
  for (const trade of activeTrades.values()) {
    if (trade.p1.socketId === socketId || trade.p2.socketId === socketId) {
      return trade;
    }
  }
  return null;
}

// Helper to safely end a trade and notify participants
function endTradeSession(tradeId, reason, notifySocketId = null) {
  const trade = activeTrades.get(tradeId);
  if (!trade) return;

  console.log(`Ending trade ${tradeId}. Reason: ${reason}`);
  activeTrades.delete(tradeId); // Remove from active trades

  // Notify both participants
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;

  if (p1Socket) p1Socket.emit("trade_cancelled", { tradeId, reason });
  if (p2Socket) p2Socket.emit("trade_cancelled", { tradeId, reason });

  // If initiated by one player (e.g., cancel button), send specific error to other
  if (notifySocketId) {
    const otherSocket =
      notifySocketId === trade.p1.socketId ? p2Socket : p1Socket;
    const initiatorName =
      notifySocketId === trade.p1.socketId ? trade.p1.name : trade.p2.name;
    if (otherSocket) {
      // Overwrite generic reason for the other player
      otherSocket.emit("trade_cancelled", {
        tradeId,
        reason: `${escapeHtml(initiatorName)} cancelled the trade.`,
      });
    }
  }
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
      // Check if avatar exists in this room's avatars map
      const potentialAvatar = Object.values(r.avatars).find(
        (a) => a && a.id === avatarId
      );
      if (potentialAvatar) {
        avatar = potentialAvatar;
        roomId = id;
        if (avatar.roomId !== roomId) {
          console.warn(
            `Consistency Warning: Avatar ${avatarId}(${avatar.name}) found in room ${roomId} structure, but avatar.roomId is ${avatar.roomId}. Correcting.`
          );
          avatar.roomId = roomId;
        }
        break; // Found the avatar, stop searching rooms
      }
    }
  }

  if (!avatar) {
    // Avatar ID exists in clients map but avatar not found in any room - possible inconsistency
    console.warn(
      `getAvatarAndRoom: Avatar ID ${avatarId} tracked for socket ${socketId}, but avatar instance not found in any room.`
    );
    return { avatar: null, room: null, socket: clientInfo.socket };
  }

  // Now we have the avatar, get its room directly
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

// --- Handler for Room List Request ---
function handleRequestPublicRooms(socket) {
  const roomListData = [];
  const sortedRoomIds = Array.from(rooms.keys()).sort();

  sortedRoomIds.forEach((roomId) => {
    const room = rooms.get(roomId);
    if (room) {
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
      // If default room STILL doesn't exist
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
    // Check game object classes loaded
    console.error(
      "FATAL: Server game object classes not loaded. Cannot create avatar."
    );
    socket.emit("auth_error", "Server error during player initialization.");
    socket.disconnect(true);
    if (clients[socket.id]) delete clients[socket.id];
    return;
  }

  // Create and configure the new avatar
  const newAvatar = new ServerAvatar(
    spawnPoint.x,
    spawnPoint.y,
    userData.username || `User_${socket.id.substring(0, 4)}`,
    socket.id
  );
  newAvatar.isAdmin = socket.isAdmin; // Set admin status on avatar instance
  newAvatar.currency = userData.currency ?? SHARED_CONFIG.DEFAULT_CURRENCY;
  newAvatar.inventory = new Map(Object.entries(userData.inventory || {}));
  newAvatar.bodyColor = userData.bodyColor || "#6CA0DC";
  newAvatar.z = userData.lastZ ?? SHARED_CONFIG.AVATAR_DEFAULT_Z;
  newAvatar.roomId = room.id; // Set initial room ID

  clients[socket.id].avatarId = newAvatar.id; // Store runtime ID in clients map

  // Send initial state to the connecting client
  socket.emit("your_persistent_id", String(userData._id)); // Send DB user ID
  socket.join(room.id); // Join the Socket.IO room for broadcasts
  console.log(`Socket ${socket.id} joined Socket.IO room: ${room.id}`);

  room.addAvatar(newAvatar); // Add avatar to the room's internal state
  console.log(
    `Avatar ${newAvatar.name} (RuntimeID:${newAvatar.id}, UserID: ${socket.userId}) added to room ${room.id} state.`
  );

  // Send initial game state relevant to the player
  socket.emit("room_state", room.getStateDTO());
  socket.emit("your_avatar_id", String(newAvatar.id)); // Send runtime avatar ID
  socket.emit("inventory_update", newAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: newAvatar.currency });

  // Broadcast the new avatar's arrival to others in the room
  socket.to(room.id).emit("avatar_added", newAvatar.toDTO());
  console.log(
    ` -> Broadcast 'avatar_added' for ${newAvatar.name} to room ${room.id}.`
  );

  // Send updated user list to everyone in the room
  io.to(room.id).emit("user_list_update", room.getUserList());

  // Attach Event Listeners for this socket
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
  socket.on("request_public_rooms", () => handleRequestPublicRooms(socket));
  // Add Trade Listeners
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
  );
  socket.on("trade_cancel", (data) => handleTradeCancel(socket, data));
  // Lifecycle listeners
  socket.on("disconnect", (reason) => handleDisconnect(socket, reason));
  socket.on("connect_error", (err) => handleConnectError(socket, err)); // Less common but good practice
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
  if (!avatar || !room || typeof message !== "string") return;
  const trimmedMessage = message.trim().substring(0, 150); // Limit message length
  const safeMessage = escapeHtml(trimmedMessage); // Sanitize
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
    let broadcastUpdate = true; // Whether to broadcast avatar_update after command
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
        return; // Exit after handling admin command
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
          if (targetAvatarKick && clients[targetAvatarKick.socketId]) {
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
              reason: `User '${escapeHtml(targetNameKick)}' not found.`,
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
    // Broadcast avatar update if needed (e.g., after emote or color change)
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
      isAdmin: avatar.isAdmin, // Include admin status
      className: avatar.isAdmin ? "admin-msg" : "", // Add class if admin
    });
  }
} // --- End handleSendChat ---

// --- Place Furniture Handler (ASYNC with Rollback Logic) ---
async function handleRequestPlaceFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
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
    definition: definition,
  };
  const occupiedTiles =
    ServerFurniture.prototype.getOccupiedTiles.call(tempFurniProto);
  const placeZ =
    room.getStackHeightAt(gridX, gridY) + (definition.zOffset || 0);

  for (const tile of occupiedTiles) {
    if (!room.isValidTile(tile.x, tile.y)) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot place on invalid tile (${tile.x},${tile.y}).`,
      });
      return;
    }
    if (!definition.isFlat) {
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
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = placeZ + (definition.isFlat ? 0 : itemStackContrib);
  const epsilon = 0.001;
  if (itemTopZ >= SHARED_CONFIG.MAX_STACK_Z - epsilon) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Stack height limit reached.`,
    });
    return;
  }
  // --- End Validation ---

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
      throw new Error("DB create failed.");
    console.log(
      `[DB Create OK] Room ${room.id}: ${definition.name} (ID: ${savedDocument._id})`
    );

    // 2. Remove from inventory
    if (avatar.removeItem(data.definitionId, 1)) {
      console.log(
        `[Inv Remove OK] User ${avatar.name}: Removed 1x ${data.definitionId}`
      );
      // 3. Add to Memory & Broadcast
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
          `CRITICAL ERROR: Failed create ServerFurniture ${savedDocument._id} AFTER DB create & inv removal!`,
          memError
        );
        socket.emit("action_failed", {
          action: "place",
          reason: "Critical server error.",
        });
      }
    } else {
      // Inventory Remove FAILED
      console.error(
        `CRITICAL ERROR: Failed remove item ${data.definitionId} AFTER creating DB doc ${savedDocument._id}! Attempting DB compensation.`
      );
      try {
        await Furniture.findByIdAndDelete(savedDocument._id);
        console.log(`[COMPENSATION] Deleted DB doc ${savedDocument._id}.`);
      } catch (deleteError) {
        console.error(
          `[COMPENSATION FAILED] Could not delete DB doc ${savedDocument._id}! Manual cleanup needed.`,
          deleteError
        );
      }
      socket.emit("action_failed", {
        action: "place",
        reason: "Inventory error (Rolled back).",
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
  const newRotation = rotateDirection(furni.rotation, 2);
  if (oldRotation === newRotation) return;
  try {
    // 1. Update DB
    const updatedDoc = await Furniture.findByIdAndUpdate(
      furniId,
      { $set: { rotation: newRotation } },
      { new: false }
    );
    if (!updatedDoc) throw new Error("Doc not found during update.");
    // 2. Update Memory
    furni.rotation = newRotation;
    // 3. Broadcast & Update Seated
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
  // Validation
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
    itemsOnTop.sort((a, b) => a.z - b.z);
    socket.emit("action_failed", {
      action: "pickup",
      reason: `Cannot pick up, '${itemsOnTop[0].name}' is on top.`,
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

  const furniDataForRecreation = furniInstance.toDBSaveObject();
  const definitionIdToRefund = furniInstance.definitionId;

  try {
    // --- Pickup Transaction ---
    // 1. Delete DB
    const deleteResult = await Furniture.findByIdAndDelete(furniId);
    if (!deleteResult) {
      // Item not in DB
      console.warn(
        `[DB Delete NF] Pickup requested for ${furniId}, but not found.`
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
    // 2. Remove Memory
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
      // 4. Broadcast & Notify Client
      io.to(room.id).emit("furni_removed", { id: furniId });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      console.log(`[Pickup Success] Broadcasted furni_removed for ${furniId}`);
    } else {
      // Inventory Add FAILED
      console.error(
        `CRITICAL ERROR: Failed add item ${definitionIdToRefund} (DB ID: ${furniId}) AFTER DB delete! Attempting DB compensation.`
      );
      try {
        furniDataForRecreation.ownerId = clientInfo?.userId || null; // Add ownerId back
        await Furniture.create(furniDataForRecreation);
        console.log(`[COMPENSATION] Re-created DB document for ${furniId}.`);
        const recreatedInstance = new ServerFurniture(
          furniDataForRecreation.definitionId,
          furniDataForRecreation.x,
          furniDataForRecreation.y,
          furniDataForRecreation.z,
          furniDataForRecreation.rotation,
          furniId,
          furniDataForRecreation.ownerId,
          furniDataForRecreation.state,
          furniDataForRecreation.colorOverride
        );
        room.addFurniture(recreatedInstance);
        io.to(room.id).emit("furni_added", recreatedInstance.toDTO());
        console.log(`[COMPENSATION] Re-added instance ${furniId} to memory.`);
      } catch (recreateError) {
        console.error(
          `[COMPENSATION FAILED] Could not re-create DB/memory for ${furniId}! Manual cleanup needed.`,
          recreateError
        );
      }
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Inventory error (Rolled back).",
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
  const sitAction = { type: "sit", targetId: furniId };
  if (currentX === interactionSpot.x && currentY === interactionSpot.y) {
    if (avatar.executeSit(furni, room))
      io.to(room.id).emit("avatar_update", avatar.toDTO());
    else
      socket.emit("action_failed", { action: "sit", reason: "Failed to sit." });
  } else {
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
  const targetAvatarId = String(data.avatarId);
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
  const useResult = furni.use(avatar, room);
  if (useResult.changed && useResult.updatePayload) {
    try {
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
    }
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
  const targetColor = data.colorHex;
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
  const recolorResult = furni.setColorOverride(targetColor);
  if (recolorResult.changed && recolorResult.updatePayload) {
    try {
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
    }
  } else
    socket.emit("action_failed", {
      action: "recolor",
      reason: "No color change needed.",
    });
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
    console.error(`Shop Error: Item ${itemId} in catalog but not defs!`);
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
    if (avatar.addItem(itemId, 1)) {
      console.log(
        `${avatar.name} bought ${definition.name} for ${price} gold.`
      );
      socket.emit("currency_update", { currency: avatar.currency });
      socket.emit("inventory_update", avatar.getInventoryDTO());
      socket.emit("chat_message", {
        avatarName: "Server",
        text: `You bought 1x ${escapeHtml(definition.name)}!`,
        className: "info-msg",
      });
    } else {
      // Failed inv add, refund
      console.error(
        `Buy Error: Failed add item ${itemId} after taking currency. Refunding.`
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
    console.error(`Buy Error: Failed remove currency ${price}.`);
    socket.emit("action_failed", {
      action: "buy",
      reason: "Currency transaction error.",
    });
  }
}

// --- Room Change Handler ---
function handleChangeRoom(socket, data) {
  // --- Add Trade Cancellation on Room Change ---
  const ongoingTrade = findTradeBySocketId(socket.id);
  if (ongoingTrade) {
    console.log(
      `Player ${socket.id} changed room during trade ${ongoingTrade.tradeId}. Cancelling trade.`
    );
    endTradeSession(ongoingTrade.tradeId, "Player left the room.");
  }
  // --- End Trade Cancellation ---

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
    // Teleport within same room
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
    );
    io.to(targetRoomId).emit("avatar_update", currentAvatar.toDTO());
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
  const targetX = data.targetX ?? -1;
  const targetY = data.targetY ?? -1;
  const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);
  currentAvatar.prepareForRoomChange(targetRoomId, spawnPoint.x, spawnPoint.y);
  targetRoom.addAvatar(currentAvatar);
  socket.join(targetRoomId);
  console.log(` -> Joined Socket.IO room: ${targetRoomId}`);
  socket.emit("room_state", targetRoom.getStateDTO());
  socket.emit("your_avatar_id", String(currentAvatar.id));
  socket.emit("inventory_update", currentAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: currentAvatar.currency });
  socket.to(targetRoomId).emit("avatar_added", currentAvatar.toDTO());
  io.to(targetRoomId).emit("user_list_update", targetRoom.getUserList());
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
    const existingRoom = await RoomState.findOne({ roomId: newRoomId });
    if (existingRoom) {
      socket.emit("action_failed", {
        action: "create_room",
        reason: `Room '${newRoomId}' already exists in DB.`,
      });
      return;
    }
    const newLayout = Array.from({ length: requestedRows }, (_, y) =>
      Array.from({ length: requestedCols }, (_, x) =>
        y === 0 || y === requestedRows - 1 || x === 0 || x === requestedCols - 1
          ? 1
          : 0
      )
    );
    const newRoomState = new RoomState({
      roomId: newRoomId,
      layout: newLayout,
    });
    await newRoomState.save();
    console.log(` -> Saved new room state for '${newRoomId}' to DB.`);
    const newRoomInstance = new ServerRoom(newRoomId);
    newRoomInstance.layout = newLayout;
    newRoomInstance.cols = requestedCols;
    newRoomInstance.rows = requestedRows;
    newRoomInstance.pathfinder = new (require("./lib/pathfinder"))(
      newRoomInstance
    );
    rooms.set(newRoomId, newRoomInstance);
    console.log(` -> Added new room '${newRoomId}' to memory.`);
    socket.emit("chat_message", {
      avatarName: "Server",
      text: `Room '${newRoomId}' created!`,
      className: "info-msg",
    });
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
  const validTypes = [0, 1, 2, "X"];
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
  const avatarOnTile = Object.values(room.avatars).find(
    (a) => Math.round(a.x) === x && Math.round(a.y) === y
  );
  if (avatarOnTile && type !== 0 && type !== 2) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: `Cannot modify under ${avatarOnTile.name}.`,
    });
    return;
  }
  const furnitureOnTile = room.getFurnitureStackAt(x, y).find((f) => !f.isFlat);
  if (furnitureOnTile && type !== 0 && type !== 2) {
    socket.emit("action_failed", {
      action: "modify_layout",
      reason: `Cannot modify under '${furnitureOnTile.name}'.`,
    });
    return;
  }

  let oldType;
  try {
    oldType = room.layout[y][x];
    if (oldType === type) return;
    room.layout[y][x] = type;
    console.log(
      `Admin ${avatar.name} modified layout in ${room.id} at (${x},${y}) from ${oldType} to ${type}.`
    );
    const updatedRoomState = await RoomState.findOneAndUpdate(
      { roomId: room.id },
      { $set: { layout: room.layout } },
      { new: false }
    );
    if (!updatedRoomState) {
      console.error(
        `Consistency Error: Room ${room.id} modified, but not found in DB!`
      );
      room.layout[y][x] = oldType; // Rollback memory
      socket.emit("action_failed", {
        action: "modify_layout",
        reason: "Server consistency error.",
      });
      return;
    }
    console.log(` -> Saved updated layout for '${room.id}' to DB.`);
    io.to(room.id).emit("layout_tile_update", { x, y, type });
  } catch (error) {
    console.error(
      `Error modifying layout for room '${room.id}' at (${x},${y}):`,
      error
    );
    try {
      if (oldType !== undefined) {
        room.layout[y][x] = oldType;
        console.log(` -> Rolled back memory change.`);
      }
    } catch (rollbackError) {
      console.error(` -> Failed rollback:`, rollbackError);
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

// --- NEW Trade Handlers ---

function handleRequestTradeInitiate(socket, data) {
  const { avatar: requesterAvatar, room: requesterRoom } = getAvatarAndRoom(
    socket.id
  );
  if (!requesterAvatar || !requesterRoom || !data || !data.targetId) {
    socket.emit("trade_error", { reason: "Invalid request." });
    return;
  }
  if (findTradeBySocketId(socket.id)) {
    socket.emit("trade_error", { reason: "You are already trading." });
    return;
  }
  const targetAvatarId = String(data.targetId);
  // Correct way to find avatar globally by runtime ID (avatar.id)
  let targetAvatar = null,
    targetRoom = null;
  for (const roomInstance of rooms.values()) {
    const found = Object.values(roomInstance.avatars).find(
      (a) => a && String(a.id) === targetAvatarId
    );
    if (found) {
      targetAvatar = found;
      targetRoom = roomInstance;
      break;
    }
  }

  if (!targetAvatar || !targetRoom) {
    socket.emit("trade_error", { reason: "Target not found." });
    return;
  }
  if (findTradeBySocketId(targetAvatar.socketId)) {
    socket.emit("trade_error", {
      reason: `${escapeHtml(targetAvatar.name)} is busy.`,
    });
    return;
  }
  if (requesterRoom.id !== targetRoom.id) {
    socket.emit("trade_error", { reason: "Must be in same room." });
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
    console.error(`Failed get participant info ${tradeId}`);
    socket.emit("trade_error", { reason: "Server error." });
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
      // Using chat_message event to trigger notification system
      avatarName: "Server", // Or maybe "System"?
      text: `Waiting for ${escapeHtml(targetAvatar.name)} to respond...`,
      className: "info-msg", // Use info class for standard notification style
    });
  } else {
    console.error(`Failed find socket ${targetAvatar.socketId}`);
    activeTrades.delete(tradeId);
    socket.emit("trade_error", { reason: "Could not send request." });
  }
}

function handleTradeRequestResponse(socket, data) {
  const { avatar: responderAvatar } = getAvatarAndRoom(socket.id);
  if (!responderAvatar || !data || !data.tradeId) return;
  const tradeId = data.tradeId;
  const trade = activeTrades.get(tradeId);
  if (!trade || trade.p2.socketId !== socket.id) return;
  const requesterSocket = clients[trade.p1.socketId]?.socket;
  if (data.accepted) {
    console.log(`Trade ${tradeId} accepted by ${responderAvatar.name}.`);
    if (requesterSocket)
      requesterSocket.emit("trade_start", {
        tradeId: trade.tradeId,
        partnerId: String(trade.p2.avatarId),
        partnerName: trade.p2.name,
      });
    socket.emit("trade_start", {
      tradeId: trade.tradeId,
      partnerId: String(trade.p1.avatarId),
      partnerName: trade.p1.name,
    });
  } else {
    console.log(`Trade ${tradeId} declined by ${responderAvatar.name}.`);
    activeTrades.delete(tradeId);
    if (requesterSocket)
      requesterSocket.emit("trade_cancelled", {
        tradeId: tradeId,
        reason: `${escapeHtml(responderAvatar.name)} declined.`,
      });
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
  )
    return;
  const isP1 = trade.p1.socketId === socket.id;
  const playerOffer = isP1 ? trade.p1.offer : trade.p2.offer;
  const { avatar: playerAvatar } = getAvatarAndRoom(socket.id);
  if (!playerAvatar) {
    endTradeSession(trade.tradeId, "Player data lost.");
    return;
  }

  const newItems = data.items;
  const newCurrency = Math.max(0, parseInt(data.currency, 10) || 0);
  let validationError = null;
  if (newCurrency > playerAvatar.currency)
    validationError = "Insufficient coins.";
  if (!validationError) {
    for (const itemId in newItems) {
      const offeredQty = newItems[itemId];
      if (offeredQty <= 0) continue;
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
    return;
  }

  playerOffer.items = newItems;
  playerOffer.currency = newCurrency;
  trade.p1.confirmed = false;
  trade.p2.confirmed = false; // Reset confirmations
  console.log(
    `Trade ${trade.tradeId}: ${
      isP1 ? trade.p1.name : trade.p2.name
    } updated offer.`
  );
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;
  // Prepare payloads tailored for each recipient
  const p1OfferPayload = {
    tradeId: trade.tradeId,
    isMyOffer: isP1, // P1's update is their own if isP1 is true
    offer: isP1 ? trade.p1.offer : trade.p2.offer, // Send the updated offer
  };
  const p2OfferPayload = {
    tradeId: trade.tradeId,
    isMyOffer: !isP1, // P1's update is NOT P2's own offer
    offer: isP1 ? trade.p1.offer : trade.p2.offer, // Send the updated offer
  };

  // Reset confirmation payload (same for both perspectives, as both reset)
  const confirmResetPayload = {
    tradeId: trade.tradeId,
    myConfirmed: false, // Reset my perspective
    partnerConfirmed: false, // Reset partner perspective
  };
  if (p1Socket) {
    p1Socket.emit("trade_offer_update", p1OfferPayload);
    p1Socket.emit("trade_confirm_update", confirmResetPayload); // Send reset confirmation
  }
  if (p2Socket) {
    p2Socket.emit("trade_offer_update", p2OfferPayload);
    p2Socket.emit("trade_confirm_update", confirmResetPayload); // Send reset confirmation
  }
}

async function handleTradeConfirmOffer(socket, data) {
  const trade = findTradeBySocketId(socket.id);

  // Basic validation of the trade and request
  if (!trade || !data || data.tradeId !== trade.tradeId) {
    console.warn(
      `[handleTradeConfirmOffer] Invalid request or trade not found for socket ${socket.id}, data:`,
      data
    );
    // Optionally emit an error back to the client if desired
    // socket.emit('trade_error', { reason: 'Invalid trade confirmation request.' });
    return;
  }

  const isP1 = trade.p1.socketId === socket.id;
  const playerState = isP1 ? trade.p1 : trade.p2;

  // Prevent re-confirming
  if (playerState.confirmed) {
    console.log(
      `Trade ${trade.tradeId}: ${playerState.name} tried to re-confirm.`
    );
    return;
  }

  playerState.confirmed = true;
  console.log(`Trade ${trade.tradeId}: ${playerState.name} confirmed.`);

  // --- Notify both clients about the confirmation status update ---
  const p1Socket = clients[trade.p1.socketId]?.socket;
  const p2Socket = clients[trade.p2.socketId]?.socket;

  // Payload for P1 (my=P1, partner=P2)
  const p1ConfirmPayload = {
    tradeId: trade.tradeId,
    myConfirmed: trade.p1.confirmed,
    partnerConfirmed: trade.p2.confirmed,
  };
  // Payload for P2 (my=P2, partner=P1) - SWAPPED
  const p2ConfirmPayload = {
    tradeId: trade.tradeId,
    myConfirmed: trade.p2.confirmed, // P2's status is 'my' for them
    partnerConfirmed: trade.p1.confirmed, // P1's status is 'partner' for them
  };

  // Emit confirmation update to both players
  if (p1Socket) p1Socket.emit("trade_confirm_update", p1ConfirmPayload);
  if (p2Socket) p2Socket.emit("trade_confirm_update", p2ConfirmPayload);

  // --- Check if both players have confirmed to execute the trade ---
  if (trade.p1.confirmed && trade.p2.confirmed) {
    console.log(`Trade ${trade.tradeId}: Both confirmed. Executing...`);
    const { avatar: p1Avatar } = getAvatarAndRoom(trade.p1.socketId);
    const { avatar: p2Avatar } = getAvatarAndRoom(trade.p2.socketId);

    // --- Final Validation before execution (ensure players/items/currency are still valid) ---
    let errorReason = null;
    if (!p1Avatar || !p2Avatar) {
      errorReason = "One or both players disconnected.";
    } else if (p1Avatar.currency < trade.p1.offer.currency) {
      errorReason = `${escapeHtml(p1Avatar.name)} has insufficient coins.`;
    } else if (p2Avatar.currency < trade.p2.offer.currency) {
      errorReason = `${escapeHtml(p2Avatar.name)} has insufficient coins.`;
    } else {
      // Check items for Player 1
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
      // Check items for Player 2 (only if P1 was ok)
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

    // If validation fails, cancel the trade
    if (errorReason) {
      console.error(
        `Trade ${trade.tradeId} failed final validation before execution: ${errorReason}`
      );
      endTradeSession(trade.tradeId, `Trade failed: ${errorReason}`);
      return;
    }

    // --- Perform Exchange (Database updates WITHOUT Transaction) ---
    // WARNING: These updates are NOT atomic. If an error occurs between
    // updating P1 and P2, the database WILL be INCONSISTENT.
    try {
      console.log(
        `Trade ${trade.tradeId}: Starting DB updates (No Transaction).`
      );

      // 1. Prepare updates (same logic as before transactions)
      const p1CurrencyChange =
        trade.p2.offer.currency - trade.p1.offer.currency;
      const p2CurrencyChange =
        trade.p1.offer.currency - trade.p2.offer.currency;

      const p1Updates = { $inc: { currency: p1CurrencyChange } };
      const p2Updates = { $inc: { currency: p2CurrencyChange } };
      const p1InvUpdates = {}; // Stores $inc values for p1 inventory
      const p2InvUpdates = {}; // Stores $inc values for p2 inventory

      // Calculate inventory changes for Player 1
      for (const itemId in trade.p1.offer.items)
        p1InvUpdates[`inventory.${itemId}`] = -trade.p1.offer.items[itemId]; // Remove P1's offer
      for (const itemId in trade.p2.offer.items)
        p1InvUpdates[`inventory.${itemId}`] =
          (p1InvUpdates[`inventory.${itemId}`] || 0) +
          trade.p2.offer.items[itemId]; // Add P2's offer

      // Calculate inventory changes for Player 2
      for (const itemId in trade.p2.offer.items)
        p2InvUpdates[`inventory.${itemId}`] = -trade.p2.offer.items[itemId]; // Remove P2's offer
      for (const itemId in trade.p1.offer.items)
        p2InvUpdates[`inventory.${itemId}`] =
          (p2InvUpdates[`inventory.${itemId}`] || 0) +
          trade.p1.offer.items[itemId]; // Add P1's offer

      // Combine inventory changes with currency changes
      if (Object.keys(p1InvUpdates).length > 0)
        p1Updates.$inc = { ...p1Updates.$inc, ...p1InvUpdates };
      if (Object.keys(p2InvUpdates).length > 0)
        p2Updates.$inc = { ...p2Updates.$inc, ...p2InvUpdates };

      // 2. Execute updates sequentially (NO LONGER ATOMIC)
      await User.findByIdAndUpdate(trade.p1.userId, p1Updates); // NO {session}
      console.log(
        `Trade ${trade.tradeId}: Updated P1 (${trade.p1.name}, ID: ${trade.p1.userId}) in DB.`
      );

      // --- If an error happens here, P1 is updated but P2 is not ---
      await User.findByIdAndUpdate(trade.p2.userId, p2Updates); // NO {session}
      console.log(
        `Trade ${trade.tradeId}: Updated P2 (${trade.p2.name}, ID: ${trade.p2.userId}) in DB.`
      );

      // 3. Prune zero/negative items after updates (Best effort)
      // Refetch users to get the exact state after increments
      const finalP1 = await User.findById(trade.p1.userId);
      const finalP2 = await User.findById(trade.p2.userId);
      const p1Unsets = {};
      const p2Unsets = {};

      if (finalP1?.inventory) {
        finalP1.inventory.forEach((value, key) => {
          if (value <= 0) p1Unsets[`inventory.${key}`] = "";
        });
      }
      if (finalP2?.inventory) {
        finalP2.inventory.forEach((value, key) => {
          if (value <= 0) p2Unsets[`inventory.${key}`] = "";
        });
      }

      // Execute unsets if needed
      if (Object.keys(p1Unsets).length > 0)
        await User.findByIdAndUpdate(trade.p1.userId, { $unset: p1Unsets }); // NO {session}
      if (Object.keys(p2Unsets).length > 0)
        await User.findByIdAndUpdate(trade.p2.userId, { $unset: p2Unsets }); // NO {session}
      console.log(`Trade ${trade.tradeId}: Pruned zero items in DB (if any).`);

      console.log(`Trade ${trade.tradeId}: DB updates nominally complete.`);

      // 4. Update In-Memory ServerAvatar State
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

      // 5. Notify Clients of Success and Update State
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

      // 6. Clean up active trade
      activeTrades.delete(trade.tradeId);
      console.log(`Trade ${trade.tradeId}: Completed and cleaned up.`);
    } catch (error) {
      // --- Catch block for errors during sequential DB updates ---
      console.error(
        `Trade ${trade.tradeId}: DB Update Error during sequential execution: ${error.message}`
      );
      console.error(error); // Log the full error stack trace

      // IMPORTANT: Database might be INCONSISTENT now.
      console.error(
        `CRITICAL WARNING: Trade ${trade.tradeId} failed mid-execution. Database state between players ${trade.p1.name} and ${trade.p2.name} may be inconsistent!`
      );

      // Notify users the trade failed server-side. They might need support intervention.
      endTradeSession(
        trade.tradeId,
        "Critical server error during finalization. Please contact support if items/currency seem wrong."
      );
    }
    // NO FINALLY block needed as there's no session to end
  }
}

function handleTradeCancel(socket, data) {
  const trade = findTradeBySocketId(socket.id);
  if (!trade || !data || data.tradeId !== trade.tradeId) return;
  console.log(
    `Trade ${trade.tradeId} cancelled by ${
      trade.p1.socketId === socket.id ? trade.p1.name : trade.p2.name
    }.`
  );
  endTradeSession(trade.tradeId, "Trade cancelled.", socket.id);
}

// --- Disconnect Handler (ASYNC) ---
async function handleDisconnect(socket, reason) {
  // --- Add Trade Cancellation on Disconnect ---
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
        `Disconnect: Avatar ${avatar.id} not found in room ${currentRoom.id} map.`
      );
  }
  if (clients[socket.id]) delete clients[socket.id];
}

// --- Connect Error Handler ---
function handleConnectError(socket, err) {
  console.error(
    `Socket connect_error for ${socket?.id || "unknown"}: ${err.message}`
  );
  handleDisconnect(
    socket || { id: `error_${Date.now()}` },
    `Connection error: ${err.message}`
  );
}

module.exports = {
  initializeHandlers,
  handleConnection, // Async
  handleChangeRoom, // Exported for use by console/commands etc.
};
