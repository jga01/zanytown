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
  requestCreateRoom, // NEW: Import create room request
  requestModifyLayout, // NEW: Import modify layout request
  requestAllRoomIds, // NEW: Import request for all rooms
  sendChat, // Need for /join command workaround
} from "./network.js";
// sounds.js provides audio feedback
import { playSound } from "./sounds.js";
// gameObject classes for type checking and method borrowing
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { ClientTile } from "./gameObjects/ClientTile.js"; // Needed for type check potentially
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
      const stateKey = key.replace("_ID", "");
      let camelCaseKey = stateKey
        .toLowerCase()
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase());

      // Handle specific key mappings if needed (already done in previous steps)
      if (camelCaseKey === "chatLog") camelCaseKey = "chatLogDiv";
      if (camelCaseKey === "inventoryItems") camelCaseKey = "inventoryItemsDiv";
      if (camelCaseKey === "shopItems") camelCaseKey = "shopItemsDiv";
      if (camelCaseKey === "recolorSwatches")
        camelCaseKey = "recolorSwatchesDiv";
      if (camelCaseKey === "recolorItemName") camelCaseKey = "recolorItemNameP";
      if (camelCaseKey === "playerCurrency") camelCaseKey = "currencyDisplay";

      const foundElement = document.getElementById(elementId);

      // Assign to the imported uiState object if the property exists
      if (uiState.hasOwnProperty(camelCaseKey)) {
        uiState[camelCaseKey] = foundElement;
        if (!foundElement) {
          // Log errors for critical elements
          if (
            [
              "canvas",
              "gameContainer",
              "chatLogDiv",
              "inventoryItemsDiv",
              "currencyDisplay",
              "loadingOverlay",
              "loadingMessage",
            ].includes(camelCaseKey)
          ) {
            console.error(
              `CRITICAL UI element missing: ${camelCaseKey} (#${elementId})`
            );
            allElementsFound = false;
          } else if (camelCaseKey !== "debugDiv") {
            // Don't warn for optional debugDiv
            console.warn(
              `UI element not found for ID: ${elementId} (expected key: ${camelCaseKey})`
            );
          }
        }
      }
      // else { console.warn(`Config key ${key} maps to ${camelCaseKey}, which is not defined in uiState.`); }
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
    // Error logged above if canvas missing
  }

  // --- Find NEW Admin UI elements ---
  uiState.adminControlsPanel = document.getElementById("admin-controls");
  uiState.adminRoomListDiv = document.getElementById("admin-room-list");
  uiState.layoutTileTypeSelector = document.getElementById(
    "admin-layout-tile-type"
  );
  // Note: createRoomBtn is already handled by the loop above if defined in CLIENT_CONFIG

  // --- Attach Listeners specific to UIManager ---
  // (Button listeners for zoom, edit toggle etc. are in inputHandler.js)
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
    }
  }

  updateAdminUI(); // Set initial visibility

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
    console.warn("showLoadingOverlay called but elements not found.");
  }
}

/** Hides the loading overlay smoothly. */
export function hideLoadingOverlay() {
  if (uiState.loadingOverlay) {
    uiState.loadingOverlay.classList.add("hidden");
    // Use setTimeout to set display:none after the transition completes
    setTimeout(() => {
      // Check if it's still hidden before setting display:none,
      // in case showLoadingOverlay was called again quickly.
      if (uiState.loadingOverlay?.classList.contains("hidden")) {
        uiState.loadingOverlay.style.display = "none";
      }
    }, 300); // Match the CSS transition duration
  }
}

