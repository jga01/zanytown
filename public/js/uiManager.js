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
  debounce, // Import debounce
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
  // Add Trade Network Functions
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
        roomsListContent: "roomsListContent",
        adminRoomList: "adminRoomListDiv",
        adminLayoutTileType: "layoutTileTypeSelector",
        debugDiv: "debugDiv",
        notificationContainer: "notificationContainer",
      };
      if (keyMappings[camelCaseKey]) {
        camelCaseKey = keyMappings[camelCaseKey];
      }

      // Map trade panel specific keys
      const tradeKeyMappings = {
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
      if (tradeKeyMappings[camelCaseKey]) {
        camelCaseKey = tradeKeyMappings[camelCaseKey];
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
            "inventoryItemsDiv",
            "currencyDisplay",
            "loadingOverlay",
            "loadingMessage",
            "bottomBar",
            "contextMenu",
            "roomsListContent",
            "notificationContainer",
            // Add trade panel elements as critical if needed
            "tradePanel",
            "selfTradeOfferDiv",
            "partnerTradeOfferDiv",
            "selfTradeCurrencyInput",
            "partnerTradeCurrencyInput",
            "tradeInventoryAreaDiv",
            "tradeConfirmBtn",
            "tradeCancelBtn",
            "tradeCloseBtn",
          ];
          if (criticalElements.includes(camelCaseKey)) {
            console.error(
              `CRITICAL UI element missing: ${camelCaseKey} (#${elementId})`
            );
            allElementsFound = false;
          } else {
            // Optional elements can have warnings
            if (camelCaseKey !== "shopCloseBtn") {
              // Example optional element
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
    allElementsFound = false;
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
        togglePanel(camelCaseSuffix, false);
      }
    });
  });

  // Context menu interaction (delegation)
  if (uiState.contextMenu) {
    uiState.contextMenu.addEventListener("click", handleContextMenuClick);
    document.addEventListener(
      "click",
      (event) => {
        if (
          uiState.contextMenu &&
          uiState.contextMenu.style.display !== "none" &&
          !uiState.contextMenu.contains(event.target)
        ) {
          hideContextMenu();
        }
      },
      true
    );
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
    const initialChecked = uiState.layoutTileTypeSelector.querySelector(
      'input[name="layout-paint-type"]:checked'
    );
    if (initialChecked) {
      selectedLayoutPaintType =
        initialChecked.value === "X" ? "X" : parseInt(initialChecked.value, 10);
    } else {
      selectedLayoutPaintType = 0;
      const defaultRadio = uiState.layoutTileTypeSelector.querySelector(
        'input[name="layout-paint-type"][value="0"]'
      );
      if (defaultRadio) defaultRadio.checked = true;
    }
  } else {
    console.warn("Admin layout tile type selector not found.");
  }

  // Add listeners for trade panel buttons
  if (uiState.tradeCloseBtn) {
    uiState.tradeCloseBtn.addEventListener("click", () => {
      if (uiState.isTrading && uiState.tradeSession.tradeId) {
        cancelTrade(uiState.tradeSession.tradeId); // Send cancel request
      }
      hideTradePanel(); // Hide immediately client-side
    });
  }
  if (uiState.tradeCancelBtn) {
    // Explicit cancel button
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
        // Disable button immediately after clicking confirm? Or wait for server confirmation.
        // uiState.tradeConfirmBtn.disabled = true;
      }
    });
  }
  // Listener for currency input change
  if (uiState.selfTradeCurrencyInput) {
    // Use debounce wrapper for event listener
    uiState.selfTradeCurrencyInput.addEventListener(
      "input",
      debouncedUpdateOffer
    ); // Update more frequently on input
  }

  if (!uiState.notificationContainer) {
    console.error("CRITICAL UI element missing: Notification Container");
    allElementsFound = false;
  }

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
    uiState.loadingOverlay.style.display = "flex";
  } else {
    if (CLIENT_CONFIG) {
      console.warn("showLoadingOverlay called but loading elements not found.");
    }
  }
}

/** Hides the loading overlay smoothly. */
export function hideLoadingOverlay() {
  if (uiState.loadingOverlay) {
    uiState.loadingOverlay.classList.add("hidden");
    setTimeout(() => {
      if (uiState.loadingOverlay?.classList.contains("hidden")) {
        uiState.loadingOverlay.style.display = "none";
      }
    }, 300);
  }
}

/** Toggle Panel Visibility */
export function togglePanel(panelIdSuffix, forceState = undefined) {
  const panelKey = panelIdSuffix + "Panel";
  const panel = uiState[panelKey];
  let buttonKey =
    "toggle" +
    panelIdSuffix.charAt(0).toUpperCase() +
    panelIdSuffix.slice(1) +
    "Btn";
  if (panelIdSuffix === "edit") buttonKey = "toggleEditBottomBtn";
  const button = uiState[buttonKey];

  if (!panel) {
    console.warn(`Panel element not found for suffix: ${panelIdSuffix}`);
    return;
  }

  const shouldBeOpen =
    forceState !== undefined ? forceState : panel.style.display === "none";

  if (
    shouldBeOpen &&
    uiState.activePanelId != null &&
    uiState.activePanelId !== panelIdSuffix
  ) {
    togglePanel(uiState.activePanelId, false);
  }

  panel.style.display = shouldBeOpen ? "flex" : "none";

  if (button) {
    button.classList.toggle("active", shouldBeOpen);
  } else {
    if (panelIdSuffix !== "edit") {
      console.warn(
        `Toggle button not found for panel suffix: ${panelIdSuffix}`
      );
    }
  }

  uiState.activePanelId = shouldBeOpen ? panelIdSuffix : null;

  if (shouldBeOpen) {
    if (panelIdSuffix === "inventory") populateInventory();
    else if (panelIdSuffix === "shop") populateShopPanel();
    else if (panelIdSuffix === "admin") requestAllRoomIds();
    else if (panelIdSuffix === "rooms") {
      if (isConnected()) requestPublicRooms();
      else if (uiState.roomsListContent)
        uiState.roomsListContent.innerHTML = "<p><i>Not connected.</i></p>";
    } else if (panelIdSuffix === "debug") updateDebugInfo();
  }

  hideContextMenu();
}

