import { gameState, uiState, camera } from "./gameState.js";
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
      const stateKey = key.replace("_ID", "");
      const camelCaseKey = stateKey
        .toLowerCase()
        .replace(/_([a-z])/g, (g) => g[1].toUpperCase());

      const foundElement = document.getElementById(elementId);
      uiState[camelCaseKey] = foundElement;

      if (!uiState[camelCaseKey]) {
        if (!["debugDiv"].includes(camelCaseKey)) {
          console.warn(
            `UI element not found for ID: ${elementId} (expected key: ${camelCaseKey})`
          );
          if (
            camelCaseKey === "canvas" ||
            camelCaseKey === "gameContainer" ||
            camelCaseKey === "chatLog" ||
            camelCaseKey === "inventoryItems" ||
            camelCaseKey === "playerCurrency" ||
            camelCaseKey === "shopItems" ||
            camelCaseKey === "recolorFurniBtn"
          ) {
            console.error(
              `CRITICAL UI element missing: ${camelCaseKey} (#${elementId})`
            );
            allElementsFound = false;
          }
        }
      }
    }
  }

  if (uiState.canvas) {
    uiState.ctx = uiState.canvas.getContext("2d");
    if (!uiState.ctx) {
      console.error("Failed to get 2D context from canvas");
      allElementsFound = false;
    }
  } else {
    console.error(
      "Canvas element (#gameCanvas) not found during UI Manager init."
    );
    allElementsFound = false;
  }

  if (allElementsFound) {
    console.log(
      "UI Manager Initialized successfully (all critical elements found)."
    );
  } else {
    console.error(
      "UI Manager Initialized with missing CRITICAL elements. Check console logs."
    );
  }
  return allElementsFound;
}

