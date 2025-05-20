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
  escapeHtml, // <-- Ensure escapeHtml is imported
  debounce,
  rotateDirection, // Needed for rotating placement ghost
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
  requestChangeRoom,
  requestMove,
  requestPlaceFurni,
  requestPublicRooms,
  requestInteract, // <-- Import NPC interaction
  // Trade Network Functions
  requestTradeInitiate,
  respondToTradeRequest,
  updateTradeOffer,
  confirmTradeOffer,
  cancelTrade,
} from "./network.js";
// sounds.js provides audio feedback
import { playSound } from "./sounds.js";
// gameObject classes for type checking and method borrowing
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientTile } from "./gameObjects/ClientTile.js";
import { ClientNPC } from "./gameObjects/ClientNPC.js"; // <-- Import ClientNPC
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
      let stateKey = key.substring(0, key.length - 3);
      let camelCaseKey = stateKey
        .toLowerCase()
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase());

      // Specific key mappings
      const keyMappings = {
        chatLog: "chatLogDiv",
        inventoryItems: "inventoryItemsDiv",
        shopItems: "shopItemsDiv",
        recolorSwatches: "recolorSwatchesDiv",
        recolorItemName: "recolorItemNameP",
        playerCurrency: "currencyDisplay",
        userListContent: "userListContent",
        roomsListContent: "roomsListContent",
        adminRoomList: "adminRoomListDiv",
        adminLayoutTileType: "layoutTileTypeSelector",
        debugDiv: "debugDiv",
        notificationContainer: "notificationContainer",
        // Trade Panel Mappings
        tradePartnerName: "tradePartnerNameSpan",
        tradePartnerNameDisplay: "tradePartnerNameDisplaySpan",
        selfTradeOffer: "selfTradeOfferDiv",
        partnerTradeOffer: "partnerTradeOfferDiv",
        selfTradeCurrency: "selfTradeCurrencyInput",
        partnerTradeCurrency: "partnerTradeCurrencyInput",
        tradeInventoryArea: "tradeInventoryAreaDiv",
        selfTradeStatus: "selfTradeStatusSpan",
        partnerTradeStatus: "partnerTradeStatusSpan",
        tradeConfirm: "tradeConfirmBtn",
        tradeCancel: "tradeCancelBtn",
        tradeClose: "tradeCloseBtn",
      };
      if (keyMappings[camelCaseKey]) {
        camelCaseKey = keyMappings[camelCaseKey];
      }

      const foundElement = document.getElementById(elementId);

      if (uiState.hasOwnProperty(camelCaseKey)) {
        uiState[camelCaseKey] = foundElement;
        if (!foundElement) {
          const criticalElements = [
            "canvas",
            "gameContainer",
            "chatLogDiv",
            "inventoryItemsDiv",
            "currencyDisplay",
            "loadingOverlay",
            "loadingMessage",
            "bottomBar",
            "contextMenu",
            "roomsListContent",
            "notificationContainer",
            "tradePanel", // Add other critical trade elements if needed
          ];
          if (criticalElements.includes(camelCaseKey)) {
            console.error(
              `CRITICAL UI element missing: ${camelCaseKey} (#${elementId})`
            );
            allElementsFound = false;
          } else {
            // Log warnings for non-critical missing elements (can be noisy)
            // console.warn(`UI element not found: ${camelCaseKey} (#${elementId})`);
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
    allElementsFound = false; // Canvas is critical
  }

  // --- Attach Listeners specific to UIManager ---
  // Close buttons for toggled panels
  document.querySelectorAll(".close-panel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelId = btn.dataset.panelId;
      if (panelId) {
        let suffix = panelId.replace("-panel", "");
        let camelCaseSuffix = suffix.replace(/-([a-z])/g, (g) =>
          g[1].toUpperCase()
        );
        togglePanel(camelCaseSuffix, false); // Close the panel
      }
    });
  });

  // Context menu interaction
  if (uiState.contextMenu) {
    uiState.contextMenu.addEventListener("click", handleContextMenuClick);
    document.addEventListener(
      "click",
      (event) => {
        // Close on outside click
        if (
          uiState.contextMenu?.style.display !== "none" &&
          !uiState.contextMenu.contains(event.target)
        ) {
          hideContextMenu();
        }
      },
      true
    ); // Use capture phase
  } else {
    console.error("Context menu element not found during init!");
    allElementsFound = false;
  }

  // Admin panel specific listeners
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
    // Initialize selectedLayoutPaintType based on initial state
    const initialChecked = uiState.layoutTileTypeSelector.querySelector(
      'input[name="layout-paint-type"]:checked'
    );
    if (initialChecked) {
      selectedLayoutPaintType =
        initialChecked.value === "X" ? "X" : parseInt(initialChecked.value, 10);
    } else {
      // Default to floor if none checked initially
      selectedLayoutPaintType = 0;
      const defaultRadio = uiState.layoutTileTypeSelector.querySelector(
        'input[name="layout-paint-type"][value="0"]'
      );
      if (defaultRadio) defaultRadio.checked = true;
    }
  } else {
    console.warn("Admin layout tile type selector not found.");
  }

  // Trade panel button/input listeners
  if (uiState.tradeCloseBtn) {
    uiState.tradeCloseBtn.addEventListener("click", () => {
      if (uiState.isTrading && uiState.tradeSession.tradeId) {
        cancelTrade(uiState.tradeSession.tradeId);
      }
      hideTradePanel();
    });
  }
  if (uiState.tradeCancelBtn) {
    uiState.tradeCancelBtn.addEventListener("click", () => {
      if (uiState.isTrading && uiState.tradeSession.tradeId) {
        cancelTrade(uiState.tradeSession.tradeId);
      }
      hideTradePanel();
    });
  }
  if (uiState.tradeConfirmBtn) {
    uiState.tradeConfirmBtn.addEventListener("click", () => {
      if (
        uiState.isTrading &&
        uiState.tradeSession.tradeId &&
        !uiState.tradeSession.myConfirmed
      ) {
        confirmTradeOffer(uiState.tradeSession.tradeId);
        // Optionally disable button immediately
        // uiState.tradeConfirmBtn.disabled = true;
      }
    });
  }
  if (uiState.selfTradeCurrencyInput) {
    // Use debounce to avoid spamming updates on every keystroke
    uiState.selfTradeCurrencyInput.addEventListener(
      "input",
      debouncedUpdateOffer
    );
  }

  // Check for notification container
  if (!uiState.notificationContainer) {
    console.error("CRITICAL UI element missing: Notification Container");
    allElementsFound = false;
  }

  // Initialize admin UI state
  updateAdminUI();

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
    uiState.loadingOverlay.style.display = "flex"; // Ensure display is correct
  } else if (CLIENT_CONFIG) {
    // Avoid warning before config loads
    console.warn("showLoadingOverlay called but loading elements not found.");
  }
}

/** Hides the loading overlay smoothly. */
export function hideLoadingOverlay() {
  if (uiState.loadingOverlay) {
    uiState.loadingOverlay.classList.add("hidden");
    // Use transitionend event for more reliable display:none after fade
    uiState.loadingOverlay.addEventListener(
      "transitionend",
      () => {
        if (uiState.loadingOverlay?.classList.contains("hidden")) {
          // Check if still hidden
          uiState.loadingOverlay.style.display = "none";
        }
      },
      { once: true }
    ); // Listener fires only once
  }
}

/** Toggles the visibility of a side/bottom panel. */
export function togglePanel(panelIdSuffix, forceState = undefined) {
  // Map suffix to the correct key in uiState
  const panelKeyMap = {
    inventory: "inventoryPanel",
    rooms: "roomsPanel",
    userList: "userListPanel",
    shop: "shopPanel",
    edit: null, // Edit isn't a panel, handled by toggleEditMode
    admin: "adminPanel",
    debug: "debugPanel",
  };
  const buttonKeyMap = {
    inventory: "toggleInventoryBtn",
    rooms: "toggleRoomsBtn",
    userList: "toggleUsersBtn",
    shop: "toggleShopBtn",
    edit: "toggleEditBottomBtn", // Edit button targets edit mode, not a panel
    admin: "toggleAdminBtn",
    debug: "toggleDebugBtn",
  };

  const panelKey = panelKeyMap[panelIdSuffix];
  const buttonKey = buttonKeyMap[panelIdSuffix];

  // Special case for edit button
  if (panelIdSuffix === "edit") {
    toggleEditMode(); // Delegate to specific edit mode toggle function
    return;
  }

  if (!panelKey) {
    console.warn(`Unknown panel suffix: ${panelIdSuffix}`);
    return;
  }

  const panel = uiState[panelKey];
  const button = uiState[buttonKey];

  if (!panel) {
    console.warn(`Panel element not found for key: ${panelKey}`);
    return;
  }

  const shouldBeOpen =
    forceState !== undefined ? forceState : panel.style.display === "none";

  // Close other panels if opening a new one
  if (
    shouldBeOpen &&
    uiState.activePanelId != null &&
    uiState.activePanelId !== panelIdSuffix
  ) {
    togglePanel(uiState.activePanelId, false); // Close the currently active panel
  }

  // Toggle display and active class on button
  panel.style.display = shouldBeOpen ? "flex" : "none";
  if (button) {
    button.classList.toggle("active", shouldBeOpen);
  } else {
    console.warn(`Toggle button not found for key: ${buttonKey}`);
  }

  // Update active panel tracking
  uiState.activePanelId = shouldBeOpen ? panelIdSuffix : null;

  // Populate content if opening
  if (shouldBeOpen) {
    if (panelIdSuffix === "inventory") populateInventory();
    else if (panelIdSuffix === "shop") populateShopPanel();
    else if (panelIdSuffix === "admin") requestAllRoomIds();
    else if (panelIdSuffix === "rooms") {
      if (isConnected()) requestPublicRooms();
      else if (uiState.roomsListContent)
        uiState.roomsListContent.innerHTML = "<p><i>Not connected.</i></p>";
    } else if (panelIdSuffix === "debug") updateDebugInfo();
    // User list is populated by network event 'user_list_update'
  }

  hideContextMenu(); // Hide context menu when toggling panels
}

/** Resets UI elements to their default/loading state. */
export function resetUIState() {
  console.log("Resetting UI State...");
  showLoadingOverlay("Loading Room...");

  // Close any open panel
  if (uiState.activePanelId != null) {
    togglePanel(uiState.activePanelId, false);
  }
  uiState.activePanelId = null;

  // Clear dynamic content areas
  if (uiState.chatLogDiv) uiState.chatLogDiv.innerHTML = "";
  uiState.chatMessages = []; // Clear chat message references
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
    uiState.roomsListContent.innerHTML = "<p><i>...</i></p>";

  // Hide floating panels
  hideProfilePanel();
  hideRecolorPanel();
  hideTradePanel(); // Hide trade panel on reset

  // Reset header/title
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Loading...";
  if (uiState.currencyDisplay)
    uiState.currencyDisplay.textContent = "Silly Coins: ...";
  document.title = "ZanyTown - Loading...";

  // Reset edit mode state
  uiState.isEditMode = false;
  if (CLIENT_CONFIG) uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  else uiState.editMode.state = "navigate"; // Fallback
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;
  // For furniture dragging
  uiState.editMode.draggedFurnitureId = null;
  uiState.editMode.dragStartX = 0;
  uiState.editMode.dragStartY = 0;
  uiState.editMode.dragOriginalZ = 0;

  // Update UI related to edit mode
  updateInventorySelection();
  updateUICursor();
  hideContextMenu();

  // Disable buttons
  if (uiState.toggleEditBottomBtn) {
    uiState.toggleEditBottomBtn.classList.remove("active");
    uiState.toggleEditBottomBtn.disabled = true;
  }
  if (uiState.toggleShopBtn) uiState.toggleShopBtn.disabled = true;
  if (uiState.toggleAdminBtn) uiState.toggleAdminBtn.disabled = true;
  if (uiState.toggleRoomsBtn) uiState.toggleRoomsBtn.disabled = true;
  if (uiState.toggleInventoryBtn) uiState.toggleInventoryBtn.disabled = true;
  if (uiState.toggleUsersBtn) uiState.toggleUsersBtn.disabled = true;
  if (uiState.toggleDebugBtn) uiState.toggleDebugBtn.disabled = true;

  // Update admin UI visibility
  updateAdminUI();
}

