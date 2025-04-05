"use strict";

// Shared configuration between Client and Server
const SHARED_CONFIG = {
  // Tile dimensions
  TILE_WIDTH_HALF: 32,
  TILE_HEIGHT_HALF: 16,
  // Stacking
  DEFAULT_STACK_HEIGHT: 0.5, // Multiplier for furniture stackHeight definition
  MAX_STACK_Z: 5.0, // Maximum allowed Z coordinate for the top of an item
  // Avatar
  AVATAR_DEFAULT_Z: 0.0,
  DEFAULT_CURRENCY: 10, // Start with some currency for testing

  // Furniture definitions (keep in sync with client)
  FURNITURE_DEFINITIONS: [
    {
      id: "chair_basic",
      name: "Basic Chair",
      color: "#A0522D",
      width: 1,
      height: 1,
      canSit: true,
      sitDir: 2,
      sitHeightOffset: 0.4,
      isWalkable: false,
      stackable: false,
      stackHeight: 1.0,
      zOffset: 0,
      canRecolor: true,
    },
    {
      id: "chair_comfy",
      name: "Comfy Chair",
      color: "#D2691E",
      width: 1,
      height: 1,
      canSit: true,
      sitDir: 2,
      sitHeightOffset: 0.4,
      isWalkable: false,
      stackable: false,
      stackHeight: 1.0,
      zOffset: 0,
      canRecolor: true,
    },
    {
      id: "box_small",
      name: "Small Box",
      color: "#8B4513",
      width: 1,
      height: 1,
      canSit: false,
      isWalkable: false,
      stackable: true,
      stackHeight: 0.5,
      zOffset: 0,
      canRecolor: true,
    },
    {
      id: "rug_green",
      name: "Green Rug",
      color: "#2E8B57",
      width: 2,
      height: 2,
      canSit: false,
      isWalkable: true,
      isFlat: true,
      stackable: true,
      stackHeight: 0.0,
      zOffset: -0.01,
      canRecolor: false,
    }, // Rugs not recolorable
    {
      id: "light_simple",
      name: "Simple Lamp",
      color: "#FFFFE0",
      width: 1,
      height: 1,
      canSit: false,
      isWalkable: false,
      stackable: true,
      stackHeight: 0.8,
      zOffset: 0,
      canUse: true,
      isToggle: true,
      defaultState: "off",
      canRecolor: false,
    }, // Lamp color based on state

    // --- NEW: Example Door Definition ---
    // This door leads FROM main_lobby TO lounge, spawning at (2,2) in the lounge.
    // Remember to place a corresponding door in the lounge layout leading back.
    {
      id: "door_simple", // Unique ID for this type of door
      name: "Simple Door", // Display name
      color: "#654321", // Default color (brown)
      width: 1,
      height: 1, // Dimensions
      canSit: false, // Cannot sit on doors
      isWalkable: false, // Cannot walk through (interaction needed)
      isFlat: false, // Doors are typically vertical
      stackable: false, // Cannot stack things on doors
      stackHeight: 2.0, // Visual height (doesn't affect stacking)
      zOffset: 0, // Base Z offset
      canRecolor: false, // Doors usually not recolorable
      canUse: false, // Not 'used' in the toggle sense
      // --- Door Specific Properties ---
      isDoor: true, // Flag indicating this is a door/portal
      targetRoomId: "lounge", // ID of the room this door leads to
      targetX: 2, // Target X coordinate in the destination room
      targetY: 2, // Target Y coordinate in the destination room
    },
    {
      id: "door_to_lobby", // Unique ID for this door instance/type
      name: "Door to Lobby", // Display name
      color: "#654321", // Can be same as other door or different
      width: 1,
      height: 1,
      canSit: false,
      isWalkable: false, // Interaction needed
      isFlat: false,
      stackable: false,
      stackHeight: 2.0,
      zOffset: 0,
      canRecolor: false,
      canUse: false,
      // --- Door Specific Properties ---
      isDoor: true, // Flag indicating this is a door/portal
      targetRoomId: "main_lobby", // Target room ID
      targetX: 13, // Target X coordinate in main_lobby
      targetY: 3, // Target Y coordinate in main_lobby
    },
  ],

  // Avatar States (Used in client & server)
  AVATAR_STATE_IDLE: "idle",
  AVATAR_STATE_WALKING: "walking",
  AVATAR_STATE_SITTING: "sitting",
  AVATAR_STATE_EMOTING: "emoting",

  // Directions (0=E, 2=S, 4=W, 6=N) - Used for rotation/facing
  DIRECTION_EAST: 0,
  DIRECTION_SOUTH_EAST: 1,
  DIRECTION_SOUTH: 2,
  DIRECTION_SOUTH_WEST: 3,
  DIRECTION_WEST: 4,
  DIRECTION_NORTH_WEST: 5,
  DIRECTION_NORTH: 6,
  DIRECTION_NORTH_EAST: 7,

  // --- Emote Definitions ---
  EMOTE_DEFINITIONS: {
    // IDs should match commands or payload
    wave: { id: "wave", duration: 2500, sound: "wave", animation: "pose_wave" }, // Example sound/anim names
    dance: {
      id: "dance",
      duration: 4000,
      sound: "dance",
      animation: "anim_dance",
    },
    happy: {
      id: "happy",
      duration: 2000,
      sound: "happy",
      animation: "pose_happy",
    },
    sad: { id: "sad", duration: 3000, sound: "sad", animation: "pose_sad" },
  },

  SHOP_CATALOG: [
    { itemId: "chair_basic", price: 10 },
    { itemId: "box_small", price: 5 },
    { itemId: "rug_green", price: 15 },
    { itemId: "light_simple", price: 20 },
    { itemId: "chair_comfy", price: 25 },
    // Add more items as desired, ensure itemId matches FURNITURE_DEFINITIONS
  ],

  // Default valid colors for recoloring (can be expanded)
  VALID_RECOLOR_HEX: [
    "#FF0000",
    "#00FF00",
    "#0000FF",
    "#FFFF00",
    "#FF00FF",
    "#00FFFF",
    "#FFFFFF",
    "#808080",
    "#FFA500",
    "#800080",
  ], // Red, Green, Blue, Yellow, Magenta, Cyan, White, Grey, Orange, Purple
};

// Server-specific configuration
const SERVER_CONFIG = {
  FURNI_DEFAULT_Z: 0.0,
  DEFAULT_ROOM_COLS: 15, // Default cols if layout missing
  DEFAULT_ROOM_ROWS: 18, // Default rows if layout missing
  AVATAR_SPEED: 4.0, // Tiles per second
  TICK_RATE: 20, // Server ticks per second
  PORT: process.env.PORT || 3000,
  EMOTE_DURATION_SERVER: 3000, // Default duration if not specified in emote def

  // --- NEW: Multi-Room Settings ---
  INITIAL_ROOMS: ["main_lobby", "lounge"], // Room IDs to load/create on server startup
  DEFAULT_ROOM_ID: "main_lobby", // Room ID where new players initially spawn
};

// Node.js export
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHARED_CONFIG,
    SERVER_CONFIG,
  };
}
