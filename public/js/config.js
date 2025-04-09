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
    // Fetch shared configuration data from the server API
    const response = await fetch("/api/config");

    // Check if the fetch request was successful
    if (!response.ok) {
      throw new Error(
        `Config fetch failed: ${response.status} ${response.statusText}`
      );
    }

    // Parse the JSON response into the SHARED_CONFIG variable
    SHARED_CONFIG = await response.json();

    // Basic validation to ensure critical shared config parts are present
    if (
      !SHARED_CONFIG?.FURNITURE_DEFINITIONS ||
      !SHARED_CONFIG?.TILE_HEIGHT_HALF
    ) {
      throw new Error("Invalid shared config received from server.");
    }
    console.log("Shared configuration loaded.");

    // --- Define Client-Specific Configuration ---
    // This object holds constants and element IDs specific to the client-side application.
    CLIENT_CONFIG = {
      // --- Core Element IDs ---
      CANVAS_ID: "gameCanvas",
      GAME_CONTAINER_ID: "game-container", // Div containing canvas and overlays
      LOADING_OVERLAY_ID: "loading-overlay",
      LOADING_MESSAGE_ID: "loading-message",

      // --- Header Element IDs ---
      ROOM_NAME_DISPLAY_ID: "room-name-display",
      PLAYER_CURRENCY_ID: "player-currency",
      LOGOUT_BTN_ID: "logout-btn",

      // --- Chat Area IDs ---
      CHAT_AREA_ID: "chat-area", // Container for log and input
      CHAT_LOG_ID: "chat-log", // Scrollable message display div
      CHAT_INPUT_ID: "chat-input", // Text input field
      BUBBLE_CONTAINER_ID: "chat-bubbles-container", // Overlay for speech bubbles

      // --- Bottom Bar IDs ---
      BOTTOM_BAR_ID: "bottom-bar",
      TOGGLE_CHAT_BTN_ID: "toggle-chat-btn", // Might just focus input
      TOGGLE_INVENTORY_BTN_ID: "toggle-inventory-btn",
      TOGGLE_ROOMS_BTN_ID: "toggle-rooms-btn",
      TOGGLE_USERS_BTN_ID: "toggle-users-btn",
      TOGGLE_SHOP_BTN_ID: "toggle-shop-btn",
      TOGGLE_EDIT_BOTTOM_BTN_ID: "toggle-edit-bottom-btn", // New edit button
      TOGGLE_ADMIN_BTN_ID: "toggle-admin-btn", // Admin panel toggle button
      TOGGLE_DEBUG_BTN_ID: "toggle-debug-btn", // Debug panel toggle button
      // Optional Zoom buttons on bottom bar
      // ZOOM_IN_BOTTOM_BTN_ID: "zoom-in-bottom-btn",
      // ZOOM_OUT_BOTTOM_BTN_ID: "zoom-out-bottom-btn",

      // --- Toggled Panel IDs (Main Container Divs) ---
      INVENTORY_PANEL_ID: "inventory-panel",
      USER_LIST_PANEL_ID: "user-list-panel", // Container for user list
      ROOMS_PANEL_ID: "rooms-panel", // Container for room list/navigation
      ADMIN_PANEL_ID: "admin-panel", // Container for admin controls
      DEBUG_PANEL_ID: "debug-panel", // Container for debug info

      // --- Content Element IDs *within* Panels ---
      INVENTORY_ITEMS_ID: "inventory-items", // Content div inside inventory panel
      USER_LIST_CONTENT_ID: "user-list-content", // UL element inside user list panel
      ROOMS_LIST_CONTENT_ID: "rooms-list-content", // Content div inside rooms panel
      ADMIN_ROOM_LIST_ID: "admin-room-list", // Content div inside admin panel
      ADMIN_LAYOUT_TILE_TYPE_ID: "admin-layout-tile-type", // Radio group inside admin panel
      CREATE_ROOM_BTN_ID: "create-room-btn", // Button inside admin panel
      DEBUG_DIV_ID: "debug-content", // Content div inside debug panel
      SHOP_ITEMS_ID: "shop-items", // Content div inside shop panel (though shop might become a toggled panel)

      // --- Existing Floating Panel IDs (Popups - may be merged into toggled panels later) ---
      PROFILE_PANEL_ID: "profile-panel",
      PROFILE_CONTENT_ID: "profile-content",
      PROFILE_CLOSE_BTN_ID: "profile-close-btn",
      RECOLOR_PANEL_ID: "recolor-panel",
      RECOLOR_SWATCHES_ID: "recolor-swatches",
      RECOLOR_ITEM_NAME_ID: "recolor-item-name",
      RECOLOR_CLOSE_BTN_ID: "recolor-close-btn",
      RECOLOR_RESET_BTN_ID: "recolor-reset-btn",
      SHOP_PANEL_ID: "shop-panel", // Main container div for shop (if still floating/toggled)
      SHOP_CLOSE_BTN_ID: "shop-close-btn",

      // --- Context Menu ID ---
      CONTEXT_MENU_ID: "context-menu",

      // --- Gameplay/Visual Settings ---
      MIN_ZOOM: 0.3, // Minimum camera zoom level
      MAX_ZOOM: 2.5, // Maximum camera zoom level
      ZOOM_FACTOR: 1.1, // Multiplier for each zoom step (scroll/button)
      CAMERA_PAN_SPEED: 15, // Pixels per frame for keyboard panning
      CHAT_BUBBLE_DURATION: 4000, // Duration chat bubbles stay visible (ms)
      MAX_CHAT_LOG_MESSAGES: 50, // Max number of messages kept in chat log
      EMOTE_DURATION: 2500, // Default client-side visual duration if definition missing (ms)
      AVATAR_SKIN_COLOR: "#F0DDBB", // Default avatar head color
      AVATAR_EYE_COLOR: "#000000", // Default avatar eye color
      INTERPOLATION_FACTOR: 0.25, // Controls smoothness of visual movement (0-1, lower is smoother but more laggy)
      VISUAL_Z_FACTOR: SHARED_CONFIG.TILE_HEIGHT_HALF * 1.5, // Pixels per Z unit for visual offset

      // Highlight Colors (RGBA for transparency)
      FURNI_PLACE_HIGHLIGHT_COLOR: "rgba(255, 255, 0, 0.5)", // Yellowish for valid placement
      FURNI_SELECT_HIGHLIGHT_COLOR: "rgba(0, 255, 255, 0.7)", // Cyan outline for selected furniture (used in draw method)
      FURNI_HOVER_HIGHLIGHT_COLOR: "rgba(0, 200, 255, 0.3)", // Light Blue overlay for hover
      TILE_EDIT_HIGHLIGHT_COLOR: "rgba(255, 0, 0, 0.4)", // Reddish for invalid placement/layout editing

      // Edit Mode State Constants (used in uiManager and inputHandler)
      EDIT_STATE_NAVIGATE: "navigate", // Default state, allows selecting items/tiles
      EDIT_STATE_PLACING: "placing", // State when placing an item from inventory
      EDIT_STATE_SELECTED_FURNI: "selected_furni", // State when a furniture item on the floor is selected
    };
    console.log("Client configuration defined.");
    return true; // Indicate success
  } catch (error) {
    // Log the error and display an alert/message to the user
    console.error("FATAL: Failed to load configuration:", error);
    alert(
      `Error loading game configuration: ${error.message}\nPlease try refreshing.`
    );

    // Attempt to display the error message in the loading overlay or debug div if available
    const loadingMsg = document.getElementById("loading-message");
    if (loadingMsg)
      loadingMsg.textContent = `FATAL ERROR: Config load failed. ${error.message}`;
    const debugDiv = document.getElementById("debug-content"); // Use raw ID as CLIENT_CONFIG failed
    if (debugDiv)
      debugDiv.innerHTML = `<span style="color:red; font-weight:bold;">FATAL ERROR: Config load failed.<br>${error.message}</span>`;

    return false; // Indicate failure
  }
}