// --- Chat & Bubble Management ---

/** Adds a message to the chat log UI, escaping HTML. */
export function logChatMessage(message, isSelf = false, className = "") {
  if (!uiState.chatLogDiv || !CLIENT_CONFIG || typeof message !== "string")
    return;

  const p = document.createElement("p");
  p.textContent = message; // Use textContent to prevent HTML injection by default
  if (isSelf) p.classList.add("self-msg");
  if (className) {
    className.split(" ").forEach((cls) => {
      if (cls) p.classList.add(cls.trim());
    });
  }

  const div = uiState.chatLogDiv;
  const isScrolledToBottom =
    Math.abs(div.scrollHeight - div.clientHeight - div.scrollTop) < 5; // Check BEFORE adding

  div.appendChild(p);
  uiState.chatMessages.push(p); // Store reference for cleanup

  // Limit chat log length
  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    const oldMessage = uiState.chatMessages.shift();
    oldMessage?.remove();
  }

  // Auto-scroll if user was at the bottom
  if (isScrolledToBottom) {
    // Use setTimeout to ensure scroll happens after DOM update
    setTimeout(() => {
      div.scrollTop = div.scrollHeight;
    }, 0);
  }
}

/** Updates positions of active chat bubbles and removes expired ones. */
export function updateChatBubbles(currentTime) {
  if (!uiState.bubbleContainer || !CLIENT_CONFIG) return;

  for (let i = uiState.activeChatBubbles.length - 1; i >= 0; i--) {
    const bubble = uiState.activeChatBubbles[i];
    if (!bubble || typeof bubble !== "object") {
      uiState.activeChatBubbles.splice(i, 1); // Remove invalid entries
      continue;
    }

    if (currentTime > bubble.endTime) {
      // Bubble expired
      bubble.element?.remove();
      uiState.activeChatBubbles.splice(i, 1);
      // Clear reference on the owner object if it still matches
      const owner =
        gameState.avatars[bubble.avatarId] || gameState.npcs[bubble.avatarId];
      if (owner && owner.chatBubble?.id === bubble.id) {
        owner.chatBubble = null;
      }
    } else {
      // Update position for active bubble
      updateChatBubblePosition(bubble);
    }
  }
}

/** Creates or updates the position of a single chat bubble element. */
function updateChatBubblePosition(bubble) {
  if (
    !bubble ||
    !uiState.bubbleContainer ||
    !bubble.avatarId ||
    !SHARED_CONFIG ||
    !CLIENT_CONFIG ||
    !camera
  )
    return;

  // Find the owner (could be avatar or NPC)
  const owner =
    gameState.avatars[bubble.avatarId] || gameState.npcs[bubble.avatarId];

  if (!owner) {
    bubble.element?.remove(); // Remove bubble if owner is gone
    bubble.endTime = 0; // Mark for removal in main loop
    return;
  }

  // Create element if it doesn't exist
  if (!bubble.element) {
    bubble.element = document.createElement("div");
    bubble.element.id = bubble.id;
    bubble.element.className = "chat-bubble";
    // Apply NPC specific class if needed
    if (owner instanceof ClientNPC) {
      bubble.element.classList.add("npc-bubble"); // Add custom class
      // Example: Change bubble style for NPCs
      // bubble.element.style.backgroundColor = 'rgba(200, 220, 255, 0.95)';
      // bubble.element.style.borderColor = '#6699FF';
      // bubble.element.style.borderRadius = '20px 5px 20px 20px'; // Different shape?
    }
    bubble.element.textContent = bubble.text; // Use textContent for safety
    uiState.bubbleContainer.appendChild(bubble.element);
  }

  // Calculate position based on owner's visual state
  const screenPos = getScreenPos(owner.visualX, owner.visualY);
  const zoom = camera.zoom;
  const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
  const headHeight = totalHeight * 0.3;
  const zOffsetPx = owner.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
  const baseY =
    screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx;
  const bodyY = baseY - totalHeight * 0.7;
  const headTopY = bodyY - headHeight;
  const verticalOffsetAboveHead = 15 * zoom; // Offset above the calculated head top

  // Update transform for positioning
  if (bubble.element) {
    bubble.element.style.transform = `translate(-50%, calc(-100% - ${verticalOffsetAboveHead}px)) translate(${screenPos.x}px, ${headTopY}px)`;
  }
}

// --- Debug Info ---

/** Updates the content of the debug information panel. */
export function updateDebugInfo() {
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
  const npcCount = Object.keys(gameState.npcs || {}).length; // <-- Added NPC Count
  const inventoryCount = Object.values(gameState.inventory || {}).reduce(
    (s, q) => s + q,
    0
  );
  const currentRoom = gameState.currentRoomId || "N/A";
  const isAdmin = player?.isAdmin || false;

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
    if (isAdmin && uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE)
      editDetails += ` Paint: ${selectedLayoutPaintType}`;
  }

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
    const stackHeight = getClientStackHeightAt(ht.x, ht.y); // Function needs to exist or be implemented
    tileInfo = ` Tile(${ht.x},${ht.y}) L:${tLayout ?? "?"} ${
      topFurni
        ? `Top:${escapeHtml(
            topFurni.definition?.name || "?"
          )}(Z:${topFurni.visualZ.toFixed(2)}) `
        : ""
    }StackZ:${stackHeight.toFixed(2)}`;
  }

  // Use textContent for safety, construct string with HTML breaks
  uiState.debugDiv.textContent =
    `Room: ${escapeHtml(currentRoom)} | Player: (${pGrid.x},${
      pGrid.y
    }) St:${pState} Dir:${pDir}\n` +
    `Mouse: (${mGrid.x},${mGrid.y})${tileInfo}\n` +
    `Cam: (${camera.x.toFixed(0)},${camera.y.toFixed(
      0
    )}) Zoom:${camera.zoom.toFixed(2)}\n` +
    `Edit: ${editDetails}\n` +
    `Inv: ${inventoryCount} | Coins: ${gameState.myCurrency} | Admin:${
      isAdmin ? "Y" : "N"
    }\n` +
    `Objs:${furniCount}|Avs:${avatarCount}|NPCs:${npcCount}|Bub:${
      uiState.activeChatBubbles.length
    }|Sock:${isConnected() ? "OK" : "DOWN"}`;
}

// --- Inventory & Shop UI ---

/** Populates the inventory UI panel, escaping item names. */
export function populateInventory() {
  if (!uiState.inventoryItemsDiv || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    if (uiState.inventoryItemsDiv)
      uiState.inventoryItemsDiv.innerHTML =
        "<p><i>Error loading inventory.</i></p>";
    return;
  }

  uiState.inventoryItemsDiv.innerHTML = ""; // Clear existing items
  const inventory = gameState.inventory || {};
  const ownedItemIds = Object.keys(inventory).filter((id) => inventory[id] > 0);

  if (ownedItemIds.length === 0) {
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
    // Clear placement selection if item is gone
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

  // Create elements for each item
  ownedItemIds.forEach((itemId) => {
    const quantity = inventory[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (!def) return; // Skip if definition not found

    const itemDiv = document.createElement("div");
    itemDiv.className = "inventory-item";
    itemDiv.dataset.itemId = def.id;

    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = def.color || "#8B4513"; // Use default color if needed
    itemDiv.appendChild(previewSpan);

    // Use textContent for name and quantity to prevent HTML injection
    const textNode = document.createTextNode(
      ` ${escapeHtml(def.name)} (x${quantity})`
    );
    itemDiv.appendChild(textNode);

    // Set title attribute safely
    itemDiv.title = `${escapeHtml(def.name)} (${def.width}x${def.height})${
      def.canSit ? " (Sit)" : ""
    }${def.stackable ? " (Stack)" : ""}${def.canUse ? " (Use)" : ""}${
      def.canRecolor ? " (Recolor)" : ""
    }`;

    // Add click listener
    itemDiv.addEventListener("click", () => {
      if (uiState.isEditMode) {
        setSelectedInventoryItem(def.id); // Set selection
        playSound("select"); // Play feedback sound
      } else {
        // Feedback if not in edit mode
        itemDiv.classList.add("flash-red");
        setTimeout(() => itemDiv.classList.remove("flash-red"), 600);
        showNotification("Enable 'Edit' mode to place items!", "info");
      }
    });

    uiState.inventoryItemsDiv.appendChild(itemDiv);
  });

  updateInventorySelection(); // Update visual selection state
}

/** Updates visual selection in the inventory UI. */
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

/** Updates the player currency display, with visual feedback on change. */
export function updateCurrencyDisplay() {
  if (!uiState.currencyDisplay) {
    console.warn("Currency display element not found.");
    return;
  }

  const currentText = uiState.currencyDisplay.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)?.[0] || "0"; // Safer matching
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency || 0; // Default to 0 if undefined

  uiState.currencyDisplay.textContent = `Silly Coins: ${newValue}`; // Use textContent

  // Flash animation on change, prevent re-flashing immediately
  if (
    !isNaN(oldValue) &&
    newValue !== oldValue &&
    !uiState.currencyDisplay.classList.contains("flash-green") &&
    !uiState.currencyDisplay.classList.contains("flash-red")
  ) {
    const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
    uiState.currencyDisplay.classList.add(changeClass);
    setTimeout(() => {
      uiState.currencyDisplay?.classList.remove(changeClass);
    }, 600); // Match animation duration
  }
}

/** Populates the shop panel UI, escaping item names. */
function populateShopPanel() {
  if (
    !uiState.shopItemsDiv ||
    !SHARED_CONFIG?.SHOP_CATALOG ||
    !SHARED_CONFIG?.FURNITURE_DEFINITIONS
  ) {
    if (uiState.shopItemsDiv)
      uiState.shopItemsDiv.innerHTML = "<p><i>Error loading shop.</i></p>";
    return;
  }

  uiState.shopItemsDiv.innerHTML = ""; // Clear existing items

  if (
    !Array.isArray(SHARED_CONFIG.SHOP_CATALOG) ||
    SHARED_CONFIG.SHOP_CATALOG.length === 0
  ) {
    uiState.shopItemsDiv.innerHTML =
      "<p><i>Shop is empty! Come back later!</i></p>";
    return;
  }

  // Sort catalog by item name, then price
  const sortedCatalog = [...SHARED_CONFIG.SHOP_CATALOG].sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === a.itemId
    );
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === b.itemId
    );
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
    if (!definition) return; // Skip if definition is missing

    const itemDiv = document.createElement("div");
    itemDiv.className = "shop-item";

    // Item Info (Preview + Name)
    const infoDiv = document.createElement("div");
    infoDiv.className = "shop-item-info";
    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = definition.color || "#8B4513";
    infoDiv.appendChild(previewSpan);
    const nameSpan = document.createElement("span");
    nameSpan.className = "shop-item-name";
    nameSpan.textContent = escapeHtml(definition.name || shopEntry.itemId); // Escape name
    nameSpan.title = `${escapeHtml(definition.name)} (${definition.width}x${
      definition.height
    })`; // Escape title
    infoDiv.appendChild(nameSpan);
    itemDiv.appendChild(infoDiv);

    // Price
    const priceSpan = document.createElement("span");
    priceSpan.className = "shop-item-price";
    priceSpan.textContent = `${shopEntry.price} Coins`; // Price is not user input
    itemDiv.appendChild(priceSpan);

    // Buy Button
    const buyButton = document.createElement("button");
    buyButton.className = "buy-btn";
    buyButton.textContent = "Buy";
    buyButton.dataset.itemId = shopEntry.itemId;
    buyButton.dataset.price = shopEntry.price;
    buyButton.addEventListener("click", () => {
      if (!isConnected()) {
        showNotification("Not connected.", "error");
        return;
      }
      buyButton.disabled = true; // Disable immediately
      buyButton.textContent = "Buying...";
      requestBuyItem(shopEntry.itemId); // Send buy request
      // Re-enable button state handled by updateShopButtonStates after currency/inv update
    });
    itemDiv.appendChild(buyButton);

    uiState.shopItemsDiv.appendChild(itemDiv);
  });

  updateShopButtonStates(); // Set initial button states
}

