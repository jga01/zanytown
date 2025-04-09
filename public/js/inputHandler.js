import { gameState, uiState, camera } from "./gameState.js";
import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import { snapToGrid, isoToWorld, rotateDirection } from "./utils.js";
import {
  isConnected,
  requestMove,
  requestPlaceFurni,
  requestRotateFurni,
  requestPickupFurni,
  requestSit,
  requestStand,
  requestProfile,
  requestUseFurni,
  sendChat,
  requestChangeRoom,
  requestRecolorFurni,
  disconnectSocket,
  // Admin requests are usually triggered via UI, not direct keybinds here
} from "./network.js";
import {
  toggleEditMode, // Manages edit state and bottom bar button
  moveCamera,
  changeZoom,
  setSelectedInventoryItem, // Used for selection logic
  setSelectedFurniture, // Used for selection logic
  hideProfilePanel,
  hideRecolorPanel,
  // Shop panel toggled via togglePanel
  getAvatarAtScreen,
  getTopmostFurnitureAtScreen,
  isClientWalkable,
  isValidClientTile,
  logChatMessage,
  togglePanel, // NEW: For bottom bar buttons
  showContextMenu, // NEW: For right-click
  hideContextMenu, // NEW: To hide menu on other actions
  handleEditModeClick, // NEW: Moved logic to uiManager
  handleNavigateModeClick, // NEW: Moved logic to uiManager
} from "./uiManager.js";
import { playSound } from "./sounds.js";

// Define and Export the shared input state object
export const inputState = {
  keysPressed: {}, // Tracks currently held keys { keyName: boolean }
  isDragging: false, // Flag for camera dragging (middle/right mouse)
  lastMousePos: { x: 0, y: 0 }, // Stores screen coords for drag delta and click vs drag detection
  currentMouseScreenPos: { x: 0, y: 0 }, // Current mouse position relative to canvas
  currentMouseWorldPos: { x: 0, y: 0 }, // Current mouse position converted to world coordinates
  currentMouseGridPos: { x: 0, y: 0 }, // Current mouse position snapped to the grid
};

// Store listener references for cleanup
const listeners = {
  keydown: null,
  keyup: null,
  canvasClick: null,
  canvasMouseDown: null,
  canvasMouseUp: null,
  canvasMouseLeave: null,
  canvasMouseMove: null,
  canvasWheel: null,
  canvasContextMenu: null, // For right-click
  chatKeydown: null,
};

