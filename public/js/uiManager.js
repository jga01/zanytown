// --- Correct Import ---
// uiState is DEFINED in gameState.js and IMPORTED here for use.
import { gameState, uiState, camera } from "./gameState.js";
// --- End Correct Import ---

import { SHARED_CONFIG, CLIENT_CONFIG } from "./config.js";
import {
  getScreenPos,
  snapToGrid,
  isoToWorld,
  worldToIso,
  shadeColor,
  escapeHtml,
} from "./utils.js";
import {
  isConnected,
  requestProfile,
  requestUseFurni,
  requestPickupFurni,
  requestRecolorFurni,
  requestBuyItem,
} from "./network.js";
import { playSound } from "./sounds.js";
import { ClientAvatar } from "./gameObjects/ClientAvatar.js";
import { ClientFurniture } from "./gameObjects/ClientFurniture.js";
import { inputState } from "./inputHandler.js";

export function initUIManager() {
  console.log("Initializing UI Manager...");
  if (!CLIENT_CONFIG) {
    console.error("UIManager init failed: CLIENT_CONFIG not loaded.");
    return false;
  }

  let allElementsFound = true;
  for (const key in CLIENT_CONFIG) {
    if (key.endsWith("_ID")) {
      const elementId = CLIENT_CONFIG[key];
      // Derive the expected key in the uiState object (imported from gameState.js)
      const stateKey = key.replace("_ID", "");
      let camelCaseKey = stateKey
        .toLowerCase()
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase());

      if (camelCaseKey === "chatLog") camelCaseKey = "chatLogDiv";
      if (camelCaseKey === "inventoryItems") camelCaseKey = "inventoryItemsDiv";
      if (camelCaseKey === "shopItems") camelCaseKey = "shopItemsDiv";
      if (camelCaseKey === "recolorSwatches")
        camelCaseKey = "recolorSwatchesDiv";
      if (camelCaseKey === "recolorItemName") camelCaseKey = "recolorItemNameP";
      if (camelCaseKey === "playerCurrency") camelCaseKey = "currencyDisplay";

      const foundElement = document.getElementById(elementId);

      // Check if the derived key exists on the IMPORTED uiState object
      // This check ensures we only try to assign to keys defined in gameState.js
      if (uiState.hasOwnProperty(camelCaseKey)) {
        // Assign the found element TO the property on the IMPORTED uiState object
        uiState[camelCaseKey] = foundElement;

        // Log errors/warnings if element not found
        if (!foundElement) {
          if (
            [
              "canvas",
              "gameContainer",
              "chatLogDiv",
              "inventoryItemsDiv",
              "currencyDisplay",
              "shopItemsDiv",
              "recolorFurniBtn",
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
      } else {
        // This shouldn't normally happen if gameState.js defines all expected keys
        // console.warn(`Config key ${key} maps to ${camelCaseKey}, which is not defined in the imported uiState object.`);
      }
    }
  }

  // Special handling for canvas context (using the assigned uiState.canvas)
  if (uiState.canvas) {
    uiState.ctx = uiState.canvas.getContext("2d");
    if (!uiState.ctx) {
      console.error("Failed to get 2D context from canvas");
      allElementsFound = false;
    }
  } else {
    // Error already logged above if canvas was missing
  }

  if (allElementsFound) {
    console.log("UI Manager Initialized successfully.");
  } else {
    console.error(
      "UI Manager Initialized with missing CRITICAL elements. Check console logs."
    );
  }
  return allElementsFound;
}

// NEW Function: Show Loading Overlay
export function showLoadingOverlay(message = "Loading...") {
  // uiState here refers to the IMPORTED object
  if (uiState.loadingOverlay && uiState.loadingMessage) {
    uiState.loadingMessage.textContent = message;
    uiState.loadingOverlay.classList.remove("hidden");
    uiState.loadingOverlay.style.display = "flex";
  } else {
    console.warn("showLoadingOverlay called but elements not found.");
  }
}

// NEW Function: Hide Loading Overlay
export function hideLoadingOverlay() {
  // uiState here refers to the IMPORTED object
  if (uiState.loadingOverlay) {
    uiState.loadingOverlay.classList.add("hidden");
    setTimeout(() => {
      if (uiState.loadingOverlay?.classList.contains("hidden")) {
        uiState.loadingOverlay.style.display = "none";
      }
    }, 300);
  }
}

export function resetUIState() {
  console.log("Resetting UI State...");
  showLoadingOverlay("Loading Room..."); // Show overlay during reset

  // All references to uiState below correctly modify the IMPORTED object from gameState.js
  if (uiState.chatLogDiv) uiState.chatLogDiv.innerHTML = "";
  uiState.chatMessages = []; // Reset the array property on the imported uiState
  if (uiState.inventoryItemsDiv)
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Entering room...</i></p>";
  if (uiState.userListContent)
    uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
  if (uiState.debugDiv) uiState.debugDiv.textContent = "Resetting state...";
  if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
  uiState.activeChatBubbles = [];
  if (uiState.shopItemsDiv)
    uiState.shopItemsDiv.innerHTML = "<p><i>Stocking shelves...</i></p>";

  hideProfilePanel();
  hideRecolorPanel();
  hideShopPanel();

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

  // Reset edit mode properties on the imported uiState object
  uiState.isEditMode = false;
  if (CLIENT_CONFIG) {
    uiState.editMode.state = CLIENT_CONFIG.EDIT_STATE_NAVIGATE;
  } else {
    uiState.editMode.state = "navigate";
  }
  uiState.editMode.selectedInventoryItemId = null;
  uiState.editMode.selectedFurnitureId = null;
  uiState.editMode.placementValid = false;
  uiState.editMode.placementRotation = 0;
  uiState.activeRecolorFurniId = null;

  // Update UI elements based on the reset state
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();

  // Reset toggle button visual state
  if (uiState.toggleEditBtn) {
    uiState.toggleEditBtn.textContent = `Make Stuff? (Off)`;
    uiState.toggleEditBtn.classList.remove("active");
  }
}

// --- ALL OTHER FUNCTIONS remain the same ---
// (logChatMessage, updateChatBubbles, updateDebugInfo, populateInventory, etc.)
// They all correctly reference the imported `uiState` object now.

export function logChatMessage(message, isSelf = false, className = "") {
  // Use uiState.chatLogDiv now
  if (!uiState.chatLogDiv) {
    console.error(
      "logChatMessage failed: uiState.chatLogDiv is null/undefined!"
    );
    return;
  }
  if (!CLIENT_CONFIG || typeof message !== "string") {
    console.error(
      "logChatMessage failed: CLIENT_CONFIG missing or invalid message type."
    );
    return;
  }

  const p = document.createElement("p");
  p.textContent = message; // Already escaped by caller if needed (e.g., server message)

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

  // Limit chat log messages
  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    uiState.chatMessages.shift()?.remove(); // Remove the oldest message element
  }

  // Auto-scroll to bottom if already at bottom
  if (isScrolledToBottom) {
    // Use setTimeout to allow the DOM to update before scrolling
    setTimeout(() => {
      div.scrollTop = div.scrollHeight;
    }, 0);
  }
}

export function updateChatBubbles(currentTime) {
  if (!uiState.bubbleContainer || !CLIENT_CONFIG) return;

  for (let i = uiState.activeChatBubbles.length - 1; i >= 0; i--) {
    const bubble = uiState.activeChatBubbles[i];

    if (!bubble || currentTime > bubble.endTime) {
      bubble?.element?.remove(); // Remove the DOM element if it exists
      uiState.activeChatBubbles.splice(i, 1);
      // Clean up avatar's reference if this was their bubble
      if (bubble?.avatarId) {
        const owner = gameState.avatars[bubble.avatarId];
        if (owner && owner.chatBubble?.id === bubble.id) {
          owner.chatBubble = null;
        }
      }
    } else {
      // Update position if the bubble is still active
      updateChatBubblePosition(bubble);
    }
  }
}

function updateChatBubblePosition(bubble) {
  if (!bubble || !uiState.bubbleContainer) return;

  const avatar = gameState.avatars[bubble.avatarId];
  if (!avatar) {
    // Avatar disappeared, remove the bubble
    bubble.element?.remove();
    const index = uiState.activeChatBubbles.findIndex(
      (b) => b.id === bubble.id
    );
    if (index > -1) uiState.activeChatBubbles.splice(index, 1);
    return;
  }

  // Create element if it doesn't exist
  if (!bubble.element) {
    bubble.element = document.createElement("div");
    bubble.element.id = bubble.id;
    bubble.element.className = "chat-bubble";
    bubble.element.textContent = bubble.text;
    uiState.bubbleContainer.appendChild(bubble.element);
  }

  // Basic safety check for dependencies
  if (!SHARED_CONFIG || !CLIENT_CONFIG || !camera) return;

  // Calculate position based on avatar's visual state
  const screenPos = getScreenPos(avatar.visualX, avatar.visualY);
  const zoom = camera.zoom;
  // Approximate avatar height calculation (matches ClientAvatar draw logic)
  const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
  const headHeight = totalHeight * 0.3;
  const zOffsetPx = avatar.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
  const baseY =
    screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx;
  const bodyY = baseY - totalHeight * 0.7;
  const headTopY = bodyY - headHeight;
  const verticalOffsetAboveHead = 15 * zoom; // Space above head

  // Use requestAnimationFrame for smoother updates potentially
  requestAnimationFrame(() => {
    if (!bubble.element) return; // Check again in case it was removed
    // Position the bubble centered above the head
    bubble.element.style.transform = `translate(-50%, calc(-100% - ${verticalOffsetAboveHead}px)) translate(${screenPos.x}px, ${headTopY}px)`;
  });
}

export function updateDebugInfo() {
  // Use correct inputState reference from inputHandler.js
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
  const mGrid = inputState.currentMouseGridPos || { x: "?", y: "?" }; // Use inputState
  const furniCount = Object.keys(gameState.furniture || {}).length;
  const avatarCount = Object.keys(gameState.avatars || {}).length;
  const inventoryCount = Object.values(gameState.inventory || {}).reduce(
    (s, q) => s + q,
    0
  );
  const currentRoom = gameState.currentRoomId || "N/A";

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

  let tileInfo = "";
  const ht = gameState.highlightedTile;
  if (ht && isValidClientTile(ht.x, ht.y)) {
    // Check if tile is valid
    const tLayout = getTileLayoutType(ht.x, ht.y);
    const stack = Object.values(gameState.furniture).filter(
      (f) =>
        f instanceof ClientFurniture &&
        Math.round(f.visualX) === ht.x &&
        Math.round(f.visualY) === ht.y
    );
    stack.sort((a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0));
    const topFurni = stack[0];
    const stackHeight = getClientStackHeightAt(ht.x, ht.y); // Calculate stack height
    tileInfo = ` Tile(${ht.x},${ht.y}) L:${tLayout ?? "?"} ${
      topFurni
        ? `Top:${topFurni.definition?.name || "?"}(Z:${topFurni.visualZ.toFixed(
            2
          )}) `
        : ""
    }StackZ:${stackHeight.toFixed(2)}`;
  }

  // Update the debug div content
  uiState.debugDiv.innerHTML =
    `Room: ${currentRoom} | Player: (${pGrid.x},${pGrid.y}) St:${pState} Dir:${pDir}<br>` +
    `Mouse: (${mGrid.x},${mGrid.y})${tileInfo}<br>` +
    `Cam: (${camera.x.toFixed(0)},${camera.y.toFixed(
      0
    )}) Zoom:${camera.zoom.toFixed(2)}<br>` +
    `Edit: ${editDetails}<br>` +
    `Inv: ${inventoryCount} | Coins: ${
      gameState.myCurrency
    } | Objs:${furniCount}|Users:${avatarCount}|Bub:${
      uiState.activeChatBubbles.length
    }|Sock:${isConnected() ? "OK" : "DOWN"}`;
}

export function populateInventory() {
  // Use uiState.inventoryItemsDiv
  if (!uiState.inventoryItemsDiv) {
    console.error(
      "populateInventory failed: uiState.inventoryItemsDiv is null/undefined!"
    );
    if (uiState.debugDiv)
      uiState.debugDiv.innerHTML +=
        "<br><span style='color:red'>Inventory UI missing!</span>";
    return;
  }
  if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    uiState.inventoryItemsDiv.innerHTML =
      "<p><i>Error loading inventory data (Config missing?).</i></p>";
    return;
  }

  uiState.inventoryItemsDiv.innerHTML = ""; // Clear previous items

  const inventory = gameState.inventory;
  const ownedItemIds = Object.keys(inventory || {}).filter(
    (id) => inventory[id] > 0
  );

  if (ownedItemIds.length === 0) {
    uiState.inventoryItemsDiv.innerHTML = "<p><i>Inventory empty.</i></p>";
    // Deselect if the currently selected item is now gone
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
    if (!def) {
      console.warn(`Inventory item ID '${itemId}' not found in definitions.`);
      return; // Skip this item if definition is missing
    }

    const itemDiv = document.createElement("div");
    itemDiv.className = "inventory-item";
    itemDiv.dataset.itemId = def.id; // Store item ID for click handling

    // Add preview box
    const previewSpan = document.createElement("span");
    previewSpan.className = "item-preview";
    previewSpan.style.backgroundColor = def.color || "#8B4513"; // Use definition color or brown default
    itemDiv.appendChild(previewSpan);

    // Add text node for name and quantity
    itemDiv.appendChild(
      document.createTextNode(` ${escapeHtml(def.name)} (x${quantity})`)
    );

    // Set title attribute for hover info
    itemDiv.title = `${def.name} (${def.width}x${def.height})${
      def.canSit ? " (Sit)" : ""
    }${def.stackable ? " (Stack)" : ""}${def.canUse ? " (Use)" : ""}${
      def.canRecolor ? " (Recolor)" : ""
    }`;

    // Click listener for selection in edit mode
    itemDiv.addEventListener("click", () => {
      if (uiState.isEditMode) {
        setSelectedInventoryItem(def.id);
        playSound("select"); // Optional: sound feedback for selection
      } else {
        // Optional: Visual feedback if trying to select outside edit mode
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

  // Ensure the selection highlight is correct after repopulating
  updateInventorySelection();
}

export function updateInventorySelection() {
  // Use uiState.inventoryItemsDiv
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

export function updatePickupButtonState() {
  if (uiState.pickupFurniBtn && CLIENT_CONFIG) {
    const enabled =
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId; // Check if a furniture ID is actually selected
    uiState.pickupFurniBtn.disabled = !enabled;
  }
}

export function updateRecolorButtonState() {
  // Use uiState.recolorFurniBtn
  if (uiState.recolorFurniBtn && CLIENT_CONFIG) {
    let enabled = false;
    let visible = false; // Control visibility separately
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
      uiState.editMode.selectedFurnitureId
    ) {
      const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
      visible = !!(furni && furni.canRecolor); // Check if the selected item *can* be recolored
      enabled = visible; // Enable only if visible/recolorable
    }
    uiState.recolorFurniBtn.disabled = !enabled;
    uiState.recolorFurniBtn.style.display = visible ? "inline-block" : "none"; // Show/hide the button
  }
}

export function updateCurrencyDisplay() {
  // Use uiState.currencyDisplay
  if (!uiState.currencyDisplay) {
    console.warn(
      "updateCurrencyDisplay skipped: uiState.currencyDisplay is null/undefined!"
    );
    if (uiState.debugDiv)
      uiState.debugDiv.innerHTML +=
        "<br><span style='color:orange'>Currency UI missing!</span>";
    return;
  }

  const currentText = uiState.currencyDisplay.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)
    ? currentText.match(/\d+/)[0]
    : "0";
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency;

  uiState.currencyDisplay.textContent = `Silly Coins: ${newValue}`;

  // Add flash effect on change, only if not already flashing
  if (
    !isNaN(oldValue) &&
    newValue !== oldValue &&
    !uiState.currencyDisplay.classList.contains("flash-green") &&
    !uiState.currencyDisplay.classList.contains("flash-red")
  ) {
    const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
    uiState.currencyDisplay.classList.add(changeClass);
    // Remove the class after the animation duration
    setTimeout(() => {
      uiState.currencyDisplay.classList.remove(changeClass);
    }, 600); // Match CSS animation duration
  }
}

export function showShopPanel() {
  if (!uiState.shopPanel) {
    console.warn("Cannot show shop: Shop panel element not found.");
    return;
  }
  populateShopPanel(); // Populate content when shown
  uiState.shopPanel.style.display = "block";
}

export function hideShopPanel() {
  if (uiState.shopPanel) uiState.shopPanel.style.display = "none";
}

function populateShopPanel() {
  // Use uiState.shopItemsDiv
  if (!uiState.shopItemsDiv) {
    console.warn(
      "populateShopPanel skipped: uiState.shopItemsDiv is null/undefined!"
    );
    return;
  }
  if (!SHARED_CONFIG?.SHOP_CATALOG || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    uiState.shopItemsDiv.innerHTML =
      "<p><i>Error loading shop data (Config missing?).</i></p>";
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

  // Sort catalog items alphabetically by name
  const sortedCatalog = [...SHARED_CONFIG.SHOP_CATALOG].sort((a, b) => {
    const defA = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === a.itemId
    );
    const defB = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (d) => d.id === b.itemId
    );
    return (defA?.name || a.itemId).localeCompare(defB?.name || b.itemId);
  });

  sortedCatalog.forEach((shopEntry) => {
    const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
      (def) => def.id === shopEntry.itemId
    );
    if (!definition) {
      console.warn(`Shop item '${shopEntry.itemId}' has no definition.`);
      return; // Skip invalid items
    }

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
    nameSpan.textContent = escapeHtml(definition.name || shopEntry.itemId);
    nameSpan.title = `${definition.name} (${definition.width}x${definition.height})`;
    infoDiv.appendChild(nameSpan);
    itemDiv.appendChild(infoDiv);

    // Price
    const priceSpan = document.createElement("span");
    priceSpan.className = "shop-item-price";
    priceSpan.textContent = `${shopEntry.price} Coins`;
    itemDiv.appendChild(priceSpan);

    // Buy Button
    const buyButton = document.createElement("button");
    buyButton.className = "buy-btn";
    buyButton.textContent = "Buy";
    buyButton.dataset.itemId = shopEntry.itemId;
    buyButton.dataset.price = shopEntry.price; // Store price for enabling/disabling

    buyButton.addEventListener("click", () => {
      if (!isConnected()) return; // Prevent action if not connected
      buyButton.disabled = true; // Disable immediately
      buyButton.textContent = "Buying...";
      requestBuyItem(shopEntry.itemId);
      // Buttons will be re-enabled/checked on currency/inventory updates
      setTimeout(updateShopButtonStates, 300); // Re-check state shortly after
    });
    itemDiv.appendChild(buyButton);

    uiState.shopItemsDiv.appendChild(itemDiv);
  });

  // Set initial button states based on current currency
  updateShopButtonStates();
}

export function updateShopButtonStates() {
  // Use uiState.shopItemsDiv
  if (!uiState.shopItemsDiv) return;
  uiState.shopItemsDiv.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = gameState.myCurrency >= price;
      button.disabled = !canAfford;
      button.classList.toggle("cannot-afford", !canAfford);
      // Reset text if it was 'Buying...'
      if (button.textContent === "Buying...") {
        button.textContent = "Buy";
      }
    } else {
      button.disabled = true; // Disable if price is invalid
    }
  });
}

