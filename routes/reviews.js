const express = require('express');
const Review = require('../models/Review');
const Book = require('../models/Book');
const Joi = require('joi');
const { requireUser } = require('../middleware/userAuth');

const router = express.Router();

const reviewSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().allow('', null).max(2000)
});

// Get reviews for a book
router.get('/api/books/:id/reviews', async (req, res) => {
  try {
    const reviews = await Review.find({ book: req.params.id })
      .sort({ createdAt: -1 })
      .limit(100)
      .populate('user', 'name email');
    res.json(reviews);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

// Add or update a review
router.post('/api/books/:id/reviews', requireUser, async (req, res) => {
  try {
    const { value, error } = reviewSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'invalid input' });
    const { rating, comment } = value;
    const userId = req.session.user.id;
    const bookId = req.params.id;

    await Review.findOneAndUpdate(
      { user: userId, book: bookId },
      { rating, comment },
      { upsert: true, setDefaultsOnInsert: true }
    );

    // Recompute aggregate
    const agg = await Review.aggregate([
      { $match: { book: require('mongoose').Types.ObjectId.createFromHexString(bookId) } },
      { $group: { _id: '$book', avg: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);
    const avg = agg[0]?.avg || 0;
    const count = agg[0]?.count || 0;
    await Book.findByIdAndUpdate(bookId, { avg_rating: Math.round(avg * 10)/10, ratings_count: count });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;