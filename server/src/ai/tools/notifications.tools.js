const Notification = require('../../models/Notification');

const clampLimit = (value, fallback = 10) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), 20);
};

const mapNotification = (notification) => ({
  _id: notification._id,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  read: notification.read,
  priority: notification.priority,
  createdAt: notification.createdAt,
  relatedTo: notification.relatedTo
    ? {
      type: notification.relatedTo.type,
      label: notification.relatedTo.label,
    }
    : null,
});

module.exports = [
  {
    name: 'list_my_notifications',
    description: 'List notifications for the current user, optionally limited to unread notifications.',
    riskLevel: 'low',
    requiredPermissions: [],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unread_only: { type: 'boolean' },
        limit:       { type: 'number', integer: true, minimum: 1, maximum: 20 },
      },
    },
    async execute(args, context) {
      const unreadOnly = args.unread_only === true;
      const limit = clampLimit(args.limit, 10);
      const filter = { recipient: context.userId };
      if (unreadOnly) filter.read = false;

      const [notifications, unreadCount, total] = await Promise.all([
        Notification.find(filter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean(),
        Notification.countDocuments({ recipient: context.userId, read: false }),
        Notification.countDocuments(filter),
      ]);

      const shown = notifications.length;
      let message;
      if (shown === 0) {
        message = unreadOnly
          ? 'You have no unread notifications.'
          : 'You have no notifications.';
      } else {
        const scope = unreadOnly ? 'unread notification' : 'notification';
        message = unreadOnly
          ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}. Showing ${shown}.`
          : `You have ${total} notification${total !== 1 ? 's' : ''}, including ${unreadCount} unread. Showing ${shown} ${scope}${shown !== 1 ? 's' : ''}.`;
      }

      return {
        type: 'success',
        data: {
          notifications: notifications.map(mapNotification),
          unreadCount,
          total,
          count: shown,
          unreadOnly,
          message,
        },
      };
    },
  },

  {
    name: 'count_my_notifications',
    description: 'Count notifications for the current user, optionally limited to unread notifications.',
    riskLevel: 'low',
    requiredPermissions: [],
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        unread_only: { type: 'boolean' },
      },
    },
    async execute(args, context) {
      const unreadOnly = args.unread_only === true;
      const [unreadCount, total] = await Promise.all([
        Notification.countDocuments({ recipient: context.userId, read: false }),
        Notification.countDocuments({ recipient: context.userId }),
      ]);
      const count = unreadOnly ? unreadCount : total;
      const noun = unreadOnly ? 'unread notification' : 'notification';

      return {
        type: 'success',
        data: {
          total,
          unreadCount,
          count,
          unreadOnly,
          message: count === 0
            ? `You have no ${unreadOnly ? 'unread notifications' : 'notifications'}.`
            : `You have ${count} ${noun}${count !== 1 ? 's' : ''}.`,
        },
      };
    },
  },
];
