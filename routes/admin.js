const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const rateLimit = require('express-rate-limit');
const Book = require('../models/Book');
const User = require('../models/User');
const SubscriptionRequest = require('../models/SubscriptionRequest');
const { requireAuth } = require('../middleware/auth');

const adminSubLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// Subscription Requests page (protected)
router.get('/requests', requireAuth, (req, res) => {
    res.render('admin/requests', { csrfToken: req.csrfToken() });
});

// API: list subscription requests (protected)
router.get('/api/subscription-requests', requireAuth, async (req, res) => {
    try {
        const status = (req.query.status || 'pending');
        const query = {};
        if (['pending','processed'].includes(status)) query.status = status;
        const items = await SubscriptionRequest.find(query)
          .sort({ createdAt: -1 })
          .populate({ path: 'user', select: 'name email phone createdAt subscription_status subscription_plan subscription_end' });
        // Deduplicate by user+plan+status, keep latest (sorted desc already)
        const seen = new Set();
        const unique = [];
        for (const r of items) {
          const key = `${r.user?._id || 'nouser'}|${r.plan}|${r.status}`;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(r);
        }
        res.json(unique.map(r => ({
          id: r._id,
          plan: r.plan,
          status: r.status,
          createdAt: r.createdAt,
          processed_at: r.processed_at || null,
          user: r.user ? { id: r.user._id, name: r.user.name, email: r.user.email, phone: r.user.phone, subscription_status: r.user.subscription_status, subscription_plan: r.user.subscription_plan, subscription_end: r.user.subscription_end } : null,
          note: r.note || ''
        })));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'failed' });
    }
});

// Approve request: grant 30 days and mark processed (protected)
router.post('/requests/:id/approve', requireAuth, adminSubLimiter, async (req, res) => {
    try {
        const reqDoc = await SubscriptionRequest.findById(req.params.id);
        if (!reqDoc) return res.status(404).json({ error: 'not found' });
        if (reqDoc.status === 'processed') return res.status(400).json({ error: 'already processed' });
        const user = await User.findById(reqDoc.user);
        if (!user) return res.status(404).json({ error: 'user not found' });
        const now = new Date();
        const end = new Date(now.getTime() + 30*24*60*60*1000);
        user.subscription_plan = reqDoc.plan;
        user.subscription_status = 'active';
        user.subscription_start = now;
        user.subscription_end = end;
        user.period_started_at = now;
        user.read_books_in_period = [];
        user.downloaded_books_in_period = [];
        await user.save();
        reqDoc.status = 'processed';
        reqDoc.processed_at = new Date();
        await reqDoc.save();
        return res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'failed' });
    }
});

// Mark processed without granting (protected)
router.post('/requests/:id/mark-processed', requireAuth, async (req, res) => {
    try {
        const reqDoc = await SubscriptionRequest.findById(req.params.id);
        if (!reqDoc) return res.status(404).json({ error: 'not found' });
        if (reqDoc.status === 'processed') return res.json({ ok: true });
        reqDoc.status = 'processed';
        reqDoc.processed_at = new Date();
        await reqDoc.save();
        return res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'failed' });
    }
});

const bookUploadSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  author: Joi.string().trim().max(200).required(),
  category: Joi.string().trim().max(100).required(),
  description: Joi.string().trim().allow('', null).max(2000),
  tags: Joi.string().trim().allow('', null),
  is_premium: Joi.string().valid('on').allow('', null), // checkbox
  featured: Joi.string().valid('on').allow('', null),
  featured_tagline: Joi.string().trim().allow('', null).max(200)
});

const bookEditSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  author: Joi.string().trim().max(200).allow('', null),
  category: Joi.string().trim().max(100).allow('', null),
  description: Joi.string().trim().allow('', null).max(2000),
  tags: Joi.string().trim().allow('', null),
  is_premium: Joi.string().valid('on').allow('', null),
  featured: Joi.string().valid('on').allow('', null),
  featured_tagline: Joi.string().trim().allow('', null).max(200)
});

// String similarity function for duplicate detection
function calculateSimilarity(str1, str2) {
    if (str1 === str2) return 1;
    if (str1.length < 2 || str2.length < 2) return 0;
    
    // Create character pairs
    const pairs1 = [];
    const pairs2 = [];
    
    for (let i = 0; i < str1.length - 1; i++) {
        pairs1.push(str1.substring(i, i + 2));
    }
    
    for (let i = 0; i < str2.length - 1; i++) {
        pairs2.push(str2.substring(i, i + 2));
    }
    
    // Calculate intersection
    let intersection = 0;
    for (let i = 0; i < pairs1.length; i++) {
        for (let j = 0; j < pairs2.length; j++) {
            if (pairs1[i] === pairs2[j]) {
                intersection++;
                pairs2.splice(j, 1);
                break;
            }
        }
    }
    
    return (2 * intersection) / (pairs1.length + pairs2.length);
}

