"use strict";

const { SHARED_CONFIG, SERVER_CONFIG } = require("./lib/config");
const { ServerAvatar, ServerFurniture } = require("./lib/game_objects");
const { rotateDirection } = require("./lib/utils");

// --- Globals passed from server.js ---
let rooms; // Now a Map<roomId, ServerRoom>
let io;
let clients; // Map: socket.id -> { socket, avatarId }

/**
 * Initialize handlers with dependencies.
 * @param {Map<string, ServerRoom>} roomsMap - The map of active room instances.
 * @param {SocketIO.Server} ioInstance - The Socket.IO server instance.
 * @param {object} clientsMap - The map tracking client connections.
 */
function initializeHandlers(roomsMap, ioInstance, clientsMap) {
  rooms = roomsMap; // Store the map of rooms
  io = ioInstance;
  clients = clientsMap;
}

// --- Helper function to get avatar and their current room ---
function getAvatarAndRoom(socketId) {
  const clientInfo = clients[socketId];
  if (!clientInfo || clientInfo.avatarId == null) {
    // console.warn(`getAvatarAndRoom: No clientInfo or avatarId for socket ${socketId}`);
    return { avatar: null, room: null };
  }
  const avatarId = clientInfo.avatarId;

  // Find the avatar across all rooms using their known ID
  let avatar = null;
  let roomId = null;
  for (const [id, r] of rooms.entries()) {
    // Check if avatar exists in this room's map directly
    avatar = Object.values(r.avatars).find((a) => a.id === avatarId);
    if (avatar) {
      roomId = id; // Found the avatar and their room ID
      // Ensure avatar object knows its room - crucial consistency check
      if (avatar.roomId !== roomId) {
        console.warn(
          `Avatar ${avatarId} found in room ${roomId}, but avatar.roomId is ${avatar.roomId}. Correcting.`
        );
        avatar.roomId = roomId; // Correct the avatar's stored room ID
      }
      break;
    }
  }

  if (!avatar) {
    console.warn(
      `getAvatarAndRoom: Could not find avatar object for ID ${avatarId} in any room.`
    );
    // Attempt to find the client's socket to potentially disconnect if needed
    const socket = clientInfo.socket;
    return { avatar: null, room: null, socket: socket }; // Return socket if possible for error handling
  }

  // Now use the confirmed roomId from the avatar object (or the corrected one)
  const currentRoomId = avatar.roomId;
  if (!currentRoomId) {
    console.warn(
      `getAvatarAndRoom: Avatar ${avatarId} found but has no valid roomId property.`
    );
    return { avatar: avatar, room: null, socket: clientInfo.socket }; // Avatar found, but room link broken
  }

  const room = rooms.get(currentRoomId);
  if (!room) {
    console.warn(
      `getAvatarAndRoom: Avatar ${avatarId} has roomId ${currentRoomId}, but room not found in map.`
    );
    return { avatar: avatar, room: null, socket: clientInfo.socket }; // Avatar found, room instance missing
  }

  // Success case
  return { avatar, room, socket: clientInfo.socket };
}

// --- Event Handler Functions ---

