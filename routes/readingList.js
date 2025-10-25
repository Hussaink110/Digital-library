const express = require('express');
const User = require('../models/User');
const Joi = require('joi');
const { requireUser } = require('../middleware/userAuth');

const router = express.Router();

const bookIdSchema = Joi.object({
  bookId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required()
});

async function ensureActiveSubscription(userId) {
  const user = await User.findById(userId);
  if (!user) return { ok: false, message: 'User not found' };
  if (user.subscription_status !== 'active' || !user.subscription_end || user.subscription_end < new Date()) {
    return { ok: false, message: 'Subscription inactive or expired. Please contact admin to renew.' };
  }
  return { ok: true };
}

router.get('/api/reading-list', requireUser, async (req, res) => {
  const user = await User.findById(req.session.user.id).populate('reading_list');
  res.json(user.reading_list || []);
});

router.post('/api/reading-list/add', requireUser, async (req, res) => {
  const { value, error } = bookIdSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return res.status(400).json({ error: 'invalid input' });
  const gate = await ensureActiveSubscription(req.session.user.id);
  if (!gate.ok) return res.status(403).json({ error: gate.message });
  const { bookId } = value;
  await User.findByIdAndUpdate(req.session.user.id, { $addToSet: { reading_list: bookId } });
  res.json({ ok: true });
});

router.post('/api/reading-list/remove', requireUser, async (req, res) => {
  const { value, error } = bookIdSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
  if (error) return res.status(400).json({ error: 'invalid input' });
  const { bookId } = value;
  await User.findByIdAndUpdate(req.session.user.id, { $pull: { reading_list: bookId } });
  res.json({ ok: true });
});

module.exports = router;