// Admin credentials from environment variables
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 10);

// Login page
router.get('/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.render('admin/login', { error: null });
});

// Handle login
router.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
        req.session.isAdmin = true;
        return res.redirect('/admin');
    }
    
    res.render('admin/login', { error: 'Invalid username or password' });
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect('/admin/login');
    });
});

// Admin dashboard page (protected)
router.get('/', requireAuth, (req, res) => {
    res.render('admin/dashboard', { csrfToken: req.csrfToken(), success: req.query.success, updated: req.query.updated });
});

// Upload book page (protected)
router.get('/upload', requireAuth, (req, res) => {
    res.render('admin/upload', { csrfToken: req.csrfToken() });
});

// Handle book upload (protected)
router.post('/upload', requireAuth, async (req, res) => {
    if (!req.files || !req.files.pdf || !req.files.thumbnail) {
        return res.status(400).send('Please upload both PDF and thumbnail image');
    }

    const { value, error } = bookUploadSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).send('Invalid input');

    const { title, author, category, description, tags } = value;
    const pdfFile = req.files.pdf;
    const thumbnailFile = req.files.thumbnail;

    // Check for duplicate titles (case-insensitive, fuzzy matching)
    try {
        const existingBooks = await Book.find({});
        const duplicates = existingBooks.filter(book => {
            const similarity = calculateSimilarity(title.toLowerCase(), book.title.toLowerCase());
            return similarity > 0.8; // 80% similarity threshold
        });

        if (duplicates.length > 0) {
            const duplicateList = duplicates.map(book => `"${book.title}" by ${book.author || 'Unknown'}`).join(', ');
            return res.status(409).send(`⚠️ Possible duplicate detected! Similar book(s) already exist: ${duplicateList}. If this is a different book, please modify the title slightly and try again.`);
        }
    } catch (err) {
        console.error('Error checking for duplicates:', err);
        // Continue with upload if duplicate check fails
    }
    
    // Process tags - convert comma-separated string to array
    let tagsArray = [];
    if (tags && tags.trim()) {
        tagsArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
    }

    // Validate file types
    if (!pdfFile.name.endsWith('.pdf')) {
        return res.status(400).send('Please upload a valid PDF file');
    }

    if (!thumbnailFile.mimetype.startsWith('image/')) {
        return res.status(400).send('Please upload a valid image file');
    }

    // Generate unique filenames
    const timestamp = Date.now();
    const pdfFileName = `${timestamp}_${pdfFile.name}`;
    const thumbnailFileName = `${timestamp}_${thumbnailFile.name}`;

    const pdfPath = path.join(__dirname, '../public/uploads/books', pdfFileName);
    const thumbnailPath = path.join(__dirname, '../public/uploads/thumbnails', thumbnailFileName);

    // Save files
    pdfFile.mv(pdfPath, (err) => {
        if (err) {
            return res.status(500).send('Error uploading PDF: ' + err);
        }

        thumbnailFile.mv(thumbnailPath, async (err) => {
            if (err) {
                return res.status(500).send('Error uploading thumbnail: ' + err);
            }

            // Save to database
            try {
                const dbPdfPath = `/uploads/books/${pdfFileName}`;
                const dbThumbnailPath = `/uploads/thumbnails/${thumbnailFileName}`;

                const newBook = new Book({
                    title,
                    author,
                    category,
                    tags: tagsArray,
                    description,
                    is_premium: req.body.is_premium === 'on',
                    featured: req.body.featured === 'on',
                    featured_tagline: req.body.featured_tagline || '',
                    pdf_path: dbPdfPath,
                    thumbnail_path: dbThumbnailPath
                });

                await newBook.save();
                // If featured, unset others
                if (newBook.featured) {
                    await Book.updateMany({ _id: { $ne: newBook._id } }, { $set: { featured: false } });
                }
                res.redirect('/admin?success=1');
            } catch (err) {
                console.error(err);
                res.status(500).send('Database error: ' + err.message);
            }
        });
    });
});