export function updateUserListPanel(users) {
  if (!uiState.userListContent || !uiState.userListPanel) {
    console.warn("Cannot update user list: Panel/Content element not found.");
    return;
  }
  uiState.userListContent.innerHTML = ""; // Clear previous list

  // Update panel header with room name
  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${gameState.currentRoomId})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle;

  if (!users || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }

  // Sort users alphabetically
  users
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((user) => {
      const li = document.createElement("li");
      li.textContent = escapeHtml(user.name || "Unknown");
      const userIdStr = String(user.id); // Ensure ID is string
      li.dataset.userid = userIdStr; // Store ID for click handling
      li.classList.toggle("self-user", userIdStr === gameState.myAvatarId); // Highlight self

      // Add click listener to request profile (if not self)
      li.addEventListener("click", () => {
        if (userIdStr !== gameState.myAvatarId && isConnected()) {
          requestProfile(userIdStr);
        }
      });
      uiState.userListContent.appendChild(li);
    });
}

export function showProfilePanel(profileData) {
  if (!uiState.profilePanel || !uiState.profileContent) {
    console.warn("Cannot show profile: Panel/Content element not found.");
    return;
  }

  // Extract and sanitize data
  const name = profileData.name || "Unknown User";
  const id = String(profileData.id || "N/A");
  const state = profileData.state || "Idle";
  const color = profileData.bodyColor || "#CCCCCC"; // Default color if missing
  const currency =
    profileData.currency === undefined
      ? "N/A"
      : `${profileData.currency} Coins`;

  // Build HTML content
  uiState.profileContent.innerHTML = `
        <h4>${escapeHtml(name)}</h4>
        <p>Status: ${escapeHtml(state)}</p>
        <p>Look: <span class="profile-color-swatch" style="background-color: ${escapeHtml(
          color
        )};"></span> ${escapeHtml(color)}</p>
        <p>Coins: ${escapeHtml(currency)}</p>
        <div class="profile-actions">
             <!-- Add action buttons here later if needed (e.g., Friend, Trade) -->
        </div>
    `;

  // Set target ID and display
  uiState.profilePanel.dataset.targetId = id;
  uiState.profilePanel.style.display = "block";
}

