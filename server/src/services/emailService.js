const nodemailer = require('nodemailer');

const createTransport = () =>
  nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

const baseTemplate = (content, title) => `
<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body{font-family:Arial,sans-serif;background:#f4f6f9;margin:0;padding:0}
  .wrapper{max-width:600px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .header{background:#1a2744;padding:24px 32px;color:#fff}
  .header h1{margin:0;font-size:22px;font-weight:700}
  .header p{margin:4px 0 0;opacity:.8;font-size:14px}
  .body{padding:32px}
  .body h2{color:#1a2744;margin-top:0}
  .btn{display:inline-block;padding:12px 28px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin:16px 0}
  .footer{background:#f4f6f9;padding:16px 32px;font-size:12px;color:#666;text-align:center}
  .meta{background:#f8fafc;border-left:4px solid #2563eb;padding:12px 16px;margin:16px 0;border-radius:0 6px 6px 0}
  .meta p{margin:4px 0;font-size:14px;color:#444}
</style></head>
<body><div class="wrapper">
  <div class="header"><h1>⚖ ContractIQ</h1><p>Legal Contract Management System</p></div>
  <div class="body"><h2>${title}</h2>${content}</div>
  <div class="footer">© ${new Date().getFullYear()} ContractIQ. This is an automated message — please do not reply.</div>
</div></body></html>`;

const send = async (to, subject, html) => {
  if (!process.env.SMTP_USER || process.env.SMTP_USER === 'your-email@gmail.com') {
    console.log(`[EMAIL MOCK] To: ${to} | Subject: ${subject}`);
    return { messageId: 'mock-' + Date.now() };
  }
  const transporter = createTransport();
  return transporter.sendMail({
    from: process.env.EMAIL_FROM || '"ContractIQ" <noreply@contractiq.com>',
    to,
    subject,
    html,
  });
};

const sendTaskAssignment = async (user, task, assigner) => {
  const html = baseTemplate(`
    <p>Hi <strong>${user.name}</strong>,</p>
    <p>You have been assigned a new task by <strong>${assigner.name}</strong>.</p>
    <div class="meta">
      <p><strong>Task:</strong> ${task.title}</p>
      <p><strong>Type:</strong> ${task.type}</p>
      <p><strong>Priority:</strong> ${task.priority}</p>
      <p><strong>Deadline:</strong> ${new Date(task.deadline).toLocaleDateString('en-US', { dateStyle: 'full' })}</p>
      ${task.description ? `<p><strong>Notes:</strong> ${task.description}</p>` : ''}
    </div>
    <p>Please log in to ContractIQ to view the task details and get started.</p>
  `, 'New Task Assigned');
  return send(user.email, `Task Assigned: ${task.title}`, html);
};

const sendTaskCompletion = async (manager, task, completedBy) => {
  const html = baseTemplate(`
    <p>Hi <strong>${manager.name}</strong>,</p>
    <p><strong>${completedBy.name}</strong> has completed a task.</p>
    <div class="meta">
      <p><strong>Task:</strong> ${task.title}</p>
      <p><strong>Completed by:</strong> ${completedBy.name}</p>
      <p><strong>Completed at:</strong> ${new Date(task.completedAt || Date.now()).toLocaleString()}</p>
      ${task.progressNote ? `<p><strong>Note:</strong> ${task.progressNote}</p>` : ''}
    </div>
  `, 'Task Completed');
  return send(manager.email, `Task Completed: ${task.title}`, html);
};

const sendDocumentUpload = async (recipients, document, uploader) => {
  const html = baseTemplate(`
    <p>A new document has been uploaded by <strong>${uploader.name}</strong>.</p>
    <div class="meta">
      <p><strong>Document:</strong> ${document.name}</p>
      <p><strong>Type:</strong> ${document.type.toUpperCase()}</p>
      <p><strong>Uploaded:</strong> ${new Date().toLocaleString()}</p>
    </div>
    <p>Log in to ContractIQ to review the document.</p>
  `, 'New Document Uploaded');
  const jobs = recipients.map((r) => send(r.email, `Document Uploaded: ${document.name}`, html));
  return Promise.allSettled(jobs);
};

const sendSigningRequest = async (signer, document, requestedBy, signerToken) => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const signingLink = signerToken
    ? `${appUrl}/sign/external/${signerToken}`
    : `${appUrl}/signing`;
  const html = baseTemplate(`
    <p>Hi <strong>${signer.name || signer.email}</strong>,</p>
    <p>Your signature is required on the following document.</p>
    <div class="meta">
      <p><strong>Document:</strong> ${document.name}</p>
      <p><strong>Requested by:</strong> ${requestedBy.name || requestedBy.email}</p>
      <p><strong>Your role:</strong> ${signer.role || 'Signatory'}</p>
    </div>
    <p>Click the button below to review and sign the document. No account required.</p>
    <a href="${signingLink}" class="btn">Review &amp; Sign Document</a>
    <p style="font-size:12px;color:#888;margin-top:16px;">If the button doesn't work, copy this link: ${signingLink}</p>
  `, 'Signature Required');
  return send(signer.email, `Signature Required: ${document.name}`, html);
};

