// gameState.js provides the centralized state objects
import { gameState, uiState, camera } from "./gameState.js";
// config.js provides constants and configuration fetched from server
import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
// utils.js provides helper functions for coordinates, colors, etc.
import {
  getScreenPos,
  snapToGrid,
  isoToWorld,
  worldToIso,
  shadeColor,
  escapeHtml,
} from "./utils.js";
// network.js provides functions to communicate with the server
import {
  isConnected,
  requestProfile,
  requestUseFurni,
  requestPickupFurni,
  requestRecolorFurni,
  requestBuyItem,
  requestCreateRoom,
  requestModifyLayout,
  requestAllRoomIds,
  sendChat,
  requestSit,
  requestStand,
  requestRotateFurni,
  requestChangeRoom, // Ensure this is imported
  requestMove,
  requestPlaceFurni,
  requestPublicRooms, // Added for room list
} from "./network.js";
// sounds.js provides audio feedback
import { playSound } from "./sounds.js";
// gameObject classes for type checking and method borrowing
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientTile } from "./gameObjects/ClientTile.js";
// inputState from inputHandler.js for mouse position
import { inputState } from "./inputHandler.js";

// --- Module-level state for UI Manager ---
let selectedLayoutPaintType = 0; // Default layout paint type (0 = Floor)

/**
 * Finds and assigns references to essential UI elements defined in CLIENT_CONFIG.
 * Attaches listeners to UI elements specific to this manager.
 * @returns {boolean} True if all critical elements were found, false otherwise.
 */
export function initUIManager() {
  console.log("Initializing UI Manager...");
  if (!CLIENT_CONFIG) {
    console.error("UIManager init failed: CLIENT_CONFIG not loaded.");
    return false;
  }

  let allElementsFound = true;
  // Dynamically find elements based on CLIENT_CONFIG keys ending in '_ID'
  for (const key in CLIENT_CONFIG) {
    if (key.endsWith("_ID")) {
      const elementId = CLIENT_CONFIG[key];
      // Derive state key: remove _ID, convert to camelCase
      let stateKey = key.substring(0, key.length - 3);
      let camelCaseKey = stateKey
        .toLowerCase()
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase());

      // Map specific config keys to desired uiState keys
      const keyMappings = {
        chatLog: "chatLogDiv",
        inventoryItems: "inventoryItemsDiv",
        shopItems: "shopItemsDiv",
        recolorSwatches: "recolorSwatchesDiv",
        recolorItemName: "recolorItemNameP",
        playerCurrency: "currencyDisplay",
        userListContent: "userListContent",
        roomsListContent: "roomsListContent", // Added mapping
        adminRoomList: "adminRoomListDiv",
        adminLayoutTileType: "layoutTileTypeSelector",
        debugDiv: "debugDiv", // Added mapping for debug content
      };
      if (keyMappings[camelCaseKey]) {
        camelCaseKey = keyMappings[camelCaseKey];
      }

      const foundElement = document.getElementById(elementId);

      // Assign to the imported uiState object if the property exists
      if (uiState.hasOwnProperty(camelCaseKey)) {
        uiState[camelCaseKey] = foundElement;
        if (!foundElement) {
          // Log errors for critical elements
          const criticalElements = [
            "canvas",
            "gameContainer",
            "chatLogDiv",
            "inventoryItemsDiv", // Content div is critical
            "currencyDisplay",
            "loadingOverlay",
            "loadingMessage",
            "bottomBar", // New critical element
            "contextMenu", // New critical element
            "roomsListContent", // Room list content is important
          ];
          if (criticalElements.includes(camelCaseKey)) {
            console.error(
              `CRITICAL UI element missing: ${camelCaseKey} (#${elementId})`
            );
            allElementsFound = false;
          } else {
            // Optional elements can have warnings
            // Avoid warning for shopCloseBtn as it might be removed if shop is purely toggle
            if (camelCaseKey !== "shopCloseBtn") {
              console.warn(
                `UI element not found for ID: ${elementId} (expected key: ${camelCaseKey})`
              );
            }
          }
        }
      }
    }
  }

  // Special handling for canvas context
  if (uiState.canvas) {
    uiState.ctx = uiState.canvas.getContext("2d");
    if (!uiState.ctx) {
      console.error("Failed to get 2D context from canvas");
      allElementsFound = false;
    }
  } else {
    // Error already logged if canvas missing
    allElementsFound = false; // Canvas is critical
  }

  // --- Attach Listeners specific to UIManager ---
  // Close buttons for toggled panels
  document.querySelectorAll(".close-panel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelId = btn.dataset.panelId;
      if (panelId) {
        let suffix = panelId.replace("-panel", ""); // e.g., "user-list"
        // Convert suffix to camelCase (e.g., "user-list" -> "userList")
        let camelCaseSuffix = suffix.replace(/-([a-z])/g, (g) =>
          g[1].toUpperCase()
        );
        togglePanel(camelCaseSuffix, false); // Call with camelCase suffix: togglePanel('userList', false)
      }
    });
  });

  // Context menu interaction (delegation)
  if (uiState.contextMenu) {
    uiState.contextMenu.addEventListener("click", handleContextMenuClick);
    // Add listener to hide menu when clicking elsewhere (uses capture phase)
    document.addEventListener(
      "click",
      (event) => {
        if (
          uiState.contextMenu &&
          uiState.contextMenu.style.display !== "none"
        ) {
          // If click is outside the context menu, hide it
          if (!uiState.contextMenu.contains(event.target)) {
            hideContextMenu();
          }
        }
      },
      true // Use capture phase to catch clicks before they bubble up
    );
  } else {
    console.error("Context menu element not found during init!");
    allElementsFound = false;
  }

  // Admin panel specific listeners (if admin panel exists)
  if (uiState.createRoomBtn) {
    uiState.createRoomBtn.addEventListener("click", handleCreateRoomClick);
  }
  if (uiState.layoutTileTypeSelector) {
    uiState.layoutTileTypeSelector.addEventListener("change", (event) => {
      if (
        event.target.type === "radio" &&
        event.target.name === "layout-paint-type"
      ) {
        const value = event.target.value;
        selectedLayoutPaintType = value === "X" ? "X" : parseInt(value, 10);
        console.log("Selected layout paint type:", selectedLayoutPaintType);
      }
    });
    // Read initial value
    const initialChecked = uiState.layoutTileTypeSelector.querySelector(
      'input[name="layout-paint-type"]:checked'
    );
    if (initialChecked) {
      selectedLayoutPaintType =
        initialChecked.value === "X" ? "X" : parseInt(initialChecked.value, 10);
    } else {
      // Default if none checked initially
      selectedLayoutPaintType = 0;
      const defaultRadio = uiState.layoutTileTypeSelector.querySelector(
        'input[name="layout-paint-type"][value="0"]'
      );
      if (defaultRadio) defaultRadio.checked = true;
    }
  } else {
    console.warn("Admin layout tile type selector not found.");
  }

  updateAdminUI(); // Set initial visibility of admin button

  if (allElementsFound) {
    console.log("UI Manager Initialized successfully.");
  } else {
    console.error("UI Manager Initialized with missing CRITICAL elements.");
  }
  return allElementsFound;
}

// --- Loading Overlay Functions ---

/** Displays the loading overlay with a specified message. */
export function showLoadingOverlay(message = "Loading...") {
  if (uiState.loadingOverlay && uiState.loadingMessage) {
    uiState.loadingMessage.textContent = message;
    uiState.loadingOverlay.classList.remove("hidden");
    uiState.loadingOverlay.style.display = "flex"; // Ensure it's visible
  } else {
    // Only warn if critical elements are missing after init should have run
    if (CLIENT_CONFIG) {
      // Check if config loaded, implies initUIManager should have run
      console.warn("showLoadingOverlay called but loading elements not found.");
    }
  }
}

/** Hides the loading overlay smoothly. */
export function hideLoadingOverlay() {
  if (uiState.loadingOverlay) {
    uiState.loadingOverlay.classList.add("hidden");
    // Use setTimeout to set display:none after the opacity transition completes
    setTimeout(() => {
      // Double check it should still be hidden before setting display:none
      if (uiState.loadingOverlay?.classList.contains("hidden")) {
        uiState.loadingOverlay.style.display = "none";
      }
    }, 300); // Match CSS transition duration (0.3s)
  }
}

/** NEW: Toggle Panel Visibility */
export function togglePanel(panelIdSuffix, forceState = undefined) {
  // Construct the full uiState key for the panel element
  const panelKey = panelIdSuffix + "Panel"; // e.g., 'inventoryPanel'
  const panel = uiState[panelKey];

  // Construct the full uiState key for the toggle button element
  let buttonKey =
    "toggle" +
    panelIdSuffix.charAt(0).toUpperCase() +
    panelIdSuffix.slice(1) +
    "Btn"; // e.g., 'toggleInventoryBtn'
  // Handle special case for edit button name mismatch
  if (panelIdSuffix === "edit") {
    buttonKey = "toggleEditBottomBtn";
  }
  const button = uiState[buttonKey];

  if (!panel) {
    console.warn(
      `Panel element not found in uiState for ID suffix: ${panelIdSuffix}`
    );
    return;
  }

  const shouldBeOpen =
    forceState !== undefined ? forceState : panel.style.display === "none";

  // Close currently active panel if different and opening a new one
  if (
    shouldBeOpen &&
    uiState.activePanelId != null &&
    uiState.activePanelId !== panelIdSuffix
  ) {
    togglePanel(uiState.activePanelId, false); // Close the other panel
  }

  // Toggle the target panel
  panel.style.display = shouldBeOpen ? "flex" : "none"; // Use flex as panels have flex-direction: column

  // Update the corresponding button's active state
  if (button) {
    button.classList.toggle("active", shouldBeOpen);
  } else {
    // Log if button not found, except for 'edit' which might not have a direct toggle button in some layouts
    if (panelIdSuffix !== "edit") {
      console.warn(
        `Toggle button not found for panel suffix: ${panelIdSuffix} (expected key: ${buttonKey})`
      );
    }
  }

  // Update the tracked active panel ID
  uiState.activePanelId = shouldBeOpen ? panelIdSuffix : null;

  // Special actions when opening specific panels
  if (shouldBeOpen) {
    if (panelIdSuffix === "inventory") {
      populateInventory(); // Refresh inventory content when panel is opened
    } else if (panelIdSuffix === "shop") {
      populateShopPanel(); // Populate shop panel
    } else if (panelIdSuffix === "admin") {
      requestAllRoomIds(); // Request admin room list
    } else if (panelIdSuffix === "userList") {
      // User list updates via network events mostly, but requesting here ensures freshness if needed
      // requestUserList(); // Uncomment if you want to force refresh on open
    } else if (panelIdSuffix === "rooms") {
      // Request public room list when the panel opens
      if (isConnected()) {
        requestPublicRooms();
      } else {
        // Handle case where user tries to open panel while disconnected
        if (uiState.roomsListContent) {
          uiState.roomsListContent.innerHTML =
            "<p><i>Not connected to server.</i></p>";
        }
      }
    } else if (panelIdSuffix === "debug") {
      // Debug panel content updates in the game loop via updateDebugInfo()
      updateDebugInfo(); // Update immediately on open
    }
  }

  // Hide context menu whenever a panel is toggled
  hideContextMenu();
}

