import { ClientGameObject } from "./ClientGameObject.js";
import { SHARED_CONFIG, CLIENT_CONFIG } from "../config.js";
import { gameState, uiState, camera } from "../gameState.js"; // Need game state for ID check, uiState for bubbles
import { getScreenPos, shadeColor } from "../utils.js";
// Sounds are handled by network/uiManager now based on state changes
// import { playSound } from '../sounds.js';
// Bubble DOM manipulation is handled by uiManager
// import { updateChatBubblePosition, clearBubble } from '../uiManager.js';

export class ClientAvatar extends ClientGameObject {
  constructor(dto) {
    super(dto); // Call base constructor

    this.name = dto.name || "???";
    this.state = dto.state || SHARED_CONFIG?.AVATAR_STATE_IDLE || "idle";
    this.direction = dto.direction ?? SHARED_CONFIG?.DIRECTION_SOUTH ?? 2;
    this.sittingOnFurniId = dto.sittingOnFurniId || null; // String furniture DB ID
    this.bodyColor =
      dto.bodyColor || CLIENT_CONFIG?.AVATAR_SKIN_COLOR || "#6CA0DC";
    this.isAdmin = dto.isAdmin || false;

    // Client-side emote tracking
    this.currentEmoteId = dto.emoteId || null; // The ID of the active emote
    this.emoteEndTime = 0; // Timestamp when the emote should visually end

    // Link to chat bubble data (managed by uiManager)
    this.chatBubble = null; // Holds { id, text, endTime } - element managed by uiManager

    this.isPlayer = false; // Determined by comparing with gameState.myAvatarId
    this.checkIfPlayer(); // Initial check

    // Apply initial state which might start an emote
    this.update(dto);
  }

  /** Sets the isPlayer flag based on gameState.myAvatarId */
  checkIfPlayer() {
    this.isPlayer =
      gameState.myAvatarId !== null && this.id === gameState.myAvatarId;
  }

  /** Updates avatar state from a server DTO. */
  update(dto) {
    if (!SHARED_CONFIG || !CLIENT_CONFIG) {
      // console.warn(`Avatar update skipped for ${this.id}: config not ready.`);
      return;
    }

    // Re-check if this avatar is the player on every update
    this.checkIfPlayer();

    if (dto.name != null) this.name = dto.name;
    if (dto.bodyColor != null) this.bodyColor = dto.bodyColor;
    if (dto.isAdmin !== undefined) this.isAdmin = dto.isAdmin;
    if (dto.direction != null) this.direction = dto.direction;
    if (dto.sittingOnFurniId !== undefined)
      this.sittingOnFurniId = dto.sittingOnFurniId;

    // --- State and Emote Handling ---
    if (dto.state != null) {
      const oldState = this.state;
      const oldEmoteId = this.currentEmoteId;

      // Start new emote?
      if (dto.state === SHARED_CONFIG.AVATAR_STATE_EMOTING && dto.emoteId) {
        if (
          oldState !== SHARED_CONFIG.AVATAR_STATE_EMOTING ||
          oldEmoteId !== dto.emoteId
        ) {
          this.currentEmoteId = dto.emoteId;
          const emoteDef =
            SHARED_CONFIG.EMOTE_DEFINITIONS?.[this.currentEmoteId];
          const duration = emoteDef?.duration || CLIENT_CONFIG.EMOTE_DURATION;
          this.emoteEndTime = Date.now() + duration;
          // Sound is played by network handler upon receiving the update
          // console.log(`${this.name} started emote: ${this.currentEmoteId}`);
        }
      }
      // Stop existing emote?
      else if (
        oldState === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
        dto.state !== SHARED_CONFIG.AVATAR_STATE_EMOTING
      ) {
        // console.log(`${this.name} ended emote via state change: ${this.currentEmoteId}`);
        this.emoteEndTime = 0;
        this.currentEmoteId = null;
      }
      this.state = dto.state;
      // Walk sound played by network handler
    }
    // Handle emote change even if state remains EMOTING
    else if (
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
      dto.emoteId &&
      this.currentEmoteId !== dto.emoteId
    ) {
      // console.log(`${this.name} switched emote to: ${dto.emoteId}`);
      this.currentEmoteId = dto.emoteId;
      const emoteDef = SHARED_CONFIG.EMOTE_DEFINITIONS?.[this.currentEmoteId];
      const duration = emoteDef?.duration || CLIENT_CONFIG.EMOTE_DURATION;
      this.emoteEndTime = Date.now() + duration;
      // Sound played by network handler
    }

    super.update(dto); // Update base properties (x, y, z)
  }

