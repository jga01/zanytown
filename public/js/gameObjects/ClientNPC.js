import { ClientAvatar } from "./ClientAvatar.js";
import { SHARED_CONFIG, CLIENT_CONFIG } from "../config.js";
import { getScreenPos } from "../utils.js";

// Represents an NPC on the client side. Inherits from ClientAvatar for rendering/movement.
export class ClientNPC extends ClientAvatar {
  constructor(dto) {
    super(dto); // Call base constructor (handles id, pos, visuals, state, dir etc.)

    this.isNPC = true; // Explicit flag
    this.npcId = dto.npcId; // The definition ID (e.g., "bob_the_wanderer")

    // NPCs don't have inventories, currency, etc. on the client
    this.inventory = {};
    this.currency = 0;
    this.isAdmin = false; // NPCs are not admins
    this.isPlayer = false; // NPCs are not the player

    // Override name color/styling if needed
    // this.nameColor = "#00DDDD"; // Example: Cyan name for NPCs
  }

  // Inherits update(), interpolate(), draw(), containsPoint() from ClientAvatar
  // We might override draw() later for unique NPC appearances.

  // Override say() to style NPC bubbles differently?
  say(text) {
    // Currently uses ClientAvatar's say, which adds to uiState.activeChatBubbles.
    // We can customize the element creation/styling in uiManager based on isNPC flag.
    super.say(text);
    // Add a specific class? Handled better in uiManager when creating the element.
    // if (this.chatBubble?.element) {
    //    this.chatBubble.element.classList.add('npc-bubble');
    // }
  }

  // Override update to ensure isNPC and isPlayer are correct
  update(dto) {
    super.update(dto); // Call parent update
    this.isNPC = true;
    this.isPlayer = false; // Ensure NPCs are never marked as player
    if (dto.npcId) this.npcId = dto.npcId; // Update definition ID if provided
  }

  draw(ctx, camera) {
    // Use the parent Avatar drawing for now
    super.draw(ctx, camera);

    // --- Optional: Add NPC-specific visual cues ---
    // Example: Draw a small indicator above the name?
    // const screenPos = getScreenPos(this.visualX, this.visualY);
    // const zoom = camera.zoom;
    // const nameY = super.getNameTagYPosition(screenPos.y, zoom); // Need to expose or recalculate name Y
    // if (nameY) {
    //     ctx.fillStyle = "purple";
    //     ctx.font = `bold ${Math.max(6, 8 * zoom)}px Arial`;
    //     ctx.textAlign = "center";
    //     ctx.fillText("[NPC]", screenPos.x, nameY - 12 * zoom);
    // }
    // --- End Optional ---
  }
}