/** Resets UI elements to their default/loading state, typically on disconnect or room change. */
export function resetUIState() {
  console.log("Resetting UI State...");
  showLoadingOverlay("Loading Room..."); // Show loading state

  // Close any active panel
  if (uiState.activePanelId && uiState.activePanelId !== null) {
    // Ensure activePanelId is not null
    togglePanel(uiState.activePanelId, false);
  }
  uiState.activePanelId = null; // Explicitly clear active panel tracker

  // Clear dynamic content areas within panels or other containers
  if (uiState.chatLogDiv) uiState.chatLogDiv.innerHTML = "";
  uiState.chatMessages = [];
  if (uiState.inventoryItemsDiv)
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Entering room...</i></p>";
  if (uiState.userListContent)
    uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
  if (uiState.debugDiv) uiState.debugDiv.textContent = "Resetting state...";
  if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
  uiState.activeChatBubbles = [];
  if (uiState.shopItemsDiv)
    uiState.shopItemsDiv.innerHTML = "<p><i>Stocking shelves...</i></p>";
  if (uiState.adminRoomListDiv)
    uiState.adminRoomListDiv.innerHTML = "<i>...</i>";
  if (uiState.roomsListContent)
    // Clear rooms list content
    uiState.roomsListContent.innerHTML = "<p><i>...</i></p>";

  // Hide floating panels explicitly
  hideProfilePanel();
  hideRecolorPanel();

  // Update static displays in header/etc.
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Loading...";
  if (uiState.currencyDisplay)
    uiState.currencyDisplay.textContent = "Silly Coins: ...";
  document.title = "ZanyTown - Loading...";

  // Reset edit mode state
  uiState.isEditMode = false;
  if (CLIENT_CONFIG) {
    uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  } else {
    uiState.editMode.state = "navigate"; // Fallback
  }
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;

  // Update UI buttons/cursor based on reset state
  updateInventorySelection(); // Clear inventory selection visuals
  updateUICursor(); // Reset cursor
  hideContextMenu(); // Ensure context menu is hidden

  // Reset bottom bar buttons appearance and state
  if (uiState.toggleEditBottomBtn) {
    uiState.toggleEditBottomBtn.classList.remove("active");
    uiState.toggleEditBottomBtn.disabled = true; // Disable until connected/loaded
  }
  // Disable other buttons that require connection/room state
  if (uiState.toggleShopBtn) uiState.toggleShopBtn.disabled = true;
  if (uiState.toggleAdminBtn) uiState.toggleAdminBtn.disabled = true;
  if (uiState.toggleRoomsBtn) uiState.toggleRoomsBtn.disabled = true;
  if (uiState.toggleInventoryBtn) uiState.toggleInventoryBtn.disabled = true;
  if (uiState.toggleUsersBtn) uiState.toggleUsersBtn.disabled = true;
  if (uiState.toggleDebugBtn) uiState.toggleDebugBtn.disabled = true;

  updateAdminUI(); // Ensure admin UI button is hidden if user somehow lost status
}

// --- Chat & Bubble Management ---

/** Adds a message to the chat log UI. */
export function logChatMessage(message, isSelf = false, className = "") {
  if (!uiState.chatLogDiv || !CLIENT_CONFIG || typeof message !== "string") {
    console.warn(
      "logChatMessage: Chat log element, config, or message invalid."
    );
    return;
  }

  const p = document.createElement("p");
  // Use textContent for safety against HTML injection
  p.textContent = message;
  if (isSelf) p.classList.add("self-msg");
  if (className) {
    className.split(" ").forEach((cls) => {
      if (cls) p.classList.add(cls.trim());
    });
  }

  const div = uiState.chatLogDiv;
  // Check scroll position *before* adding the new message
  const isScrolledToBottom =
    Math.abs(div.scrollHeight - div.clientHeight - div.scrollTop) < 5;

  div.appendChild(p);
  uiState.chatMessages.push(p);

  // Limit messages displayed
  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    const oldMessage = uiState.chatMessages.shift();
    oldMessage?.remove(); // Safely remove the element from DOM
  }

  // Auto-scroll only if user was already at the bottom
  if (isScrolledToBottom) {
    // Use timeout to ensure element is rendered before scrolling
    setTimeout(() => {
      div.scrollTop = div.scrollHeight;
    }, 0);
  }
}

/** Updates positions of active chat bubbles and removes expired ones. Called by game loop. */
export function updateChatBubbles(currentTime) {
  if (!uiState.bubbleContainer || !CLIENT_CONFIG) return;

  for (let i = uiState.activeChatBubbles.length - 1; i >= 0; i--) {
    const bubble = uiState.activeChatBubbles[i];
    // Basic check if bubble object is valid
    if (!bubble || typeof bubble !== "object") {
      uiState.activeChatBubbles.splice(i, 1); // Remove invalid entry
      continue;
    }

    // Check expiration
    if (currentTime > bubble.endTime) {
      bubble.element?.remove(); // Remove DOM element if it exists
      uiState.activeChatBubbles.splice(i, 1); // Remove from active list
      // Clean up reference on the avatar object if it matches
      if (bubble.avatarId) {
        const owner = gameState.avatars[bubble.avatarId];
        if (owner && owner.chatBubble?.id === bubble.id) {
          owner.chatBubble = null;
        }
      }
    } else {
      updateChatBubblePosition(bubble); // Update position if still active
    }
  }
}

/** Creates or updates the position of a single chat bubble element relative to its avatar. */
function updateChatBubblePosition(bubble) {
  if (!bubble || !uiState.bubbleContainer || !bubble.avatarId) return;
  const avatar = gameState.avatars[bubble.avatarId];
  if (!avatar) {
    // Avatar might have left, remove the bubble
    bubble.element?.remove();
    // Mark for removal in the next updateChatBubbles cycle
    bubble.endTime = 0;
    return;
  }

  // Create DOM element if it doesn't exist yet
  if (!bubble.element) {
    bubble.element = document.createElement("div");
    bubble.element.id = bubble.id;
    bubble.element.className = "chat-bubble";
    bubble.element.textContent = bubble.text; // Assume text is safe
    uiState.bubbleContainer.appendChild(bubble.element);
  }

  // Ensure necessary configs and state are available for position calculation
  if (!SHARED_CONFIG || !CLIENT_CONFIG || !camera) return;

  // Calculate avatar's screen position and dimensions (consistent with ClientAvatar.draw)
  const screenPos = getScreenPos(avatar.visualX, avatar.visualY);
  const zoom = camera.zoom;
  const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
  const headHeight = totalHeight * 0.3;
  const zOffsetPx = avatar.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
  const baseY =
    screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx;
  const bodyY = baseY - totalHeight * 0.7;
  const headTopY = bodyY - headHeight;
  const verticalOffsetAboveHead = 15 * zoom; // Space between head top and bubble bottom

  // Update style using transform for performance
  // requestAnimationFrame helps batch DOM updates for potentially smoother rendering
  requestAnimationFrame(() => {
    if (!bubble.element) return; // Check if element was removed before frame render
    // translate(-50%, calc(-100% - verticalOffset)) positions the bubble's center-bottom
    // above the avatar's head-top point.
    bubble.element.style.transform = `translate(-50%, calc(-100% - ${verticalOffsetAboveHead}px)) translate(${screenPos.x}px, ${headTopY}px)`;
  });
}

// --- Debug Info ---