/** Updates the enabled state of shop buy buttons based on current currency. */
export function updateShopButtonStates() {
  if (!uiState.shopItemsDiv) return;
  uiState.shopItemsDiv.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = (gameState.myCurrency || 0) >= price;
      button.disabled = !canAfford;
      button.classList.toggle("cannot-afford", !canAfford);
      // Reset text if it was "Buying..."
      if (button.textContent === "Buying...") {
        button.textContent = "Buy";
      }
    } else {
      button.disabled = true; // Disable if price is invalid
    }
  });
}

// --- User List & Profile UI ---

/** Populates the user list panel, escaping names. */
export function updateUserListPanel(users) {
  if (!uiState.userListContent || !uiState.userListPanel) return;

  uiState.userListContent.innerHTML = ""; // Clear existing list

  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${escapeHtml(gameState.currentRoomId)})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle; // Use textContent

  if (!users || !Array.isArray(users) || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }

  // Sort users alphabetically
  users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  users.forEach((user) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(user.name || "Unknown"); // Escape name
    const userIdStr = String(user.id); // Ensure ID is string
    li.dataset.userid = userIdStr;
    li.classList.toggle("self-user", userIdStr === gameState.myAvatarId); // Highlight self

    // Add click listener for profiles (if not self)
    if (userIdStr !== gameState.myAvatarId) {
      li.addEventListener("click", () => {
        if (isConnected()) requestProfile(userIdStr);
      });
    } else {
      li.style.cursor = "default"; // No pointer for self
    }

    uiState.userListContent.appendChild(li);
  });
}

/** Displays the profile panel, escaping content. */
export function showProfilePanel(profileData) {
  if (
    !uiState.profilePanel ||
    !uiState.profileContent ||
    !profileData ||
    !profileData.id
  )
    return;

  const name = profileData.name || "Unknown User";
  const id = String(profileData.id); // Ensure ID is string
  const state = profileData.state || "Idle";
  const color = profileData.bodyColor || "#CCCCCC";
  const currency =
    profileData.currency === undefined
      ? "N/A"
      : `${profileData.currency} Coins`; // Currency not user input

  // Use textContent and manual element creation for safety
  uiState.profileContent.innerHTML = ""; // Clear previous content

  const header = document.createElement("h4");
  header.textContent = escapeHtml(name);
  uiState.profileContent.appendChild(header);

  const statusP = document.createElement("p");
  statusP.textContent = `Status: ${escapeHtml(state)}`;
  uiState.profileContent.appendChild(statusP);

  const lookP = document.createElement("p");
  lookP.textContent = "Look: ";
  const swatchSpan = document.createElement("span");
  swatchSpan.className = "profile-color-swatch";
  swatchSpan.style.backgroundColor = escapeHtml(color); // Color is generally safe, but escape anyway
  lookP.appendChild(swatchSpan);
  lookP.appendChild(document.createTextNode(` ${escapeHtml(color)}`));
  uiState.profileContent.appendChild(lookP);

  const coinsP = document.createElement("p");
  coinsP.textContent = `Coins: ${escapeHtml(currency)}`;
  uiState.profileContent.appendChild(coinsP);

  // Placeholder for profile actions (e.g., Add Friend, Trade - handled by context menu now)
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "profile-actions";
  // Add buttons here if needed in the future
  uiState.profileContent.appendChild(actionsDiv);

  uiState.profilePanel.dataset.targetId = id; // Store target ID
  uiState.profilePanel.style.display = "block"; // Show panel
}

/** Hides the profile panel. */
export function hideProfilePanel() {
  if (uiState.profilePanel) {
    uiState.profilePanel.style.display = "none";
    uiState.profilePanel.dataset.targetId = "";
    if (uiState.profileContent) uiState.profileContent.innerHTML = "";
  }
}

// --- Recolor Panel UI ---

/** Displays the recolor panel, escaping item name. */
export function showRecolorPanel(furniId) {
  const furniIdStr = String(furniId); // Ensure string ID
  const furni = gameState.furniture[furniIdStr];

  // Validate prerequisites
  if (
    !uiState.recolorPanel ||
    !uiState.recolorSwatchesDiv ||
    !uiState.recolorItemNameP ||
    !furni ||
    !(furni instanceof ClientFurniture) ||
    !furni.canRecolor ||
    !SHARED_CONFIG?.VALID_RECOLOR_HEX
  ) {
    hideRecolorPanel(); // Ensure panel is hidden if cannot show
    return;
  }

  uiState.activeRecolorFurniId = furniIdStr; // Store active ID
  uiState.recolorItemNameP.textContent = `Item: ${escapeHtml(
    furni.definition?.name || "Unknown"
  )}`; // Escape name

  // Populate color swatches
  uiState.recolorSwatchesDiv.innerHTML = ""; // Clear previous swatches
  SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "recolor-swatch";
    swatch.style.backgroundColor = hex; // Hex colors are generally safe
    swatch.title = hex;
    swatch.dataset.colorHex = hex;
    swatch.addEventListener("click", () => handleRecolorSwatchClick(hex));
    uiState.recolorSwatchesDiv.appendChild(swatch);
  });

  uiState.recolorPanel.style.display = "block"; // Show panel
}

/** Hides the recolor panel. */
export function hideRecolorPanel() {
  if (uiState.recolorPanel) uiState.recolorPanel.style.display = "none";
  uiState.activeRecolorFurniId = null; // Clear active ID
}

/** Handles clicking a color swatch in the recolor panel. */
function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor);
    hideRecolorPanel(); // Close panel after selection
  } else {
    console.warn("Recolor click ignored: No active item or not connected.");
    showNotification("Cannot recolor now.", "error");
    hideRecolorPanel();
  }
}

// --- Admin UI Functions ---

/** Shows or hides admin UI elements based on player status. */
export function updateAdminUI() {
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const isAdmin = player?.isAdmin || false;
  const displayStyle = isAdmin ? "flex" : "none"; // Use flex for button display

  if (uiState.toggleAdminBtn) {
    uiState.toggleAdminBtn.style.display = displayStyle;
    uiState.toggleAdminBtn.disabled = !isAdmin || !isConnected(); // Disable if not admin or not connected
  }

  // Close admin panel if user is no longer admin
  if (!isAdmin && uiState.activePanelId === "admin") {
    togglePanel("admin", false);
  }
}

/** Populates the admin room list, escaping room IDs. */
export function updateAdminRoomList(roomIds) {
  if (!uiState.adminRoomListDiv) return;

  uiState.adminRoomListDiv.innerHTML = ""; // Clear list

  if (!roomIds || !Array.isArray(roomIds) || roomIds.length === 0) {
    uiState.adminRoomListDiv.textContent = "No rooms found."; // Use textContent
    return;
  }

  const ul = document.createElement("ul");
  roomIds.sort(); // Sort room IDs alphabetically

  roomIds.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(id); // Escape room ID for display
    li.title = `Click to join ${escapeHtml(id)}`; // Escape title
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      if (isConnected()) {
        console.log(`Admin joining room via list: ${id}`);
        requestChangeRoom(id); // Request room change
        togglePanel("admin", false); // Close admin panel
      } else {
        showNotification("Not connected.", "error");
      }
    });
    ul.appendChild(li);
  });

  uiState.adminRoomListDiv.appendChild(ul);
}

/** Handles admin create room button click, prompting for input. */
function handleCreateRoomClick() {
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!player?.isAdmin || !isConnected()) {
    showNotification("Admin permissions required.", "error");
    return;
  }

  // Use prompts for simplicity (consider a modal form for better UI)
  const newRoomId = prompt(
    "Enter ID for new room (letters, numbers, underscores):"
  );
  if (!newRoomId || !newRoomId.trim()) {
    if (newRoomId !== null) alert("Room ID cannot be empty."); // Alert only if user didn't cancel
    return;
  }
  // Basic client-side sanitization attempt
  const sanitizedId = newRoomId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .substring(0, 30);
  if (!sanitizedId) {
    alert("Invalid characters in room ID.");
    return;
  }

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
}

// --- Room List Population ---

/** Populates the rooms panel UI, escaping room IDs. */
export function populateRoomsPanel(roomData) {
  if (!uiState.roomsListContent) return;

  uiState.roomsListContent.innerHTML = ""; // Clear list

  if (!Array.isArray(roomData) || roomData.length === 0) {
    uiState.roomsListContent.innerHTML =
      "<p><i>No public rooms available.</i></p>";
    return;
  }

  // Sort rooms by ID
  roomData.sort((a, b) => (a.id || "").localeCompare(b.id || ""));

  roomData.forEach((roomInfo) => {
    const roomDiv = document.createElement("div");
    roomDiv.className = "room-list-item";
    roomDiv.dataset.roomId = roomInfo.id;

    const nameSpan = document.createElement("span");
    nameSpan.className = "room-name";
    nameSpan.textContent = escapeHtml(roomInfo.id); // Escape room ID
    roomDiv.appendChild(nameSpan);

    const countSpan = document.createElement("span");
    countSpan.className = "room-player-count";
    countSpan.textContent = `(${roomInfo.playerCount} ${
      roomInfo.playerCount === 1 ? "User" : "Users"
    })`; // Not user input
    roomDiv.appendChild(countSpan);

    // Highlight and disable click for current room
    if (roomInfo.id === gameState.currentRoomId) {
      roomDiv.classList.add("current-room");
    } else {
      // Add click listener for other rooms
      roomDiv.addEventListener("click", () => {
        if (isConnected()) {
          requestChangeRoom(roomInfo.id); // Request change
          togglePanel("rooms", false); // Close panel
        } else {
          showNotification("Not connected.", "error");
        }
      });
    }
    uiState.roomsListContent.appendChild(roomDiv);
  });
}

// --- Edit Mode State Management ---

/** Sets the current edit mode sub-state and updates UI. */
export function setEditState(newState) {
  if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;

  const oldState = uiState.editMode.state;
  uiState.editMode.state = newState;
  console.log(`Edit state changed from ${oldState} to ${newState}`);

  // Reset specific sub-state properties when leaving a state
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_PLACING &&
    newState !== CLIENT_CONFIG.EDIT_STATE_PLACING
  ) {
    uiState.editMode.placementRotation = 0;
    uiState.editMode.placementValid = false;
    // Optionally clear selected inventory item visual state if leaving placing mode this way
    // setSelectedInventoryItem(null); // Causes issues if clicking floor furniture
  }
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
    newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
    newState !== "dragging_furni" // Don't deselect if transitioning to drag
  ) {
    setSelectedFurniture(null); // Deselect furniture when leaving this state
    hideRecolorPanel(); // Ensure recolor panel is hidden
  }
  // Cleanup when leaving dragging state
  if (oldState === "dragging_furni" && newState !== "dragging_furni") {
    uiState.editMode.draggedFurnitureId = null;
    uiState.editMode.dragStartX = 0;
    uiState.editMode.dragStartY = 0;
    uiState.editMode.dragOriginalZ = 0;
    // Potentially show the original furniture again if it was hidden by renderer
    // This might involve telling the renderer to redraw or unhide.
    // For now, game state itself isn't changing the furniture's actual position.
  }

  // Update UI elements based on the new state
  updateInventorySelection(); // Highlight/unhighlight inventory item
  updateUICursor(); // Change cursor style
  updateHighlights(); // Update tile/furniture highlights
  hideContextMenu(); // Hide context menu on state change
}

// --- Furniture Dragging ---
const EDIT_STATE_DRAGGING_FURNI = "dragging_furni"; // Define state string