/** Resets UI elements to their default/loading state. */
export function resetUIState() {
  console.log("Resetting UI State...");
  showLoadingOverlay("Loading Room...");

  if (uiState.activePanelId && uiState.activePanelId !== null) {
    togglePanel(uiState.activePanelId, false);
  }
  uiState.activePanelId = null;

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
    uiState.roomsListContent.innerHTML = "<p><i>...</i></p>";

  hideProfilePanel();
  hideRecolorPanel();
  hideTradePanel(); // Hide trade panel on reset

  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Loading...";
  if (uiState.currencyDisplay)
    uiState.currencyDisplay.textContent = "Silly Coins: ...";
  document.title = "ZanyTown - Loading...";

  uiState.isEditMode = false;
  if (CLIENT_CONFIG) uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  else uiState.editMode.state = "navigate";
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;

  updateInventorySelection();
  updateUICursor();
  hideContextMenu();

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

  updateAdminUI();
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
  p.textContent = message;
  if (isSelf) p.classList.add("self-msg");
  if (className)
    className.split(" ").forEach((cls) => {
      if (cls) p.classList.add(cls.trim());
    });
  const div = uiState.chatLogDiv;
  const isScrolledToBottom =
    Math.abs(div.scrollHeight - div.clientHeight - div.scrollTop) < 5;
  div.appendChild(p);
  uiState.chatMessages.push(p);
  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    const oldMessage = uiState.chatMessages.shift();
    oldMessage?.remove();
  }
  if (isScrolledToBottom)
    setTimeout(() => {
      div.scrollTop = div.scrollHeight;
    }, 0);
}

/** Updates positions of active chat bubbles and removes expired ones. */
export function updateChatBubbles(currentTime) {
  if (!uiState.bubbleContainer || !CLIENT_CONFIG) return;
  for (let i = uiState.activeChatBubbles.length - 1; i >= 0; i--) {
    const bubble = uiState.activeChatBubbles[i];
    if (!bubble || typeof bubble !== "object") {
      uiState.activeChatBubbles.splice(i, 1);
      continue;
    }
    if (currentTime > bubble.endTime) {
      bubble.element?.remove();
      uiState.activeChatBubbles.splice(i, 1);
      if (bubble.avatarId) {
        const owner = gameState.avatars[bubble.avatarId];
        if (owner && owner.chatBubble?.id === bubble.id)
          owner.chatBubble = null;
      }
    } else {
      updateChatBubblePosition(bubble);
    }
  }
}

/** Creates or updates the position of a single chat bubble element. */
function updateChatBubblePosition(bubble) {
  if (!bubble || !uiState.bubbleContainer || !bubble.avatarId) return;
  const avatar = gameState.avatars[bubble.avatarId];
  if (!avatar) {
    bubble.element?.remove();
    bubble.endTime = 0;
    return;
  }
  if (!bubble.element) {
    bubble.element = document.createElement("div");
    bubble.element.id = bubble.id;
    bubble.element.className = "chat-bubble";
    bubble.element.textContent = bubble.text;
    uiState.bubbleContainer.appendChild(bubble.element);
  }
  if (!SHARED_CONFIG || !CLIENT_CONFIG || !camera) return;
  const screenPos = getScreenPos(avatar.visualX, avatar.visualY);
  const zoom = camera.zoom;
  const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
  const headHeight = totalHeight * 0.3;
  const zOffsetPx = avatar.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
  const baseY =
    screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx;
  const bodyY = baseY - totalHeight * 0.7;
  const headTopY = bodyY - headHeight;
  const verticalOffsetAboveHead = 15 * zoom;
  requestAnimationFrame(() => {
    if (!bubble.element) return;
    bubble.element.style.transform = `translate(-50%, calc(-100% - ${verticalOffsetAboveHead}px)) translate(${screenPos.x}px, ${headTopY}px)`;
  });
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
    const stackHeight = getClientStackHeightAt(ht.x, ht.y);
    tileInfo = ` Tile(${ht.x},${ht.y}) L:${tLayout ?? "?"} ${
      topFurni
        ? `Top:${escapeHtml(
            topFurni.definition?.name || "?"
          )}(Z:${topFurni.visualZ.toFixed(2)}) `
        : ""
    }StackZ:${stackHeight.toFixed(2)}`;
  }
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

/** Populates the inventory UI panel. */
export function populateInventory() {
  if (!uiState.inventoryItemsDiv || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    if (uiState.inventoryItemsDiv)
      uiState.inventoryItemsDiv.innerHTML = "<p><i>Error.</i></p>";
    return;
  }
  uiState.inventoryItemsDiv.innerHTML = "";
  const inventory = gameState.inventory;
  const ownedItemIds = Object.keys(inventory || {}).filter(
    (id) => inventory[id] > 0
  );
  if (ownedItemIds.length === 0) {
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
    if (
      uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING &&
      !inventory[uiState.editMode.selectedInventoryItemId]
    )
      setSelectedInventoryItem(null);
    return;
  }
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
    if (!def) return;
    const itemDiv = document.createElement("div");
    itemDiv.className = "inventory-item";
    itemDiv.dataset.itemId = def.id;
    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = def.color || "#8B4513";
    itemDiv.appendChild(previewSpan);
    itemDiv.appendChild(
      document.createTextNode(` ${escapeHtml(def.name)} (x${quantity})`)
    );
    itemDiv.title = `${escapeHtml(def.name)} (${def.width}x${def.height})${
      def.canSit ? " (Sit)" : ""
    }${def.stackable ? " (Stack)" : ""}${def.canUse ? " (Use)" : ""}${
      def.canRecolor ? " (Recolor)" : ""
    }`;
    itemDiv.addEventListener("click", () => {
      if (uiState.isEditMode) {
        setSelectedInventoryItem(def.id);
        playSound("select");
      } else {
        itemDiv.classList.add("flash-red");
        setTimeout(() => itemDiv.classList.remove("flash-red"), 600);
        showNotification(
          "Enable 'Edit' mode (bottom bar) to place items!",
          "info"
        );
      }
    });
    uiState.inventoryItemsDiv.appendChild(itemDiv);
  });
  updateInventorySelection();
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

/** Updates the player currency display. */
export function updateCurrencyDisplay() {
  if (!uiState.currencyDisplay) {
    console.warn("Currency display element not found.");
    return;
  }
  const currentText = uiState.currencyDisplay.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)
    ? currentText.match(/\d+/)[0]
    : "0";
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency;
  uiState.currencyDisplay.textContent = `Silly Coins: ${newValue}`;
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
    }, 600);
  }
}

/** Shows the shop panel. */
export function showShopPanel() {
  togglePanel("shop", true);
}
/** Hides the shop panel. */
export function hideShopPanel() {
  togglePanel("shop", false);
}

/** Populates the shop panel UI. */
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
  uiState.shopItemsDiv.innerHTML = "";
  if (
    !Array.isArray(SHARED_CONFIG.SHOP_CATALOG) ||
    SHARED_CONFIG.SHOP_CATALOG.length === 0
  ) {
    uiState.shopItemsDiv.innerHTML = "<p><i>Shop is empty!</i></p>";
    return;
  }
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
    if (!definition) return;
    const itemDiv = document.createElement("div");
    itemDiv.className = "shop-item";
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
    const priceSpan = document.createElement("span");
    priceSpan.className = "shop-item-price";
    priceSpan.textContent = `${shopEntry.price} Coins`;
    itemDiv.appendChild(priceSpan);
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
      buyButton.disabled = true;
      buyButton.textContent = "Buying...";
      requestBuyItem(shopEntry.itemId);
      setTimeout(updateShopButtonStates, 300);
    });
    itemDiv.appendChild(buyButton);
    uiState.shopItemsDiv.appendChild(itemDiv);
  });
  updateShopButtonStates();
}