/** Updates the content of the debug information panel. Called by game loop. */
export function updateDebugInfo() {
  // Target the content div inside the debug panel
  if (!uiState.debugDiv || !SHARED_CONFIG || !CLIENT_CONFIG || !inputState)
    return;

  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const pGrid = player
    ? snapToGrid(player.visualX, player.visualY)
    : { x: "?", y: "?" };
  const pState = player ? player.state : "N/A";
  const pDir = player ? player.direction : "?";
  const mGrid = inputState.currentMouseGridPos || { x: "?", y: "?" };
  const furniCount = Object.keys(gameState.furniture || {}).length;
  const avatarCount = Object.keys(gameState.avatars || {}).length;
  const inventoryCount = Object.values(gameState.inventory || {}).reduce(
    (s, q) => s + q,
    0
  );
  const currentRoom = gameState.currentRoomId || "N/A";
  const isAdmin = player?.isAdmin || false;

  // Edit Mode Details
  let editDetails = " Off";
  if (uiState.isEditMode) {
    editDetails = ` St: ${uiState.editMode.state}`;
    if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
      const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === uiState.editMode.selectedInventoryItemId
      );
      editDetails += ` Item: ${escapeHtml(def?.name || "?")} R:${
        uiState.editMode.placementRotation
      } V:${uiState.editMode.placementValid ? "OK" : "No"}`;
    } else if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const f = gameState.furniture[uiState.editMode.selectedFurnitureId];
      editDetails += ` Sel: ${escapeHtml(
        f?.definition?.name || "?"
      )} (ID:${uiState.editMode.selectedFurnitureId?.substring(0, 6)}...) R:${
        f?.rotation ?? "?"
      }`;
    }
    // Layout Paint Details (if admin and in navigate sub-state)
    if (
      isAdmin &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE
    ) {
      editDetails += ` Paint: ${selectedLayoutPaintType}`;
    }
  }

  // Tile Info under cursor
  let tileInfo = "";
  const ht = gameState.highlightedTile;
  if (ht && isValidClientTile(ht.x, ht.y)) {
    const tLayout = getTileLayoutType(ht.x, ht.y);
    const stack = Object.values(gameState.furniture).filter(
      (f) =>
        f instanceof ClientFurniture &&
        Math.round(f.visualX) === ht.x &&
        Math.round(f.visualY) === ht.y
    );
    stack.sort((a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0));
    const topFurni = stack[0];
    const stackHeight = getClientStackHeightAt(ht.x, ht.y);
    tileInfo = ` Tile(${ht.x},${ht.y}) L:${tLayout ?? "?"} ${
      topFurni
        ? `Top:${escapeHtml(
            topFurni.definition?.name || "?"
          )}(Z:${topFurni.visualZ.toFixed(2)}) `
        : ""
    }StackZ:${stackHeight.toFixed(2)}`;
  }

  // Construct the final HTML string
  uiState.debugDiv.innerHTML =
    `Room: ${escapeHtml(currentRoom)} | Player: (${pGrid.x},${
      pGrid.y
    }) St:${pState} Dir:${pDir}<br>` +
    `Mouse: (${mGrid.x},${mGrid.y})${tileInfo}<br>` +
    `Cam: (${camera.x.toFixed(0)},${camera.y.toFixed(
      0
    )}) Zoom:${camera.zoom.toFixed(2)}<br>` +
    `Edit: ${editDetails}<br>` +
    `Inv: ${inventoryCount} | Coins: ${gameState.myCurrency} | Admin:${
      isAdmin ? "Y" : "N"
    }<br>` +
    `Objs:${furniCount}|Users:${avatarCount}|Bub:${
      uiState.activeChatBubbles.length
    }|Sock:${isConnected() ? "OK" : "DOWN"}`;
}

// --- Inventory & Shop UI ---

/** Populates the inventory UI panel based on gameState.inventory. */
export function populateInventory() {
  // Target the content div within the inventory panel
  if (!uiState.inventoryItemsDiv || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    console.warn("populateInventory: Inventory div or definitions not ready.");
    if (uiState.inventoryItemsDiv)
      uiState.inventoryItemsDiv.innerHTML =
        "<p><i>Error loading inventory.</i></p>";
    return;
  }

  uiState.inventoryItemsDiv.innerHTML = ""; // Clear previous content
  const inventory = gameState.inventory;
  const ownedItemIds = Object.keys(inventory || {}).filter(
    (id) => inventory[id] > 0
  );

  if (ownedItemIds.length === 0) {
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
    // Deselect item if it's no longer in inventory while placing
    if (
      uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING &&
      !inventory[uiState.editMode.selectedInventoryItemId]
    ) {
      setSelectedInventoryItem(null);
    }
    return;
  }

  // Sort items alphabetically by name
  ownedItemIds.sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === a);
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === b);
    return (defA?.name || a).localeCompare(defB?.name || b);
  });

  ownedItemIds.forEach((itemId) => {
    const quantity = inventory[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (!def) return; // Skip if definition not found

    const itemDiv = document.createElement("div");
    itemDiv.className = "inventory-item";
    itemDiv.dataset.itemId = def.id; // Store definition ID for selection

    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = def.color || "#8B4513"; // Use definition color
    itemDiv.appendChild(previewSpan);

    // Add text content (Item Name and Quantity)
    itemDiv.appendChild(
      document.createTextNode(` ${escapeHtml(def.name)} (x${quantity})`)
    );
    itemDiv.title = `${escapeHtml(def.name)} (${def.width}x${def.height})${
      def.canSit ? " (Sit)" : ""
    }${def.stackable ? " (Stack)" : ""}${def.canUse ? " (Use)" : ""}${
      def.canRecolor ? " (Recolor)" : ""
    }`;

    // Click listener for selection/placement
    itemDiv.addEventListener("click", () => {
      if (uiState.isEditMode) {
        setSelectedInventoryItem(def.id); // Select item for placement
        playSound("select"); // Optional feedback sound
      } else {
        // Provide feedback if trying to place outside edit mode
        itemDiv.classList.add("flash-red");
        setTimeout(() => itemDiv.classList.remove("flash-red"), 600);
        logChatMessage(
          "Enable 'Edit' mode (bottom bar) to place items!",
          true,
          "info-msg"
        );
      }
    });
    uiState.inventoryItemsDiv.appendChild(itemDiv);
  });

  updateInventorySelection(); // Ensure correct item is visually highlighted
}

/** Updates the visual selection state of items in the inventory UI. */
export function updateInventorySelection() {
  if (!uiState.inventoryItemsDiv || !CLIENT_CONFIG) return;
  uiState.inventoryItemsDiv
    .querySelectorAll(".inventory-item")
    .forEach((item) => {
      const isSelected =
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        item.dataset.itemId === uiState.editMode.selectedInventoryItemId;
      item.classList.toggle("selected", isSelected);
    });
}

/** Updates the player currency display in the header. */
export function updateCurrencyDisplay() {
  if (!uiState.currencyDisplay) {
    console.warn("updateCurrencyDisplay: Currency display element not found.");
    return;
  }

  const currentText = uiState.currencyDisplay.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)
    ? currentText.match(/\d+/)[0]
    : "0";
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency;
  uiState.currencyDisplay.textContent = `Silly Coins: ${newValue}`;

  // Flash effect on change
  if (
    !isNaN(oldValue) &&
    newValue !== oldValue &&
    !uiState.currencyDisplay.classList.contains("flash-green") &&
    !uiState.currencyDisplay.classList.contains("flash-red")
  ) {
    const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
    uiState.currencyDisplay.classList.add(changeClass);
    setTimeout(() => {
      uiState.currencyDisplay?.classList.remove(changeClass); // Check element still exists
    }, 600);
  }
}

/** Shows the shop panel (using togglePanel). */
export function showShopPanel() {
  togglePanel("shop", true);
}

/** Hides the shop panel (using togglePanel). */
export function hideShopPanel() {
  togglePanel("shop", false);
}

/** Populates the shop panel UI based on SHARED_CONFIG.SHOP_CATALOG. */
function populateShopPanel() {
  // Target the content div within the shop panel
  if (
    !uiState.shopItemsDiv ||
    !SHARED_CONFIG?.SHOP_CATALOG ||
    !SHARED_CONFIG?.FURNITURE_DEFINITIONS
  ) {
    console.warn("populateShopPanel: Shop items div or config not ready.");
    if (uiState.shopItemsDiv)
      uiState.shopItemsDiv.innerHTML = "<p><i>Error loading shop.</i></p>";
    return;
  }

  uiState.shopItemsDiv.innerHTML = ""; // Clear previous content
  if (
    !Array.isArray(SHARED_CONFIG.SHOP_CATALOG) ||
    SHARED_CONFIG.SHOP_CATALOG.length === 0
  ) {
    uiState.shopItemsDiv.innerHTML = "<p><i>Shop is empty!</i></p>";
    return;
  }

  // Sort catalog items (e.g., by price or name)
  const sortedCatalog = [...SHARED_CONFIG.SHOP_CATALOG].sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === a.itemId
    );
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === b.itemId
    );
    // Sort by name primarily, then price if names are equal
    const nameCompare = (defA?.name || a.itemId).localeCompare(
      defB?.name || b.itemId
    );
    if (nameCompare !== 0) return nameCompare;
    return (a.price || 0) - (b.price || 0);
  });

  sortedCatalog.forEach((shopEntry) => {
    const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (def) => def.id === shopEntry.itemId
    );
    if (!definition) return; // Skip if definition missing

    const itemDiv = document.createElement("div");
    itemDiv.className = "shop-item";

    // Info section (Preview + Name)
    const infoDiv = document.createElement("div");
    infoDiv.className = "shop-item-info";
    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = definition.color || "#8B4513";
    infoDiv.appendChild(previewSpan);
    const nameSpan = document.createElement("span");
    nameSpan.className = "shop-item-name";
    nameSpan.textContent = escapeHtml(definition.name || shopEntry.itemId);
    nameSpan.title = `${escapeHtml(definition.name)} (${definition.width}x${
      definition.height
    })`;
    infoDiv.appendChild(nameSpan);
    itemDiv.appendChild(infoDiv);

    // Price section
    const priceSpan = document.createElement("span");
    priceSpan.className = "shop-item-price";
    priceSpan.textContent = `${shopEntry.price} Coins`;
    itemDiv.appendChild(priceSpan);

    // Buy button section
    const buyButton = document.createElement("button");
    buyButton.className = "buy-btn";
    buyButton.textContent = "Buy";
    buyButton.dataset.itemId = shopEntry.itemId;
    buyButton.dataset.price = shopEntry.price;
    buyButton.addEventListener("click", () => {
      if (!isConnected()) {
        logChatMessage("Not connected to server.", true, "error-msg");
        return;
      }
      buyButton.disabled = true; // Disable immediately
      buyButton.textContent = "Buying...";
      requestBuyItem(shopEntry.itemId); // Send buy request
      // Button state will be re-evaluated by updateShopButtonStates after currency/inventory updates
      // Adding a small delay ensures visual feedback even if server response is fast
      setTimeout(updateShopButtonStates, 300);
    });
    itemDiv.appendChild(buyButton);

    uiState.shopItemsDiv.appendChild(itemDiv);
  });

  updateShopButtonStates(); // Set initial enabled/disabled state of buy buttons
}

