'use strict';
const express  = require('express');
const AuditLog = require('../models/AuditLog');
const { protect } = require('../middleware/auth');
const { safeUserFields } = require('../ai/security/FieldFilter');

const router = express.Router();

router.use(protect);

const canViewAiAudit = (user) => ['admin', 'manager'].includes(user?.role);

// GET /api/ai/audit — paginated AI activity log for admin/manager
router.get('/', async (req, res) => {
  try {
    if (!canViewAiAudit(req.user)) {
      return res.status(403).json({ error: 'Access denied. Admins and managers only.' });
    }

    const {
      from,
      to,
      userId,
      toolName,
      result: resultFilter,
      eventType,
      page  = '1',
      limit = '50',
    } = req.query;

    // All AI entries use action prefixes 'AI tool:', 'AI security:', or 'AI RAG:'
    const filter = { action: /^AI (tool|security|RAG):/ };

    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(String(from));
      if (to)   filter.createdAt.$lte = new Date(String(to));
    }
    if (userId)      filter.performedBy          = String(userId);
    if (resultFilter) filter.result               = String(resultFilter);
    if (toolName)    filter['metadata.toolName']  = String(toolName);
    if (eventType)   filter['metadata.eventType'] = String(eventType);

    const pageNum  = Math.max(1, parseInt(page,  10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip     = (pageNum - 1) * limitNum;

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('performedBy', 'name email role')
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    const sanitized = entries.map((e) => ({
      _id:        e._id,
      createdAt:  e.createdAt,
      action:     e.action,
      result:     e.result,
      errorMessage: e.errorMessage || null,
      performedBy: e.performedBy
        ? safeUserFields(e.performedBy, req.user)
        : { email: e.performedByEmail || null },
      // Only expose safe metadata keys — never full args or RAG snippets
      metadata: {
        toolName:    e.metadata?.toolName    || null,
        resultType:  e.metadata?.resultType  || null,
        eventType:   e.metadata?.eventType   || null,
        sourceType:  e.metadata?.sourceType  || null,
        retrievedCount: e.metadata?.retrievedCount ?? null,
        blockedCount: e.metadata?.blockedCount ?? null,
        securityFlags: e.metadata?.securityFlags || [],
        riskLevel:   e.metadata?.riskLevel   || null,
        reason:      e.metadata?.reason      || null,
      },
    }));

    res.json({
      entries: sanitized,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