function handleConnection(socket) {
  console.log("Client connected:", socket.id);
  clients[socket.id] = { socket: socket, avatarId: null };

  // --- Join Default Room ---
  const defaultRoomId = SERVER_CONFIG.DEFAULT_ROOM_ID;
  const room = rooms.get(defaultRoomId); // Get the specific room instance

  if (!room) {
    console.error(
      `FATAL: Default room '${defaultRoomId}' not found! Cannot spawn player ${socket.id}.`
    );
    socket.disconnect(true); // Disconnect client if default room missing
    delete clients[socket.id]; // Clean up clients map
    return;
  }

  // 1. Send initial room state FOR THE DEFAULT ROOM
  socket.emit("room_state", room.getStateDTO());
  // Furniture definitions are global, send once
  socket.emit("furniture_definitions", SHARED_CONFIG.FURNITURE_DEFINITIONS);

  // 2. Create and add avatar TO THE DEFAULT ROOM
  const spawnPoint = room.findSpawnPoint(); // Find spawn in the specific room
  // Assign next global ID using ServerGameObject static property
  const newAvatar = new ServerAvatar(
    spawnPoint.x,
    spawnPoint.y,
    `User_${socket.id.substring(0, 4)}`,
    null,
    socket.id
  );
  room.addAvatar(newAvatar); // Add to the specific room instance
  clients[socket.id].avatarId = newAvatar.id; // Store assigned avatar ID
  newAvatar.roomId = defaultRoomId; // Set avatar's room ID explicitly

  // 3. Join Socket.IO Room
  socket.join(defaultRoomId);
  console.log(`Socket ${socket.id} joined Socket.IO room: ${defaultRoomId}`);

  // 4. Send client-specific initial state
  socket.emit("your_avatar_id", newAvatar.id);
  socket.emit("inventory_update", newAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: newAvatar.currency });

  // 5. Broadcast new avatar TO THE SPECIFIC ROOM
  // Use io.to() to target clients in the same Socket.IO room
  io.to(defaultRoomId).emit("avatar_added", newAvatar.toDTO());
  console.log(
    `Avatar ${newAvatar.name} (ID:${newAvatar.id}) added to room ${defaultRoomId} for ${socket.id} at (${spawnPoint.x},${spawnPoint.y})`
  );

  // 6. Update user list FOR THAT ROOM
  io.to(defaultRoomId).emit("user_list_update", room.getUserList());

  // --- Attach Event Listeners for this Socket ---
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
  socket.on("request_user_list", () => handleRequestUserList(socket)); // Sends list for current room
  socket.on("request_profile", (data) => handleRequestProfile(socket, data));
  socket.on("request_use_furni", (data) => handleRequestUseFurni(socket, data));
  socket.on("request_recolor_furni", (data) =>
    handleRequestRecolorFurni(socket, data)
  );
  socket.on("request_buy_item", (data) => handleRequestBuyItem(socket, data));
  socket.on("request_change_room", (data) => handleChangeRoom(socket, data)); // NEW HANDLER
  socket.on("disconnect", (reason) => handleDisconnect(socket, reason));
  socket.on("connect_error", (err) => handleConnectError(socket, err));
}

function handleRequestMove(socket, target) {
  const { avatar, room } = getAvatarAndRoom(socket.id); // Use helper
  if (
    !avatar ||
    !room ||
    !target ||
    typeof target.x !== "number" ||
    typeof target.y !== "number"
  ) {
    console.warn(
      `[Move Request Invalid] Socket: ${
        socket.id
      }, Avatar: ${!!avatar}, Room: ${!!room}, Target: ${JSON.stringify(
        target
      )}`
    );
    return;
  }

  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Cannot move while sitting",
    });
    return;
  }

  const endX = Math.round(target.x);
  const endY = Math.round(target.y);

  // Use the specific room's validation
  if (!room.isWalkable(endX, endY)) {
    socket.emit("action_failed", {
      action: "move",
      reason: "Target tile is not walkable",
    });
    // Stop path immediately if walking towards invalid target
    if (avatar.state === SHARED_CONFIG.AVATAR_STATE_WALKING) {
      const oldState = avatar.state;
      avatar.state = SHARED_CONFIG.AVATAR_STATE_IDLE;
      avatar.path = [];
      avatar.actionAfterPath = null;
      avatar.clearEmote(true);
      if (oldState !== avatar.state)
        io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM
    }
    return;
  }

  // Pass the correct room context to moveTo
  if (avatar.moveTo(endX, endY, room)) {
    io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM if state/path changed OR emote cleared
  } else {
    // moveTo returns false if path not found or already there AND state didn't change AND emote wasn't active
    // Ensure the state is 'idle' if pathfinding failed mid-walk previously
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
        io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM
    }
  }
}