export function hideProfilePanel() {
  if (uiState.profilePanel) {
    uiState.profilePanel.style.display = "none";
    uiState.profilePanel.dataset.targetId = ""; // Clear target ID
    if (uiState.profileContent) uiState.profileContent.innerHTML = ""; // Clear content
  }
}

export function showRecolorPanel(furniId) {
  const furniIdStr = String(furniId); // Ensure string ID
  const furni = gameState.furniture[furniIdStr];

  // Use correct uiState references
  if (
    !furni ||
    !(furni instanceof ClientFurniture) ||
    !uiState.recolorPanel ||
    !uiState.recolorSwatchesDiv ||
    !uiState.recolorItemNameP ||
    !furni.canRecolor ||
    !SHARED_CONFIG?.VALID_RECOLOR_HEX
  ) {
    console.warn("Cannot show recolor panel: Prerequisites not met.", {
      furniExists: !!furni,
      canRecolor: furni?.canRecolor,
      configExists: !!SHARED_CONFIG?.VALID_RECOLOR_HEX,
      panelElement: !!uiState.recolorPanel,
      swatchesElement: !!uiState.recolorSwatchesDiv,
      nameElement: !!uiState.recolorItemNameP,
    });
    hideRecolorPanel(); // Ensure it's hidden if prerequisites fail
    return;
  }

  uiState.activeRecolorFurniId = furniIdStr;
  uiState.recolorItemNameP.textContent = `Item: ${escapeHtml(
    furni.definition?.name || "Unknown"
  )}`;
  uiState.recolorSwatchesDiv.innerHTML = ""; // Clear previous swatches

  SHARED_CONFIG.VALID_RECOLOR_HEX.forEach((hex) => {
    const swatch = document.createElement("div");
    swatch.className = "recolor-swatch";
    swatch.style.backgroundColor = hex;
    swatch.title = hex;
    swatch.dataset.colorHex = hex; // Store color for click handler
    swatch.addEventListener("click", () => handleRecolorSwatchClick(hex));
    uiState.recolorSwatchesDiv.appendChild(swatch);
  });

  uiState.recolorPanel.style.display = "block";
}