  /** Interpolates position and handles client-side emote end prediction. */
  interpolate(deltaTimeFactor) {
    if (!SHARED_CONFIG || !CLIENT_CONFIG) return;
    super.interpolate(deltaTimeFactor); // Interpolate x, y, z and calculate draw order

    // --- Client-side Emote End Prediction ---
    if (
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING &&
      this.emoteEndTime > 0 &&
      Date.now() > this.emoteEndTime
    ) {
      // Predict next logical state visually (server state is authoritative)
      const isSitting =
        this.sittingOnFurniId !== null &&
        gameState.furniture[this.sittingOnFurniId];
      if (isSitting) {
        this.state = SHARED_CONFIG.AVATAR_STATE_SITTING;
      } else if (
        Math.abs(this.x - this.visualX) > 0.1 ||
        Math.abs(this.y - this.visualY) > 0.1
      ) {
        this.state = SHARED_CONFIG.AVATAR_STATE_WALKING; // Predict walking if still moving visually
      } else {
        this.state = SHARED_CONFIG.AVATAR_STATE_IDLE; // Predict idle
      }
      // console.log(`Client predicted end for emote ${this.currentEmoteId} on ${this.name}, visual state -> ${this.state}`);
      this.currentEmoteId = null;
      this.emoteEndTime = 0;
    }
  }

  /** Stores chat message details to be displayed by the UIManager. */
  say(text) {
    if (!text || !text.trim() || !CLIENT_CONFIG) return;
    // Clear previous bubble reference (uiManager handles actual removal)
    if (this.chatBubble) {
      this.clearBubble(); // Clears local reference
    }
    // Store bubble data; uiManager will create/update the element
    this.chatBubble = {
      id: `bubble-${this.id}-${uiState.nextBubbleId++}`,
      text,
      endTime: Date.now() + CLIENT_CONFIG.CHAT_BUBBLE_DURATION,
      avatarId: this.id, // Link back to avatar
    };
    // Add to global list for uiManager processing
    uiState.activeChatBubbles.push(this.chatBubble);
  }

  /** Clears the local reference to the chat bubble. */
  clearBubble() {
    if (this.chatBubble) {
      // Find in global list and mark for removal or let uiManager handle it
      const bubbleIndex = uiState.activeChatBubbles.findIndex(
        (b) => b.id === this.chatBubble.id
      );
      if (bubbleIndex > -1) {
        // Option 1: Remove immediately (might cause issues if uiManager is iterating)
        // uiState.activeChatBubbles[bubbleIndex].element?.remove();
        // uiState.activeChatBubbles.splice(bubbleIndex, 1);

        // Option 2: Mark for removal by setting endTime (safer)
        uiState.activeChatBubbles[bubbleIndex].endTime = 0; // Mark as expired
      }
      this.chatBubble = null;
    }
  }

