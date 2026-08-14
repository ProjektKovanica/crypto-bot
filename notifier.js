// notifier.js - Notification stub (can be extended with Telegram/Discord)

module.exports = {
  send: async (message) => {
    console.log('🔔 NOTIFIKACIJA:', message);
  }
};