export function hideRecolorPanel() {
  if (uiState.recolorPanel) {
    uiState.recolorPanel.style.display = "none";
  }
  uiState.activeRecolorFurniId = null; // Clear the active item ID
}

// Called by swatch click event
function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor);
    hideRecolorPanel(); // Close panel after selection
  }
}

export function setEditState(newState) {
  if (!CLIENT_CONFIG || uiState.editMode.state === newState) return;

  const oldState = uiState.editMode.state;
  uiState.editMode.state = newState;
  console.log(`Edit state changed from ${oldState} to ${newState}`);

  // Clean up state from previous mode
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_PLACING &&
    newState !== CLIENT_CONFIG.EDIT_STATE_PLACING
  ) {
    uiState.editMode.placementRotation = 0;
    uiState.editMode.placementValid = false;
    updateHighlights(); // Clear placement highlights
  }
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
    newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
  ) {
    setSelectedFurniture(null); // Deselect furniture visually
    hideRecolorPanel();
  }

  // Update UI elements dependent on edit state
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();
}

export function setSelectedInventoryItem(definitionId) {
  console.log(`Setting selected inventory item: ${definitionId}`);
  uiState.editMode.selectedInventoryItemId = definitionId;
  uiState.editMode.placementRotation = 0; // Reset rotation on new selection

  if (definitionId) {
    setSelectedFurniture(null); // Deselect any floor furniture
    setEditState(CLIENT_CONFIG.EDIT_STATE_PLACING);
  } else {
    // If we were placing and now deselecting item, go back to navigate
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }
  updateInventorySelection(); // Update visual selection in inventory list
  updateHighlights(); // Update tile highlights for placement ghost
}

