"use strict";

// --- Core Node Modules ---
const fs = require("fs");
const path = require("path");

// --- Application Modules ---
let ServerFurniture, ServerGameObject, ServerAvatar;
let Pathfinder;
let SHARED_CONFIG_REF, SERVER_CONFIG_REF;
let rotateDirectionFunc;
let RoomState; // Database model for room layout/metadata
let Furniture; // Database model for individual furniture items

// --- Dependency Loading ---
try {
  const gameObjects = require("./game_objects");
  ServerFurniture = gameObjects.ServerFurniture;
  ServerGameObject = gameObjects.ServerGameObject;
  ServerAvatar = gameObjects.ServerAvatar;

  Pathfinder = require("./pathfinder");

  const configModule = require("./config");
  SHARED_CONFIG_REF = configModule.SHARED_CONFIG;
  SERVER_CONFIG_REF = configModule.SERVER_CONFIG;

  rotateDirectionFunc = require("./utils").rotateDirection;

  RoomState = require("../models/roomState");
  Furniture = require("../models/furniture");
  if (!RoomState || !Furniture) {
    throw new Error("RoomState or Furniture model failed to load.");
  }
  // Basic check if config itself loaded
  if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) {
    throw new Error(
      "Configuration (SHARED_CONFIG or SERVER_CONFIG) failed to load."
    );
  }
} catch (e) {
  console.error("FATAL Error loading dependencies in room.js:", e);
  // Propagate the error to prevent server running in broken state
  throw new Error("Room dependencies failed to load.");
}

/**
 * Manages the state of a single game room on the server.
 */
class ServerRoom {
  /**
   * Creates an instance of ServerRoom. Initializes structure, async loading happens later.
   * @param {string} id - The unique identifier for this room.
   */
  constructor(id = "default_room") {
    // Config is guaranteed to exist here due to checks in the outer try-catch
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      throw new Error("Room ID cannot be empty or null.");
    }

    this.id = id.trim();
    console.log(`[Room ${this.id}] Initializing structure...`);

    // --- Load default layout initially from file/fallback ---
    // This will be overridden by loadStateFromDB if DB state exists.
    this.layout = this._getDefaultLayout(this.id); // Call the modified loader
    if (
      !this.layout ||
      !Array.isArray(this.layout) ||
      this.layout.length === 0 ||
      !Array.isArray(this.layout[0])
    ) {
      console.error(
        `[Room ${this.id}] CRITICAL: Failed to load any valid default layout during constructor! Check _getDefaultLayout and file paths.`
      );
      // Use a minimal hardcoded fallback to prevent immediate crashes
      this.layout = [[1]]; // Minimal 1x1 wall
    }
    // --- End Default Layout Loading ---

    // Set dimensions based on the layout obtained (default or minimal)
    this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
    this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;

    // --- State Holders ---
    this.furniture = []; // Holds ServerFurniture instances loaded from DB
    this.avatars = {}; // Map: socketId -> ServerAvatar instance

    // --- Pathfinder ---
    this.pathfinder = new Pathfinder(this); // Uses initial layout