/** Updates the enabled state of shop buy buttons. */
export function updateShopButtonStates() {
  if (!uiState.shopItemsDiv) return;
  uiState.shopItemsDiv.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = gameState.myCurrency >= price;
      button.disabled = !canAfford;
      button.classList.toggle("cannot-afford", !canAfford);
      if (button.textContent === "Buying...") button.textContent = "Buy";
    } else button.disabled = true;
  });
}

// --- User List & Profile UI ---

/** Populates the user list panel. */
export function updateUserListPanel(users) {
  if (!uiState.userListContent || !uiState.userListPanel) {
    console.warn("User list elements not found.");
    return;
  }
  uiState.userListContent.innerHTML = "";
  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${escapeHtml(gameState.currentRoomId)})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle;
  if (!users || !Array.isArray(users) || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }
  users.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  users.forEach((user) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(user.name || "Unknown");
    const userIdStr = String(user.id);
    li.dataset.userid = userIdStr;
    li.classList.toggle("self-user", userIdStr === gameState.myAvatarId);
    li.addEventListener("click", () => {
      if (userIdStr !== gameState.myAvatarId && isConnected())
        requestProfile(userIdStr);
    });
    uiState.userListContent.appendChild(li);
  });
}

/** Displays the profile panel. */
export function showProfilePanel(profileData) {
  if (!uiState.profilePanel || !uiState.profileContent) {
    console.warn("Profile panel elements not found.");
    return;
  }
  if (!profileData || !profileData.id) {
    console.warn("Invalid profile data.");
    return;
  }
  const name = profileData.name || "Unknown User";
  const id = String(profileData.id);
  const state = profileData.state || "Idle";
  const color = profileData.bodyColor || "#CCCCCC";
  const currency =
    profileData.currency === undefined
      ? "N/A"
      : `${profileData.currency} Coins`;
  uiState.profileContent.innerHTML = `
        <h4>${escapeHtml(name)}</h4>
        <p>Status: ${escapeHtml(state)}</p>
        <p>Look: <span class="profile-color-swatch" style="background-color: ${escapeHtml(
          color
        )};"></span> ${escapeHtml(color)}</p>
        <p>Coins: ${escapeHtml(currency)}</p>
        <div class="profile-actions"></div>`;
  uiState.profilePanel.dataset.targetId = id;
  uiState.profilePanel.style.display = "block";
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

/** Displays the recolor panel. */
export function showRecolorPanel(furniId) {
  const furniIdStr = String(furniId);
  const furni = gameState.furniture[furniIdStr];
  if (
    !uiState.recolorPanel ||
    !uiState.recolorSwatchesDiv ||
    !uiState.recolorItemNameP ||
    !furni ||
    !(furni instanceof ClientFurniture) ||
    !furni.canRecolor ||
    !SHARED_CONFIG?.VALID_RECOLOR_HEX
  ) {
    hideRecolorPanel();
    return;
  }
  uiState.activeRecolorFurniId = furniIdStr;
  uiState.recolorItemNameP.textContent = `Item: ${escapeHtml(
    furni.definition?.name || "Unknown"
  )}`;
  uiState.recolorSwatchesDiv.innerHTML = "";
  SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "recolor-swatch";
    swatch.style.backgroundColor = hex;
    swatch.title = hex;
    swatch.dataset.colorHex = hex;
    swatch.addEventListener("click", () => handleRecolorSwatchClick(hex));
    uiState.recolorSwatchesDiv.appendChild(swatch);
  });
  uiState.recolorPanel.style.display = "block";
}

/** Hides the recolor panel. */
export function hideRecolorPanel() {
  if (uiState.recolorPanel) uiState.recolorPanel.style.display = "none";
  uiState.activeRecolorFurniId = null;
}

/** Handles clicking a color swatch. */
function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor);
    hideRecolorPanel();
  } else console.warn("No active item or not connected.");
}

// --- Admin UI Functions ---

/** Shows or hides admin UI elements. */
export function updateAdminUI() {
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const isAdmin = player?.isAdmin || false;
  const displayStyle = isAdmin ? "flex" : "none";
  if (uiState.toggleAdminBtn) {
    uiState.toggleAdminBtn.style.display = displayStyle;
    uiState.toggleAdminBtn.disabled = !isAdmin || !isConnected();
  }
  if (!isAdmin && uiState.activePanelId === "admin")
    togglePanel("admin", false);
}

/** Populates the admin room list. */
export function updateAdminRoomList(roomIds) {
  if (!uiState.adminRoomListDiv) {
    console.warn("Admin room list div not found.");
    return;
  }
  uiState.adminRoomListDiv.innerHTML = "";
  if (!roomIds || !Array.isArray(roomIds) || roomIds.length === 0) {
    uiState.adminRoomListDiv.textContent = "No rooms found.";
    return;
  }
  const ul = document.createElement("ul");
  roomIds.sort();
  roomIds.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(id);
    li.title = `Click to join ${escapeHtml(id)}`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      console.log(`Admin joining room via list: ${id}`);
      requestChangeRoom(id);
      togglePanel("admin", false);
    });
    ul.appendChild(li);
  });
  uiState.adminRoomListDiv.appendChild(ul);
}

/** Handles admin create room button click. */
function handleCreateRoomClick() {
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!player?.isAdmin) {
    showNotification("Admin permissions required.", "error");
    return;
  }
  const newRoomId = prompt("Enter ID for new room:");
  if (newRoomId && newRoomId.trim()) {
    const sanitizedId = newRoomId.trim().toLowerCase().replace(/\s+/g, "_");
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
      alert("Invalid dimensions.");
      return;
    }
    requestCreateRoom(sanitizedId, cols, rows);
  } else if (newRoomId !== null) alert("Invalid room ID.");
}

// --- Room List Population ---
/** Populates the rooms panel UI. */
export function populateRoomsPanel(roomData) {
  if (!uiState.roomsListContent) {
    console.warn("Rooms list content div not found.");
    return;
  }
  uiState.roomsListContent.innerHTML = "";
  if (!Array.isArray(roomData) || roomData.length === 0) {
    uiState.roomsListContent.innerHTML =
      "<p><i>No public rooms available.</i></p>";
    return;
  }
  roomData.sort((a, b) => (a.id || "").localeCompare(b.id || ""));
  roomData.forEach((roomInfo) => {
    const roomDiv = document.createElement("div");
    roomDiv.className = "room-list-item";
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
    if (roomInfo.id === gameState.currentRoomId) {
      roomDiv.classList.add("current-room");
    } else {
      roomDiv.addEventListener("click", () => {
        if (isConnected()) {
          requestChangeRoom(roomInfo.id);
          togglePanel("rooms", false);
        } else showNotification("Not connected.", "error");
      });
    }
    uiState.roomsListContent.appendChild(roomDiv);
  });
}

// --- Edit Mode State Management ---