export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null; // Ensure string or null

  // If clicking the already selected item, deselect it
  if (uiState.editMode.selectedFurnitureId === newSelectedId) {
    if (newSelectedId !== null) {
      // Only deselect if something was actually selected
      console.log(`Deselecting floor furniture: ${newSelectedId}`);
      const oldFurni = gameState.furniture[newSelectedId];
      if (oldFurni) {
        oldFurni.isSelected = false; // Update visual state
      }
      uiState.editMode.selectedFurnitureId = null;
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Back to navigate state
      hideRecolorPanel();
      updatePickupButtonState();
      updateRecolorButtonState();
      updateHighlights(); // Clear selection highlight
    }
    return; // Nothing more to do
  }

  console.log(`Setting selected floor furniture: ${newSelectedId}`);

  // Deselect previous item if any
  const oldSelectedId = uiState.editMode.selectedFurnitureId;
  if (oldSelectedId && gameState.furniture[oldSelectedId]) {
    gameState.furniture[oldSelectedId].isSelected = false;
  }

  // Set new selected item
  uiState.editMode.selectedFurnitureId = newSelectedId;

  if (newSelectedId && gameState.furniture[newSelectedId]) {
    gameState.furniture[newSelectedId].isSelected = true; // Update new item's visual state
    setSelectedInventoryItem(null); // Deselect any inventory item
    setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI); // Set correct edit mode state
  } else {
    // If newSelectedId is null or item not found, ensure state is reset
    uiState.editMode.selectedFurnitureId = null;
    hideRecolorPanel();
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }

  // Update button states and highlights
  updatePickupButtonState();
  updateRecolorButtonState();
  updateHighlights();
}

