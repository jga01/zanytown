import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { gameState, uiState, camera } from "./gameState.js";
import { resetLocalState } from "./main.js"; // Import the main reset function
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
  centerCameraOnRoom, // <-- Import the camera centering function
  showLoadingOverlay, // <-- Import loading overlay helper
  hideLoadingOverlay, // <-- Import loading overlay helper
} from "./uiManager.js";
import { playSound } from "./sounds.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientTile } from "./gameObjects/ClientTile.js"; // Needed for room_state processing
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";

let socket = null;

/** Establishes connection to the server. Returns true if attempt started, false otherwise. */
export function connectToServer() {
  const token = localStorage.getItem("authToken");
  if (!token) {
    console.log("No auth token found, directing to login.");
    // Use loading overlay for feedback before redirect
    showLoadingOverlay("Auth token missing. Redirecting...");
    // Allow time for message to show before redirect
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 1500);
    return false;
  }

  // Disconnect existing socket if any (prevents multiple connections)
  if (socket && socket.connected) {
    console.log(
      "connectToServer called but socket already exists. Disconnecting old one first."
    );
    socket.disconnect();
    socket = null;
  }

  try {
    showLoadingOverlay("Connecting to Server..."); // Show connecting message
    // Connect with authentication token
    socket = io({ auth: { token: token } }); // Use io() globally available from script tag
    setupSocketListeners(); // Setup listeners *before* connect event fires
    return true; // Indicate connection attempt started
  } catch (err) {
    console.error("Failed to initialize Socket.IO:", err);
    showLoadingOverlay("Error: Connection Failed. Check console."); // Show error on overlay
    if (uiState.debugDiv) uiState.debugDiv.textContent = "Connection Error";
    return false; // Indicate connection failure
  }
}

/** Returns true if the socket is currently connected. */
export function isConnected() {
  return socket?.connected || false;
}

/** Disconnects the socket. */
export function disconnectSocket() {
  if (socket) {
    console.log("Disconnecting socket...");
    socket.disconnect();
    socket = null; // Clear reference
  }
}

// --- Emit Functions (Wrappers around socket.emit) ---