/** Initiates dragging for the currently selected furniture. */
export function startDraggingSelectedFurniture(startGridX, startGridY) {
  if (
    !uiState.isEditMode ||
    uiState.editMode.state !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI ||
    !uiState.editMode.selectedFurnitureId
  ) {
    console.error(
      "startDraggingSelectedFurniture: Conditions not met.",
      uiState.editMode.state,
      uiState.editMode.selectedFurnitureId
    );
    return;
  }

  const furniToDrag = gameState.furniture[uiState.editMode.selectedFurnitureId];
  if (!furniToDrag) {
    console.error("startDraggingSelectedFurniture: Selected furniture not found in gameState.");
    setSelectedFurniture(null); // Clear selection if invalid
    return;
  }

  uiState.editMode.draggedFurnitureId = uiState.editMode.selectedFurnitureId;
  uiState.editMode.dragStartX = startGridX;
  uiState.editMode.dragStartY = startGridY;
  uiState.editMode.dragOriginalZ = furniToDrag.z; // Store original Z

  // The selectedFurnitureId remains the same, as it's what we are dragging
  // No need to call setSelectedFurniture() again if it's already selected.

  setEditState(EDIT_STATE_DRAGGING_FURNI); // Transition to dragging state
  playSound("pickup"); // Use pickup sound for now
  console.log(
    `Started dragging ${uiState.editMode.draggedFurnitureId} from (${startGridX},${startGridY})`
  );
  // The renderer will need to know to hide the original furniture piece
  // and draw a ghost based on draggedFurnitureId and current mouse grid pos.
}

/** Cleans up state after furniture dragging is finished. */
export function stopDraggingFurniture() {
  console.log(
    `Stopping drag for ${uiState.editMode.draggedFurnitureId || "unknown furni"}`
  );
  uiState.editMode.draggedFurnitureId = null;
  uiState.editMode.dragStartX = 0;
  uiState.editMode.dragStartY = 0;
  uiState.editMode.dragOriginalZ = 0;
  // No need to explicitly change state here, handleMouseUp will do that.
  // updateHighlights() will be called by the game loop and will stop drawing the ghost.
  // The renderer should automatically show the original furniture if it was hidden.
  updateHighlights(); // Explicitly update highlights to remove ghost immediately
  updateUICursor(); // Reset cursor if needed
}
// --- End Furniture Dragging ---

/** Sets the currently selected inventory item for placement. */
export function setSelectedInventoryItem(definitionId) {
  // Allow deselecting by passing null
  const newSelection = definitionId ? String(definitionId) : null;
  if (uiState.editMode.selectedInventoryItemId === newSelection) return; // No change

  console.log(`Setting selected inventory item: ${newSelection}`);
  uiState.editMode.selectedInventoryItemId = newSelection;
  uiState.editMode.placementRotation = 0; // Reset rotation on new selection

  if (newSelection) {
    setSelectedFurniture(null); // Deselect any floor furniture
    setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING); // Enter placing state
  } else {
    // If currently in placing state and deselecting, go back to navigate
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }

  updateInventorySelection(); // Update visual highlight in inventory panel
  updateHighlights(); // Update tile highlights for placement ghost
  hideContextMenu(); // Hide context menu
}

/** Sets the currently selected floor furniture for manipulation. */
export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null;
  const oldSelectedId = uiState.editMode.selectedFurnitureId;

  if (oldSelectedId === newSelectedId) return; // No change

  console.log(`Setting selected floor furniture: ${newSelectedId}`);

  // Deselect the old furniture visually
  if (oldSelectedId && gameState.furniture[oldSelectedId]) {
    gameState.furniture[oldSelectedId].isSelected = false;
  }

  uiState.editMode.selectedFurnitureId = newSelectedId;

  // Select the new furniture visually and update state
  if (newSelectedId) {
    const furni = gameState.furniture[newSelectedId];
    if (furni) {
      furni.isSelected = true;
      setSelectedInventoryItem(null); // Deselect inventory item
      setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI); // Enter selected furniture state
    } else {
      // Furniture ID provided but not found in game state? Deselect.
      console.warn(
        `Selected furniture ID ${newSelectedId} not found in gameState.`
      );
      uiState.editMode.selectedFurnitureId = null;
      if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
        setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
      }
      hideRecolorPanel();
    }
  } else {
    // Deselecting furniture
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Return to navigate state
    }
    hideRecolorPanel(); // Hide recolor panel on deselect
  }

  updateHighlights(); // Update tile/furniture highlights
  hideContextMenu(); // Hide context menu
}

/** Toggles the main edit mode on/off. */
export function toggleEditMode() {
  if (!CLIENT_CONFIG || !uiState.toggleEditBottomBtn) return;

  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);

  uiState.toggleEditBottomBtn.classList.toggle("active", uiState.isEditMode);

  if (!uiState.isEditMode) {
    // Cleanup when turning Edit Mode OFF
    setSelectedFurniture(null);
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Ensure back to navigate state
    hideRecolorPanel();
    hideContextMenu();
  } else {
    // When turning Edit Mode ON, start in navigate state
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }

  // Update UI elements affected by edit mode toggle
  updateInventorySelection(); // Update highlights in inventory
  updateHighlights(); // Update tile/furniture highlights on map
  updateUICursor(); // Change main cursor
}

// --- Input Click Handlers ---

/** Handles LEFT clicks on the canvas when in Edit Mode. */
export function handleEditModeClick(gridPos, screenPos) {
  if (
    !CLIENT_CONFIG ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !isConnected()
  )
    return;

  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const canLayoutEdit =
    uiState.isEditMode &&
    player?.isAdmin &&
    uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;

  // --- Admin Layout Painting ---
  if (canLayoutEdit) {
    if (
      gridPos &&
      gridPos.x >= 0 &&
      gridPos.x < gameState.roomCols &&
      gridPos.y >= 0 &&
      gridPos.y < gameState.roomRows
    ) {
      // Check if tile is blocked before allowing modification (except for flooring)
      if (selectedLayoutPaintType === 1 || selectedLayoutPaintType === "X") {
        // Wall or Hole
        const avatarOnTile = Object.values({
          ...gameState.avatars,
          ...gameState.npcs,
        }).find(
          (a) => Math.round(a.x) === gridPos.x && Math.round(a.y) === gridPos.y
        );
        const furnitureOnTile = roomHasNonFlatFurnitureAt(gridPos.x, gridPos.y); // Use helper
        if (avatarOnTile) {
          showNotification(
            `Cannot modify under ${escapeHtml(avatarOnTile.name)}.`,
            "warning"
          );
          return;
        }
        if (furnitureOnTile) {
          showNotification(
            `Cannot modify under '${escapeHtml(furnitureOnTile.name)}'.`,
            "warning"
          );
          return;
        }
      }
      // Proceed with modification request
      requestModifyLayout(
        gameState.currentRoomId,
        gridPos.x,
        gridPos.y,
        selectedLayoutPaintType
      );
      playSound("place"); // Use place sound for painting too?
    } else {
      showNotification(`Cannot modify layout outside bounds.`, "warning");
    }
    return; // Stop further processing after layout paint attempt
  }

  // --- Furniture Placement / Selection ---
  switch (uiState.editMode.state) {
    case CLIENT_CONFIG.EDIT_STATE_PLACING:
      if (
        gridPos &&
        uiState.editMode.placementValid &&
        uiState.editMode.selectedInventoryItemId
      ) {
        // Check client-side inventory count before sending request (minor optimization)
        if (
          (gameState.inventory[uiState.editMode.selectedInventoryItemId] || 0) >
          0
        ) {
          requestPlaceFurni(
            uiState.editMode.selectedInventoryItemId,
            gridPos.x,
            gridPos.y,
            uiState.editMode.placementRotation
          );
          // Don't play sound here, wait for server confirmation (furni_added)
        } else {
          showNotification("You don't have that item anymore.", "error");
          setSelectedInventoryItem(null); // Deselect if item is gone
        }
      } else {
        showNotification("Cannot place item there.", "error");
        playSound("error");
      }
      break;

    case CLIENT_CONFIG.EDIT_STATE_NAVIGATE:
    case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI:
      // Furniture selection logic
      if (screenPos) {
        // Requires screen position to check what was clicked
        const clickedFurniture = getTopmostFurnitureAtScreen(
          screenPos.x,
          screenPos.y
        );
        if (clickedFurniture) {
          // If clicking already selected furniture, deselect it. Otherwise, select the new one.
          if (clickedFurniture.id === uiState.editMode.selectedFurnitureId) {
            setSelectedFurniture(null); // Deselect
          } else {
            setSelectedFurniture(clickedFurniture.id); // Select new
            playSound("select");
          }
        } else {
          // Clicked empty ground or non-selectable item
          setSelectedFurniture(null); // Deselect if anything was selected
          hideRecolorPanel(); // Ensure recolor panel is closed
        }
      } else {
        // No screen position (e.g., triggered from context menu) - likely already handled
      }
      break;
  }
}

/** Handles LEFT clicks on the canvas when *not* in Edit Mode (Navigate). */
export function handleNavigateModeClick(gridPos, screenPos) {
  if (!isConnected() || !SHARED_CONFIG || !gameState.currentRoomId) return;

  const myAvatar = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!myAvatar) return; // Cannot perform actions without player avatar

  // Determine what was clicked (priority: Character > Furniture > Tile)
  const clickedCharacter = screenPos
    ? getAvatarOrNPCOnScreen(screenPos.x, screenPos.y)
    : null;
  const clickedFurniture =
    !clickedCharacter && screenPos
      ? getTopmostFurnitureAtScreen(screenPos.x, screenPos.y)
      : null; // Only check furniture if no character clicked

  // 1. Clicked on a Character (Player or NPC)
  if (clickedCharacter) {
    if (clickedCharacter.isNPC) {
      requestInteract(clickedCharacter.id); // Interact with NPC
    } else if (clickedCharacter.id !== gameState.myAvatarId) {
      requestProfile(clickedCharacter.id); // View other player's profile
    } else {
      // Clicked self - maybe stand up if sitting?
      if (myAvatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
        requestStand();
      } else {
        showNotification(
          `You clicked yourself (${escapeHtml(clickedCharacter.name)}).`,
          "info"
        );
      }
    }
    return; // Stop processing after character click
  }

  // 2. Clicked on Furniture (and not a character)
  if (clickedFurniture) {
    if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
      const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === clickedFurniture.definitionId
      );
      requestChangeRoom(
        clickedFurniture.targetRoomId,
        doorDef?.targetX,
        doorDef?.targetY
      );
    } else if (clickedFurniture.definition?.canUse) {
      requestUseFurni(clickedFurniture.id);
      // Play sound on server confirmation? Or optimistically here? Let's wait for server.
    } else if (clickedFurniture.definition?.canSit) {
      requestSit(clickedFurniture.id);
    } else {
      // Clicked non-interactive furniture, try walking to tile instead (fall through)
      if (gridPos && isClientWalkable(gridPos.x, gridPos.y)) {
        requestMove(gridPos.x, gridPos.y);
      } else {
        showNotification("Cannot interact with or walk there.", "info");
      }
    }
    return; // Stop processing after furniture click
  }

  // 3. Clicked on a Tile (and not a character or interactive furniture)
  if (gridPos) {
    // Special case: If currently sitting, clicking own tile means stand up
    if (myAvatar.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
      const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
      if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
        requestStand();
        return;
      }
    }
    // Otherwise, try walking
    if (isClientWalkable(gridPos.x, gridPos.y)) {
      requestMove(gridPos.x, gridPos.y);
    } else {
      showNotification("Cannot walk there.", "error");
      playSound("error");
    }
  }
}

// --- Context Menu Functions ---

/** Hides the custom context menu. */
export function hideContextMenu() {
  if (uiState.contextMenu) {
    uiState.contextMenu.style.display = "none";
    const ul = uiState.contextMenu.querySelector("ul");
    if (ul) ul.innerHTML = ""; // Clear previous items
    uiState.contextMenuTarget = null; // Clear target info
  }
}

