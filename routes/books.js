const express = require('express');
const router = express.Router();
const path = require('path');
const Book = require('../models/Book');
const User = require('../models/User');
const { requireUser } = require('../middleware/userAuth');

function resetPeriodIfNeeded(user) {
    const now = new Date();
    const start = user.period_started_at || user.subscription_start;
    if (!start || (now - start) > 30 * 24 * 60 * 60 * 1000) {
        user.period_started_at = now;
        user.read_books_in_period = [];
        user.downloaded_books_in_period = [];
    }
}

function getPlanLimits(plan) {
    if (plan === 'premium') return { maxReads: 100, maxDownloads: 25 };
    if (plan === 'basic') return { maxReads: 10, maxDownloads: 5 };
    return { maxReads: 0, maxDownloads: 0 };
}

async function ensureActiveAndWithinLimits(userId, bookId, type) {
    const user = await User.findById(userId);
    if (!user) return { ok: false, message: 'User not found' };
    if (user.subscription_status !== 'active' || !user.subscription_end || user.subscription_end < new Date()) {
        return { ok: false, message: 'Subscription inactive or expired. Please contact admin to renew.' };
    }
    resetPeriodIfNeeded(user);
    const limits = getPlanLimits(user.subscription_plan);
    if (limits.maxReads === 0 && limits.maxDownloads === 0) {
        return { ok: false, message: 'No active plan. Please subscribe.' };
    }
    if (type === 'read') {
        const already = user.read_books_in_period.some(id => id.equals(bookId));
        if (!already && user.read_books_in_period.length >= limits.maxReads) {
            return { ok: false, message: `Read limit reached for this period.` };
        }
        if (!already) user.read_books_in_period.push(bookId);
    } else if (type === 'download') {
        const already = user.downloaded_books_in_period.some(id => id.equals(bookId));
        if (!already && user.downloaded_books_in_period.length >= limits.maxDownloads) {
            return { ok: false, message: `Download limit reached for this period.` };
        }
        if (!already) user.downloaded_books_in_period.push(bookId);
    }
    await user.save();
    return { ok: true };
}

// Home page - Display all books with search, filter, and pagination
router.get('/', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = 12; // Books per page
        const skip = (page - 1) * limit;
        
        const searchQuery = req.query.search || '';
        const category = req.query.category || '';
        const author = req.query.author || '';
        const sortBy = req.query.sort || 'newest';
        
        // Build query filter
        let filter = {};
        
        if (searchQuery) {
            filter.$text = { $search: searchQuery };
        }
        
        if (category) {
            filter.category = category;
        }
        
        if (author) {
            filter.author = new RegExp(author, 'i');
        }
        
        // Build sort option
        let sortOption = {};
        switch(sortBy) {
            case 'oldest':
                sortOption = { upload_date: 1 };
                break;
            case 'title-asc':
                sortOption = { title: 1 };
                break;
            case 'title-desc':
                sortOption = { title: -1 };
                break;
            case 'author':
                sortOption = { author: 1, title: 1 };
                break;
            case 'newest':
            default:
                sortOption = { upload_date: -1 };
        }
        
        const totalBooks = await Book.countDocuments(filter);
        const totalPages = Math.ceil(totalBooks / limit);
        
        const books = await Book.find(filter)
            .sort(sortOption)
            .skip(skip)
            .limit(limit);
        
        // Get unique categories and authors for filters
        const categories = await Book.distinct('category');
        const authors = await Book.distinct('author');
        
        // Get popular books (most viewed)
        const popularBooks = await Book.find()
            .sort({ view_count: -1 })
            .limit(6);
        
        // Recent uploads (latest 10)
        const recentUploads = await Book.find()
            .sort({ upload_date: -1 })
            .limit(10);

        // Featured banner (latest featured if multiple)
        const featuredBook = await Book.findOne({ featured: true }).sort({ updatedAt: -1 });
        
        // Resolve current user with subscription fields (if logged in)
        let currentUser = null;
        if (req.session && req.session.user) {
          try {
            const u = await User.findById(req.session.user.id).select('name email subscription_plan subscription_status subscription_end');
            if (u) currentUser = { id: u._id, name: u.name, email: u.email, subscription_plan: u.subscription_plan, subscription_status: u.subscription_status, subscription_end: u.subscription_end };
          } catch {}
        }

        res.render('index', { 
            books, 
            currentPage: page,
            totalPages,
            totalBooks,
            searchQuery,
            selectedCategory: category,
            selectedAuthor: author,
            sortBy,
            categories: categories.filter(c => c).sort(),
            authors: authors.filter(a => a).sort(),
            popularBooks,
            recentUploads,
            featuredBook,
            csrfToken: req.csrfToken(),
            currentUser
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Book details page
router.get('/book/:id', async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);
        if (!book) {
            return res.status(404).send('Book not found');
        }
        
        // Get related books (same category or author, excluding current book)
        const relatedBooks = await Book.find({
            _id: { $ne: req.params.id },
            $or: [
                { category: book.category },
                { author: book.author }
            ]
        }).limit(6);
        
        res.render('details', { book, relatedBooks });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Read book page (requires active subscription)
router.get('/read/:id', requireUser, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);
        if (!book) {
            return res.status(404).send('Book not found');
        }
        const gate = await ensureActiveAndWithinLimits(req.session.user.id, book._id, 'read');
        if (!gate.ok) return res.redirect('/?subscribe=1');
        
        // Increment view count
        await Book.findByIdAndUpdate(req.params.id, { $inc: { view_count: 1 } });
        
        res.render('read', { book });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Download book (requires active subscription)
router.get('/download/:id', requireUser, async (req, res) => {
    try {
        const book = await Book.findById(req.params.id);
        if (!book) {
            return res.status(404).send('Book not found');
        }
        const gate = await ensureActiveAndWithinLimits(req.session.user.id, book._id, 'download');
        if (!gate.ok) return res.redirect('/?subscribe=1');
        
        // Increment download count
        await Book.findByIdAndUpdate(req.params.id, { $inc: { download_count: 1 } });
        
        const filePath = path.join(__dirname, '../public', book.pdf_path);
        const fileName = book.title.replace(/[^a-z0-9]/gi, '_') + '.pdf';
        
        res.download(filePath, fileName, (err) => {
            if (err) {
                res.status(500).send('Error downloading file: ' + err.message);
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database error: ' + err.message);
    }
});

// Suggestions API for autocomplete
router.get('/api/suggest', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q || q.length < 2) return res.json([]);
        
        const regex = new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const results = await Book.find({
            $or: [
                { title: regex },
                { author: regex },
                { category: regex },
                { tags: regex }
            ]
        }, { title: 1, author: 1, category: 1 }).limit(8);
        
        res.json(results.map(b => ({
            title: b.title,
            author: b.author,
            category: b.category
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'suggest failed' });
    }
});

module.exports = router;