/** Updates the enabled state of buy buttons in the shop based on player currency. */
export function updateShopButtonStates() {
  if (!uiState.shopItemsDiv) return;
  uiState.shopItemsDiv.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = gameState.myCurrency >= price;
      button.disabled = !canAfford; // Disable if cannot afford
      button.classList.toggle("cannot-afford", !canAfford); // Add class for styling
      // Reset text if it was 'Buying...' and button is now enabled/disabled based on price
      if (button.textContent === "Buying...") {
        button.textContent = "Buy";
      }
    } else {
      button.disabled = true; // Disable if price data is invalid
    }
  });
}

// --- User List & Profile UI ---

/** Populates the user list panel with online users in the current room. */
export function updateUserListPanel(users) {
  // Target the UL element within the user list panel
  if (!uiState.userListContent || !uiState.userListPanel) {
    console.warn("updateUserListPanel: User list elements not found.");
    return;
  }
  uiState.userListContent.innerHTML = ""; // Clear previous list

  // Update the panel's header with the current room ID
  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${escapeHtml(gameState.currentRoomId)})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle;

  if (!users || !Array.isArray(users) || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }

  // Sort users alphabetically by name
  users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  users.forEach((user) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(user.name || "Unknown");
    const userIdStr = String(user.id); // Ensure ID is a string
    li.dataset.userid = userIdStr;
    // Highlight the player's own name
    li.classList.toggle("self-user", userIdStr === gameState.myAvatarId);
    // Add click listener to request profile (if not clicking self)
    li.addEventListener("click", () => {
      if (userIdStr !== gameState.myAvatarId && isConnected()) {
        requestProfile(userIdStr);
      }
    });
    uiState.userListContent.appendChild(li);
  });
}

/** Displays the profile panel with data for a specific user. */
export function showProfilePanel(profileData) {
  if (!uiState.profilePanel || !uiState.profileContent) {
    console.warn("showProfilePanel: Profile panel elements not found.");
    return;
  }

  // Ensure profileData is valid
  if (!profileData || !profileData.id) {
    console.warn("showProfilePanel: Invalid profile data received.");
    return;
  }

  const name = profileData.name || "Unknown User";
  const id = String(profileData.id); // Ensure ID is string
  const state = profileData.state || "Idle";
  const color = profileData.bodyColor || "#CCCCCC"; // Default swatch color
  const currency =
    profileData.currency === undefined
      ? "N/A"
      : `${profileData.currency} Coins`;

  // Populate panel content using safe HTML insertion
  uiState.profileContent.innerHTML = `
        <h4>${escapeHtml(name)}</h4>
        <p>Status: ${escapeHtml(state)}</p>
        <p>Look: <span class="profile-color-swatch" style="background-color: ${escapeHtml(
          color
        )};"></span> ${escapeHtml(color)}</p>
        <p>Coins: ${escapeHtml(currency)}</p>
        <div class="profile-actions">
            <!-- Add buttons for Friend, Trade, Ignore later -->
        </div>`;

  uiState.profilePanel.dataset.targetId = id; // Store target ID for reference
  uiState.profilePanel.style.display = "block"; // Show the panel
}

/** Hides the profile panel. */
export function hideProfilePanel() {
  if (uiState.profilePanel) {
    uiState.profilePanel.style.display = "none";
    uiState.profilePanel.dataset.targetId = ""; // Clear target ID
    if (uiState.profileContent) uiState.profileContent.innerHTML = ""; // Clear content
  }
}

// --- Recolor Panel UI ---

/** Displays the recolor panel for a specific piece of furniture. */
export function showRecolorPanel(furniId) {
  const furniIdStr = String(furniId); // Ensure ID is string
  const furni = gameState.furniture[furniIdStr];

  // Validate all necessary elements and conditions
  if (
    !uiState.recolorPanel ||
    !uiState.recolorSwatchesDiv ||
    !uiState.recolorItemNameP ||
    !furni ||
    !(furni instanceof ClientFurniture) ||
    !furni.canRecolor ||
    !SHARED_CONFIG?.VALID_RECOLOR_HEX
  ) {
    console.warn("showRecolorPanel: Conditions not met or elements missing.");
    hideRecolorPanel(); // Ensure panel is hidden if conditions fail
    return;
  }

  uiState.activeRecolorFurniId = furniIdStr; // Store ID of item being recolored
  uiState.recolorItemNameP.textContent = `Item: ${escapeHtml(
    furni.definition?.name || "Unknown"
  )}`;
  uiState.recolorSwatchesDiv.innerHTML = ""; // Clear previous swatches

  // Populate color swatches
  SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "recolor-swatch";
    swatch.style.backgroundColor = hex;
    swatch.title = hex; // Tooltip shows the hex code
    swatch.dataset.colorHex = hex; // Store color data
    swatch.addEventListener("click", () => handleRecolorSwatchClick(hex)); // Add click listener
    uiState.recolorSwatchesDiv.appendChild(swatch);
  });

  uiState.recolorPanel.style.display = "block"; // Show the panel
}

/** Hides the recolor panel. */
export function hideRecolorPanel() {
  if (uiState.recolorPanel) {
    uiState.recolorPanel.style.display = "none";
  }
  uiState.activeRecolorFurniId = null; // Clear the active item ID
}

/** Handles clicking a color swatch in the recolor panel. */
function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor); // Send request
    hideRecolorPanel(); // Close panel after selection
  } else {
    console.warn("handleRecolorSwatchClick: No active item or not connected.");
  }
}

// --- Admin UI Functions ---

/** Shows or hides admin UI elements based on the player's status. */
export function updateAdminUI() {
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const isAdmin = player?.isAdmin || false;
  const displayStyle = isAdmin ? "flex" : "none"; // Use 'flex' for bottom bar button layout

  // Toggle visibility of the Admin button in the bottom bar
  if (uiState.toggleAdminBtn) {
    uiState.toggleAdminBtn.style.display = displayStyle;
    // Only enable the button if the user is an admin AND connected
    uiState.toggleAdminBtn.disabled = !isAdmin || !isConnected();
  }

  // Ensure the Admin *panel* is hidden if the user is not an admin
  // and it happens to be the currently active panel.
  if (!isAdmin && uiState.activePanelId === "admin") {
    togglePanel("admin", false); // Force close the admin panel
  }
}

/** Populates the list of available rooms in the admin panel. */
export function updateAdminRoomList(roomIds) {
  // Target the content div inside the admin panel
  if (!uiState.adminRoomListDiv) {
    console.warn("updateAdminRoomList: Admin room list div not found.");
    return;
  }
  uiState.adminRoomListDiv.innerHTML = ""; // Clear previous list

  if (!roomIds || !Array.isArray(roomIds) || roomIds.length === 0) {
    uiState.adminRoomListDiv.textContent = "No rooms found.";
    return;
  }

  const ul = document.createElement("ul");
  roomIds.sort(); // Sort alphabetically
  roomIds.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(id);
    li.title = `Click to join ${escapeHtml(id)}`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      console.log(`Admin joining room via list: ${id}`);
      // Use the chat command workaround for joining rooms via admin panel
      // sendChat(`/join ${id}`); // Or use direct requestChangeRoom if preferred
      requestChangeRoom(id); // Use direct room change request
      // Hide the admin panel after clicking a room for better UX
      togglePanel("admin", false);
    });
    ul.appendChild(li);
  });
  uiState.adminRoomListDiv.appendChild(ul);
}

/** Handles the click event for the "Create Room" admin button. */
function handleCreateRoomClick() {
  // Check permissions client-side (server validates again)
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!player?.isAdmin) {
    logChatMessage("Admin permissions required.", true, "error-msg");
    return;
  }

  const newRoomId = prompt(
    "Enter ID for the new room (letters, numbers, underscores):"
  );
  if (newRoomId && newRoomId.trim()) {
    const sanitizedId = newRoomId.trim().toLowerCase().replace(/\s+/g, "_");
    // Optional: Prompt for dimensions with validation
    const colsStr = prompt(`Enter columns (5-50):`, "15");
    const rowsStr = prompt(`Enter rows (5-50):`, "18");
    const cols = parseInt(colsStr, 10);
    const rows = parseInt(rowsStr, 10);

    if (
      isNaN(cols) ||
      isNaN(rows) ||
      cols < 5 ||
      cols > 50 ||
      rows < 5 ||
      rows > 50
    ) {
      alert("Invalid dimensions. Must be between 5 and 50.");
      return;
    }
    requestCreateRoom(sanitizedId, cols, rows); // Send request to server
  } else if (newRoomId !== null) {
    // Only show error if prompt wasn't cancelled
    alert("Invalid room ID entered.");
  }
}

// --- Room List Population ---
/** Populates the rooms panel UI with data received from the server. */
export function populateRoomsPanel(roomData) {
  // Target the content div within the rooms panel
  if (!uiState.roomsListContent) {
    console.warn("populateRoomsPanel: Rooms list content div not found.");
    return;
  }

  uiState.roomsListContent.innerHTML = ""; // Clear previous content

  if (!Array.isArray(roomData) || roomData.length === 0) {
    uiState.roomsListContent.innerHTML =
      "<p><i>No public rooms available.</i></p>";
    return;
  }

  // roomData is expected to be an array of { id: string, playerCount: number }

  // Sort rooms alphabetically by ID
  roomData.sort((a, b) => (a.id || "").localeCompare(b.id || ""));

  roomData.forEach((roomInfo) => {
    const roomDiv = document.createElement("div");
    roomDiv.className = "room-list-item"; // Use a class for styling
    roomDiv.dataset.roomId = roomInfo.id;

    const nameSpan = document.createElement("span");
    nameSpan.className = "room-name";
    nameSpan.textContent = escapeHtml(roomInfo.id);
    roomDiv.appendChild(nameSpan);

    const countSpan = document.createElement("span");
    countSpan.className = "room-player-count";
    countSpan.textContent = `(${roomInfo.playerCount} ${
      roomInfo.playerCount === 1 ? "User" : "Users"
    })`;
    roomDiv.appendChild(countSpan);

    // Highlight current room
    if (roomInfo.id === gameState.currentRoomId) {
      roomDiv.classList.add("current-room");
    } else {
      // Add click listener to join other rooms
      roomDiv.addEventListener("click", () => {
        if (isConnected()) {
          console.log(`Requesting change to room: ${roomInfo.id}`);
          requestChangeRoom(roomInfo.id); // Use network function
          togglePanel("rooms", false); // Close panel after clicking
        } else {
          logChatMessage("Not connected.", true, "error-msg");
        }
      });
    }

    uiState.roomsListContent.appendChild(roomDiv);
  });
}