/** Sets the current edit mode sub-state. */
export function setEditState(newState) {
  if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;
  const oldState = uiState.editMode.state;
  uiState.editMode.state = newState;
  console.log(`Edit state changed from ${oldState} to ${newState}`);
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
    setSelectedFurniture(null);
    hideRecolorPanel();
  }
  updateInventorySelection();
  updateUICursor();
  updateHighlights();
  hideContextMenu();
}

/** Sets the currently selected inventory item. */
export function setSelectedInventoryItem(definitionId) {
  console.log(`Setting selected inventory item: ${definitionId}`);
  uiState.editMode.selectedInventoryItemId = definitionId;
  uiState.editMode.placementRotation = 0;
  if (definitionId) {
    setSelectedFurniture(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING);
  } else if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }
  updateInventorySelection();
  updateHighlights();
  hideContextMenu();
}

/** Sets the currently selected floor furniture. */
export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null;
  const oldSelectedId = uiState.editMode.selectedFurnitureId;
  if (oldSelectedId === newSelectedId) {
    if (newSelectedId !== null) setSelectedFurniture(null);
    return;
  }
  console.log(`Setting selected floor furniture: ${newSelectedId}`);
  if (oldSelectedId && gameState.furniture[oldSelectedId])
    gameState.furniture[oldSelectedId].isSelected = false;
  uiState.editMode.selectedFurnitureId = newSelectedId;
  if (newSelectedId && gameState.furniture[newSelectedId]) {
    gameState.furniture[newSelectedId].isSelected = true;
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI);
  } else {
    uiState.editMode.selectedFurnitureId = null;
    hideRecolorPanel();
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI)
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }
  updateHighlights();
  hideContextMenu();
}

/** Toggles the main edit mode. */
export function toggleEditMode() {
  if (!CLIENT_CONFIG || !uiState.toggleEditBottomBtn) {
    console.warn("Edit button not found.");
    return;
  }
  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);
  uiState.toggleEditBottomBtn.classList.toggle("active", uiState.isEditMode);
  if (!uiState.isEditMode) {
    setSelectedFurniture(null);
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    hideRecolorPanel();
    hideContextMenu();
  } else setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  updateInventorySelection();
  updateHighlights();
  updateUICursor();
}

// --- Input Click Handlers ---

/** Handles clicks on the canvas when in Edit Mode. */
export function handleEditModeClick(gridPos, screenPos) {
  if (!CLIENT_CONFIG || !SHARED_CONFIG || !gameState.currentRoomId) return;
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  const canLayoutEdit =
    uiState.isEditMode &&
    player?.isAdmin &&
    uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  if (canLayoutEdit) {
    if (
      gridPos.x >= 0 &&
      gridPos.x < gameState.roomCols &&
      gridPos.y >= 0 &&
      gridPos.y < gameState.roomRows
    ) {
      requestModifyLayout(
        gameState.currentRoomId,
        gridPos.x,
        gridPos.y,
        selectedLayoutPaintType
      );
      playSound("place");
    } else showNotification(`Cannot modify layout outside bounds.`, "warning");
    return;
  }
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
        } else {
          showNotification("You don't have that item anymore.", "error");
          setSelectedInventoryItem(null);
        }
      } else showNotification("Cannot place item there.", "error");
      break;
    case CLIENT_CONFIG.EDIT_STATE_NAVIGATE:
    case CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI:
      if (
        screenPos === null &&
        uiState.contextMenuTarget?.action === "place_item_here"
      ) {
        /* Handled by PLACING case */
      } else if (screenPos !== null) {
        const clickedFurniture = getTopmostFurnitureAtScreen(
          screenPos.x,
          screenPos.y
        );
        if (clickedFurniture) {
          if (clickedFurniture.id !== uiState.editMode.selectedFurnitureId)
            setSelectedFurniture(clickedFurniture.id);
        } else {
          setSelectedFurniture(null);
          hideRecolorPanel();
        }
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
  const clickedAvatar = screenPos
    ? getAvatarAtScreen(screenPos.x, screenPos.y)
    : null;
  const clickedFurniture = screenPos
    ? getTopmostFurnitureAtScreen(screenPos.x, screenPos.y)
    : null;
  if (clickedAvatar) {
    if (clickedAvatar.id !== gameState.myAvatarId)
      requestProfile(clickedAvatar.id);
    else
      showNotification(
        `You clicked yourself (${escapeHtml(clickedAvatar.name)}).`,
        "info"
      );
    return;
  }
  if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
    if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
      requestStand();
      return;
    }
  }
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
      return;
    }
    if (clickedFurniture.definition?.canUse) {
      requestUseFurni(clickedFurniture.id);
      playSound("use");
      return;
    }
    if (clickedFurniture.definition?.canSit) {
      requestSit(clickedFurniture.id);
      return;
    }
  }
  if (isClientWalkable(gridPos.x, gridPos.y)) requestMove(gridPos.x, gridPos.y);
  else if (!clickedFurniture) showNotification("Cannot walk there.", "error");
}

/** Handles the click of the pickup furniture action. */
export function handlePickupFurniClick() {
  const targetId = uiState.contextMenuTarget?.id;
  if (uiState.isEditMode && targetId && isConnected())
    requestPickupFurni(targetId);
  else showNotification("Cannot pick up item now.", "info");
}

/** Handles the click of the recolor furniture action. */
export function handleRecolorFurniClick() {
  const targetId = uiState.contextMenuTarget?.id;
  if (uiState.isEditMode && targetId) {
    const furni = gameState.furniture[targetId];
    if (furni?.canRecolor) showRecolorPanel(furni.id);
    else showNotification("This item cannot be recolored.", "info");
  } else showNotification("Cannot recolor item now.", "info");
}

// --- Context Menu Functions ---

/** Hides the custom context menu. */
export function hideContextMenu() {
  if (uiState.contextMenu) {
    uiState.contextMenu.style.display = "none";
    const ul = uiState.contextMenu.querySelector("ul");
    if (ul) ul.innerHTML = "";
    uiState.contextMenuTarget = null;
  }
}

/** Shows the custom context menu. */
export function showContextMenu(screenX, screenY, target) {
  if (!uiState.contextMenu || !target || !CLIENT_CONFIG || !SHARED_CONFIG) {
    return;
  }
  hideContextMenu();
  uiState.contextMenuTarget = target;
  const menuUl = uiState.contextMenu.querySelector("ul");
  if (!menuUl) {
    console.error("Context menu UL not found!");
    return;
  }
  menuUl.innerHTML = "";
  const menuItems = getContextMenuActions(target);
  if (menuItems.length === 0) return;
  menuItems.forEach((item) => {
    const li = document.createElement("li");
    if (item.separator) li.className = "separator";
    else {
      li.textContent = item.label || "Action";
      li.dataset.action = item.action || "none";
      if (item.disabled) li.classList.add("disabled");
    }
    menuUl.appendChild(li);
  });
  const menuWidth = uiState.contextMenu.offsetWidth;
  const menuHeight = uiState.contextMenu.offsetHeight;
  const canvasRect = uiState.canvas?.getBoundingClientRect();
  if (!canvasRect) return;
  let menuX = screenX;
  let menuY = screenY;
  if (menuX + menuWidth > canvasRect.width) menuX = screenX - menuWidth;
  if (menuY + menuHeight > canvasRect.height) menuY = screenY - menuHeight;
  if (menuX < 0) menuX = 5;
  if (menuY < 0) menuY = 5;
  uiState.contextMenu.style.left = `${menuX}px`;
  uiState.contextMenu.style.top = `${menuY}px`;
  uiState.contextMenu.style.display = "block";
}