const sendSigningReminder = async (signer, document, requestedBy, signerToken) => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const signingLink = signerToken
    ? `${appUrl}/sign/external/${signerToken}`
    : `${appUrl}/signing`;
  const html = baseTemplate(`
    <p>Hi <strong>${signer.name || signer.email}</strong>,</p>
    <p>This is a friendly reminder that your signature is still required on the document below.</p>
    <div class="meta">
      <p><strong>Document:</strong> ${document.name}</p>
      <p><strong>Requested by:</strong> ${requestedBy.name || requestedBy.email}</p>
      <p><strong>Your role:</strong> ${signer.role || 'Signatory'}</p>
    </div>
    <a href="${signingLink}" class="btn">Sign Now</a>
    <p style="font-size:12px;color:#888;margin-top:16px;">If the button doesn't work, copy this link: ${signingLink}</p>
  `, 'Reminder: Signature Required');
  return send(signer.email, `Reminder — Signature Required: ${document.name}`, html);
};

const sendSigningCompletion = async (owner, document, signers = []) => {
  const signerRows = signers
    .map((s) => `<tr><td style="padding:4px 8px;font-size:13px;">${s.name || s.email}</td><td style="padding:4px 8px;font-size:13px;color:#15803d;">${s.signingStatus === 'signed' ? '&#10003; Signed' : s.signingStatus}</td></tr>`)
    .join('');
  const html = baseTemplate(`
    <p>Hi <strong>${owner.name || owner.email}</strong>,</p>
    <p>All signatures have been collected. <strong>${document.name}</strong> is now fully executed.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden">
      <thead><tr style="background:#f1f5f9"><th style="padding:6px 8px;text-align:left;font-size:12px;color:#64748b">Signer</th><th style="padding:6px 8px;text-align:left;font-size:12px;color:#64748b">Status</th></tr></thead>
      <tbody>${signerRows}</tbody>
    </table>
    <p>The finalized, tamper-evident PDF has been saved to your ContractIQ document vault.</p>
  `, 'Document Fully Executed');
  return send(owner.email, `Fully Executed: ${document.name}`, html);
};

const sendSigningConfirmation = async (recipient, document, signer, isOwner) => {
  const title = isOwner ? 'Document Signed' : 'Your Signature Was Recorded';
  const html = baseTemplate(`
    <p>Hi <strong>${recipient.name || recipient.email}</strong>,</p>
    <p><strong>${signer.name || signer.email}</strong> has signed <strong>${document.name}</strong>.</p>
    <div class="meta">
      <p><strong>Signed by:</strong> ${signer.name || signer.email} (${signer.email})</p>
      <p><strong>Signed at:</strong> ${new Date().toLocaleString()}</p>
      <p><strong>Document:</strong> ${document.name}</p>
    </div>
  `, title);
  return send(recipient.email, `${title}: ${document.name}`, html);
};

const sendExpiryAlert = async (recipient, contract, daysUntilExpiry) => {
  const urgency = daysUntilExpiry === 0 ? 'has expired TODAY' : `expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`;
  const html = baseTemplate(`
    <p>Hi <strong>${recipient.name}</strong>,</p>
    <p>This is an automated reminder that a contract under your management <strong>${urgency}</strong>.</p>
    <div class="meta">
      <p><strong>Contract:</strong> ${contract.title}</p>
      <p><strong>Contract ID:</strong> ${contract.contractId}</p>
      <p><strong>Expiry Date:</strong> ${new Date(contract.expiryDate).toLocaleDateString('en-US', { dateStyle: 'full' })}</p>
      <p><strong>Parties:</strong> ${contract.parties.map((p) => p.name).join(', ')}</p>
    </div>
    <p>Please take the necessary action in ContractIQ.</p>
  `, `Contract Expiry Alert — ${daysUntilExpiry === 0 ? 'Expired Today' : `${daysUntilExpiry} Days Remaining`}`);
  return send(recipient.email, `Contract Expiry Alert: ${contract.title}`, html);
};

module.exports = {
  sendTaskAssignment,
  sendTaskCompletion,
  sendDocumentUpload,
  sendSigningRequest,
  sendSigningReminder,
  sendSigningCompletion,
  sendSigningConfirmation,
  sendExpiryAlert,
  send,
};