// Get all books for admin (protected)
router.get('/books', requireAuth, async (req, res) => {
    try {
        const books = await Book.find().sort({ upload_date: -1 });
        res.json(books);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Edit book page (protected)
router.get('/edit/:id', requireAuth, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);
        if (!book) {
            return res.status(404).send('Book not found');
        }
        res.render('admin/edit', { book, csrfToken: req.csrfToken() });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Update book (protected)
router.post('/edit/:id', requireAuth, async (req, res) => {
    try {
        const { value, error } = bookEditSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
        if (error) return res.status(400).send('Invalid input');
        const { title, author, category, description, tags } = value;
        
        // Process tags
        let tagsArray = [];
        if (tags && tags.trim()) {
            tagsArray = tags.split(',').map(tag => tag.trim()).filter(tag => tag);
        }
        
        const updateData = {
            title,
            author,
            category,
            tags: tagsArray,
            description,
            is_premium: req.body.is_premium === 'on',
            featured: req.body.featured === 'on',
            featured_tagline: req.body.featured_tagline || ''
        };
        
        const updated = await Book.findByIdAndUpdate(req.params.id, updateData, { new: true });
        if (updated && updated.featured) {
            await Book.updateMany({ _id: { $ne: updated._id } }, { $set: { featured: false } });
        }
        res.redirect('/admin?updated=1');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Delete book (protected)
router.delete('/books/:id', requireAuth, async (req, res) => {
    try {
        await Book.findByIdAndDelete(req.params.id);
        res.json({ message: 'Book deleted successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Bulk delete books (protected)
router.post('/books/bulk-delete', requireAuth, async (req, res) => {
    try {
        const { bookIds } = req.body;
        if (!bookIds || !Array.isArray(bookIds) || bookIds.length === 0) {
            return res.status(400).json({ error: 'No books selected' });
        }
        
        await Book.deleteMany({ _id: { $in: bookIds } });
        res.json({ message: `${bookIds.length} book(s) deleted successfully` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// User lookup by email for subscriptions panel (protected)
router.get('/users/find', requireAuth, async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'provide email' });
    const user = await User.findOne({ email }).select('name email subscription_plan subscription_status subscription_end read_books_in_period downloaded_books_in_period createdAt');
    if (!user) return res.status(404).json({ error: 'not found' });
    return res.json({
      id: user._id,
      name: user.name,
      email: user.email,
      subscription_plan: user.subscription_plan || 'none',
      subscription_status: user.subscription_status || 'none',
      subscription_end: user.subscription_end || null,
      reads_used: Array.isArray(user.read_books_in_period) ? user.read_books_in_period.length : 0,
      downloads_used: Array.isArray(user.downloaded_books_in_period) ? user.downloaded_books_in_period.length : 0,
      createdAt: user.createdAt
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed' });
  }
});

// Users list with search/sort/pagination (protected)
router.get('/users', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const search = (req.query.search || '').trim();
    const sortField = (req.query.sort || 'createdAt');
    const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;

    const query = {};
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ email: rx }, { name: rx }];
    }

    const total = await User.countDocuments(query);
    const items = await User.find(query)
      .select('name email phone subscription_plan subscription_status subscription_end createdAt')
      .sort({ [sortField]: order })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({ items, total, page, limit });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'failed' });
  }
});

// Bulk subscription grant/cancel (protected)
router.post('/users/bulk/subscription', requireAuth, adminSubLimiter, async (req, res) => {
  try {
    const { ids, action, plan } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'no ids' });

    if (action === 'cancel') {
      await User.updateMany({ _id: { $in: ids } }, {
        $set: { subscription_status: 'expired', subscription_plan: 'none', subscription_end: new Date() }
      });
      return res.json({ ok: true, count: ids.length });
    }

    if (action === 'grant') {
      if (!['basic','premium'].includes(plan)) return res.status(400).json({ error: 'invalid plan' });
      const now = new Date();
      const end = new Date(now.getTime() + 30*24*60*60*1000);
      await User.updateMany({ _id: { $in: ids } }, {
        $set: {
          subscription_plan: plan,
          subscription_status: 'active',
          subscription_start: now,
          subscription_end: end,
          period_started_at: now,
          read_books_in_period: [],
          downloaded_books_in_period: []
        }
      });
      return res.json({ ok: true, count: ids.length });
    }

    return res.status(400).json({ error: 'invalid action' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed' });
  }
});

// --- Subscription management (mock) ---
const subGrantSchema = Joi.object({ plan: Joi.string().valid('basic','premium').required() });
const createUserSchema = Joi.object({
  name: Joi.string().trim().max(120).allow('', null),
  email: Joi.string().email().required(),
  phone: Joi.string().trim().allow('', null)
});

router.post('/users/:id/subscription', requireAuth, adminSubLimiter, async (req, res) => {
    try {
        const { value, error } = subGrantSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
        if (error) return res.status(400).json({ error: 'invalid input' });
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'user not found' });
        const now = new Date();
        const end = new Date(now.getTime() + 30*24*60*60*1000);
        user.subscription_plan = value.plan;
        user.subscription_status = 'active';
        user.subscription_start = now;
        user.subscription_end = end;
        user.period_started_at = now;
        user.read_books_in_period = [];
        user.downloaded_books_in_period = [];
        await user.save();
        return res.json({ ok: true, user: { id: user._id, plan: user.subscription_plan, end: user.subscription_end } });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'failed' });
    }
});

// Create user (protected)
router.post('/users', requireAuth, adminSubLimiter, async (req, res) => {
    try {
        const { value, error } = createUserSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
        if (error) return res.status(400).json({ error: 'invalid input' });
        const email = value.email.toLowerCase();
        const existing = await User.findOne({ email });
        if (existing) return res.status(409).json({ error: 'user exists' });
        const tempPassword = Math.random().toString(36).slice(-8) + Math.floor(1000+Math.random()*9000);
        const password_hash = bcrypt.hashSync(String(tempPassword), 10);
        const user = await User.create({ name: value.name || '', email, phone: value.phone || '', password_hash });
        return res.status(201).json({
            ok: true,
            user: { id: user._id, name: user.name, email: user.email },
            tempPassword
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'failed' });
    }
});

router.post('/users/:id/subscription/cancel', requireAuth, adminSubLimiter, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'user not found' });
        user.subscription_status = 'expired';
        user.subscription_plan = 'none';
        user.subscription_end = new Date();
        await user.save();
        return res.json({ ok: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'failed' });
    }
});

