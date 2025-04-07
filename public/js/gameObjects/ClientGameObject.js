/** Base class for client-side objects with position and interpolation. */
export class ClientGameObject {
  constructor(dto) {
    this.id = String(dto.id); // Ensure ID is always a string
    this.x = dto.x ?? 0;
    this.y = dto.y ?? 0;
    this.z = dto.z ?? 0;
    this.visualX = this.x; // Initialize visual position to actual position
    this.visualY = this.y;
    this.visualZ = this.z;
    this.drawOrder = 0; // Calculated based on position
    this.isVisible = true; // Flag for potential culling
    // Initial update called by subclasses if needed AFTER they set definition, etc.
  }

  /** Updates the object's state from a server DTO. */
  update(dto) {
    // Apply updates from server DTO
    if (dto.x != null) this.x = dto.x;
    if (dto.y != null) this.y = dto.y;
    if (dto.z != null) this.z = dto.z;
    // Don't call calculateDrawOrder here, interpolate handles it
  }

  /** Smoothly moves visual representation towards target state. */
  interpolate(deltaTimeFactor) {
    // Clamp factor to prevent overshooting
    const factor = Math.max(0, Math.min(1, deltaTimeFactor));

    this.visualX += (this.x - this.visualX) * factor;
    this.visualY += (this.y - this.visualY) * factor;
    this.visualZ += (this.z - this.visualZ) * factor;

    // Snap if very close to target to avoid tiny oscillations and ensure final state
    const SNAP_THRESHOLD = 0.01;
    if (Math.abs(this.x - this.visualX) < SNAP_THRESHOLD) this.visualX = this.x;
    if (Math.abs(this.y - this.visualY) < SNAP_THRESHOLD) this.visualY = this.y;
    if (Math.abs(this.z - this.visualZ) < SNAP_THRESHOLD) this.visualZ = this.z;

    this.calculateDrawOrder(); // Recalculate based on interpolated position
  }

  /** Calculates isometric draw order. Higher Y/X/Z means drawn earlier (further back). */
  calculateDrawOrder() {
    // Ensure integer calculation for reliable sorting
    this.drawOrder =
      Math.round(
        this.visualY * 100000 + this.visualX * 10000 + this.visualZ * 1000
      ) + 1000;
  }

  /** Base draw method (to be overridden). Placeholder showing args. */
  draw(ctx, camera) {
    // Subclasses will implement actual drawing logic using ctx and camera state
    // console.log(`Base draw called for object ${this.id}`);
  }
}
