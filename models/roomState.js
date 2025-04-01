// models/roomState.js
const mongoose = require("mongoose");

const roomStateSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Store the layout directly
    layout: {
      type: [[mongoose.Schema.Types.Mixed]], // Array of arrays, mixed types (0, 1, 2, 'X')
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RoomState", roomStateSchema);
