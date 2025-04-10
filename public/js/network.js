import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { gameState, uiState } from "./gameState.js"; // Removed camera import - not directly used here
import { resetLocalState } from "./main.js"; // Import the main reset function for disconnects
import {
  logChatMessage,
  updateUserListPanel,
  showProfilePanel,
  hideProfilePanel,
  populateInventory,
  updateCurrencyDisplay,
  updateShopButtonStates,
  setSelectedFurniture,
  hideRecolorPanel,
  setSelectedInventoryItem,
  updateInventorySelection,
  updateUICursor,
  centerCameraOnRoom,
  showLoadingOverlay, // For explicit loading state control
  hideLoadingOverlay, // For hiding overlay after load
  updateAdminUI, // To update admin controls visibility/state
  updateAdminRoomList, // To populate the admin room list
  populateRoomsPanel, // Added for room list population
  togglePanel, // For closing panels on disconnect/state change
  showNotification, // Keep simple notification for backward compatibility/simple messages
  showNotificationWithActions, // Import the advanced notification handler
  showTradePanel, // Need function to show/update trade panel
  hideTradePanel, // Need function to hide trade panel
  updateTradePanelOffers, // Need function to update offers visually
  handleTradeRequest, // Need function to display incoming request
  updateTradeConfirmationStatus, // Need function to update confirmed visuals
  populateTradeInventory, // Import function to refresh trade inventory
} from "./uiManager.js";
import { playSound } from "./sounds.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientTile } from "./gameObjects/ClientTile.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientNPC } from "./gameObjects/ClientNPC.js"; // <-- Import ClientNPC
import { escapeHtml } from "./utils.js";

let socket = null;

/**
 * Establishes a Socket.IO connection to the server using the stored auth token.
 * Handles token checks and redirects to login if necessary.
 * @returns {boolean} True if the connection attempt was initiated, false otherwise.
 */
export function connectToServer() {
  const token = localStorage.getItem("authToken");
  if (!token) {
    console.log("No auth token found, directing to login.");
    showLoadingOverlay("Auth token missing. Redirecting...");
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 1500);
    return false;
  }

  // Prevent multiple connections
  if (socket && socket.connected) {
    console.warn("connectToServer called but socket already connected.");
    return true; // Already connected or attempting
  }
  if (socket) {
    console.log("Disconnecting existing socket before reconnecting...");
    socket.disconnect();
    socket = null;
  }

  try {
    showLoadingOverlay("Connecting to Server...");
    // Initialize the connection with authentication
    socket = io({ auth: { token: token } }); // io() is global from the script include
    setupSocketListeners(); // Setup listeners immediately
    return true; // Indicate connection attempt started
  } catch (err) {
    console.error("Failed to initialize Socket.IO:", err);
    showLoadingOverlay("Error: Connection Failed. Check console.");
    if (uiState.debugDiv) uiState.debugDiv.textContent = "Connection Error";
    return false; // Indicate failure
  }
}

/** Checks if the socket is currently connected. */
export function isConnected() {
  return socket?.connected || false;
}

/** Disconnects the current socket connection. */
export function disconnectSocket() {
  if (socket) {
    console.log("Disconnecting socket...");
    socket.disconnect();
    socket = null;
  }
}

// --- Emit Functions (Client -> Server) ---

/** Safely emits an event via the socket if connected. */
function emitIfConnected(event, data) {
  if (isConnected()) {
    socket.emit(event, data);
  } else {
    console.warn(
      `Attempted to emit "${event}" while disconnected. Data:`,
      data
    );
    // Use notification for feedback
    showNotification("Not connected to server.", "error");
  }
}

export function sendChat(message) {
  if (message && message.trim()) {
    emitIfConnected("send_chat", message.trim());
  }
}

export function requestMove(x, y) {
  emitIfConnected("request_move", { x, y });
}

export function requestPlaceFurni(definitionId, x, y, rotation) {
  emitIfConnected("request_place_furni", { definitionId, x, y, rotation });
}