// --- Edit Mode State Management ---

/** Sets the current edit mode sub-state and performs necessary cleanup/UI updates. */
export function setEditState(newState) {
  if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;

  const oldState = uiState.editMode.state;
  uiState.editMode.state = newState;
  console.log(`Edit state changed from ${oldState} to ${newState}`);

  // Cleanup based on previous state
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_PLACING &&
    newState !== CLIENT_CONFIG.EDIT_STATE_PLACING
  ) {
    uiState.editMode.placementRotation = 0;
    uiState.editMode.placementValid = false;
  }
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
    newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
  ) {
    setSelectedFurniture(null); // Deselect furniture visually
    hideRecolorPanel(); // Hide recolor panel if it was open for the deselected item
  }

  // Update UI dependent on the new state
  updateInventorySelection(); // Reflect selection changes in inventory panel
  updateUICursor(); // Update mouse cursor style
  updateHighlights(); // Update tile/furniture highlights
  hideContextMenu(); // Hide context menu when sub-state changes
}

/** Sets the currently selected item from the inventory for placement. */
export function setSelectedInventoryItem(definitionId) {
  console.log(`Setting selected inventory item: ${definitionId}`);
  uiState.editMode.selectedInventoryItemId = definitionId;
  uiState.editMode.placementRotation = 0; // Reset rotation when selecting new item

  if (definitionId) {
    setSelectedFurniture(null); // Deselect any floor furniture when selecting from inventory
    setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING); // Enter placing sub-state
  } else if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
    // If deselecting an inventory item (setting to null) while in placing state
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Go back to navigate sub-state
  }

  updateInventorySelection(); // Update visual highlight in inventory panel
  updateHighlights(); // Show placement ghost/highlights immediately
  hideContextMenu(); // Hide context menu when selection changes
}

/** Sets the currently selected furniture item on the floor. */
export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null;
  const oldSelectedId = uiState.editMode.selectedFurnitureId;

  if (oldSelectedId === newSelectedId) {
    // Clicking the same item again acts as deselect
    if (newSelectedId !== null) {
      setSelectedFurniture(null); // Recursive call with null to deselect
    }
    return;
  }

  console.log(`Setting selected floor furniture: ${newSelectedId}`);

  // Deselect previous item visually
  if (oldSelectedId && gameState.furniture[oldSelectedId]) {
    gameState.furniture[oldSelectedId].isSelected = false;
  }
  // Set new selected item ID in state
  uiState.editMode.selectedFurnitureId = newSelectedId;

  if (newSelectedId && gameState.furniture[newSelectedId]) {
    // Select the new item
    gameState.furniture[newSelectedId].isSelected = true; // Set visual state
    setSelectedInventoryItem(null); // Ensure no inventory item is simultaneously selected
    setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI); // Set edit sub-state
  } else {
    // Deselecting (newSelectedId is null or item not found)
    uiState.editMode.selectedFurnitureId = null;
    hideRecolorPanel(); // Hide recolor panel if nothing is selected
    // Only change state back to navigate if we were previously selecting furniture
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }

  // Update UI elements based on selection change
  updateHighlights(); // Update highlights (will remove highlight from old, potentially add to new)
  hideContextMenu(); // Hide context menu on selection change
}

/** Toggles the main edit mode on/off. */
export function toggleEditMode() {
  // Target the new button on the bottom bar
  if (!CLIENT_CONFIG || !uiState.toggleEditBottomBtn) {
    console.warn("toggleEditMode: Edit button not found.");
    return;
  }
  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);

  // Update the bottom bar button's appearance
  uiState.toggleEditBottomBtn.classList.toggle("active", uiState.isEditMode);

  // Reset sub-state and UI when toggling
  if (!uiState.isEditMode) {
    // Exiting Edit Mode
    setSelectedFurniture(null); // Deselect any floor furniture
    setSelectedInventoryItem(null); // Deselect any inventory item
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Ensure state is navigate
    hideRecolorPanel(); // Close recolor panel if open
    hideContextMenu(); // Hide context menu
  } else {
    // Entering Edit Mode
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Start in navigate sub-state
  }

  // Update other UI elements affected by edit mode change
  updateInventorySelection(); // Clear inventory selection visuals if exiting
  updateHighlights(); // Update tile/furniture highlights based on new mode
  updateUICursor(); // Update mouse cursor style
}

// --- Input Click Handlers ---

/** Handles clicks on the canvas when in Edit Mode. */
export function handleEditModeClick(gridPos, screenPos) {
  if (!CLIENT_CONFIG || !SHARED_CONFIG || !gameState.currentRoomId) return;

  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  // Allow layout painting only for admins in navigate sub-state
  const canLayoutEdit =
    uiState.isEditMode &&
    player?.isAdmin &&
    uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;

  if (canLayoutEdit) {
    // Bounds check happens server-side now, but quick client check is okay
    if (
      gridPos.x >= 0 &&
      gridPos.x < gameState.roomCols &&
      gridPos.y >= 0 &&
      gridPos.y < gameState.roomRows
    ) {
      console.log(
        `Requesting layout change at (${gridPos.x}, ${gridPos.y}) to type ${selectedLayoutPaintType}`
      );
      requestModifyLayout(
        gameState.currentRoomId,
        gridPos.x,
        gridPos.y,
        selectedLayoutPaintType
      );
      playSound("place"); // Feedback
    } else {
      logChatMessage(
        `Cannot modify layout outside room bounds.`,
        true,
        "info-msg"
      );
    }
    return; // Layout edit handled
  }

  // Handle furniture placement or selection/use
  switch (uiState.editMode.state) {
    case CLIENT_CONFIG.EDIT_STATE_PLACING:
      if (
        uiState.editMode.placementValid &&
        uiState.editMode.selectedInventoryItemId
      ) {
        if (gameState.inventory[uiState.editMode.selectedInventoryItemId] > 0) {
          requestPlaceFurni(
            uiState.editMode.selectedInventoryItemId,
            gridPos.x,
            gridPos.y,
            uiState.editMode.placementRotation
          );
          playSound("place");
          // Optional: Keep item selected to place multiple?
          // setSelectedInventoryItem(null); // Deselect after placing
        } else {
          logChatMessage(
            "You don't have that item anymore.",
            true,
            "error-msg"
          );
          setSelectedInventoryItem(null); // Deselect if gone
        }
      } else {
        logChatMessage("Cannot place item there.", true, "error-msg");
      }
      break;

    case CLIENT_CONFIG.EDIT_STATE_NAVIGATE:
    case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI:
      // If screenPos is null, it might be a context menu action like "Place Item Here"
      // In that case, we don't need to check for clicked furniture, assume it's placing on the gridPos tile.
      if (screenPos === null && target?.action === "place_item_here") {
        // Handled by EDIT_STATE_PLACING block if an item is selected.
        // If no item selected, this case shouldn't happen via context menu.
      } else if (screenPos !== null) {
        const clickedFurniture = getTopmostFurnitureAtScreen(
          screenPos.x,
          screenPos.y
        );
        if (clickedFurniture) {
          // If clicking the currently selected furniture, do nothing (or maybe deselect?)
          if (clickedFurniture.id === uiState.editMode.selectedFurnitureId) {
            // Option: Deselect by calling setSelectedFurniture(null);
            // For now, do nothing on re-click while selected. Context menu handles actions.
          } else {
            // Selecting a different furniture item
            setSelectedFurniture(clickedFurniture.id);
            // playSound('select'); // Optional selection sound
          }
        } else {
          // Clicked empty space, deselect any currently selected furniture
          setSelectedFurniture(null);
          hideRecolorPanel();
        }
      } else {
        // Clicked on empty tile without a screen position (likely context menu) - handled by context menu handler
      }
      break;
  }
}

/** Handles clicks on the canvas when *not* in Edit Mode (Navigate). */
export function handleNavigateModeClick(gridPos, screenPos) {
  if (!isConnected() || !SHARED_CONFIG || !gameState.currentRoomId) return;
  const myAvatar = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;

  // Check if clicked object available (from left-click or context menu walk_here)
  const clickedAvatar = screenPos
    ? getAvatarAtScreen(screenPos.x, screenPos.y)
    : null;
  const clickedFurniture = screenPos
    ? getTopmostFurnitureAtScreen(screenPos.x, screenPos.y)
    : null;

  // 1. Click on Avatar -> Profile (Only if screenPos available)
  if (clickedAvatar) {
    if (clickedAvatar.id !== gameState.myAvatarId) {
      requestProfile(clickedAvatar.id);
    } else {
      // Clicking self? Maybe show own profile or do nothing?
      // requestProfile(clickedAvatar.id); // Show own profile
      logChatMessage(
        `You clicked yourself (${escapeHtml(clickedAvatar.name)}).`,
        true,
        "info-msg"
      );
    }
    return; // Stop processing if avatar clicked
  }
  // 2. Click self while sitting -> Stand (Check grid pos)
  if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
    if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
      requestStand(); // Server handles state change
      return;
    }
  }
  // 3. Click on Furniture -> Use/Sit/Door (Check grid pos and furniture existence)
  if (clickedFurniture) {
    // Use furniture found at screenPos first
    if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
      const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === clickedFurniture.definitionId
      );
      requestChangeRoom(
        clickedFurniture.targetRoomId,
        doorDef?.targetX,
        doorDef?.targetY
      );
      return;
    }
    if (clickedFurniture.definition?.canUse) {
      requestUseFurni(clickedFurniture.id);
      playSound("use");
      return;
    }
    if (clickedFurniture.definition?.canSit) {
      requestSit(clickedFurniture.id); // Server handles pathfinding/state
      return;
    }
    // If furniture clicked but no specific action, do nothing or log info
    // logChatMessage(`Clicked on ${escapeHtml(clickedFurniture.definition?.name || '?')}.`, true, "info-msg");
    // If it wasn't interactive furniture, fall through to potentially walk to the tile if walkable
  }
  // 4. Click on Floor (or context menu 'Walk Here', or non-interactive furniture) -> Navigate
  if (isClientWalkable(gridPos.x, gridPos.y)) {
    requestMove(gridPos.x, gridPos.y); // Server handles pathfinding/state
  } else if (!clickedFurniture) {
    // Only show error if they clicked empty non-walkable space
    logChatMessage("Cannot walk there.", true, "error-msg");
  }
}

