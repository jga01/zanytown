"use strict";

// Note: config might be loaded differently depending on environment
// Assuming it's required correctly in the context where these classes are used.
let SHARED_CONFIG_REF; // Use a reference that gets populated later
let SERVER_CONFIG_REF;
if (typeof require !== "undefined") {
  try {
    const configModule = require("./config");
    SHARED_CONFIG_REF = configModule.SHARED_CONFIG;
    SERVER_CONFIG_REF = configModule.SERVER_CONFIG;
  } catch (e) {
    console.error("Could not load config in game_objects.js via require:", e);
    SHARED_CONFIG_REF = global.SHARED_CONFIG || {}; // Example fallback
    SERVER_CONFIG_REF = global.SERVER_CONFIG || {}; // Example fallback
  }
} else {
  // Assume loaded globally in browser context
  SHARED_CONFIG_REF = global.SHARED_CONFIG || {};
  SERVER_CONFIG_REF = global.SERVER_CONFIG || {};
}

// Utility function from utils.js (assuming utils.js is available)
let rotateDirectionFunc = (dir, amount) => (dir + amount + 8) % 8; // Default inline implementation
if (typeof require !== "undefined") {
  try {
    rotateDirectionFunc = require("./utils").rotateDirection;
  } catch (e) {
    console.warn("Could not load rotateDirection from utils.js");
  }
}

// --- Base class for server-side game objects ---
class ServerGameObject {
  // --- NEW: Simple static counter for RUNTIME IDs (resets on server restart) ---
  // Primarily used for objects that don't need DB persistence, like Avatars.
  static _runtimeIdCounter = 0;

  /**
   * Creates a new ServerGameObject.
   * @param {number} x - Initial X coordinate.
   * @param {number} y - Initial Y coordinate.
   * @param {number} [z=0] - Initial Z coordinate.
   * @param {string | number | null} [persistentId=null] - A persistent identifier (e.g., MongoDB _id string). If null, a runtime ID is generated.
   */
  constructor(x, y, z = 0, persistentId = null) {
    // If a persistentId is provided, use it.
    // Otherwise, generate a new RUNTIME ID using the simple counter.
    this.id = persistentId ?? ServerGameObject._runtimeIdCounter++;
    this.x = x; // Authoritative position X
    this.y = y; // Authoritative position Y
    this.z = z; // Authoritative position Z
    // No longer managing global persistent nextId here
  }

  /**
   * Basic Data Transfer Object for sending minimal state to clients.
   * Ensures ID is sent as a string.
   */
  toDTO() {
    return {
      id: String(this.id), // Always send ID as string
      x: this.x,
      y: this.y,
      z: this.z,
    };
  }
}

