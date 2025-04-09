// Exported variables to hold configuration data
export let SHARED_CONFIG = null;
export let CLIENT_CONFIG = null;

/**
 * Fetches the shared configuration object from the server's API endpoint
 * and defines the client-side configuration based on it.
 * @returns {Promise<boolean>} True if configuration was loaded successfully, false otherwise.
 */
export async function loadConfig() {
  try {
    console.log("Fetching server configuration...");
    const response = await fetch("/api/config");
    if (!response.ok) {
      throw new Error(
        `Config fetch failed: ${response.status} ${response.statusText}`
      );
    }
    SHARED_CONFIG = await response.json();
    if (
      !SHARED_CONFIG?.FURNITURE_DEFINITIONS ||
      !SHARED_CONFIG?.TILE_HEIGHT_HALF
    ) {
      throw new Error("Invalid shared config received from server.");
    }
    console.log("Shared configuration loaded.");

    CLIENT_CONFIG = {
      // --- Core Element IDs ---
      CANVAS_ID: "gameCanvas",
      GAME_CONTAINER_ID: "game-container",
      LOADING_OVERLAY_ID: "loading-overlay",
      LOADING_MESSAGE_ID: "loading-message",

      // --- Header Element IDs ---
      ROOM_NAME_DISPLAY_ID: "room-name-display",
      PLAYER_CURRENCY_ID: "player-currency",
      LOGOUT_BTN_ID: "logout-btn",

      // --- Chat Area IDs ---
      CHAT_AREA_ID: "chat-area",
      CHAT_LOG_ID: "chat-log",
      CHAT_INPUT_ID: "chat-input",
      BUBBLE_CONTAINER_ID: "chat-bubbles-container",

      // --- Bottom Bar IDs ---
      BOTTOM_BAR_ID: "bottom-bar",
      TOGGLE_INVENTORY_BTN_ID: "toggle-inventory-btn",
      TOGGLE_ROOMS_BTN_ID: "toggle-rooms-btn",
      TOGGLE_USERS_BTN_ID: "toggle-users-btn",
      TOGGLE_SHOP_BTN_ID: "toggle-shop-btn",
      TOGGLE_EDIT_BOTTOM_BTN_ID: "toggle-edit-bottom-btn",
      TOGGLE_ADMIN_BTN_ID: "toggle-admin-btn",
      TOGGLE_DEBUG_BTN_ID: "toggle-debug-btn",

      // --- Toggled Panel IDs ---
      INVENTORY_PANEL_ID: "inventory-panel",
      USER_LIST_PANEL_ID: "user-list-panel",
      ROOMS_PANEL_ID: "rooms-panel",
      ADMIN_PANEL_ID: "admin-panel",
      DEBUG_PANEL_ID: "debug-panel",
      SHOP_PANEL_ID: "shop-panel", // Shop is now toggled

      // --- Content Element IDs *within* Panels ---
      INVENTORY_ITEMS_ID: "inventory-items",
      USER_LIST_CONTENT_ID: "user-list-content",
      ROOMS_LIST_CONTENT_ID: "rooms-list-content",
      ADMIN_ROOM_LIST_ID: "admin-room-list",
      ADMIN_LAYOUT_TILE_TYPE_ID: "admin-layout-tile-type",
      CREATE_ROOM_BTN_ID: "create-room-btn",
      DEBUG_DIV_ID: "debug-content",
      SHOP_ITEMS_ID: "shop-items",

      // --- Floating Panel IDs ---
      PROFILE_PANEL_ID: "profile-panel",
      PROFILE_CONTENT_ID: "profile-content",
      PROFILE_CLOSE_BTN_ID: "profile-close-btn",
      RECOLOR_PANEL_ID: "recolor-panel",
      RECOLOR_SWATCHES_ID: "recolor-swatches",
      RECOLOR_ITEM_NAME_ID: "recolor-item-name",
      RECOLOR_CLOSE_BTN_ID: "recolor-close-btn",
      RECOLOR_RESET_BTN_ID: "recolor-reset-btn",

      // --- Context Menu ID ---
      CONTEXT_MENU_ID: "context-menu",

      // --- Notification Config ---
      NOTIFICATION_CONTAINER_ID: "notification-container",
      NOTIFICATION_DURATION: 3500,
      NOTIFICATION_FADE_OUT_DURATION: 400,

      // ===== START: TRADE PANEL IDs =====
      TRADE_PANEL_ID: "trade-panel",
      TRADE_CLOSE_BTN_ID: "trade-close-btn",
      TRADE_PARTNER_NAME_ID: "trade-partner-name", // Span in header
      TRADE_PARTNER_NAME_DISPLAY_ID: "trade-partner-name-display", // Span in partner offer header
      SELF_TRADE_OFFER_ID: "self-trade-offer",
      PARTNER_TRADE_OFFER_ID: "partner-trade-offer",
      SELF_TRADE_ITEMS_GRID_ID: "self-trade-items", // Placeholder ID (use querySelector within offer area)
      PARTNER_TRADE_ITEMS_GRID_ID: "partner-trade-items", // Placeholder ID
      SELF_TRADE_CURRENCY_ID: "self-trade-currency",
      PARTNER_TRADE_CURRENCY_ID: "partner-trade-currency",
      TRADE_INVENTORY_AREA_ID: "trade-inventory-area",
      SELF_TRADE_STATUS_ID: "self-trade-status",
      PARTNER_TRADE_STATUS_ID: "partner-trade-status",
      TRADE_CONFIRM_BTN_ID: "trade-confirm-btn",
      TRADE_CANCEL_BTN_ID: "trade-cancel-btn",
      // ===== END: TRADE PANEL IDs =====

      // --- Gameplay/Visual Settings ---
      MIN_ZOOM: 0.3,
      MAX_ZOOM: 2.5,
      ZOOM_FACTOR: 1.1,
      CAMERA_PAN_SPEED: 15,
      CHAT_BUBBLE_DURATION: 4000,
      MAX_CHAT_LOG_MESSAGES: 50,
      EMOTE_DURATION: 2500,
      AVATAR_SKIN_COLOR: "#F0DDBB",
      AVATAR_EYE_COLOR: "#000000",
      INTERPOLATION_FACTOR: 0.25,
      VISUAL_Z_FACTOR: SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5,
      FURNI_PLACE_HIGHLIGHT_COLOR: "rgba(255, 255, 0, 0.5)",
      FURNI_SELECT_HIGHLIGHT_COLOR: "rgba(0, 255, 255, 0.7)",
      FURNI_HOVER_HIGHLIGHT_COLOR: "rgba(0, 200, 255, 0.3)",
      TILE_EDIT_HIGHLIGHT_COLOR: "rgba(255, 0, 0, 0.4)",
      EDIT_STATE_NAVIGATE: "navigate",
      EDIT_STATE_PLACING: "placing",
      EDIT_STATE_SELECTED_FURNI: "selected_furni",

      // ===== START: TRADE CONFIG =====
      TRADE_REQUEST_TIMEOUT: 20000, // ms for trade request popup
      // ===== END: TRADE CONFIG =====
    };
    console.log("Client configuration defined.");
    return true;
  } catch (error) {
    console.error("FATAL: Failed to load configuration:", error);
    alert(
      `Error loading game configuration: ${error.message}\nPlease try refreshing.`
    );
    const loadingMsg = document.getElementById("loading-message"); // Raw ID
    if (loadingMsg)
      loadingMsg.textContent = `FATAL ERROR: Config load failed. ${error.message}`;
    const debugDiv = document.getElementById("debug-content"); // Raw ID
    if (debugDiv)
      debugDiv.innerHTML = `<span style="color:red; font-weight:bold;">FATAL ERROR: Config load failed.<br>${error.message}</span>`;
    return false;
  }
}