router.get('/analytics', requireAuth, async (req, res) => {
    try {
        // Get basic stats
        const totalBooks = await Book.countDocuments();
        const totalViews = await Book.aggregate([{ $group: { _id: null, total: { $sum: '$view_count' } } }]);
        const totalDownloads = await Book.aggregate([{ $group: { _id: null, total: { $sum: '$download_count' } } }]);
        
        // Get most popular books
        const mostViewed = await Book.find().sort({ view_count: -1 }).limit(10);
        const mostDownloaded = await Book.find().sort({ download_count: -1 }).limit(10);
        
        // Get recent uploads
        const recentBooks = await Book.find().sort({ upload_date: -1 }).limit(10);
        
        // Category distribution
        const categoryStats = await Book.aggregate([
            { $group: { _id: '$category', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);
        
        // Monthly upload trends (last 12 months)
        const twelveMonthsAgo = new Date();
        twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
        
        const monthlyUploads = await Book.aggregate([
            { $match: { upload_date: { $gte: twelveMonthsAgo } } },
            {
                $group: {
                    _id: {
                        year: { $year: '$upload_date' },
                        month: { $month: '$upload_date' }
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.year': 1, '_id.month': 1 } }
        ]);
        
        res.render('admin/analytics', {
            totalBooks,
            totalViews: totalViews[0]?.total || 0,
            totalDownloads: totalDownloads[0]?.total || 0,
            mostViewed,
            mostDownloaded,
            recentBooks,
            categoryStats,
            monthlyUploads
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Export books data (protected)
router.get('/export/:format', requireAuth, async (req, res) => {
    try {
        const format = req.params.format;
        const books = await Book.find().sort({ upload_date: -1 });
        
        if (format === 'json') {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="books.json"');
            res.send(JSON.stringify(books, null, 2));
        } else if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="books.csv"');
            
            // CSV headers
            let csv = 'ID,Title,Author,Category,Tags,Description,Views,Downloads,Upload Date,PDF Path,Thumbnail Path\n';
            
            // CSV data
            books.forEach(book => {
                const tags = book.tags ? book.tags.join(';') : '';
                const description = book.description ? book.description.replace(/"/g, '""') : '';
                const uploadDate = new Date(book.upload_date).toISOString().split('T')[0];
                
                csv += `"${book._id}","${book.title}","${book.author || ''}","${book.category || ''}","${tags}","${description}",${book.view_count || 0},${book.download_count || 0},"${uploadDate}","${book.pdf_path}","${book.thumbnail_path}"\n`;
            });
            
            res.send(csv);
        } else {
            res.status(400).send('Invalid format. Use json or csv.');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Export error: ' + err.message);
    }
});

module.exports = router;