/** Attaches all necessary input event listeners. */
export function setupInputListeners() {
  if (!uiState.canvas || !CLIENT_CONFIG) {
    console.error(
      "Cannot setup input listeners: Canvas or CLIENT_CONFIG not ready."
    );
    return;
  }
  console.log("Setting up input listeners...");

  // --- Keyboard Listeners (on window) ---
  listeners.keydown = handleKeyDown;
  listeners.keyup = handleKeyUp;
  window.addEventListener("keydown", listeners.keydown);
  window.addEventListener("keyup", listeners.keyup);

  // --- Mouse Listeners on Canvas/Window ---
  listeners.canvasClick = handleCanvasClick; // Left click actions
  listeners.canvasMouseDown = handleMouseDown; // Start drag / click detection
  listeners.canvasMouseUp = handleMouseUp; // Stop drag (on window)
  listeners.canvasMouseLeave = handleMouseLeave; // Stop drag if leaving canvas
  listeners.canvasMouseMove = handleMouseMove; // Update positions, handle drag (on window)
  listeners.canvasWheel = handleMouseWheel; // Zoom (on canvas)
  listeners.canvasContextMenu = handleContextMenu; // Right-click menu (on canvas)

  uiState.canvas.addEventListener("click", listeners.canvasClick);
  uiState.canvas.addEventListener("mousedown", listeners.canvasMouseDown);
  window.addEventListener("mouseup", listeners.canvasMouseUp); // Use window for reliable release
  window.addEventListener("mousemove", listeners.canvasMouseMove); // Use window for reliable drag
  uiState.canvas.addEventListener("mouseleave", listeners.canvasMouseLeave);
  uiState.canvas.addEventListener("wheel", listeners.canvasWheel, {
    passive: false,
  }); // Need active for preventDefault
  uiState.canvas.addEventListener("contextmenu", listeners.canvasContextMenu); // Listen for right-click

  // --- Chat Input Listener ---
  if (uiState.chatInput) {
    listeners.chatKeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault(); // Stop default form submission/newline
        const text = uiState.chatInput.value;
        if (text) {
          sendChat(text); // Send via network module
          uiState.chatInput.value = ""; // Clear the input
        }
      }
    };
    uiState.chatInput.addEventListener("keydown", listeners.chatKeydown);
  } else {
    console.warn("Chat input element not found during listener setup.");
  }

  // --- Bottom Bar Button Listeners ---
  // Use optional chaining (?.) in case elements aren't found
  uiState.toggleInventoryBtn?.addEventListener("click", () =>
    togglePanel("inventory")
  );
  uiState.toggleRoomsBtn?.addEventListener("click", () => togglePanel("rooms")); // Assumes rooms panel exists
  uiState.toggleUsersBtn?.addEventListener("click", () =>
    togglePanel("userList")
  );
  uiState.toggleShopBtn?.addEventListener("click", () => togglePanel("shop")); // Use togglePanel for shop too
  uiState.toggleEditBottomBtn?.addEventListener("click", toggleEditMode); // Target new button
  uiState.toggleAdminBtn?.addEventListener("click", () => togglePanel("admin"));
  uiState.toggleDebugBtn?.addEventListener("click", () => togglePanel("debug"));
  // Optional Zoom Buttons
  // uiState.zoomInBottomBtn?.addEventListener('click', () => changeZoom(CLIENT_CONFIG.ZOOM_FACTOR));
  // uiState.zoomOutBottomBtn?.addEventListener('click', () => changeZoom(1 / CLIENT_CONFIG.ZOOM_FACTOR));

  // --- Existing Floating Panel Close Buttons ---
  uiState.profileCloseBtn?.addEventListener("click", hideProfilePanel);
  uiState.recolorCloseBtn?.addEventListener("click", hideRecolorPanel);
  uiState.recolorResetBtn?.addEventListener("click", handleRecolorResetClick);
  uiState.shopCloseBtn?.addEventListener("click", () =>
    togglePanel("shop", false)
  ); // Use togglePanel to close

  // --- Logout Button ---
  uiState.logoutBtn?.addEventListener("click", handleLogoutClick);

  console.log("Input listeners attached.");
}

/** Removes all attached input event listeners. */
export function cleanupInputListeners() {
  console.log("Cleaning up input listeners...");
  // Remove window listeners
  window.removeEventListener("keydown", listeners.keydown);
  window.removeEventListener("keyup", listeners.keyup);
  window.removeEventListener("mouseup", listeners.canvasMouseUp);
  window.removeEventListener("mousemove", listeners.canvasMouseMove);

  // Remove canvas listeners
  if (uiState.canvas) {
    uiState.canvas.removeEventListener("click", listeners.canvasClick);
    uiState.canvas.removeEventListener("mousedown", listeners.canvasMouseDown);
    uiState.canvas.removeEventListener(
      "mouseleave",
      listeners.canvasMouseLeave
    );
    uiState.canvas.removeEventListener("wheel", listeners.canvasWheel);
    uiState.canvas.removeEventListener(
      "contextmenu",
      listeners.canvasContextMenu
    );
  }

  // Remove chat input listener
  if (uiState.chatInput && listeners.chatKeydown) {
    uiState.chatInput.removeEventListener("keydown", listeners.chatKeydown);
  }

  // --- Remove Bottom Bar Button Listeners (and others) ---
  // It's often sufficient to rely on page unload, but explicit removal is cleaner if components lifecycle matters.
  // Example for one button:
  // uiState.toggleInventoryBtn?.removeEventListener('click', () => togglePanel('inventory')); // This requires storing the exact function reference, not just calling togglePanel
  // For simplicity in this context, we'll skip explicit removal of button listeners,
  // assuming they are cleaned up when the page/app closes.

  console.log("Input listeners removed.");
}