export function requestRotateFurni(furniId) {
  emitIfConnected("request_rotate_furni", { furniId: String(furniId) });
}

export function requestPickupFurni(furniId) {
  emitIfConnected("request_pickup_furni", { furniId: String(furniId) });
}

export function requestSit(furniId) {
  emitIfConnected("request_sit", { furniId: String(furniId) });
}

export function requestStand() {
  emitIfConnected("request_stand");
}

export function requestUserList() {
  emitIfConnected("request_user_list");
}

export function requestProfile(avatarId) {
  emitIfConnected("request_profile", { avatarId: String(avatarId) });
}

export function requestUseFurni(furniId) {
  emitIfConnected("request_use_furni", { furniId: String(furniId) });
}

export function requestRecolorFurni(furniId, colorHex) {
  emitIfConnected("request_recolor_furni", {
    furniId: String(furniId),
    colorHex: colorHex ?? "",
  });
}

export function requestBuyItem(itemId) {
  emitIfConnected("request_buy_item", { itemId });
}

// Shows loading overlay immediately before sending request
export function requestChangeRoom(targetRoomId, targetX, targetY) {
  const data = { targetRoomId };
  if (typeof targetX === "number" && typeof targetY === "number") {
    data.targetX = targetX;
    data.targetY = targetY;
  }
  showLoadingOverlay(`Joining Room: ${escapeHtml(targetRoomId)}...`);
  emitIfConnected("request_change_room", data);
}

/** Requests the list of public rooms from the server. */
export function requestPublicRooms() {
  emitIfConnected("request_public_rooms");
}

// --- NEW Trade Emit Functions ---
export function requestTradeInitiate(targetAvatarId) {
  emitIfConnected("request_trade_initiate", {
    targetId: String(targetAvatarId),
  });
}
export function respondToTradeRequest(tradeId, accepted) {
  emitIfConnected("trade_request_response", { tradeId, accepted });
}
export function updateTradeOffer(tradeId, items, currency) {
  // items should be { definitionId: quantity }
  emitIfConnected("trade_update_offer", { tradeId, items, currency });
}
export function confirmTradeOffer(tradeId) {
  emitIfConnected("trade_confirm_offer", { tradeId });
}
export function cancelTrade(tradeId) {
  emitIfConnected("trade_cancel", { tradeId });
}
// --- End Trade Emit Functions ---

// --- Interact Emitter ---
export function requestInteract(targetId) {
  emitIfConnected("request_interact", { targetId: String(targetId) });
}
// --- End Interact Emitter ---

// --- Admin Emitters ---
export function requestCreateRoom(roomId, cols, rows) {
  const data = { roomId };
  if (cols) data.cols = cols;
  if (rows) data.rows = rows;
  emitIfConnected("request_create_room", data);
}

export function requestModifyLayout(roomId, x, y, type) {
  // Server uses socket's current room
  emitIfConnected("request_modify_layout", { x, y, type });
}

export function requestAllRoomIds() {
  emitIfConnected("request_all_room_ids");
}

// --- Socket Event Listeners (Server -> Client) ---

