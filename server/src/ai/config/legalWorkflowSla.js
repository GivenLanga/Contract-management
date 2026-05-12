/**
 * Central SLA configuration for the legal workflow.
 * Import this wherever SLA thresholds are needed — AI tools, dashboard APIs,
 * deadline monitors, reminder services — so the numbers live in one place.
 */
module.exports = {
  /** Calendar days from submission for internal requests to be completed. */
  INTERNAL_TURNAROUND_DAYS: 4,

  /** Calendar days from submission for external requests to be completed OR sent for signature. */
  EXTERNAL_TURNAROUND_DAYS: 7,

  /** Requests with no status change in this many days are flagged as stale. */
  NO_UPDATE_THRESHOLD_DAYS: 3,

  /** Days after signatureEmailSentAt to send a signature reminder. */
  SIGNATURE_REMINDER_DAYS: 2,

  /** Days after signatureEmailSentAt to escalate the signature request. */
  SIGNATURE_ESCALATION_DAYS: 4,

  /** Days after submission with no assignedTo before escalating as unassigned. */
  UNASSIGNED_ESCALATION_DAYS: 1,
};