/** Shows the custom context menu at the specified screen coordinates. */
export function showContextMenu(screenX, screenY, target) {
  if (!uiState.contextMenu || !target || !CLIENT_CONFIG || !SHARED_CONFIG) {
    return;
  }

  hideContextMenu(); // Hide any previous menu
  uiState.contextMenuTarget = target; // Store info about the clicked target

  const menuUl = uiState.contextMenu.querySelector("ul");
  if (!menuUl) {
    console.error("Context menu UL element not found!");
    return;
  }
  menuUl.innerHTML = ""; // Clear previous items

  const menuItems = getContextMenuActions(target); // Get actions based on target
  if (menuItems.length === 0) return; // Don't show empty menu

  // Populate the menu
  menuItems.forEach((item) => {
    const li = document.createElement("li");
    if (item.separator) {
      li.className = "separator";
    } else {
      li.textContent = item.label || "Action"; // Escape handled by textContent
      li.dataset.action = item.action || "none";
      if (item.disabled) li.classList.add("disabled");
    }
    menuUl.appendChild(li);
  });

  // Position the menu, ensuring it stays within canvas bounds
  const menuWidth = uiState.contextMenu.offsetWidth;
  const menuHeight = uiState.contextMenu.offsetHeight;
  const canvasRect = uiState.canvas?.getBoundingClientRect();
  if (!canvasRect) return;

  let menuX = screenX;
  let menuY = screenY;

  // Adjust if menu goes off-screen
  if (menuX + menuWidth > canvasRect.width) menuX = screenX - menuWidth;
  if (menuY + menuHeight > canvasRect.height) menuY = screenY - menuHeight;
  if (menuX < 0) menuX = 5; // Add small padding from edge
  if (menuY < 0) menuY = 5;

  uiState.contextMenu.style.left = `${menuX}px`;
  uiState.contextMenu.style.top = `${menuY}px`;
  uiState.contextMenu.style.display = "block"; // Show the menu
}

/** Determines context menu actions based on the target object. */
function getContextMenuActions(target) {
  const actions = [];
  const isEditing = uiState.isEditMode;
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!SHARED_CONFIG || !CLIENT_CONFIG || !gameState.currentRoomId) return [];

  switch (target.type) {
    case "avatar":
      const avatar = gameState.avatars[target.id];
      if (!avatar) return [];
      if (target.id !== gameState.myAvatarId) {
        // Other Player
        actions.push({
          label: `Profile: ${escapeHtml(avatar.name)}`,
          action: "profile",
        });
        actions.push({
          label: `Trade with ${escapeHtml(avatar.name)}`,
          action: "trade",
          disabled: uiState.isTrading,
        });
      } else {
        // Self
        actions.push({
          label: "Stand Up",
          action: "stand",
          disabled:
            !player || player.state !== SHARED_CONFIG.AVATAR_STATE_SITTING,
        });
        // Could add self-profile or appearance actions here
      }
      if (player?.isAdmin && target.id !== gameState.myAvatarId) {
        // Admin actions on others
        actions.push({ separator: true });
        actions.push({
          label: `Kick ${escapeHtml(avatar.name)}`,
          action: "admin_kick",
        });
        // Add other admin actions like teleport-to, give etc. here? Might be better via console/chat commands.
      }
      break;

    case "npc": // <-- Added NPC Actions
      const npc = gameState.npcs[target.id];
      if (npc) {
        actions.push({
          label: `Talk to ${escapeHtml(npc.name)}`,
          action: "npc_talk",
        });
        // Add other NPC interactions if implemented (e.g., 'Quest', 'Shop')
      } else {
        actions.push({
          label: "(NPC Vanished?)",
          action: "none",
          disabled: true,
        });
      }
      break;

    case "furniture":
      const furni = gameState.furniture[target.id];
      if (!furni || !furni.definition) return [];
      const def = furni.definition;
      const clientInfo = gameState.myUserId
        ? { userId: gameState.myUserId }
        : null; // Get client's persistent ID
      const isOwner =
        clientInfo?.userId &&
        furni.ownerId &&
        String(furni.ownerId) === clientInfo.userId;
      const occupied = isFurnitureOccupied(target.id); // Check if an avatar is sitting

      if (isEditing) {
        // Actions in Edit Mode
        if (isOwner || player?.isAdmin) {
          // Owner or Admin
          actions.push({
            label: `Pickup ${escapeHtml(def.name)}`,
            action: "pickup",
            disabled: occupied,
          });
          if (!def.isFlat)
            actions.push({
              label: "Rotate",
              action: "rotate",
              disabled: occupied,
            });
          if (furni.canRecolor)
            actions.push({ label: "Recolor", action: "recolor" });
        } else {
          actions.push({
            label: `(Owned by other)`,
            action: "none",
            disabled: true,
          });
        }
        // Allow 'Use' even in edit mode? Maybe not to avoid confusion.
        // if (def.canUse) actions.push({ label: `Use ${escapeHtml(def.name)}`, action: 'use' });
      } else {
        // Actions in Navigate Mode
        if (def.isDoor && def.targetRoomId)
          actions.push({
            label: `Enter ${escapeHtml(def.targetRoomId)}`,
            action: "door",
          });
        else if (def.canSit)
          actions.push({
            label: occupied ? "Sit (Occupied)" : "Sit Here",
            action: "sit",
            disabled: occupied,
          });
        else if (def.canUse)
          actions.push({ label: `Use ${escapeHtml(def.name)}`, action: "use" });
        else
          actions.push({
            label: escapeHtml(def.name),
            action: "none",
            disabled: true,
          }); // Just show name if no action
      }
      break;

    case "tile":
      if (
        isEditing &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        uiState.editMode.selectedInventoryItemId
      ) {
        const placingDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
          (d) => d.id === uiState.editMode.selectedInventoryItemId
        );
        const canPlace = placingDef
          ? isClientPlacementValid(placingDef, target.x, target.y)
          : false;
        actions.push({
          label: `Place ${escapeHtml(placingDef?.name || "Item")}`,
          action: "place_item_here",
          disabled: !canPlace,
        });
      } else if (
        isEditing &&
        player?.isAdmin &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE
      ) {
        actions.push({
          label: `Paint Tile (${selectedLayoutPaintType})`,
          action: "paint_tile",
        });
      } else if (!isEditing && isClientWalkable(target.x, target.y)) {
        actions.push({ label: `Walk Here`, action: "walk_here" });
      }
      break;
  }
  return actions;
}

/** Checks client-side if furniture is occupied by an avatar or NPC. */
function isFurnitureOccupied(furniDbId) {
  if (!furniDbId) return false;
  const idString = String(furniDbId);
  // Check both player avatars and NPCs
  const isOccupiedByAvatar = Object.values(gameState.avatars || {}).some(
    (a) => a instanceof ClientAvatar && String(a.sittingOnFurniId) === idString
  );
  // NPCs currently don't sit, but could be added later
  // const isOccupiedByNPC = Object.values(gameState.npcs || {}).some(
  //    (n) => n instanceof ClientNPC && String(n.sittingOnFurniId) === idString
  // );
  return isOccupiedByAvatar; // || isOccupiedByNPC;
}

/** Handles clicks on context menu items. */
function handleContextMenuClick(event) {
  const targetLi = event.target.closest("li");
  if (
    !targetLi ||
    targetLi.classList.contains("disabled") ||
    targetLi.classList.contains("separator")
  ) {
    hideContextMenu(); // Hide if disabled or separator clicked
    return;
  }

  const action = targetLi.dataset.action;
  const targetInfo = uiState.contextMenuTarget; // Get target info stored when menu was shown

  if (!action || !targetInfo || action === "none") {
    hideContextMenu();
    return;
  }

  console.log(
    `Context Menu Action: ${action} on ${targetInfo.type} ${
      targetInfo.id || `(${targetInfo.x},${targetInfo.y})`
    }`
  );

  // --- Handle Actions ---
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
    case "trade":
      if (
        targetInfo.type === "avatar" &&
        targetInfo.id &&
        targetInfo.id !== gameState.myAvatarId
      )
        requestTradeInitiate(targetInfo.id);
      break;
    case "admin_kick": // Assuming server handles permission check again
      if (targetInfo.type === "avatar" && targetInfo.id) {
        const avatarToKick = gameState.avatars[targetInfo.id];
        if (avatarToKick) sendChat(`/kick ${avatarToKick.name}`); // Use chat command for server processing
      }
      break;

    // NPC Actions <-- Added
    case "npc_talk":
      if (targetInfo.type === "npc" && targetInfo.id)
        requestInteract(targetInfo.id);
      break;

    // Furniture Actions
    case "use":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestUseFurni(targetInfo.id);
      break;
    case "sit":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestSit(targetInfo.id);
      break;
    case "door":
      if (targetInfo.type === "furniture" && targetInfo.id) {
        const f = gameState.furniture[targetInfo.id];
        if (f?.isDoor && f.targetRoomId) {
          const d = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
            (x) => x.id === f.definitionId
          );
          requestChangeRoom(f.targetRoomId, d?.targetX, d?.targetY);
        }
      }
      break;
    case "pickup":
      if (
        targetInfo.type === "furniture" &&
        targetInfo.id &&
        uiState.isEditMode
      )
        requestPickupFurni(targetInfo.id);
      break;
    case "rotate":
      if (
        targetInfo.type === "furniture" &&
        targetInfo.id &&
        uiState.isEditMode
      )
        requestRotateFurni(targetInfo.id);
      break;
    case "recolor":
      if (
        targetInfo.type === "furniture" &&
        targetInfo.id &&
        uiState.isEditMode
      ) {
        const furni = gameState.furniture[targetInfo.id];
        if (furni?.canRecolor) showRecolorPanel(furni.id);
        else showNotification("This item cannot be recolored.", "info");
      }
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
        handleEditModeClick(targetInfo, null); // Trigger placement
      }
      break;
    case "walk_here":
      if (
        targetInfo.type === "tile" &&
        !uiState.isEditMode &&
        targetInfo.x != null &&
        targetInfo.y != null
      ) {
        handleNavigateModeClick(targetInfo, null); // Trigger walk
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
        handleEditModeClick(targetInfo, null); // Trigger paint
      }
      break;

    default:
      console.warn(`Unhandled context menu action: ${action}`);
  }

  hideContextMenu(); // Hide menu after action
}

// --- Highlighting Logic ---