/** Sets up all listeners for events received from the server. */
async function setupSocketListeners() {
  if (!socket) {
    console.error("Socket not initialized before setting up listeners.");
    return;
  }

  // Remove existing listeners to prevent duplicates if re-connecting
  socket.removeAllListeners(); // Clear all previous listeners reliably

  // --- Connection Lifecycle ---
  socket.on("connect", () => {
    console.log("Connected to server with ID:", socket.id);
    showLoadingOverlay("Connected. Waiting for Player Data...");
    if (uiState.debugDiv) uiState.debugDiv.textContent = "Connected...";
    // Enable basic buttons on connect attempt? Maybe wait for room_state.
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected from server. Reason:", reason);
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`);
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Disconnected: ${reason}`;
    resetLocalState(); // Reset client game state
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`); // Re-show disconnect message
    gameState.myAvatarId = null;
    gameState.myUserId = null;
    socket = null; // Clear socket reference

    // Disable UI buttons that require connection
    if (uiState.toggleShopBtn) uiState.toggleShopBtn.disabled = true;
    if (uiState.toggleEditBottomBtn)
      uiState.toggleEditBottomBtn.disabled = true;
    if (uiState.toggleAdminBtn) uiState.toggleAdminBtn.disabled = true;
    if (uiState.toggleRoomsBtn) uiState.toggleRoomsBtn.disabled = true;
    if (uiState.toggleInventoryBtn) uiState.toggleInventoryBtn.disabled = true;
    if (uiState.toggleUsersBtn) uiState.toggleUsersBtn.disabled = true;
    if (uiState.toggleDebugBtn) uiState.toggleDebugBtn.disabled = true;
    if (uiState.logoutBtn) uiState.logoutBtn.disabled = true; // Disable logout too? Maybe not.

    updateAdminUI(); // Hide admin controls on disconnect
  });

  // --- Core Game State Sync ---
  socket.on("room_state", async (state) => {
    console.log(
      "DEBUG: Received room_state:",
      state ? `for room ${state.id}` : "INVALID STATE"
    );
    if (!CLIENT_CONFIG || !state || state.id == null || !state.layout) {
      console.error("Received invalid room_state:", state);
      showLoadingOverlay("Error: Invalid room data received.");
      return;
    }
    showLoadingOverlay("Initializing Room..."); // Update overlay message

    // --- Partial Reset (Keep global state like inventory/currency) ---
    gameState.furniture = {};
    gameState.avatars = {};
    gameState.npcs = {}; // <-- Clear NPCs
    gameState.clientTiles = [];
    gameState.highlightedTile = null;
    gameState.roomLayout = [];
    gameState.roomCols = 0;
    gameState.roomRows = 0;
    if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
    uiState.activeChatBubbles = [];
    hideProfilePanel();
    hideRecolorPanel();
    hideTradePanel(); // Ensure trade panel is closed on room change
    // Close any other open toggled panels
    if (uiState.activePanelId != null) {
      togglePanel(uiState.activePanelId, false);
    }
    // Reset edit mode state
    uiState.isEditMode = false;
    if (CLIENT_CONFIG)
      uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
    uiState.editMode.selectedInventoryItemId = null;
    uiState.editMode.selectedFurnitureId = null;
    uiState.editMode.placementValid = false;
    uiState.editMode.placementRotation = 0;
    uiState.activeRecolorFurniId = null;
    // Reset UI elements related to edit mode
    updateInventorySelection();
    updateUICursor();
    if (uiState.toggleEditBottomBtn) {
      uiState.toggleEditBottomBtn.classList.remove("active");
      uiState.toggleEditBottomBtn.disabled = false; // Re-enable edit button
    }
    // --- End Partial Reset ---

    gameState.currentRoomId = state.id;
    gameState.roomLayout = state.layout;
    gameState.roomCols = state.cols || state.layout[0]?.length || 0;
    gameState.roomRows = state.rows || state.layout.length;

    if (uiState.roomNameDisplay)
      uiState.roomNameDisplay.textContent = `Room: ${escapeHtml(state.id)}`;
    document.title = `ZanyTown - ${escapeHtml(state.id)}`;

    // Create client-side tile objects
    for (let y = 0; y < gameState.roomRows; y++) {
      for (let x = 0; x < gameState.roomCols; x++) {
        const layoutType = gameState.roomLayout[y]?.[x] ?? 0;
        try {
          gameState.clientTiles.push(new ClientTile(x, y, layoutType));
        } catch (e) {
          console.error(`Error creating ClientTile at (${x},${y}):`, e);
        }
      }
    }

    // Process furniture
    state.furniture?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          gameState.furniture[String(dto.id)] = new ClientFurniture(dto);
        } catch (e) {
          console.error(`Error creating ClientFurniture:`, dto, e);
        }
      } else console.warn("Invalid furniture DTO in room_state:", dto);
    });

    // Process player avatars (and identify player)
    state.avatars?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          const avatarIdStr = String(dto.id);
          const avatarInstance = new ClientAvatar(dto);
          if (
            gameState.myAvatarId &&
            avatarInstance.id === gameState.myAvatarId
          ) {
            avatarInstance.isPlayer = true;
            console.log(
              `[room_state] Identified MY AVATAR: ${dto.name} (ID: ${avatarIdStr})`
            );
            updateAdminUI();
          }
          gameState.avatars[avatarIdStr] = avatarInstance;
        } catch (e) {
          console.error(`Error creating ClientAvatar:`, dto, e);
        }
      } else console.warn("Invalid avatar DTO in room_state:", dto);
    });

    // Process NPCs <-- ADDED
    state.npcs?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          const npcIdStr = String(dto.id);
          gameState.npcs[npcIdStr] = new ClientNPC(dto);
        } catch (e) {
          console.error("Error creating ClientNPC from room_state:", dto, e);
        }
      } else {
        console.warn("Invalid NPC DTO in room_state:", dto);
      }
    });
    // --- END NPC PROCESSING ---

    centerCameraOnRoom(); // Center camera on the new room
    hideLoadingOverlay(); // Hide overlay AFTER processing complete

    logChatMessage(`Entered room: ${escapeHtml(state.id)}`, true, "info-msg");
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Room '${escapeHtml(state.id)}' loaded.`;

    // Enable bottom bar buttons now that room is loaded
    if (uiState.toggleShopBtn) uiState.toggleShopBtn.disabled = false;
    if (uiState.toggleEditBottomBtn)
      uiState.toggleEditBottomBtn.disabled = false;
    if (
      uiState.toggleAdminBtn &&
      gameState.avatars[gameState.myAvatarId]?.isAdmin
    ) {
      uiState.toggleAdminBtn.disabled = false;
    } else if (uiState.toggleAdminBtn) {
      uiState.toggleAdminBtn.disabled = true; // Ensure disabled if not admin
    }
    if (uiState.toggleRoomsBtn) uiState.toggleRoomsBtn.disabled = false;
    if (uiState.toggleInventoryBtn) uiState.toggleInventoryBtn.disabled = false;
    if (uiState.toggleUsersBtn) uiState.toggleUsersBtn.disabled = false;
    if (uiState.toggleDebugBtn) uiState.toggleDebugBtn.disabled = false;

    // Refresh UI elements that might depend on room state or player avatar
    populateInventory(); // Refresh inventory display
    updateCurrencyDisplay(); // Refresh currency display
    updateShopButtonStates(); // Refresh shop button states
    updateUserListPanel(state.avatars || []); // Populate user list immediately
    updateAdminUI(); // Ensure admin UI visibility is correct
  });

  socket.on("your_avatar_id", (id) => {
    const myIdString = String(id);
    console.log("DEBUG: Received your_avatar_id:", myIdString);
    gameState.myAvatarId = myIdString;
    // Update isPlayer flag for the avatar if already present
    if (gameState.avatars[myIdString]) {
      gameState.avatars[myIdString].checkIfPlayer();
      updateAdminUI();
    }
    requestUserList();
  });

  socket.on("your_persistent_id", (userId) => {
    gameState.myUserId = String(userId);
    console.log(
      `[DEBUG CLIENT] Received myUserId: '${
        gameState.myUserId
      }' (Type: ${typeof gameState.myUserId})`
    );
  });

  // --- Incremental Updates & Events ---
  socket.on("avatar_added", (avatarDTO) => {
    if (
      !avatarDTO ||
      avatarDTO.id == null ||
      avatarDTO.roomId !== gameState.currentRoomId
    )
      return;
    const avatarIdStr = String(avatarDTO.id);
    if (!gameState.avatars[avatarIdStr]) {
      try {
        const newAvatar = new ClientAvatar(avatarDTO);
        newAvatar.checkIfPlayer();
        gameState.avatars[avatarIdStr] = newAvatar;
        console.log(`Avatar added: ${avatarDTO.name} (ID: ${avatarIdStr})`);
        requestUserList();
      } catch (e) {
        console.error(
          "Error creating ClientAvatar on avatar_added:",
          avatarDTO,
          e
        );
      }
    } else {
      console.warn(
        `Received avatar_added for existing avatar ${avatarIdStr}. Updating instead.`
      );
      gameState.avatars[avatarIdStr].update(avatarDTO);
      requestUserList();
    }
  });

  socket.on("avatar_removed", (data) => {
    if (!data || data.id == null) return;
    const avatarIdStr = String(data.id);
    const removedAvatar = gameState.avatars[avatarIdStr];
    if (removedAvatar) {
      console.log(`Avatar removed: ${removedAvatar.name} (${avatarIdStr})`);
      removedAvatar.clearBubble?.();
      delete gameState.avatars[avatarIdStr];
      requestUserList();
      if (uiState.profilePanel?.dataset.targetId === avatarIdStr)
        hideProfilePanel();
    }
  });

  socket.on("avatar_update", (avatarDTO) => {
    if (!avatarDTO || avatarDTO.id == null) return;
    const avatarIdStr = String(avatarDTO.id);
    const avatar = gameState.avatars[avatarIdStr];
    if (avatar instanceof ClientAvatar) {
      const oldState = avatar.state;
      const oldName = avatar.name;
      const oldIsAdmin = avatar.isAdmin;
      avatar.update(avatarDTO);
      // Play sounds for *other* avatars' state changes
      if (avatarIdStr !== gameState.myAvatarId) {
        if (
          avatar.state === SHARED_CONFIG.AVATAR_STATE_WALKING &&
          oldState !== SHARED_CONFIG.AVATAR_STATE_WALKING
        ) {
          playSound("walk");
        } else if (
          avatar.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
          oldState !== SHARED_CONFIG.AVATAR_STATE_EMOTING &&
          avatar.currentEmoteId
        ) {
          const emoteDef =
            SHARED_CONFIG.EMOTE_DEFINITIONS?.[avatar.currentEmoteId];
          if (emoteDef?.sound) playSound(emoteDef.sound);
        }
      }
      // Update admin UI if player's admin status changed
      if (
        avatarIdStr === gameState.myAvatarId &&
        oldIsAdmin !== avatar.isAdmin
      ) {
        updateAdminUI();
      }
      // Update user list if name or admin status changed
      if (
        avatarDTO.name &&
        (oldName !== avatar.name || oldIsAdmin !== avatar.isAdmin)
      ) {
        requestUserList(); // Refresh user list on relevant changes
      }
    }
  });

  socket.on("furni_added", (furniDTO) => {
    if (!furniDTO || furniDTO.id == null) return;
    const furniIdStr = String(furniDTO.id);
    let isNew = false;
    if (!gameState.furniture[furniIdStr]) {
      try {
        gameState.furniture[furniIdStr] = new ClientFurniture(furniDTO);
        isNew = true;
      } catch (e) {
        console.error(
          "Error creating ClientFurniture on furni_added:",
          furniDTO,
          e
        );
      }
    } else {
      console.warn(
        `Received furni_added for existing furni ${furniIdStr}. Updating instead.`
      );
      gameState.furniture[furniIdStr].update(furniDTO);
    }
    if (isNew) playSound("place");
  });

  socket.on("furni_removed", (data) => {
    if (!data || data.id == null) return;
    const furniIdStr = String(data.id);
    const removedFurni = gameState.furniture[furniIdStr];
    if (removedFurni) {
      console.log(
        `Furniture removed: ${
          removedFurni.definition?.name || "Unknown"
        } (ID: ${furniIdStr})`
      );
      if (uiState.editMode.selectedFurnitureId === furniIdStr)
        setSelectedFurniture(null);
      if (uiState.activeRecolorFurniId === furniIdStr) hideRecolorPanel();
      delete gameState.furniture[furniIdStr];
      // playSound('pickup'); // Optional pickup sound
    }
  });

  socket.on("furni_updated", (updateData) => {
    if (!updateData || updateData.id == null) return;
    const furniIdStr = String(updateData.id);
    const furni = gameState.furniture[furniIdStr];
    if (furni instanceof ClientFurniture) {
      const oldState = furni.state;
      furni.update(updateData);
      if (
        updateData.state !== undefined &&
        oldState !== updateData.state &&
        furni.definition?.canUse
      ) {
        playSound("use");
      }
    }
  });

  // --- NPC Handlers --- <-- ADDED
  socket.on("npc_added", (npcDTO) => {
    if (
      !npcDTO ||
      npcDTO.id == null ||
      npcDTO.roomId !== gameState.currentRoomId
    )
      return;
    const npcIdStr = String(npcDTO.id);
    if (!gameState.npcs[npcIdStr]) {
      try {
        gameState.npcs[npcIdStr] = new ClientNPC(npcDTO);
        console.log(`NPC added dynamically: ${npcDTO.name} (ID: ${npcIdStr})`);
      } catch (e) {
        console.error("Error creating ClientNPC on npc_added:", npcDTO, e);
      }
    } else {
      console.warn(
        `Received npc_added for existing NPC ${npcIdStr}. Updating.`
      );
      gameState.npcs[npcIdStr].update(npcDTO);
    }
  });

  socket.on("npc_removed", (data) => {
    if (!data || data.id == null) return;
    const npcIdStr = String(data.id);
    const removedNpc = gameState.npcs[npcIdStr];
    if (removedNpc) {
      console.log(`NPC removed: ${removedNpc.name} (${npcIdStr})`);
      delete gameState.npcs[npcIdStr];
    }
  });

  socket.on("npc_update", (npcDTO) => {
    if (!npcDTO || npcDTO.id == null) return;
    const npcIdStr = String(npcDTO.id);
    const npc = gameState.npcs[npcIdStr];
    if (npc instanceof ClientNPC) {
      const oldState = npc.state;
      npc.update(npcDTO);
      if (
        npc.state === SHARED_CONFIG.AVATAR_STATE_WALKING &&
        oldState !== SHARED_CONFIG.AVATAR_STATE_WALKING
      ) {
        playSound("walk");
      }
    } else {
      try {
        console.warn(
          `Received npc_update for unknown NPC ${npcIdStr}. Creating.`
        );
        gameState.npcs[npcIdStr] = new ClientNPC(npcDTO);
      } catch (e) {
        console.error(`Failed to create NPC on update:`, e);
      }
    }
  });
  // --- End NPC Handlers ---

  // --- Layout Update Listener ---
  socket.on("layout_tile_update", (data) => {
    if (!data || data.x == null || data.y == null || data.type == null) {
      console.warn("Received invalid layout_tile_update data:", data);
      return;
    }
    const tile = gameState.clientTiles?.find(
      (t) => t.x === data.x && t.y === data.y
    );
    if (tile instanceof ClientTile) {
      tile.layoutType = data.type;
      tile._setBaseColor(); // Update visual base color
      if (gameState.roomLayout[data.y]) {
        gameState.roomLayout[data.y][data.x] = data.type;
      }
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING
      ) {
        // updateHighlights will re-evaluate placement validity
      }
    } else {
      console.warn(
        `Could not find client tile at (${data.x}, ${data.y}) to update.`
      );
    }
  });

  // --- User/Global State Updates ---
  socket.on("inventory_update", (inventoryData) => {
    gameState.inventory =
      typeof inventoryData === "object" && inventoryData !== null
        ? inventoryData
        : {};
    populateInventory();
    updateShopButtonStates();
    // Refresh trade inventory if trade panel is open
    if (uiState.isTrading && typeof populateTradeInventory === "function") {
      populateTradeInventory();
    }
  });

  socket.on("currency_update", (data) => {
    if (data && typeof data.currency === "number") {
      const oldValue = gameState.myCurrency;
      gameState.myCurrency = data.currency;
      updateCurrencyDisplay();
      updateShopButtonStates();

      const increase = gameState.myCurrency - oldValue;
      if (increase > 10) {
        showNotification(`Received ${increase} Coins!`, "success");
        playSound("success");
      } else if (increase > 0) {
        // Minor sound?
      }
    } else console.warn("Received invalid currency update:", data);
  });

  socket.on("user_list_update", (users) => {
    updateUserListPanel(users || []);
  });

  socket.on("show_profile", (profileData) => {
    if (!profileData || !profileData.id) return;
    showProfilePanel(profileData);
  });

  // --- Public Room List Update Handler ---
  socket.on("public_rooms_update", (roomData) => {
    console.log("DEBUG: Received public_rooms_update:", roomData);
    if (Array.isArray(roomData)) {
      populateRoomsPanel(roomData);
    } else {
      console.warn("Received invalid data for public_rooms_update:", roomData);
      populateRoomsPanel([]);
    }
  });

  // --- Admin Room List Update ---
  socket.on("all_room_ids_update", (roomIds) => {
    if (Array.isArray(roomIds)) {
      updateAdminRoomList(roomIds);
    } else {
      console.warn("Received invalid data for all_room_ids_update:", roomIds);
    }
  });

  // --- Chat & Feedback ---
  socket.on("chat_message", (data) => {
    if (!data || typeof data.text !== "string") return;
    const avatarIdStr = data.avatarId ? String(data.avatarId) : null;
    const isNPC = data.isNPC || gameState.npcs[avatarIdStr] !== undefined; // Check if it's a known NPC
    const isPlayer = !isNPC && gameState.avatars[avatarIdStr] !== undefined;

    let avatar = null;
    if (isNPC) avatar = gameState.npcs[avatarIdStr];
    else if (isPlayer) avatar = gameState.avatars[avatarIdStr];

    const senderName = avatar
      ? escapeHtml(avatar.name)
      : escapeHtml(data.avatarName || "Unknown");

    const isServerInfo =
      !avatarIdStr &&
      !isNPC &&
      (data.className === "info-msg" || data.className === "server-msg");
    const isSimpleFeedback =
      isServerInfo &&
      (data.text.startsWith("You bought") ||
        data.text.startsWith("You received") ||
        data.text.includes("privileges have been") ||
        data.text.startsWith("Room") ||
        data.text.startsWith("Teleported") ||
        data.text.startsWith("Gave"));

    if (isSimpleFeedback) {
      const type = data.text.includes("privileges have been revoked")
        ? "info"
        : "success";
      showNotification(data.text, type);
      playSound(type === "success" ? "success" : "info");
    } else if (
      avatar instanceof ClientAvatar &&
      data.avatarId !== gameState.myAvatarId &&
      !data.className?.includes("announcement") &&
      !isNPC
    ) {
      // Normal chat from another PLAYER
      avatar.say?.(data.text);
      logChatMessage(
        `${senderName}: ${escapeHtml(data.text)}`,
        false,
        data.className
      );
      playSound("chat");
    } else if (avatar instanceof ClientNPC) {
      // Chat from an NPC
      avatar.say?.(data.text); // Display bubble
      logChatMessage(
        `${senderName}: ${escapeHtml(data.text)}`,
        false,
        `npc-dialogue ${data.className || ""}`
      ); // Log with special class
      playSound("chat"); // Use same chat sound for now
    } else {
      // Log own messages, announcements, admin messages, server errors etc.
      logChatMessage(
        data.avatarName &&
          data.avatarName !== "Server" &&
          data.avatarName !== "Announcement"
          ? `${senderName}: ${escapeHtml(data.text)}`
          : escapeHtml(data.text),
        avatarIdStr === gameState.myAvatarId,
        data.className
      );
      if (!isSimpleFeedback) {
        if (
          avatarIdStr !== gameState.myAvatarId &&
          !data.className?.includes("announcement") &&
          !isNPC
        )
          playSound("chat");
        if (data.className?.includes("announcement")) playSound("announce");
        if (data.className?.includes("admin-msg") && !data.text.startsWith("["))
          playSound("admin");
      }
    }
  });

  socket.on("action_failed", (data) => {
    console.warn("DEBUG: Received action_failed:", JSON.stringify(data));
    const reason = data.reason || "Unknown error";
    showNotification(`Action failed: ${escapeHtml(reason)}`, "error");
    playSound("error");
  });

  // --- NEW Trade Listeners ---
  socket.on("trade_request_incoming", (data) => {
    if (data && data.tradeId && data.requesterName) {
      handleTradeRequest(data.tradeId, data.requesterName);
    } else {
      console.warn("Invalid trade_request_incoming data:", data);
    }
  });

  socket.on("trade_start", (data) => {
    if (data && data.tradeId && data.partnerId && data.partnerName) {
      showTradePanel(data.tradeId, data.partnerId, data.partnerName);
      playSound("success");
    } else {
      console.warn("Invalid trade_start data:", data);
    }
  });

  socket.on("trade_offer_update", (data) => {
    if (
      uiState.isTrading &&
      uiState.tradeSession.tradeId === data.tradeId &&
      data.offer
    ) {
      updateTradePanelOffers(data.isMyOffer, data.offer);
      updateTradeConfirmationStatus(false, false);
      if (uiState.tradeConfirmBtn) uiState.tradeConfirmBtn.disabled = true;
    }
  });

  socket.on("trade_confirm_update", (data) => {
    if (uiState.isTrading && uiState.tradeSession.tradeId === data.tradeId) {
      updateTradeConfirmationStatus(data.myConfirmed, data.partnerConfirmed);
    }
  });

  socket.on("trade_complete", (data) => {
    if (uiState.isTrading && uiState.tradeSession.tradeId === data.tradeId) {
      hideTradePanel();
      showNotification(data.message || "Trade complete!", "success");
      playSound("success");
    }
  });

  socket.on("trade_cancelled", (data) => {
    if (uiState.isTrading && uiState.tradeSession.tradeId === data.tradeId) {
      hideTradePanel();
      showNotification(
        `Trade cancelled: ${escapeHtml(data.reason) || "Unknown reason"}`,
        "warning"
      );
      playSound("error");
    }
  });

  socket.on("trade_error", (data) => {
    showNotification(
      `Trade Error: ${escapeHtml(data.reason) || "An error occurred"}`,
      "error"
    );
    playSound("error");
    if (uiState.isTrading) {
      hideTradePanel();
    }
  });
  // --- End Trade Listeners ---

  // --- Error Handling & Disconnects ---
  socket.on("connect_error", (err) => {
    console.error(`DEBUG: Received connect_error: ${err.message}`);
    console.error(`Connection Error: ${err.message}`);
    showLoadingOverlay(
      `Connection Error: ${err.message}. Please refresh or check console.`
    );
    const msgLower = err.message.toLowerCase();
    if (
      msgLower.includes("invalid token") ||
      msgLower.includes("authentication error") ||
      msgLower.includes("token expired")
    ) {
      localStorage.removeItem("authToken");
      setTimeout(() => {
        window.location.href = "/login.html";
      }, 2500);
    }
    disconnectSocket(); // Ensure client-side cleanup
    socket = null;
  });

  socket.on("auth_error", (message) => {
    console.error(`DEBUG: Received auth_error: ${message}`);
    console.error("Authentication Error:", message);
    showLoadingOverlay(`Authentication Error: ${message}. Redirecting...`);
    localStorage.removeItem("authToken");
    disconnectSocket();
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 2500);
    socket = null;
  });

  socket.on("force_disconnect", (reason) => {
    console.warn(`DEBUG: Received force_disconnect: ${reason}`);
    console.warn("Forcefully disconnected by server:", reason);
    showLoadingOverlay(`Disconnected: ${reason}. Redirecting...`);
    localStorage.removeItem("authToken");
    disconnectSocket();
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 2500);
    socket = null;
  });
} // --- End setupSocketListeners ---