// --- Keyboard Event Handlers ---

function handleKeyDown(event) {
  if (!CLIENT_CONFIG) return; // Ensure config is loaded

  const isChatFocused = document.activeElement === uiState.chatInput;

  // Prevent default browser actions for game keys ONLY when chat is not focused
  const gameKeys = [
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "e",
    "r",
    "i", // Added 'i'
    // Removed Delete/Backspace as they are context menu actions now
  ];
  if (!isChatFocused && gameKeys.includes(event.key.toLowerCase())) {
    event.preventDefault();
  }

  // Store key state
  inputState.keysPressed[event.key] = true;
  const keyLower = event.key.toLowerCase();

  // Handle hotkeys (only when chat is not focused)
  if (!isChatFocused) {
    // Toggle Edit Mode (E key)
    if (keyLower === "e") {
      toggleEditMode(); // uiManager handles button update
    }

    // Toggle Inventory Panel (I key)
    if (keyLower === "i") {
      togglePanel("inventory");
    }

    // Rotate placement ghost or selected furniture (R key) - Keep if desired
    if (uiState.isEditMode && keyLower === "r") {
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
        // Rotate placement ghost client-side
        uiState.editMode.placementRotation = rotateDirection(
          uiState.editMode.placementRotation,
          2
        ); // 90 deg clockwise
        // No network needed, renderer uses uiState.editMode.placementRotation
      } else if (
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId
      ) {
        // Request server to rotate the selected furniture
        requestRotateFurni(uiState.editMode.selectedFurnitureId);
      }
    }
    // Add other hotkeys here (e.g., open map, quests) if needed
  }
  // Chat input submission ('Enter') is handled in its specific listener setup
}

function handleKeyUp(event) {
  // Update key state
  inputState.keysPressed[event.key] = false;
}

/** Processes held arrow keys for continuous camera panning. Called by game loop. */
export function handleHeldKeys() {
  if (!CLIENT_CONFIG || !inputState) return; // Check prerequisites
  let dx = 0;
  let dy = 0;
  const panSpeed = CLIENT_CONFIG.CAMERA_PAN_SPEED;

  // Check held keys state
  if (inputState.keysPressed["ArrowLeft"]) dx += panSpeed;
  if (inputState.keysPressed["ArrowRight"]) dx -= panSpeed;
  if (inputState.keysPressed["ArrowUp"]) dy += panSpeed;
  if (inputState.keysPressed["ArrowDown"]) dy -= panSpeed;

  // Apply panning if movement detected
  if (dx !== 0 || dy !== 0) {
    moveCamera(dx, dy); // Delegate to uiManager
  }
}

// --- Mouse Event Handlers ---

/** Handles LEFT clicks on the canvas. */
function handleCanvasClick(event) {
  if (event.button !== 0) return; // Only handle left clicks

  if (
    !CLIENT_CONFIG ||
    event.target !== uiState.canvas ||
    !gameState.currentRoomId
  ) {
    // console.warn("Canvas click ignored: Prereqs not met.");
    return;
  }

  // Hide context menu on any left click
  hideContextMenu();

  // --- Click vs Drag Detection ---
  // Check if this click was likely the end of a drag motion
  const dragThreshold = 5; // Pixels threshold to differentiate click from drag
  const dx = Math.abs(event.clientX - inputState.lastMousePos.x);
  const dy = Math.abs(event.clientY - inputState.lastMousePos.y);
  // The isDragging flag is managed by mousedown/mousemove/mouseup
  if (inputState.isDragging && (dx > dragThreshold || dy > dragThreshold)) {
    // console.log("Ignoring click, likely end of drag.");
    // isDragging flag is reset in mouseup
    return;
  }
  // If it wasn't a drag, proceed with click logic

  // Use the calculated grid/screen positions from the shared inputState
  const gridPos = inputState.currentMouseGridPos;
  const screenPos = inputState.currentMouseScreenPos;

  // Ignore clicks outside the valid tile area of the current room
  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    // Use uiManager helper
    // console.log("Click ignored: Outside valid tile area");
    return;
  }

  // Delegate click handling based on current mode (Edit vs Navigate)
  // Logic is now moved into uiManager for better cohesion
  if (uiState.isEditMode) {
    handleEditModeClick(gridPos, screenPos);
  } else {
    handleNavigateModeClick(gridPos, screenPos);
  }
}

