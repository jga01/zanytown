"use strict";

// --- Core Modules ---
const fs = require("fs");
const path = require("path");

// --- Application Modules ---
// Use references for config/game objects as they might depend on load order elsewhere
let ServerFurniture, ServerGameObject, ServerAvatar;
let Pathfinder;
let SHARED_CONFIG_REF, SERVER_CONFIG_REF;
let rotateDirectionFunc;

try {
  const gameObjects = require("./game_objects");
  ServerFurniture = gameObjects.ServerFurniture;
  ServerGameObject = gameObjects.ServerGameObject;
  ServerAvatar = gameObjects.ServerAvatar;

  Pathfinder = require("./pathfinder");

  const configModule = require("./config");
  SHARED_CONFIG_REF = configModule.SHARED_CONFIG;
  SERVER_CONFIG_REF = configModule.SERVER_CONFIG;

  rotateDirectionFunc = require("./utils").rotateDirection; // Assuming utils is available
} catch (e) {
  console.error("FATAL Error loading dependencies in room.js:", e);
  // Cannot proceed without dependencies
  throw new Error("Room dependencies failed to load.");
}

/**
 * Manages the state of a single game room on the server.
 */
class ServerRoom {
  /**
   * Creates an instance of ServerRoom.
   * @param {string} id - The unique identifier for this room.
   */
  constructor(id = "default_room") {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) {
      throw new Error("Configuration not loaded before creating ServerRoom.");
    }
    if (!id) {
      throw new Error("Room ID cannot be empty or null.");
    }

    this.id = id; // Store the room ID
    console.log(`[Room ${this.id}] Initializing...`);

    // Load layout (default or from file during loadStateFromFile)
    this.layout = this._getDefaultLayout(id); // Start with default layout
    this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
    this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;

    this.furniture = []; // Array of ServerFurniture instances in this room
    this.avatars = {}; // Map: socketId -> ServerAvatar instance (Avatars IN THIS ROOM)
    this.pathfinder = new Pathfinder(this); // Pathfinder specific to this room's layout

    // Note: ServerGameObject.nextId is now managed globally in server.js
    // No need to reset or manage it here per room.

