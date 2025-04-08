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
  requestRecolorFurni, // Added recolor request
  disconnectSocket,
} from "./network.js";
import {
  toggleEditMode,
  moveCamera,
  changeZoom,
  setSelectedInventoryItem,
  setSelectedFurniture,
  handlePickupFurniClick,
  handleRecolorFurniClick,
  hideProfilePanel,
  hideRecolorPanel,
  showShopPanel,
  hideShopPanel,
  getAvatarAtScreen,
  getTopmostFurnitureAtScreen,
  isClientWalkable,
  isValidClientTile,
  logChatMessage, // Added for feedback
} from "./uiManager.js";
import { playSound } from "./sounds.js"; // Added for UI feedback sounds

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
  canvasContextMenu: null,
  chatKeydown: null,
  // Button listener refs aren't stored here as they are attached directly in setup
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

  // --- Mouse Listeners on Canvas ---
  listeners.canvasClick = handleCanvasClick;
  listeners.canvasMouseDown = handleMouseDown;
  listeners.canvasMouseUp = handleMouseUp; // Attached to window for better drag release
  listeners.canvasMouseLeave = handleMouseLeave; // Keep on canvas to detect leaving boundary
  listeners.canvasMouseMove = handleMouseMove; // Attached to window for better drag tracking
  listeners.canvasWheel = handleMouseWheel;
  listeners.canvasContextMenu = (e) => e.preventDefault(); // Prevent right-click menu

  uiState.canvas.addEventListener("click", listeners.canvasClick);
  uiState.canvas.addEventListener("mousedown", listeners.canvasMouseDown);
  window.addEventListener("mouseup", listeners.canvasMouseUp); // Use window for reliable mouseup
  window.addEventListener("mousemove", listeners.canvasMouseMove); // Use window for reliable mousemove during drag
  uiState.canvas.addEventListener("mouseleave", listeners.canvasMouseLeave);
  uiState.canvas.addEventListener("wheel", listeners.canvasWheel, {
    passive: false,
  }); // Need active for preventDefault
  uiState.canvas.addEventListener("contextmenu", listeners.canvasContextMenu);

  // --- Chat Input Listener ---
  if (uiState.chatInput) {
    listeners.chatKeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault(); // Stop default form submission/newline
        const text = uiState.chatInput.value;
        if (text) {
          // Only send if there's text
          sendChat(text); // Send via network module
          uiState.chatInput.value = ""; // Clear the input
        }
      }
    };
    uiState.chatInput.addEventListener("keydown", listeners.chatKeydown);
  } else {
    console.warn("Chat input element not found during listener setup.");
  }

  // --- Button Click Listeners ---
  // Attach listeners directly using uiState references
  // Note: Error checking (?. ) added in case elements aren't found
  uiState.zoomInBtn?.addEventListener("click", () =>
    changeZoom(CLIENT_CONFIG.ZOOM_FACTOR)
  );
  uiState.zoomOutBtn?.addEventListener("click", () =>
    changeZoom(1 / CLIENT_CONFIG.ZOOM_FACTOR)
  );
  uiState.toggleEditBtn?.addEventListener("click", toggleEditMode);
  uiState.pickupFurniBtn?.addEventListener("click", handlePickupFurniClick); // Uses uiManager handler
  uiState.recolorFurniBtn?.addEventListener("click", handleRecolorFurniClick); // Uses uiManager handler
  uiState.profileCloseBtn?.addEventListener("click", hideProfilePanel);
  uiState.recolorCloseBtn?.addEventListener("click", hideRecolorPanel);
  uiState.recolorResetBtn?.addEventListener("click", handleRecolorResetClick);
  uiState.openShopBtn?.addEventListener("click", showShopPanel);
  uiState.shopCloseBtn?.addEventListener("click", hideShopPanel);
  uiState.logoutBtn?.addEventListener("click", handleLogoutClick);

  // Add listeners for inventory items dynamically when populated in uiManager
  // Or use event delegation on the inventory container

  console.log("Input listeners attached.");
}

/** Removes all attached input event listeners. */
export function cleanupInputListeners() {
  console.log("Cleaning up input listeners...");
  window.removeEventListener("keydown", listeners.keydown);
  window.removeEventListener("keyup", listeners.keyup);
  window.removeEventListener("mouseup", listeners.canvasMouseUp); // Remove from window
  window.removeEventListener("mousemove", listeners.canvasMouseMove); // Remove from window

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
  if (uiState.chatInput && listeners.chatKeydown) {
    // Check if listener was assigned
    uiState.chatInput.removeEventListener("keydown", listeners.chatKeydown);
  }

  // Button listeners are typically removed when the elements are destroyed or page unloads.
  // If components are dynamically added/removed, explicit removal might be needed.
  console.log("Input listeners removed.");
}

