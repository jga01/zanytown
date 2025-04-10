// Represents the camera's position (pan) and zoom level.
export const camera = {
  x: 0, // Horizontal pan offset (screen pixels)
  y: 0, // Vertical pan offset (screen pixels)
  zoom: 1.0, // Zoom multiplier (1.0 = default)
};

// Holds the core game data received from the server or managed client-side.
export const gameState = {
  // --- Room Specific State ---
  currentRoomId: null, // String ID of the currently loaded room
  roomLayout: [], // 2D array representing the room's tile layout (e.g., [[0, 1], [0, 0]])
  roomCols: 0, // Number of columns in the current room layout
  roomRows: 0, // Number of rows in the current room layout
  clientTiles: [], // Array of ClientTile instances representing the room floor/walls
  furniture: {}, // Map: furnitureDbId (string) -> ClientFurniture instance
  avatars: {}, // Map: avatarRuntimeId (string) -> ClientAvatar instance
  npcs: {}, // <-- Map: npcRuntimeId (string) -> ClientNPC instance
  highlightedTile: null, // {x, y} world coordinates of the tile currently under the mouse, if valid

  // --- Player Specific State (Synced with Server) ---
  myAvatarId: null, // String runtime ID of the player's own avatar
  myUserId: null, // String persistent database ID (_id) of the logged-in user
  myCurrency: 0, // Player's current amount of Silly Coins
  inventory: {}, // Map: definitionId (string) -> quantity (number)
};

// Holds references to UI DOM elements and flags related to UI state.
export const uiState = {
  // --- DOM Element References (Populated by uiManager.js) ---
  // Core Rendering & Containers
  canvas: null,
  ctx: null, // Canvas 2D rendering context
  gameContainer: null, // Div containing the canvas and overlays
  bubbleContainer: null, // Div specifically for chat bubbles overlaying the canvas

  // Loading Overlay
  loadingOverlay: null,
  loadingMessage: null,

  // Header
  roomNameDisplay: null,
  currencyDisplay: null,
  logoutBtn: null,

  // Chat Area
  chatArea: null, // Main container for chat log and input
  chatLogDiv: null, // The scrollable div holding chat messages
  chatInput: null, // The text input field for chat

  // Bottom Bar
  bottomBar: null,
  toggleInventoryBtn: null,
  toggleRoomsBtn: null,
  toggleUsersBtn: null,
  toggleShopBtn: null,
  toggleEditBottomBtn: null, // Renamed edit toggle button
  toggleAdminBtn: null,
  toggleDebugBtn: null,
  // zoomInBottomBtn: null, // Optional zoom buttons
  // zoomOutBottomBtn: null, // Optional zoom buttons

  // Toggled Panels (Main container divs)
  inventoryPanel: null,
  userListPanel: null,
  roomsPanel: null,
  adminPanel: null,
  debugPanel: null,
  shopPanel: null, // Added shopPanel here

  // Content Elements *within* Toggled Panels
  inventoryItemsDiv: null, // Div inside inventoryPanel for item elements
  userListContent: null, // UL element inside userListPanel
  roomsListContent: null, // Div/UL inside roomsPanel (assuming)
  adminRoomListDiv: null, // Div inside adminPanel for room list
  layoutTileTypeSelector: null, // Radio group inside adminPanel
  debugDiv: null, // Div inside debugPanel for text content
  createRoomBtn: null, // Button inside adminPanel
  shopItemsDiv: null, // Added shopItemsDiv

  // Floating Panels (Popups)
  profilePanel: null,
  profileContent: null,
  profileCloseBtn: null,
  recolorPanel: null,
  recolorSwatchesDiv: null,
  recolorItemNameP: null,
  recolorCloseBtn: null,
  recolorResetBtn: null,
  // Note: shopCloseBtn removed as shop is now a toggled panel

  // Context Menu
  contextMenu: null, // The main context menu div
  contextMenuTarget: null, // Stores info about the right-clicked object { type: 'avatar'|'furniture'|'tile', id?, x?, y? }

  // Notification Container
  notificationContainer: null,

  // ===== START: TRADE PANEL References =====
  tradePanel: null,
  tradeCloseBtn: null,
  tradePartnerNameSpan: null, // Span in header h4
  tradePartnerNameDisplaySpan: null, // Span in partner offer h5
  selfTradeOfferDiv: null, // Container for self offer
  partnerTradeOfferDiv: null, // Container for partner offer
  selfTradeCurrencyInput: null,
  partnerTradeCurrencyInput: null,
  tradeInventoryAreaDiv: null, // Container for clickable inventory in trade panel
  selfTradeStatusSpan: null, // "Confirmed" indicator
  partnerTradeStatusSpan: null, // "Confirmed" indicator
  tradeConfirmBtn: null,
  tradeCancelBtn: null,
  // Note: Item grids within offer areas will be queried dynamically
  // ===== END: TRADE PANEL References =====

  activePanelId: null, // Tracks the ID suffix of the currently open panel (e.g., 'inventory', 'shop')

  // --- UI Data / Flags ---
  activeChatBubbles: [], // Array stores { id, text, endTime, avatarId, element } for positioning/removal
  chatMessages: [], // Array stores chat log <p> elements for limiting count
  nextBubbleId: 0, // Counter for generating unique bubble element IDs
  isEditMode: false, // Boolean flag indicating if edit mode is active
  editMode: {
    // State specific to edit mode interactions
    state: "navigate", // Current sub-state ('navigate', 'placing', 'selected_furni')
    selectedInventoryItemId: null, // definitionId string of item selected from inventory for placing
    selectedFurnitureId: null, // furniture DB ID string of item selected on the floor
    placementValid: false, // Boolean indicating if current placement location is valid
    placementRotation: 0, // Direction (0-7) for placement ghost/request
  },
  activeRecolorFurniId: null, // furniture DB ID string of the item currently being recolored

  // ===== START: TRADE State Flags =====
  isTrading: false, // Is the trade panel currently open?
  tradeSession: {
    // Info about the current trade session
    tradeId: null, // Unique ID from server
    partnerId: null, // Avatar ID of the trade partner
    partnerName: null,
    myOffer: { items: {}, currency: 0 }, // { definitionId: quantity }
    partnerOffer: { items: {}, currency: 0 },
    myConfirmed: false,
    partnerConfirmed: false,
  },
  // ===== END: TRADE State Flags =====
};

/**
 * Initializes default values for gameState and uiState based on config.
 * Called once after configuration is loaded in main.js.
 * @param {object} clientConfig - The loaded CLIENT_CONFIG object.
 */
export function initializeGameState(clientConfig) {
  // Set default edit mode state using the constant from config
  if (clientConfig?.EDIT_STATE_NAVIGATE) {
    uiState.editMode.state = clientConfig.EDIT_STATE_NAVIGATE;
  } else {
    console.warn(
      "CLIENT_CONFIG not available during gameState initialization, using default edit state 'navigate'."
    );
    uiState.editMode.state = "navigate"; // Fallback if config constant is missing
  }

  // Initialize other states if needed based on config defaults
  // Example:
  // gameState.myCurrency = clientConfig?.STARTING_CURRENCY || 0;

  // Reset trade state too
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
}