// --- Represents furniture items on the server (uses persistent DB ID) ---
class ServerFurniture extends ServerGameObject {
  /**
   * Creates a new ServerFurniture instance.
   * @param {string} definitionId - The ID from FURNITURE_DEFINITIONS.
   * @param {number} x - X coordinate.
   * @param {number} y - Y coordinate.
   * @param {number} z - Z coordinate.
   * @param {number} [rotation=0] - Initial rotation (0-7).
   * @param {string} dbId - The persistent MongoDB _id string for this furniture item. **Required**.
   * @param {string | null} [ownerId=null] - The persistent User _id string of the owner, or null.
   * @param {string | null} [initialState=null] - Initial state ('on', 'off').
   * @param {string | null} [initialColorOverride=null] - Initial custom color hex.
   */
  constructor(
    definitionId,
    x,
    y,
    z,
    rotation = 0,
    dbId, // Renamed from id, now mandatory DB _id string
    ownerId = null,
    initialState = null,
    initialColorOverride = null
  ) {
    if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS) {
      throw new Error(
        "SHARED_CONFIG_REF not loaded or invalid when creating ServerFurniture."
      );
    }
    const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
      (def) => def.id === definitionId
    );
    if (!definition) {
      throw new Error(`Invalid furniture definition ID: ${definitionId}`);
    }
    // --- DB ID is now required for persistent furniture ---
    if (!dbId) {
      throw new Error(
        "ServerFurniture requires a persistent database ID (dbId)."
      );
    }

    // Pass the MongoDB _id (dbId) as the persistentId to the base constructor
    super(x, y, z, dbId); // Sets this.id = dbId

    // Room ID needs to be set externally (e.g., by ServerRoom when loading/adding)
    this.roomId = null;

    // --- Definition Properties ---
    this.definitionId = definitionId;
    this.name = definition.name;
    this.width = definition.width || 1;
    this.height = definition.height || 1;
    this.isWalkable = definition.isWalkable || false;
    this.isFlat = definition.isFlat || false;
    this.stackable =
      definition.stackable !== undefined ? definition.stackable : !this.isFlat;
    this.stackHeight = definition.stackHeight ?? (this.isFlat ? 0 : 1.0);
    this.zOffset = definition.zOffset || 0;
    this.canRecolor = definition.canRecolor || false;

    // --- Interaction Properties ---
    this.canSit = definition.canSit || false;
    this.sitDir = definition.sitDir ?? SHARED_CONFIG_REF.DIRECTION_SOUTH;
    this.sitHeightOffset = definition.sitHeightOffset || 0.1;
    this.canUse = definition.canUse || false;
    this.isToggle = definition.isToggle || false;

    // --- Door Properties ---
    this.isDoor = definition.isDoor || false;
    this.targetRoomId = definition.targetRoomId || null;
    this.targetX = definition.targetX;
    this.targetY = definition.targetY;

    // --- Instance Properties ---
    this.rotation = rotateDirectionFunc(0, rotation);
    this.ownerId = ownerId; // User ObjectId string or null
    this.state = initialState ?? definition.defaultState ?? null;
    this.colorOverride = initialColorOverride || null;
  }

  /**
   * Data Transfer Object for clients. Includes persistent ID as string.
   */
  toDTO() {
    const dto = {
      ...super.toDTO(), // Includes id (string), x, y, z
      definitionId: this.definitionId,
      rotation: this.rotation,
    };
    if (this.canUse) dto.state = this.state;
    if (this.colorOverride) dto.colorOverride = this.colorOverride;
    if (this.isDoor) {
      dto.isDoor = true;
      dto.targetRoomId = this.targetRoomId;
    }
    // dto.ownerId = this.ownerId; // Optionally include owner if needed client-side
    return dto;
  }

  /**
   * Generates an object suitable for saving/updating this furniture item in the DB.
   * Excludes the _id itself, as that's the document key. Requires this.roomId to be set.
   */
  toDBSaveObject() {
    if (this.roomId === null) {
      console.warn(
        `Attempted to generate DB save object for furniture ${this.id} without roomId set!`
      );
    }
    return {
      roomId: this.roomId,
      definitionId: this.definitionId,
      x: this.x,
      y: this.y,
      z: this.z,
      rotation: this.rotation,
      ownerId: this.ownerId, // Store the User ObjectId string (or null)
      state: this.state,
      colorOverride: this.colorOverride,
    };
  }

  /**
   * Calculates the grid tiles occupied by this furniture.
   */
  getOccupiedTiles() {
    const tiles = [];
    const startX = Math.round(this.x);
    const startY = Math.round(this.y);
    const halfW = Math.floor((this.width - 1) / 2);
    const halfH = Math.floor((this.height - 1) / 2);

    for (let dx = -halfW; dx < this.width - halfW; dx++) {
      for (let dy = -halfH; dy < this.height - halfH; dy++) {
        tiles.push({ x: startX + dx, y: startY + dy });
      }
    }
    return tiles.length > 0 ? tiles : [{ x: startX, y: startY }];
  }

  /**
   * Calculates the grid tile an avatar should stand on to interact.
   */
  getInteractionTile() {
    const baseFacingDir = this.sitDir ?? SHARED_CONFIG_REF.DIRECTION_SOUTH;
    const facingDir = rotateDirectionFunc(baseFacingDir, this.rotation);
    const interactionDir = rotateDirectionFunc(facingDir, 4); // 180 degrees

    let dx = 0,
      dy = 0;
    if (interactionDir === 0 || interactionDir === 1 || interactionDir === 7)
      dy = -1;
    if (interactionDir === 3 || interactionDir === 4 || interactionDir === 5)
      dy = 1;
    if (interactionDir === 1 || interactionDir === 2 || interactionDir === 3)
      dx = 1;
    if (interactionDir === 5 || interactionDir === 6 || interactionDir === 7)
      dx = -1;

    return { x: Math.round(this.x) + dx, y: Math.round(this.y) + dy };
  }

  /**
   * Handles the 'use' action. Updates in-memory state and returns changes for DB/broadcast.
   * @param {ServerAvatar} avatar - The initiating avatar.
   * @param {ServerRoom} room - The room context for Z calculation.
   * @returns {{ changed: boolean, updatePayload: object | null }}
   */
  use(avatar, room) {
    const result = { changed: false, updatePayload: null };
    if (
      !this.canUse ||
      this.isDoor ||
      !SHARED_CONFIG_REF ||
      !SHARED_CONFIG_REF.FURNITURE_DEFINITIONS
    ) {
      return result;
    }

    const oldState = this.state;
    const oldZ = this.z;

    // Toggle state if applicable
    if (this.isToggle) {
      this.state = this.state === "on" ? "off" : "on";
      if (this.state !== oldState) {
        result.changed = true;
        result.updatePayload = { state: this.state };
      }
    }

    // Recalculate Z Position
    const definition = SHARED_CONFIG_REF.FURNITURE_DEFINITIONS.find(
      (d) => d.id === this.definitionId
    );
    if (!definition) return result; // Should not happen if constructor succeeded

    const baseZ = room.getStackHeightAt(
      Math.round(this.x),
      Math.round(this.y),
      this.id
    );
    const stateZOffset =
      this.state === "on" && definition.id === "light_simple" ? 0.01 : 0;
    const newZ = baseZ + (definition.zOffset || 0) + stateZOffset;

    if (Math.abs(this.z - newZ) > 0.001) {
      this.z = newZ;
      result.changed = true;
      // Add Z to the update payload, merging if state already changed
      result.updatePayload = { ...(result.updatePayload || {}), z: this.z };
    }

    return result;
  }

  /**
   * Changes the furniture's color override. Updates in-memory state and returns changes.
   * @param {string | null} hexColor - New hex color or null/"" to reset.
   * @returns {{ changed: boolean, updatePayload: object | null }}
   */
  setColorOverride(hexColor) {
    const result = { changed: false, updatePayload: null };
    if (!this.canRecolor) return result;
    if (!SHARED_CONFIG_REF || !SHARED_CONFIG_REF.VALID_RECOLOR_HEX) {
      console.warn(
        "Cannot set color override: SHARED_CONFIG_REF missing or invalid."
      );
      return result;
    }

    const effectiveColor =
      hexColor === null || hexColor === "" ? null : hexColor.toUpperCase();

    if (
      effectiveColor !== null &&
      !SHARED_CONFIG_REF.VALID_RECOLOR_HEX.includes(effectiveColor)
    ) {
      console.warn(
        `Attempted to set invalid color ${effectiveColor} on ${this.name}`
      );
      return result;
    }

    if (this.colorOverride === effectiveColor) return result; // No change

    this.colorOverride = effectiveColor;
    result.changed = true;
    result.updatePayload = { colorOverride: this.colorOverride }; // Payload includes new value (could be null)
    return result;
  }
}