export function toggleEditMode() {
  if (!CLIENT_CONFIG || !uiState.toggleEditBtn) return;
  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);

  // Update button text and style
  uiState.toggleEditBtn.textContent = `Make Stuff? (${
    uiState.isEditMode ? "On" : "Off"
  })`;
  uiState.toggleEditBtn.classList.toggle("active", uiState.isEditMode);

  // Reset edit sub-state when toggling mode
  if (!uiState.isEditMode) {
    // Exiting edit mode
    setSelectedFurniture(null);
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE); // Should already be set, but belt-and-suspenders
    hideRecolorPanel();
  } else {
    // Entering edit mode, start in navigate state
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }

  // Update UI elements affected by edit mode status
  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateHighlights();
  updateUICursor();
}

export function handlePickupFurniClick() {
  if (
    uiState.isEditMode &&
    uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_SELECTED_FURNI &&
    uiState.editMode.selectedFurnitureId &&
    isConnected()
  ) {
    requestPickupFurni(uiState.editMode.selectedFurnitureId);
    playSound("pickup"); // Provide immediate feedback
    // State will be updated on server response (furni_removed, inventory_update)
  } else {
    console.warn("Pickup button clicked but conditions not met.");
    logChatMessage(
      "Select an item you own first to pick it up.",
      true,
      "info-msg"
    );
  }
}

export function handleRecolorFurniClick() {
  if (
    uiState.isEditMode &&
    uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_SELECTED_FURNI &&
    uiState.editMode.selectedFurnitureId
  ) {
    const furni = gameState.furniture[uiState.editMode.selectedFurnitureId];
    if (furni?.canRecolor) {
      showRecolorPanel(furni.id);
    } else {
      hideRecolorPanel();
      logChatMessage("This item cannot be recolored.", true, "info-msg");
    }
  } else {
    hideRecolorPanel(); // Ensure panel is hidden if conditions not met
  }
}

export function updateHighlights() {
  // Use inputState from inputHandler.js
  if (
    !CLIENT_CONFIG ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.clientTiles ||
    !inputState
  )
    return;

  // 1. Clear previous highlights
  clearAllHighlights();

  // 2. Get current mouse positions
  const gridPos = inputState.currentMouseGridPos || { x: -1, y: -1 };
  const screenPos = inputState.currentMouseScreenPos || { x: -1, y: -1 };

  // 3. Check if mouse is over a valid tile in the room
  if (!isValidClientTile(gridPos.x, gridPos.y)) {
    gameState.highlightedTile = null;
    // If placing, mark placement as invalid when off-grid
    if (
      uiState.isEditMode &&
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING
    ) {
      uiState.editMode.placementValid = false;
    }
    return; // No highlights if mouse is outside valid area
  }

  // Store the currently hovered valid grid tile
  gameState.highlightedTile = { x: gridPos.x, y: gridPos.y };

  // 4. Determine highlights based on mode
  if (uiState.isEditMode) {
    if (
      uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_PLACING &&
      uiState.editMode.selectedInventoryItemId
    ) {
      // Placing an item: Show ghost preview highlights
      const definition = SHARED_CONFIG.FURNITURE_DEFINITIONS.find(
        (d) => d.id === uiState.editMode.selectedInventoryItemId
      );
      // Check placement validity using client-side logic
      uiState.editMode.placementValid = definition
        ? isClientPlacementValid(definition, gridPos.x, gridPos.y)
        : false;
      const color = uiState.editMode.placementValid
        ? CLIENT_CONFIG.FURNI_PLACE_HIGHLIGHT_COLOR
        : CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR;

      if (definition) {
        // Create a temporary object structure matching ClientFurniture for getOccupiedTiles
        const tempFurniProto = {
          x: gridPos.x,
          y: gridPos.y,
          definition: definition, // Pass the actual definition object
          getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles, // Borrow the method
        };
        // Highlight all tiles the ghost would occupy
        tempFurniProto
          .getOccupiedTiles()
          .forEach((tp) => setTileHighlight(tp.x, tp.y, color));
      } else {
        // Fallback: Highlight just the single hovered tile if definition is missing (shouldn't happen often)
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        );
      }
    } else {
      // Edit mode but not placing: Highlight hovered furniture or tile
      const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
      if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId) {
        // Don't highlight if already selected
        // Highlight tiles occupied by hovered furniture
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
        // Highlight the single empty tile being hovered
        setTileHighlight(
          gameState.highlightedTile.x,
          gameState.highlightedTile.y,
          CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
        );
      }
      // Selected furniture highlight is handled by clearAllHighlights/ClientFurniture.draw
    }
  } else {
    // Navigate mode: Highlight interactive furniture or walkable tiles
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
      // Highlight walkable floor tile
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      );
    }
  }

  // Final check: Ensure highlighted tile is actually valid (safety net)
  if (
    gameState.highlightedTile &&
    !isValidClientTile(gameState.highlightedTile.x, gameState.highlightedTile.y)
  ) {
    gameState.highlightedTile = null;
  }
}

