const User = require('../models/User');

function requireUser(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/user/login?next=' + encodeURIComponent(req.originalUrl || '/'));
}

async function setUserLocals(req, res, next) {
  try {
    if (req.session && req.session.user) {
      const u = await User.findById(req.session.user.id).select('name email subscription_plan subscription_status subscription_end');
      res.locals.currentUser = u ? {
        id: u._id.toString(),
        name: u.name,
        email: u.email,
        subscription_plan: u.subscription_plan,
        subscription_status: u.subscription_status,
        subscription_end: u.subscription_end
      } : null;
    } else {
      res.locals.currentUser = null;
    }
  } catch (_) {
    res.locals.currentUser = req.session && req.session.user ? req.session.user : null;
  }
  next();
}

module.exports = { requireUser, setUserLocals };