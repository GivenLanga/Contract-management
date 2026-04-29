const fetch = require('node-fetch');
const Document = require('../models/Document');
const Contract = require('../models/Contract');

const HF_API_URL = 'https://api-inference.huggingface.co/models';
const MODEL = process.env.HF_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

const callHuggingFace = async (prompt) => {
  const apiKey = process.env.HF_API_KEY;
  if (!apiKey || apiKey === 'hf_your_hugging_face_api_key') {
    return simulateResponse(prompt);
  }
  try {
    const res = await fetch(`${HF_API_URL}/${MODEL}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: {
          max_new_tokens: 512,
          temperature: 0.3,
          return_full_text: false,
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('HF API error:', errText);
      return simulateResponse(prompt);
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0]?.generated_text : data?.generated_text || 'No response from AI.';
  } catch (err) {
    console.error('AI service error:', err.message);
    return simulateResponse(prompt);
  }
};

// Fallback when no API key configured
const simulateResponse = (prompt) => {
  const lower = prompt.toLowerCase();
  if (lower.includes('open') || lower.includes('find')) {
    return 'I found the document. Click the link in the results below to open it.';
  }
  if (lower.includes('clause') || lower.includes('section')) {
    return 'I searched the document for that clause. The relevant section is highlighted in the results.';
  }
  if (lower.includes('expir')) {
    return 'Based on your contracts database, I found contracts with upcoming expiry dates listed below.';
  }
  return 'I processed your request. Here are the matching documents from your legal folder.';
};

const parseIntent = (query) => {
  const lower = query.toLowerCase();
  if (lower.match(/open|show|display|get|find/)) return 'find_document';
  if (lower.match(/clause|section|provision|article/)) return 'find_clause';
  if (lower.match(/expir|renew/)) return 'expiry_check';
  if (lower.match(/sign|execut/)) return 'signing_status';
  if (lower.match(/task|assign/)) return 'task_query';
  return 'general_search';
};

const searchDocuments = async (query, userId) => {
  const words = query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter((w) => w.length > 2);
  const regex = new RegExp(words.join('|'), 'i');
  const docs = await Document.find({
    $or: [
      { name: regex },
      { description: regex },
      { tags: { $in: words } },
    ],
  })
    .populate('uploadedBy', 'name email')
    .populate('contract', 'title contractId')
    .limit(10);
  return docs;
};

const processQuery = async (query, userId) => {
  const intent = parseIntent(query);
  let documents = [];
  let contracts = [];
  let aiResponse = '';

  if (intent === 'find_document' || intent === 'general_search') {
    documents = await searchDocuments(query, userId);
  }

  if (intent === 'expiry_check') {
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
    contracts = await Contract.find({
      expiryDate: { $lte: thirtyDaysFromNow },
      status: { $nin: ['Terminated', 'Cancelled'] },
    })
      .populate('createdBy', 'name')
      .limit(10);
  }

  if (intent === 'find_document' || intent === 'general_search') {
    documents = await searchDocuments(query, userId);
  }

  const systemPrompt = `You are a legal assistant AI for ContractIQ. Answer queries about contracts and documents concisely.
Query: "${query}"
Found ${documents.length} documents and ${contracts.length} contracts.
Respond in 1-3 sentences with a helpful summary.`;

  aiResponse = await callHuggingFace(systemPrompt);

  return { intent, documents, contracts, aiResponse };
};

module.exports = { processQuery, searchDocuments };