// --- Represents player avatars on the server (uses runtime ID) ---
class ServerAvatar extends ServerGameObject {
  /**
   * Creates a new ServerAvatar instance.
   * @param {number} x - Initial X coordinate.
   * @param {number} y - Initial Y coordinate.
   * @param {string} [name="User"] - Avatar's name.
   * @param {string | null} [explicitRuntimeId=null] - IGNORED. Kept for potential past compatibility, but runtime ID is now always generated.
   * @param {string | null} [socketId=null] - Associated socket ID.
   */
  constructor(x, y, name = "User", explicitRuntimeId = null, socketId = null) {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) {
      throw new Error(
        "SHARED_CONFIG_REF or SERVER_CONFIG_REF not loaded when creating ServerAvatar."
      );
    }
    // Avatars use RUNTIME IDs. Pass null for persistentId to generate one.
    super(x, y, SHARED_CONFIG_REF.AVATAR_DEFAULT_Z, null);
    // this.id is now the runtime ID (_runtimeIdCounter value)

    this.name = name;
    this.socketId = socketId;
    this.roomId = null; // Set by ServerRoom

    // --- Movement ---
    this.targetX = x;
    this.targetY = y;
    this.path = [];
    this.speed = SERVER_CONFIG_REF.AVATAR_SPEED;
    this.actionAfterPath = null;