    // Attempt to load persisted state specific to this room ID
    if (!this.loadStateFromFile()) {
      console.log(
        `[Room ${this.id}] No saved state found or load failed, adding initial furniture.`
      );
      // Add initial furniture based on room ID if no save file exists
      this._addInitialFurnitureForRoom(id);
    } else {
      console.log(`[Room ${this.id}] Loaded state from file.`);
    }
    console.log(
      `[Room ${this.id}] Initialization complete. Dimensions: ${this.cols}x${this.rows}. Furniture: ${this.furniture.length}.`
    );
  }

  // --- Helper for default layout based on ID (example) ---
  _getDefaultLayout(roomId) {
    // In a real application, load this from dedicated layout files (e.g., room_layouts/${roomId}.json)
    console.log(`[Room ${roomId}] Getting default layout.`);
    if (roomId === "lounge") {
      return [
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 0, 2, 0, 1, 1, 0, 2, 0, 1], // Added some alt floor
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [1, 1, "X", 1, 0, 0, 1, 1, 0, 1], // Hole and walls
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      ];
    }
    // Default layout for 'main_lobby' or any other unspecified room
    return [
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1],
      [1, "X", 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1], // Example row with Hole
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    ];
  }

  // --- Helper for initial furniture per room ---
  _addInitialFurnitureForRoom(roomId) {
    console.log(`[Room ${roomId}] Adding initial furniture...`);
    if (roomId === "main_lobby") {
      this._addInitialFurniture("rug_green", 3, 9);
      const box1 = this._addInitialFurniture("box_small", 3, 9);
      if (box1) this._addInitialFurniture("box_small", 3, 9); // Stack another box
      this._addInitialFurniture(
        "chair_basic",
        5,
        7,
        0,
        SHARED_CONFIG_REF.DIRECTION_SOUTH
      );
      this._addInitialFurniture("light_simple", 12, 12);
      // Add the door definition that leads TO the lounge
      this._addInitialFurniture("door_simple", 13, 2); // Placed at (13,2) in main_lobby
    } else if (roomId === "lounge") {
      this._addInitialFurniture("rug_green", 6, 4, 0);
      // Add a door back to the main lobby
      // This assumes a 'door_to_lobby' definition exists or 'door_simple' is flexible
      // Let's assume we need a specific definition for clarity:
      // NOTE: Requires adding 'door_to_lobby' to config.js FURNITURE_DEFINITIONS
      // { id: 'door_to_lobby', ..., isDoor: true, targetRoomId: 'main_lobby', targetX: 13, targetY: 3 }
      this._addInitialFurniture("door_to_lobby", 1, 4); // Placed at (1,4) in lounge
    }
    console.log(`[Room ${roomId}] Initial furniture placed.`);
  }

  /**
   * Helper to add initial furniture, calculating Z. Bypasses inventory checks.
   * Ensures door properties are set on the furniture instance.
   * Uses global ServerGameObject.nextId for ID assignment.
   */
  _addInitialFurniture(definitionId, x, y, zOffset = 0, rotation = 0) {
    if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) {
      console.error(
        `[Room ${this.id}] Cannot add initial furniture: SHARED_CONFIG not available.`
      );
      return null;
    }
    const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
      (def) => def.id === definitionId
    );
    if (!definition) {
      console.error(
        `[Room ${this.id}] Cannot add initial furniture: Definition ${definitionId} not found.`
      );
      return null;
    }
    try {
      const baseZ = this.getStackHeightAt(x, y); // Calculate Z based on current room state
      const placeZ = baseZ + (definition.zOffset || 0) + zOffset;

      if (placeZ >= SHARED_CONFIG_REF.MAX_STACK_Z) {
        console.warn(
          `[Room ${this.id}] Skipping initial ${definitionId} at (${x},${y}), exceeds max stack height (${placeZ} >= ${SHARED_CONFIG_REF.MAX_STACK_Z}).`
        );
        return null;
      }
      // Pass null ID to let ServerGameObject constructor assign the next global ID
      // Pass null ownerId, default state from definition, null color override
      const newFurni = new ServerFurniture(
        definitionId,
        x,
        y,
        placeZ,
        rotation,
        null /* ID */,
        null /* Owner */,
        definition.defaultState,
        null /* ColorOverride */
      );
      // ServerFurniture constructor now handles setting door properties based on definition
      this.addFurniture(newFurni); // Add to this room's furniture array
      return newFurni;
    } catch (error) {
      console.error(
        `[Room ${this.id}] Error creating initial furniture ${definitionId}:`,
        error
      );
      return null;
    }
  }

  // --- Persistence ---

  /** Gets the full path for this room's save file. */
  _getSaveFilePath() {
    if (!SERVER_CONFIG_REF || !SERVER_CONFIG_REF.DEFAULT_SAVE_DIR) {
      console.error(
        "Cannot get save file path: SERVER_CONFIG_REF or DEFAULT_SAVE_DIR missing."
      );
      // Fallback path might be needed, or throw error
      return path.resolve(__dirname, "..", `room_state_${this.id}.json`); // Less ideal fallback
    }
    const saveDir = path.resolve(
      __dirname,
      "..",
      SERVER_CONFIG_REF.DEFAULT_SAVE_DIR
    );
    // Ensure directory exists (important for first save)
    if (!fs.existsSync(saveDir)) {
      try {
        fs.mkdirSync(saveDir, { recursive: true });
        console.log(`[Room ${this.id}] Created save directory: ${saveDir}`);
      } catch (mkdirError) {
        console.error(
          `[Room ${this.id}] Failed to create save directory ${saveDir}:`,
          mkdirError
        );
        // Proceeding might fail file write later
      }
    }
    // Sanitize room ID for filename? Basic replacement for now.
    const safeRoomId = this.id.replace(/[^a-z0-9_-]/gi, "_");
    const filename = `room_state_${safeRoomId}.json`;
    return path.join(saveDir, filename);
  }

  /** Saves the current furniture state for this room. */
  saveStateToFile() {
    const filePath = this._getSaveFilePath();
    try {
      console.log(
        `[Room ${this.id}] Attempting to save state to ${filePath}...`
      );
      // Serialize furniture using the `serialize` method
      const furnitureData = this.furniture.map((f) => f.serialize());
      const roomState = {
        // Note: Global nextId is saved separately in server.js now
        furniture: furnitureData,
        layout: this.layout, // Optionally save the layout if it can change
      };
      fs.writeFileSync(filePath, JSON.stringify(roomState, null, 2));
      console.log(
        `[Room ${this.id}] State successfully saved. Items: ${furnitureData.length}.`
      );
      return true;
    } catch (err) {
      console.error(
        `[Room ${this.id}] Error saving state to ${filePath}:`,
        err
      );
      return false;
    }
  }

  /** Loads room furniture and layout state from its specific file. */
  loadStateFromFile() {
    const filePath = this._getSaveFilePath();
    try {
      if (!fs.existsSync(filePath)) {
        console.log(
          `[Room ${this.id}] Save file ${filePath} not found. Skipping load.`
        );
        this.furniture = []; // Ensure furniture is empty if no file
        // Keep default layout if no file
        return false;
      }

      console.log(
        `[Room ${this.id}] Attempting to load state from ${filePath}...`
      );
      const data = fs.readFileSync(filePath, "utf8");
      const roomState = JSON.parse(data);

      // --- Prepare for Load ---
      this.furniture = []; // Clear existing furniture before loading

      // Load layout if saved, otherwise keep default
      if (roomState.layout && Array.isArray(roomState.layout)) {
        this.layout = roomState.layout;
        this.cols =
          this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
        this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
        this.pathfinder = new Pathfinder(this); // Recreate pathfinder with loaded layout
        console.log(`[Room ${this.id}] Loaded layout from file.`);
      } else {
        console.log(
          `[Room ${this.id}] No layout found in save file, using default.`
        );
      }

      // Force stand any avatars currently in this room (should be empty on initial load, but good for reload)
      Object.values(this.avatars).forEach((avatar) => {
        if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
          console.log(
            `[Room ${this.id}] Forcing ${avatar.name} to stand due to room load/reload.`
          );
          avatar.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
          avatar.z = SHARED_CONFIG_REF.AVATAR_DEFAULT_Z;
          avatar.sittingOnFurniId = null;
        }
        avatar.path = [];
        avatar.actionAfterPath = null; // Reset pathing
      });

      // --- Load Furniture ---
      let loadedCount = 0;
      if (roomState.furniture && Array.isArray(roomState.furniture)) {
        roomState.furniture.forEach((furniData) => {
          if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) {
            console.error(
              "Cannot load furniture: SHARED_CONFIG_REF not available."
            );
            return; // Skip item if config missing
          }
          const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
            (d) => d.id === furniData.defId
          );
          if (definition) {
            try {
              // Use global nextId from server.js - Pass null ID here
              const newFurni = new ServerFurniture(
                furniData.defId,
                furniData.x,
                furniData.y,
                furniData.z,
                furniData.rot,
                null /* Let ServerGameObject assign global ID */,
                furniData.owner,
                furniData.state,
                furniData.color
              );
              // Constructor sets door properties based on definition
              this.addFurniture(newFurni);
              loadedCount++;
            } catch (furniCreateError) {
              console.error(
                `[Room ${this.id}] Error creating furniture instance for defId ${furniData.defId} during load:`,
                furniCreateError
              );
            }
          } else {
            console.warn(
              `[Room ${this.id}] Skipping loaded furniture: Unknown definition ID '${furniData.defId}'.`
            );
          }
        });
      }

      // Do NOT manage ServerGameObject.nextId here, it's handled globally in server.js after all rooms load.
      console.log(
        `[Room ${this.id}] State loaded. ${loadedCount} furniture items processed.`
      );
      return true; // Load successful
    } catch (err) {
      console.error(
        `[Room ${this.id}] Error loading state from ${filePath}:`,
        err
      );
      this.furniture = []; // Clear state on error
      // Revert to default layout on error?
      // this.layout = this._getDefaultLayout(this.id);
      // this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
      // this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
      // this.pathfinder = new Pathfinder(this);
      return false; // Load failed
    }
  }

  // --- Avatar Management (Now relative to this specific room) ---

  /** Adds an avatar instance to this room. Updates the avatar's roomId. */
  addAvatar(avatar) {
    if (!avatar || !avatar.socketId) {
      console.error(
        `[Room ${this.id}] Attempted to add invalid avatar object.`
      );
      return;
    }
    if (this.avatars[avatar.socketId]) {
      // This might happen if disconnect/reconnect logic is slightly off, try to recover
      console.warn(
        `[Room ${this.id}] Avatar ${avatar.name} (${avatar.socketId}) already in this room. Overwriting existing entry.`
      );
      // Ensure old instance (if different object) has its emote cleared?
      const oldAvatar = this.avatars[avatar.socketId];
      if (oldAvatar && oldAvatar !== avatar) {
        oldAvatar.clearEmote();
      }
    }
    this.avatars[avatar.socketId] = avatar;
    avatar.roomId = this.id; // Ensure avatar knows its current room
    console.log(
      `[Room ${this.id}] Avatar ${avatar.name} (ID: ${avatar.id}) entered.`
    );
  }

  /** Removes an avatar from this room based on their socket ID. Clears avatar's roomId. */
  removeAvatar(socketId) {
    const avatar = this.avatars[socketId];
    if (avatar) {
      console.log(
        `[Room ${this.id}] Avatar ${avatar.name} (ID: ${avatar.id}) left.`
      );
      avatar.clearEmote(); // Ensure emote timer is cleared on leave/disconnect
      avatar.roomId = null; // Clear avatar's room reference
      delete this.avatars[socketId]; // Remove from this room's tracking
      return avatar; // Return the removed avatar object
    }
    // console.log(`[Room ${this.id}] Attempted to remove avatar for socket ${socketId}, but not found in this room.`);
    return null;
  }

  /** Gets an avatar currently in this room by their socket ID. */
  getAvatarBySocketId(socketId) {
    return this.avatars[socketId];
  }

  /** Gets an avatar currently in this room by their name (case-insensitive). */
  getAvatarByName(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    // Find the first avatar in this room whose name matches case-insensitively
    return Object.values(this.avatars).find(
      (a) => a.name.toLowerCase() === lowerName
    );
  }

  // --- Furniture Management (Operates on this.furniture) ---

  /** Adds a furniture instance to this room's collection. */
  addFurniture(furni) {
    if (!furni || !(furni instanceof ServerFurniture)) {
      console.error(
        `[Room ${this.id}] Attempted to add invalid furniture object.`
      );
      return;
    }
    // Simple push, could add checks for overlap if needed but placement logic should handle it
    this.furniture.push(furni);
  }

  /** Removes a furniture item from this room by its ID. */
  removeFurniture(furniId) {
    const index = this.furniture.findIndex((f) => f.id === furniId);
    if (index > -1) {
      const removed = this.furniture.splice(index, 1)[0];
      // console.log(`[Room ${this.id}] Removed furniture: ${removed.name} (ID: ${furniId})`);
      return removed; // Return the removed furniture object
    }
    // console.warn(`[Room ${this.id}] Attempted to remove furniture ID ${furniId}, but not found.`);
    return null;
  }

  /** Gets a furniture item in this room by its ID. */
  getFurnitureById(id) {
    return this.furniture.find((f) => f.id === id);
  }

  /** Checks if any avatar currently in this room is sitting on the specified furniture. */
  isFurnitureOccupied(furniId) {
    return Object.values(this.avatars).some(
      (a) => a.sittingOnFurniId === furniId
    );
  }

  /** Gets all furniture items whose base tile is at the given grid coordinate in this room. */
  getFurnitureStackAt(gridX, gridY) {
    // Ensure grid coordinates are integers
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    return this.furniture.filter(
      (furni) => Math.round(furni.x) === gx && Math.round(furni.y) === gy
    );
  }

  /**
   * Calculates the Z height of the highest stackable surface at a grid coordinate in this room.
   * Used to determine where the next item placed there should start (its base Z).
   * @param {number} gridX - Target grid X.
   * @param {number} gridY - Target grid Y.
   * @param {number | null} excludeId - Optional furniture ID to ignore (e.g., the item being placed/moved).
   * @returns {number} The Z coordinate of the highest stackable surface.
   */
  getStackHeightAt(gridX, gridY, excludeId = null) {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) return 0; // Need config for defaults

    const stack = this.getFurnitureStackAt(gridX, gridY);
    let highestStackableTopZ = SERVER_CONFIG_REF.FURNI_DEFAULT_Z; // Start at floor Z=0

    stack.forEach((furni) => {
      if (furni.id === excludeId) return; // Skip the item itself if provided

      // Use logical stackHeight from furniture instance, multiplied by config factor
      const itemStackContribution =
        (furni.stackHeight || 0) * SHARED_CONFIG_REF.DEFAULT_STACK_HEIGHT;

      // Top surface Z = item's base Z + its contribution (if not flat)
      // Flat items contribute 0 height to the stack *surface*, though they occupy Z space
      const itemTopSurfaceZ =
        furni.z + (furni.isFlat ? 0 : itemStackContribution);

      // Only consider surfaces of stackable items for placing things *on top*
      if (furni.stackable) {
        highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
      }
    });
    // Clamp to a minimum of default Z? Usually not needed.
    return highestStackableTopZ;
  }

  /**
   * Checks if a grid tile is occupied by solid (non-walkable, non-flat) furniture in this room.
   * @param {number} gridX - Target grid X.
   * @param {number} gridY - Target grid Y.
   * @param {number | null} excludeId - Optional furniture ID to ignore.
   * @returns {boolean} True if occupied by a solid item, false otherwise.
   */
  isTileOccupiedBySolid(gridX, gridY, excludeId = null) {
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    // Check against furniture currently in this room
    return this.furniture.some(
      (furni) =>
        furni.id !== excludeId && // Exclude the specified item
        !furni.isWalkable && // Must be non-walkable
        !furni.isFlat && // Must be non-flat (solidly blocks)
        // Check if any tile occupied by this furniture matches the target grid coords
        furni.getOccupiedTiles().some((tile) => tile.x === gx && tile.y === gy)
    );
  }

  /**
   * Checks if a tile coordinate is within bounds and not a wall/hole according to this room's layout.
   * @param {number} x - Grid X coordinate.
   * @param {number} y - Grid Y coordinate.
   * @returns {boolean} True if the tile is valid terrain, false otherwise.
   */
  isValidTile(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    // Check bounds for this room
    if (gridX < 0 || gridX >= this.cols || gridY < 0 || gridY >= this.rows) {
      return false;
    }
    // Check layout type (1=wall, 'X'=hole are invalid terrain)
    const tileType = this.layout[gridY]?.[gridX]; // Use optional chaining for safety
    return tileType !== 1 && tileType !== "X"; // 0 (Floor) and 2 (Alt Floor) are valid
  }

  /**
   * Checks if a tile coordinate is walkable (valid terrain + not blocked by solid furniture) in this room.
   * @param {number} x - Grid X coordinate.
   * @param {number} y - Grid Y coordinate.
   * @returns {boolean} True if the tile is walkable, false otherwise.
   */
  isWalkable(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    // Must be valid terrain AND not occupied by a solid furniture item
    return (
      this.isValidTile(gridX, gridY) &&
      !this.isTileOccupiedBySolid(gridX, gridY)
    );
  }

  // --- State Serialization & Updates ---

  /** Creates a DTO representing the entire current state of THIS room for clients. */
  getStateDTO() {
    // DTO now represents *this specific room's* state
    return {
      id: this.id, // Include room ID
      layout: this.layout,
      cols: this.cols,
      rows: this.rows,
      furniture: this.furniture.map((f) => f.toDTO()), // DTO includes colorOverride, door info
      avatars: Object.values(this.avatars).map((a) => a.toDTO()), // Only avatars in THIS room
    };
  }

  /** Returns a list of users currently in THIS room (for UI panels). */
  getUserList() {
    return Object.values(this.avatars).map((a) => ({ id: a.id, name: a.name }));
  }

  /** Updates avatar movement within this room. */
  update(deltaTimeMs, ioInstance, changeRoomHandler) {
    // ioInstance passed for broadcasts originating from avatar updates (e.g., emote end)
    const changedAvatars = [];

    if (!changeRoomHandler) {
      // If the handler wasn't passed correctly, log an error but try to continue without room changes
      console.error(
        `[Room ${this.id}] FATAL: changeRoomHandler was not provided to update method! Door transitions will fail.`
      );
      // You might choose to throw an error here instead if room changes are critical
    }

    // Iterate using a safe method if avatars might be removed during iteration (e.g., by room change)
    const avatarSocketIds = Object.keys(this.avatars);
    for (const socketId of avatarSocketIds) {
      const avatar = this.avatars[socketId];
      // Avatar might have been removed by a previous iteration's room change, check existence
      if (!avatar) continue;

      // Update movement ONLY for avatars in THIS room
      if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_WALKING) {
        // Pass the changeRoom handler to updateMovement
        if (avatar.updateMovement(deltaTimeMs, this, changeRoomHandler)) {
          // Check if avatar still exists in this room after updateMovement (it might have changed rooms)
          if (this.avatars[socketId]) {
            // Only add to changed list if update didn't result in room change
            if (!changedAvatars.some((dto) => dto.id === avatar.id)) {
              changedAvatars.push(avatar.toDTO());
            }
          }
          // If updateMovement returned true but avatar is gone, room change happened, no DTO needed here
        }
      }
      // Emote timers are handled by setTimeout using the global 'io' instance passed to executeEmote
      // Emote end state change broadcast is handled within executeEmote's timeout callback now
    }
    // Return changes specific to this room
    return { changedAvatars };
  }

  // --- Room Specific Helpers ---

  /** Finds a suitable, walkable spawn point within this room. */
  findSpawnPoint(preferredX = -1, preferredY = -1) {
    console.log(
      `[Room ${this.id}] Finding spawn point (preferred: ${preferredX},${preferredY})`
    );
    // 1. Try preferred coordinates if provided and valid/walkable
    if (
      preferredX >= 0 &&
      preferredY >= 0 &&
      this.isWalkable(preferredX, preferredY)
    ) {
      console.log(` -> Using preferred spawn: (${preferredX}, ${preferredY})`);
      return { x: preferredX, y: preferredY };
    }
    // 2. Try center of the room
    const centerX = Math.floor(this.cols / 2);
    const centerY = Math.floor(this.rows / 2);
    if (this.isWalkable(centerX, centerY)) {
      console.log(` -> Using center spawn: (${centerX}, ${centerY})`);
      return { x: centerX, y: centerY };
    }
    // 3. Iterate outwards from center (simple spiral search)
    console.log(` -> Center unwalkable, searching outwards...`);
    for (let radius = 1; radius < Math.max(this.rows, this.cols); radius++) {
      // Check top/bottom edges of square
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        if (this.isWalkable(x, centerY - radius))
          return { x: x, y: centerY - radius };
        if (this.isWalkable(x, centerY + radius))
          return { x: x, y: centerY + radius };
      }
      // Check left/right edges (excluding corners already checked)
      for (let y = centerY - radius + 1; y < centerY + radius; y++) {
        if (this.isWalkable(centerX - radius, y))
          return { x: centerX - radius, y: y };
        if (this.isWalkable(centerX + radius, y))
          return { x: centerX + radius, y: y };
      }
    }
    // 4. Fallback: First walkable tile found (top-left scan)
    console.warn(
      `[Room ${this.id}] Could not find spawn near center, scanning all tiles...`
    );
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        if (this.isWalkable(x, y)) {
          console.warn(` -> Using fallback spawn (${x},${y})`);
          return { x: x, y: y };
        }
      }
    }
    // 5. Absolute fallback if no walkable tiles exist (error condition)
    console.error(
      `[Room ${this.id}] FATAL: No walkable tiles found! Cannot spawn avatar. Defaulting to (0,0).`
    );
    return { x: 0, y: 0 }; // Should not happen in a valid room layout
  }
} // End ServerRoom Class

// Node.js export
if (typeof module !== "undefined" && module.exports) {
  module.exports = ServerRoom;
}