/** Safely emits an event if connected. */
function emitIfConnected(event, data) {
  if (isConnected()) {
    socket.emit(event, data);
  } else {
    console.warn(
      `Attempted to emit "${event}" while disconnected. Data:`,
      data
    );
    // Provide user feedback via chat/log
    logChatMessage("Not connected to server.", true, "error-msg");
    // Optional: Could flash an error indicator
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
  emitIfConnected("request_rotate_furni", { furniId: String(furniId) }); // Ensure string ID
}

export function requestPickupFurni(furniId) {
  emitIfConnected("request_pickup_furni", { furniId: String(furniId) }); // Ensure string ID
}

export function requestSit(furniId) {
  emitIfConnected("request_sit", { furniId: String(furniId) }); // Ensure string ID
}

export function requestStand() {
  emitIfConnected("request_stand");
}

export function requestUserList() {
  emitIfConnected("request_user_list");
}

export function requestProfile(avatarId) {
  emitIfConnected("request_profile", { avatarId: String(avatarId) }); // Ensure string ID
}

export function requestUseFurni(furniId) {
  emitIfConnected("request_use_furni", { furniId: String(furniId) }); // Ensure string ID
}

export function requestRecolorFurni(furniId, colorHex) {
  emitIfConnected("request_recolor_furni", {
    furniId: String(furniId), // Ensure string ID
    colorHex: colorHex ?? "", // Ensure value is passed (empty for reset)
  });
}

export function requestBuyItem(itemId) {
  emitIfConnected("request_buy_item", { itemId });
}

// Modified to show loading state immediately
export function requestChangeRoom(targetRoomId, targetX, targetY) {
  const data = { targetRoomId };
  if (typeof targetX === "number" && typeof targetY === "number") {
    data.targetX = targetX;
    data.targetY = targetY;
  }
  showLoadingOverlay(`Joining Room: ${targetRoomId}...`); // Show overlay before sending request
  emitIfConnected("request_change_room", data);
}

// --- Socket Event Listeners ---
async function setupSocketListeners() {
  if (!socket) {
    console.error("Socket not initialized before setting up listeners.");
    return;
  }

  // --- Connection Lifecycle ---
  socket.on("connect", () => {
    console.log("Connected to server with ID:", socket.id);
    // Update loading message, overlay stays until room_state received
    showLoadingOverlay("Connected. Waiting for Player Data...");
    if (uiState.debugDiv) uiState.debugDiv.textContent = "Connected...";
    logChatMessage("Connected to server!", true, "info-msg");
    // Buttons enabled later by room_state or other updates
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected from server. Reason:", reason);
    // Show overlay with disconnect reason
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`);
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Disconnected: ${reason}`;
    // resetLocalState() implicitly shows "Loading Room...", but the overlay already has the disconnect reason.
    // We still need to reset the game state internally.
    resetLocalState(); // Clears game state, shows overlay briefly
    // Ensure the disconnect message persists on the overlay
    showLoadingOverlay(`Disconnected: ${reason}. Please refresh.`);
    gameState.myAvatarId = null;
    socket = null; // Clear socket reference

    // Disable UI interaction buttons
    uiState.openShopBtn?.setAttribute("disabled", "true");
    uiState.toggleEditBtn?.setAttribute("disabled", "true");
    uiState.pickupFurniBtn?.setAttribute("disabled", "true");
    uiState.recolorFurniBtn?.setAttribute("disabled", "true");
  });

  // --- Core Game State Sync ---
  socket.on("room_state", async (state) => {
    console.log(
      "DEBUG: Received room_state:",
      state ? `for room ${state.id}` : "INVALID STATE"
    );
    if (!CLIENT_CONFIG || !state || state.id == null || !state.layout) {
      console.error("Received invalid room_state:", state);
      // Show error on overlay and stop processing
      showLoadingOverlay("Error: Invalid room data received.");
      return;
    }
    console.log(`Received room_state for room: ${state.id}`);
    // Update overlay message while processing
    showLoadingOverlay("Initializing Room...");

    // Reset local state *specifically for room data* before applying new state
    // Avoid full resetUIState() here as it shows "Loading Room..." again
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

    // Apply new room state data to gameState
    gameState.currentRoomId = state.id;
    gameState.roomLayout = state.layout;
    gameState.roomCols = state.cols || state.layout[0]?.length || 0;
    gameState.roomRows = state.rows || state.layout.length;

    // Update UI elements displaying room info
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
          console.error(`Error creating ClientFurniture for DTO:`, dto, e);
        }
      } else console.warn("Received invalid furniture DTO in room_state:", dto);
    });

    // Process avatars
    state.avatars?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          const avatarIdStr = String(dto.id);
          const avatarInstance = new ClientAvatar(dto);
          // Check if this is our avatar (using gameState.myAvatarId which should be set by now)
          if (
            gameState.myAvatarId &&
            avatarInstance.id === gameState.myAvatarId
          ) {
            avatarInstance.isPlayer = true;
            console.log(
              `[room_state] Identified MY AVATAR: ${dto.name} (ID: ${avatarIdStr})`
            );
          }
          gameState.avatars[avatarIdStr] = avatarInstance;
        } catch (e) {
          console.error(`Error creating ClientAvatar for DTO:`, dto, e);
        }
      } else console.warn("Received invalid avatar DTO in room_state:", dto);
    });

    // --- Trigger Camera Centering ---
    centerCameraOnRoom();

    // --- HIDE OVERLAY ---
    hideLoadingOverlay(); // Hide overlay AFTER processing is complete

    logChatMessage(`Entered room: ${state.id}`, true, "info-msg");
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Room '${state.id}' loaded.`;

    // Enable buttons now that room is loaded
    uiState.openShopBtn?.removeAttribute("disabled");
    uiState.toggleEditBtn?.removeAttribute("disabled");
    // Other buttons (pickup/recolor) depend on edit state, handled elsewhere

    // Refresh UI (Inventory might depend on a separate update event, call here as fallback)
    populateInventory();
    updateCurrencyDisplay(); // Currency might also be separate, but refresh just in case
    updateShopButtonStates();
    // User list update often happens after join ack or your_avatar_id
  });

  socket.on("your_avatar_id", (id) => {
    const myIdString = String(id);
    console.log("DEBUG: Received your_avatar_id:", myIdString);
    gameState.myAvatarId = myIdString;

    // Update isPlayer flag for all currently loaded avatars
    Object.values(gameState.avatars).forEach((av) => {
      if (av instanceof ClientAvatar) av.checkIfPlayer();
    });
    // Request user list now that we know who we are
    requestUserList();
    // Can update loading message if overlay is somehow still visible
    // showLoadingOverlay("Player Ready. Waiting for Room Data...");
  });

  // --- Incremental Updates & Events ---
  // (avatar_added, avatar_removed, avatar_update, furni_added, etc. remain the same)
  // These handlers should NOT interact with the loading overlay.

  socket.on("avatar_added", (avatarDTO) => {
    console.log("DEBUG: Received avatar_added:", JSON.stringify(avatarDTO));
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
        requestUserList(); // Update user list
      } catch (e) {
        console.error(
          "Error creating ClientAvatar on avatar_added:",
          avatarDTO,
          e
        );
      }
    } else {
      gameState.avatars[avatarIdStr].update(avatarDTO); // Update if exists (e.g., quick rejoin)
      console.warn(
        `Received 'avatar_added' for existing ID ${avatarIdStr}. Updated.`
      );
    }
  });

  socket.on("avatar_removed", (data) => {
    console.log("DEBUG: Received avatar_removed:", JSON.stringify(data));
    if (!data || data.id == null) return;
    const avatarIdStr = String(data.id);
    const removedAvatar = gameState.avatars[avatarIdStr];
    if (removedAvatar) {
      console.log(`Avatar removed: ${removedAvatar.name} (${avatarIdStr})`);
      removedAvatar.clearBubble?.(); // Clear bubble if exists
      delete gameState.avatars[avatarIdStr];
      requestUserList(); // Update user list
      if (uiState.profilePanel?.dataset.targetId === avatarIdStr)
        hideProfilePanel(); // Close profile if viewing removed user
    }
  });

  socket.on("avatar_update", (avatarDTO) => {
    // console.log("DEBUG: Received avatar_update:", JSON.stringify(avatarDTO)); // Can be noisy
    if (!avatarDTO || avatarDTO.id == null) return;
    const avatarIdStr = String(avatarDTO.id);
    const avatar = gameState.avatars[avatarIdStr];
    if (avatar instanceof ClientAvatar) {
      const oldState = avatar.state;
      avatar.update(avatarDTO);
      // Play sounds for state changes for OTHER avatars
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
      // Update user list if name changed (though names shouldn't change often)
      if (avatarDTO.name && avatar.name !== avatarDTO.name) requestUserList();
    }
  });

  socket.on("furni_added", (furniDTO) => {
    console.log("DEBUG: Received furni_added:", JSON.stringify(furniDTO));
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
      gameState.furniture[furniIdStr].update(furniDTO);
      console.warn(
        `Received 'furni_added' for existing ID ${furniIdStr}. Updated.`
      );
    }
    if (isNew) playSound("place"); // Sound feedback for placement
  });

  socket.on("furni_removed", (data) => {
    console.log("DEBUG: Received furni_removed:", JSON.stringify(data));
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
        setSelectedFurniture(null); // Deselect if removed
      if (uiState.activeRecolorFurniId === furniIdStr) hideRecolorPanel(); // Close recolor if removed
      delete gameState.furniture[furniIdStr];
      // Maybe play pickup sound for feedback? playSound('pickup');
    }
  });

  socket.on("furni_updated", (updateData) => {
    console.log("DEBUG: Received furni_updated:", JSON.stringify(updateData));
    if (!updateData || updateData.id == null) return;
    const furniIdStr = String(updateData.id);
    const furni = gameState.furniture[furniIdStr];
    if (furni instanceof ClientFurniture) {
      const oldState = furni.state;
      furni.update(updateData);
      // Play sound on use state change
      if (
        updateData.state !== undefined &&
        oldState !== updateData.state &&
        furni.definition?.canUse
      ) {
        playSound("use");
      }
    }
  });

  // --- User/Global State Updates ---
  socket.on("inventory_update", (inventoryData) => {
    console.log(
      "DEBUG: Received inventory_update:",
      JSON.stringify(inventoryData)
    );
    gameState.inventory =
      typeof inventoryData === "object" && inventoryData !== null
        ? inventoryData
        : {};
    populateInventory(); // Refresh inventory UI
    updateShopButtonStates(); // Shop buttons depend on inventory/currency
  });

  socket.on("currency_update", (data) => {
    console.log("DEBUG: Received currency_update:", JSON.stringify(data));
    if (data && typeof data.currency === "number") {
      gameState.myCurrency = data.currency;
      updateCurrencyDisplay(); // Refresh currency UI
      updateShopButtonStates(); // Shop buttons depend on currency
    } else console.warn("Received invalid currency update:", data);
  });

  socket.on("user_list_update", (users) => {
    console.log(
      "DEBUG: Received user_list_update:",
      users ? `${users.length} users` : "INVALID DATA"
    );
    updateUserListPanel(users || []); // Refresh user list UI
  });

  socket.on("show_profile", (profileData) => {
    console.log("DEBUG: Received show_profile:", JSON.stringify(profileData));
    if (!profileData || !profileData.id) return;
    showProfilePanel(profileData); // Show profile UI
  });

  // --- Chat & Feedback ---
  socket.on("chat_message", (data) => {
    console.log("DEBUG: Received chat_message:", JSON.stringify(data));
    if (!data || typeof data.text !== "string") return;

    const avatarIdStr = data.avatarId ? String(data.avatarId) : null;
    const avatar = avatarIdStr ? gameState.avatars[avatarIdStr] : null;
    const senderName = avatar ? avatar.name : data.avatarName || "Unknown";
    const messageText = data.avatarId
      ? `${senderName}: ${data.text}`
      : data.text; // Prepend sender name if from avatar
    let messageClass = data.className || "";
    const receivedIsAdmin = data.isAdmin || false;

    // Display chat bubble if from an avatar
    if (avatar instanceof ClientAvatar) {
      avatar.say?.(data.text); // Let avatar handle bubble data creation
      if (avatarIdStr !== gameState.myAvatarId) playSound("chat"); // Play sound for others' messages
    } else {
      // Play sound for non-avatar messages like Server/Admin/Announce
      playSound("chat");
    }

    // Add admin styling if applicable
    if (receivedIsAdmin && data.avatarName !== "Admin")
      messageClass += " admin-msg";

    // Log message to the chat box
    logChatMessage(
      messageText,
      avatarIdStr === gameState.myAvatarId,
      messageClass.trim()
    );
  });

  socket.on("action_failed", (data) => {
    console.warn("DEBUG: Received action_failed:", JSON.stringify(data));
    console.warn(
      `Action Failed: ${data.action}. Reason: ${
        data.reason || "No reason specified"
      }`
    );
    logChatMessage(
      `Action failed: ${data.reason || "Unknown error"}`,
      true,
      "error-msg"
    );
    // Optional: Play an error sound
    // playSound('error');
  });

  // --- Error Handling & Disconnects ---
  socket.on("connect_error", (err) => {
    console.error(`DEBUG: Received connect_error: ${err.message}`);
    console.error(`Connection Error: ${err.message}`);
    // Show error on overlay and trigger disconnect logic
    showLoadingOverlay(
      `Connection Error: ${err.message}. Please refresh or check console.`
    );
    // Disconnect logic handles state reset and UI updates
    const msgLower = err.message.toLowerCase();
    if (
      msgLower.includes("invalid token") ||
      msgLower.includes("authentication error") ||
      msgLower.includes("token expired")
    ) {
      localStorage.removeItem("authToken");
      // Add a delay before redirecting to allow user to see message
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
    disconnectSocket(); // Disconnect client-side explicitly
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 2500); // Redirect after delay
    socket = null;
  });

  socket.on("force_disconnect", (reason) => {
    console.warn(`DEBUG: Received force_disconnect: ${reason}`);
    console.warn("Forcefully disconnected by server:", reason);
    showLoadingOverlay(`Disconnected: ${reason}. Redirecting...`);
    localStorage.removeItem("authToken");
    disconnectSocket(); // Ensure socket is closed client-side
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 2500); // Redirect to login after delay
    socket = null;
  });
} // end setupSocketListeners