/** Resets UI elements to their default/loading state, typically on disconnect or room change. */
export function resetUIState() {
  console.log("Resetting UI State...");
  showLoadingOverlay("Loading Room..."); // Show loading state

  // Clear dynamic content areas
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
    uiState.adminRoomListDiv.innerHTML = "<i>...</i>"; // Reset admin room list

  // Hide floating panels
  hideProfilePanel();
  hideRecolorPanel();
  hideShopPanel();

  // Update static displays
  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${gameState.currentRoomId})`
    : "Who's Here?";
  const header = uiState.userListPanel?.querySelector("h4");
  if (header) header.textContent = roomTitle;
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
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();
  if (uiState.toggleEditBtn) {
    uiState.toggleEditBtn.textContent = `Make Stuff? (Off)`;
    uiState.toggleEditBtn.classList.remove("active");
  }
  updateAdminUI(); // Ensure admin UI is hidden if user somehow lost status
}

// --- Chat & Bubble Management ---

/** Adds a message to the chat log UI. */
export function logChatMessage(message, isSelf = false, className = "") {
  if (!uiState.chatLogDiv) {
    /* ... error handling ... */ return;
  }
  if (!CLIENT_CONFIG || typeof message !== "string") {
    /* ... error handling ... */ return;
  }

  const p = document.createElement("p");
  p.textContent = message; // Expect pre-escaped message
  if (isSelf) p.classList.add("self-msg");
  if (className) {
    className.split(" ").forEach((cls) => {
      if (cls) p.classList.add(cls.trim());
    });
  }

  const div = uiState.chatLogDiv;
  const isScrolledToBottom =
    Math.abs(div.scrollHeight - div.clientHeight - div.scrollTop) < 5;
  div.appendChild(p);
  uiState.chatMessages.push(p);

  // Limit messages
  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    uiState.chatMessages.shift()?.remove();
  }
  // Auto-scroll
  if (isScrolledToBottom) {
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
    if (!bubble || currentTime > bubble.endTime) {
      bubble?.element?.remove();
      uiState.activeChatBubbles.splice(i, 1);
      if (bubble?.avatarId) {
        // Clean up avatar reference
        const owner = gameState.avatars[bubble.avatarId];
        if (owner && owner.chatBubble?.id === bubble.id)
          owner.chatBubble = null;
      }
    } else {
      updateChatBubblePosition(bubble); // Update position if still active
    }
  }
}

/** Creates or updates the position of a single chat bubble element relative to its avatar. */
function updateChatBubblePosition(bubble) {
  if (!bubble || !uiState.bubbleContainer) return;
  const avatar = gameState.avatars[bubble.avatarId];
  if (!avatar) {
    /* ... handle avatar gone ... */ return;
  }

  // Create element if needed
  if (!bubble.element) {
    bubble.element = document.createElement("div");
    bubble.element.id = bubble.id;
    bubble.element.className = "chat-bubble";
    bubble.element.textContent = bubble.text; // Assume text is safe
    uiState.bubbleContainer.appendChild(bubble.element);
  }

  if (!SHARED_CONFIG || !CLIENT_CONFIG || !camera) return;

  // Calculate position (consistent with ClientAvatar draw logic)
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

  // Update style using transform
  requestAnimationFrame(() => {
    // Smoother updates
    if (!bubble.element) return;
    bubble.element.style.transform = `translate(-50%, calc(-100% - ${verticalOffsetAboveHead}px)) translate(${screenPos.x}px, ${headTopY}px)`;
  });
}

// --- Debug Info ---

/** Updates the content of the debug information panel. Called by game loop. */
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
      editDetails += ` Item: ${def?.name || "?"} R:${
        uiState.editMode.placementRotation
      } V:${uiState.editMode.placementValid ? "OK" : "No"}`;
    } else if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const f = gameState.furniture[uiState.editMode.selectedFurnitureId];
      editDetails += ` Sel: ${
        f?.definition?.name || "?"
      } (ID:${uiState.editMode.selectedFurnitureId?.substring(0, 6)}...) R:${
        f?.rotation ?? "?"
      }`;
    }
  }
  // Layout Paint Details (if admin)
  if (
    isAdmin &&
    uiState.isEditMode &&
    uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_NAVIGATE
  ) {
    editDetails += ` Paint: ${selectedLayoutPaintType}`;
  }

  // Tile Info
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
        ? `Top:${topFurni.definition?.name || "?"}(Z:${topFurni.visualZ.toFixed(
            2
          )}) `
        : ""
    }StackZ:${stackHeight.toFixed(2)}`;
  }

  uiState.debugDiv.innerHTML =
    `Room: ${currentRoom} | Player: (${pGrid.x},${pGrid.y}) St:${pState} Dir:${pDir}<br>` +
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
  if (!uiState.inventoryItemsDiv) {
    /* ... error ... */ return;
  }
  if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    /* ... error ... */ return;
  }

  uiState.inventoryItemsDiv.innerHTML = ""; // Clear
  const inventory = gameState.inventory;
  const ownedItemIds = Object.keys(inventory || {}).filter(
    (id) => inventory[id] > 0
  );

  if (ownedItemIds.length === 0) {
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
    if (
      uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING &&
      !inventory[uiState.editMode.selectedInventoryItemId]
    ) {
      setSelectedInventoryItem(null); // Deselect if item gone
    }
    return;
  }

  // Sort and create elements
  ownedItemIds
    .sort((a, b) => {
      /* ... sort logic ... */
    })
    .forEach((itemId) => {
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
      itemDiv.title = `${def.name} (${def.width}x${def.height})${
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
          logChatMessage(
            "Enable 'Make Stuff?' mode to place items!",
            true,
            "info-msg"
          );
        }
      });
      uiState.inventoryItemsDiv.appendChild(itemDiv);
    });
  updateInventorySelection(); // Ensure correct item is highlighted
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

/** Updates the enabled state of the pickup button based on edit mode and selection. */
export function updatePickupButtonState() {
  if (uiState.pickupFurniBtn && CLIENT_CONFIG) {
    const enabled =
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId;
    uiState.pickupFurniBtn.disabled = !enabled;
  }
}

/** Updates the enabled/visible state of the recolor button. */
export function updateRecolorButtonState() {
  if (uiState.recolorFurniBtn && CLIENT_CONFIG) {
    let enabled = false;
    let visible = false;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
      visible = !!(furni && furni.canRecolor);
      enabled = visible;
    }
    uiState.recolorFurniBtn.disabled = !enabled;
    uiState.recolorFurniBtn.style.display = visible ? "inline-block" : "none";
  }
}

/** Updates the player currency display in the header. */
export function updateCurrencyDisplay() {
  if (!uiState.currencyDisplay) {
    /* ... error handling ... */ return;
  }

  const currentText = uiState.currencyDisplay.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)
    ? currentText.match(/\d+/)[0]
    : "0";
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency;
  uiState.currencyDisplay.textContent = `Silly Coins: ${newValue}`;

  // Flash effect
  if (
    !isNaN(oldValue) &&
    newValue !== oldValue &&
    !uiState.currencyDisplay.classList.contains("flash-green") &&
    !uiState.currencyDisplay.classList.contains("flash-red")
  ) {
    const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
    uiState.currencyDisplay.classList.add(changeClass);
    setTimeout(() => {
      uiState.currencyDisplay.classList.remove(changeClass);
    }, 600);
  }
}

/** Shows the shop panel and populates it with items. */
export function showShopPanel() {
  if (!uiState.shopPanel) return;
  populateShopPanel();
  uiState.shopPanel.style.display = "block";
}

/** Hides the shop panel. */
export function hideShopPanel() {
  if (uiState.shopPanel) uiState.shopPanel.style.display = "none";
}

/** Populates the shop panel UI based on SHARED_CONFIG.SHOP_CATALOG. */
function populateShopPanel() {
  if (!uiState.shopItemsDiv) {
    /* ... error ... */ return;
  }
  if (!SHARED_CONFIG?.SHOP_CATALOG || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    /* ... error ... */ return;
  }

  uiState.shopItemsDiv.innerHTML = ""; // Clear
  if (
    !Array.isArray(SHARED_CONFIG.SHOP_CATALOG) ||
    SHARED_CONFIG.SHOP_CATALOG.length === 0
  ) {
    uiState.shopItemsDiv.innerHTML = "<p><i>Shop is empty!</i></p>";
    return;
  }

  // Sort and create elements
  const sortedCatalog = [...SHARED_CONFIG.SHOP_CATALOG].sort((a, b) => {
    /* ... sort logic ... */
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
    nameSpan.title = `${definition.name} (${definition.width}x${definition.height})`;
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
      if (!isConnected()) return;
      buyButton.disabled = true;
      buyButton.textContent = "Buying...";
      requestBuyItem(shopEntry.itemId);
      setTimeout(updateShopButtonStates, 300);
    });
    itemDiv.appendChild(buyButton);
    uiState.shopItemsDiv.appendChild(itemDiv);
  });
  updateShopButtonStates(); // Set initial button states
}

/** Updates the enabled state of buy buttons in the shop based on player currency. */
export function updateShopButtonStates() {
  if (!uiState.shopItemsDiv) return;
  uiState.shopItemsDiv.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = gameState.myCurrency >= price;
      button.disabled = !canAfford;
      button.classList.toggle("cannot-afford", !canAfford);
      if (button.textContent === "Buying...") button.textContent = "Buy";
    } else {
      button.disabled = true;
    }
  });
}

// --- User List & Profile UI ---

/** Populates the user list panel with online users in the current room. */
export function updateUserListPanel(users) {
  if (!uiState.userListContent || !uiState.userListPanel) {
    /* ... error ... */ return;
  }
  uiState.userListContent.innerHTML = ""; // Clear

  // Update header
  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${gameState.currentRoomId})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle;

  if (!users || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }

  // Sort and create elements
  users
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((user) => {
      const li = document.createElement("li");
      li.textContent = escapeHtml(user.name || "Unknown");
      const userIdStr = String(user.id);
      li.dataset.userid = userIdStr;
      li.classList.toggle("self-user", userIdStr === gameState.myAvatarId);
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
    /* ... error ... */ return;
  }

  const name = profileData.name || "Unknown User";
  const id = String(profileData.id || "N/A");
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

/** Displays the recolor panel for a specific piece of furniture. */
export function showRecolorPanel(furniId) {
  const furniIdStr = String(furniId);
  const furni = gameState.furniture[furniIdStr];
  if (
    !furni ||
    !(furni instanceof ClientFurniture) ||
    !uiState.recolorPanel ||
    !uiState.recolorSwatchesDiv ||
    !uiState.recolorItemNameP ||
    !furni.canRecolor ||
    !SHARED_CONFIG?.VALID_RECOLOR_HEX
  ) {
    /* ... error handling ... */
    hideRecolorPanel();
    return;
  }

  uiState.activeRecolorFurniId = furniIdStr;
  uiState.recolorItemNameP.textContent = `Item: ${escapeHtml(
    furni.definition?.name || "Unknown"
  )}`;
  uiState.recolorSwatchesDiv.innerHTML = ""; // Clear

  // Populate swatches
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

/** Handles clicking a color swatch in the recolor panel. */
function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor);
    hideRecolorPanel(); // Close panel after selection
  }
}

// --- Admin UI Functions ---

/** Shows or hides admin UI elements based on the player's status. */
export function updateAdminUI() {
  const player = gameState.avatars[gameState.myAvatarId];
  const isAdmin = player?.isAdmin || false;
  const displayStyle = isAdmin ? "flex" : "none"; // Use flex for panel-column

  if (uiState.adminControlsPanel) {
    uiState.adminControlsPanel.style.display = displayStyle;
    // Fetch room list if panel is being shown
    if (isAdmin && uiState.adminControlsPanel.style.display !== "none") {
      requestAllRoomIds();
    }
  }
  // Show/hide other admin-specific buttons or sections if needed
}

/** Populates the list of available rooms in the admin panel. */
export function updateAdminRoomList(roomIds) {
  if (!uiState.adminRoomListDiv) return;
  uiState.adminRoomListDiv.innerHTML = ""; // Clear previous list
  if (!roomIds || roomIds.length === 0) {
    uiState.adminRoomListDiv.textContent = "No rooms found.";
    return;
  }
  const ul = document.createElement("ul");
  roomIds.forEach((id) => {
    const li = document.createElement("li");
    li.textContent = escapeHtml(id);
    li.title = `Click to join ${id}`;
    li.style.cursor = "pointer";
    li.addEventListener("click", () => {
      console.log(`Admin joining room: ${id}`);
      // Workaround: Use the chat command to join
      sendChat(`/join ${id}`);
      // Ideal: Replace with a dedicated network function if `handleChangeRoom` isn't exposed/imported
      // joinRoom(id); // Assuming joinRoom exists in network.js
    });
    ul.appendChild(li);
  });
  uiState.adminRoomListDiv.appendChild(ul);
}

/** Handles the click event for the "Create Room" admin button. */
function handleCreateRoomClick() {
  const newRoomId = prompt(
    "Enter ID for the new room (letters, numbers, underscores):"
  );
  if (newRoomId && newRoomId.trim()) {
    const sanitizedId = newRoomId.trim().toLowerCase().replace(/\s+/g, "_");
    // Optional: Prompt for dimensions
    const colsStr = prompt(`Enter columns (3-100):`, 3);
    const rowsStr = prompt(`Enter rows (3-100):`, 3);
    const cols = parseInt(colsStr, 10);
    const rows = parseInt(rowsStr, 10);
    // Validate dimensions before sending
    if (
      isNaN(cols) ||
      isNaN(rows) ||
      cols < 3 ||
      cols > 100 ||
      rows < 3 ||
      rows > 100
    ) {
      alert("Invalid dimensions. Must be between 3 and 100.");
      return;
    }
    requestCreateRoom(sanitizedId, cols, rows);
  } else if (newRoomId !== null) {
    // Only show error if not cancelled
    alert("Invalid room ID entered.");
  }
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
    hideRecolorPanel();
  }

  // Update UI dependent on the new state
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();
  updateHighlights(); // Crucial to update highlights after state change
}

/** Sets the currently selected item from the inventory for placement. */
export function setSelectedInventoryItem(definitionId) {
  console.log(`Setting selected inventory item: ${definitionId}`);
  uiState.editMode.selectedInventoryItemId = definitionId;
  uiState.editMode.placementRotation = 0; // Reset rotation

  if (definitionId) {
    setSelectedFurniture(null); // Deselect floor furniture
    setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING);
  } else if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Back to navigate if deselecting item
  }
  updateInventorySelection(); // Update visual highlight
  updateHighlights(); // Show placement ghost/highlights
}

/** Sets the currently selected furniture item on the floor. */
export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null;
  const oldSelectedId = uiState.editMode.selectedFurnitureId;

  if (oldSelectedId === newSelectedId) {
    // Clicking the same item again
    if (newSelectedId !== null) setSelectedFurniture(null); // Deselect
    return;
  }

  console.log(`Setting selected floor furniture: ${newSelectedId}`);

  // Deselect previous visual state
  if (oldSelectedId && gameState.furniture[oldSelectedId]) {
    gameState.furniture[oldSelectedId].isSelected = false;
  }
  // Set new selected item ID
  uiState.editMode.selectedFurnitureId = newSelectedId;

  if (newSelectedId && gameState.furniture[newSelectedId]) {
    gameState.furniture[newSelectedId].isSelected = true; // Set new visual state
    setSelectedInventoryItem(null); // Deselect inventory item
    setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI); // Set edit sub-state
  } else {
    // Deselecting or item not found
    uiState.editMode.selectedFurnitureId = null;
    hideRecolorPanel();
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }
  // Update UI elements based on selection change
  updatePickupButtonState();
  updateRecolorButtonState();
  updateHighlights();
}

/** Toggles the main edit mode on/off. */
export function toggleEditMode() {
  if (!CLIENT_CONFIG || !uiState.toggleEditBtn) return;
  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);

  uiState.toggleEditBtn.textContent = `Make Stuff? (${
    uiState.isEditMode ? "On" : "Off"
  })`;
  uiState.toggleEditBtn.classList.toggle("active", uiState.isEditMode);

  // Reset sub-state and UI when toggling
  if (!uiState.isEditMode) {
    // Exiting
    setSelectedFurniture(null);
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    hideRecolorPanel();
  } else {
    // Entering
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }
  updateAdminUI(); // Check if admin UI needs update (e.g., fetch room list)
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateHighlights();
  updateUICursor();
}

// --- Input Click Handlers (Delegated from inputHandler.js) ---

/** Handles clicks on the canvas when in Edit Mode. */
export function handleEditModeClick(gridPos, screenPos) {
  if (!CLIENT_CONFIG || !SHARED_CONFIG || !gameState.currentRoomId) return;

  const player = gameState.avatars[gameState.myAvatarId];
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
          // network.js function handles the emit
          requestPlaceFurni(
            uiState.editMode.selectedInventoryItemId,
            gridPos.x,
            gridPos.y,
            uiState.editMode.placementRotation
          );
          playSound("place");
          // Optional: setSelectedInventoryItem(null); // Deselect after placing
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
      const clickedFurniture = getTopmostFurnitureAtScreen(
        screenPos.x,
        screenPos.y
      );
      if (clickedFurniture) {
        if (clickedFurniture.definition?.canUse) {
          requestUseFurni(clickedFurniture.id);
          playSound("use");
          setSelectedFurniture(null); // Deselect after use
        } else {
          // Toggle selection (setSelectedFurniture handles this logic internally)
          setSelectedFurniture(clickedFurniture.id);
          // playSound('select'); // Optional selection sound
        }
      } else {
        setSelectedFurniture(null); // Clicked empty space, deselect
        hideRecolorPanel();
      }
      break;
  }
}

/** Handles clicks on the canvas when *not* in Edit Mode (Navigate). */
export function handleNavigateModeClick(gridPos, screenPos) {
  if (!isConnected() || !SHARED_CONFIG || !gameState.currentRoomId) return;
  const myAvatar = gameState.avatars[gameState.myAvatarId];

  // 1. Click on Avatar -> Profile
  const clickedAvatar = getAvatarAtScreen(screenPos.x, screenPos.y);
  if (clickedAvatar) {
    if (clickedAvatar.id !== gameState.myAvatarId)
      requestProfile(clickedAvatar.id);
    else
      logChatMessage(
        `You clicked yourself (${clickedAvatar.name}).`,
        true,
        "info-msg"
      );
    return;
  }
  // 2. Click self while sitting -> Stand
  if (myAvatar?.state === SHARED_CONFIG.AVATAR_STATE_SITTING) {
    const playerGridPos = snapToGrid(myAvatar.x, myAvatar.y);
    if (gridPos.x === playerGridPos.x && gridPos.y === playerGridPos.y) {
      requestStand();
      return;
    }
  }
  // 3. Click on Furniture -> Use/Sit/Door
  const clickedFurniture = getTopmostFurnitureAtScreen(
    screenPos.x,
    screenPos.y
  );
  if (clickedFurniture) {
    if (clickedFurniture.isDoor && clickedFurniture.targetRoomId) {
      const doorDef = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === clickedFurniture.definitionId
      );
      // Assuming network.js has requestChangeRoom
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
  // 4. Click on Floor -> Navigate
  if (isClientWalkable(gridPos.x, gridPos.y)) {
    requestMove(gridPos.x, gridPos.y);
  } else {
    logChatMessage("Cannot walk there.", true, "error-msg");
  }
}

/** Handles the click of the pickup furniture button (delegated from inputHandler). */
export function handlePickupFurniClick() {
  if (
    uiState.isEditMode &&
    uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_SELECTED_FURNI &&
    uiState.editMode.selectedFurnitureId &&
    isConnected()
  ) {
    requestPickupFurni(uiState.editMode.selectedFurnitureId);
    playSound("pickup"); // Immediate feedback
  } else {
    logChatMessage(
      "Select an item you own first to pick it up.",
      true,
      "info-msg"
    );
  }
}

/** Handles the click of the recolor furniture button (delegated from inputHandler). */
export function handleRecolorFurniClick() {
  if (
    uiState.isEditMode &&
    uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_SELECTED_FURNI &&
    uiState.editMode.selectedFurnitureId
  ) {
    const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
    if (furni?.canRecolor) showRecolorPanel(furni.id);
    else {
      hideRecolorPanel();
      logChatMessage("This item cannot be recolored.", true, "info-msg");
    }
  } else {
    hideRecolorPanel();
  }
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
  )
    return;

  clearAllHighlights(); // Clear previous highlights first
  const gridPos = inputState.currentMouseGridPos || { x: -1, y: -1 };
  const screenPos = inputState.currentMouseScreenPos || { x: -1, y: -1 };

  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    gameState.highlightedTile = null;
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
    ) {
      uiState.editMode.placementValid = false; // Invalid placement off-grid
    }
    return; // No highlights outside valid area
  }
  gameState.highlightedTile = { x: gridPos.x, y: gridPos.y }; // Store hovered valid tile

  // Determine highlights based on mode
  if (uiState.isEditMode) {
    if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
      // --- Placing Item ---
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
        // Highlight occupied tiles for placement ghost
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
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        ); // Fallback highlight
      }
    } else {
      // --- Edit Mode, Not Placing (Navigate or Selected Floor Item) ---
      const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
      if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId) {
        // Highlight hovered furni (if not selected)
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
        // Highlight hovered empty tile
        setTileHighlight(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y,
          CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
        );
      }
      // Note: Furniture selection highlight (cyan outline) is handled in ClientFurniture.draw based on its `isSelected` flag, which is set in `clearAllHighlights`.
    }
  } else {
    // --- Navigate Mode ---
    const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
    if (
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
      // Highlight walkable floor
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      );
    }
  }
  // Final validity check
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
    if (!isValidClientTile(gx, gy)) return false; // Check bounds/basic terrain
    const tileType = getTileLayoutType(gx, gy);
    if (tileType === 1 || tileType === "X") return false; // Wall or Hole

    if (!definition.isFlat) {
      // Check stacking/solids only if placing non-flat
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
        return false; // Cannot stack on non-stackable
      if (isClientOccupiedBySolid(gx, gy)) {
        // Check for solid blockers
        const solidBlocker = stackOnThisTile.find(
          (f) => !f.definition?.isWalkable && !f.definition?.isFlat
        );
        if (solidBlocker) return false; // Blocked by solid
      }
    }
  }
  // Check base tile stackability if non-flat
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
  // Check height limit
  const estimatedZ =
    getClientStackHeightAt(gridX, gridY) + (definition.zOffset || 0);
  if (estimatedZ >= SHARED_CONFIG.MAX_STACK_Z) return false;

  return true; // All checks passed
}

/** Sets the highlight overlay color for a specific tile. */
function setTileHighlight(x, y, color) {
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  if (tile) tile.highlight = color;
}

/** Clears all tile highlights and updates furniture selection visual state. */
function clearAllHighlights() {
  if (!CLIENT_CONFIG || !gameState.clientTiles) return;
  gameState.clientTiles.forEach((t) => (t.highlight = null)); // Clear tile highlights

  // Update furniture isSelected flag based on current edit mode state
  Object.values(gameState.furniture || {}).forEach((f) => {
    if (f instanceof ClientFurniture) {
      f.isSelected =
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        f.id === uiState.editMode.selectedFurnitureId;
    }
  });
}

// --- Helper & Calculation Functions ---

/** Calculates the effective stack height at a grid coordinate based on client-side visual state. */
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
    if (furni.definition.stackable) {
      highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
    }
  });
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
  if (!isValidClientTile(x, y) || !gameState.roomLayout) return null;
  if (y < 0 || y >= gameState.roomLayout.length) return null;
  const row = gameState.roomLayout[y];
  if (!row || x < 0 || x >= row.length) return null;
  return row[x] ?? 0; // Default to floor if undefined
}

/** Checks if a tile is walkable based on terrain and furniture presence. */
export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!isValidClientTile(gx, gy)) return false;
  const layoutType = getTileLayoutType(gx, gy);
  if (layoutType !== 0 && layoutType !== 2) return false; // Must be floor or alt floor
  return !isClientOccupiedBySolid(gx, gy); // Check for solid furniture
}

/** Checks if a tile is occupied by a solid (non-walkable, non-flat) furniture item. */
export function isClientOccupiedBySolid(gridX, gridY) {
  if (!gameState.furniture) return false;
  return Object.values(gameState.furniture || {}).some((f) => {
    if (!(f instanceof ClientFurniture)) return false;
    const def = f.definition;
    if (!def) return false;
    const isSolid = !def.isWalkable && !def.isFlat;
    if (!isSolid) return false;
    if (typeof f.getOccupiedTiles !== "function") return false;
    return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
  });
}

// --- Camera Controls ---

/** Pans the camera by the given screen pixel amounts. */
export function moveCamera(dx, dy) {
  if (!camera) return;
  camera.x += dx;
  camera.y += dy;
}

/** Zooms the camera by a factor, keeping a pivot point stationary on screen. */
export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) return;
  const pivotScreenX = pivotX ?? uiState.canvas.width / 2;
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;

  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY); // World coords of pivot before zoom
  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );
  camera.zoom = newZoom; // Apply new zoom

  // Find where the original world pivot point is now on screen after zoom
  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );
  // Adjust camera pan to compensate, keeping pivot stationary
  camera.x -= screenPosAfterZoomOnly.x - pivotScreenX;
  camera.y -= screenPosAfterZoomOnly.y - pivotScreenY;
}

/** Centers the camera view on the current room's approximate center. */
export function centerCameraOnRoom() {
  if (
    !uiState.canvas ||
    !camera ||
    !gameState ||
    !SHARED_CONFIG ||
    gameState.roomCols <= 0 ||
    gameState.roomRows <= 0
  ) {
    /* ... error handling ... */ return;
  }
  try {
    const centerX = gameState.roomCols / 2;
    const centerY = gameState.roomRows / 2;
    const centerIso = worldToIso(centerX, centerY); // Base iso coords of room center
    // Adjust camera pan to put room center at screen center (or slightly above)
    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
    camera.y = uiState.canvas.height / 3 - centerIso.y * camera.zoom; // Adjust vertical position
    console.log(
      `Camera centered on room ${
        gameState.currentRoomId
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
  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = ""; // Reset to default ('grab' from CSS)

  if (inputState.isDragging) {
    uiState.gameContainer.classList.add("dragging");
  } else if (uiState.isEditMode) {
    uiState.gameContainer.classList.add("edit-mode-cursor");
  }
}

// --- Object Picking ---

/** Finds the topmost avatar at a given screen coordinate. */
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

/** Finds the topmost furniture item at a given screen coordinate using approximate bounds checking. */
export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture) return null;

  const candidates = Object.values(gameState.furniture || {}).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;
    // Calculate approximate screen bounds (simplified from ClientFurniture.draw)
    const screenPos = getScreenPos(f.visualX, f.visualY);
    const zoom = camera.zoom;
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) * zoom * 1.1;
    const visualHeightFactor = f.definition.isFlat
      ? 0.1
      : f.definition.stackHeight
      ? f.definition.stackHeight * 1.5
      : 1.0;
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom;
    const zOffsetPx =
      (f.visualZ || 0) *
      (CLIENT_CONFIG?.VISUAL_Z_FACTOR || SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5) *
      zoom;
    const drawTopY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawBottomY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx;
    const drawLeftX = screenPos.x - baseDrawWidth / 2;
    const drawRightX = screenPos.x + baseDrawWidth / 2;
    // Check collision
    return (
      screenX >= drawLeftX &&
      screenX <= drawRightX &&
      screenY >= drawTopY &&
      screenY <= drawBottomY
    );
  });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0)); // Sort by draw order
  return candidates[0]; // Return topmost
}