export function resetUIState() {
  console.log("Resetting UI State...");

  if (uiState.chatLog) uiState.chatLog.innerHTML = "";
  uiState.chatMessages = [];
  if (uiState.inventoryItems)
    uiState.inventoryItems.innerHTML = "<p><i>Loading...</i></p>";
  if (uiState.userListContent)
    uiState.userListContent.innerHTML = "<li><i>Joining room...</i></li>";
  if (uiState.debugDiv) uiState.debugDiv.textContent = "Resetting state...";
  if (uiState.bubbleContainer) uiState.bubbleContainer.innerHTML = "";
  uiState.activeChatBubbles = [];
  if (uiState.shopItems)
    uiState.shopItems.innerHTML = "<p><i>Stocking shelves...</i></p>";

  hideProfilePanel();
  hideRecolorPanel();
  hideShopPanel();

  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${gameState.currentRoomId})`
    : "Who's Here?";
  const header = uiState.userListPanel?.querySelector("h4");
  if (header) header.textContent = roomTitle;
  if (uiState.roomNameDisplay)
    uiState.roomNameDisplay.textContent = "Room: Connecting...";
  if (uiState.playerCurrency)
    uiState.playerCurrency.textContent = "Silly Coins: ...";
  document.title = "ZanyTown - Connecting...";

  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();
}

export function logChatMessage(message, isSelf = false, className = "") {
  if (!uiState.chatLog) {
    console.error(
      "logChatMessage failed: uiState.chatLog is still null/undefined!"
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
  p.textContent = message;

  if (isSelf) p.classList.add("self-msg");
  if (className) {
    className.split(" ").forEach((cls) => {
      if (cls) p.classList.add(cls.trim());
    });
  }

  const div = uiState.chatLog;
  const isScrolledToBottom =
    Math.abs(div.scrollHeight - div.clientHeight - div.scrollTop) < 5;

  div.appendChild(p);
  uiState.chatMessages.push(p);

  while (uiState.chatMessages.length > CLIENT_CONFIG.MAX_CHAT_LOG_MESSAGES) {
    uiState.chatMessages.shift()?.remove();
  }

  if (isScrolledToBottom) {
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
      bubble?.element?.remove();
      uiState.activeChatBubbles.splice(i, 1);
      if (bubble?.avatarId) {
        const owner = gameState.avatars[bubble.avatarId];
        if (owner && owner.chatBubble?.id === bubble.id) {
          owner.chatBubble = null;
        }
      }
    } else {
      updateChatBubblePosition(bubble);
    }
  }
}

function updateChatBubblePosition(bubble) {
  if (!bubble || !uiState.bubbleContainer) return;

  const avatar = gameState.avatars[bubble.avatarId];
  if (!avatar) {
    bubble.element?.remove();
    const index = uiState.activeChatBubbles.findIndex(
      (b) => b.id === bubble.id
    );
    if (index > -1) uiState.activeChatBubbles.splice(index, 1);
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

  uiState.debugDiv.innerHTML = `Room: ${currentRoom} | Player: (${pGrid.x},${
    pGrid.y
  }) St:${pState} Dir:${pDir}<br>Mouse: (${mGrid.x},${
    mGrid.y
  })${tileInfo}<br>Cam: (${camera.x.toFixed(0)},${camera.y.toFixed(
    0
  )}) Zoom:${camera.zoom.toFixed(
    2
  )}<br>Edit: ${editDetails}<br>Inv: ${inventoryCount} | Coins: ${
    gameState.myCurrency
  } | Objs:${furniCount}|Users:${avatarCount}|Bub:${
    uiState.activeChatBubbles.length
  }|Sock:${isConnected() ? "OK" : "DOWN"}`;
}

export function populateInventory() {
  if (!uiState.inventoryItems) {
    console.error(
      "populateInventory failed: uiState.inventoryItems is still null/undefined!"
    );
    if (uiState.debugDiv)
      uiState.debugDiv.innerHTML +=
        "<br><span style='color:red'>Inventory UI missing!</span>";
    return;
  }
  if (!SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    uiState.inventoryItems.innerHTML =
      "<p><i>Error loading inventory data (Config missing?).</i></p>";
    return;
  }

  uiState.inventoryItems.innerHTML = "";

  const inventory = gameState.inventory;
  const ownedItemIds = Object.keys(inventory || {}).filter(
    (id) => inventory[id] > 0
  );

  if (ownedItemIds.length === 0) {
    uiState.inventoryItems.innerHTML = "<p><i>Inventory empty.</i></p>";
    if (uiState.editMode.state === CLIENT_CONFIG?.EDIT_STATE_PLACING) {
      setSelectedInventoryItem(null);
    }
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
    if (!def) {
      console.warn(`Inventory item ID '${itemId}' not found in definitions.`);
      return;
    }

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

    uiState.inventoryItems.appendChild(itemDiv);
  });

  updateInventorySelection();
}

export function updateInventorySelection() {
  if (!uiState.inventoryItems || !CLIENT_CONFIG) return;
  uiState.inventoryItems.querySelectorAll(".inventory-item").forEach((item) => {
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
      uiState.editMode.selectedFurnitureId;
    uiState.pickupFurniBtn.disabled = !enabled;
  }
}

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

export function updateCurrencyDisplay() {
  if (!uiState.playerCurrency) {
    console.warn(
      "updateCurrencyDisplay skipped: uiState.playerCurrency is null/undefined!"
    );
    if (uiState.debugDiv)
      uiState.debugDiv.innerHTML +=
        "<br><span style='color:orange'>Currency UI missing!</span>";
    return;
  }

  const currentText = uiState.playerCurrency.textContent || "Silly Coins: 0";
  const oldValueStr = currentText.match(/\d+/)
    ? currentText.match(/\d+/)[0]
    : "0";
  const oldValue = parseInt(oldValueStr, 10);
  const newValue = gameState.myCurrency;

  uiState.playerCurrency.textContent = `Silly Coins: ${newValue}`;

  if (
    !isNaN(oldValue) &&
    newValue !== oldValue &&
    !uiState.playerCurrency.classList.contains("flash-green") &&
    !uiState.playerCurrency.classList.contains("flash-red")
  ) {
    const changeClass = newValue > oldValue ? "flash-green" : "flash-red";
    uiState.playerCurrency.classList.add(changeClass);
    setTimeout(() => {
      uiState.playerCurrency.classList.remove(changeClass);
    }, 600);
  }
}

export function showShopPanel() {
  if (!uiState.shopPanel) {
    console.warn("Cannot show shop: Shop panel element not found.");
    return;
  }
  populateShopPanel();
  uiState.shopPanel.style.display = "block";
}

export function hideShopPanel() {
  if (uiState.shopPanel) uiState.shopPanel.style.display = "none";
}

function populateShopPanel() {
  if (!uiState.shopItems) {
    console.warn(
      "populateShopPanel skipped: uiState.shopItems is null/undefined!"
    );
    return;
  }
  if (!SHARED_CONFIG?.SHOP_CATALOG || !SHARED_CONFIG?.FURNITURE_DEFINITIONS) {
    uiState.shopItems.innerHTML =
      "<p><i>Error loading shop data (Config missing?).</i></p>";
    return;
  }

  uiState.shopItems.innerHTML = "";

  if (
    !Array.isArray(SHARED_CONFIG.SHOP_CATALOG) ||
    SHARED_CONFIG.SHOP_CATALOG.length === 0
  ) {
    uiState.shopItems.innerHTML = "<p><i>Shop is empty!</i></p>";
    return;
  }

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
      return;
    }

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

    uiState.shopItems.appendChild(itemDiv);
  });

  updateShopButtonStates();
}

export function updateShopButtonStates() {
  if (!uiState.shopItems) return;
  uiState.shopItems.querySelectorAll("button.buy-btn").forEach((button) => {
    const price = parseInt(button.dataset.price, 10);
    if (!isNaN(price)) {
      const canAfford = gameState.myCurrency >= price;
      button.disabled = !canAfford;
      button.classList.toggle("cannot-afford", !canAfford);
      if (button.textContent === "Buying...") {
        button.textContent = "Buy";
      }
    } else {
      button.disabled = true;
    }
  });
}

export function updateUserListPanel(users) {
  if (!uiState.userListContent || !uiState.userListPanel) {
    console.warn("Cannot update user list: Panel/Content element not found.");
    return;
  }
  uiState.userListContent.innerHTML = "";

  const roomTitle = gameState.currentRoomId
    ? `Who's Here? (${gameState.currentRoomId})`
    : "Who's Here?";
  const header = uiState.userListPanel.querySelector("h4");
  if (header) header.textContent = roomTitle;

  if (!users || users.length === 0) {
    uiState.userListContent.innerHTML = "<li><i>Nobody here...</i></li>";
    return;
  }

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