// --- Keyboard Event Handlers ---

function handleKeyDown(event) {
  if (!CLIENT_CONFIG) return; // Ensure config is loaded

  // Prevent default browser actions for game keys ONLY when chat is not focused
  const gameKeys = [
    "arrowup",
    "arrowdown",
    "arrowleft",
    "arrowright",
    "e",
    "r",
    "delete",
    "backspace",
  ];
  const isChatFocused = document.activeElement === uiState.chatInput;
  if (!isChatFocused && gameKeys.includes(event.key.toLowerCase())) {
    event.preventDefault();
  }

  // Store key state in the module-level inputState object
  inputState.keysPressed[event.key] = true;
  const keyLower = event.key.toLowerCase();

  // Handle hotkeys (only when chat is not focused)
  if (!isChatFocused) {
    // Toggle Edit Mode (E key)
    if (keyLower === "e") {
      toggleEditMode(); // Delegate to uiManager
    }

    // Edit Mode specific hotkeys
    if (uiState.isEditMode) {
      // Pickup selected furniture (Delete/Backspace keys)
      if (
        (keyLower === "delete" || keyLower === "backspace") &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        uiState.editMode.selectedFurnitureId // Ensure something is selected
      ) {
        handlePickupFurniClick(); // Delegate to uiManager (which calls network)
      }
      // Rotate placement ghost or selected furniture (R key)
      if (keyLower === "r") {
        if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
          // Rotate placement ghost client-side by updating uiState
          uiState.editMode.placementRotation = rotateDirection(
            uiState.editMode.placementRotation,
            2 // 90 degrees clockwise
          );
          // No network request needed here, ghost redraws based on uiState
        } else if (
          uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
          uiState.editMode.selectedFurnitureId
        ) {
          // Request server to rotate the selected furniture
          requestRotateFurni(uiState.editMode.selectedFurnitureId);
        }
      }
    }
    // Add other hotkeys here (e.g., open inventory, open map)
  }
  // Note: Chat input submission is handled in its specific 'keydown' listener
}

function handleKeyUp(event) {
  // Update key state in the module-level inputState object
  inputState.keysPressed[event.key] = false;
}

/** Processes held arrow keys for continuous camera panning. Called by game loop. */
export function handleHeldKeys() {
  if (!CLIENT_CONFIG || !inputState) return; // Ensure config and state are available
  let dx = 0;
  let dy = 0;
  const panSpeed = CLIENT_CONFIG.CAMERA_PAN_SPEED;

  // Check held keys from the exported inputState object
  if (inputState.keysPressed["ArrowLeft"]) dx += panSpeed;
  if (inputState.keysPressed["ArrowRight"]) dx -= panSpeed;
  if (inputState.keysPressed["ArrowUp"]) dy += panSpeed;
  if (inputState.keysPressed["ArrowDown"]) dy -= panSpeed;

  if (dx !== 0 || dy !== 0) {
    moveCamera(dx, dy); // Delegate camera movement to uiManager
  }
}

// --- Mouse Event Handlers ---

function handleCanvasClick(event) {
  // Basic validation
  if (
    !CLIENT_CONFIG ||
    event.target !== uiState.canvas ||
    !gameState.currentRoomId
  )
    return;

  // Prevent click action if it was likely the end of a drag motion
  const dragThreshold = 5; // Pixels threshold
  const dx = Math.abs(event.clientX - inputState.lastMousePos.x);
  const dy = Math.abs(event.clientY - inputState.lastMousePos.y);
  // Check isDragging flag which is managed by mousedown/mousemove/mouseup
  if (inputState.isDragging && (dx > dragThreshold || dy > dragThreshold)) {
    // console.log("Ignoring click, likely end of drag.");
    // Flag is reset in mouseup, no need to reset here normally
    return;
  }

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
  if (uiState.isEditMode) {
    handleEditModeClick(gridPos, screenPos);
  } else {
    handleNavigateModeClick(gridPos, screenPos);
  }
}