function handleSendChat(socket, message) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || typeof message !== "string") return;
  const cleanMessage = message.substring(0, 100).trim(); // Limit length and trim
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

    switch (command) {
      // Specific Emote Commands
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
            reason: `Unknown command: /${command}`,
          });
        } // Should not happen
        break;

      // Generic /emote command
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
        }
        break;

      case "setcolor":
        if (args.length === 1) {
          if (avatar.setBodyColor(args[0])) updateNeeded = true;
          else
            socket.emit("action_failed", {
              action: "setcolor",
              reason: "Invalid color format (#RRGGBB) or no change needed",
            });
        } else {
          socket.emit("action_failed", {
            action: "setcolor",
            reason: "Usage: /setcolor #RRGGBB",
          });
        }
        break;

      // Room Change Command
      case "join":
        if (args.length === 1) {
          const targetRoomId = args[0];
          // Call the dedicated handler
          handleChangeRoom(socket, { targetRoomId });
          updateNeeded = false; // Room change handles its own broadcasts
          broadcastUpdate = false;
        } else {
          socket.emit("action_failed", {
            action: "command",
            reason: "Usage: /join <room_id>",
          });
        }
        break;

      case "myroom": // Debug command
        socket.emit("chat_message", {
          avatarId: null,
          avatarName: "Server",
          text: `You are in room: ${avatar.roomId}`,
          className: "info-msg",
        });
        updateNeeded = false;
        broadcastUpdate = false;
        break;

      default:
        socket.emit("action_failed", {
          action: "command",
          reason: `Unknown command: /${command}`,
        });
        broadcastUpdate = false; // Don't broadcast for unknown commands
    }
    // Broadcast avatar update TO THE ROOM if the command changed state/appearance/emote
    if (updateNeeded && broadcastUpdate) {
      io.to(room.id).emit("avatar_update", avatar.toDTO()); // DTO includes emoteId
    }
  } else {
    // Regular Chat Message - broadcast TO THE ROOM
    console.log(`[${room.id}] Chat from ${avatar.name}: ${cleanMessage}`);
    io.to(room.id).emit("chat_message", {
      avatarId: avatar.id,
      avatarName: avatar.name,
      text: cleanMessage,
    });
  }
}

