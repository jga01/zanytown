const mongoose = require("mongoose");

const furnitureSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, index: true }, // Room this furniture belongs to
    definitionId: { type: String, required: true }, // e.g., 'chair_basic'
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    z: { type: Number, required: true },
    rotation: { type: Number, default: 0 },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    }, // User ObjectId
    state: { type: String, default: null }, // 'on'/'off' etc.
    colorOverride: { type: String, default: null }, // Hex color string
    // Note: _id is automatically added by Mongoose
  },
  { timestamps: true }
); // Add createdAt/updatedAt

module.exports = mongoose.model("Furniture", furnitureSchema);
