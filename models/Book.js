const mongoose = require('mongoose');

const bookSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
        trim: true
    },
    author: {
        type: String,
        trim: true
    },
    category: {
        type: String,
        trim: true
    },
    tags: {
        type: [String],
        default: []
    },
    description: {
        type: String,
        trim: true
    },
    is_premium: {
        type: Boolean,
        default: false,
        index: true
    },
    pdf_path: {
        type: String,
        required: true
    },
    thumbnail_path: {
        type: String
    },
    upload_date: {
        type: Date,
        default: Date.now
    },
    view_count: {
        type: Number,
        default: 0
    },
    download_count: {
        type: Number,
        default: 0
    },
    avg_rating: { type: Number, default: 0 },
    ratings_count: { type: Number, default: 0 },
    featured: { type: Boolean, default: false, index: true },
    featured_tagline: { type: String, trim: true }
}, {
    timestamps: true  // Adds createdAt and updatedAt automatically
});

// Index for faster searches
bookSchema.index({ title: 'text', author: 'text', category: 'text', description: 'text' });

const Book = mongoose.model('Book', bookSchema);

module.exports = Book;