function handleRequestPlaceFurni(socket, data) {
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
      reason: "Invalid request data",
    });
    return;
  }
  const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
    (d) => d.id === data.definitionId
  );
  if (!definition) {
    socket.emit("action_failed", {
      action: "place",
      reason: "Invalid item definition",
    });
    return;
  }

  // --- Inventory Check ---
  if (!avatar.hasItem(data.definitionId, 1)) {
    socket.emit("action_failed", {
      action: "place",
      reason: "You do not have that item in your inventory",
    });
    return;
  }

  const gridX = Math.round(data.x);
  const gridY = Math.round(data.y);
  const rotation = data.rotation % 8 || 0;

  // --- Placement Validation (using room instance) ---
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    width: definition.width,
    height: definition.height,
  };
  const occupiedTiles =
    ServerFurniture.prototype.getOccupiedTiles.call(tempFurniProto);

  for (const tile of occupiedTiles) {
    // 1. Check tile validity (bounds and layout type)
    if (!room.isValidTile(tile.x, tile.y)) {
      socket.emit("action_failed", {
        action: "place",
        reason: `Cannot place on invalid tile (${tile.x},${tile.y})`,
      });
      return;
    }
    // 2. Check for solid, non-stackable obstruction (unless placing a flat item)
    if (!definition.isFlat) {
      const stack = room.getFurnitureStackAt(tile.x, tile.y);
      const topItemOnThisTile = stack.sort((a, b) => b.z - a.z)[0];
      // Fail if the top item exists and is not stackable
      if (topItemOnThisTile && !topItemOnThisTile.stackable) {
        socket.emit("action_failed", {
          action: "place",
          reason: `Tile (${tile.x},${tile.y}) is blocked by non-stackable '${topItemOnThisTile.name}'`,
        });
        return;
      }
      // More robust check: Use isTileOccupiedBySolid and check stackability of blocker
      if (room.isTileOccupiedBySolid(tile.x, tile.y)) {
        // Find the actual blocking item (must be solid, non-flat)
        const blockingItem = stack.find(
          (f) =>
            f.id !== topItemOnThisTile?.id &&
            !f.isWalkable &&
            !f.isFlat &&
            Math.abs(f.z - (topItemOnThisTile?.z ?? -1)) < 0.01
        ); // Approximate check
        if (blockingItem && !blockingItem.stackable) {
          socket.emit("action_failed", {
            action: "place",
            reason: `Tile (${tile.x},${tile.y}) blocked by solid non-stackable '${blockingItem.name}'`,
          });
          return;
        }
      }
    }
  }
  // 3. Check stackability of item directly below the *base* tile (gridX, gridY)
  const baseStack = room.getFurnitureStackAt(gridX, gridY);
  const topItemOnBase = baseStack.sort((a, b) => b.z - a.z)[0];
  // Cannot stack non-flat items on top of non-stackable items. Flat items (rugs) are okay.
  if (topItemOnBase && !topItemOnBase.stackable && !definition.isFlat) {
    socket.emit("action_failed", {
      action: "place",
      reason: `Cannot stack on '${topItemOnBase.name}' at (${gridX},${gridY})`,
    });
    return;
  }
  // 4. Calculate final Z and check stack height limit
  const baseZ = room.getStackHeightAt(gridX, gridY);
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

  // --- Place Item (Inventory Aware) ---
  if (avatar.removeItem(data.definitionId, 1)) {
    // Attempt to remove from inventory first
    // Create and add the furniture instance (pass null color override, use global ID counter)
    const newFurni = new ServerFurniture(
      definition.id,
      gridX,
      gridY,
      placeZ,
      rotation,
      null,
      avatar.id,
      definition.defaultState,
      null
    );
    // Store door properties if needed
    if (definition.isDoor) {
      newFurni.isDoor = true;
      newFurni.targetRoomId = definition.targetRoomId;
      newFurni.targetX = definition.targetX;
      newFurni.targetY = definition.targetY;
    }
    room.addFurniture(newFurni); // Add to the specific room
    console.log(
      `[${room.id}] ${avatar.name} placed ${definition.name} (id:${newFurni.id}) from inventory.`
    );
    io.to(room.id).emit("furni_added", newFurni.toDTO()); // Broadcast TO THE ROOM

    // Update the player's inventory on the client
    socket.emit("inventory_update", avatar.getInventoryDTO());
  } else {
    console.error(
      `Inventory inconsistency: ${avatar.name} failed place in room ${room.id}, could not remove ${data.definitionId}`
    );
    socket.emit("action_failed", {
      action: "place",
      reason: "Inventory error occurred",
    });
  }
}

function handleRequestRotateFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furni = room.getFurnitureById(data.furniId); // Find in specific room
  if (!furni) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "Furniture not found",
    });
    return;
  }

  if (furni.ownerId !== avatar.id) {
    socket.emit("action_failed", {
      action: "rotate",
      reason: "You do not own this item",
    });
    return; // Stop if not the owner
  }

  const oldRotation = furni.rotation;
  furni.rotation = rotateDirection(furni.rotation, 2); // 90 deg clockwise
  if (oldRotation !== furni.rotation) {
    console.log(
      `[${room.id}] ${avatar.name} rotated ${furni.name} (id:${furni.id}) to ${furni.rotation}`
    );
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      rotation: furni.rotation,
    }); // Broadcast TO THE ROOM
    // Update direction of anyone sitting on it IN THIS ROOM
    Object.values(room.avatars).forEach((seatedAvatar) => {
      if (seatedAvatar.sittingOnFurniId === furni.id) {
        const oldDir = seatedAvatar.direction;
        seatedAvatar.direction = rotateDirection(furni.sitDir, furni.rotation);
        if (oldDir !== seatedAvatar.direction) {
          // Broadcast update specifically for the seated avatar TO THE ROOM
          io.to(room.id).emit("avatar_update", {
            id: seatedAvatar.id,
            direction: seatedAvatar.direction,
          });
        }
      }
    });
  }
}

function handleRequestPickupFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furni = room.getFurnitureById(data.furniId); // Find in specific room
  if (!furni) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Furniture not found",
    });
    return;
  }

  if (furni.ownerId !== avatar.id) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "You do not own this item",
    });
    return; // Stop if not the owner
  }

  // Validation: Check for items stacked ON TOP using the specific room's furniture
  const furniTiles = furni.getOccupiedTiles();
  const itemsOnTop = room.furniture.filter((f) => {
    if (f.id === furni.id || f.isFlat || f.z <= furni.z) return false;
    const fTiles = f.getOccupiedTiles();
    return furniTiles.some((ft) =>
      fTiles.some((fft) => ft.x === fft.x && ft.y === fft.y)
    );
  });
  if (itemsOnTop.length > 0) {
    itemsOnTop.sort((a, b) => a.z - b.z);
    socket.emit("action_failed", {
      action: "pickup",
      reason: `Cannot pick up, '${itemsOnTop[0].name}' is on top`,
    });
    return;
  }
  // Validation: Check if anyone IN THIS ROOM is sitting on it
  if (room.isFurnitureOccupied(furni.id)) {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Cannot pick up, someone is using it",
    });
    return;
  }

  // --- Pickup Item (Inventory Aware) ---
  const removedFurni = room.removeFurniture(data.furniId); // Remove from specific room
  if (removedFurni) {
    if (avatar.addItem(removedFurni.definitionId, 1)) {
      // Add to inventory
      console.log(
        `[${room.id}] ${avatar.name} picked up ${removedFurni.name} (id:${removedFurni.id}) into inventory.`
      );
      io.to(room.id).emit("furni_removed", { id: removedFurni.id }); // Broadcast TO THE ROOM
      socket.emit("inventory_update", avatar.getInventoryDTO()); // Update client's inventory UI
    } else {
      console.error(
        `Inventory Error: Failed to add picked up item ${removedFurni.definitionId} to ${avatar.name}'s inventory in room ${room.id}.`
      );
      socket.emit("action_failed", {
        action: "pickup",
        reason: "Inventory error after pickup",
      });
      // Attempt to add the furniture back to the room state to prevent item loss
      room.addFurniture(removedFurni);
      io.to(room.id).emit("furni_added", removedFurni.toDTO()); // Tell clients it's back
    }
  } else {
    socket.emit("action_failed", {
      action: "pickup",
      reason: "Failed to remove item (already removed?)",
    });
  }
}

function handleRequestSit(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  if (avatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", { action: "sit", reason: "Already sitting" });
    return;
  }
  const furni = room.getFurnitureById(data.furniId); // Find in specific room
  if (!furni || !furni.canSit) {
    socket.emit("action_failed", {
      action: "sit",
      reason: "Cannot sit on this item",
    });
    return;
  }
  // Checks room.avatars for occupation
  if (room.isFurnitureOccupied(furni.id)) {
    socket.emit("action_failed", {
      action: "sit",
      reason: "This seat is occupied",
    });
    return;
  }

  const interactionSpot = furni.getInteractionTile();
  // Use room's check for walkability
  if (!room.isWalkable(interactionSpot.x, interactionSpot.y)) {
    const blockingFurni = room
      .getFurnitureStackAt(interactionSpot.x, interactionSpot.y)
      .find((f) => !f.isWalkable && !f.isFlat);
    const reason = blockingFurni
      ? `Cannot reach seat (blocked by ${blockingFurni.name})`
      : "Cannot reach seat (invalid tile)";
    socket.emit("action_failed", { action: "sit", reason: reason });
    return;
  }

  const currentX = Math.round(avatar.x);
  const currentY = Math.round(avatar.y);
  const sitAction = { type: "sit", targetId: furni.id };

  if (currentX === interactionSpot.x && currentY === interactionSpot.y) {
    // Already at spot
    if (avatar.executeSit(furni, room)) {
      // Pass specific room context
      io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM
    } else {
      socket.emit("action_failed", {
        action: "sit",
        reason: "Failed to sit (internal error)",
      });
    }
  } else {
    // Pathfind first
    if (avatar.moveTo(interactionSpot.x, interactionSpot.y, room, sitAction)) {
      // Pass specific room context
      io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM walk start
    } else {
      socket.emit("action_failed", {
        action: "sit",
        reason: "Cannot find path to seat",
      });
    }
  }
}