/** Handles RIGHT clicks on the canvas to show the context menu. */
function handleContextMenu(event) {
  if (!uiState.canvas || !CLIENT_CONFIG || !gameState.currentRoomId) return;
  event.preventDefault(); // ALWAYS prevent default browser right-click menu

  // Use current mouse positions calculated by mousemove
  const screenPos = inputState.currentMouseScreenPos;
  const gridPos = inputState.currentMouseGridPos; // For tile context

  // Determine what was clicked under the cursor
  const clickedAvatar = getAvatarAtScreen(screenPos.x, screenPos.y);
  // Only check furniture if no avatar was clicked directly
  const clickedFurniture = !clickedAvatar
    ? getTopmostFurnitureAtScreen(screenPos.x, screenPos.y)
    : null;

  let target = null;
  if (clickedAvatar) {
    // Clicked on an avatar
    target = { type: "avatar", id: clickedAvatar.id };
  } else if (clickedFurniture) {
    // Clicked on a piece of furniture
    target = { type: "furniture", id: clickedFurniture.id };
  } else if (isValidClientTile(gridPos.x, gridPos.y)) {
    // Clicked on an empty (or non-interactive furniture) tile
    target = { type: "tile", x: gridPos.x, y: gridPos.y };
  } else {
    // Clicked outside valid area, hide any existing menu
    hideContextMenu();
    return;
  }

  // Show the context menu, passing screen coords relative to canvas
  showContextMenu(screenPos.x, screenPos.y, target);
}

function handleMouseDown(event) {
  // Middle mouse (button 1) or Right mouse (button 2) for camera dragging
  if (event.button === 1 || event.button === 2) {
    inputState.isDragging = true;
    inputState.lastMousePos = { x: event.clientX, y: event.clientY }; // Record screen start position
    uiState.gameContainer?.classList.add("dragging"); // Apply dragging cursor style
    event.preventDefault(); // Prevent default middle/right click actions (like auto-scroll)
  } else if (event.button === 0) {
    // Left mouse down
    // Record position for click vs drag detection later
    inputState.lastMousePos = { x: event.clientX, y: event.clientY };
    // Assume it's a click initially; mousemove will set isDragging if threshold exceeded
    // We only set isDragging definitively on button 1 or 2 mousedown.
    // inputState.isDragging = false; // Don't reset isDragging here if another button is held
  }
}

function handleMouseUp(event) {
  // Stop dragging on ANY mouse button release ANYWHERE on the window
  // We check which button was released, but generally stop drag if ANY button comes up
  // while isDragging was true. This handles cases where multiple buttons might be involved.
  if (inputState.isDragging) {
    // Check if the button *initiating* the drag (middle/right) was released
    // Though simply stopping on any mouse up is usually fine.
    // if (event.button === 1 || event.button === 2) {
    inputState.isDragging = false;
    uiState.gameContainer?.classList.remove("dragging"); // Remove dragging cursor style
    // }
  }
}

function handleMouseLeave(event) {
  // If the mouse leaves the canvas element *specifically* while dragging, stop the drag.
  // This prevents the drag state remaining true if the mouseup happens outside the window/canvas area.
  if (inputState.isDragging && event.target === uiState.canvas) {
    // console.log("Mouse left canvas during drag, stopping drag."); // Debugging
    inputState.isDragging = false;
    uiState.gameContainer?.classList.remove("dragging");
  }
}