export function isClientPlacementValid(definition, gridX, gridY) {
  if (
    !definition ||
    !SHARED_CONFIG ||
    !gameState.currentRoomId ||
    !gameState.furniture
  )
    return false;

  // Simulate the furniture's occupied tiles
  const tempFurniProto = {
    x: gridX,
    y: gridY,
    definition: definition, // Use the actual definition
    getOccupiedTiles: ClientFurniture.prototype.getOccupiedTiles, // Borrow method
  };
  const occupiedTiles = tempFurniProto.getOccupiedTiles();

  // Check each tile the furniture would occupy
  for (const tile of occupiedTiles) {
    const gx = tile.x;
    const gy = tile.y;

    // Check 1: Is the tile within room bounds and valid terrain?
    if (!isValidClientTile(gx, gy)) return false;
    const tileType = getTileLayoutType(gx, gy);
    if (tileType === 1 || tileType === "X") return false; // Wall or Hole

    // Check 2: If placing a non-flat item, check what's underneath *this specific tile*
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

      // Cannot place on non-stackable items
      if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable) {
        return false;
      }
      // Cannot place on solid items (that aren't flat/walkable) occupying this tile
      if (isClientOccupiedBySolid(gx, gy)) {
        // Check if the solid item is specifically the top item (or part of it)
        const solidBlocker = stackOnThisTile.find(
          (f) => !f.definition?.isWalkable && !f.definition?.isFlat
        );
        if (solidBlocker) {
          // && solidBlocker === topItemOnThisTile) { // Is the solid item the top one?
          return false; // Blocked by a solid item on this tile
        }
      }
    }
  }

  // Check 3: If placing a non-flat item, check the *base* tile (gridX, gridY) specifically for stackability
  // This prevents placing the center of a large item onto a non-stackable small item.
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
    if (topItemOnBase && !topItemOnBase.definition?.stackable) {
      return false;
    }
  }

  // Check 4: Calculate estimated Z height and check against limit
  const estimatedZ =
    getClientStackHeightAt(gridX, gridY) + (definition.zOffset || 0);
  if (estimatedZ >= SHARED_CONFIG.MAX_STACK_Z) {
    return false; // Exceeds stack height limit
  }

  // If all checks pass
  return true;
}

function setTileHighlight(x, y, color) {
  // Ensure clientTiles is populated
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  if (tile) {
    tile.highlight = color;
  }
}

function clearAllHighlights() {
  if (!CLIENT_CONFIG || !gameState.clientTiles) return;
  // Clear tile highlights
  gameState.clientTiles.forEach((t) => (t.highlight = null));

  // Clear furniture selection state (visual update happens in draw)
  Object.values(gameState.furniture || {}).forEach((f) => {
    if (f instanceof ClientFurniture) {
      // Determine selection based on current edit mode state
      f.isSelected =
        uiState.isEditMode &&
        uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
        f.id === uiState.editMode.selectedFurnitureId;
    }
  });
}

export function getClientStackHeightAt(gridX, gridY) {
  if (!SHARED_CONFIG || !gameState.currentRoomId || !gameState.furniture)
    return 0;
  const gx = Math.round(gridX);
  const gy = Math.round(gridY);

  // Filter furniture items visually present at the target grid coordinates
  const stack = Object.values(gameState.furniture).filter(
    (f) =>
      f instanceof ClientFurniture &&
      Math.round(f.visualX) === gx &&
      Math.round(f.visualY) === gy
  );
  let highestStackableTopZ = 0.0; // Default ground level

  stack.forEach((furni) => {
    if (!furni.definition) return; // Skip if definition is missing

    // Calculate the effective height contribution of this item for stacking
    const itemStackHeight =
      furni.definition.stackHeight ?? (furni.definition.isFlat ? 0 : 1.0);
    const itemStackContrib =
      itemStackHeight * (SHARED_CONFIG.DEFAULT_STACK_HEIGHT ?? 0.5);
    // Calculate the Z coordinate of the top surface where another item could potentially be placed
    const itemTopSurfaceZ =
      (furni.visualZ ?? 0) + (furni.definition.isFlat ? 0 : itemStackContrib);

    // If this item allows stacking on top of it, update the highest Z found so far
    if (furni.definition.stackable) {
      highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
    }
  });
  // Return the highest Z level on which stacking is allowed, capped at 0 minimum
  return Math.max(0, highestStackableTopZ);
}

export function isValidClientTile(x, y) {
  // Check if we have room data and coordinates are within bounds
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

export function getTileLayoutType(x, y) {
  if (!isValidClientTile(x, y) || !gameState.roomLayout) {
    return null; // Invalid coordinates or no layout data
  }
  // Boundary checks again just in case
  if (y < 0 || y >= gameState.roomLayout.length) return null;
  const row = gameState.roomLayout[y];
  if (!row || x < 0 || x >= row.length) return null;

  // Return the layout type (0, 1, 2, 'X') or default to 0 (floor) if undefined
  return row[x] ?? 0;
}

export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!isValidClientTile(gx, gy)) return false; // Outside bounds

  // Check terrain type (must be floor or alt floor)
  const layoutType = getTileLayoutType(gx, gy);
  if (layoutType !== 0 && layoutType !== 2) return false; // Wall, hole, or invalid type

  // Check if occupied by a solid, non-walkable furniture item
  return !isClientOccupiedBySolid(gx, gy);
}

export function isClientOccupiedBySolid(gridX, gridY) {
  if (!gameState.furniture) return false;

  // Check if *any* furniture item visually occupying this tile is solid
  return Object.values(gameState.furniture || {}).some((f) => {
    if (!(f instanceof ClientFurniture)) return false; // Skip non-furniture
    const def = f.definition;
    if (!def) return false; // Skip if definition missing

    // A "solid" item is one that is NOT walkable and NOT flat
    const isSolid = !def.isWalkable && !def.isFlat;
    if (!isSolid) return false; // If it's walkable or flat, it's not a solid blocker

    // Check if this solid item visually occupies the target tile
    if (typeof f.getOccupiedTiles !== "function") return false; // Safety check
    return f.getOccupiedTiles().some((t) => t.x === gridX && t.y === gridY);
  });
}