function handleRequestStand(socket) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room) return;
  if (avatar.state !== SHARED_CONFIG.AVATAR_STATE_SITTING) {
    socket.emit("action_failed", {
      action: "stand",
      reason: "You are not sitting",
    });
    return;
  }
  if (avatar.executeStand(room)) {
    // Pass specific room context
    io.to(room.id).emit("avatar_update", avatar.toDTO()); // Broadcast TO THE ROOM state change
  } else {
    socket.emit("action_failed", {
      action: "stand",
      reason: "Failed to stand (internal error)",
    });
  }
}

function handleRequestUserList(socket) {
  const { room } = getAvatarAndRoom(socket.id);
  if (room) {
    // console.log(`[${room.id}] Client ${socket.id} requested user list.`); // Less noisy
    socket.emit("user_list_update", room.getUserList()); // Send list for current room
  } else {
    console.warn(
      `Cannot send user list: Socket ${socket.id} not found in any room.`
    );
    // Optionally send an empty list or error
    socket.emit("user_list_update", []);
  }
}

function handleRequestProfile(socket, data) {
  // Profile is global, find user across rooms
  const requesterInfo = getAvatarAndRoom(socket.id); // Info about the requester
  if (!requesterInfo.avatar || !data || data.avatarId == null) return;

  let targetAvatar = null;
  // Find the target avatar across all rooms
  for (const r of rooms.values()) {
    targetAvatar = Object.values(r.avatars).find((a) => a.id === data.avatarId);
    if (targetAvatar) break;
  }

  if (targetAvatar) {
    console.log(
      `${requesterInfo.avatar.name} requested profile for ${
        targetAvatar.name
      } (in room ${targetAvatar.roomId || "unknown"})`
    );
    // Send profile DTO (includes currency, etc.)
    socket.emit("show_profile", targetAvatar.toProfileDTO());
  } else {
    socket.emit("action_failed", {
      action: "profile",
      reason: "User not found online",
    });
  }
}

function handleRequestUseFurni(socket, data) {
  const { avatar, room } = getAvatarAndRoom(socket.id);
  if (!avatar || !room || !data || data.furniId == null) return;
  const furni = room.getFurnitureById(data.furniId); // Find in specific room
  if (!furni) {
    socket.emit("action_failed", {
      action: "use",
      reason: "Furniture not found",
    });
    return;
  }
  if (!furni.canUse) {
    socket.emit("action_failed", {
      action: "use",
      reason: "Cannot use this item",
    });
    return;
  }

  // Optional: Add distance check?

  console.log(`[${room.id}] ${avatar.name} requesting use on ${furni.name}`);
  if (furni.use(avatar, room)) {
    // Pass specific room context for potential Z recalc
    console.log(
      ` -> Success. New state: ${furni.state}, New Z: ${furni.z.toFixed(2)}`
    );
    // Broadcast update including potentially changed state and Z TO THE ROOM
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      state: furni.state,
      z: furni.z,
    });
  } else {
    console.log(` -> Used ${furni.name}, but state/Z did not change.`);
  }
}

