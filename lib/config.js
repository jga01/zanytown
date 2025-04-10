"use strict";

const fs = require("fs"); // Require the file system module
const path = require("path"); // Require the path module

// --- Load Furniture Definitions from JSON ---
let loadedFurnitureDefinitions = [];
try {
  // Construct the absolute path to the data file relative to this config file's directory
  const filePath = path.join(
    __dirname,
    "..",
    "data",
    "furniture_definitions.json"
  );

  // Check if the file exists before attempting to read
  if (!fs.existsSync(filePath)) {
    throw new Error(`Furniture definitions file not found at: ${filePath}`);
  }

  // Read the file synchronously (acceptable for startup config)
  const jsonData = fs.readFileSync(filePath, "utf8");

  // Parse the JSON data
  loadedFurnitureDefinitions = JSON.parse(jsonData);

  // Optional: Basic validation after parsing
  if (!Array.isArray(loadedFurnitureDefinitions)) {
    throw new Error(
      "furniture_definitions.json does not contain a valid JSON array."
    );
  }

  console.log(
    `Successfully loaded ${loadedFurnitureDefinitions.length} furniture definitions from JSON.`
  );
} catch (error) {
  console.error(
    "!!! FATAL ERROR: Failed to load or parse furniture_definitions.json !!!"
  );
  console.error(error.message); // Log the specific error message
  // Exit the process if furniture definitions are critical for server operation
  console.error("Exiting due to critical configuration error.");
  process.exit(1); // Ensure server stops if definitions fail to load
  // Note: loadedFurnitureDefinitions will remain empty if exit doesn't happen immediately
}
// --- End Loading ---

// Shared configuration between Client and Server
const SHARED_CONFIG = {
  // Tile dimensions
  TILE_WIDTH_HALF: 32,
  TILE_HEIGHT_HALF: 16,
  // Stacking
  DEFAULT_STACK_HEIGHT: 0.5, // Multiplier for furniture stackHeight definition
  MAX_STACK_Z: 5.0, // Maximum allowed Z coordinate for the top of an item
  // Avatar
  AVATAR_DEFAULT_Z: 0.01,
  DEFAULT_CURRENCY: 10, // Start with some currency for testing

  // --- Use the loaded definitions ---
  // Furniture definitions are now loaded from data/furniture_definitions.json
  FURNITURE_DEFINITIONS: loadedFurnitureDefinitions,

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

  // --- Shop Catalog ---
  // Items listed here should have a corresponding entry in furniture_definitions.json
  SHOP_CATALOG: [
    { itemId: "chair_basic", price: 10 },
    { itemId: "box_small", price: 5 },
    { itemId: "rug_green", price: 15 },
    { itemId: "light_simple", price: 20 },
    { itemId: "chair_comfy", price: 25 },
    // Add more items as desired
  ],

  // --- Valid Recolor Colors ---
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
  DEFAULT_ROOM_COLS: 15, // Default cols if layout missing from DB/file
  DEFAULT_ROOM_ROWS: 18, // Default rows if layout missing from DB/file
  AVATAR_SPEED: 4.0, // Tiles per second
  TICK_RATE: 20, // Server ticks per second
  PORT: process.env.PORT || 3000,
  EMOTE_DURATION_SERVER: 3000, // Default duration if not specified in emote def

  // --- Multi-Room Settings ---
  INITIAL_ROOMS: ["main_lobby", "lounge"], // Room IDs to load/create on server startup
  DEFAULT_ROOM_ID: "main_lobby", // Room ID where new players initially spawn
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SHARED_CONFIG,
    SERVER_CONFIG,
  };
}
