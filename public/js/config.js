export let SHARED_CONFIG = null;
export let CLIENT_CONFIG = null;

/** Fetches shared config and defines client config. Returns true on success, false on failure. */
export async function loadConfig() {
  try {
    console.log("Fetching server configuration...");
    const response = await fetch("/api/config");
    if (!response.ok)
      throw new Error(
        `Config fetch failed: ${response.status} ${response.statusText}`
      );
    SHARED_CONFIG = await response.json();
    if (
      !SHARED_CONFIG?.FURNITURE_DEFINITIONS ||
      !SHARED_CONFIG?.TILE_HEIGHT_HALF
    ) {
      throw new Error("Invalid shared config received from server.");
    }
    console.log("Shared configuration loaded.");

    // Define Client-Specific Configuration (dependent on SHARED_CONFIG)
    CLIENT_CONFIG = {
      CANVAS_ID: "gameCanvas",
      GAME_CONTAINER_ID: "game-container",
      DEBUG_DIV_ID: "debug-content",
      CHAT_INPUT_ID: "chat-input",
      CHAT_LOG_ID: "chat-log",
      BUBBLE_CONTAINER_ID: "chat-bubbles-container",
      INVENTORY_ITEMS_ID: "inventory-items",
      PICKUP_FURNI_BTN_ID: "pickup-furni-btn",
      RECOLOR_FURNI_BTN_ID: "recolor-furni-btn",
      PLAYER_CURRENCY_ID: "player-currency",
      ROOM_NAME_DISPLAY_ID: "room-name-display",
      ZOOM_IN_BTN_ID: "zoom-in-btn",
      ZOOM_OUT_BTN_ID: "zoom-out-btn",
      TOGGLE_EDIT_BTN_ID: "toggle-edit-btn",
      USER_LIST_PANEL_ID: "user-list-panel",
      USER_LIST_CONTENT_ID: "user-list-content",
      PROFILE_PANEL_ID: "profile-panel",
      PROFILE_CONTENT_ID: "profile-content",
      PROFILE_CLOSE_BTN_ID: "profile-close-btn",
      RECOLOR_PANEL_ID: "recolor-panel",
      RECOLOR_SWATCHES_ID: "recolor-swatches",
      RECOLOR_ITEM_NAME_ID: "recolor-item-name",
      RECOLOR_CLOSE_BTN_ID: "recolor-close-btn",
      RECOLOR_RESET_BTN_ID: "recolor-reset-btn",
      SHOP_PANEL_ID: "shop-panel",
      SHOP_ITEMS_ID: "shop-items",
      SHOP_CLOSE_BTN_ID: "shop-close-btn",
      OPEN_SHOP_BTN_ID: "open-shop-btn",
      LOGOUT_BTN_ID: "logout-btn", // Added logout button ID
      LOADING_OVERLAY_ID: "loading-overlay",
      LOADING_MESSAGE_ID: "loading-message",

      // Gameplay/Visual Settings
      MIN_ZOOM: 0.3,
      MAX_ZOOM: 2.5,
      ZOOM_FACTOR: 1.1, // Multiplier for zoom steps
      CAMERA_PAN_SPEED: 15, // Pixels per frame for key panning
      CHAT_BUBBLE_DURATION: 4000, // ms
      MAX_CHAT_LOG_MESSAGES: 50,
      EMOTE_DURATION: 2500, // Default client-side visual duration if definition missing
      AVATAR_SKIN_COLOR: "#F0DDBB",
      AVATAR_EYE_COLOR: "#000000",
      INTERPOLATION_FACTOR: 0.25, // Controls smoothness of visual movement (0-1)
      VISUAL_Z_FACTOR: SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5, // Pixels per Z unit
      // Highlight Colors (RGBA for transparency)
      FURNI_PLACE_HIGHLIGHT_COLOR: "rgba(255, 255, 0, 0.5)", // Yellowish
      FURNI_SELECT_HIGHLIGHT_COLOR: "rgba(0, 255, 255, 0.7)", // Cyan
      FURNI_HOVER_HIGHLIGHT_COLOR: "rgba(0, 200, 255, 0.3)", // Light Blue
      TILE_EDIT_HIGHLIGHT_COLOR: "rgba(255, 0, 0, 0.4)", // Reddish (invalid placement)
      // Edit Mode State Constants
      EDIT_STATE_NAVIGATE: "navigate",
      EDIT_STATE_PLACING: "placing",
      EDIT_STATE_SELECTED_FURNI: "selected_furni",
    };
    console.log("Client configuration defined.");
    return true; // Indicate success
  } catch (error) {
    console.error("FATAL: Failed to load configuration:", error);
    alert(
      `Error loading game configuration: ${error.message}\nPlease try refreshing.`
    );
    // Attempt to display error even if CLIENT_CONFIG failed
    const debugDiv = document.getElementById("debug-content");
    if (debugDiv)
      debugDiv.innerHTML = `<span style="color:red; font-weight:bold;">FATAL ERROR: Config load failed.<br>${error.message}</span>`;
    return false; // Indicate failure
  }
}