/** Determines context menu actions based on the target. */
function getContextMenuActions(target) {
  const actions = [];
  const isEditing = uiState.isEditMode;
  const player = gameState.myAvatarId
    ? gameState.avatars[gameState.myAvatarId]
    : null;
  if (!SHARED_CONFIG || !CLIENT_CONFIG) return [];

  if (target.type === "avatar") {
    const avatar = gameState.avatars[target.id];
    if (!avatar) return [];
    if (target.id !== gameState.myAvatarId) {
      actions.push({
        label: `Profile: ${escapeHtml(avatar.name)}`,
        action: "profile",
      });
      // Add Trade Action
      actions.push({
        label: `Trade with ${escapeHtml(avatar.name)}`,
        action: "trade",
        disabled: uiState.isTrading,
      });
    } else {
      actions.push({
        label: "Stand Up",
        action: "stand",
        disabled:
          !player || player.state !== SHARED_CONFIG.AVATAR_STATE_SITTING,
      });
    }
    if (player?.isAdmin && target.id !== gameState.myAvatarId) {
      actions.push({ separator: true });
      actions.push({
        label: `Kick ${escapeHtml(avatar.name)}`,
        action: "admin_kick",
      });
    }
  } else if (target.type === "furniture") {
    const furni = gameState.furniture[target.id];
    if (!furni || !furni.definition) return [];
    const def = furni.definition;
    const isOwner =
      gameState.myUserId &&
      furni.ownerId &&
      String(furni.ownerId) === gameState.myUserId;
    const occupied = isFurnitureOccupied(target.id);
    if (isEditing) {
      if (isOwner || player?.isAdmin) {
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
      } else
        actions.push({ label: `(Not Owner)`, action: "none", disabled: true });
      if (def.canUse)
        actions.push({ label: `Use ${escapeHtml(def.name)}`, action: "use" });
    } else {
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
        });
    }
  } else if (target.type === "tile") {
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
        label: `Place Item Here`,
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
  }
  return actions;
}

// Helper for context menu
function isFurnitureOccupied(furniDbId) {
  if (!furniDbId) return false;
  const idString = String(furniDbId);
  return Object.values(gameState.avatars || {}).some(
    (a) => a instanceof ClientAvatar && String(a.sittingOnFurniId) === idString
  );
}

/** Handles clicks on context menu items. */
function handleContextMenuClick(event) {
  const targetLi = event.target.closest("li");
  if (
    !targetLi ||
    targetLi.classList.contains("disabled") ||
    targetLi.classList.contains("separator")
  ) {
    hideContextMenu();
    return;
  }
  const action = targetLi.dataset.action;
  const targetInfo = uiState.contextMenuTarget;
  if (!action || !targetInfo || action === "none") {
    hideContextMenu();
    return;
  }
  console.log(
    `Context Menu Action: ${action} on ${targetInfo.type} ${
      targetInfo.id || `(${targetInfo.x},${targetInfo.y})`
    }`
  );
  switch (action) {
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
      if (targetInfo.type === "furniture" && targetInfo.id)
        handlePickupFurniClick();
      break;
    case "rotate":
      if (targetInfo.type === "furniture" && targetInfo.id)
        requestRotateFurni(targetInfo.id);
      break;
    case "recolor":
      if (targetInfo.type === "furniture" && targetInfo.id)
        handleRecolorFurniClick();
      break;
    case "place_item_here":
      if (
        targetInfo.type === "tile" &&
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
        targetInfo.x != null &&
        targetInfo.y != null
      )
        handleEditModeClick(targetInfo, null);
      break;
    case "walk_here":
      if (
        targetInfo.type === "tile" &&
        !uiState.isEditMode &&
        targetInfo.x != null &&
        targetInfo.y != null
      )
        handleNavigateModeClick(targetInfo, null);
      break;
    case "paint_tile":
      if (
        targetInfo.type === "tile" &&
        uiState.isEditMode &&
        gameState.avatars[gameState.myAvatarId]?.isAdmin &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE &&
        targetInfo.x != null &&
        targetInfo.y != null
      )
        handleEditModeClick(targetInfo, null);
      break;
    case "admin_kick":
      if (targetInfo.type === "avatar" && targetInfo.id) {
        const a = gameState.avatars[targetInfo.id];
        if (a) sendChat(`/kick ${a.name}`);
      }
      break;
    default:
      console.warn(`Unhandled context menu action: ${action}`);
      break;
  }
  hideContextMenu();
}

// --- Highlighting Logic ---

/** Updates tile and furniture highlights. */
export function updateHighlights() {
  if (
    !CLIENT_CONFIG ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.clientTiles ||
    !inputState
  )
    return;
  clearAllHighlights();
  const gridPos = inputState.currentMouseGridPos || { x: -1, y: -1 };
  const screenPos = inputState.currentMouseScreenPos || { x: -1, y: -1 };
  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    gameState.highlightedTile = null;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
    )
      uiState.editMode.placementValid = false;
    return;
  }
  gameState.highlightedTile = { x: gridPos.x, y: gridPos.y };
  if (uiState.isEditMode) {
    if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
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
        const tempFurniProto = {
          x: gridPos.x,
          y: gridPos.y,
          definition: definition,
          getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles,
        };
        tempFurniProto
          .getOccupiedTiles()
          .forEach((tp) => setTileHighlight(tp.x, tp.y, color));
      } else
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        );
    } else {
      const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
      const player = gameState.myAvatarId
        ? gameState.avatars[gameState.myAvatarId]
        : null;
      const canLayoutEdit =
        player?.isAdmin &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
      if (canLayoutEdit)
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        );
      else if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId)
        hoveredF
          .getOccupiedTiles()
          .forEach((tp) =>
            setTileHighlight(
              tp.x,
              tp.y,
              CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
            )
          );
      else if (!hoveredF && gameState.highlightedTile)
        setTileHighlight(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y,
          CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
        );
    }
  } else {
    const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
    if (
      hoveredF &&
      (hoveredF.isDoor ||
        hoveredF.definition?.canUse ||
        hoveredF.definition?.canSit)
    )
      hoveredF
        .getOccupiedTiles()
        .forEach((tp) =>
          setTileHighlight(
            tp.x,
            tp.y,
            CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
          )
        );
    else if (
      gameState.highlightedTile &&
      isClientWalkable(gameState.highlightedTile.x, gameState.highlightedTile.y)
    )
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      );
  }
  if (
    gameState.highlightedTile &&
    !isValidClientTile(gameState.highlightedTile.x, gameState.highlightedTile.y)
  )
    gameState.highlightedTile = null;
}

