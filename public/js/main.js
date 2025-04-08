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
  resetUIState, // Although resetUIState shows overlay, main.js calls it during initialization logic path modification
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
  showLoadingOverlay, // Import showLoadingOverlay
  hideLoadingOverlay, // Import hideLoadingOverlay
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
  // Loading overlay is visible by default via HTML/CSS

  // --- Pre-initialization: Check Auth Token ---
  const token = localStorage.getItem("authToken");
  if (!token) {
    console.log("No auth token found, directing to login.");
    // Show message on overlay before redirect
    showLoadingOverlay("Auth token missing. Redirecting...");
    setTimeout(() => {
      window.location.href = "/login.html";
    }, 1500); // Delay redirect slightly
    return; // Stop initialization
  }

  // --- Step 1: Show Basic Loading State (Already visible) ---
  // Message is already "Initializing ZanyTown..." from HTML
  // Can update if needed: showLoadingOverlay("Initializing...");

  // --- Step 2: Load Configuration (Await it!) ---
  const configLoaded = await loadConfig();
  if (!configLoaded) {
    showLoadingOverlay("Error: Failed to load configuration. Please refresh.");
    return; // Stop initialization if config fails
  }
  console.log(
    "Configuration loaded successfully. CLIENT_CONFIG is now available."
  );
  showLoadingOverlay("Loading UI..."); // Update message

  // --- Step 3: Initialize UI Manager (Find DOM Elements) ---
  const uiInitialized = initUIManager(); // Capture return value
  if (!uiInitialized) {
    showLoadingOverlay("Error: Failed to initialize UI. Please refresh.");
    // Optionally display a more prominent error message in the body
    // document.body.innerHTML = '<h1 style="color:red; text-align:center; margin-top: 50px;">Critical Error: UI Init Failed.</h1>';
    return;
  }
  console.log("UI Manager Initialized successfully.");
  showLoadingOverlay("Preparing Graphics..."); // Update message

  // --- Step 4: Initialize Game State (Uses Config) ---
  initializeGameState(CLIENT_CONFIG);

  // --- Step 5: Initialize Renderer ---
  if (!initRenderer(uiState.canvas, uiState.ctx)) {
    showLoadingOverlay("Error: Failed to initialize graphics. Please refresh.");
    return;
  }
  showLoadingOverlay("Loading Assets..."); // Update message

  // --- Step 6: Disable Interaction Buttons Initially ---
  uiState.openShopBtn?.setAttribute("disabled", "true");
  uiState.toggleEditBtn?.setAttribute("disabled", "true");
  uiState.pickupFurniBtn?.setAttribute("disabled", "true");
  uiState.recolorFurniBtn?.setAttribute("disabled", "true"); // Use correct name

  // --- Step 7: Initial Canvas Resize & Setup Listener ---
  const debouncedResize = debounce(() => {
    if (uiState.gameContainer) {
      resizeRenderer(
        uiState.gameContainer.clientWidth,
        uiState.gameContainer.clientHeight
      );
    }
  }, 100); // Debounce resize events

  // Perform initial resize after a frame to ensure layout is stable
  requestAnimationFrame(() => {
    if (uiState.gameContainer) {
      resizeRenderer(
        uiState.gameContainer.clientWidth,
        uiState.gameContainer.clientHeight
      );
    }
    // Attach resize listener
    window.addEventListener("resize", debouncedResize);
  });

  // --- Step 8: Load Sounds ---
  loadSounds();

  // --- Step 9: Setup Input Listeners ---
  setupInputListeners();

  // --- Step 10: Reset State (Minimal initial setup) ---
  // Don't call full resetLocalState here, as it shows "Loading Room..."
  // Set initial placeholder text in UI elements
  if (uiState.inventoryItemsDiv)
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Connecting...</i></p>";
  if (uiState.currencyDisplay)
    uiState.currencyDisplay.textContent = "Silly Coins: ...";
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Connecting...";
  if (uiState.userListContent)
    uiState.userListContent.innerHTML = "<li><i>Connecting...</i></li>";
  logChatMessage("Welcome to ZanyTown!", true, "info-msg"); // Initial chat message

  // --- Step 11: Connect to Server ---
  showLoadingOverlay("Connecting to Server..."); // Update message before connect attempt
  if (!connectToServer()) {
    // connectToServer now shows its own overlay message on failure
    // showLoadingOverlay("Error: Failed to start connection. Please refresh."); // This might override connectToServer's message
    return; // Stop if connection initiation fails
  }
  console.log("Attempting connection to server...");

  // --- Step 12: Start Game Loop ---
  startGameLoop();

  // The loading overlay will now be hidden by the 'room_state' event handler in network.js
  // after the first successful room load.
  console.log(
    "Client Initialization sequence complete (pending connection & room state)."
  );
}

/**
 * Resets the local client state, typically called on room change or disconnect.
 * Shows loading overlay and clears room-specific data.
 */
export function resetLocalState() {
  console.log("Resetting local client room state...");
  showLoadingOverlay("Loading Room..."); // Ensure overlay shows during reset

  // --- Clear Room-Specific Game Objects/State ---
  // Clear bubbles from avatars before clearing avatars array
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
  // Clear DOM elements managed by UI manager
  if (uiState.chatLogDiv) uiState.chatLogDiv.innerHTML = "";
  uiState.chatMessages = []; // Clear message references
  if (uiState.inventoryItemsDiv)
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Entering room...</i></p>";
  if (uiState.userListContent)
    uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
  if (uiState.debugDiv) uiState.debugDiv.textContent = "Resetting state...";
  if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
  uiState.activeChatBubbles = []; // Clear bubble references
  if (uiState.shopItemsDiv)
    uiState.shopItemsDiv.innerHTML = "<p><i>Stocking shelves...</i></p>";

  // Hide floating panels
  hideProfilePanel();
  hideRecolorPanel();
  hideShopPanel();

  // Reset Edit Mode State
  uiState.isEditMode = false;
  // Ensure CLIENT_CONFIG is available before accessing its properties
  if (CLIENT_CONFIG) {
    uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  } else {
    uiState.editMode.state = "navigate"; // Fallback if config not ready (shouldn't happen here normally)
  }
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;

  // --- Update UI Buttons/Cursor/Displays ---
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();

  if (uiState.toggleEditBtn) {
    uiState.toggleEditBtn.textContent = `Make Stuff? (Off)`;
    uiState.toggleEditBtn.classList.remove("active");
  }

  // Update Displays to Loading/Default State
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Loading...";
  // Currency display usually updated separately, but reset placeholder
  if (uiState.currencyDisplay)
    uiState.currencyDisplay.textContent = "Silly Coins: ...";
  document.title = "ZanyTown - Loading...";

  // The loading overlay remains visible until the next room_state is processed
}

// --- Cleanup ---
function cleanup() {
  console.log("Cleaning up client before unload...");
  stopGameLoop();
  disconnectSocket();
  cleanupInputListeners();
  // Optional: Remove resize listener if attached to window
  // window.removeEventListener('resize', debouncedResize); // Need to ensure debouncedResize is accessible here
}

// Add listener for page unload events
window.addEventListener("beforeunload", cleanup);

// --- Start Initialization on DOM Load ---
document.addEventListener("DOMContentLoaded", initClient);
