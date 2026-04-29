const express = require('express');
const aiService = require('../services/aiService');
const AuditLog = require('../models/AuditLog');
const { protect } = require('../middleware/auth');

const router = express.Router();

// POST /api/ai/query — natural language document navigation
router.post('/query', protect, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || query.trim().length < 3) {
      return res.status(400).json({ error: 'Query must be at least 3 characters.' });
    }

    const result = await aiService.processQuery(query.trim(), req.user._id);

    await AuditLog.create({
      action: `AI query: "${query.slice(0, 80)}"`,
      category: 'system',
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      metadata: { intent: result.intent, resultCount: result.documents.length },
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ai/suggestions — quick suggestion chips
router.get('/suggestions', protect, (req, res) => {
  res.json({
    suggestions: [
      'Open the MOI document in the legal folder',
      'Find the NDA for Apex Technologies',
      'Show contracts expiring this month',
      'List all documents pending signature',
      'Find clause 5 in the MSA agreement',
      'Show my assigned tasks',
    ],
  });
});

module.exports = router;
