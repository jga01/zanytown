import { loadConfig, CLIENT_CONFIG, SHARED_CONFIG } from "./config.js";
import {
  initializeGameState,
  gameState,
  uiState,
  camera,
} from "./gameState.js";
import { connectToServer, disconnectSocket } from "./network.js";
import { initRenderer, resizeRenderer } from "./renderer.js";
import {
  initUIManager,
  resetUIState,
  hideProfilePanel,
  hideRecolorPanel,
  hideShopPanel,
  updatePickupButtonState,
  updateRecolorButtonState,
  updateInventorySelection,
  updateUICursor,
  updateCurrencyDisplay, // Keep import, used in initClient
  populateInventory,
  updateUserListPanel,
  logChatMessage, // Keep import, used in initClient
  centerCameraOnRoom,
} from "./uiManager.js";
import { setupInputListeners, cleanupInputListeners } from "./inputHandler.js";
import { startGameLoop, stopGameLoop } from "./gameLoop.js";
import { loadSounds } from "./sounds.js";
import { debounce } from "./utils.js";

// Game Object Classes (needed if resetLocalState clears them)
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientTile } from "./gameObjects/ClientTile.js";

/** Main initialization function, called on DOMContentLoaded. */
async function initClient() {
  console.log("Initializing Client...");

  // --- Pre-initialization: Check Auth Token ---
  const token = localStorage.getItem("authToken");
  if (!token) {
    console.log("No auth token found, directing to login.");
    window.location.href = "/login.html";
    return; // Stop initialization
  }

  // --- Step 1: Show Basic Loading State ---
  // (Optional: Add a loading overlay here)

  // --- Step 2: Load Configuration (Await it!) ---
  const configLoaded = await loadConfig();
  if (!configLoaded) {
    return; // Stop initialization if config fails
  }
  console.log(
    "Configuration loaded successfully. CLIENT_CONFIG is now available."
  );

  // --- Step 3: Initialize UI Manager (Find DOM Elements) ---
  initUIManager();
  if (!uiState.canvas || !uiState.ctx || !uiState.gameContainer) {
    console.error(
      "FATAL: Critical UI elements (canvas/container) not found after UI Manager init!"
    );
    document.body.innerHTML =
      '<h1 style="color:red; text-align:center; margin-top: 50px;">Critical Error: Failed to find game elements. Please refresh.</h1>';
    return;
  }
  console.log("UI Manager Initialized successfully.");

  // --- Step 4: Initialize Game State (Uses Config) ---
  initializeGameState(CLIENT_CONFIG);

  // --- Step 5: Initialize Renderer ---
  if (!initRenderer(uiState.canvas, uiState.ctx)) {
    console.error("FATAL: Failed to initialize renderer!");
    alert(
      "Error initializing graphics. Please refresh or try a different browser."
    );
    return;
  }

  // --- Step 6: Disable Interaction Buttons Initially ---
  uiState.openShopBtn?.setAttribute("disabled", "true");
  uiState.toggleEditBtn?.setAttribute("disabled", "true");
  uiState.pickupFurniBtn?.setAttribute("disabled", "true");
  // Corrected button name based on config/initUIManager
  uiState.recolorFurniBtn?.setAttribute("disabled", "true");

  // --- Step 7: Initial Canvas Resize & Setup Listener ---
  const debouncedResize = debounce(() => {
    if (uiState.gameContainer) {
      resizeRenderer(
        uiState.gameContainer.clientWidth,
        uiState.gameContainer.clientHeight
      );
    }
  }, 100);

  requestAnimationFrame(() => {
    if (uiState.gameContainer) {
      resizeRenderer(
        uiState.gameContainer.clientWidth,
        uiState.gameContainer.clientHeight
      );
    }
    window.addEventListener("resize", debouncedResize);
  });

  // --- Step 8: Load Sounds ---
  loadSounds();

  // --- Step 9: Setup Input Listeners ---
  setupInputListeners();

  // --- Step 10: Reset State ---
  resetLocalState();
  updateCurrencyDisplay(); // Show initial '...' state - call is fine, function uses correct internal names now
  logChatMessage("Welcome to ZanyTown!", true, "info-msg"); // Call is fine, function uses correct internal names now

  // --- Step 11: Connect to Server ---
  if (connectToServer()) {
    console.log("Attempting connection to server...");
  } else {
    console.error("Failed to initiate server connection.");
    logChatMessage(
      "Error starting connection. Please refresh.",
      true,
      "error-msg"
    );
    return;
  }

  // --- Step 12: Start Game Loop ---
  startGameLoop();

  console.log("Client Initialization sequence complete (pending connection).");
}

/**
 * Resets the local client state, typically called on room change or disconnect.
 * Clears room-specific data but preserves global data loaded from user profile
 * (like inventory, currency - though their display might be reset by UI).
 */
export function resetLocalState() {
  console.log("Resetting local client room state...");

  // --- Clear Room-Specific Game Objects/State ---
  Object.values(gameState.avatars || {}).forEach((a) => {
    if (a instanceof ClientAvatar && typeof a.clearBubble === "function") {
      a.clearBubble();
    }
  });
  gameState.furniture = {};
  gameState.avatars = {};
  gameState.clientTiles = [];
  gameState.highlightedTile = null;
  gameState.roomLayout = [];
  gameState.roomCols = 0;
  gameState.roomRows = 0;
  gameState.currentRoomId = null;

  // --- Reset UI State related to room context ---
  // resetUIState handles its own internal names correctly now
  resetUIState();

  // --- Reset Edit Mode State ---
  uiState.isEditMode = false;
  uiState.editMode.state = CLIENT_CONFIG?.EDIT_STATE_NAVIGATE || "navigate";
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;

  // --- Update UI Buttons/Cursor ---
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();

  if (uiState.toggleEditBtn) {
    // toggleEditBtn name is correct
    uiState.toggleEditBtn.textContent = `Make Stuff? (Off)`;
    uiState.toggleEditBtn.classList.remove("active");
  }

  // --- Update Displays to Loading/Default State ---
  // Corrected property names used here:
  if (uiState.inventoryItems)
    uiState.inventoryItems.innerHTML = "<p><i>Loading...</i></p>";
  if (uiState.playerCurrency)
    uiState.playerCurrency.textContent = "Silly Coins: ...";
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Connecting...";
}

// --- Cleanup ---
function cleanup() {
  console.log("Cleaning up client before unload...");
  stopGameLoop();
  disconnectSocket();
  cleanupInputListeners();
  // Consider removing resize listener if needed
}

// Add listener for page unload events
window.addEventListener("beforeunload", cleanup);

// --- Start Initialization on DOM Load ---
document.addEventListener("DOMContentLoaded", initClient);