function handleRequestRecolorFurni(socket, data) {
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
      reason: "Invalid request data",
    });
    return;
  }

  const furni = room.getFurnitureById(data.furniId); // Find in specific room
  if (!furni) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Furniture not found",
    });
    return;
  }

  if (furni.ownerId !== avatar.id) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "You do not own this item",
    });
    return;
  }

  if (!furni.canRecolor) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "This item cannot be recolored",
    });
    return;
  }

  const targetColor = data.colorHex;
  if (
    targetColor &&
    typeof targetColor === "string" &&
    targetColor !== "" &&
    !SHARED_CONFIG.VALID_RECOLOR_HEX.includes(targetColor.toUpperCase())
  ) {
    socket.emit("action_failed", {
      action: "recolor",
      reason: `Invalid color: ${targetColor}`,
    });
    return;
  }

  // TODO: Check for/consume dye item cost if implementing dyes

  if (furni.setColorOverride(targetColor)) {
    const displayColor = furni.colorOverride || "default";
    console.log(
      `[${room.id}] ${avatar.name} recolored ${furni.name} (id:${furni.id}) to ${displayColor}`
    );
    // Send minimal update TO THE ROOM
    io.to(room.id).emit("furni_updated", {
      id: furni.id,
      colorOverride: furni.colorOverride,
    });
    // If dyes were used: socket.emit('inventory_update', avatar.getInventoryDTO());
  } else {
    socket.emit("action_failed", {
      action: "recolor",
      reason: "Recolor failed or no change needed",
    });
  }
}

function handleRequestBuyItem(socket, data) {
  // Buying is global (inventory/currency is on avatar)
  const { avatar } = getAvatarAndRoom(socket.id); // Don't strictly need room here
  if (!avatar || !data || !data.itemId) {
    socket.emit("action_failed", {
      action: "buy",
      reason: "Invalid buy request",
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
      reason: "Item not available for sale",
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
      reason: "Shop configuration error",
    });
    return;
  }

  const price = shopEntry.price;

  // 3. Check currency
  if (avatar.currency < price) {
    socket.emit("action_failed", {
      action: "buy",
      reason: `Insufficient gold (Need ${price} G)`,
    });
    return;
  }

  // 4. Perform transaction
  if (avatar.removeCurrency(price)) {
    if (avatar.addItem(itemId, 1)) {
      // Success! Notify client (no room broadcast needed for buy)
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
      // Failed to add item (should be rare), refund currency
      console.error(
        `Buy Error: Failed to add item ${itemId} to ${avatar.name} after taking currency. Refunding.`
      );
      avatar.addCurrency(price); // Refund
      socket.emit("action_failed", {
        action: "buy",
        reason: "Inventory error after purchase (refunded)",
      });
      socket.emit("currency_update", { currency: avatar.currency }); // Send refund update
    }
  } else {
    // Failed to remove currency (e.g., race condition? Should have been checked)
    console.error(
      `Buy Error: Failed to remove currency ${price} from ${avatar.name} even after check.`
    );
    socket.emit("action_failed", {
      action: "buy",
      reason: "Currency transaction error",
    });
  }
}

