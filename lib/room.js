"use strict";

// --- Application Modules ---
// Import necessary classes and config
let ServerFurniture, ServerGameObject, ServerAvatar;
let Pathfinder;
let SHARED_CONFIG_REF, SERVER_CONFIG_REF;
let rotateDirectionFunc;
let RoomState; // Database model for room layout/metadata
let Furniture; // Database model for individual furniture items

try {
  // Load Game Objects
  const gameObjects = require("./game_objects");
  ServerFurniture = gameObjects.ServerFurniture;
  ServerGameObject = gameObjects.ServerGameObject;
  ServerAvatar = gameObjects.ServerAvatar;

  // Load Pathfinder
  Pathfinder = require("./pathfinder");

  // Load Config
  const configModule = require("./config");
  SHARED_CONFIG_REF = configModule.SHARED_CONFIG;
  SERVER_CONFIG_REF = configModule.SERVER_CONFIG;

  // Load Utils
  rotateDirectionFunc = require("./utils").rotateDirection;

  // --- Load the database models ---
  RoomState = require("../models/roomState"); // For layout/metadata
  Furniture = require("../models/furniture"); // For individual furniture items
  if (!RoomState || !Furniture) {
    throw new Error("RoomState or Furniture model failed to load.");
  }
} catch (e) {
  console.error("FATAL Error loading dependencies in room.js:", e);
  // Cannot proceed without dependencies
  throw new Error("Room dependencies failed to load.");
}

/**
 * Manages the state of a single game room on the server.
 * Layout is loaded/saved from the RoomState collection.
 * Furniture items are loaded from the Furniture collection and managed in memory.
 * Furniture persistence (create/update/delete) is handled by socket handlers.
 */
class ServerRoom {
  /**
   * Creates an instance of ServerRoom. Initializes structure, async loading happens later.
   * @param {string} id - The unique identifier for this room.
   */
  constructor(id = "default_room") {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) {
      throw new Error("Configuration not loaded before creating ServerRoom.");
    }
    if (!id || typeof id !== "string" || id.trim().length === 0) {
      throw new Error("Room ID cannot be empty or null.");
    }

    this.id = id.trim(); // Store the room ID, trimmed
    console.log(`[Room ${this.id}] Initializing structure...`);

    // Load default layout initially. loadStateFromDB will override this if DB state exists.
    this.layout = this._getDefaultLayout(id);
    this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
    this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;

    // --- State Holders ---
    // furniture holds ServerFurniture instances loaded from DB
    this.furniture = [];
    // avatars holds ServerAvatar instances (runtime IDs) currently in this room
    // Map: socketId -> ServerAvatar instance (key is socketId for easier removal)
    this.avatars = {};

    // --- Pathfinder ---
    // Initialized with default layout, potentially updated after DB load
    this.pathfinder = new Pathfinder(this);