/** Handles the click of the pickup furniture action (from context menu). */
export function handlePickupFurniClick() {
  // This function is now primarily triggered by the context menu handler,
  // but the core logic remains the same. Ensure context menu provides the ID.
  const targetId = uiState.contextMenuTarget?.id;
  if (uiState.isEditMode && targetId && isConnected()) {
    requestPickupFurni(targetId);
    // Optional: Clear selection immediately? Or wait for server confirmation?
    // setSelectedFurniture(null);
  } else {
    logChatMessage("Cannot pick up item now.", true, "info-msg");
  }
}

/** Handles the click of the recolor furniture action (from context menu). */
export function handleRecolorFurniClick() {
  // This function is now primarily triggered by the context menu handler.
  const targetId = uiState.contextMenuTarget?.id;
  if (uiState.isEditMode && targetId) {
    const furni = gameState.furniture[targetId];
    if (furni?.canRecolor) {
      showRecolorPanel(furni.id); // Open the panel
    } else {
      logChatMessage("This item cannot be recolored.", true, "info-msg");
    }
  } else {
    logChatMessage("Cannot recolor item now.", true, "info-msg");
  }
}

// --- Context Menu Functions ---

/** Hides the custom context menu. */
export function hideContextMenu() {
  if (uiState.contextMenu) {
    uiState.contextMenu.style.display = "none";
    const ul = uiState.contextMenu.querySelector("ul");
    if (ul) ul.innerHTML = ""; // Clear items
    uiState.contextMenuTarget = null; // Clear target reference
  }
}

/**
 * Shows the custom context menu at the specified screen coordinates,
 * populated with relevant actions for the target object.
 * @param {number} screenX - Screen X coordinate relative to canvas.
 * @param {number} screenY - Screen Y coordinate relative to canvas.
 * @param {object} target - The clicked object { type: 'avatar'|'furniture'|'tile', id?, x?, y? }.
 */
export function showContextMenu(screenX, screenY, target) {
  if (!uiState.contextMenu || !target || !CLIENT_CONFIG || !SHARED_CONFIG) {
    console.warn("showContextMenu: Prereqs not met.");
    return;
  }

  hideContextMenu(); // Hide previous menu first
  uiState.contextMenuTarget = target; // Store what was clicked

  const menuUl = uiState.contextMenu.querySelector("ul");
  if (!menuUl) {
    console.error("Context menu UL element not found!");
    return;
  }
  menuUl.innerHTML = ""; // Clear previous items

  const menuItems = getContextMenuActions(target); // Get actions based on target

  if (menuItems.length === 0) {
    console.log("No context actions for target:", target);
    return; // Don't show empty menu
  }

  // Populate the menu UL
  menuItems.forEach((item) => {
    const li = document.createElement("li");
    if (item.separator) {
      li.className = "separator";
    } else {
      li.textContent = item.label || "Action"; // Default label
      li.dataset.action = item.action || "none"; // Store action identifier
      if (item.disabled) {
        li.classList.add("disabled");
      }
    }
    menuUl.appendChild(li);
  });

  // Position and show the menu
  // Get menu dimensions *after* populating content
  const menuWidth = uiState.contextMenu.offsetWidth;
  const menuHeight = uiState.contextMenu.offsetHeight;
  const canvasRect = uiState.canvas?.getBoundingClientRect(); // Get canvas bounds relative to viewport
  if (!canvasRect) return; // Cannot position without canvas bounds

  // Calculate initial menu position relative to canvas
  let menuX = screenX;
  let menuY = screenY;

  // Adjust if menu would go off-screen right or bottom
  if (menuX + menuWidth > canvasRect.width) {
    menuX = screenX - menuWidth; // Shift left
  }
  if (menuY + menuHeight > canvasRect.height) {
    menuY = screenY - menuHeight; // Shift up
  }

  // Ensure menu doesn't go off-screen left or top (less common)
  if (menuX < 0) menuX = 5;
  if (menuY < 0) menuY = 5;

  // Apply position and display
  uiState.contextMenu.style.left = `${menuX}px`;
  uiState.contextMenu.style.top = `${menuY}px`;
  uiState.contextMenu.style.display = "block";
}

/** Determines the available actions for the context menu based on the target object and game state. */
function getContextMenuActions(target) {
  const actions = [];
  const isEditing = uiState.isEditMode;
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;

  if (!SHARED_CONFIG || !CLIENT_CONFIG) return []; // Need configs

  if (target.type === "avatar") {
    const avatar = gameState.avatars[target.id];
    if (!avatar) return []; // Target avatar not found

    if (target.id !== gameState.myAvatarId) {
      actions.push({
        label: `Profile: ${escapeHtml(avatar.name)}`,
        action: "profile",
      });
      // Future actions: Trade, Friend, Ignore, etc.
    } else {
      // Actions for clicking self
      actions.push({
        label: "Stand Up",
        action: "stand",
        disabled:
          !player || player.state !== SHARED_CONFIG.AVATAR_STATE_SITTING,
      });
    }
    // Admin actions for targeting others
    if (player?.isAdmin && target.id !== gameState.myAvatarId) {
      actions.push({ separator: true });
      actions.push({
        label: `Kick ${escapeHtml(avatar.name)}`,
        action: "admin_kick",
      });
      // Add other admin actions if needed
    }
  } else if (target.type === "furniture") {
    const furni = gameState.furniture[target.id];
    if (!furni || !furni.definition) return []; // Target furniture not found

    const def = furni.definition;
    const isOwner =
      gameState.myUserId &&
      furni.ownerId &&
      String(furni.ownerId) === gameState.myUserId;
    const occupied = isFurnitureOccupied(target.id); // Check if someone is sitting

    if (isEditing) {
      // --- Edit Mode Actions ---
      if (isOwner || player?.isAdmin) {
        // Allow admin pickup/rotate/recolor
        actions.push({
          label: `Pickup ${escapeHtml(def.name)}`,
          action: "pickup",
          disabled: occupied,
        });
        if (!def.isFlat) {
          actions.push({
            label: "Rotate",
            action: "rotate",
            disabled: occupied,
          });
        }
        if (furni.canRecolor) {
          actions.push({ label: "Recolor", action: "recolor" });
        }
      } else {
        actions.push({ label: `(Not Owner)`, action: "none", disabled: true });
      }
      // Use action can still be useful in edit mode for things like lamps
      if (def.canUse) {
        actions.push({
          label: `Use ${escapeHtml(def.name)}`,
          action: "use",
          // disabled: occupied, // Should lamps be usable if occupied? Maybe not.
        });
      }
    } else {
      // --- Navigate Mode Actions ---
      if (def.isDoor && def.targetRoomId) {
        actions.push({
          label: `Enter ${escapeHtml(def.targetRoomId)}`,
          action: "door",
        });
      } else if (def.canSit) {
        actions.push({
          label: occupied ? "Sit (Occupied)" : "Sit Here",
          action: "sit",
          disabled: occupied,
        });
      } else if (def.canUse) {
        actions.push({
          label: `Use ${escapeHtml(def.name)}`,
          action: "use",
          // disabled: occupied, // Allow using lamp even if someone sits near?
        });
      } else {
        // Non-interactive furniture in navigate mode
        actions.push({
          label: escapeHtml(def.name),
          action: "none",
          disabled: true,
        });
      }
    }
  } else if (target.type === "tile") {
    // --- Actions for clicking empty tile ---
    if (
      isEditing &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
      // If placing an item
      const placingDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === uiState.editMode.selectedInventoryItemId
      );
      const canPlace = placingDef
        ? isClientPlacementValid(placingDef, target.x, target.y)
        : false;
      actions.push({
        label: `Place Item Here`,
        action: "place_item_here",
        disabled: !canPlace,
      });
    } else if (
      isEditing &&
      player?.isAdmin &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE
    ) {
      // If admin is painting layout
      actions.push({
        label: `Paint Tile (${selectedLayoutPaintType})`,
        action: "paint_tile",
      });
    } else if (!isEditing && isClientWalkable(target.x, target.y)) {
      // If navigating
      actions.push({ label: `Walk Here`, action: "walk_here" });
    }
    // Add other tile actions if needed
  }

  return actions;
}

// Helper needed for context menu actions
function isFurnitureOccupied(furniDbId) {
  if (!furniDbId) return false;
  const idString = String(furniDbId);
  return Object.values(gameState.avatars || {}).some(
    (a) => a instanceof ClientAvatar && String(a.sittingOnFurniId) === idString
  );
}