    // Note: Loading from DB (loadStateFromDB) is called externally after constructor
    console.log(
      `[Room ${this.id}] Structure init complete. Dimensions: ${this.cols}x${this.rows}. Ready for DB load.`
    );
  }

  /**
   * Attempts to load a default layout for a given room ID from a JSON file.
   * Falls back to a predefined minimal layout if the file is missing or invalid.
   * @param {string} roomId - The ID of the room (used to find the layout file).
   * @returns {Array<Array<number|string>> | null} The loaded layout array, or a fallback/null on error.
   */
  _getDefaultLayout(roomId) {
    console.log(
      `[Room ${roomId}] Attempting to load default layout from file...`
    );
    const filename = `${roomId}.json`;
    const layoutsDir = path.join(__dirname, "..", "data", "layouts");
    const filePath = path.join(layoutsDir, filename);
    const fallbackPath = path.join(layoutsDir, "_fallback.json"); // Path to generic fallback

    const loadLayoutFromFile = (p) => {
      try {
        if (fs.existsSync(p)) {
          const jsonData = fs.readFileSync(p, "utf8");
          const layoutData = JSON.parse(jsonData);
          // Basic validation: is it a non-empty 2D array?
          if (
            Array.isArray(layoutData) &&
            layoutData.length > 0 &&
            Array.isArray(layoutData[0])
          ) {
            console.log(` -> Loaded layout from ${path.basename(p)}.`);
            return layoutData;
          } else {
            console.warn(
              ` -> Invalid layout data format in ${path.basename(p)}.`
            );
          }
        } else {
          console.log(` -> Layout file not found: ${path.basename(p)}.`);
        }
      } catch (error) {
        console.error(
          ` -> Error loading or parsing layout file ${path.basename(p)}:`,
          error.message
        );
      }
      return null; // Return null if load failed
    };

    // 1. Try specific room file
    let layout = loadLayoutFromFile(filePath);

    // 2. If specific file failed, try the fallback file
    if (!layout) {
      console.warn(
        ` -> Attempting to load fallback layout (_fallback.json)...`
      );
      layout = loadLayoutFromFile(fallbackPath);
    }

    // 3. If fallback also failed, use absolute minimal layout
    if (!layout) {
      console.error(
        ` -> CRITICAL: No valid default layout loaded for room '${roomId}'. Using minimal 1x1 wall.`
      );
      return [[1]]; // Return a minimal valid layout to prevent crashes
    }

    return layout;
  }

  // --- Helper for adding initial furniture to the DB AND memory ---
  // This is typically run only once when a room is first created/loaded empty.
  async _addInitialFurnitureForRoom(roomId) {
    console.log(`[Room ${roomId}] Adding and saving initial furniture...`);
    // Using await ensures items are saved before calculating stack height for next item
    // Make sure definition IDs match those in furniture_definitions.json
    if (roomId === "main_lobby") {
      await this._addInitialFurniture("rug_green", 3, 9);
      const box1 = await this._addInitialFurniture("box_small", 3, 9);
      if (box1) await this._addInitialFurniture("box_small", 3, 9); // Stack on box1
      await this._addInitialFurniture(
        "chair_basic",
        5,
        7,
        0,
        SHARED_CONFIG_REF.DIRECTION_SOUTH
      );
      await this._addInitialFurniture("light_simple", 12, 12);
      await this._addInitialFurniture("door_simple", 13, 2); // Door from lobby to lounge
    } else if (roomId === "lounge") {
      await this._addInitialFurniture("rug_green", 6, 4);
      await this._addInitialFurniture("door_to_lobby", 1, 4); // Door from lounge to lobby
    }
    // Add other rooms' initial furniture here if needed
    console.log(`[Room ${roomId}] Initial furniture placed and saved to DB.`);
  }

  // --- Helper to add AND SAVE a single initial furniture item ---
  async _addInitialFurniture(definitionId, x, y, zOffset = 0, rotation = 0) {
    if (!SHARED_CONFIG_REF?.FURNITURE_DEFINITIONS) {
      console.error(
        `[Room ${this.id}] Cannot add initial furniture: SHARED_CONFIG missing.`
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
      // Calculate Z based on *current* in-memory furniture state
      const baseZ = this.getStackHeightAt(x, y);
      const placeZ = baseZ + (definition.zOffset || 0) + zOffset;

      if (placeZ >= SHARED_CONFIG_REF.MAX_STACK_Z) {
        console.warn(
          `[Room ${this.id}] Skipping initial ${definitionId} at (${x},${y}), exceeds max stack height.`
        );
        return null;
      }

      // --- Save to Database using Furniture model ---
      const newFurniData = {
        roomId: this.id,
        definitionId: definitionId,
        x: x,
        y: y,
        z: placeZ,
        rotation: rotation,
        ownerId: null,
        state: definition.defaultState,
        colorOverride: null,
      };
      const savedDocument = await Furniture.create(newFurniData);
      if (!savedDocument || !savedDocument._id)
        throw new Error("Failed to save initial furniture to DB or get _id.");

      // Create the ServerFurniture instance using the DB _id string
      const newFurniInstance = new ServerFurniture(
        definitionId,
        x,
        y,
        placeZ,
        rotation,
        savedDocument._id.toString(),
        null,
        savedDocument.state,
        null
      );

      this.addFurniture(newFurniInstance); // Add instance to room memory
      console.log(
        ` -> Added initial ${definition.name} (ID: ${
          newFurniInstance.id
        }) at (${x},${y}, Z:${placeZ.toFixed(2)}) to memory.`
      );
      return newFurniInstance; // Return the in-memory instance
    } catch (error) {
      console.error(
        `[Room ${this.id}] Error creating/saving initial furniture ${definitionId}:`,
        error
      );
      return null;
    }
  }

  // --- Persistence (DATABASE) ---

  /** Loads room layout from RoomState DB and furniture items from the Furniture collection. */
  async loadStateFromDB() {
    console.log(`[Room ${this.id}] Attempting to load state from Database...`);
    let roomStateDoc;
    let furnitureDocs = [];

    try {
      // 1. Load Room Layout/Metadata from RoomState collection
      if (!RoomState) throw new Error("RoomState model is not loaded.");
      roomStateDoc = await RoomState.findOne({ roomId: this.id }).lean();

      // 2. Load Furniture Items
      if (!Furniture) throw new Error("Furniture model is not loaded.");
      furnitureDocs = await Furniture.find({ roomId: this.id }).lean();
      console.log(
        `[Room ${this.id}] Found ${furnitureDocs.length} furniture documents in DB.`
      );

      this.furniture = []; // Clear existing in-memory furniture

      // --- Apply Loaded Layout (DB has priority) ---
      let layoutSource = "Unknown";
      // Check if DB layout is valid (non-empty 2D array)
      if (
        roomStateDoc?.layout &&
        Array.isArray(roomStateDoc.layout) &&
        roomStateDoc.layout.length > 0 &&
        Array.isArray(roomStateDoc.layout[0])
      ) {
        this.layout = roomStateDoc.layout;
        layoutSource = "Database";
        console.log(`[Room ${this.id}] Loaded layout from RoomState DB.`);
      } else {
        // Fallback to File/Default if DB layout missing/invalid
        console.warn(
          `[Room ${this.id}] RoomState layout missing/invalid in DB. Attempting file/fallback default...`
        );
        this.layout = this._getDefaultLayout(this.id); // Load from file or get fallback
        layoutSource = "File/Fallback Default";
        if (!this.layout || this.layout.length === 0 || !this.layout[0]) {
          console.error(
            `[Room ${this.id}] CRITICAL: Failed to get any layout (DB or Default)! Using minimal.`
          );
          this.layout = [[1]]; // Absolute fallback
          layoutSource = "Minimal Fallback";
        } else {
          // If DB doc was missing entirely or had invalid layout, create/update it now with the default
          console.log(
            `[Room ${this.id}] Creating/Updating RoomState document with ${layoutSource} layout...`
          );
          try {
            // Use findOneAndUpdate with upsert to handle both creation and update
            await RoomState.findOneAndUpdate(
              { roomId: this.id },
              { $set: { layout: this.layout } }, // Set the layout
              { upsert: true, setDefaultsOnInsert: true } // Create if not exists
            );
            console.log(
              `[Room ${this.id}] Saved/Updated default layout to DB.`
            );
          } catch (createError) {
            console.error(
              `[Room ${this.id}] Failed to save/update default layout to DB:`,
              createError
            );
          }
        }
      }
      // Update dimensions and pathfinder based on the final layout used
      this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
      this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
      this.pathfinder = new Pathfinder(this);
      console.log(
        `[Room ${this.id}] Final layout source: ${layoutSource}. Dimensions: ${this.cols}x${this.rows}.`
      );

      // --- Load Furniture Instances ---
      let loadedCount = 0;
      furnitureDocs.forEach((furniData) => {
        if (!SHARED_CONFIG_REF?.FURNITURE_DEFINITIONS) {
          console.error(
            "[Room DB Load] Cannot load furniture: SHARED_CONFIG_REF missing."
          );
          return;
        }
        const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
          (d) => d.id === furniData.definitionId
        );
        if (definition) {
          try {
            const newFurni = new ServerFurniture(
              furniData.definitionId,
              furniData.x,
              furniData.y,
              furniData.z,
              furniData.rotation,
              furniData._id.toString(),
              furniData.ownerId,
              furniData.state,
              furniData.colorOverride
            );
            this.addFurniture(newFurni);
            loadedCount++;
          } catch (furniCreateError) {
            console.error(
              `[Room ${this.id}] DB Load: Error creating furniture instance for defId ${furniData.definitionId} (DB ID: ${furniData._id}):`,
              furniCreateError
            );
          }
        } else {
          console.warn(
            `[Room ${this.id}] DB Load: Skipping furniture (DB ID: ${furniData._id}): Unknown definition ID '${furniData.definitionId}'.`
          );
        }
      });

      // --- Handle Initial State if No Furniture Loaded ---
      if (loadedCount === 0 && furnitureDocs.length === 0) {
        console.log(
          `[Room ${this.id}] No furniture found in DB. Adding and saving initial default furniture...`
        );
        await this._addInitialFurnitureForRoom(this.id);
        console.log(
          `[Room ${this.id}] Initial default furniture added and saved.`
        );
      }

      // --- Reset Avatars in Room ---
      Object.values(this.avatars).forEach((avatar) => {
        if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
          console.log(
            `[Room ${this.id}] Forcing ${avatar.name} to stand due to room load/reload.`
          );
          avatar.executeStand(this);
        }
        avatar.path = [];
        avatar.actionAfterPath = null;
      });

      console.log(
        `[Room ${this.id}] DB State loaded. ${loadedCount} furniture instances created.`
      );
      return true;
    } catch (err) {
      console.error(
        `[Room ${this.id}] Error loading state from Database:`,
        err
      );
      this.furniture = [];
      console.warn(
        `[Room ${this.id}] Reverting to default layout due to DB load error.`
      );
      this.layout = this._getDefaultLayout(this.id); // Get from file/fallback
      if (!this.layout || this.layout.length === 0 || !this.layout[0])
        this.layout = [[1]]; // Minimal fallback
      this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
      this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
      this.pathfinder = new Pathfinder(this);
      return false; // Load failed
    }
  }

  /**
   * Saves only the room layout/metadata to the RoomState collection.
   * Furniture items are saved/updated/deleted individually via socket handlers.
   */
  async saveStateToDB() {
    console.log(
      `[Room ${this.id}] Attempting to save room layout to Database...`
    );
    try {
      if (!RoomState) throw new Error("RoomState model is not loaded.");
      const roomStateData = { roomId: this.id, layout: this.layout };
      // Use findOneAndUpdate with upsert to create or update the room layout document
      await RoomState.findOneAndUpdate(
        { roomId: this.id },
        { $set: roomStateData }, // Use $set to only update specified fields
        { upsert: true, setDefaultsOnInsert: true }
      );
      console.log(
        `[Room ${this.id}] Layout successfully saved/updated in RoomState collection.`
      );
      return true;
    } catch (err) {
      console.error(
        `[Room ${this.id}] Error saving room layout to Database:`,
        err
      );
      return false;
    }
  }

  // --- Avatar Management ---
  addAvatar(avatar) {
    if (!avatar || !avatar.socketId) {
      console.error(`[Room ${this.id}] Attempted to add invalid avatar.`);
      return;
    }
    if (this.avatars[avatar.socketId]) {
      console.warn(
        `[Room ${this.id}] Avatar ${avatar.name} (${avatar.socketId}) already in room. Overwriting.`
      );
      const oldAvatar = this.avatars[avatar.socketId];
      if (oldAvatar && oldAvatar !== avatar) {
        oldAvatar.clearEmote();
      }
    }
    this.avatars[avatar.socketId] = avatar;
    avatar.roomId = this.id;
    console.log(
      `[Room ${this.id}] Avatar ${avatar.name} (RuntimeID: ${avatar.id}, SocketID: ${avatar.socketId}) entered.`
    );
  }

  removeAvatar(socketId) {
    const avatar = this.avatars[socketId];
    if (avatar) {
      console.log(
        `[Room ${this.id}] Avatar ${avatar.name} (RuntimeID: ${avatar.id}, SocketID: ${socketId}) left.`
      );
      avatar.clearEmote();
      avatar.roomId = null;
      delete this.avatars[socketId];
      return avatar;
    }
    return null;
  }

  getAvatarBySocketId(socketId) {
    return this.avatars[socketId];
  }

  getAvatarByName(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    return Object.values(this.avatars).find(
      (a) =>
        a && typeof a.name === "string" && a.name.toLowerCase() === lowerName
    );
  }

  // --- Furniture Management (In-Memory Operations) ---
  addFurniture(furniInstance) {
    if (!furniInstance || !(furniInstance instanceof ServerFurniture)) {
      console.error(
        `[Room ${this.id}] Attempted add invalid furniture instance.`
      );
      return;
    }
    furniInstance.roomId = this.id;
    if (this.furniture.some((f) => String(f.id) === String(furniInstance.id))) {
      console.warn(
        `[Room ${this.id}] Attempted add duplicate furniture instance ID: ${furniInstance.id}. Skipping.`
      );
      return;
    }
    this.furniture.push(furniInstance);
  }

  removeFurnitureInstance(furniDbId) {
    if (!furniDbId) return null;
    const idString = String(furniDbId);
    const index = this.furniture.findIndex((f) => String(f.id) === idString);
    if (index > -1) return this.furniture.splice(index, 1)[0];
    return null;
  }

  getFurnitureById(dbId) {
    if (!dbId) return undefined;
    const idString = String(dbId);
    return this.furniture.find((f) => String(f.id) === idString);
  }

  isFurnitureOccupied(furniDbId) {
    if (!furniDbId) return false;
    const idString = String(furniDbId);
    return Object.values(this.avatars).some(
      (a) => a && String(a.sittingOnFurniId) === idString
    );
  }

  getFurnitureStackAt(gridX, gridY) {
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    return this.furniture.filter(
      (furni) => Math.round(furni.x) === gx && Math.round(furni.y) === gy
    );
  }

  getStackHeightAt(gridX, gridY, excludeId = null) {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) return 0;
    const stack = this.getFurnitureStackAt(gridX, gridY);
    let highestStackableTopZ = SERVER_CONFIG_REF.FURNI_DEFAULT_Z; // Usually 0.0
    const excludeIdString = excludeId ? String(excludeId) : null;

    stack.forEach((furni) => {
      if (excludeIdString && String(furni.id) === excludeIdString) return;
      const itemStackContrib =
        (furni.stackHeight || 0) * SHARED_CONFIG_REF.DEFAULT_STACK_HEIGHT;
      const itemTopSurfaceZ = furni.z + (furni.isFlat ? 0 : itemStackContrib);
      if (furni.stackable)
        highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
    });
    return highestStackableTopZ;
  }

  isTileOccupiedBySolid(gridX, gridY, excludeId = null) {
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    const excludeIdString = excludeId ? String(excludeId) : null;
    return this.furniture.some((furni) => {
      if (excludeIdString && String(furni.id) === excludeIdString) return false;
      if (furni.isWalkable || furni.isFlat) return false;
      return furni
        .getOccupiedTiles()
        .some((tile) => tile.x === gx && tile.y === gy);
    });
  }

  // --- Validation Helpers ---
  isValidTile(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    if (gridX < 0 || gridX >= this.cols || gridY < 0 || gridY >= this.rows)
      return false;
    const tileType = this.layout[gridY]?.[gridX];
    // Allow 0 (floor) and 2 (alt floor), disallow 1 (wall) and 'X' (hole) or undefined
    return tileType === 0 || tileType === 2;
  }

  isWalkable(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    return (
      this.isValidTile(gridX, gridY) &&
      !this.isTileOccupiedBySolid(gridX, gridY)
    );
  }

  // --- State Serialization & Updates ---
  getStateDTO() {
    return {
      id: this.id,
      layout: this.layout,
      cols: this.cols,
      rows: this.rows,
      furniture: this.furniture.map((f) => f.toDTO()),
      avatars: Object.values(this.avatars).map((a) => a.toDTO()),
    };
  }

  getUserList() {
    return Object.values(this.avatars).map((a) => ({
      id: String(a.id),
      name: a.name,
    }));
  }

  update(deltaTimeMs, ioInstance, changeRoomHandler) {
    const changedAvatars = [];
    if (typeof changeRoomHandler !== "function") {
      console.error(
        `[Room ${this.id}] FATAL: changeRoomHandler was not provided to update method!`
      );
      return { changedAvatars };
    }

    const avatarSocketIds = Object.keys(this.avatars);
    for (const socketId of avatarSocketIds) {
      const avatar = this.avatars[socketId];
      if (!avatar) continue;

      if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_WALKING) {
        if (avatar.updateMovement(deltaTimeMs, this, changeRoomHandler)) {
          // Check if avatar still exists and is in this room after update
          if (
            this.avatars[socketId] &&
            this.avatars[socketId].roomId === this.id
          ) {
            if (!changedAvatars.some((dto) => dto.id === String(avatar.id))) {
              changedAvatars.push(avatar.toDTO());
            }
          } // Else avatar might have changed rooms
        }
      }
      // Add other per-avatar updates here
    }
    return { changedAvatars };
  }

  // --- Room Specific Helpers ---
  findSpawnPoint(preferredX = -1, preferredY = -1) {
    console.log(
      `[Room ${this.id}] Finding spawn point (preferred: ${preferredX},${preferredY})`
    );
    // 1. Try preferred coordinates
    if (
      preferredX >= 0 &&
      preferredY >= 0 &&
      this.isWalkable(preferredX, preferredY)
    ) {
      console.log(` -> Using preferred spawn: (${preferredX}, ${preferredY})`);
      return { x: preferredX, y: preferredY };
    }
    // 2. Try center
    const centerX = Math.floor(this.cols / 2);
    const centerY = Math.floor(this.rows / 2);
    if (this.isWalkable(centerX, centerY)) {
      console.log(` -> Using center spawn: (${centerX}, ${centerY})`);
      return { x: centerX, y: centerY };
    }
    // 3. Search outwards
    console.log(` -> Center unwalkable, searching outwards...`);
    for (let radius = 1; radius < Math.max(this.rows, this.cols); radius++) {
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        if (this.isWalkable(x, centerY - radius))
          return { x: x, y: centerY - radius };
        if (this.isWalkable(x, centerY + radius))
          return { x: x, y: centerY + radius };
      }
      for (let y = centerY - radius + 1; y < centerY + radius; y++) {
        if (this.isWalkable(centerX - radius, y))
          return { x: centerX - radius, y: y };
        if (this.isWalkable(centerX + radius, y))
          return { x: centerX + radius, y: y };
      }
    }
    // 4. Fallback: Scan entire room
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
    // 5. Absolute Fallback
    console.error(
      `[Room ${this.id}] FATAL: No walkable tiles found! Defaulting to (0,0). Check layout.`
    );
    return { x: 0, y: 0 };
  }
} // End ServerRoom Class

if (typeof module !== "undefined" && module.exports) {
  module.exports = ServerRoom;
}