// --- NEW Room Change Handler ---
function handleChangeRoom(socket, data) {
  const { avatar: currentAvatar, room: currentRoom } = getAvatarAndRoom(
    socket.id
  );
  if (!currentAvatar || !currentRoom || !data || !data.targetRoomId) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: "Invalid request or current state",
    });
    return;
  }

  const targetRoomId = data.targetRoomId;
  const targetRoom = rooms.get(targetRoomId);

  if (!targetRoom) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: `Room '${targetRoomId}' does not exist`,
    });
    return;
  }

  if (currentRoom.id === targetRoomId) {
    socket.emit("action_failed", {
      action: "change_room",
      reason: "Already in that room",
    });
    return;
  }

  console.log(
    `${currentAvatar.name} attempting to change from room ${currentRoom.id} to ${targetRoomId}`
  );

  // --- Perform the change ---
  // 1. Remove from current room & notify others in that room
  currentRoom.removeAvatar(socket.id); // Remove using socket ID
  io.to(currentRoom.id).emit("avatar_removed", { id: currentAvatar.id }); // Broadcast removal using avatar ID
  io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList()); // Update list for old room
  socket.leave(currentRoom.id);
  console.log(` -> Left Socket.IO room: ${currentRoom.id}`);

  // 2. Find spawn point in target room
  // Use targetX/Y if provided (e.g., from door), otherwise find default
  const targetX = data.targetX ?? -1;
  const targetY = data.targetY ?? -1;
  const spawnPoint = targetRoom.findSpawnPoint(targetX, targetY);

  // 3. Prepare avatar state for new room
  currentAvatar.prepareForRoomChange(targetRoomId, spawnPoint.x, spawnPoint.y);

  // 4. Add to new room & join Socket.IO room
  targetRoom.addAvatar(currentAvatar); // Add using the avatar object
  socket.join(targetRoomId);
  console.log(` -> Joined Socket.IO room: ${targetRoomId}`);

  // 5. Send new room state to the client who moved
  socket.emit("room_state", targetRoom.getStateDTO());
  // Re-send client-specific info in case something went wrong or for confirmation
  socket.emit("your_avatar_id", currentAvatar.id);
  socket.emit("inventory_update", currentAvatar.getInventoryDTO());
  socket.emit("currency_update", { currency: currentAvatar.currency });

  // 6. Broadcast arrival to others in the new room
  io.to(targetRoomId).emit("avatar_added", currentAvatar.toDTO());
  io.to(targetRoomId).emit("user_list_update", targetRoom.getUserList()); // Update list for new room

  console.log(
    ` -> ${currentAvatar.name} successfully changed to room ${targetRoomId}`
  );
}
// --- End Room Change Handler ---

function handleDisconnect(socket, reason) {
  console.log(`Client disconnected: ${socket.id}. Reason: ${reason}`);
  const clientInfo = clients[socket.id]; // Get client info before deleting

  // Find avatar and the room they were in *before* removing from clients map
  let avatar = null;
  let currentRoom = null;
  if (clientInfo && clientInfo.avatarId !== null) {
    // Use the helper, but handle potential errors gracefully during disconnect
    try {
      const findResult = getAvatarAndRoom(socket.id);
      avatar = findResult.avatar;
      currentRoom = findResult.room;
    } catch (e) {
      console.error(
        `Error finding avatar/room during disconnect for ${socket.id}: ${e.message}`
      );
    }
  }

  if (avatar && currentRoom) {
    // Remove avatar from the specific room instance using socket ID
    const removed = currentRoom.removeAvatar(socket.id);
    if (removed) {
      // Broadcast removal TO THAT ROOM using avatar ID
      io.to(currentRoom.id).emit("avatar_removed", { id: avatar.id });
      console.log(
        `Avatar ${avatar.name} (ID:${avatar.id}) removed from room ${currentRoom.id}.`
      );
      // Update user list FOR THAT ROOM
      io.to(currentRoom.id).emit("user_list_update", currentRoom.getUserList());
    } else {
      console.warn(
        `Disconnect: Failed to remove avatar ${avatar.id} from room ${currentRoom.id} map.`
      );
    }
  } else {
    console.log(
      `Socket ${socket.id} disconnected, but no valid avatar/room association found.`
    );
  }

  // Socket.IO automatically handles the socket leaving all its associated rooms on disconnect.
  // We manually called socket.leave() during room changes, which is also fine.

  // Finally, remove from the global client tracking map
  delete clients[socket.id];
}

function handleConnectError(socket, err) {
  // This usually fires client-side, but good to log if server sees it
  console.error(
    `Socket connect_error for ${socket?.id || "unknown"}: ${err.message}`
  );
  // Attempt cleanup as if disconnected
  handleDisconnect(
    socket || { id: "unknown_on_error" },
    `Connection error: ${err.message}`
  );
}

// --- Export handlers ---
module.exports = {
  initializeHandlers,
  handleConnection,
  // Expose room change handler if needed by console commands directly (optional)
  handleChangeRoom,
};