export function moveCamera(dx, dy) {
  if (!camera) return;
  camera.x += dx;
  camera.y += dy;
  // Clamping camera bounds could be added here if desired
}

export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) return;

  // Use provided pivot or default to canvas center
  const pivotScreenX = pivotX ?? uiState.canvas.width / 2;
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;

  // 1. Get world position of the pivot point BEFORE zoom
  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY);

  // 2. Calculate and clamp new zoom level
  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );

  // 3. Apply new zoom
  camera.zoom = newZoom;

  // 4. Get screen position of the original world pivot point AFTER zoom
  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );

  // 5. Adjust camera pan (camera.x, camera.y) to keep the pivot point stationary on screen
  camera.x -= screenPosAfterZoomOnly.x - pivotScreenX;
  camera.y -= screenPosAfterZoomOnly.y - pivotScreenY;
}

export function centerCameraOnRoom() {
  if (
    !uiState.canvas ||
    !camera ||
    !gameState ||
    !SHARED_CONFIG ||
    gameState.roomCols <= 0 ||
    gameState.roomRows <= 0
  ) {
    console.warn(
      "Cannot center camera: prerequisites not met (canvas, camera, config, room dimensions)."
    );
    return;
  }

  try {
    // Calculate the world coordinates of the room's center
    const centerX = gameState.roomCols / 2;
    const centerY = gameState.roomRows / 2;
    // Convert world center to the base isometric screen coordinates (without pan/zoom)
    const centerIso = worldToIso(centerX, centerY);

    // Adjust camera pan (camera.x, camera.y) to place the room center
    // at the desired screen position (e.g., canvas center, or slightly above center).
    // We multiply by the current zoom to account for scaling.
    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
    // Place slightly above vertical center (e.g., 1/3 down) for better perspective
    camera.y = uiState.canvas.height / 3 - centerIso.y * camera.zoom;

    console.log(
      `Camera centered on room ${
        gameState.currentRoomId
      }. New pos: (${camera.x.toFixed(0)}, ${camera.y.toFixed(0)})`
    );
  } catch (e) {
    console.error("Error calculating camera center:", e);
  }
}

export function updateUICursor() {
  // Use inputState from inputHandler.js
  if (!uiState.gameContainer || !inputState) return;

  // Reset cursor styles first
  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = ""; // Reset to default (usually 'grab' from CSS)

  if (inputState.isDragging) {
    uiState.gameContainer.classList.add("dragging"); // Apply dragging cursor style
  } else if (uiState.isEditMode) {
    uiState.gameContainer.classList.add("edit-mode-cursor"); // Apply edit mode cursor style
  }
  // If neither dragging nor edit mode, the default 'grab' cursor (set in CSS) will apply.
}

export function getAvatarAtScreen(screenX, screenY) {
  // Filter avatars whose bounding box contains the screen point
  const candidates = Object.values(gameState.avatars || {}).filter(
    (a) =>
      a instanceof ClientAvatar &&
      typeof a.containsPoint === "function" &&
      a.containsPoint(screenX, screenY)
  );
  if (candidates.length === 0) return null;
  // Sort by draw order (higher means drawn later/on top) and return the top one
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0];
}

export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture) return null;

  // Filter furniture based on approximate visual bounding box collision
  const candidates = Object.values(gameState.furniture || {}).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;

    // Calculate approximate screen bounds (similar to ClientFurniture.draw logic)
    const screenPos = getScreenPos(f.visualX, f.visualY);
    const zoom = camera.zoom;
    const baseDrawWidth =
      SHARED_CONFIG.TILE_WIDTH_HALF * (f.definition.width || 1) * zoom * 1.1; // Use draw width
    const visualHeightFactor = f.definition.isFlat
      ? 0.1
      : f.definition.stackHeight
      ? f.definition.stackHeight * 1.5
      : 1.0;
    const baseDrawHeight =
      SHARED_CONFIG.TILE_HEIGHT_HALF * 3 * visualHeightFactor * zoom; // Use draw height
    const zOffsetPx =
      (f.visualZ || 0) *
      (CLIENT_CONFIG?.VISUAL_Z_FACTOR || SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5) *
      zoom;

    // Calculate Top/Bottom/Left/Right edges on screen
    const drawTopY =
      screenPos.y -
      baseDrawHeight +
      SHARED_CONFIG.TILE_HEIGHT_HALF * zoom -
      zOffsetPx;
    const drawBottomY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom - zOffsetPx; // Base Y adjusted for Z
    const drawLeftX = screenPos.x - baseDrawWidth / 2;
    const drawRightX = screenPos.x + baseDrawWidth / 2;

    // Check if the point is within these bounds
    return (
      screenX >= drawLeftX &&
      screenX <= drawRightX &&
      screenY >= drawTopY &&
      screenY <= drawBottomY
    );
  });

  if (candidates.length === 0) return null;

  // Sort candidates by draw order (higher means drawn later/on top)
  candidates.sort((a, b) => (b.drawOrder ?? 0) - (a.drawOrder ?? 0));
  return candidates[0]; // Return the topmost furniture item
}