export function showProfilePanel(profileData) {
  if (!uiState.profilePanel || !uiState.profileContent) {
    console.warn("Cannot show profile: Panel/Content element not found.");
    return;
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
        <div class="profile-actions">

        </div>
    `;

  uiState.profilePanel.dataset.targetId = id;
  uiState.profilePanel.style.display = "block";
}

export function hideProfilePanel() {
  if (uiState.profilePanel) {
    uiState.profilePanel.style.display = "none";
    uiState.profilePanel.dataset.targetId = "";
    if (uiState.profileContent) uiState.profileContent.innerHTML = "";
  }
}

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
    console.warn("Cannot show recolor panel: Prerequisites not met.", {
      furniExists: !!furni,
      canRecolor: furni?.canRecolor,
      configExists: !!SHARED_CONFIG?.VALID_RECOLOR_HEX,
      panelElement: !!uiState.recolorPanel,
      swatchesElement: !!uiState.recolorSwatchesDiv,
      nameElement: !!uiState.recolorItemNameP,
    });
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

export function hideRecolorPanel() {
  if (uiState.recolorPanel) {
    uiState.recolorPanel.style.display = "none";
  }
  uiState.activeRecolorFurniId = null;
}

function handleRecolorSwatchClick(hexColor) {
  if (uiState.activeRecolorFurniId && isConnected()) {
    requestRecolorFurni(uiState.activeRecolorFurniId, hexColor);
    hideRecolorPanel();
  }
}

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
    updateHighlights();
  }
  if (
    oldState === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI &&
    newState !== CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI
  ) {
    setSelectedFurniture(null);
    hideRecolorPanel();
  }

  updatePickupButtonState();
  updateRecolorButtonState();
  updateInventorySelection();
  updateUICursor();
}

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
}

export function setSelectedFurniture(furnitureId) {
  const newSelectedId = furnitureId ? String(furnitureId) : null;
  if (uiState.editMode.selectedFurnitureId === newSelectedId) {
    if (newSelectedId !== null) {
      console.log(`Deselecting floor furniture: ${newSelectedId}`);
      const oldFurni = gameState.furniture[newSelectedId];
      if (oldFurni) {
        oldFurni.isSelected = false;
      }
      uiState.editMode.selectedFurnitureId = null;
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
      hideRecolorPanel();
      updatePickupButtonState();
      updateRecolorButtonState();
      updateHighlights();
    }
    return;
  }

  console.log(`Setting selected floor furniture: ${newSelectedId}`);

  const oldSelectedId = uiState.editMode.selectedFurnitureId;
  if (oldSelectedId && gameState.furniture[oldSelectedId]) {
    gameState.furniture[oldSelectedId].isSelected = false;
  }

  uiState.editMode.selectedFurnitureId = newSelectedId;

  if (newSelectedId && gameState.furniture[newSelectedId]) {
    gameState.furniture[newSelectedId].isSelected = true;
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI);
  } else {
    uiState.editMode.selectedFurnitureId = null;
    hideRecolorPanel();
    if (uiState.editMode.state === CLIENT_CONFIG.EDIT_STATE_SELECTED_FURNI) {
      setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    }
  }

  updatePickupButtonState();
  updateRecolorButtonState();
  updateHighlights();
}

export function toggleEditMode() {
  if (!CLIENT_CONFIG || !uiState.toggleEditBtn) return;
  uiState.isEditMode = !uiState.isEditMode;
  console.log(`Toggled Edit Mode: ${uiState.isEditMode ? "ON" : "OFF"}`);

  uiState.toggleEditBtn.textContent = `Make Stuff? (${
    uiState.isEditMode ? "On" : "Off"
  })`;
  uiState.toggleEditBtn.classList.toggle("active", uiState.isEditMode);

  if (!uiState.isEditMode) {
    setSelectedFurniture(null);
    setSelectedInventoryItem(null);
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
    hideRecolorPanel();
  } else {
    setEditState(CLIENT_CONFIG.EDIT_STATE_NAVIGATE);
  }

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
    playSound("pickup");
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
    hideRecolorPanel();
  }
}

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
    ) {
      uiState.editMode.placementValid = false;
    }
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
      } else {
        setTileHighlight(
          gridPos.x,
          gridPos.y,
          CLIENT_CONFIG.TILE_EDIT_HIGHLIGHT_COLOR
        );
      }
    } else {
      const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
      if (hoveredF && hoveredF.id !== uiState.editMode.selectedFurnitureId) {
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
    }
  } else {
    const hoveredF = getTopmostFurnitureAtScreen(screenPos.x, screenPos.y);
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
      setTileHighlight(
        gameState.highlightedTile.x,
        gameState.highlightedTile.y,
        CLIENT_CONFIG.FURNI_HOVER_HIGHLIGHT_COLOR
      );
    }
  }

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
      const stack = Object.values(gameState.furniture).filter(
        (f) =>
          f instanceof ClientFurniture &&
          Math.round(f.visualX) === gx &&
          Math.round(f.visualY) === gy
      );
      const topItemOnThisTile = stack.sort(
        (a, b) => (b.visualZ ?? 0) - (a.visualZ ?? 0)
      )[0];

      if (topItemOnThisTile && !topItemOnThisTile.definition?.stackable) {
        return false;
      }
      if (isClientOccupiedBySolid(gx, gy)) {
        const solidBlocker = stack.find(
          (f) => !f.isWalkable && !f.isFlat && !f.stackable
        );
        if (solidBlocker) {
          return false;
        }
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
    if (topItemOnBase && !topItemOnBase.definition?.stackable) {
      return false;
    }
  }

  const estimatedZ =
    getClientStackHeightAt(gridX, gridY) + (definition.zOffset || 0);
  if (estimatedZ >= SHARED_CONFIG.MAX_STACK_Z) {
    return false;
  }

  return true;
}

function setTileHighlight(x, y, color) {
  const tile = gameState.clientTiles?.find((t) => t.x === x && t.y === y);
  if (tile) {
    tile.highlight = color;
  }
}

function clearAllHighlights() {
  if (!CLIENT_CONFIG || !gameState.clientTiles) return;
  gameState.clientTiles.forEach((t) => (t.highlight = null));

  Object.values(gameState.furniture || {}).forEach((f) => {
    if (f instanceof ClientFurniture) {
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

export function getTileLayoutType(x, y) {
  if (!isValidClientTile(x, y) || !gameState.roomLayout) {
    return null;
  }
  if (y < 0 || y >= gameState.roomLayout.length) return null;
  const row = gameState.roomLayout[y];
  if (!row || x < 0 || x >= row.length) return null;

  return row[x] ?? 0;
}

export function isClientWalkable(x, y) {
  const gx = Math.round(x);
  const gy = Math.round(y);
  if (!isValidClientTile(gx, gy)) return false;

  const layoutType = getTileLayoutType(gx, gy);
  if (layoutType !== 0 && layoutType !== 2) return false;

  return !isClientOccupiedBySolid(gx, gy);
}

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

export function moveCamera(dx, dy) {
  if (!camera) return;
  camera.x += dx;
  camera.y += dy;
}

export function changeZoom(factor, pivotX, pivotY) {
  if (!uiState.canvas || !CLIENT_CONFIG || !camera) return;

  const pivotScreenX = pivotX ?? uiState.canvas.width / 2;
  const pivotScreenY = pivotY ?? uiState.canvas.height / 2;

  const worldPosBefore = isoToWorld(pivotScreenX, pivotScreenY);

  const oldZoom = camera.zoom;
  const newZoom = Math.max(
    CLIENT_CONFIG.MIN_ZOOM,
    Math.min(CLIENT_CONFIG.MAX_ZOOM, camera.zoom * factor)
  );

  camera.zoom = newZoom;

  const screenPosAfterZoomOnly = getScreenPos(
    worldPosBefore.x,
    worldPosBefore.y
  );

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
    const centerX = gameState.roomCols / 2;
    const centerY = gameState.roomRows / 2;
    const centerIso = worldToIso(centerX, centerY);

    camera.x = uiState.canvas.width / 2 - centerIso.x * camera.zoom;
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
  if (!uiState.gameContainer || !inputState) return;

  uiState.gameContainer.classList.remove("dragging", "edit-mode-cursor");
  uiState.gameContainer.style.cursor = "";

  if (inputState.isDragging) {
    uiState.gameContainer.classList.add("dragging");
  } else if (uiState.isEditMode) {
    uiState.gameContainer.classList.add("edit-mode-cursor");
  } else {
    uiState.gameContainer.style.cursor = "grab";
  }
}

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

export function getTopmostFurnitureAtScreen(screenX, screenY) {
  if (!SHARED_CONFIG || !camera || !gameState.furniture) return null;

  const candidates = Object.values(gameState.furniture || {}).filter((f) => {
    if (!(f instanceof ClientFurniture) || !f.definition) return false;

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
