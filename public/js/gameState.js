export const camera = { x: 0, y: 0, zoom: 1.0 };

export const gameState = {
  // Room specific state
  roomLayout: [],
  roomCols: 0,
  roomRows: 0,
  clientTiles: [], // Array of ClientTile instances
  furniture: {}, // Map: string -> ClientFurniture instance
  avatars: {}, // Map: string -> ClientAvatar instance
  highlightedTile: null, // {x, y} of the currently highlighted grid tile
  currentRoomId: null, // String ID of the current room

  // Global/Persistent state
  inventory: {}, // Map: definitionId -> quantity
  myAvatarId: null, // String runtime ID of the player's avatar
  myCurrency: 0,
};

export const uiState = {
  // DOM Element References (populated by uiManager.js)
  canvas: null,
  ctx: null,
  gameContainer: null,
  debugDiv: null,
  chatInput: null,
  chatLogDiv: null,
  bubbleContainer: null,
  inventoryItemsDiv: null,
  pickupFurniBtn: null,
  recolorFurniBtn: null,
  currencyDisplay: null,
  roomNameDisplay: null,
  userListPanel: null,
  userListContent: null,
  profilePanel: null,
  profileContent: null,
  profileCloseBtn: null,
  recolorPanel: null,
  recolorSwatchesDiv: null,
  recolorItemNameP: null,
  recolorCloseBtn: null,
  recolorResetBtn: null,
  shopPanel: null,
  shopItemsDiv: null,
  shopCloseBtn: null,
  openShopBtn: null,
  logoutBtn: null, // Added logout button ref
  zoomInBtn: null,
  zoomOutBtn: null,
  toggleEditBtn: null,

  // UI Data / Flags
  activeChatBubbles: [], // Stores { id, text, endTime, avatarId, element } for positioning/removal
  chatMessages: [], // Stores chat log <p> elements for limiting count
  nextBubbleId: 0,
  isEditMode: false,
  editMode: {
    state: "navigate", // Default state
    selectedInventoryItemId: null, // definitionId string
    selectedFurnitureId: null, // furniture DB ID string
    placementValid: false,
    placementRotation: 0, // Direction (0-7)
  },
  activeRecolorFurniId: null, // furniture DB ID string
};

// Input state is managed within inputHandler.js
// export const inputState = { ... };

/** Initializes default values based on config (call after config loaded). */
export function initializeGameState(clientConfig) {
  if (clientConfig?.EDIT_STATE_NAVIGATE) {
    uiState.editMode.state = clientConfig.EDIT_STATE_NAVIGATE;
  } else {
    console.warn(
      "CLIENT_CONFIG not available during gameState initialization, using default edit state."
    );
    uiState.editMode.state = "navigate"; // Fallback
  }
}
