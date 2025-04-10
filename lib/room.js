"use strict";

// --- Core Node Modules ---
const fs = require("fs");
const path = require("path");

// --- Application Modules ---
// FIX 1: Declare ServerNPC variable here
let ServerFurniture, ServerGameObject, ServerAvatar, ServerNPC;
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
  // FIX 2: Add assignment for ServerNPC here
  ServerNPC = gameObjects.ServerNPC;

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
  // --- Add check to ensure ServerNPC loaded ---
  if (!ServerNPC) {
    throw new Error("ServerNPC failed to load from game_objects.");
  }
  // --- End check ---
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
    this.avatars = {}; // Map: socketId (players) or npcId (NPCs) -> ServerAvatar/ServerNPC instance

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
        // IMPORTANT: Ensure 'avatar' here is a ServerAvatar or ServerNPC instance
        if (avatar instanceof ServerAvatar) {
          // Check it's an avatar type that can sit/move
          if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
            console.log(
              `[Room ${this.id}] Forcing ${avatar.name} to stand due to room load/reload.`
            );
            avatar.executeStand(this); // Call stand method
          }
          avatar.path = []; // Clear path/actions
          avatar.actionAfterPath = null;
        }
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

  // --- Avatar/NPC Management ---

  /**
   * Adds a ServerAvatar or ServerNPC instance to the room's state.
   * Uses socketId as key for players, instance ID for NPCs.
   * @param {ServerAvatar|ServerNPC} instance - The avatar or NPC instance to add.
   */
  addAvatar(instance) {
    if (!instance || !(instance instanceof ServerGameObject)) {
      // More generic check
      console.error(`[Room ${this.id}] Attempted to add invalid object.`);
      return;
    }

    const instanceId = String(instance.id);
    const instanceType = instance instanceof ServerNPC ? "NPC" : "Avatar";
    let lookupKey;

    // Determine the key for the this.avatars map
    if (
      instance instanceof ServerAvatar &&
      instance.socketId &&
      !instance.isNPC
    ) {
      lookupKey = instance.socketId; // Use socketId for players
    } else if (instance instanceof ServerNPC) {
      lookupKey = instanceId; // Use NPC's runtime ID for NPCs
    } else {
      console.error(
        `[Room ${this.id}] Cannot determine lookup key for instance:`,
        instance
      );
      return;
    }

    if (this.avatars[lookupKey]) {
      console.warn(
        `[Room ${this.id}] ${instanceType} with key ${lookupKey} already in room map. Overwriting.`
      );
      const oldInstance = this.avatars[lookupKey];
      if (
        oldInstance &&
        oldInstance !== instance &&
        typeof oldInstance.clearEmote === "function"
      ) {
        oldInstance.clearEmote(); // Clear any active emote timer
      }
    }

    this.avatars[lookupKey] = instance; // Store instance in map
    instance.roomId = this.id; // Ensure room ID is set on the instance

    console.log(
      `[Room ${this.id}] ${instanceType} ${instance.name} (ID: ${instanceId}, MapKey: ${lookupKey}) entered/added.`
    );
  }

  /**
   * Removes an avatar or NPC from the room's state.
   * @param {string} idToRemove - The lookup key (socketId for players, instance ID for NPCs).
   * @returns {ServerAvatar|ServerNPC|null} The removed instance, or null if not found.
   */
  removeAvatar(idToRemove) {
    const keyToRemove = String(idToRemove); // Ensure it's a string
    const instance = this.avatars[keyToRemove];

    if (instance) {
      const instanceType = instance instanceof ServerNPC ? "NPC" : "Avatar";
      console.log(
        `[Room ${this.id}] ${instanceType} ${instance.name} (ID: ${instance.id}, MapKey: ${keyToRemove}) left/removed.`
      );

      // Perform cleanup on the instance
      if (typeof instance.clearEmote === "function") {
        instance.clearEmote(); // Clear server-side timers if applicable
      }
      instance.roomId = null; // Clear room reference

      delete this.avatars[keyToRemove]; // Remove from the map
      return instance; // Return the removed instance
    } else {
      // Optional: Add more specific logging if needed
      // console.warn(`[Room ${this.id}] Could not find instance with key ${keyToRemove} to remove.`);
      return null;
    }
  }

  /** Gets a player avatar instance by their socket ID. */
  getAvatarBySocketId(socketId) {
    const instance = this.avatars[socketId];
    // Ensure it's a player avatar, not an NPC that might coincidentally have an ID matching a socketId
    if (instance instanceof ServerAvatar && !instance.isNPC) {
      return instance;
    }
    return null;
  }

  /** Gets an avatar or NPC instance by their runtime ID. */
  getAvatarOrNPCById(runtimeId) {
    const idString = String(runtimeId);
    // Check players (keyed by socketId, need to iterate)
    for (const key in this.avatars) {
      const instance = this.avatars[key];
      if (instance && String(instance.id) === idString) {
        return instance;
      }
    }
    // Check NPCs (keyed by their runtimeId) - this might be redundant if already checked above
    // const npcInstance = this.avatars[idString];
    // if (npcInstance instanceof ServerNPC) {
    //    return npcInstance;
    //}
    return null;
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
    // Check if any *player avatar* is sitting on it
    return Object.values(this.avatars).some(
      (a) =>
        a instanceof ServerAvatar &&
        !a.isNPC &&
        String(a.sittingOnFurniId) === idString
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

    // Check solid furniture
    const solidFurni = this.furniture.some((furni) => {
      if (excludeIdString && String(furni.id) === excludeIdString) return false;
      if (furni.isWalkable || furni.isFlat) return false; // Not solid if walkable or flat
      return furni
        .getOccupiedTiles()
        .some((tile) => tile.x === gx && tile.y === gy);
    });
    if (solidFurni) return true;

    // Check solid NPCs (optional - decide if NPCs block movement)
    // Iterate through the values, check type, and position
    const solidNPC = Object.values(this.avatars).some((obj) => {
      if (!(obj instanceof ServerNPC)) return false; // Only check NPCs
      if (excludeIdString && String(obj.id) === excludeIdString) return false;
      // Simple check: does NPC occupy the target tile?
      return Math.round(obj.x) === gx && Math.round(obj.y) === gy;
      // More complex: check NPC width/height if they occupy multiple tiles? For now, treat as 1x1.
    });
    if (solidNPC) return true; // NPCs block pathfinding if this check is active

    return false; // Not blocked by solid furniture or NPCs
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
    const playerAvatarsDTO = [];
    const npcsDTO = [];

    // Separate players and NPCs for the DTO
    Object.values(this.avatars).forEach((instance) => {
      if (instance instanceof ServerNPC) {
        npcsDTO.push(instance.toDTO());
      } else if (instance instanceof ServerAvatar && instance.socketId) {
        // Check for socketId to confirm player
        playerAvatarsDTO.push(instance.toDTO());
      } else {
        // Log unexpected objects in the map if any
        // console.warn(`[getStateDTO] Found unexpected object type in avatars map: ID ${instance?.id}`);
      }
    });

    return {
      id: this.id,
      layout: this.layout,
      cols: this.cols,
      rows: this.rows,
      furniture: this.furniture.map((f) => f.toDTO()),
      avatars: playerAvatarsDTO, // Only player avatars here
      npcs: npcsDTO, // Add NPCs separately
    };
  }

  getUserList() {
    // Filters the avatars map to return only player avatar info
    return Object.values(this.avatars)
      .filter((a) => a instanceof ServerAvatar && !a.isNPC && a.socketId) // Filter for player avatars with socketId
      .map((a) => ({ id: String(a.id), name: a.name }));
  }

  /**
   * Updates the state of player avatars within the room (e.g., movement).
   * NPC updates are handled separately in the main server loop via npc.updateAI().
   * @param {number} deltaTimeMs - Time elapsed since last update.
   * @param {import('socket.io').Server} ioInstance - Socket.IO server instance for broadcasting.
   * @param {Function} changeRoomHandler - Callback function to handle room changes.
   * @returns {{changedAvatars: Array<object>}} - DTOs of player avatars whose state changed.
   */
  update(deltaTimeMs, ioInstance, changeRoomHandler, clientsMap) {
    const changedAvatars = []; // Keep track of player avatars that changed
    if (typeof changeRoomHandler !== "function") {
      console.error(
        `[Room ${this.id}] FATAL: changeRoomHandler was not provided to update method!`
      );
      return { changedAvatars };
    }

    // Use global clients map if available, otherwise handle error
    const clientsRef = clientsMap;
    if (!clientsRef) {
      console.error(
        `[Room ${this.id}] FATAL: Global 'clients' map not available in update method!`
      );
      return { changedAvatars };
    }

    // Iterate through the VALUES of the avatars map
    for (const instance of Object.values(this.avatars)) {
      if (!instance) continue;

      // --- Process ONLY player avatars here ---
      // Check if it's a ServerAvatar instance AND not marked as an NPC
      if (instance instanceof ServerAvatar && !instance.isNPC) {
        const avatar = instance; // Rename for clarity within this block

        // Only call updateMovement if the player is walking
        if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_WALKING) {
          // Call updateMovement on the ServerAvatar instance
          if (avatar.updateMovement(deltaTimeMs, this, changeRoomHandler)) {
            // Check if avatar still exists and is in this room AFTER updateMovement
            if (
              clientsRef[avatar.socketId] && // Check if client connection still exists
              this.avatars[avatar.socketId] && // Check if avatar still in *this* room's map (keyed by socketId for players)
              this.avatars[avatar.socketId].roomId === this.id
            ) {
              // Add DTO to list if not already added
              if (!changedAvatars.some((dto) => dto.id === String(avatar.id))) {
                changedAvatars.push(avatar.toDTO());
              }
            } // Else avatar changed rooms or disconnected during update
          }
        }
        // Add other per-player-avatar updates here if needed later
      }
      // --- NPCs are handled in the main server loop via updateAI ---
    }
    // Return only the list of *changed player avatars* for broadcasting
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