    // --- State ---
    this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
    this.direction = SHARED_CONFIG_REF.DIRECTION_SOUTH;
    this.sittingOnFurniId = null; // Stores the MongoDB _id STRING of the furniture

    // --- Customization & Effects ---
    this.bodyColor = "#6CA0DC";
    this.emoteTimeout = null;
    this.currentEmoteId = null;

    // --- Inventory & Currency ---
    this.inventory = new Map(); // definitionId -> quantity
    this.currency = SHARED_CONFIG_REF.DEFAULT_CURRENCY;
  }

  /**
   * Data Transfer Object for client updates. Includes runtime ID as string.
   */
  toDTO() {
    if (!SHARED_CONFIG_REF) return { id: String(this.id), name: this.name }; // Send runtime ID as string

    const emoteData =
      this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING
        ? { emoteId: this.currentEmoteId }
        : {};
    return {
      ...super.toDTO(), // Includes id (runtime, string), x, y, z
      name: this.name,
      roomId: this.roomId,
      state: this.state,
      direction: this.direction,
      sittingOnFurniId: this.sittingOnFurniId
        ? String(this.sittingOnFurniId)
        : null, // Send furniture DB ID string
      bodyColor: this.bodyColor,
      ...emoteData,
    };
  }

  /**
   * Simplified DTO for profile information requests. Includes runtime ID as string.
   */
  toProfileDTO() {
    return {
      id: String(this.id), // Send runtime ID as string
      name: this.name,
      state: this.state,
      roomId: this.roomId,
      bodyColor: this.bodyColor,
      currency: this.currency,
      // inventory: this.getInventoryDTO(), // Optional: send inventory summary
    };
  }

  /** Adds an item (by definition ID) to the inventory. */
  addItem(definitionId, quantity = 1) {
    if (quantity <= 0) return false;
    const currentQuantity = this.inventory.get(definitionId) || 0;
    this.inventory.set(definitionId, currentQuantity + quantity);
    console.log(
      `Inventory: Added ${quantity}x ${definitionId} to ${
        this.name
      }. New total: ${this.inventory.get(definitionId)}`
    );
    return true;
  }

  /** Removes an item (by definition ID) from the inventory. */
  removeItem(definitionId, quantity = 1) {
    if (quantity <= 0) return false;
    const currentQuantity = this.inventory.get(definitionId) || 0;
    if (currentQuantity < quantity) {
      console.log(
        `Inventory: Failed to remove ${quantity}x ${definitionId} from ${this.name}. Only have ${currentQuantity}`
      );
      return false; // Not enough items
    }
    const newQuantity = currentQuantity - quantity;
    if (newQuantity === 0) {
      this.inventory.delete(definitionId);
      console.log(
        `Inventory: Removed last ${quantity}x ${definitionId} from ${this.name}.`
      );
    } else {
      this.inventory.set(definitionId, newQuantity);
      console.log(
        `Inventory: Removed ${quantity}x ${definitionId} from ${this.name}. New total: ${newQuantity}`
      );
    }
    return true;
  }

  /** Checks if the avatar has a specific item in inventory. */
  hasItem(definitionId, quantity = 1) {
    return (this.inventory.get(definitionId) || 0) >= quantity;
  }

  /** Gets a DTO representation of the inventory for sending to the client. */
  getInventoryDTO() {
    return Object.fromEntries(this.inventory.entries());
  }

  /**
   * Updates avatar position based on path and delta time. Executes deferred actions upon arrival.
   * Uses furniture DB IDs for deferred actions.
   * @param {number} deltaTimeMs - Time elapsed since last update in milliseconds.
   * @param {ServerRoom} room - Room context for executing actions.
   * @param {Function} changeRoomCallback - Callback function to trigger room change if action is 'door'. Signature: (socket, data)
   * @returns {boolean} True if the avatar's state (pos, dir, state) changed, false otherwise.
   */
  updateMovement(deltaTimeMs, room, changeRoomCallback) {
    if (!SHARED_CONFIG_REF) return false;
    if (
      this.state !== SHARED_CONFIG_REF.AVATAR_STATE_WALKING ||
      this.path.length === 0
    ) {
      return false;
    }

    const targetStep = this.path[0];
    const dx = targetStep.x - this.x;
    const dy = targetStep.y - this.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const moveAmount = this.speed * (deltaTimeMs / 1000);

    let positionChanged = false;
    let stateOrDirectionChanged = false;

    if (distance <= moveAmount) {
      // Reached Waypoint
      this.x = targetStep.x;
      this.y = targetStep.y;
      this.path.shift();
      positionChanged = true;

      if (this.path.length === 0) {
        // Reached Final Destination
        const oldState = this.state;
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Tentative
        stateOrDirectionChanged = this.state !== oldState;

        if (this.actionAfterPath) {
          const action = this.actionAfterPath;
          this.actionAfterPath = null;

          if (action.type === "sit") {
            // Use the DB ID (string) stored in action.targetId for lookup
            const furni = room.getFurnitureById(action.targetId);
            if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
              if (this.executeSit(furni, room)) {
                // executeSit handles setting state
                stateOrDirectionChanged = true;
              } else {
                this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
              }
            } else {
              this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
            }
          } else if (action.type === "door") {
            if (changeRoomCallback && action.targetRoomId && action.socket) {
              changeRoomCallback(action.socket, {
                targetRoomId: action.targetRoomId,
                targetX: action.targetX,
                targetY: action.targetY,
              });
              return true; // Room change handles state
            } else {
              console.error(
                "Door action failed: Missing callback, targetRoomId, or socket.",
                action
              );
              this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
            }
          } else {
            this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
          }
        }
        // Ensure idle if not sitting after action
        if (
          this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING &&
          this.state !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE
        ) {
          this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
          stateOrDirectionChanged = true;
        }
      } else {
        // Intermediate Waypoint
        const nextStep = this.path[0];
        if (this.updateDirection(nextStep.x - this.x, nextStep.y - this.y)) {
          stateOrDirectionChanged = true;
        }
      }
    } else {
      // Moving Towards Waypoint
      this.x += (dx / distance) * moveAmount;
      this.y += (dy / distance) * moveAmount;
      positionChanged = true;
      if (this.updateDirection(dx, dy)) {
        stateOrDirectionChanged = true;
      }
    }
    return positionChanged || stateOrDirectionChanged;
  }

  /**
   * Updates the avatar's facing direction based on movement vector.
   */
  updateDirection(dx, dy) {
    if (!SHARED_CONFIG_REF || (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01))
      return false;

    let newDirection = this.direction;
    const angle = Math.atan2(dy, dx);
    const pi = Math.PI;

    if (angle > -pi / 8 && angle <= pi / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_EAST;
    else if (angle > pi / 8 && angle <= (3 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH_EAST;
    else if (angle > (3 * pi) / 8 && angle <= (5 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH;
    else if (angle > (5 * pi) / 8 && angle <= (7 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_SOUTH_WEST;
    else if (angle > (7 * pi) / 8 || angle <= (-7 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_WEST;
    else if (angle > (-7 * pi) / 8 && angle <= (-5 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH_WEST;
    else if (angle > (-5 * pi) / 8 && angle <= (-3 * pi) / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH;
    else if (angle > (-3 * pi) / 8 && angle <= -pi / 8)
      newDirection = SHARED_CONFIG_REF.DIRECTION_NORTH_EAST;

    if (newDirection !== this.direction) {
      this.direction = newDirection;
      return true; // Direction changed
    }
    return false; // Direction did not change
  }

  /**
   * Initiates movement towards a target grid coordinate.
   * Deferred action `targetId` should use the furniture's persistent DB ID (_id string).
   * @param {number} targetGridX - Target grid X coordinate.
   * @param {number} targetGridY - Target grid Y coordinate.
   * @param {ServerRoom} room - The room context for pathfinding and actions.
   * @param {object | null} deferredAction - Action to perform upon arrival (e.g., { type: 'sit', targetId: 'furni_db_id_string' }).
   * @param {Function} changeRoomCallback - Required if deferredAction might be 'door'.
   * @returns {boolean} True if the avatar's state changed (e.g., started walking or emote cleared), false otherwise.
   */
  moveTo(
    targetGridX,
    targetGridY,
    room,
    deferredAction = null,
    changeRoomCallback = null
  ) {
    if (!SHARED_CONFIG_REF) return false;
    if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
      console.log(`${this.name} cannot move while sitting.`);
      return false;
    }

    let stateChangedByEmoteClear = false;
    if (this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING) {
      this.clearEmote(true); // Clear emote AND reset state
      stateChangedByEmoteClear = true;
    }
    this.actionAfterPath = null; // Clear previous deferred action

    const startX = Math.round(this.x);
    const startY = Math.round(this.y);
    const endX = Math.round(targetGridX);
    const endY = Math.round(targetGridY);

    // --- Handle reaching target immediately ---
    if (startX === endX && startY === endY) {
      const oldState = this.state;
      let stateChangedByAction = false;
      this.path = [];

      if (deferredAction) {
        this.actionAfterPath = deferredAction; // Temporarily set to execute now
        if (this.actionAfterPath.type === "sit") {
          const furni = room.getFurnitureById(this.actionAfterPath.targetId); // Use DB ID
          if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
            if (this.executeSit(furni, room)) stateChangedByAction = true;
          }
        } else if (this.actionAfterPath.type === "door") {
          if (changeRoomCallback && action.targetRoomId && action.socket) {
            // Trigger immediately if already at the door tile
            changeRoomCallback(action.socket, {
              targetRoomId: action.targetRoomId,
              targetX: action.targetX,
              targetY: action.targetY,
            });
            // Don't change state here, room change handles it
            return true; // State will definitely change
          } else {
            console.error(
              "moveTo: Cannot trigger door action immediately: Missing callback, targetRoomId, or socket.",
              this.actionAfterPath
            );
          }
        }
        // Clear action if executed or if not handled immediately
        if (this.actionAfterPath?.type !== "door") {
          // Keep door action pending if callback missing
          this.actionAfterPath = null;
        }
      }

      // If state isn't sitting after potential action, set to idle
      if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
        return (
          stateChangedByAction ||
          oldState !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE ||
          stateChangedByEmoteClear
        );
      }
      return stateChangedByAction || stateChangedByEmoteClear;
    }

    // --- Find Path ---
    const newPath = room.pathfinder.findPath(startX, startY, endX, endY);

    if (newPath && newPath.length > 0) {
      if (newPath[0].x === startX && newPath[0].y === startY) {
        newPath.shift();
      }

      if (newPath.length > 0) {
        // Valid path found
        this.path = newPath;
        const oldState = this.state;
        this.state = SHARED_CONFIG_REF.AVATAR_STATE_WALKING;
        this.targetX = endX;
        this.targetY = endY;
        this.actionAfterPath = deferredAction; // Store action for arrival
        this.updateDirection(this.path[0].x - this.x, this.path[0].y - this.y);
        return this.state !== oldState || stateChangedByEmoteClear;
      } else {
        // Path found, but only contains start tile (already there) - treat same as above
        const oldState = this.state;
        let stateChangedByAction = false;
        this.path = [];
        if (deferredAction) {
          this.actionAfterPath = deferredAction;
          if (this.actionAfterPath.type === "sit") {
            /* ... try sit ... */
            const furni = room.getFurnitureById(this.actionAfterPath.targetId);
            if (furni && furni.canSit && !room.isFurnitureOccupied(furni.id)) {
              if (this.executeSit(furni, room)) stateChangedByAction = true;
            }
          } else if (this.actionAfterPath.type === "door") {
            /* ... trigger door if possible ... */
            if (changeRoomCallback && action.targetRoomId && action.socket) {
              changeRoomCallback(action.socket, {
                targetRoomId: action.targetRoomId,
                targetX: action.targetX,
                targetY: action.targetY,
              });
              return true;
            }
          }
          if (this.actionAfterPath?.type !== "door")
            this.actionAfterPath = null;
        }
        if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) {
          this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
          return (
            stateChangedByAction ||
            oldState !== SHARED_CONFIG_REF.AVATAR_STATE_IDLE ||
            stateChangedByEmoteClear
          );
        }
        return stateChangedByAction || stateChangedByEmoteClear;
      }
    } else {
      // No path found
      const oldState = this.state;
      this.path = [];
      this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Ensure idle
      this.actionAfterPath = null;
      console.log(
        `No path found for ${this.name} to (${endX},${endY}). State -> idle`
      );
      return this.state !== oldState || stateChangedByEmoteClear;
    }
  }

  /**
   * Executes the sit action on a given piece of furniture.
   * Uses furniture's persistent DB ID (_id string).
   */
  executeSit(furniture, room) {
    if (!SHARED_CONFIG_REF) return false;
    // Use furniture.id (which is the DB _id string)
    if (
      this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING ||
      !furniture ||
      !furniture.id
    )
      return false;

    this.clearEmote(true); // Clear emote and reset state

    const oldState = this.state;
    this.state = SHARED_CONFIG_REF.AVATAR_STATE_SITTING;
    this.path = [];
    this.actionAfterPath = null;
    this.z = furniture.z + furniture.sitHeightOffset;
    this.x = furniture.x;
    this.y = furniture.y;
    this.direction = rotateDirectionFunc(furniture.sitDir, furniture.rotation);
    this.sittingOnFurniId = String(furniture.id); // Store the DB _id STRING

    return this.state !== oldState;
  }

  /**
   * Executes the stand action. Uses furniture's persistent DB ID.
   */
  executeStand(room) {
    if (!SHARED_CONFIG_REF) return false;
    if (this.state !== SHARED_CONFIG_REF.AVATAR_STATE_SITTING) return false;

    this.clearEmote(false);

    const oldState = this.state;
    const oldFurniId = this.sittingOnFurniId; // This is the DB ID string
    const furni = room?.getFurnitureById(oldFurniId); // Lookup by DB ID

    // Reset avatar state regardless
    this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
    this.z = SHARED_CONFIG_REF.AVATAR_DEFAULT_Z;
    this.sittingOnFurniId = null; // Clear link

    let movedToAdjacent = false;
    if (furni && room) {
      // Try to find a walkable adjacent tile
      const standOffsets = [
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0 },
        { dx: 1, dy: 0 },
        { dx: 0, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: -1 },
        { dx: 1, dy: -1 },
      ];
      const currentFurniX = Math.round(furni.x);
      const currentFurniY = Math.round(furni.y);

      for (const offset of standOffsets) {
        const standX = currentFurniX + offset.dx;
        const standY = currentFurniY + offset.dy;
        if (room.isWalkable(standX, standY)) {
          this.x = standX;
          this.y = standY;
          movedToAdjacent = true;
          break;
        }
      }
    }

    if (!movedToAdjacent && furni) {
      // Fallback: place at furniture's base coords
      this.x = furni.x;
      this.y = furni.y;
    } else if (!movedToAdjacent && !furni) {
      // If original furniture is gone, avatar position remains
      console.warn(
        `${this.name} stood up but original furniture (ID: ${oldFurniId}) not found. Avatar remains at (${this.x}, ${this.y}).`
      );
    }
    return true; // State always changes from sitting to idle
  }

  /**
   * Starts an emote action.
   */
  executeEmote(emoteId, ioInstance) {
    if (!SHARED_CONFIG_REF || !SERVER_CONFIG_REF) return false;
    const emoteDef = SHARED_CONFIG_REF.EMOTE_DEFINITIONS[emoteId];
    if (!emoteDef) return false;
    if (
      this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING ||
      this.state === SHARED_CONFIG_REF.AVATAR_STATE_SITTING
    ) {
      return false;
    }

    const oldState = this.state;
    this.state = SHARED_CONFIG_REF.AVATAR_STATE_EMOTING;
    this.currentEmoteId = emoteId;
    this.clearEmote(false); // Clear previous timer

    const duration =
      emoteDef.duration || SERVER_CONFIG_REF.EMOTE_DURATION_SERVER;

    this.emoteTimeout = setTimeout(() => {
      if (
        this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING &&
        this.currentEmoteId === emoteId
      ) {
        this.state =
          this.path?.length > 0
            ? SHARED_CONFIG_REF.AVATAR_STATE_WALKING
            : SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
        this.currentEmoteId = null;
        this.emoteTimeout = null;
        if (ioInstance && this.roomId) {
          ioInstance.to(this.roomId).emit("avatar_update", this.toDTO());
        } else {
          console.warn(
            "Cannot broadcast emote end: ioInstance or avatar.roomId missing."
          );
        }
      }
    }, duration);
    return true; // State changed
  }

  /**
   * Clears any active server-side emote timeout.
   */
  clearEmote(resetState = false) {
    if (!SHARED_CONFIG_REF) return;
    if (this.emoteTimeout) {
      clearTimeout(this.emoteTimeout);
      this.emoteTimeout = null;
    }
    if (resetState && this.state === SHARED_CONFIG_REF.AVATAR_STATE_EMOTING) {
      this.state =
        this.path?.length > 0
          ? SHARED_CONFIG_REF.AVATAR_STATE_WALKING
          : SHARED_CONFIG_REF.AVATAR_STATE_IDLE;
      this.currentEmoteId = null;
      // Caller responsible for broadcasting change if needed immediately
    }
  }

  /**
   * Sets the avatar's body color.
   */
  setBodyColor(hexColor) {
    if (!/^#[0-9A-F]{6}$/i.test(hexColor)) return false;
    const upperHex = hexColor.toUpperCase();
    if (this.bodyColor === upperHex) return false;
    this.bodyColor = upperHex;
    return true;
  }

  /** Adds currency to the avatar. */
  addCurrency(amount) {
    const amountInt = Math.floor(amount);
    if (typeof amountInt !== "number" || amountInt <= 0 || isNaN(amountInt))
      return false;
    this.currency += amountInt;
    console.log(
      `Currency: Added ${amountInt} to ${this.name}. New total: ${this.currency}`
    );
    return true;
  }

  /** Removes currency if sufficient funds exist. */
  removeCurrency(amount) {
    const amountInt = Math.floor(amount);
    if (typeof amountInt !== "number" || amountInt <= 0 || isNaN(amountInt))
      return false;
    if (this.currency >= amountInt) {
      this.currency -= amountInt;
      console.log(
        `Currency: Removed ${amountInt} from ${this.name}. New total: ${this.currency}`
      );
      return true;
    }
    console.log(
      `Currency: Failed to remove ${amountInt} from ${this.name}. Only have ${this.currency}`
    );
    return false;
  }

  /**
   * Prepares the avatar for a room change. Resets state, position, etc.
   */
  prepareForRoomChange(newRoomId, targetX, targetY) {
    if (!SHARED_CONFIG_REF) return;
    console.log(
      `${this.name} (ID: ${this.id}) preparing for room change to ${newRoomId} at (${targetX}, ${targetY})`
    );
    this.clearEmote(true); // Stop emote and reset state
    this.state = SHARED_CONFIG_REF.AVATAR_STATE_IDLE; // Force idle
    this.path = [];
    this.actionAfterPath = null;
    this.targetX = targetX;
    this.targetY = targetY;
    this.sittingOnFurniId = null; // Cannot be sitting

    this.x = targetX;
    this.y = targetY;
    this.z = SHARED_CONFIG_REF.AVATAR_DEFAULT_Z; // Reset Z
    this.roomId = newRoomId; // Update room ID
  }
} // End ServerAvatar Class

// Node.js export
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ServerGameObject,
    ServerFurniture,
    ServerAvatar,
  };
}