/** Handles clicks on items within the context menu using event delegation. */
function handleContextMenuClick(event) {
  const targetLi = event.target.closest("li"); // Find the clicked list item
  // Ignore clicks on disabled items, separators, or outside list items
  if (
    !targetLi ||
    targetLi.classList.contains("disabled") ||
    targetLi.classList.contains("separator")
  ) {
    hideContextMenu(); // Hide menu but do nothing else
    return;
  }

  const action = targetLi.dataset.action; // Get action from data attribute
  const targetInfo = uiState.contextMenuTarget; // Get info about the right-clicked object

  // Validate action and target context
  if (!action || !targetInfo || action === "none") {
    hideContextMenu();
    return;
  }

  console.log(
    `Context Menu Action: ${action} on ${targetInfo.type} ${
      targetInfo.id || `(${targetInfo.x},${targetInfo.y})`
    }`
  );

  // Execute action based on 'action' and 'targetInfo'
  switch (action) {
    // Avatar Actions
    case "profile":
      if (targetInfo.type === "avatar" && targetInfo.id)
        requestProfile(targetInfo.id);
      break;
    case "stand":
      if (
        targetInfo.type === "avatar" &&
        targetInfo.id === gameState.myAvatarId
      )
        requestStand();
      break;
    // Furniture Actions (Common)
    case "use":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestUseFurni(targetInfo.id);
      break;
    // Furniture Actions (Navigate Mode)
    case "sit":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestSit(targetInfo.id);
      break;
    case "door":
      if (targetInfo.type === "furniture" && targetInfo.id) {
        const furni = gameState.furniture[targetInfo.id];
        if (furni?.isDoor && furni.targetRoomId) {
          const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
            (d) => d.id === furni.definitionId
          );
          requestChangeRoom(
            furni.targetRoomId,
            doorDef?.targetX,
            doorDef?.targetY
          );
        }
      }
      break;
    // Furniture Actions (Edit Mode - Owner/Admin)
    case "pickup":
      if (targetInfo.type === "furniture" && targetInfo.id)
        handlePickupFurniClick(); // Use existing handler logic
      break;
    case "rotate":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestRotateFurni(targetInfo.id);
      break;
    case "recolor":
      if (targetInfo.type === "furniture" && targetInfo.id)
        handleRecolorFurniClick(); // Use existing handler logic
      break;
    // Tile Actions
    case "place_item_here":
      if (
        targetInfo.type === "tile" &&
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        targetInfo.x != null &&
        targetInfo.y != null
      ) {
        handleEditModeClick(targetInfo, null); // Simulate left-click logic for placement
      }
      break;
    case "walk_here":
      if (
        targetInfo.type === "tile" &&
        !uiState.isEditMode &&
        targetInfo.x != null &&
        targetInfo.y != null
      ) {
        handleNavigateModeClick(targetInfo, null); // Simulate left-click logic for walking
      }
      break;
    case "paint_tile":
      if (
        targetInfo.type === "tile" &&
        uiState.isEditMode &&
        gameState.avatars[gameState.myAvatarId]?.isAdmin &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE &&
        targetInfo.x != null &&
        targetInfo.y != null
      ) {
        handleEditModeClick(targetInfo, null); // Simulate left-click logic for painting
      }
      break;
    // Admin Actions (Example using chat commands)
    case "admin_kick":
      if (targetInfo.type === "avatar" && targetInfo.id) {
        const avatar = gameState.avatars[targetInfo.id];
        if (avatar) {
          sendChat(`/kick ${avatar.name}`); // Use chat command helper
        }
      }
      break;
    // Default case for unhandled actions
    default:
      console.warn(`Unhandled context menu action: ${action}`);
      break;
  }

  hideContextMenu(); // Hide menu after action is processed
}

// --- Highlighting Logic ---

/** Updates tile and furniture highlights based on mouse position and edit mode. Called by game loop. */
export function updateHighlights() {
  if (
    !CLIENT_CONFIG ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.clientTiles ||
    !inputState
  ) {
    return; // Prereqs not met
  }

  clearAllHighlights(); // Clear previous tile highlights first

  const gridPos = inputState.currentMouseGridPos || { x: -1, y: -1 };
  const screenPos = inputState.currentMouseScreenPos || { x: -1, y: -1 };

  // Validate if mouse is over a valid tile in the current room layout
  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    gameState.highlightedTile = null; // Not highlighting any tile
    // If placing item, mark placement as invalid when off-grid
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
    ) {
      uiState.editMode.placementValid = false;
    }
    return; // Stop if mouse is outside valid grid area
  }

  // Store the currently hovered valid tile coordinates
  gameState.highlightedTile = { x: gridPos.x, y: gridPos.y };

  // Determine highlight style based on current mode (Edit vs Navigate)
  if (uiState.isEditMode) {
    // --- Edit Mode Highlighting ---
    if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
      // Highlight for placing an item from inventory
      const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === uiState.editMode.selectedInventoryItemId
      );
      uiState.editMode.placementValid = definition
        ? isClientPlacementValid(definition, gridPos.x, gridPos.y)
        : false;
      const color = uiState.editMode.placementValid
        ? CLIENT_CONFIG.FURNI_PLACE_HIGHLIGHT_COLOR
        : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR;

      if (definition) {
        // Highlight all tiles the item would occupy
        const tempFurniProto = {
          x: gridPos.x,
          y: gridPos.y,
          definition: definition,
          getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles,
        };
        tempFurniProto
          .getOccupiedTiles()
          .forEach((tp) => setTileHighlight(tp.x, tp.y, color));
      } else {
        // Fallback if definition somehow invalid: highlight only the hovered tile red
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        );
      }
    } else {
      // Highlight for navigating/selecting within Edit Mode
      const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
      const player = gameState.myAvatarId
        ? gameState.avatars[gameState.myAvatarId]
        : null;
      const canLayoutEdit =
        player?.isAdmin &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;

      if (canLayoutEdit) {
        // Admin painting layout: highlight the single tile under cursor
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        ); // Use red/edit color
      } else if (
        hoveredF &&
        hoveredF.id !== uiState.editMode.selectedFurnitureId
      ) {
        // Highlight furniture being hovered over (if it's not already selected)
        hoveredF
          .getOccupiedTiles()
          .forEach((tp) =>
            setTileHighlight(
              tp.x,
              tp.y,
              CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
            )
          );
      } else if (!hoveredF && gameState.highlightedTile) {
        // Highlight the empty tile being hovered over (only if not admin painting)
        setTileHighlight(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y,
          CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
        );
      }
      // Note: The blue selection outline for the *currently selected* furniture
      // is handled within ClientFurniture.draw based on its `isSelected` flag.
    }
  } else {
    // --- Navigate Mode Highlighting ---
    const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
    // Highlight interactive furniture (doors, chairs, usable items)
    if (
      hoveredF &&
      (hoveredF.isDoor ||
        hoveredF.definition?.canUse ||
        hoveredF.definition?.canSit)
    ) {
      hoveredF
        .getOccupiedTiles()
        .forEach((tp) =>
          setTileHighlight(
            tp.x,
            tp.y,
            CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
          )
        );
    } else if (
      gameState.highlightedTile &&
      isClientWalkable(gameState.highlightedTile.x, gameState.highlightedTile.y)
    ) {
      // Highlight walkable floor tile if no interactive furniture is hovered
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      );
    }
  }

  // Final safety check: if highlightedTile somehow became invalid after logic, clear it
  if (
    gameState.highlightedTile &&
    !isValidClientTile(gameState.highlightedTile.x, gameState.highlightedTile.y)
  ) {
    gameState.highlightedTile = null;
  }
}

/** Checks if placing a furniture item at the given coordinates is valid based on client-side state. */
export function isClientPlacementValid(definition, gridX, gridY) {
  if (
    !definition ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.furniture
  ) {
    console.warn(
      "isClientPlacementValid: Missing definition, config, room, or furniture state."
    );
    return false;
  }

  // Simulate the furniture placement to get occupied tiles
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    definition: definition, // Provide definition context
    getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles,
  };
  const occupiedTiles = tempFurniProto.getOccupiedTiles();

  // Check each tile the item would occupy
  for (const tile of occupiedTiles) {
    const gx = tile.x;
    const gy = tile.y;

    // 1. Check Tile Validity (Bounds and Terrain Type)
    if (!isValidClientTile(gx, gy)) return false; // Out of bounds
    const tileType = getTileLayoutType(gx, gy);
    if (tileType === 1 || tileType === "X") return false; // Cannot place on Wall or Hole

    // 2. Stacking/Solid Checks (only if placing a non-flat item)
    if (!definition.isFlat) {
      // Find items currently stacked on this specific tile
      const stackOnThisTile = Object.values(gameState.furniture).filter(
        (f) =>
          f instanceof ClientFurniture &&
          Math.round(f.visualX) === gx &&
          Math.round(f.visualY) === gy
      );
      // Find the visually topmost item on this tile
      const topItemOnThisTile = stackOnThisTile.sort(
        (a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0)
      )[0];

      // Check if the top item prevents stacking
      if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable)
        return false;

      // Check if a solid item blocks this tile (redundant if top item check works, but safer)
      if (isClientOccupiedBySolid(gx, gy)) {
        // Further check if the solid item is the one we might be stacking on (which is okay if it's stackable)
        const solidBlocker = stackOnThisTile.find(
          (f) => !f.definition?.isWalkable && !f.definition?.isFlat
        );
        if (solidBlocker && !solidBlocker.definition?.stackable) return false; // Blocked by non-stackable solid
      }
    }
  }

  // 3. Base Tile Stacking Check (specifically for the item's base tile at gridX, gridY, if non-flat)
  if (!definition.isFlat) {
    const baseStack = Object.values(gameState.furniture).filter(
      (f) =>
        f instanceof ClientFurniture &&
        Math.round(f.visualX) === gridX &&
        Math.round(f.visualY) === gridY
    );
    const topItemOnBase = baseStack.sort(
      (a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0)
    )[0];
    // Can only place on the base tile if the top item there is stackable
    if (topItemOnBase && !topItemOnBase.definition?.stackable) return false;
  }

  // 4. Height Limit Check
  // Calculate the Z position where the new item's base would be placed
  const estimatedBaseZ = getClientStackHeightAt(gridX, gridY);
  // Add the item's own offset (if any)
  const itemBaseZ = estimatedBaseZ + (definition.zOffset || 0);
  // Calculate the top surface Z of the new item
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = itemBaseZ + (definition.isFlat ? 0 : itemStackContrib);

  // Compare the *top* of the item against the max stack height
  // Using a small tolerance (epsilon) for floating point comparisons
  const epsilon = 0.001;
  if (itemTopZ >= (SHARED_CONFIG.MAX_STACK_Z || 5.0) - epsilon) return false; // Use default if MAX_STACK_Z missing

  return true; // All checks passed
}

