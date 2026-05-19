'use strict';

/**
 * Detects queries that require live database data to answer correctly.
 * Used by AssistantOrchestrator to trigger a tool-call retry when the model
 * produces a plain-text answer for a question that must use a tool.
 */

const OPERATIONAL_PATTERNS = [
  /\b(how many|count|number of|total|tell me (how many|the number))\b/i,
  /\b(overdue|past due|late|missed deadline|missed (the )?sla)\b/i,
  /\b(due today|due this week|due (in|within) \d+\s*days?)\b/i,
  /\b(what|which|who|list|show|find|get)\b.{0,60}\b(contract|document|task|workflow|tracker|legal|status|signed|signing|signature)\b/i,
  /\b(unassigned|no owner|not assigned|nobody assigned)\b/i,
  /\b(waiting for|pending (approval|review|input|action) (from|by|of)?|awaiting)\b.{0,60}\b(manager|business|signature|review|approval)\b/i,
  /\b(sla|service level|turnaround time|turnaround)\b/i,
  /\b(workload|overloaded|capacity)\b/i,
  /\b(expired|expires?|expiring|expiry|renewal|past expiry|past expiration)\b.{0,40}\b(contract|contracts|agreement|agreements|soon|today|this week|in \d|next month)\b/i,
  /\b(contract|contracts|agreement|agreements)\b.{0,40}\b(expired|expires?|expiring|expiry|renewal|past expiry|past expiration|next month)\b/i,
  /\b(my tasks?|my contracts?|my documents?|my requests?|assigned to me|tasks for me)\b/i,
  /\b(stuck|stale|no update|no activity|no progress|no movement|blocking)\b/i,
  /\b(ready for signature|sent for signature|awaiting signature|needs? (to be )?signed)\b/i,
  /\b(internal|external)\b.{0,40}\b(sla|legal|turnaround|compliance)\b/i,
  /\b(team workload|who is handling|whos handling|who are handling)\b/i,
  /\b(workflow history|status history|timeline|audit trail)\b.{0,40}\b(workflow|task|tracker)\b/i,
  /\b(notify|notification|inbox|alert)\b.{0,40}\b(unread|new|how many|count)\b/i,
  /\b(contract|document|task|workflow|tracker)\b.{0,60}\b(status|progress|update|current|latest|pending|signed|approved)\b/i,
  /\b(who|which (team member|person|user|staff))\b.{0,60}\b(assigned|overloaded|working on|drafting|managing|handling)\b/i,
  /\b(this (month|quarter|week|year))\b.{0,60}\b(completed|closed|approved|signed|submitted)\b/i,
  /\b(legal team|legal teams|legal department)\b.{0,80}\b(progress|performance|doing|completed|submitted|overdue|sla)\b/i,
  /\b(tasks?|work)\b.{0,50}\b(in|linked to|for)\b.{0,30}\b(workflows?|tracker)\b/i,
  /\b(documents?|files?)\b.{0,50}\b(expired|expiry|expires?|signed|unsigned|uploaded|awaiting signature|pending signature)\b/i,
  /\b(what changed recently|dashboard summary|system summary|app summary|contract health|signing summary|department summary)\b/i,
  // Contract intelligence: value, type, counterparty, renewal, missing signed copy, health
  /\b(total value|contract value|value of contracts?|contracts? worth|highest value|high.?value)\b/i,
  /\b(loan agreements?|grant agreements?|service provider agreements?|software licen[cs]es?|lease agreements?|compliance documents?|partnership mou)\b/i,
  /\b(contracts?|agreements?)\b.{0,50}\b(by department|by counterparty|by type|no owner|without owner|missing signed|missing signature|no signed copy|renewal candidate|need renewal|needs renewal)\b/i,
  /\b(contract management summary|contract health|contract register|overall contract status|contract overview)\b/i,
  /\b(contracts?|agreements?)\s+(with|for|involving)\s+\w/i,
  /\b(contracts?|agreements?)\b.{0,60}\b(active|draft|approved|under\s+review|pending\s+approval|terminated|cancelled|pending\s+signature)\b/i,
  /\b(which|show|list|find|how many)\b.{0,40}\b(loan|grant|nda|msa|sow|moa|mou|vendor|employment|lease)\b.{0,30}\b(contract|agreement)\b/i,
  /\b(tracker tasks?|tracker rows?|workflow tasks?|manual workflow tasks?)\b/i,
];

/**
 * Returns true if the message is likely asking for live operational data
 * that cannot be answered reliably without a tool call.
 */
const isOperationalQuery = (message) => {
  const text = String(message || '');
  return OPERATIONAL_PATTERNS.some((pattern) => pattern.test(text));
};

module.exports = { isOperationalQuery };