/** Checks if placement is valid client-side. */
export function isClientPlacementValid(definition, gridX, gridY) {
  if (
    !definition ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.furniture
  )
    return false;
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
    if (!isValidClientTile(gx, gy)) return false;
    const tileType = getTileLayoutType(gx, gy);
    if (tileType === 1 || tileType === "X") return false;
    if (!definition.isFlat) {
      const stackOnThisTile = Object.values(gameState.furniture).filter(
        (f) =>
          f instanceof ClientFurniture &&
          Math.round(f.visualX) === gx &&
          Math.round(f.visualY) === gy
      );
      const topItemOnThisTile = stackOnThisTile.sort(
        (a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0)
      )[0];
      if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable)
        return false;
      if (isClientOccupiedBySolid(gx, gy)) {
        const solidBlocker = stackOnThisTile.find(
          (f) =>
            !f.definition?.isWalkable &&
            !f.definition?.isFlat &&
            !f.definition?.stackable
        );
        if (solidBlocker) return false;
      }
    }
  }
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
    if (topItemOnBase && !topItemOnBase.definition?.stackable) return false;
  }
  const estimatedBaseZ = getClientStackHeightAt(gridX, gridY);
  const itemBaseZ = estimatedBaseZ + (definition.zOffset || 0);
  const itemStackHeight =
    definition.stackHeight ?? (definition.isFlat ? 0 : 1.0);
  const itemStackContrib =
    itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
  const itemTopZ = itemBaseZ + (definition.isFlat ? 0 : itemStackContrib);
  const epsilon = 0.001;
  if (itemTopZ >= (SHARED_CONFIG.MAX_STACK_Z || 5.0) - epsilon) return false;
  return true;
}

/** Sets highlight color for a tile. */
function setTileHighlight(x, y, color) {
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  if (tile) tile.highlight = color;
}

/** Clears all tile highlights. */
function clearAllHighlights() {
  if (!gameState.clientTiles) return;
  gameState.clientTiles.forEach((t) => (t.highlight = null));
}

// --- Helper & Calculation Functions ---

/** Calculates stack height at coordinates client-side. */
export function getClientStackHeightAt(gridX, gridY) {
  if (!SHARED_CONFIG || !gameState.currentRoomId || !gameState.furniture)
    return 0;
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
    if (furni.definition.stackable)
      highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
  });
  return Math.max(0, highestStackableTopZ);
}

/** Checks if coordinates are within room bounds. */
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

/** Gets layout type for coordinates. */
export function getTileLayoutType(x, y) {
  if (!isValidClientTile(x, y) || !gameState.roomLayout) return null;
  if (y < 0 || y >= gameState.roomLayout.length) return null;
  const row = gameState.roomLayout[y];
  if (!row || x < 0 || x >= row.length) return null;
  return row[x] ?? 0;
}

/** Checks if tile is walkable based on layout and furniture. */
export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!isValidClientTile(gx, gy)) return false;
  const layoutType = getTileLayoutType(gx, gy);
  if (layoutType !== 0 && layoutType !== 2) return false;
  return !isClientOccupiedBySolid(gx, gy);
}

/** Checks if tile is occupied by solid furniture. */
export function isClientOccupiedBySolid(gridX, gridY) {
  if (!gameState.furniture) return false;
  return Object.values(gameState.furniture || {}).some((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;
    const def = f.definition;
    const isSolid = !def.isWalkable && !def.isFlat;
    if (!isSolid) return false;
    if (typeof f.getOccupiedTiles !== "function") return false;
    return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
  });
}

// --- Camera Controls ---

/** Pans the camera. */
export function moveCamera(dx, dy) {
  if (!camera) {
    console.warn("Camera state not available.");
    return;
  }
  camera.x += dx;
  camera.y += dy;
}

/** Zooms the camera. */
export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) {
    return;
  }
  const pivotScreenX = pivotX ?? uiState.canvas.width / 2;
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;
  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY);
  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );
  if (Math.abs(newZoom - oldZoom) < 0.001) return;
  camera.zoom = newZoom;
  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );
  camera.x -= screenPosAfterZoomOnly.x - pivotScreenX;
  camera.y -= screenPosAfterZoomOnly.y - pivotScreenY;
}

/** Centers the camera on the room. */
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
    const centerIso = worldToIso(centerX, centerY);
    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
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

/** Updates the game container's cursor style. */
export function updateUICursor() {
  if (!uiState.gameContainer || !inputState) return;
  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = "";
  if (inputState.isDragging) uiState.gameContainer.classList.add("dragging");
  else if (uiState.isEditMode)
    uiState.gameContainer.classList.add("edit-mode-cursor");
}

// --- Object Picking ---

/** Finds the topmost avatar at screen coordinates. */
export function getAvatarAtScreen(screenX, screenY) {
  const candidates = Object.values(gameState.avatars || {}).filter(
    (a) =>
      a instanceof ClientAvatar &&
      typeof a.containsPoint === "function" &&
      a.containsPoint(screenX, screenY)
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0];
}

/** Finds the topmost furniture at screen coordinates. */
export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture || !CLIENT_CONFIG)
    return null;
  const candidates = Object.values(gameState.furniture || {}).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;
    const screenPos = getScreenPos(f.visualX, f.visualY);
    const zoom = camera.zoom;
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) * zoom * 1.1;
    const visualHeightFactor = f.definition.isFlat
      ? 0.1
      : f.definition.stackHeight != null
      ? f.definition.stackHeight * 1.5
      : 1.0;
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom;
    const visualZFactor =
      CLIENT_CONFIG.VISUAL_Z_FACTOR || SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5;
    const zOffsetPx = (f.visualZ || 0) * visualZFactor * zoom;
    const drawTopY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawBottomY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx;
    const drawLeftX = screenPos.x - baseDrawWidth / 2;
    const drawRightX = screenPos.x + baseDrawWidth / 2;
    return (
      screenX >= drawLeftX &&
      screenX <= drawRightX &&
      screenY >= drawTopY &&
      screenY <= drawBottomY
    );
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0];
}

// --- NEW Notification Function (Replaces previous simple one) ---
/**
 * Displays a temporary notification message on the screen, optionally with action buttons.
 */