    // Note: Loading from DB (loadStateFromDB) is called externally after constructor
    console.log(
      `[Room ${this.id}] Structure initialization complete. Dimensions: ${this.cols}x${this.rows}. Ready for DB load.`
    );
  }

  // --- Helper for default layout based on ID ---
  _getDefaultLayout(roomId) {
    console.log(`[Room ${roomId}] Getting default layout.`);
    // Lounge Layout
    if (roomId === "lounge") {
      return [
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 0, 2, 0, 1, 1, 0, 2, 0, 1],
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [1, 0, 0, 1, 0, 0, 1, 1, 0, 1], // Changed [4,2] ('X') to 0 to be potentially walkable if needed, placed door at [1,4]
        [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      ];
    }
    // Default layout (e.g., 'main_lobby')
    return [
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], // Door simple at 13, 2
      [1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1], // Changed D to 0
      [1, 0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1],
      [1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1], // Changed X to 0
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

  // --- Helper for adding initial furniture to the DB AND memory ---
  // This is typically run only once when a room is first created/loaded empty.
  async _addInitialFurnitureForRoom(roomId) {
    // Marked as async
    console.log(`[Room ${roomId}] Adding and saving initial furniture...`);
    // Using await ensures items are saved before calculating stack height for next item
    if (roomId === "main_lobby") {
      await this._addInitialFurniture("rug_green", 3, 9);
      const box1 = await this._addInitialFurniture("box_small", 3, 9); // Saves box1
      if (box1) await this._addInitialFurniture("box_small", 3, 9); // Saves box2 stacked on box1
      await this._addInitialFurniture(
        "chair_basic",
        5,
        7,
        0,
        SHARED_CONFIG_REF.DIRECTION_SOUTH
      );
      await this._addInitialFurniture("light_simple", 12, 12);
      await this._addInitialFurniture("door_simple", 13, 2); // Door from lobby to lounge (placed at 13,2)
    } else if (roomId === "lounge") {
      await this._addInitialFurniture("rug_green", 6, 4);
      await this._addInitialFurniture("door_to_lobby", 1, 4); // Door from lounge to lobby (placed at 1,4)
    }
    // Add other rooms' initial furniture here
    console.log(`[Room ${roomId}] Initial furniture placed and saved to DB.`);
  }

  // --- Helper to add AND SAVE a single initial furniture item ---
  async _addInitialFurniture(definitionId, x, y, zOffset = 0, rotation = 0) {
    // Marked as async
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
      // Calculate Z based on *current* in-memory furniture state
      const baseZ = this.getStackHeightAt(x, y);
      const placeZ = baseZ + (definition.zOffset || 0) + zOffset;

      if (placeZ >= SHARED_CONFIG_REF.MAX_STACK_Z) {
        console.warn(
          `[Room ${this.id}] Skipping initial ${definitionId} at (${x},${y}), exceeds max stack height (${placeZ} >= ${SHARED_CONFIG_REF.MAX_STACK_Z}).`
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
        ownerId: null, // Initial items have no owner
        state: definition.defaultState, // Use default state from definition
        colorOverride: null, // No initial color override
      };
      const savedDocument = await Furniture.create(newFurniData);
      // --- End Save to Database ---

      if (!savedDocument || !savedDocument._id) {
        throw new Error("Failed to save initial furniture to DB or get _id.");
      }

      // Create the ServerFurniture instance using the DB _id string
      const newFurniInstance = new ServerFurniture(
        definitionId,
        x,
        y,
        placeZ,
        rotation,
        savedDocument._id.toString(), // Pass the DB ID string
        null, // ownerId
        savedDocument.state, // Use state from saved doc (which was default)
        null // colorOverride
      );

      // Add the instance to the room's in-memory list
      this.addFurniture(newFurniInstance); // Use the addFurniture method
      console.log(
        ` -> Added initial ${definition.name} (ID: ${
          newFurniInstance.id
        }) at (${x},${y}, Z:${placeZ.toFixed(2)}) to memory.`
      );
      return newFurniInstance; // Return the in-memory instance
    } catch (error) {
      console.error(
        `[Room ${this.id}] Error creating or saving initial furniture ${definitionId}:`,
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

      // 2. Load Furniture Items for this room from Furniture collection
      if (!Furniture) throw new Error("Furniture model is not loaded.");
      // Ensure Furniture model is correctly imported and available
      furnitureDocs = await Furniture.find({ roomId: this.id }).lean();
      console.log(
        `[Room ${this.id}] Found ${furnitureDocs.length} furniture documents in DB.`
      );

      // --- Prepare for Load ---
      this.furniture = []; // Clear existing in-memory furniture

      // --- Apply Loaded Layout (or default) ---
      if (
        roomStateDoc &&
        roomStateDoc.layout &&
        Array.isArray(roomStateDoc.layout)
      ) {
        this.layout = roomStateDoc.layout;
        console.log(`[Room ${this.id}] Loaded layout from RoomState DB.`);
      } else {
        console.warn(
          `[Room ${this.id}] RoomState layout missing/invalid in DB. Using default layout.`
        );
        this.layout = this._getDefaultLayout(this.id);
        // If RoomState doc was missing, create/save it now with the default layout
        if (!roomStateDoc) {
          console.log(
            `[Room ${this.id}] Creating RoomState document with default layout...`
          );
          try {
            await RoomState.create({ roomId: this.id, layout: this.layout });
            console.log(`[Room ${this.id}] Saved default layout to DB.`);
          } catch (createError) {
            console.error(
              `[Room ${this.id}] Failed to save default layout to DB:`,
              createError
            );
            // Continue with default layout in memory, but log failure
          }
        }
      }
      // Update dimensions and pathfinder based on the final layout (loaded or default)
      this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
      this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
      this.pathfinder = new Pathfinder(this); // Recreate pathfinder with potentially new layout

      // --- Load Furniture Instances from DB docs ---
      let loadedCount = 0;
      furnitureDocs.forEach((furniData) => {
        if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) {
          console.error(
            "[Room DB Load] Cannot load furniture: SHARED_CONFIG_REF not available."
          );
          return; // Skip item if config missing
        }
        const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
          (d) => d.id === furniData.definitionId
        );
        if (definition) {
          try {
            // Create furniture instance using data from DB document
            const newFurni = new ServerFurniture(
              furniData.definitionId,
              furniData.x,
              furniData.y,
              furniData.z,
              furniData.rotation,
              furniData._id.toString(), // <= Pass the MongoDB _id string
              furniData.ownerId, // Pass ownerId (User ObjectId string or null)
              furniData.state, // Pass state from DB
              furniData.colorOverride // Pass color override from DB
            );
            // Add instance to the room's in-memory list
            this.addFurniture(newFurni); // Uses the method below
            loadedCount++;
          } catch (furniCreateError) {
            console.error(
              `[Room ${this.id}] DB Load: Error creating furniture instance for defId ${furniData.definitionId} (DB ID: ${furniData._id}):`,
              furniCreateError
            );
          }
        } else {
          console.warn(
            `[Room ${this.id}] DB Load: Skipping loaded furniture (DB ID: ${furniData._id}): Unknown definition ID '${furniData.definitionId}'.`
          );
        }
      });

      // --- Handle Initial State if No Furniture Loaded ---
      // Check if DB query returned 0 docs AND we didn't load any (e.g., due to missing defs)
      if (loadedCount === 0 && furnitureDocs.length === 0) {
        console.log(
          `[Room ${this.id}] No furniture found in DB. Adding and saving initial default furniture...`
        );
        // This function now saves items to DB as it adds them to memory
        await this._addInitialFurnitureForRoom(this.id);
        console.log(
          `[Room ${this.id}] Initial default furniture added and saved.`
        );
        // Note: No explicit return value needed here, just indicates initial setup happened
      }

      // --- Reset Avatars in Room (Force stand, clear path) ---
      // Should run AFTER furniture is loaded so adjacent tiles for standing can be checked correctly
      Object.values(this.avatars).forEach((avatar) => {
        if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
          console.log(
            `[Room ${this.id}] Forcing ${avatar.name} to stand due to room load/reload.`
          );
          // executeStand finds a walkable spot based on CURRENT room state
          avatar.executeStand(this);
          // Client will get the updated state via the full room_state emission later
        }
        avatar.path = [];
        avatar.actionAfterPath = null;
      });

      console.log(
        `[Room ${this.id}] DB State loaded. ${loadedCount} furniture instances created and added to memory.`
      );
      return true; // Indicate successful load (even if initial defaults were used)
    } catch (err) {
      console.error(
        `[Room ${this.id}] Error loading state from Database:`,
        err
      );
      this.furniture = []; // Clear in-memory state on error
      this.layout = this._getDefaultLayout(this.id); // Revert to default layout
      this.cols = this.layout[0]?.length || SERVER_CONFIG_REF.DEFAULT_ROOM_COLS;
      this.rows = this.layout.length || SERVER_CONFIG_REF.DEFAULT_ROOM_ROWS;
      this.pathfinder = new Pathfinder(this); // Reset pathfinder
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

      // Data only includes layout and roomId for the RoomState document
      const roomStateData = {
        roomId: this.id,
        layout: this.layout,
        // NO furniture array here
      };

      // Use findOneAndUpdate with upsert to create or update the room layout document
      await RoomState.findOneAndUpdate(
        { roomId: this.id }, // Find condition
        roomStateData, // Data to set/update (just layout)
        {
          upsert: true, // Create if document doesn't exist
          new: false, // Don't need the updated doc returned
          setDefaultsOnInsert: true, // Apply schema defaults if inserting
        }
      );

      console.log(
        `[Room ${this.id}] Layout successfully saved to RoomState collection.`
      );
      // --- Furniture saving is NOT done here anymore ---
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
  // Methods remain unchanged, operate on in-memory this.avatars map
  /**
   * Adds an avatar instance to the room's in-memory map.
   * @param {ServerAvatar} avatar The avatar instance to add.
   */
  addAvatar(avatar) {
    if (!avatar || !avatar.socketId) {
      console.error(
        `[Room ${this.id}] Attempted to add invalid avatar object.`
      );
      return;
    }
    if (this.avatars[avatar.socketId]) {
      console.warn(
        `[Room ${this.id}] Avatar ${avatar.name} (${avatar.socketId}) already in this room. Overwriting existing entry.`
      );
      const oldAvatar = this.avatars[avatar.socketId];
      if (oldAvatar && oldAvatar !== avatar) {
        oldAvatar.clearEmote(); // Clear timer if overwriting different avatar instance
      }
    }
    this.avatars[avatar.socketId] = avatar;
    avatar.roomId = this.id; // Ensure avatar knows its room

    // FIX: Remove the direct dependency on the global 'clients' map.
    // The UserID is already logged earlier in the connection handler (server_socket_handlers.js).
    // Log using available info (SocketID is on the avatar instance).
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
      avatar.clearEmote(); // Stop any server-side emote timer
      avatar.roomId = null; // Clear room association
      delete this.avatars[socketId];
      return avatar; // Return the removed avatar object
    }
    // console.warn(`[Room ${this.id}] Attempted to remove non-existent avatar with socketId ${socketId}.`); // Can be noisy
    return null; // Avatar not found
  }

  getAvatarBySocketId(socketId) {
    return this.avatars[socketId];
  }

  getAvatarByName(name) {
    if (!name) return null;
    const lowerName = name.toLowerCase();
    // Find avatar within this room's current avatars
    return Object.values(this.avatars).find(
      (a) =>
        a && typeof a.name === "string" && a.name.toLowerCase() === lowerName
    );
  }

  // --- Furniture Management (In-Memory Operations) ---

  /**
   * Adds a pre-existing ServerFurniture INSTANCE to the room's IN-MEMORY list.
   * Assumes the instance was already created (e.g., after loading from DB or placing).
   * @param {ServerFurniture} furniInstance - The furniture instance to add.
   */
  addFurniture(furniInstance) {
    if (!furniInstance || !(furniInstance instanceof ServerFurniture)) {
      console.error(
        `[Room ${this.id}] Attempted to add invalid furniture instance.`
      );
      return;
    }
    // Ensure the instance knows its room ID
    furniInstance.roomId = this.id;
    // Prevent adding duplicates to the in-memory list
    if (this.furniture.some((f) => String(f.id) === String(furniInstance.id))) {
      console.warn(
        `[Room ${this.id}] Attempted to add duplicate furniture instance ID: ${furniInstance.id}. Skipping.`
      );
      return;
    }
    this.furniture.push(furniInstance);
    // No console log here usually, loaded/placed logs are sufficient
  }

  /**
   * Removes a furniture INSTANCE from the room's IN-MEMORY list.
   * DB deletion is handled separately by socket handlers.
   * @param {string} furniDbId - The MongoDB _id string of the furniture to remove from memory.
   * @returns {ServerFurniture | null} The removed instance, or null if not found.
   */
  removeFurnitureInstance(furniDbId) {
    if (!furniDbId) return null;
    const idString = String(furniDbId); // Ensure string comparison
    const index = this.furniture.findIndex((f) => String(f.id) === idString);
    if (index > -1) {
      const removed = this.furniture.splice(index, 1)[0];
      // console.log(`[Room ${this.id}] Removed furniture instance ${idString} from memory.`); // Can be noisy
      return removed;
    }
    // console.warn(`[Room ${this.id}] Could not find furniture instance ${idString} in memory to remove.`); // Can be noisy
    return null;
  }

  /**
   * Gets a furniture instance from the IN-MEMORY list by its persistent DB ID (_id string).
   * @param {string} dbId - The MongoDB _id string.
   * @returns {ServerFurniture | undefined} The found instance or undefined.
   */
  getFurnitureById(dbId) {
    if (!dbId) return undefined;
    const idString = String(dbId); // Ensure string comparison
    return this.furniture.find((f) => String(f.id) === idString);
  }

  /**
   * Checks if anyone IN THIS ROOM (in-memory avatars) is sitting on the specified furniture.
   * @param {string} furniDbId - The MongoDB _id string of the furniture.
   * @returns {boolean} True if occupied, false otherwise.
   */
  isFurnitureOccupied(furniDbId) {
    if (!furniDbId) return false;
    const idString = String(furniDbId); // Ensure string comparison
    // Check sittingOnFurniId (which should be the DB ID string) for avatars in this room
    return Object.values(this.avatars).some(
      (a) => a && String(a.sittingOnFurniId) === idString
    );
  }

  /**
   * Gets all IN-MEMORY furniture instances at a specific grid coordinate.
   * @param {number} gridX - Target X coordinate.
   * @param {number} gridY - Target Y coordinate.
   * @returns {ServerFurniture[]} Array of furniture instances at the coordinate.
   */
  getFurnitureStackAt(gridX, gridY) {
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    // Filter the in-memory list
    return this.furniture.filter(
      (furni) => Math.round(furni.x) === gx && Math.round(furni.y) === gy
    );
  }

  /**
   * Calculates stack height based on IN-MEMORY furniture instances.
   * @param {number} gridX - Target X coordinate.
   * @param {number} gridY - Target Y coordinate.
   * @param {string | null} [excludeId=null] - DB ID string of furniture to exclude from calculation.
   * @returns {number} The calculated height of the stackable surface.
   */
  getStackHeightAt(gridX, gridY, excludeId = null) {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) return 0;
    const stack = this.getFurnitureStackAt(gridX, gridY); // Uses in-memory list
    let highestStackableTopZ = SERVER_CONFIG_REF.FURNI_DEFAULT_Z; // Usually 0.0
    const excludeIdString = excludeId ? String(excludeId) : null;

    stack.forEach((furni) => {
      // Compare persistent DB IDs as strings
      if (excludeIdString && String(furni.id) === excludeIdString) return;

      // Calculate Z contribution based on item's definition
      const itemStackContribution =
        (furni.stackHeight || 0) * SHARED_CONFIG_REF.DEFAULT_STACK_HEIGHT;
      const itemTopSurfaceZ =
        furni.z + (furni.isFlat ? 0 : itemStackContribution);

      if (furni.stackable) {
        highestStackableTopZ = Math.max(highestStackableTopZ, itemTopSurfaceZ);
      }
    });
    return highestStackableTopZ;
  }

  /**
   * Checks if a tile is occupied by solid (non-walkable, non-flat) furniture
   * based on the IN-MEMORY furniture list.
   * @param {number} gridX - Target X coordinate.
   * @param {number} gridY - Target Y coordinate.
   * @param {string | null} [excludeId=null] - DB ID string of furniture to exclude.
   * @returns {boolean} True if occupied by a solid item, false otherwise.
   */
  isTileOccupiedBySolid(gridX, gridY, excludeId = null) {
    const gx = Math.round(gridX);
    const gy = Math.round(gridY);
    const excludeIdString = excludeId ? String(excludeId) : null;

    // Check against the in-memory furniture list
    return this.furniture.some((furni) => {
      // Compare persistent DB IDs as strings
      if (excludeIdString && String(furni.id) === excludeIdString) return false;

      // Check if the furniture is solid
      if (furni.isWalkable || furni.isFlat) return false;

      // Check if any tile occupied by this solid furniture matches the target tile
      return furni
        .getOccupiedTiles()
        .some((tile) => tile.x === gx && tile.y === gy);
    });
  }

  // --- Validation Helpers ---
  // These operate on the loaded layout and call isTileOccupiedBySolid (which uses in-memory furniture)
  isValidTile(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    // Check bounds
    if (gridX < 0 || gridX >= this.cols || gridY < 0 || gridY >= this.rows) {
      return false;
    }
    // Check layout type (wall, hole)
    const tileType = this.layout[gridY]?.[gridX];
    // Allow placement on 0 (floor) and 2 (alt floor), disallow 1 (wall) and 'X' (hole)
    return tileType === 0 || tileType === 2;
  }

  isWalkable(x, y) {
    const gridX = Math.round(x);
    const gridY = Math.round(y);
    // Check if the tile itself is valid terrain AND not blocked by solid furniture (in memory)
    return (
      this.isValidTile(gridX, gridY) && // Already checks layout for 0 or 2
      !this.isTileOccupiedBySolid(gridX, gridY)
    );
  }

  // --- State Serialization & Updates ---
  // These operate on the current in-memory state of avatars and furniture

  /** Generates a DTO representing the current state of the room for clients. */
  getStateDTO() {
    return {
      id: this.id,
      layout: this.layout,
      cols: this.cols,
      rows: this.rows,
      // Map in-memory furniture instances to DTOs
      furniture: this.furniture.map((f) => f.toDTO()),
      // Map in-memory avatar instances to DTOs
      avatars: Object.values(this.avatars).map((a) => a.toDTO()),
    };
  }

  /** Returns a list of users currently in the room (in memory). */
  getUserList() {
    // Map avatar instances to basic info, ensuring ID is string
    return Object.values(this.avatars).map((a) => ({
      // Use runtime avatar ID here, client side might map to UserID if needed
      id: String(a.id),
      name: a.name,
    }));
  }

  /**
   * Updates the state of the room and its objects (e.g., avatar movement).
   * Called by the main server game loop.
   * @param {number} deltaTimeMs - Time elapsed since last update.
   * @param {import('socket.io').Server} ioInstance - Socket.IO server instance for broadcasting.
   * @param {Function} changeRoomHandler - Callback for handling room changes triggered by avatars.
   * @returns {{changedAvatars: object[]}} - DTOs of avatars whose state changed.
   */
  update(deltaTimeMs, ioInstance, changeRoomHandler) {
    const changedAvatars = [];
    if (!changeRoomHandler) {
      console.error(
        `[Room ${this.id}] FATAL: changeRoomHandler was not provided to update method!`
      );
      return { changedAvatars }; // Avoid errors if handler missing
    }

    // Iterate safely over avatar keys
    const avatarSocketIds = Object.keys(this.avatars);
    for (const socketId of avatarSocketIds) {
      const avatar = this.avatars[socketId];
      if (!avatar) continue; // Avatar might have disconnected

      // Update avatar movement if walking
      if (avatar.state === SHARED_CONFIG_REF.AVATAR_STATE_WALKING) {
        // updateMovement handles path following, state changes, and calls changeRoomHandler if needed
        if (avatar.updateMovement(deltaTimeMs, this, changeRoomHandler)) {
          // Check if avatar still exists and is in this room after update
          if (
            this.avatars[socketId] &&
            this.avatars[socketId].roomId === this.id
          ) {
            // Add to changed list only if not already added this tick
            if (!changedAvatars.some((dto) => dto.id === String(avatar.id))) {
              changedAvatars.push(avatar.toDTO());
            }
          }
          // If updateMovement returned true due to room change, the avatar might no longer be in this.avatars
        }
      }
      // Add other per-avatar updates here (e.g., passive effects, timers)
    }
    // Return DTOs of avatars that changed state/position
    return { changedAvatars };
  }

  // --- Room Specific Helpers ---

  /** Finds a suitable spawn point in the room, preferring specific coords if provided and walkable. */
  findSpawnPoint(preferredX = -1, preferredY = -1) {
    console.log(
      `[Room ${this.id}] Finding spawn point (preferred: ${preferredX},${preferredY})`
    );
    // 1. Try preferred coordinates if valid and walkable (uses in-memory state check)
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

    // 3. Search outwards from the center
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

    // 5. Absolute Fallback: No walkable tiles (Error)
    console.error(
      `[Room ${this.id}] FATAL: No walkable tiles found! Defaulting to (0,0). Check layout.`
    );
    return { x: 0, y: 0 };
  }
} // End ServerRoom Class

// Node.js export
if (typeof module !== "undefined" && module.exports) {
  module.exports = ServerRoom;
}