/** Updates tile and furniture highlights based on mode and mouse position. */
export function updateHighlights() {
  if (
    !CLIENT_CONFIG ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.clientTiles ||
    !inputState
  )
    return;

  clearAllHighlights(); // Clear previous highlights

  const gridPos = inputState.currentMouseGridPos || { x: -1, y: -1 };
  const screenPos = inputState.currentMouseScreenPos || { x: -1, y: -1 };

  // Check if mouse is over a valid tile in the room layout
  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    gameState.highlightedTile = null;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
    ) {
      uiState.editMode.placementValid = false; // Invalidate placement if outside bounds
    }
    return; // Stop if not on a valid tile
  }

  gameState.highlightedTile = { x: gridPos.x, y: gridPos.y }; // Store highlighted tile coords

  // --- Edit Mode Highlighting ---
  if (uiState.isEditMode) {
    switch (uiState.editMode.state) {
      case CLIENT_CONFIG.EDIT_STATE_PLACING:
        if (uiState.editMode.selectedInventoryItemId) {
          const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
            (d) => d.id === uiState.editMode.selectedInventoryItemId
          );
          if (definition) {
            uiState.editMode.placementValid = isClientPlacementValid(
              definition,
              gridPos.x,
              gridPos.y
            );
            const color = uiState.editMode.placementValid
              ? CLIENT_CONFIG.FURNI_PLACE_HIGHLIGHT_COLOR
              : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR;
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
            uiState.editMode.placementValid = false;
            setTileHighlight(
              gridPos.x,
              gridPos.y,
              CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
            );
          }
        }
        break;

      case EDIT_STATE_DRAGGING_FURNI: // "dragging_furni"
        if (uiState.editMode.draggedFurnitureId) {
          const draggedFurni =
            gameState.furniture[uiState.editMode.draggedFurnitureId];
          if (draggedFurni && draggedFurni.definition) {
            // Use the original furniture's definition for the ghost
            uiState.editMode.placementValid = isClientPlacementValid(
              draggedFurni.definition,
              gridPos.x,
              gridPos.y,
              uiState.editMode.draggedFurnitureId // Pass ID to ignore self in collision
            );
            const color = uiState.editMode.placementValid
              ? CLIENT_CONFIG.FURNI_MOVE_HIGHLIGHT_COLOR // Potentially a different color for move
              : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR;

            // Create a temporary representation for highlighting occupied tiles
            const tempGhostProto = {
              x: gridPos.x, // Ghost is at mouse grid position
              y: gridPos.y,
              definition: draggedFurni.definition, // Use original definition
              // Rotation is visual, getOccupiedTiles usually doesn't need it directly
              // but the renderer will use draggedFurni.rotation for the ghost image.
              getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles,
            };
            tempGhostProto
              .getOccupiedTiles()
              .forEach((tp) => setTileHighlight(tp.x, tp.y, color));
          } else {
            uiState.editMode.placementValid = false; // Cannot place if definition missing
          }
        }
        break;

      // Navigate/Selected Furniture State (default case)
      default:
        const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
        const player = gameState.myAvatarId
          ? gameState.avatars[gameState.myAvatarId]
          : null;
        const canLayoutEdit =
          player?.isAdmin &&
          uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;

        if (canLayoutEdit) {
          setTileHighlight(
            gridPos.x,
            gridPos.y,
            CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
          );
        } else if (
          hoveredF &&
          hoveredF.id !== uiState.editMode.selectedFurnitureId
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
        } else if (!hoveredF && gameState.highlightedTile) {
          setTileHighlight(
            gameState.highlightedTile.x,
            gameState.highlightedTile.y,
            CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
          );
        }
        // Selected furniture highlighting is handled by ClientFurniture.draw
        break;
    }
  }
  // --- Navigate Mode Highlighting ---
  else {
    const hoveredChar = getAvatarOrNPCOnScreen(screenPos.x, screenPos.y);
    const hoveredF = !hoveredChar
      ? getTopmostFurnitureAtScreen(screenPos.x, screenPos.y)
      : null; // Only check furniture if no char

    if (hoveredChar && !hoveredChar.isPlayer) {
      // Highlight NPCs slightly?
      // Example: Set a property on the NPC? Or handle in draw? For now, no specific NPC highlight.
    } else if (
      hoveredF &&
      (hoveredF.isDoor ||
        hoveredF.definition?.canUse ||
        hoveredF.definition?.canSit)
    ) {
      // Highlight interactive furniture
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
      // Highlight walkable empty tile
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      ); // More transparent
    }
  }

  // Final check if highlighted tile itself became invalid (e.g., layout changed)
  if (
    gameState.highlightedTile &&
    !isValidClientTile(gameState.highlightedTile.x, gameState.highlightedTile.y)
  ) {
    gameState.highlightedTile = null;
  }
}

/** Checks if placement is valid client-side (visual feedback only). */
export function isClientPlacementValid(
  definition,
  gridX,
  gridY,
  ignoreFurniId = null
) {
  if (
    !definition ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.furniture
  )
    return false;

  // Check bounds and layout type for all occupied tiles
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    definition: definition,
    getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles,
  };
  const occupiedTiles = tempFurniProto.getOccupiedTiles();
  for (const tile of occupiedTiles) {
    const gx = tile.x;
    const gy = tile.y;
    if (!isValidClientTile(gx, gy)) return false; // Out of bounds
    const tileType = getTileLayoutType(gx, gy);
    if (tileType === 1 || tileType === "X") return false; // Wall or Hole

    // Check stacking rules if not flat
    if (!definition.isFlat) {
      const stackOnThisTile = Object.values(gameState.furniture).filter(
        (f) =>
          f instanceof ClientFurniture &&
          f.id !== ignoreFurniId && // Don't collide with self when dragging
          Math.round(f.visualX) === gx &&
          Math.round(f.visualY) === gy
      );
      const topItemOnThisTile = stackOnThisTile.sort(
        (a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0)
      )[0];

      if (topItemOnThisTile) {
        if (!topItemOnThisTile.definition?.stackable) return false; // Cannot stack on top of non-stackable

        // Check if blocked by SOLID item (only matters if placing item is also solid)
        if (
          !definition.isWalkable && // Current item is solid
          !definition.isFlat &&
          !topItemOnThisTile.definition?.isWalkable && // Item below is solid
          !topItemOnThisTile.definition?.isFlat
        ) {
          return false; // Blocked by existing solid item
        }
      }
    }
  }

  // Check stack height limit, ignoring self if dragging
  const estimatedBaseZ = getClientStackHeightAt(gridX, gridY, ignoreFurniId);
  const itemBaseZ = estimatedBaseZ + (definition.zOffset || 0);
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = itemBaseZ + (definition.isFlat ? 0 : itemStackContrib);
  const epsilon = 0.001;
  if (itemTopZ >= (SHARED_CONFIG.MAX_STACK_Z || 5.0) - epsilon) return false; // Exceeds max height

  return true; // Placement appears valid client-side
}

/** Sets the highlight color property on a specific ClientTile instance. */
function setTileHighlight(x, y, color) {
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  if (tile) {
    tile.highlight = color; // Assign color string (e.g., 'rgba(255,0,0,0.3)')
  }
}

/** Clears the highlight property on all ClientTile instances. */
function clearAllHighlights() {
  if (!gameState.clientTiles) return;
  gameState.clientTiles.forEach((t) => {
    t.highlight = null;
  });
}

// --- Helper & Calculation Functions ---

/** Calculates stack height at coordinates client-side based on visual Z. */
export function getClientStackHeightAt(gridX, gridY) {
  if (!SHARED_CONFIG || !gameState.currentRoomId || !gameState.furniture)
    return 0.0;

  const gx = Math.round(gridX);
  const gy = Math.round(gridY);
  const stack = Object.values(gameState.furniture).filter(
    (f) =>
      f instanceof ClientFurniture &&
      Math.round(f.visualX) === gx &&
      Math.round(f.visualY) === gy
  );

  let highestStackableTopZ = 0.0;
  stack.forEach((furni) => {
    if (!furni.definition) return;
    const itemStackHeight =
      furni.definition.stackHeight ?? (furni.definition.isFlat ? 0 : 1.0);
    const itemStackContrib =
      itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
    const itemTopSurfaceZ =
      (furni.visualZ ?? 0) + (furni.definition.isFlat ? 0 : itemStackContrib);
    // Consider only stackable items for the base of the next item
    if (furni.definition.stackable) {
      highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
    }
  });
  return Math.max(0, highestStackableTopZ); // Ensure non-negative
}

/** Checks if coordinates are within the current room's bounds. */
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

/** Gets the layout type (0, 1, 2, 'X') for given coordinates. */
export function getTileLayoutType(x, y) {
  if (!isValidClientTile(x, y) || !gameState.roomLayout) return null; // Check bounds and layout existence
  const row = gameState.roomLayout[y];
  if (!row || x < 0 || x >= row.length) return null; // Check row existence and x bounds
  return row[x] ?? 0; // Return type or default 0 (floor)
}

/** Checks if a tile is walkable based on layout and client-side furniture state. */
export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!isValidClientTile(gx, gy)) return false; // Check bounds

  const layoutType = getTileLayoutType(gx, gy);
  // Allow walking on floor (0) and alternate floor (2)
  if (layoutType !== 0 && layoutType !== 2) return false;

  // Check if occupied by solid furniture or NPC (if NPCs block)
  return !isClientOccupiedBySolid(gx, gy);
}

/** Checks if a tile is occupied by solid (non-walkable, non-flat) furniture client-side. */
export function isClientOccupiedBySolid(gridX, gridY) {
  if (!gameState.furniture) return false;

  // Check solid furniture
  const solidFurni = Object.values(gameState.furniture).some((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;
    const def = f.definition;
    // Solid means not walkable AND not flat
    const isSolid = !def.isWalkable && !def.isFlat;
    if (!isSolid) return false;
    // Check if this solid furniture occupies the target tile
    return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
  });
  if (solidFurni) return true;

  // Optionally check NPCs
  // const solidNPC = Object.values(gameState.npcs || {}).some(npc => {
  //    if (!(npc instanceof ClientNPC)) return false;
  //    // Simple check: Does NPC visually occupy the target tile?
  //    return Math.round(npc.visualX) === gridX && Math.round(npc.visualY) === gridY;
  // });
  // if (solidNPC) return true;

  return false; // Not occupied by solid furniture (or NPCs if check disabled)
}

/** Checks if the room has any non-flat furniture at the given coordinates. */
function roomHasNonFlatFurnitureAt(gridX, gridY) {
  if (!gameState.furniture) return null;
  return Object.values(gameState.furniture).find(
    (f) =>
      f instanceof ClientFurniture &&
      !f.definition?.isFlat &&
      Math.round(f.visualX) === gridX &&
      Math.round(f.visualY) === gridY
  );
}

// --- Camera Controls ---

/** Pans the camera by the given screen pixel amounts. */
export function moveCamera(dx, dy) {
  if (!camera) return;
  camera.x += dx;
  camera.y += dy;
  // Add bounds checks if desired later
}

/** Zooms the camera by a factor, pivoting around a screen point. */
export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) return;

  const pivotScreenX = pivotX ?? uiState.canvas.width / 2; // Default to center
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;

  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY); // World point under cursor

  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );

  if (Math.abs(newZoom - oldZoom) < 0.001) return; // Avoid tiny changes

  camera.zoom = newZoom; // Apply new zoom level

  // Find where the world point under the cursor *would* be with the new zoom (but same pan)
  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );

  // Adjust camera pan (x, y) to keep the world point under the cursor
  camera.x -= screenPosAfterZoomOnly.x - pivotScreenX;
  camera.y -= screenPosAfterZoomOnly.y - pivotScreenY;
}