export function showNotificationWithActions(
  message,
  actions = [],
  duration = null,
  type = "info",
  autoDeclineTimeout = null
) {
  if (!uiState.notificationContainer || !CLIENT_CONFIG || !message) {
    console.warn(
      "showNotificationWithActions: Container, config, or message missing."
    );
    return;
  }
  const displayDuration = duration ?? CLIENT_CONFIG.NOTIFICATION_DURATION;
  const fadeDuration = CLIENT_CONFIG.NOTIFICATION_FADE_OUT_DURATION;
  const hasActions = actions && actions.length > 0;
  const notificationElement = document.createElement("div");
  notificationElement.className = `toast-notification ${type}`;
  notificationElement.innerHTML = `<p>${message}</p>`;
  let autoDeclineTimerId = null;
  if (hasActions) {
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "toast-actions";
    actions.forEach((actionInfo) => {
      const button = document.createElement("button");
      button.textContent = actionInfo.label;
      button.classList.add("toast-action-btn", actionInfo.type || type);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        if (autoDeclineTimerId) clearTimeout(autoDeclineTimerId);
        actionInfo.action();
        notificationElement.classList.add("fade-out");
        setTimeout(() => notificationElement.remove(), fadeDuration);
      });
      actionsContainer.appendChild(button);
    });
    notificationElement.appendChild(actionsContainer);
    if (
      autoDeclineTimeout !== null &&
      autoDeclineTimeout > 0 &&
      actions.length > 0
    ) {
      const lastAction = actions[actions.length - 1];
      autoDeclineTimerId = setTimeout(() => {
        console.log(
          `Notification timeout triggered action: ${lastAction.label}`
        );
        lastAction.action();
        notificationElement.classList.add("fade-out");
        setTimeout(() => notificationElement.remove(), fadeDuration);
      }, autoDeclineTimeout);
      notificationElement.dataset.autoTimeoutId = autoDeclineTimerId.toString();
    }
  } else {
    const removalTimeout = setTimeout(() => {
      notificationElement.classList.add("fade-out");
      const finalRemovalTimeout = setTimeout(() => {
        notificationElement.remove();
      }, fadeDuration);
      notificationElement.dataset.finalTimeoutId =
        finalRemovalTimeout.toString();
    }, displayDuration);
    notificationElement.dataset.removalTimeoutId = removalTimeout.toString();
  }
  if (!hasActions || autoDeclineTimeout !== null) {
    notificationElement.addEventListener(
      "click",
      () => {
        if (notificationElement.dataset.removalTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.removalTimeoutId));
        if (notificationElement.dataset.finalTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.finalTimeoutId));
        if (notificationElement.dataset.autoTimeoutId)
          clearTimeout(parseInt(notificationElement.dataset.autoTimeoutId));
        notificationElement.remove();
      },
      { once: true }
    );
  }
  uiState.notificationContainer.appendChild(notificationElement);
  const maxNotifications = 5;
  while (uiState.notificationContainer.children.length > maxNotifications) {
    const oldestNotification = uiState.notificationContainer.firstChild;
    if (oldestNotification) {
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
// Wrapper for backward compatibility
export function showNotification(message, type = "info", duration = null) {
  showNotificationWithActions(message, [], duration, type, null);
}
// --- End Notification Function ---

// --- Trade UI Functions ---

// Store a debounce function for sending offer updates
const debouncedUpdateOffer = debounce(() => {
  if (!uiState.isTrading || !uiState.tradeSession.tradeId) return;
  const items = {};
  const selfItemsGrid =
    uiState.selfTradeOfferDiv?.querySelector(".trade-items-grid");
  selfItemsGrid?.querySelectorAll(".trade-item").forEach((itemEl) => {
    const itemId = itemEl.dataset.itemId;
    const quantity = parseInt(itemEl.dataset.quantity || "1", 10);
    if (itemId) items[itemId] = (items[itemId] || 0) + quantity;
  });
  const currency = parseInt(uiState.selfTradeCurrencyInput?.value || "0", 10);
  uiState.tradeSession.myOffer = { items, currency };
  updateTradeOffer(uiState.tradeSession.tradeId, items, Math.max(0, currency));
}, 500);

function handleSelfOfferChange() {
  if (uiState.tradeSession.myConfirmed) {
    updateTradeConfirmationStatus(false, uiState.tradeSession.partnerConfirmed);
  }
  let currencyValue = parseInt(uiState.selfTradeCurrencyInput.value, 10);
  if (isNaN(currencyValue) || currencyValue < 0) {
    currencyValue = 0;
    uiState.selfTradeCurrencyInput.value = "0";
  }
  const maxCurrency = gameState.myCurrency || 0;
  if (currencyValue > maxCurrency) {
    currencyValue = maxCurrency;
    uiState.selfTradeCurrencyInput.value = maxCurrency.toString();
    showNotification(`You only have ${maxCurrency} coins!`, "warning");
  }
  debouncedUpdateOffer();
}

/** Populates the inventory section within the trade panel. */
function populateTradeInventory() {
  if (!uiState.tradeInventoryAreaDiv || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    if (uiState.tradeInventoryAreaDiv)
      uiState.tradeInventoryAreaDiv.innerHTML = "<p><i>Error.</i></p>";
    return;
  }
  uiState.tradeInventoryAreaDiv.innerHTML = "";
  const inventory = gameState.inventory;
  const offeredItems = uiState.tradeSession.myOffer?.items || {};
  let hasItems = false;
  const availableInventory = {};
  for (const itemId in inventory) {
    const totalOwned = inventory[itemId] || 0;
    const currentlyOffered = offeredItems[itemId] || 0;
    const available = totalOwned - currentlyOffered;
    if (available > 0) {
      availableInventory[itemId] = available;
      hasItems = true;
    }
  }
  if (!hasItems) {
    uiState.tradeInventoryAreaDiv.innerHTML =
      "<p><i>No items available to add.</i></p>";
    return;
  }
  const sortedItemIds = Object.keys(availableInventory).sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === a);
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === b);
    return (defA?.name || a).localeCompare(defB?.name || b);
  });
  sortedItemIds.forEach((itemId) => {
    const quantityAvailable = availableInventory[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (!def) return;
    const itemDiv = createTradeItemElement(def, quantityAvailable, true);
    itemDiv.addEventListener("click", () => addTradeItemToOffer(itemId));
    uiState.tradeInventoryAreaDiv.appendChild(itemDiv);
  });
}

/** Adds an item from the inventory list to the self offer grid. */
function addTradeItemToOffer(itemId) {
  if (!uiState.isTrading || !uiState.selfTradeOfferDiv) return;
  const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find((d) => d.id === itemId);
  if (!def) return;
  const totalOwned = gameState.inventory[itemId] || 0;
  const currentlyOffered = uiState.tradeSession.myOffer?.items[itemId] || 0;
  if (totalOwned - currentlyOffered <= 0) {
    showNotification("No more available.", "warning");
    return;
  }
  const selfItemsGrid =
    uiState.selfTradeOfferDiv.querySelector(".trade-items-grid");
  if (!selfItemsGrid) return;
  const itemEl = createTradeItemElement(def, 1, false);
  itemEl.dataset.quantity = "1";
  itemEl.addEventListener("click", () => removeTradeItemFromOffer(itemEl));
  selfItemsGrid.appendChild(itemEl);
  uiState.tradeSession.myOffer.items[itemId] =
    (uiState.tradeSession.myOffer.items[itemId] || 0) + 1;
  populateTradeInventory();
  handleSelfOfferChange();
  playSound("place");
}

