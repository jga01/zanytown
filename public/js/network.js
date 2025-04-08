import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { gameState, uiState, camera } from "./gameState.js";
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
  hideShopPanel,
  updatePickupButtonState,
  updateRecolorButtonState,
  updateInventorySelection,
  updateUICursor,
  centerCameraOnRoom,
  showLoadingOverlay, // For explicit loading state control
  hideLoadingOverlay, // For hiding overlay after load
  updateAdminUI, // To update admin controls visibility/state
  updateAdminRoomList, // To populate the admin room list
} from "./uiManager.js";
import { playSound } from "./sounds.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientTile } from "./gameObjects/ClientTile.js"; // Needed for room_state processing
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";

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
    logChatMessage("Not connected to server.", true, "error-msg");
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
  showLoadingOverlay(`Joining Room: ${targetRoomId}...`);
  emitIfConnected("request_change_room", data);
}

// --- NEW Admin Emitters ---
export function requestCreateRoom(roomId, cols, rows) {
  const data = { roomId };
  if (cols) data.cols = cols;
  if (rows) data.rows = rows;
  emitIfConnected("request_create_room", data);
}

export function requestModifyLayout(roomId, x, y, type) {
  // Server uses socket's current room, roomId isn't strictly needed but can be explicit
  // emitIfConnected('request_modify_layout', { roomId, x, y, type });
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
  socket.off("connect");
  socket.off("disconnect");
  socket.off("room_state");
  socket.off("your_avatar_id");
  socket.off("avatar_added");
  socket.off("avatar_removed");
  socket.off("avatar_update");
  socket.off("furni_added");
  socket.off("furni_removed");
  socket.off("furni_updated");
  socket.off("inventory_update");
  socket.off("currency_update");
  socket.off("user_list_update");
  socket.off("show_profile");
  socket.off("chat_message");
  socket.off("action_failed");
  socket.off("connect_error");
  socket.off("auth_error");
  socket.off("force_disconnect");
  socket.off("layout_tile_update"); // NEW
  socket.off("all_room_ids_update"); // NEW

  // --- Connection Lifecycle ---
  socket.on("connect", () => {
    console.log("Connected to server with ID:", socket.id);
    showLoadingOverlay("Connected. Waiting for Player Data...");
    if (uiState.debugDiv) uiState.debugDiv.textContent = "Connected...";
    logChatMessage("Connected to server!", true, "info-msg");
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected from server. Reason:", reason);
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`);
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Disconnected: ${reason}`;
    resetLocalState(); // Reset client game state
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`); // Re-show disconnect message
    gameState.myAvatarId = null;
    socket = null; // Clear socket reference
    // Disable UI buttons
    uiState.openShopBtn?.setAttribute("disabled", "true");
    uiState.toggleEditBtn?.setAttribute("disabled", "true");
    uiState.pickupFurniBtn?.setAttribute("disabled", "true");
    uiState.recolorFurniBtn?.setAttribute("disabled", "true");
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
    gameState.clientTiles = [];
    gameState.highlightedTile = null;
    gameState.roomLayout = [];
    gameState.roomCols = 0;
    gameState.roomRows = 0;
    if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
    uiState.activeChatBubbles = [];
    hideProfilePanel();
    hideRecolorPanel();
    hideShopPanel();
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
    updatePickupButtonState();
    updateRecolorButtonState();
    updateInventorySelection();
    updateUICursor();
    if (uiState.toggleEditBtn) {
      uiState.toggleEditBtn.textContent = `Make Stuff? (Off)`;
      uiState.toggleEditBtn.classList.remove("active");
    }
    // --- End Partial Reset ---

    gameState.currentRoomId = state.id;
    gameState.roomLayout = state.layout;
    gameState.roomCols = state.cols || state.layout[0]?.length || 0;
    gameState.roomRows = state.rows || state.layout.length;

    if (uiState.roomNameDisplay)
      uiState.roomNameDisplay.textContent = `Room: ${state.id}`;
    document.title = `ZanyTown - ${state.id}`;

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

    // Process avatars (and identify player)
    state.avatars?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          const avatarIdStr = String(dto.id);
          const avatarInstance = new ClientAvatar(dto);
          // Check if this is our avatar (gameState.myAvatarId should be set by your_avatar_id)
          if (
            gameState.myAvatarId &&
            avatarInstance.id === gameState.myAvatarId
          ) {
            avatarInstance.isPlayer = true;
            console.log(
              `[room_state] Identified MY AVATAR: ${dto.name} (ID: ${avatarIdStr})`
            );
            updateAdminUI(); // Update admin controls based on player status
          }
          gameState.avatars[avatarIdStr] = avatarInstance;
        } catch (e) {
          console.error(`Error creating ClientAvatar:`, dto, e);
        }
      } else console.warn("Invalid avatar DTO in room_state:", dto);
    });

    centerCameraOnRoom(); // Center camera on the new room
    hideLoadingOverlay(); // Hide overlay AFTER processing complete

    logChatMessage(`Entered room: ${state.id}`, true, "info-msg");
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Room '${state.id}' loaded.`;

    // Enable buttons
    uiState.openShopBtn?.removeAttribute("disabled");
    uiState.toggleEditBtn?.removeAttribute("disabled");
    // Pickup/Recolor buttons depend on edit state/selection, handled elsewhere

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
    // Update isPlayer flag for the avatar if already present (race condition handling)
    if (gameState.avatars[myIdString]) {
      gameState.avatars[myIdString].checkIfPlayer();
      updateAdminUI(); // Update admin UI now that we know if player is admin
    }
    requestUserList(); // Request user list now
  });

  // --- Incremental Updates & Events ---
  socket.on("avatar_added", (avatarDTO) => {
    // console.log("DEBUG: Received avatar_added:", JSON.stringify(avatarDTO));
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
        newAvatar.checkIfPlayer(); // Check if this is the player avatar
        gameState.avatars[avatarIdStr] = newAvatar;
        console.log(`Avatar added: ${avatarDTO.name} (ID: ${avatarIdStr})`);
        requestUserList(); // Update user list
      } catch (e) {
        console.error(
          "Error creating ClientAvatar on avatar_added:",
          avatarDTO,
          e
        );
      }
    } else {
      gameState.avatars[avatarIdStr].update(
        avatarDTO
      ); /* ... update existing ... */
    }
  });

  socket.on("avatar_removed", (data) => {
    // console.log("DEBUG: Received avatar_removed:", JSON.stringify(data));
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
    // console.log("DEBUG: Received avatar_update:", JSON.stringify(avatarDTO)); // Noisy
    if (!avatarDTO || avatarDTO.id == null) return;
    const avatarIdStr = String(avatarDTO.id);
    const avatar = gameState.avatars[avatarIdStr];
    if (avatar instanceof ClientAvatar) {
      const oldState = avatar.state;
      const oldName = avatar.name; // Track name changes
      const oldIsAdmin = avatar.isAdmin; // Track admin status changes
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
      // Update user list if name changed
      if (avatarDTO.name && oldName !== avatar.name) requestUserList();
    }
  });

  socket.on("furni_added", (furniDTO) => {
    // console.log("DEBUG: Received furni_added:", JSON.stringify(furniDTO));
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
      gameState.furniture[furniIdStr].update(
        furniDTO
      ); /* ... update existing ... */
    }
    if (isNew) playSound("place");
  });

  socket.on("furni_removed", (data) => {
    // console.log("DEBUG: Received furni_removed:", JSON.stringify(data));
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
    // console.log("DEBUG: Received furni_updated:", JSON.stringify(updateData));
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

  // --- Layout Update Listener ---
  socket.on("layout_tile_update", (data) => {
    // console.log("DEBUG: Received layout_tile_update:", JSON.stringify(data));
    if (!data || data.x == null || data.y == null || data.type == null) {
      /* ... error handling ... */ return;
    }
    const tile = gameState.clientTiles?.find(
      (t) => t.x === data.x && t.y === data.y
    );
    if (tile instanceof ClientTile) {
      tile.layoutType = data.type;
      tile._setBaseColor(); // Update visual
      // If placing item, re-validate placement after layout change
      if (
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING
      ) {
        updateHighlights();
      }
    } else {
      /* ... error handling ... */
    }
  });

  // --- User/Global State Updates ---
  socket.on("inventory_update", (inventoryData) => {
    // console.log("DEBUG: Received inventory_update:", JSON.stringify(inventoryData));
    gameState.inventory =
      typeof inventoryData === "object" && inventoryData !== null
        ? inventoryData
        : {};
    populateInventory();
    updateShopButtonStates(); // Check if purchase now possible/impossible
  });

  socket.on("currency_update", (data) => {
    // console.log("DEBUG: Received currency_update:", JSON.stringify(data));
    if (data && typeof data.currency === "number") {
      gameState.myCurrency = data.currency;
      updateCurrencyDisplay();
      updateShopButtonStates(); // Check if purchase now possible/impossible
    } else console.warn("Received invalid currency update:", data);
  });

  socket.on("user_list_update", (users) => {
    // console.log("DEBUG: Received user_list_update:", users ? `${users.length} users` : "INVALID DATA");
    updateUserListPanel(users || []);
  });

  socket.on("show_profile", (profileData) => {
    // console.log("DEBUG: Received show_profile:", JSON.stringify(profileData));
    if (!profileData || !profileData.id) return;
    showProfilePanel(profileData);
  });

  // --- Admin Room List Update ---
  socket.on("all_room_ids_update", (roomIds) => {
    // console.log("DEBUG: Received all_room_ids_update:", roomIds);
    if (Array.isArray(roomIds)) {
      updateAdminRoomList(roomIds);
    } else {
      console.warn("Received invalid data for all_room_ids_update:", roomIds);
    }
  });

  // --- Chat & Feedback ---
  socket.on("chat_message", (data) => {
    // console.log("DEBUG: Received chat_message:", JSON.stringify(data));
    if (!data || typeof data.text !== "string") return;
    const avatarIdStr = data.avatarId ? String(data.avatarId) : null;
    const avatar = avatarIdStr ? gameState.avatars[avatarIdStr] : null;
    const senderName = avatar ? avatar.name : data.avatarName || "Unknown";
    const messageText = avatarIdStr ? `${senderName}: ${data.text}` : data.text; // Prepend sender name
    let messageClass = data.className || "";
    const receivedIsAdmin = data.isAdmin || false;

    if (avatar instanceof ClientAvatar) {
      avatar.say?.(data.text); // Display bubble
      if (avatarIdStr !== gameState.myAvatarId) playSound("chat"); // Sound for others
    } else {
      playSound("chat");
    } // Sound for server/announce

    if (receivedIsAdmin && data.avatarName !== "Admin")
      messageClass += " admin-msg"; // Style admin chat
    logChatMessage(
      messageText,
      avatarIdStr === gameState.myAvatarId,
      messageClass.trim()
    );
  });

  socket.on("action_failed", (data) => {
    console.warn("DEBUG: Received action_failed:", JSON.stringify(data));
    logChatMessage(
      `Action failed: ${data.reason || "Unknown error"}`,
      true,
      "error-msg"
    );
    // playSound('error'); // Optional error sound
  });

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