/** Sets the highlight overlay color for a specific tile. */
function setTileHighlight(x, y, color) {
  // Find the ClientTile instance corresponding to the coordinates
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  // If found, set its highlight property
  if (tile) {
    tile.highlight = color;
  }
}

/** Clears all tile highlights. Furniture selection visuals are handled elsewhere. */
function clearAllHighlights() {
  if (!gameState.clientTiles) return;
  // Iterate through all client tiles and set their highlight to null
  gameState.clientTiles.forEach((t) => (t.highlight = null));
}

// --- Helper & Calculation Functions ---

/** Calculates the effective stack height at a grid coordinate based on client-side visual state. */
export function getClientStackHeightAt(gridX, gridY) {
  if (!SHARED_CONFIG || !gameState.currentRoomId || !gameState.furniture)
    return 0;
  const gx = Math.round(gridX);
  const gy = Math.round(gridY);

  // Find all furniture items visually located at the target grid coordinates
  const stack = Object.values(gameState.furniture).filter(
    (f) =>
      f instanceof ClientFurniture &&
      Math.round(f.visualX) === gx &&
      Math.round(f.visualY) === gy
  );

  let highestStackableTopZ = 0.0; // Initialize to ground level

  stack.forEach((furni) => {
    // Ensure furniture and its definition are valid
    if (!furni.definition) return;

    // Calculate the height contribution of this item if it were stacked upon
    const itemStackHeight =
      furni.definition.stackHeight ?? (furni.definition.isFlat ? 0 : 1.0);
    const itemStackContrib =
      itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);

    // Calculate the Z coordinate of the top surface of this item
    // If flat, top surface is same as base Z. If not flat, add stack contribution.
    const itemTopSurfaceZ =
      (furni.visualZ ?? 0) + (furni.definition.isFlat ? 0 : itemStackContrib);

    // If this item allows other items to be stacked on top of it...
    if (furni.definition.stackable) {
      // Update the highest point where an item could be placed
      highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
    }
  });

  // Return the highest Z level found that allows stacking, clamped to non-negative.
  return Math.max(0, highestStackableTopZ);
}

/** Checks if a tile coordinate is within the current room's bounds. */
export function isValidClientTile(x, y) {
  return (
    gameState.currentRoomId != null &&
    gameState.roomCols > 0 &&
    gameState.roomRows > 0 &&
    x >= 0 &&
    x < gameState.roomCols &&
    y >= 0 &&
    y < gameState.roomRows
  );
}

/** Gets the layout type (0, 1, 2, 'X') for a given tile coordinate. */
export function getTileLayoutType(x, y) {
  // Check bounds first
  if (!isValidClientTile(x, y) || !gameState.roomLayout) return null;
  // Check row bounds
  if (y < 0 || y >= gameState.roomLayout.length) return null;
  const row = gameState.roomLayout[y];
  // Check column bounds and return type (default to 0/floor if undefined)
  if (!row || x < 0 || x >= row.length) return null; // Should be caught by isValidClientTile but safer
  return row[x] ?? 0; // Default to floor if type is missing/null/undefined
}

/** Checks if a tile is walkable based on terrain and furniture presence. */
export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  // 1. Check if tile is valid and has walkable terrain type
  if (!isValidClientTile(gx, gy)) return false;
  const layoutType = getTileLayoutType(gx, gy);
  if (layoutType !== 0 && layoutType !== 2) return false; // Must be Floor or AltFloor

  // 2. Check if tile is occupied by solid furniture
  return !isClientOccupiedBySolid(gx, gy);
}

/** Checks if a tile is occupied by a solid (non-walkable, non-flat) furniture item. */
export function isClientOccupiedBySolid(gridX, gridY) {
  if (!gameState.furniture) return false; // No furniture state available

  // Iterate through all furniture items in the current room state
  return Object.values(gameState.furniture || {}).some((f) => {
    // Ensure it's a valid furniture object with a definition
    if (!(f instanceof ClientFurniture) || !f.definition) return false;

    // Determine if the furniture item is considered "solid"
    const def = f.definition;
    const isSolid = !def.isWalkable && !def.isFlat;
    if (!isSolid) return false; // Skip if walkable or flat

    // Ensure the furniture object has the method to get its occupied tiles
    if (typeof f.getOccupiedTiles !== "function") return false;

    // Check if any of the tiles occupied by this solid furniture match the target grid coordinates
    return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
  });
}

// --- Camera Controls ---

/** Pans the camera by the given screen pixel amounts. */
export function moveCamera(dx, dy) {
  if (!camera) {
    console.warn("moveCamera: Camera state not available.");
    return;
  }
  camera.x += dx;
  camera.y += dy;
  // No immediate redraw needed, game loop handles rendering
}

/** Zooms the camera by a factor, keeping a pivot point stationary on screen. */
export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) {
    console.warn("changeZoom: Prereqs not met (canvas, config, camera).");
    return;
  }
  // Use provided pivot or default to canvas center
  const pivotScreenX = pivotX ?? uiState.canvas.width / 2;
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;

  // Store world coordinates of the pivot point BEFORE zooming
  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY);

  // Calculate and apply the new zoom level, clamped within limits
  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );
  if (Math.abs(newZoom - oldZoom) < 0.001) return; // Avoid tiny changes/infinite loops
  camera.zoom = newZoom;

  // Calculate where the original world pivot point appears on screen AFTER zooming
  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );

  // Adjust camera pan (camera.x, camera.y) to counteract the shift caused by zooming,
  // effectively keeping the world point under the pivot stationary on screen.
  camera.x -= screenPosAfterZoomOnly.x - pivotScreenX;
  camera.y -= screenPosAfterZoomOnly.y - pivotScreenY;
  // No immediate redraw needed, game loop handles rendering
}

/** Centers the camera view on the current room's approximate center. */
export function centerCameraOnRoom() {
  // Ensure all necessary components are available
  if (
    !uiState.canvas ||
    !camera ||
    !gameState ||
    !SHARED_CONFIG ||
    gameState.roomCols <= 0 ||
    gameState.roomRows <= 0
  ) {
    console.warn(
      "centerCameraOnRoom: Prereqs not met (canvas, camera, gameState, room dimensions)."
    );
    return;
  }
  try {
    // Calculate the world coordinates of the room's center
    const centerX = gameState.roomCols / 2;
    const centerY = gameState.roomRows / 2;
    // Convert world center to base isometric screen coordinates (without pan/zoom)
    const centerIso = worldToIso(centerX, centerY);

    // Adjust camera pan (camera.x, camera.y) to position the room's
    // isometric center point at the center of the canvas viewport.
    // We subtract the zoomed iso coords from the canvas center.
    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
    // Optionally adjust vertical centering (e.g., center vertically or slightly above center)
    // Centering slightly above center (using 1/3rd):
    camera.y = uiState.canvas.height / 3 - centerIso.y * camera.zoom;

    console.log(
      `Camera centered on room ${
        gameState.currentRoomId || "N/A"
      }. New pos: (${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})`
    );
  } catch (e) {
    console.error("Error calculating camera center:", e);
  }
}

// --- Cursor ---

/** Updates the game container's cursor style based on current interaction mode. */
export function updateUICursor() {
  if (!uiState.gameContainer || !inputState) return;

  // Remove potentially conflicting classes first
  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = ""; // Reset to default (likely 'grab' from CSS)

  if (inputState.isDragging) {
    // Apply dragging cursor ('grabbing')
    uiState.gameContainer.classList.add("dragging");
  } else if (uiState.isEditMode) {
    // Apply edit mode cursor ('crosshair')
    uiState.gameContainer.classList.add("edit-mode-cursor");
  }
  // Default cursor ('grab') is applied via CSS if no specific class is set
}

// --- Object Picking ---

/** Finds the topmost avatar at a given screen coordinate. */
export function getAvatarAtScreen(screenX, screenY) {
  // Filter potential candidates: must be ClientAvatar instances and contain the point
  const candidates = Object.values(gameState.avatars || {}).filter(
    (a) =>
      a instanceof ClientAvatar &&
      typeof a.containsPoint === "function" &&
      a.containsPoint(screenX, screenY)
  );

  if (candidates.length === 0) return null; // No avatar found at this point

  // If multiple avatars overlap (unlikely but possible), sort by draw order (higher Y/X/Z first)
  // and return the one that would be drawn last (topmost visually)
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0];
}

/** Finds the topmost furniture item at a given screen coordinate using approximate bounds checking. */
export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture || !CLIENT_CONFIG)
    return null; // Check prerequisites

  // Filter candidates: must be ClientFurniture with a definition and approximate bounds must contain the point
  const candidates = Object.values(gameState.furniture || {}).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false; // Basic validation

    // Calculate approximate screen bounding box (simplified logic from ClientFurniture.draw)
    const screenPos = getScreenPos(f.visualX, f.visualY);
    const zoom = camera.zoom;
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) * zoom * 1.1; // Approx width
    // Approx height calculation
    const visualHeightFactor = f.definition.isFlat
      ? 0.1
      : f.definition.stackHeight != null // Use defined stackHeight if available
      ? f.definition.stackHeight * 1.5
      : 1.0; // Default height factor
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom;
    // Z offset calculation
    const visualZFactor =
      CLIENT_CONFIG.VISUAL_Z_FACTOR || SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5; // Use default if config missing
    const zOffsetPx = (f.visualZ || 0) * visualZFactor * zoom;

    // Calculate bounding box coordinates
    const drawTopY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawBottomY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx; // Base Y + half tile height
    const drawLeftX = screenPos.x - baseDrawWidth / 2;
    const drawRightX = screenPos.x + baseDrawWidth / 2;

    // Check if the screen point falls within these approximate bounds
    return (
      screenX >= drawLeftX &&
      screenX <= drawRightX &&
      screenY >= drawTopY &&
      screenY <= drawBottomY
    );
  });

  if (candidates.length === 0) return null; // No furniture found

  // Sort candidates by draw order (descending) to find the topmost visually
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0]; // Return the first item after sorting (highest drawOrder)
}