/** Removes an item element from the self offer grid. */
function removeTradeItemFromOffer(itemElement) {
  if (!uiState.isTrading || !itemElement || !itemElement.parentNode) return;
  const itemId = itemElement.dataset.itemId;
  if (!itemId) return;
  itemElement.remove();
  if (uiState.tradeSession.myOffer.items[itemId]) {
    uiState.tradeSession.myOffer.items[itemId]--;
    if (uiState.tradeSession.myOffer.items[itemId] <= 0)
      delete uiState.tradeSession.myOffer.items[itemId];
  }
  populateTradeInventory();
  handleSelfOfferChange();
  playSound("pickup");
}

/** Creates a DOM element representing a trade item. */
function createTradeItemElement(definition, quantity, isInventoryList) {
  const itemDiv = document.createElement("div");
  itemDiv.className = "trade-item";
  itemDiv.dataset.itemId = definition.id;
  itemDiv.title = `${escapeHtml(definition.name)} (${definition.width}x${
    definition.height
  })`;
  const previewSpan = document.createElement("span");
  previewSpan.className = "trade-item-preview";
  previewSpan.style.backgroundColor = definition.color || "#8B4513";
  itemDiv.appendChild(previewSpan);
  if (isInventoryList) {
    const nameSpan = document.createElement("span");
    nameSpan.className = "trade-item-name";
    nameSpan.textContent = escapeHtml(definition.name);
    itemDiv.appendChild(nameSpan);
    const quantitySpan = document.createElement("span");
    quantitySpan.className = "trade-item-quantity";
    quantitySpan.textContent = `(x${quantity})`;
    itemDiv.appendChild(quantitySpan);
    itemDiv.dataset.available = quantity;
  } else {
    const quantitySpan = document.createElement("span");
    quantitySpan.className = "trade-item-quantity";
    quantitySpan.textContent = "x1";
    itemDiv.appendChild(quantitySpan);
  }
  return itemDiv;
}

/** Updates the visual display of offers in the trade panel. */
export function updateTradePanelOffers(isMyOffer, offer) {
  const sideDiv = isMyOffer
    ? uiState.selfTradeOfferDiv
    : uiState.partnerTradeOfferDiv;
  const currencyInput = isMyOffer
    ? uiState.selfTradeCurrencyInput
    : uiState.partnerTradeCurrencyInput;
  if (!sideDiv || !currencyInput || !offer) return;
  const itemsGrid = sideDiv.querySelector(".trade-items-grid");
  if (!itemsGrid) return;
  itemsGrid.innerHTML = "";
  for (const itemId in offer.items) {
    const quantity = offer.items[itemId];
    const def = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === itemId
    );
    if (def && quantity > 0) {
      for (let i = 0; i < quantity; i++) {
        const itemEl = createTradeItemElement(def, 1, false);
        if (isMyOffer) {
          itemEl.dataset.quantity = "1";
          itemEl.addEventListener("click", () =>
            removeTradeItemFromOffer(itemEl)
          );
        }
        itemsGrid.appendChild(itemEl);
      }
    }
  }
  currencyInput.value = offer.currency || 0;
  if (!isMyOffer) uiState.tradeSession.partnerOffer = offer;
  else {
    uiState.tradeSession.myOffer = offer;
    populateTradeInventory();
  }
}

/** Updates the visual confirmation status. */
export function updateTradeConfirmationStatus(myConfirmed, partnerConfirmed) {
  uiState.tradeSession.myConfirmed = myConfirmed;
  uiState.tradeSession.partnerConfirmed = partnerConfirmed;
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
  const canConfirmFinal = myConfirmed && partnerConfirmed;
  const enableButton = !myConfirmed || canConfirmFinal;
  if (uiState.tradeConfirmBtn) {
    uiState.tradeConfirmBtn.disabled = !enableButton;
    uiState.tradeConfirmBtn.textContent = myConfirmed
      ? "Waiting..."
      : "Confirm Trade";
    if (canConfirmFinal) {
      uiState.tradeConfirmBtn.textContent = "ACCEPT TRADE";
      uiState.tradeConfirmBtn.classList.add("flash-green");
      setTimeout(
        () => uiState.tradeConfirmBtn?.classList.remove("flash-green"),
        600
      );
    }
  }
}

/** Opens and initializes the trade panel. */
export function showTradePanel(tradeId, partnerId, partnerName) {
  if (!uiState.tradePanel || !CLIENT_CONFIG) return;
  console.log(`Starting trade ${tradeId} with ${partnerName} (${partnerId})`);
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
  if (uiState.tradePartnerNameSpan)
    uiState.tradePartnerNameSpan.textContent = escapeHtml(partnerName);
  if (uiState.tradePartnerNameDisplaySpan)
    uiState.tradePartnerNameDisplaySpan.textContent = escapeHtml(partnerName);
  updateTradePanelOffers(true, { items: {}, currency: 0 });
  updateTradePanelOffers(false, { items: {}, currency: 0 });
  updateTradeConfirmationStatus(false, false);
  populateTradeInventory();
  uiState.tradePanel.style.display = "flex";
}

/** Hides and resets the trade panel state. */
export function hideTradePanel() {
  if (uiState.tradePanel) uiState.tradePanel.style.display = "none";
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
  if (uiState.tradePartnerNameSpan)
    uiState.tradePartnerNameSpan.textContent = "...";
  if (uiState.tradePartnerNameDisplaySpan)
    uiState.tradePartnerNameDisplaySpan.textContent = "Partner";
  if (uiState.selfTradeOfferDiv)
    uiState.selfTradeOfferDiv.querySelector(".trade-items-grid").innerHTML = "";
  if (uiState.partnerTradeOfferDiv)
    uiState.partnerTradeOfferDiv.querySelector(".trade-items-grid").innerHTML =
      "";
  if (uiState.selfTradeCurrencyInput) uiState.selfTradeCurrencyInput.value = 0;
  if (uiState.partnerTradeCurrencyInput)
    uiState.partnerTradeCurrencyInput.value = 0;
  if (uiState.tradeInventoryAreaDiv)
    uiState.tradeInventoryAreaDiv.innerHTML = "";
  updateTradeConfirmationStatus(false, false);
}

/** Handles an incoming trade request - shows notification with buttons. */
export function handleTradeRequest(tradeId, requesterName) {
  if (uiState.isTrading) {
    console.log("Received trade request while already trading. Ignoring.");
    return;
  }
  const message = `${escapeHtml(requesterName)} wants to trade!`;
  showNotificationWithActions(
    message,
    [
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
    ],
    CLIENT_CONFIG.TRADE_REQUEST_TIMEOUT,
    "info",
    CLIENT_CONFIG.TRADE_REQUEST_TIMEOUT
  );
  playSound("info");
}
// --- End Trade UI Functions ---