/** Centers the camera approximately on the middle of the current room. */
export function centerCameraOnRoom() {
  if (
    !uiState.canvas ||
    !camera ||
    !gameState ||
    !SHARED_CONFIG ||
    gameState.roomCols <= 0 ||
    gameState.roomRows <= 0
  )
    return;

  try {
    const centerX = gameState.roomCols / 2;
    const centerY = gameState.roomRows / 2;
    const centerIso = worldToIso(centerX, centerY); // World center to ISO origin coords

    // Adjust pan to place the ISO center point at the desired screen location (e.g., center)
    // Multiply by zoom because pan is in screen pixels, affected by zoom level.
    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
    // Adjust Y slightly higher than center for better perspective
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

/** Updates the game container's cursor style based on current state. */
export function updateUICursor() {
  if (!uiState.gameContainer || !inputState) return;

  // Remove previous cursor classes
  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = ""; // Reset to default (CSS defined)

  if (inputState.isDragging) {
    uiState.gameContainer.classList.add("dragging"); // Use 'grabbing' cursor
  } else if (uiState.isEditMode) {
    uiState.gameContainer.classList.add("edit-mode-cursor"); // Use 'crosshair' cursor
  }
  // Default cursor is 'grab' (set in CSS) for navigate mode
}

// --- Object Picking ---

/** Finds the topmost avatar OR NPC at the given screen coordinates. */
export function getAvatarOrNPCOnScreen(screenX, screenY) {
  const avatarCandidates = Object.values(gameState.avatars || {}).filter(
    (a) =>
      a instanceof ClientAvatar &&
      typeof a.containsPoint === "function" &&
      a.containsPoint(screenX, screenY)
  );
  const npcCandidates = Object.values(gameState.npcs || {}).filter(
    (n) =>
      n instanceof ClientNPC &&
      typeof n.containsPoint === "function" &&
      n.containsPoint(screenX, screenY)
  );

  const allCandidates = [...avatarCandidates, ...npcCandidates];
  if (allCandidates.length === 0) return null;

  // Sort by drawOrder ascending (lower drawOrder = drawn first/further back)
  allCandidates.sort((a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0));

  // Return the last element (highest drawOrder = drawn last/topmost)
  return allCandidates[allCandidates.length - 1];
}

/** Finds the topmost PLAYER avatar at screen coordinates. */
export function getAvatarAtScreen(screenX, screenY) {
  const obj = getAvatarOrNPCOnScreen(screenX, screenY);
  // Ensure it's a ClientAvatar and NOT an NPC
  return obj instanceof ClientAvatar && !obj.isNPC ? obj : null;
}

/** Finds the topmost NPC at screen coordinates. */
export function getNPCAtScreen(screenX, screenY) {
  const obj = getAvatarOrNPCOnScreen(screenX, screenY);
  return obj instanceof ClientNPC ? obj : null;
}

/** Finds the topmost furniture at the given screen coordinates. */
export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture || !CLIENT_CONFIG)
    return null;

  const candidates = Object.values(gameState.furniture).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;

    // Use furniture's visual position and dimensions for hit testing
    const screenPos = getScreenPos(f.visualX, f.visualY);
    const zoom = camera.zoom;
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) * zoom * 1.1; // Use draw width
    const visualHeightFactor = f.definition.isFlat
      ? 0.1
      : f.definition.stackHeight != null
      ? f.definition.stackHeight * 1.5
      : 1.0;
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom; // Use draw height
    const visualZFactor =
      CLIENT_CONFIG.VISUAL_Z_FACTOR || SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5;
    const zOffsetPx = (f.visualZ || 0) * visualZFactor * zoom;

    // Calculate bounding box based on drawing logic
    const drawTopY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawBottomY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx; // Bottom edge approx
    const drawLeftX = screenPos.x - baseDrawWidth / 2;
    const drawRightX = screenPos.x + baseDrawWidth / 2;

    // Check if screen point is within this bounding box
    return (
      screenX >= drawLeftX &&
      screenX <= drawRightX &&
      screenY >= drawTopY &&
      screenY <= drawBottomY
    );
  });

  if (candidates.length === 0) return null;

  // Sort candidates by drawOrder ascending
  candidates.sort((a, b) => (a.drawOrder ?? 0) - (b.drawOrder ?? 0));

  // Return the last one (highest drawOrder = topmost)
  return candidates[candidates.length - 1];
}

// --- Notification System ---

/**
 * Displays a temporary notification message on the screen, optionally with action buttons.
 * @param {string} message - The message text (HTML will be escaped).
 * @param {Array<object>} [actions=[]] - Array of action objects { label: string, action: function, type?: string ('success', 'error', 'info') }.
 * @param {number | null} [duration=null] - Auto-dismiss duration in ms. Uses config default if null. Ignored if actions are present unless autoDeclineTimeout is set.
 * @param {string} [type='info'] - Notification type ('info', 'success', 'warning', 'error'). Affects styling.
 * @param {number | null} [autoDeclineTimeout=null] - If actions are present, automatically triggers the LAST action after this duration (ms).
 */
export function showNotificationWithActions(
  message,
  actions = [],
  duration = null,
  type = "info",
  autoDeclineTimeout = null
) {
  if (!uiState.notificationContainer || !CLIENT_CONFIG || !message) return;

  const displayDuration = duration ?? CLIENT_CONFIG.NOTIFICATION_DURATION;
  const fadeDuration = CLIENT_CONFIG.NOTIFICATION_FADE_OUT_DURATION;
  const hasActions = Array.isArray(actions) && actions.length > 0;

  // Create notification element
  const notificationElement = document.createElement("div");
  notificationElement.className = `toast-notification ${type}`; // Base class + type class

  // Set message content safely
  const messageP = document.createElement("p");
  messageP.textContent = message; // Use textContent to escape message
  notificationElement.appendChild(messageP);

  let autoDeclineTimerId = null;

  // Add action buttons if provided
  if (hasActions) {
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "toast-actions";

    actions.forEach((actionInfo) => {
      const button = document.createElement("button");
      button.textContent = actionInfo.label; // Label is likely safe, but escape if needed
      button.classList.add("toast-action-btn", actionInfo.type || type); // Style based on action type or notification type
      button.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent notification click handler
        if (autoDeclineTimerId) clearTimeout(autoDeclineTimerId); // Clear auto-decline timer
        if (typeof actionInfo.action === "function") {
          actionInfo.action(); // Execute the action callback
        }
        // Start fade out animation
        notificationElement.classList.add("fade-out");
        setTimeout(() => notificationElement.remove(), fadeDuration); // Remove after fade
      });
      actionsContainer.appendChild(button);
    });
    notificationElement.appendChild(actionsContainer);

    // Set up auto-decline timer if requested
    if (
      autoDeclineTimeout !== null &&
      autoDeclineTimeout > 0 &&
      actions.length > 0
    ) {
      const lastAction = actions[actions.length - 1]; // Usually the 'decline' or 'cancel' action
      if (typeof lastAction.action === "function") {
        autoDeclineTimerId = setTimeout(() => {
          console.log(
            `Notification timeout triggered action: ${lastAction.label}`
          );
          lastAction.action(); // Trigger the last action
          notificationElement.classList.add("fade-out");
          setTimeout(() => notificationElement.remove(), fadeDuration);
        }, autoDeclineTimeout);
        notificationElement.dataset.autoTimeoutId = String(autoDeclineTimerId); // Store timer ID
      }
    }
  } else {
    // Simple notification - set auto-dismiss timer
    const removalTimeout = setTimeout(() => {
      notificationElement.classList.add("fade-out");
      const finalRemovalTimeout = setTimeout(() => {
        notificationElement.remove();
      }, fadeDuration);
      notificationElement.dataset.finalTimeoutId = String(finalRemovalTimeout);
    }, displayDuration);
    notificationElement.dataset.removalTimeoutId = String(removalTimeout);
  }

  // Add click listener to dismiss simple notifications or cancel action timers
  // Only add if it's NOT an action-based notification that requires explicit button clicks (unless auto-decline is set)
  if (!hasActions || autoDeclineTimeout !== null) {
    notificationElement.style.cursor = "pointer"; // Indicate it's clickable
    notificationElement.addEventListener(
      "click",
      () => {
        // Clear any active timers associated with this notification
        if (notificationElement.dataset.removalTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.removalTimeoutId));
        if (notificationElement.dataset.finalTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.finalTimeoutId));
        if (notificationElement.dataset.autoTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.autoTimeoutId));
        // Remove the element immediately on click
        notificationElement.remove();
      },
      { once: true }
    );
  }

  // Add to container and limit count
  uiState.notificationContainer.appendChild(notificationElement);
  const maxNotifications = 5; // Limit visible notifications
  while (uiState.notificationContainer.children.length > maxNotifications) {
    const oldestNotification = uiState.notificationContainer.firstChild;
    if (oldestNotification) {
      // Clear timers before removing to prevent errors
      if (oldestNotification.dataset.removalTimeoutId)
        clearTimeout(parseInt(oldestNotification.dataset.removalTimeoutId));
      if (oldestNotification.dataset.finalTimeoutId)
        clearTimeout(parseInt(oldestNotification.dataset.finalTimeoutId));
      if (oldestNotification.dataset.autoTimeoutId)
        clearTimeout(parseInt(oldestNotification.dataset.autoTimeoutId));
      oldestNotification.remove();
    }
  }
}

// Wrapper for simple notifications without actions
export function showNotification(message, type = "info", duration = null) {
  showNotificationWithActions(message, [], duration, type, null);
}
// --- End Notification System ---

// --- Trade UI Functions ---

/** Debounced function to send trade offer updates to the server. */
const debouncedUpdateOffer = debounce(() => {
  if (!uiState.isTrading || !uiState.tradeSession.tradeId || !isConnected())
    return;

  const items = {};
  const selfItemsGrid =
    uiState.selfTradeOfferDiv?.querySelector(".trade-items-grid");
  // Collect items currently in the offer grid
  selfItemsGrid?.querySelectorAll(".trade-item").forEach((itemEl) => {
    const itemId = itemEl.dataset.itemId;
    const quantity = parseInt(itemEl.dataset.quantity || "1", 10); // Assuming each element represents 1 item
    if (itemId && quantity > 0) {
      items[itemId] = (items[itemId] || 0) + quantity;
    }
  });

  // Get and validate currency
  let currency = parseInt(uiState.selfTradeCurrencyInput?.value || "0", 10);
  if (isNaN(currency) || currency < 0) currency = 0;
  const maxCurrency = gameState.myCurrency || 0;
  if (currency > maxCurrency) {
    currency = maxCurrency;
    if (uiState.selfTradeCurrencyInput)
      uiState.selfTradeCurrencyInput.value = String(currency); // Correct input value
    // showNotification(`Cannot offer more than ${maxCurrency} coins!`, "warning"); // Feedback might be too noisy here
  }

  // Update local state immediately for responsiveness (server will validate)
  uiState.tradeSession.myOffer = { items, currency };

  // Send update to server
  updateTradeOffer(uiState.tradeSession.tradeId, items, currency);
}, 500); // Debounce updates sent every 500ms

/** Handles changes to the self offer (items added/removed or currency changed). */
function handleSelfOfferChange() {
  // If already confirmed, unconfirm self when offer changes
  if (uiState.isTrading && uiState.tradeSession.myConfirmed) {
    // Reset local state and update UI (server will send confirm_update too)
    updateTradeConfirmationStatus(false, uiState.tradeSession.partnerConfirmed);
    // Note: We don't need to send an "unconfirm" message, changing the offer implicitly does this on server.
  }

  // Validate and potentially adjust currency input
  if (uiState.selfTradeCurrencyInput) {
    let currencyValue = parseInt(uiState.selfTradeCurrencyInput.value, 10);
    if (isNaN(currencyValue) || currencyValue < 0) {
      currencyValue = 0;
      uiState.selfTradeCurrencyInput.value = "0";
    }
    const maxCurrency = gameState.myCurrency || 0;
    if (currencyValue > maxCurrency) {
      currencyValue = maxCurrency;
      uiState.selfTradeCurrencyInput.value = String(maxCurrency);
      showNotification(`You only have ${maxCurrency} coins!`, "warning");
    }
  }

  // Trigger the debounced update to send changes to the server
  debouncedUpdateOffer();
}

/** Populates the inventory section within the trade panel. */
export function populateTradeInventory() {
  // Exported for potential refresh from network handler
  if (!uiState.tradeInventoryAreaDiv || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    if (uiState.tradeInventoryAreaDiv)
      uiState.tradeInventoryAreaDiv.innerHTML =
        "<p><i>Error loading inventory.</i></p>";
    return;
  }

  uiState.tradeInventoryAreaDiv.innerHTML = ""; // Clear existing
  const inventory = gameState.inventory || {};
  const offeredItems = uiState.tradeSession?.myOffer?.items || {}; // Get currently offered items
  let hasItemsToShow = false;

  // Determine available items (total owned - currently offered)
  const availableInventory = {};
  for (const itemId in inventory) {
    const totalOwned = inventory[itemId] || 0;
    const currentlyOffered = offeredItems[itemId] || 0;
    const available = totalOwned - currentlyOffered;
    if (available > 0) {
      availableInventory[itemId] = available;
      hasItemsToShow = true;
    }
  }

  if (!hasItemsToShow) {
    uiState.tradeInventoryAreaDiv.innerHTML =
      "<p><i>No items available to add.</i></p>";
    return;
  }

  // Sort available items by name
  const sortedItemIds = Object.keys(availableInventory).sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === a);
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === b);
    return (defA?.name || a).localeCompare(defB?.name || b);
  });

  // Create elements for available items
  sortedItemIds.forEach((itemId) => {
    const quantityAvailable = availableInventory[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (!def) return;

    // Use helper to create the item element (styled for inventory list)
    const itemDiv = createTradeItemElement(def, quantityAvailable, true);
    itemDiv.addEventListener("click", () => addTradeItemToOffer(itemId)); // Add click listener
    uiState.tradeInventoryAreaDiv.appendChild(itemDiv);
  });
}