/** Handles clicks when in Edit Mode (Place/Select/Use furniture). */
function handleEditModeClick(gridPos, screenPos) {
  if (!CLIENT_CONFIG || !SHARED_CONFIG || !gameState.currentRoomId) return;

  switch (uiState.editMode.state) {
    case CLIENT_CONFIG.EDIT_STATE_PLACING: // Attempting to place item from inventory
      if (
        uiState.editMode.placementValid &&
        uiState.editMode.selectedInventoryItemId
      ) {
        // Client-side check if item still exists (server validates again)
        if (gameState.inventory[uiState.editMode.selectedInventoryItemId] > 0) {
          requestPlaceFurni(
            uiState.editMode.selectedInventoryItemId,
            gridPos.x,
            gridPos.y,
            uiState.editMode.placementRotation
          );
          playSound("place"); // Immediate feedback
          // Keep item selected after placement attempt? Or deselect? User preference.
          // setSelectedInventoryItem(null); // Option: Deselect after placing
        } else {
          logChatMessage(
            "You don't seem to have that item anymore.",
            true,
            "error-msg"
          );
          setSelectedInventoryItem(null); // Deselect if item gone
        }
      } else {
        logChatMessage("Cannot place item there.", true, "error-msg");
        // playSound('error'); // Optional failure sound
      }
      break;

    case CLIENT_CONFIG.EDIT_STATE_NAVIGATE: // No item selected from inventory
    case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI: // Furniture already selected on floor
      // Find furniture at the click location
      const clickedFurniture = getTopmostFurnitureAtScreen(
        screenPos.x,
        screenPos.y
      ); // Use uiManager helper

      if (clickedFurniture) {
        // If the clicked item is usable (like a lamp), use it immediately
        if (clickedFurniture.definition?.canUse) {
          requestUseFurni(clickedFurniture.id);
          playSound("use");
          setSelectedFurniture(null); // Deselect after using
        } else {
          // Otherwise, toggle selection of the clicked furniture
          if (uiState.editMode.selectedFurnitureId === clickedFurniture.id) {
            setSelectedFurniture(null); // Click again to deselect
          } else {
            setSelectedFurniture(clickedFurniture.id); // Select the clicked furniture
            playSound("select"); // Optional selection sound? Need to add 'select.wav'
          }
        }
      } else {
        // Clicked on empty space
        setSelectedFurniture(null); // Deselect any currently selected furniture
        hideRecolorPanel(); // Hide recolor panel if empty space is clicked
      }
      break;
  }
}

/** Handles clicks when NOT in Edit Mode (Navigate/Sit/Use/Profile/Door). */
function handleNavigateModeClick(gridPos, screenPos) {
  if (!isConnected() || !SHARED_CONFIG || !gameState.currentRoomId) return;

  const myAvatar = gameState.avatars[gameState.myAvatarId]; // Get own avatar instance

  // 1. Check for click on another Avatar -> Request Profile
  const clickedAvatar = getAvatarAtScreen(screenPos.x, screenPos.y); // Use uiManager helper
  if (clickedAvatar) {
    if (clickedAvatar.id !== gameState.myAvatarId) {
      requestProfile(clickedAvatar.id); // Request profile via network
    } else {
      // Optional: clicking self could open own profile/stats panel later
      logChatMessage(
        `You clicked yourself (${clickedAvatar.name}).`,
        true,
        "info-msg"
      );
    }
    return; // Stop processing if an avatar was clicked
  }

  // 2. Check for click on own tile while sitting -> Request Stand
  if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
    if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
      requestStand(); // Request to stand up via network
      return;
    }
  }

  // 3. Check for click on Furniture -> Use / Sit / Enter Door
  const clickedFurniture = getTopmostFurnitureAtScreen(
    screenPos.x,
    screenPos.y
  ); // Use uiManager helper
  if (clickedFurniture) {
    // Handle Door Click
    if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
      const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === clickedFurniture.definitionId
      );
      requestChangeRoom(
        clickedFurniture.targetRoomId,
        doorDef?.targetX, // Pass target coords if defined
        doorDef?.targetY
      );
      return;
    }
    // Handle Usable Item Click
    if (clickedFurniture.definition?.canUse) {
      requestUseFurni(clickedFurniture.id);
      playSound("use"); // Provide immediate feedback
      return;
    }
    // Handle Sittable Item Click
    if (clickedFurniture.definition?.canSit) {
      requestSit(clickedFurniture.id);
      // Server will handle pathfinding and actual state change; walking sound triggered by avatar_update
      return;
    }
    // Add other interactions here (e.g., opening containers)
  }

  // 4. Clicked on floor tile -> Request Navigate (if walkable)
  if (isClientWalkable(gridPos.x, gridPos.y)) {
    // Use uiManager helper
    requestMove(gridPos.x, gridPos.y); // Request move via network
  } else {
    // Clicked unwalkable tile (wall, hole, occupied solid)
    logChatMessage("Cannot walk there.", true, "error-msg");
    // playSound('error'); // Optional failure sound
  }
}

