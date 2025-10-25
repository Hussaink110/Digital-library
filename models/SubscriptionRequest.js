const mongoose = require('mongoose');

const subscriptionRequestSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: String, enum: ['basic', 'premium'], required: true },
  status: { type: String, enum: ['pending', 'processed'], default: 'pending', index: true },
  processed_at: { type: Date },
  note: { type: String, trim: true }
}, { timestamps: true });

// Unique index for pending requests by user+plan to avoid duplicates
subscriptionRequestSchema.index(
  { user: 1, plan: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

module.exports = mongoose.model('SubscriptionRequest', subscriptionRequestSchema);
