import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { gameState, uiState, camera } from "./gameState.js"; // Import camera here if needed by utils, but not directly used in this file now
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
  centerCameraOnRoom, // <-- Import the camera centering function
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
    logChatMessage("Auth token missing. Redirecting...", true, "error-msg");
    window.location.href = "/login.html";
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
    logChatMessage("Connecting to server...", true, "info-msg");
    // Connect with authentication token
    socket = io({ auth: { token: token } }); // Use io() globally available from script tag
    setupSocketListeners(); // Setup listeners *before* connect event fires
    return true; // Indicate connection attempt started
  } catch (err) {
    console.error("Failed to initialize Socket.IO:", err);
    logChatMessage("Error connecting. Check console.", true, "error-msg");
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
    // Optional: provide user feedback?
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

export function requestChangeRoom(targetRoomId, targetX, targetY) {
  const data = { targetRoomId };
  if (typeof targetX === "number" && typeof targetY === "number") {
    data.targetX = targetX;
    data.targetY = targetY;
  }
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
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = "Connected. Waiting for room state...";
    logChatMessage("Connected to server!", true, "info-msg");

    // FIX: Enable buttons that require connection/config
    uiState.openShopBtn?.removeAttribute("disabled");
    uiState.toggleEditBtn?.removeAttribute("disabled");
    // Pickup/Recolor buttons are enabled/disabled based on edit mode state, not connection

    // Game state is populated by 'room_state' event
  });

  socket.on("disconnect", (reason) => {
    console.log("Disconnected from server. Reason:", reason);
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Disconnected: ${reason}`;
    logChatMessage(`Disconnected: ${reason}`, true, "error-msg");

    // FIX: Disable buttons on disconnect
    uiState.openShopBtn?.setAttribute("disabled", "true");
    uiState.toggleEditBtn?.setAttribute("disabled", "true");
    uiState.pickupFurniBtn?.setAttribute("disabled", "true"); // Disable edit actions
    uiState.recolorBtn?.setAttribute("disabled", "true"); // Disable edit actions

    resetLocalState(); // Call the main reset function from main.js
    gameState.myAvatarId = null; // Explicitly reset player ID
    // Socket reference is cleared in disconnectSocket, which should ideally be called before this handler runs,
    // but setting to null here ensures it if disconnect happens unexpectedly.
    socket = null;
  });

  // --- Core Game State Sync ---
  socket.on("room_state", async (state) => {
    // DEBUG: Log received room state
    console.log(
      "DEBUG: Received room_state:",
      state ? `for room ${state.id}` : "INVALID STATE"
    );
    // Basic validation
    if (!CLIENT_CONFIG || !state || state.id == null || !state.layout) {
      console.error("Received invalid room_state:", state);
      logChatMessage(
        "Received invalid room data from server.",
        true,
        "error-msg"
      );
      return;
    }
    console.log(`Received room_state for room: ${state.id}`);

    // Reset local state BEFORE applying new state
    resetLocalState();

    // Apply new room state data to gameState
    gameState.currentRoomId = state.id;
    gameState.roomLayout = state.layout;
    gameState.roomCols = state.cols || state.layout[0]?.length || 0;
    gameState.roomRows = state.rows || state.layout.length;

    // Update UI elements displaying room info (via uiManager)
    if (uiState.roomNameDisplay)
      uiState.roomNameDisplay.textContent = `Room: ${state.id}`;
    document.title = `ZanyTown - ${state.id}`;

    // Create client-side tile objects
    gameState.clientTiles = [];
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

    // Process furniture: Create ClientFurniture instances
    gameState.furniture = {}; // Clear old furniture
    state.furniture?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          gameState.furniture[String(dto.id)] = new ClientFurniture(dto);
        } catch (e) {
          console.error(`Error creating ClientFurniture for DTO:`, dto, e);
        }
      } else {
        console.warn("Received invalid furniture DTO in room_state:", dto);
      }
    });

    // Process avatars: Create ClientAvatar instances
    gameState.avatars = {}; // Clear old avatars
    state.avatars?.forEach((dto) => {
      if (dto && dto.id != null) {
        try {
          const avatarIdStr = String(dto.id);
          const avatarInstance = new ClientAvatar(dto);
          // Check if this is our avatar based on ID received later
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
      } else {
        console.warn("Received invalid avatar DTO in room_state:", dto);
      }
    });

    // --- Trigger Camera Centering using uiManager ---
    // Call AFTER gameState.roomCols/Rows are set
    centerCameraOnRoom(); // <-- Call the imported function from uiManager

    logChatMessage(`Entered room: ${state.id}`, true, "info-msg");
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Room '${state.id}' loaded.`;

    // Refresh UI elements that depend on persistent state
    // These might be called again when your_avatar_id/inventory_update arrive, but
    // calling here ensures something shows up if those events are delayed/missed.
    populateInventory();
    updateCurrencyDisplay();
    updateShopButtonStates();
    // User list update usually triggered separately after join/ID assignment
  });

  socket.on("your_avatar_id", (id) => {
    const myIdString = String(id);
    // DEBUG: Log assigned ID
    console.log("DEBUG: Received your_avatar_id:", myIdString);
    gameState.myAvatarId = myIdString;

    // Update isPlayer flag for all currently loaded avatars
    Object.values(gameState.avatars).forEach((av) => {
      if (av instanceof ClientAvatar) {
        av.checkIfPlayer();
      }
    });

    // Request user list for the current room now that we know who we are
    requestUserList();
  });

  // --- Incremental Updates & Events ---
  socket.on("avatar_added", (avatarDTO) => {
    // DEBUG: Log avatar added
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
        console.log(
          `Avatar added to current room: ${avatarDTO.name} (ID: ${avatarIdStr})`
        );
        requestUserList(); // Update the user list panel
      } catch (e) {
        console.error(
          "Error creating ClientAvatar on avatar_added:",
          avatarDTO,
          e
        );
      }
    } else {
      gameState.avatars[avatarIdStr].update(avatarDTO);
      console.warn(
        `Received 'avatar_added' for existing ID ${avatarIdStr} in current room. Updated.`
      );
    }
  });

  socket.on("avatar_removed", (data) => {
    // DEBUG: Log avatar removed
    console.log("DEBUG: Received avatar_removed:", JSON.stringify(data));
    if (!data || data.id == null) return;
    const avatarIdStr = String(data.id);
    const removedAvatar = gameState.avatars[avatarIdStr];
    if (removedAvatar) {
      console.log(
        `Avatar removed from current room: ${removedAvatar.name} (${avatarIdStr})`
      );
      if (typeof removedAvatar.clearBubble === "function") {
        removedAvatar.clearBubble(); // Clear local bubble reference
      }
      delete gameState.avatars[avatarIdStr];
      requestUserList();
      if (uiState.profilePanel?.dataset.targetId === avatarIdStr) {
        hideProfilePanel();
      }
    }
  });

  socket.on("avatar_update", (avatarDTO) => {
    // DEBUG: Log avatar update (can be noisy, maybe comment out later)
    // console.log("DEBUG: Received avatar_update:", JSON.stringify(avatarDTO));
    if (!avatarDTO || avatarDTO.id == null) return;
    const avatarIdStr = String(avatarDTO.id);
    const avatar = gameState.avatars[avatarIdStr];
    if (avatar instanceof ClientAvatar) {
      const oldName = avatar.name;
      const oldState = avatar.state; // Store state *before* update
      avatar.update(avatarDTO); // Apply changes
      if (
        uiState.userListContent &&
        avatarDTO.name &&
        oldName !== avatarDTO.name
      ) {
        requestUserList(); // Update list if name changed
      }
      // Play walk sound if OTHER avatar started walking
      if (
        avatar.state === SHARED_CONFIG.AVATAR_STATE_WALKING && // Check *new* state
        oldState !== SHARED_CONFIG.AVATAR_STATE_WALKING && // Check *old* state
        avatarIdStr !== gameState.myAvatarId // Check if not self
      ) {
        playSound("walk"); // Play sound on state transition
      }
      // Play emote sound if OTHER avatar started emoting
      if (
        avatar.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        oldState !== SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        avatar.currentEmoteId &&
        avatarIdStr !== gameState.myAvatarId
      ) {
        const emoteDef =
          SHARED_CONFIG.EMOTE_DEFINITIONS?.[avatar.currentEmoteId];
        if (emoteDef?.sound) {
          playSound(emoteDef.sound);
        }
      }
    }
  });

  socket.on("furni_added", (furniDTO) => {
    // DEBUG: Log furni added
    console.log("DEBUG: Received furni_added:", JSON.stringify(furniDTO));
    if (!furniDTO || furniDTO.id == null) {
      console.warn("Received invalid furni_added DTO:", furniDTO);
      return;
    }
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
        `Received 'furni_added' for existing ID ${furniIdStr} in current room. Updated.`
      );
    }
    if (isNew) {
      playSound("place");
    }
  });

  socket.on("furni_removed", (data) => {
    // DEBUG: Log furni removed
    console.log("DEBUG: Received furni_removed:", JSON.stringify(data));
    if (!data || data.id == null) return;
    const furniIdStr = String(data.id);
    const removedFurni = gameState.furniture[furniIdStr];
    if (removedFurni) {
      console.log(
        `Furniture removed from current room: ${
          removedFurni.definition?.name || "Unknown"
        } (ID: ${furniIdStr})`
      );
      if (uiState.editMode.selectedFurnitureId === furniIdStr) {
        setSelectedFurniture(null);
      }
      if (uiState.activeRecolorFurniId === furniIdStr) {
        hideRecolorPanel();
      }
      delete gameState.furniture[furniIdStr];
    }
  });

  socket.on("furni_updated", (updateData) => {
    // DEBUG: Log furni updated
    console.log("DEBUG: Received furni_updated:", JSON.stringify(updateData));
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
        playSound("use"); // Play sound on use state change
      }
    }
  });

  // --- User/Global State Updates ---
  socket.on("inventory_update", (inventoryData) => {
    // DEBUG: Log received data
    console.log(
      "DEBUG: Received inventory_update:",
      JSON.stringify(inventoryData)
    );
    gameState.inventory =
      typeof inventoryData === "object" && inventoryData !== null
        ? inventoryData
        : {};
    populateInventory(); // Ensure this is called
    updateShopButtonStates(); // May need inventory state
  });

  socket.on("currency_update", (data) => {
    // DEBUG: Log received data
    console.log("DEBUG: Received currency_update:", JSON.stringify(data));
    if (data && typeof data.currency === "number") {
      gameState.myCurrency = data.currency;
      updateCurrencyDisplay(); // Ensure this is called
      updateShopButtonStates(); // May depend on currency
    } else {
      console.warn("Received invalid currency update:", data);
    }
  });

  socket.on("user_list_update", (users) => {
    // DEBUG: Log user list update
    console.log(
      "DEBUG: Received user_list_update:",
      users ? `${users.length} users` : "INVALID DATA"
    );
    updateUserListPanel(users || []);
  });

  socket.on("show_profile", (profileData) => {
    // DEBUG: Log profile data
    console.log("DEBUG: Received show_profile:", JSON.stringify(profileData));
    if (!profileData || !profileData.id) {
      console.warn("Received invalid profile data:", profileData);
      return;
    }
    showProfilePanel(profileData);
  });

  // --- Chat & Feedback ---
  socket.on("chat_message", (data) => {
    // DEBUG: Log received chat data
    console.log("DEBUG: Received chat_message:", JSON.stringify(data));
    if (!data || typeof data.text !== "string") return;

    const avatarIdStr = data.avatarId ? String(data.avatarId) : null;
    const avatar = avatarIdStr ? gameState.avatars[avatarIdStr] : null;
    const senderName = avatar ? avatar.name : data.avatarName || "Unknown";
    const messageText = data.avatarId
      ? `${senderName}: ${data.text}`
      : data.text;
    let messageClass = data.className || "";
    const receivedIsAdmin = data.isAdmin || false;

    // Manage chat bubble
    if (avatar instanceof ClientAvatar) {
      if (typeof avatar.say === "function") {
        avatar.say(data.text); // Let avatar handle bubble creation data
      }
      // Play sound for others
      if (avatarIdStr !== gameState.myAvatarId) {
        playSound("chat");
      }
    } else if (
      data.avatarName &&
      !["Server", "Announcement", "Admin"].includes(data.avatarName)
    ) {
      // Play sound for other non-avatar messages (e.g., if sender not visible)
      if (avatarIdStr !== gameState.myAvatarId) {
        playSound("chat");
      }
    } else {
      // Play sound for Server/Admin/Announcement
      playSound("chat");
    }

    if (receivedIsAdmin && data.avatarName !== "Admin") {
      messageClass += " admin-msg";
    }

    // Log to chat box
    logChatMessage(
      messageText,
      avatarIdStr === gameState.myAvatarId,
      messageClass.trim()
    ); // Ensure this is called correctly
  });

  socket.on("action_failed", (data) => {
    // DEBUG: Log action failed
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
    // DEBUG: Log connect error
    console.error(`DEBUG: Received connect_error: ${err.message}`);
    console.error(`Connection Error: ${err.message}`);
    logChatMessage(`Connection Error: ${err.message}`, true, "error-msg");
    const msgLower = err.message.toLowerCase();
    if (
      msgLower.includes("invalid token") ||
      msgLower.includes("authentication error") ||
      msgLower.includes("token expired")
    ) {
      localStorage.removeItem("authToken");
      window.location.href = "/login.html"; // Redirect on critical auth failure
    } else {
      // For other connection errors, try to reconnect or show a persistent error?
      // Socket.IO might attempt reconnection automatically depending on config.
    }
    if (uiState.debugDiv)
      uiState.debugDiv.textContent = `Conn Err: ${err.message}`;
    // Resetting local state is handled by the 'disconnect' event which usually follows.
  });

  socket.on("auth_error", (message) => {
    // DEBUG: Log auth error
    console.error(`DEBUG: Received auth_error: ${message}`);
    console.error("Authentication Error:", message);
    logChatMessage(message, true, "error-msg");
    localStorage.removeItem("authToken");
    disconnectSocket(); // Disconnect client-side explicitly
    window.location.href = "/login.html"; // Redirect on critical auth failure
  });

  socket.on("force_disconnect", (reason) => {
    // DEBUG: Log force disconnect
    console.warn(`DEBUG: Received force_disconnect: ${reason}`);
    console.warn("Forcefully disconnected by server:", reason);
    logChatMessage(`Disconnected: ${reason}`, true, "error-msg");
    localStorage.removeItem("authToken");
    disconnectSocket(); // Ensure socket is closed client-side
    // alert(`Disconnected: ${reason}`); // Alert might be annoying, chat message is enough
    window.location.href = "/login.html"; // Redirect to login
  });
} // end setupSocketListeners