function handleMouseMove(event) {
  // Ensure canvas exists for calculating relative position
  if (!uiState.canvas) return;

  // Calculate mouse position relative to the canvas top-left corner
  const rect = uiState.canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Update the shared inputState with current screen coordinates
  inputState.currentMouseScreenPos = { x: screenX, y: screenY };

  // Update world/grid position based on new screen coords and camera state
  updateMouseWorldPosition(); // Update internal state used by highlights etc.

  // Handle camera panning if dragging flag is set (by middle/right mouse)
  if (inputState.isDragging) {
    // Calculate delta from the last recorded screen position
    const dx = event.clientX - inputState.lastMousePos.x;
    const dy = event.clientY - inputState.lastMousePos.y;

    // Apply camera movement
    moveCamera(dx, dy); // Delegate camera movement to uiManager

    // Update the last position for the next delta calculation
    inputState.lastMousePos = { x: event.clientX, y: event.clientY };
  }
}

/** Updates cached world and grid coordinates based on current screen mouse position and camera state. */
export function updateMouseWorldPosition() {
  // Ensure necessary state objects are available
  if (!inputState || !camera || !SHARED_CONFIG) return;

  try {
    // Convert current screen coordinates to world coordinates, considering camera pan and zoom
    const worldCoords = isoToWorld(
      inputState.currentMouseScreenPos.x,
      inputState.currentMouseScreenPos.y
    );
    inputState.currentMouseWorldPos = worldCoords;

    // Snap the calculated world coordinates to the nearest grid intersection
    inputState.currentMouseGridPos = snapToGrid(worldCoords.x, worldCoords.y);
  } catch (error) {
    console.error("Error in updateMouseWorldPosition:", error);
    // Reset positions to avoid using invalid data
    inputState.currentMouseWorldPos = { x: 0, y: 0 };
    inputState.currentMouseGridPos = { x: 0, y: 0 };
  }
}

function handleMouseWheel(event) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) return;
  event.preventDefault(); // Prevent default page scrolling behavior

  // Determine zoom direction and factor
  const zoomFactor =
    event.deltaY < 0
      ? CLIENT_CONFIG.ZOOM_FACTOR // Zoom in (scroll up/forward)
      : 1 / CLIENT_CONFIG.ZOOM_FACTOR; // Zoom out (scroll down/backward)

  // Calculate pivot point for zooming (mouse cursor position relative to canvas)
  const rect = uiState.canvas.getBoundingClientRect();
  const pivotX = event.clientX - rect.left;
  const pivotY = event.clientY - rect.top;

  // Delegate zoom logic to uiManager, passing the zoom factor and pivot point
  changeZoom(zoomFactor, pivotX, pivotY);
}

// --- Button Click Handlers (Specific Actions) ---

/** Handles click on the reset button in the recolor panel. */
function handleRecolorResetClick() {
  if (uiState.activeRecolorFurniId && isConnected()) {
    console.log(`Requesting reset color for ${uiState.activeRecolorFurniId}`);
    // Send empty string or null to indicate reset to default color
    requestRecolorFurni(uiState.activeRecolorFurniId, "");
    hideRecolorPanel(); // Close panel after action
  } else {
    console.warn("handleRecolorResetClick: No active item or not connected.");
  }
}

/** Handles click on the logout button. */
function handleLogoutClick() {
  console.log("Logout button clicked. Clearing token and disconnecting.");
  localStorage.removeItem("authToken"); // Clear the JWT from local storage
  disconnectSocket(); // Disconnect the socket connection cleanly
  // Redirect to the login page
  // Use a slight delay if needed to ensure disconnect message is sent/processed
  // setTimeout(() => { window.location.href = "/login.html"; }, 100);
  window.location.href = "/login.html"; // Immediate redirect usually fine
}