/** Adds an item from the inventory list to the self offer grid. */
function addTradeItemToOffer(itemId) {
  if (!uiState.isTrading || !uiState.selfTradeOfferDiv) return;

  const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === itemId);
  if (!def) return;

  // Re-check availability just before adding
  const totalOwned = gameState.inventory[itemId] || 0;
  const offeredItemsGrid =
    uiState.selfTradeOfferDiv.querySelector(".trade-items-grid");
  let currentlyOfferedCount = 0;
  offeredItemsGrid
    ?.querySelectorAll(`.trade-item[data-item-id="${itemId}"]`)
    .forEach(() => currentlyOfferedCount++);

  if (totalOwned - currentlyOfferedCount <= 0) {
    showNotification("No more available to add.", "warning");
    populateTradeInventory(); // Refresh inventory display in case of race condition
    return;
  }

  // Add item to the visual grid
  const selfItemsGrid =
    uiState.selfTradeOfferDiv.querySelector(".trade-items-grid");
  if (!selfItemsGrid) return;
  const itemEl = createTradeItemElement(def, 1, false); // Create element for offer grid (qty 1)
  itemEl.dataset.quantity = "1"; // Explicitly set quantity for offer grid item
  itemEl.addEventListener("click", () => removeTradeItemFromOffer(itemEl)); // Add removal listener
  selfItemsGrid.appendChild(itemEl);

  // Refresh available inventory display and trigger offer update
  populateTradeInventory();
  handleSelfOfferChange(); // This will call debouncedUpdateOffer
  playSound("place"); // Feedback sound
}

/** Removes an item element from the self offer grid. */
function removeTradeItemFromOffer(itemElement) {
  if (!uiState.isTrading || !itemElement || !itemElement.parentNode) return;
  const itemId = itemElement.dataset.itemId;
  if (!itemId) return;

  itemElement.remove(); // Remove from visual grid

  // Refresh available inventory display and trigger offer update
  populateTradeInventory();
  handleSelfOfferChange(); // This will call debouncedUpdateOffer
  playSound("pickup"); // Feedback sound
}

/** Creates a DOM element representing a trade item (for grid or inventory list). */
function createTradeItemElement(definition, quantity, isInventoryList) {
  const itemDiv = document.createElement("div");
  itemDiv.className = "trade-item";
  itemDiv.dataset.itemId = definition.id;
  itemDiv.title = `${escapeHtml(definition.name)} (${definition.width}x${
    definition.height
  })`; // Escape title

  // Preview
  const previewSpan = document.createElement("span");
  previewSpan.className = "trade-item-preview";
  previewSpan.style.backgroundColor = definition.color || "#8B4513";
  itemDiv.appendChild(previewSpan);

  if (isInventoryList) {
    // For inventory list: Show name and available quantity
    const nameSpan = document.createElement("span");
    nameSpan.className = "trade-item-name";
    nameSpan.textContent = escapeHtml(definition.name);
    itemDiv.appendChild(nameSpan);

    const quantitySpan = document.createElement("span");
    quantitySpan.className = "trade-item-quantity";
    quantitySpan.textContent = `(x${quantity})`;
    itemDiv.appendChild(quantitySpan);
    itemDiv.dataset.available = String(quantity); // Store available quantity
  } else {
    // For offer grid: Show 'x1' or similar (each element represents one item)
    const quantitySpan = document.createElement("span");
    quantitySpan.className = "trade-item-quantity";
    quantitySpan.textContent = `x1`; // Or maybe hide quantity for grid items
    itemDiv.appendChild(quantitySpan);
  }
  return itemDiv;
}

/** Updates the visual display of items and currency for one side of the trade panel. */
export function updateTradePanelOffers(isMyOffer, offer) {
  const sideDiv = isMyOffer
    ? uiState.selfTradeOfferDiv
    : uiState.partnerTradeOfferDiv;
  const currencyInput = isMyOffer
    ? uiState.selfTradeCurrencyInput
    : uiState.partnerTradeCurrencyInput;

  if (!sideDiv || !currencyInput || !offer || !offer.items) return;

  const itemsGrid = sideDiv.querySelector(".trade-items-grid");
  if (!itemsGrid) return;

  itemsGrid.innerHTML = ""; // Clear previous items

  // Add items to the grid
  for (const itemId in offer.items) {
    const quantity = offer.items[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (def && quantity > 0) {
      // Create one element per item in the offer
      for (let i = 0; i < quantity; i++) {
        const itemEl = createTradeItemElement(def, 1, false); // Create grid item element
        if (isMyOffer) {
          // Add listener only for self offer items to allow removal
          itemEl.dataset.quantity = "1"; // Ensure quantity is set for removal logic
          itemEl.addEventListener("click", () =>
            removeTradeItemFromOffer(itemEl)
          );
        }
        itemsGrid.appendChild(itemEl);
      }
    }
  }

  // Update currency display
  currencyInput.value = offer.currency || 0;

  // Update local state cache (important for subsequent offer changes/validation)
  if (isMyOffer) {
    uiState.tradeSession.myOffer = { ...offer }; // Update cached self offer
    populateTradeInventory(); // Refresh available inventory based on new offer
  } else {
    uiState.tradeSession.partnerOffer = { ...offer }; // Update cached partner offer
  }
}

/** Updates the visual confirmation status indicators in the trade panel. */
export function updateTradeConfirmationStatus(myConfirmed, partnerConfirmed) {
  // Update local state cache
  uiState.tradeSession.myConfirmed = myConfirmed;
  uiState.tradeSession.partnerConfirmed = partnerConfirmed;

  // Update UI indicators (text and styles)
  if (uiState.selfTradeStatusSpan) {
    uiState.selfTradeStatusSpan.textContent = myConfirmed ? "Confirmed" : "";
    uiState.selfTradeStatusSpan.classList.toggle("visible", myConfirmed);
  }
  if (uiState.partnerTradeStatusSpan) {
    uiState.partnerTradeStatusSpan.textContent = partnerConfirmed
      ? "Confirmed"
      : "";
    uiState.partnerTradeStatusSpan.classList.toggle(
      "visible",
      partnerConfirmed
    );
  }
  if (uiState.selfTradeOfferDiv)
    uiState.selfTradeOfferDiv.classList.toggle("confirmed", myConfirmed);
  if (uiState.partnerTradeOfferDiv)
    uiState.partnerTradeOfferDiv.classList.toggle(
      "confirmed",
      partnerConfirmed
    );

  // Update confirm button state and text
  if (uiState.tradeConfirmBtn) {
    const canConfirmFinal = myConfirmed && partnerConfirmed;
    // Button should be enabled unless self is already confirmed AND partner is NOT yet confirmed
    const enableButton = !myConfirmed || canConfirmFinal;

    uiState.tradeConfirmBtn.disabled = !enableButton;
    uiState.tradeConfirmBtn.textContent = myConfirmed
      ? "Waiting..."
      : "Confirm Trade";
    uiState.tradeConfirmBtn.classList.remove("flash-green"); // Remove flash effect

    if (canConfirmFinal) {
      uiState.tradeConfirmBtn.textContent = "ACCEPT TRADE";
      uiState.tradeConfirmBtn.classList.add("flash-green"); // Add flash effect
      // Remove flash after animation? Or let CSS handle it.
    }
  }
}

/** Opens and initializes the trade panel UI. */
export function showTradePanel(tradeId, partnerId, partnerName) {
  if (!uiState.tradePanel || !CLIENT_CONFIG) return;

  console.log(`Starting trade ${tradeId} with ${partnerName} (${partnerId})`);

  // Reset and store trade session state
  uiState.isTrading = true;
  uiState.tradeSession = {
    tradeId: tradeId,
    partnerId: partnerId,
    partnerName: partnerName,
    myOffer: { items: {}, currency: 0 },
    partnerOffer: { items: {}, currency: 0 },
    myConfirmed: false,
    partnerConfirmed: false,
  };

  // Update panel header text safely
  if (uiState.tradePartnerNameSpan)
    uiState.tradePartnerNameSpan.textContent = escapeHtml(partnerName);
  if (uiState.tradePartnerNameDisplaySpan)
    uiState.tradePartnerNameDisplaySpan.textContent = escapeHtml(partnerName);

  // Clear offer areas and reset confirmation status visuals
  updateTradePanelOffers(true, { items: {}, currency: 0 }); // Clear self offer
  updateTradePanelOffers(false, { items: {}, currency: 0 }); // Clear partner offer
  updateTradeConfirmationStatus(false, false); // Reset confirmations

  // Populate available inventory for trading
  populateTradeInventory();

  // Make sure currency input is editable for self, readonly for partner
  if (uiState.selfTradeCurrencyInput)
    uiState.selfTradeCurrencyInput.readOnly = false;
  if (uiState.partnerTradeCurrencyInput)
    uiState.partnerTradeCurrencyInput.readOnly = true;

  // Show the panel
  uiState.tradePanel.style.display = "flex"; // Use flex display
}

/** Hides and resets the trade panel state. */
export function hideTradePanel() {
  if (uiState.tradePanel) uiState.tradePanel.style.display = "none"; // Hide panel

  // Reset trade state flags and data
  uiState.isTrading = false;
  uiState.tradeSession = {
    tradeId: null,
    partnerId: null,
    partnerName: null,
    myOffer: { items: {}, currency: 0 },
    partnerOffer: { items: {}, currency: 0 },
    myConfirmed: false,
    partnerConfirmed: false,
  };

  // Reset UI elements to default state
  if (uiState.tradePartnerNameSpan)
    uiState.tradePartnerNameSpan.textContent = "...";
  if (uiState.tradePartnerNameDisplaySpan)
    uiState.tradePartnerNameDisplaySpan.textContent = "Partner";
  if (uiState.selfTradeOfferDiv)
    uiState.selfTradeOfferDiv.querySelector(".trade-items-grid").innerHTML = "";
  if (uiState.partnerTradeOfferDiv)
    uiState.partnerTradeOfferDiv.querySelector(".trade-items-grid").innerHTML =
      "";
  if (uiState.selfTradeCurrencyInput) {
    uiState.selfTradeCurrencyInput.value = 0;
    uiState.selfTradeCurrencyInput.readOnly = true;
  }
  if (uiState.partnerTradeCurrencyInput) {
    uiState.partnerTradeCurrencyInput.value = 0;
    uiState.partnerTradeCurrencyInput.readOnly = true;
  }
  if (uiState.tradeInventoryAreaDiv)
    uiState.tradeInventoryAreaDiv.innerHTML = "";
  updateTradeConfirmationStatus(false, false); // Reset confirm button and indicators
}

/** Handles an incoming trade request - shows notification with accept/decline actions. */
export function handleTradeRequest(tradeId, requesterName) {
  if (uiState.isTrading) {
    // Already trading, automatically decline? Send busy message?
    console.log(
      "Received trade request while already trading. Auto-declining."
    );
    respondToTradeRequest(tradeId, false); // Send decline response
    showNotification(
      `${escapeHtml(requesterName)} tried to trade, but you are busy.`,
      "info"
    );
    return;
  }

  const message = `${escapeHtml(requesterName)} wants to trade!`;
  const actions = [
    {
      label: "Accept",
      action: () => respondToTradeRequest(tradeId, true),
      type: "success",
    },
    {
      label: "Decline",
      action: () => respondToTradeRequest(tradeId, false),
      type: "error",
    },
  ];

  // Show notification with buttons and auto-decline timeout
  showNotificationWithActions(
    message,
    actions,
    null, // Duration is ignored when autoDeclineTimeout is set
    "info", // Notification type
    CLIENT_CONFIG.TRADE_REQUEST_TIMEOUT // Auto-decline after timeout
  );
  playSound("info"); // Play notification sound
}
// --- End Trade UI Functions ---
