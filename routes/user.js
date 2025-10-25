const express = require('express');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const User = require('../models/User');
const SubscriptionRequest = require('../models/SubscriptionRequest');

const { requireUser } = require('../middleware/userAuth');

const router = express.Router();

const bookIdSchema = Joi.object({
  bookId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).required()
});

const registerSchema = Joi.object({
  name: Joi.string().trim().max(120).allow('', null),
  email: Joi.string().email().required(),
  phone: Joi.string().trim().allow('', null),
  password: Joi.string().min(6).max(128).required()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).max(128).required(),
  next: Joi.string().allow('', null)
});

// Register page
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('user/register', { error: null, csrfToken: req.csrfToken() });
});

router.post('/register', async (req, res) => {
  try {
    const { value, error } = registerSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).render('user/register', { error: 'Invalid input' });
    const { name, email, phone, password } = value;
    if (!email || !password) return res.status(400).send('Email and password are required');
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) return res.status(400).render('user/register', { error: 'Email already in use' });
    const password_hash = bcrypt.hashSync(password, 10);
    const user = await User.create({ name, email: email.toLowerCase(), phone: phone || '', password_hash });
    req.session.user = { id: user._id.toString(), name: user.name, email: user.email };
    res.redirect('/');
  } catch (e) {
    console.error(e);
    res.status(500).render('user/register', { error: 'Registration failed' });
  }
});

// Login page
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('user/login', { error: null, next: req.query.next || '' });
});

router.post('/login', async (req, res) => {
  try {
    const { value, error } = loginSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).render('user/login', { error: 'Invalid input', next: req.body.next || '' });
    const { email, password, next } = value;
    const user = await User.findOne({ email: (email||'').toLowerCase() });
    if (!user) return res.status(400).render('user/login', { error: 'Invalid credentials', next: next || '' });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(400).render('user/login', { error: 'Invalid credentials', next: next || '' });
    req.session.user = { id: user._id.toString(), name: user.name, email: user.email };
    res.redirect(next || '/');
  } catch (e) {
    console.error(e);
    res.status(500).render('user/login', { error: 'Login failed', next: '' });
  }
});

router.get('/logout', (req, res) => {
  req.session.user = null;
  res.redirect('/');
});

// Me API
router.get('/me', (req, res) => {
  res.json(req.session.user || null);
});

// Request subscription (internal form instead of mailto)
router.post('/subscribe-request', requireUser, async (req, res) => {
  try {
    const { value, error } = Joi.object({ plan: Joi.string().valid('basic','premium').required(), note: Joi.string().allow('', null) }).validate(req.body, { abortEarly:false, stripUnknown:true });
    if (error) return res.status(400).json({ error: 'invalid input' });
    const userId = req.session.user.id;
    // If there is an existing pending request for same user+plan, just return ok
    const exists = await SubscriptionRequest.findOne({ user: userId, plan: value.plan, status: 'pending' });
    if (exists) return res.json({ ok: true, pending: true, id: exists._id });
    const doc = await SubscriptionRequest.create({ user: userId, plan: value.plan, note: value.note || '' });
    return res.status(201).json({ ok: true, id: doc._id });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'failed' }); }
});

// Favorites: list
router.get('/favorites', requireUser, async (req, res) => {
  try {
    const full = req.query.full === '1';
    const user = await User.findById(req.session.user.id).select('favorites').populate(full ? { path: 'favorites' } : null);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (full) return res.json(user.favorites || []);
    return res.json((user.favorites || []).map(id => id.toString()));
  } catch (e) { console.error(e); res.status(500).json({ error: 'failed' }); }
});

// Favorites: toggle add/remove
router.post('/favorites/toggle', requireUser, async (req, res) => {
  try {
    const { value, error } = bookIdSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'invalid input' });
    const { bookId } = value;
    const user = await User.findById(req.session.user.id).select('favorites');
    if (!user) return res.status(404).json({ error: 'user not found' });
    const exists = (user.favorites || []).some(id => id.toString() === bookId);
    if (exists) {
      await User.findByIdAndUpdate(req.session.user.id, { $pull: { favorites: bookId } });
      return res.json({ ok: true, favorited: false });
    } else {
      await User.findByIdAndUpdate(req.session.user.id, { $addToSet: { favorites: bookId } });
      return res.json({ ok: true, favorited: true });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: 'failed' }); }
});

// Reading progress: get per book
router.get('/progress/:bookId', requireUser, async (req, res) => {
  try {
    const bookId = req.params.bookId;
    const user = await User.findById(req.session.user.id).select('reading_progress');
    if (!user) return res.status(404).json({ error: 'user not found' });
    const prog = (user.reading_progress || []).find(p => p.book && p.book.toString() === bookId);
    if (!prog) return res.json({ page: 1, scale: 1.2 });
    return res.json({ page: prog.page || 1, scale: prog.scale || 1.2, updated_at: prog.updated_at });
  } catch (e) { console.error(e); res.status(500).json({ error: 'failed' }); }
});

// Reading progress: set
router.post('/progress', requireUser, async (req, res) => {
  try {
    const { value, error } = Joi.object({ bookId: bookIdSchema.extract('bookId'), page: Joi.number().min(1).required(), scale: Joi.number().min(0.3).max(5).required() }).validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'invalid input' });
    const { bookId, page, scale } = value;
    await User.updateOne(
      { _id: req.session.user.id, 'reading_progress.book': bookId },
      { $set: { 'reading_progress.$.page': page, 'reading_progress.$.scale': scale, 'reading_progress.$.updated_at': new Date() } }
    );
    // If not matched, push new
    const user = await User.findById(req.session.user.id).select('reading_progress');
    const exists = (user.reading_progress || []).some(p => p.book && p.book.toString() === bookId);
    if (!exists) {
      await User.findByIdAndUpdate(req.session.user.id, { $addToSet: { reading_progress: { book: bookId, page, scale, updated_at: new Date() } } });
    }
    return res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'failed' }); }
});

module.exports = router;