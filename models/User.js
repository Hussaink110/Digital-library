const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
  phone: { type: String, trim: true, index: true },
  password_hash: { type: String, required: true },
  reading_list: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Book' }],
  favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Book', index: true }],
  reading_progress: [{
    book: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', index: true },
    page: { type: Number, default: 1 },
    scale: { type: Number, default: 1.2 },
    updated_at: { type: Date, default: Date.now }
  }],
  subscription_plan: { type: String, enum: ['none', 'basic', 'premium'], default: 'none', index: true },
  subscription_status: { type: String, enum: ['none', 'active', 'expired'], default: 'none', index: true },
  subscription_start: { type: Date },
  subscription_end: { type: Date, index: true },
  period_started_at: { type: Date },
  read_books_in_period: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Book' }],
  downloaded_books_in_period: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Book' }]
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);