  /** Draws the avatar on the canvas. */
  draw(ctx, camera) {
    if (!this.isVisible || !SHARED_CONFIG || !CLIENT_CONFIG || !ctx || !camera)
      return;

    const screenPos = getScreenPos(this.visualX, this.visualY);
    const zoom = camera.zoom;

    // Calculate dimensions
    const bodyWidth = SHARED_CONFIG.TILE_WIDTH_HALF * 0.8 * zoom;
    const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
    const headHeight = totalHeight * 0.3;
    const bodyHeight = totalHeight * 0.7;
    const headWidth = bodyWidth * 0.8;

    // Calculate drawing position (bottom-center is screenPos, offset by Z)
    const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
    const baseY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx; // Adjusted base Y slightly higher than tile center
    const bodyY = baseY - bodyHeight;
    const headY = bodyY - headHeight;
    const bodyX = screenPos.x - bodyWidth / 2;
    const headX = screenPos.x - headWidth / 2;

    // Determine visual state cues
    let isEmotingVisually =
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING && this.currentEmoteId;
    let bodyOutline = shadeColor(this.bodyColor, -40);
    if (isEmotingVisually) bodyOutline = "#FFFF00"; // Yellow outline

    // Body fill color based on state
    let bodyFill = this.bodyColor;
    if (this.state === SHARED_CONFIG.AVATAR_STATE_SITTING)
      bodyFill = shadeColor(this.bodyColor, -20);
    else if (
      this.state === SHARED_CONFIG.AVATAR_STATE_WALKING ||
      this.state === SHARED_CONFIG.AVATAR_STATE_EMOTING
    )
      bodyFill = shadeColor(this.bodyColor, 10);

    ctx.save();

    // Draw Body
    ctx.fillStyle = bodyFill;
    ctx.strokeStyle = bodyOutline;
    ctx.lineWidth = Math.max(1, 1.5 * zoom);
    ctx.fillRect(bodyX, bodyY, bodyWidth, bodyHeight);
    ctx.strokeRect(bodyX, bodyY, bodyWidth, bodyHeight);

    // Draw Head
    ctx.fillStyle = CLIENT_CONFIG.AVATAR_SKIN_COLOR;
    ctx.strokeStyle = shadeColor(CLIENT_CONFIG.AVATAR_SKIN_COLOR, -30);
    ctx.fillRect(headX, headY, headWidth, headHeight);
    ctx.strokeRect(headX, headY, headWidth, headHeight);

    // Draw Eyes (adjusted by direction)
    if (this.direction !== SHARED_CONFIG.DIRECTION_NORTH) {
      // Don't draw if facing directly away
      ctx.fillStyle = CLIENT_CONFIG.AVATAR_EYE_COLOR;
      const eyeSize = Math.max(1.5, 2 * zoom);
      const eyeY = headY + headHeight * 0.4 - eyeSize / 2;
      let eyeCenterX = headX + headWidth / 2;
      let eyeSpacingFactor =
        this.direction === SHARED_CONFIG.DIRECTION_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_WEST
          ? 0.1
          : 0.25;

      // Shift eyes based on horizontal component of direction
      if (
        this.direction === SHARED_CONFIG.DIRECTION_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_SOUTH_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_NORTH_EAST
      ) {
        eyeCenterX = headX + headWidth * 0.6; // Shift right
      } else if (
        this.direction === SHARED_CONFIG.DIRECTION_WEST ||
        this.direction === SHARED_CONFIG.DIRECTION_SOUTH_WEST ||
        this.direction === SHARED_CONFIG.DIRECTION_NORTH_WEST
      ) {
        eyeCenterX = headX + headWidth * 0.4; // Shift left
      }

      const eyeSpacing = headWidth * eyeSpacingFactor;
      // Center eyes slightly differently depending on main axis
      if (
        this.direction === SHARED_CONFIG.DIRECTION_EAST ||
        this.direction === SHARED_CONFIG.DIRECTION_WEST
      ) {
        ctx.fillRect(eyeCenterX - eyeSize / 2, eyeY, eyeSize, eyeSize); // Single centered eye for side view
      } else {
        ctx.fillRect(eyeCenterX - eyeSpacing, eyeY, eyeSize, eyeSize); // Left eye
        ctx.fillRect(eyeCenterX + eyeSpacing - eyeSize, eyeY, eyeSize, eyeSize); // Right eye
      }
    }

    // Draw Name Tag
    ctx.font = `bold ${Math.max(8, 10 * zoom)}px Verdana`;
    ctx.textAlign = "center";
    ctx.lineWidth = Math.max(1, 2 * zoom);
    const nameY = headY - 5 * zoom;
    let nameColor = "white"; // Default
    if (this.isAdmin) nameColor = "cyan";
    if (this.isPlayer) nameColor = "yellow";
    ctx.fillStyle = nameColor;
    ctx.strokeStyle = "black"; // Outline for readability
    ctx.strokeText(this.name, screenPos.x, nameY);
    ctx.fillText(this.name, screenPos.x, nameY);

    // Draw Emote Indicator Bubble (simplified, direct draw)
    if (isEmotingVisually) {
      ctx.fillStyle = "rgba(255, 255, 150, 0.85)"; // Semi-transparent yellow
      ctx.strokeStyle = "#555";
      ctx.lineWidth = 1;
      ctx.font = `italic bold ${Math.max(7, 9 * zoom)}px Verdana`;
      const emoteText = `* ${this.currentEmoteId} *`;
      const emoteY = nameY - 12 * zoom; // Position above name tag
      const textMetrics = ctx.measureText(emoteText);
      const textWidth = textMetrics.width;
      const bubblePadding = 4 * zoom;
      const bubbleWidth = textWidth + bubblePadding * 2;
      const bubbleHeight = 10 * zoom + bubblePadding;

      // Draw simple rect background for emote
      ctx.fillRect(
        screenPos.x - bubbleWidth / 2,
        emoteY - bubbleHeight + bubblePadding / 2,
        bubbleWidth,
        bubbleHeight
      );
      ctx.strokeRect(
        screenPos.x - bubbleWidth / 2,
        emoteY - bubbleHeight + bubblePadding / 2,
        bubbleWidth,
        bubbleHeight
      );

      // Draw emote text
      ctx.fillStyle = "#333";
      ctx.textAlign = "center"; // Already set
      ctx.fillText(emoteText, screenPos.x, emoteY);
    }

    ctx.restore();
  }

  /** Checks if a screen point is within the avatar's approximate bounds. */
  containsPoint(screenX, screenY) {
    if (!SHARED_CONFIG || !CLIENT_CONFIG) return false;
    // Calculate avatar's bounding box on screen
    const screenPos = getScreenPos(this.visualX, this.visualY);
    const zoom = camera.zoom;
    const bodyWidth = SHARED_CONFIG.TILE_WIDTH_HALF * 0.8 * zoom;
    const totalHeight = SHARED_CONFIG.TILE_HEIGHT_HALF * 3.5 * zoom;
    const zOffsetPx = this.visualZ * CLIENT_CONFIG.VISUAL_Z_FACTOR * zoom;
    const baseY =
      screenPos.y + SHARED_CONFIG.TILE_HEIGHT_HALF * zoom * 0.5 - zOffsetPx;
    const topY = baseY - totalHeight;
    const leftX = screenPos.x - bodyWidth / 2;
    const rightX = screenPos.x + bodyWidth / 2;

    return (
      screenX >= leftX &&
      screenX <= rightX &&
      screenY >= topY &&
      screenY <= baseY
    );
  }
}