function handleMouseDown(event) {
  // Middle mouse (button 1) or Right mouse (button 2) for camera dragging
  if (event.button === 1 || event.button === 2) {
    inputState.isDragging = true;
    inputState.lastMousePos = { x: event.clientX, y: event.clientY }; // Record screen start position
    uiState.gameContainer?.classList.add("dragging"); // Apply dragging cursor style via uiManager potentially
    event.preventDefault(); // Prevent default middle/right click actions
  } else if (event.button === 0) {
    // Left mouse down
    // Record position for click vs drag detection later
    inputState.lastMousePos = { x: event.clientX, y: event.clientY };
    inputState.isDragging = false; // Assume it's a click initially
  }
}

function handleMouseUp(event) {
  // Stop dragging on any mouse button release anywhere on the window
  if (inputState.isDragging) {
    inputState.isDragging = false;
    uiState.gameContainer?.classList.remove("dragging"); // Remove dragging cursor style
  }
}

function handleMouseLeave(event) {
  // If the mouse leaves the canvas element *specifically*, stop dragging
  // This prevents the drag state remaining true if the mouseup happens outside the window
  if (inputState.isDragging && event.target === uiState.canvas) {
    // console.log("Mouse left canvas during drag, stopping drag."); // Debugging
    inputState.isDragging = false;
    uiState.gameContainer?.classList.remove("dragging");
  }
}

function handleMouseMove(event) {
  // Calculate mouse position relative to the canvas
  if (!uiState.canvas) return;
  const rect = uiState.canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  // Update the shared inputState with current screen coordinates
  inputState.currentMouseScreenPos = { x: screenX, y: screenY };

  // Update world/grid position based on new screen coords and camera
  updateMouseWorldPosition(); // Update internal state

  // Handle camera panning if dragging flag is set
  if (inputState.isDragging) {
    // Calculate delta from the last recorded position (screen coordinates)
    const dx = event.clientX - inputState.lastMousePos.x;
    const dy = event.clientY - inputState.lastMousePos.y;

    moveCamera(dx, dy); // Delegate camera movement to uiManager

    // Update the last position for the next delta calculation
    inputState.lastMousePos = { x: event.clientX, y: event.clientY };
  }
  // Note: Drag detection (setting isDragging=true) happens implicitly here
  // if mouse buttons are down and movement exceeds threshold, but the flag is
  // primarily managed by mousedown/mouseup for clarity.
}

/** Updates cached world and grid coordinates based on current screen mouse position and camera state. */
export function updateMouseWorldPosition() {
  // Export needed by gameLoop/uiManager
  if (!uiState.canvas) return; // Canvas needed for context? Not directly.
  if (!inputState || !camera) return; // Need inputState and camera

  // Update the module-level inputState object using imported utils
  inputState.currentMouseWorldPos = isoToWorld(
    inputState.currentMouseScreenPos.x,
    inputState.currentMouseScreenPos.y
  );
  inputState.currentMouseGridPos = snapToGrid(
    inputState.currentMouseWorldPos.x,
    inputState.currentMouseWorldPos.y
  );
}

function handleMouseWheel(event) {
  if (!uiState.canvas || !CLIENT_CONFIG) return;
  event.preventDefault(); // Prevent default page scrolling behavior

  const zoomFactor =
    event.deltaY < 0
      ? CLIENT_CONFIG.ZOOM_FACTOR // Zoom in (scroll up/forward)
      : 1 / CLIENT_CONFIG.ZOOM_FACTOR; // Zoom out (scroll down/backward)

  // Calculate pivot point for zooming (mouse cursor position relative to canvas)
  const rect = uiState.canvas.getBoundingClientRect();
  const pivotX = event.clientX - rect.left;
  const pivotY = event.clientY - rect.top;

  changeZoom(zoomFactor, pivotX, pivotY); // Delegate zoom logic to uiManager
}

// --- Button Click Handlers (Delegated Actions) ---

function handleRecolorResetClick() {
  if (uiState.activeRecolorFurniId) {
    console.log(`Requesting reset color for ${uiState.activeRecolorFurniId}`);
    requestRecolorFurni(uiState.activeRecolorFurniId, ""); // Send empty string for reset
    hideRecolorPanel(); // Close panel after action (via uiManager)
  }
}

function handleLogoutClick() {
  console.log("Logout button clicked.");
  localStorage.removeItem("authToken"); // Clear token
  disconnectSocket(); // Disconnect from server (via network)
  // Redirect immediately
  window.location.href = "/login.html";
}
